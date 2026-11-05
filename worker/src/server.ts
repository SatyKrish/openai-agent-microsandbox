// Copyright 2026 openai-agent-mxc contributors
// SPDX-License-Identifier: Apache-2.0
//
// The gRPC side of the worker (proto/sandbox/v1/sandbox.proto). Commands and
// file operations of one session run one at a time, in arrival order; commands of
// different sessions run concurrently, one per running VM (runner.ts).

import { existsSync, readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { MicrosandboxError } from 'microsandbox';

import type { Config } from './config.js';
import { evidenceName, kubectlRead } from './evidence.js';
import { Journal, sha256, type EvidenceEntry } from './journal.js';
import { applyLogPolicy } from './log-policy.js';
import { apiHealthSource, type HealthSource, type NamespaceHealth } from './health.js';
import { KubeApi } from './kube-api.js';
import { apiLogSource, LogError, type LogSource } from './logs.js';
import { redact } from './redact.js';
import { describeEgress, type Runner } from './runner.js';
import { WorkspaceError, Workspaces, validSessionId } from './workspace.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROTO = 'sandbox/v1/sandbox.proto';
// microsandbox does not export its package.json; read it beside the module it resolves to.
const MICROSANDBOX = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.resolve('microsandbox'))),
  '..', 'package.json'), 'utf8')) as { version: string };
export const RUNTIME = `microsandbox ${MICROSANDBOX.version}`;

export function protoRoot(): string {
  const candidates = [process.env.WORKER_PROTO_ROOT, path.resolve(here, '../../proto'), path.resolve(here, '../../../proto')];
  const found = candidates.find((dir) => dir && existsSync(path.join(dir, PROTO)));
  if (!found) throw new Error(`cannot find ${PROTO}; set WORKER_PROTO_ROOT`);
  return found;
}

export function loadService(): grpc.ServiceDefinition {
  const definition = protoLoader.loadSync(PROTO, { includeDirs: [protoRoot()], keepCase: true, longs: Number,
    enums: String, defaults: true });
  const loaded = grpc.loadPackageDefinition(definition) as unknown as
    { sandbox: { v1: { Sandbox: { service: grpc.ServiceDefinition } } } };
  return loaded.sandbox.v1.Sandbox.service;
}

class Status extends Error {
  constructor(readonly code: grpc.status, message: string) {
    super(message);
  }
}

/** Serializes work per key: each task starts after the previous one for that key settles. */
class KeyedQueue {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

function cap(text: string, limit: number): { data: Buffer; truncated: boolean } {
  const data = Buffer.from(text, 'utf8');
  if (data.length <= limit) return { data, truncated: false };
  const note = Buffer.from(`\n[sandbox-worker: output truncated at ${limit} of ${data.length} bytes]\n`);
  return { data: Buffer.concat([data.subarray(0, limit), note]), truncated: true };
}

function wire(entry: EvidenceEntry) {
  return { ...entry };
}

const NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const POD_REF = /^(?:(?:deploy|deployment|deployments)\/)?[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;

function logStatus(status: number): grpc.status {
  if (status === 404) return grpc.status.NOT_FOUND;
  if (status === 403 || status === 401) return grpc.status.PERMISSION_DENIED;
  if (status >= 400 && status < 500) return grpc.status.FAILED_PRECONDITION;
  return grpc.status.UNAVAILABLE;
}

interface ReadLogsRequest {
  session_id: string; namespace: string; pod: string; container: string; previous: boolean; tail_lines: number;
  since_seconds: number; match: string; requester: string;
}

interface ExecRequest { session_id: string; argv: string[]; cwd: string; timeout_ms: number; requester: string }

/** Who asked, as the client says: the person behind the turn, so the journal answers more than "the service
 * account". Printable and short; the client is the paired harness, but the journal stays readable regardless. */
export function requesterOf(value: string | undefined): string | undefined {
  const cleaned = (value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
  return cleaned || undefined;
}

export interface Sources {
  logs?: LogSource;
  health?: HealthSource;
}

export function createServer(config: Config, runner: Runner, sources: Sources = {}): grpc.Server {
  const workspaces = new Workspaces(config.dataDir);
  const journal = new Journal(config.dataDir);
  const sessions = new KeyedQueue();
  const expected = config.token ? Buffer.from(`Bearer ${config.token}`) : null;

  function authorize(metadata: grpc.Metadata): void {
    if (!expected) return;
    const given = Buffer.from(String(metadata.get('authorization')[0] ?? ''));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new Status(grpc.status.UNAUTHENTICATED, 'missing or wrong worker token');
    }
  }

  // Wrap a handler: authenticate, run it, and turn known failures into status codes.
  function unary<Req, Res>(name: string, handler: (request: Req) => Promise<Res>) {
    return async (call: grpc.ServerUnaryCall<Req, Res>, callback: grpc.sendUnaryData<Res>) => {
      try {
        authorize(call.metadata);
        callback(null, await handler(call.request));
      } catch (error) {
        let code = grpc.status.INTERNAL;
        let message = 'internal worker error';
        if (error instanceof Status) {
          ({ code, message } = error);
        } else if (error instanceof WorkspaceError) {
          code = { invalid: grpc.status.INVALID_ARGUMENT, not_found: grpc.status.NOT_FOUND,
            too_large: grpc.status.RESOURCE_EXHAUSTED }[error.kind];
          message = error.message;
        } else if (error instanceof MicrosandboxError) {
          // The session's VM could not be started or reached, or refused the operation.
          code = grpc.status.UNAVAILABLE;
          message = `the session's VM could not run this (${error.name})`;
          log('error', `${name} failed in the VM`, { error: error.message.slice(0, 2000) });
        } else {
          log('error', `${name} failed`, { error: String((error as Error)?.message ?? error).slice(0, 2000) });
        }
        callback({ code, details: message });
      }
    };
  }

  let api: KubeApi | undefined;
  function kubeApi(): KubeApi {
    if (!config.kubeApi) throw new Status(grpc.status.FAILED_PRECONDITION, 'this worker has no Kubernetes API');
    api ??= new KubeApi({ url: new URL(`https://${config.kubeApi.host}:${config.kubeApi.port}`),
      ca: readFileSync(config.kubeCaFile), tokenFile: config.kubeTokenFile });
    return api;
  }
  const logs = (): LogSource => (sources.logs ??= apiLogSource(kubeApi()));
  const healthSource = (): HealthSource => (sources.health ??= apiHealthSource(kubeApi()));
  // Several browsers poll the summary; the API is asked at most every few seconds.
  let healthCache: { at: number; value: Promise<{ generated_at: string; namespaces: NamespaceHealth[] }> } | null = null;
  function health() {
    if (!healthCache || Date.now() - healthCache.at > 5000) {
      const value = healthSource()(config.namespaces).then((namespaces) => ({ generated_at: new Date().toISOString(),
        namespaces }));
      healthCache = { at: Date.now(), value };
      value.catch(() => { healthCache = null; });
    }
    return healthCache.value;
  }

  async function readLogs(request: ReadLogsRequest) {
    const id = validSessionId(request.session_id);
    await workspaces.require(id);
    const { namespace, pod } = request;
    if (!NAME.test(namespace) || (config.namespaces.length && !config.namespaces.includes(namespace))) {
      throw new Status(grpc.status.INVALID_ARGUMENT,
        `namespace ${namespace} is outside this worker's scope: ${config.namespaces.join(', ')}`);
    }
    if (!POD_REF.test(pod)) throw new Status(grpc.status.INVALID_ARGUMENT, `${pod} is not a pod or deploy/NAME`);
    if (request.container && !NAME.test(request.container)) {
      throw new Status(grpc.status.INVALID_ARGUMENT, `${request.container} is not a container name`);
    }
    const match = (request.match || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
    let fetched: { pod: string; text: string };
    try {
      fetched = await logs()({ namespace, pod, container: request.container || undefined, previous: request.previous,
        tailLines: Math.min(request.tail_lines || config.logTailLines, config.logMaxTailLines),
        sinceSeconds: request.since_seconds || undefined, limitBytes: config.logMaxBytes });
    } catch (error) {
      if (error instanceof LogError) throw new Status(logStatus(error.status), error.message);
      throw error;
    }
    const label = `pod ${fetched.pod}${request.container ? ` container ${request.container}` : ''}`
      + `${request.previous ? ' (previous container)' : ''} in ${namespace}`;
    const excerpt = applyLogPolicy(fetched.text, label, config.logPolicy, match);
    const content = Buffer.from(excerpt.text, 'utf8');
    const seq = await journal.nextSeq(id);
    const name = evidenceName(seq, ['pod-logs', fetched.pod, ...(request.container ? [request.container] : []),
      ...(request.previous ? ['previous'] : []), ...(match ? ['match'] : [])]);
    const command = `pod_logs ${fetched.pod} -n ${namespace}${request.container ? ` -c ${request.container}` : ''}`
      + `${request.previous ? ' --previous' : ''}${match ? ` match=${JSON.stringify(match)}` : ''}`;
    const requester = requesterOf(request.requester);
    await journal.record(id, { seq, path: name, command, exit_code: 0, requester }, content);
    try {
      await workspaces.write(id, name, content, config.maxEvidenceBytes, (file) => runner.write(id, file, content));
    } catch (error) {
      if (!(error instanceof WorkspaceError)) throw error;
    }
    // The audit trail keeps the raw log's size and hash, never its text.
    await journal.event(id, 'logs', { requester, namespace, pod: fetched.pod, container: request.container || undefined,
      previous: request.previous, match: match || undefined, lines_read: excerpt.linesRead,
      lines_shown: excerpt.linesShown, lines_withheld: excerpt.linesWithheld, redactions: excerpt.redactions,
      raw_bytes: Buffer.byteLength(fetched.text), raw_sha256: sha256(fetched.text), evidence_seq: seq });
    return { excerpt: excerpt.text, evidence_path: name, lines_read: excerpt.linesRead,
      lines_shown: excerpt.linesShown, lines_withheld: excerpt.linesWithheld, redactions: excerpt.redactions };
  }

  async function exec(request: ExecRequest) {
    const id = validSessionId(request.session_id);
    const requester = requesterOf(request.requester);
    if (!request.argv.length) throw new Status(grpc.status.INVALID_ARGUMENT, 'argv is empty');
    const root = await workspaces.require(id);
    const cwd = request.cwd ? workspaces.lexical(id, request.cwd) : root;
    const timeoutMs = Math.min(request.timeout_ms || config.timeoutMs, config.timeoutMs);
    const result = await runner.run(id, root, request.argv, cwd, timeoutMs);
    const stdoutText = redact(result.stdout);
    let stderrText = redact(result.stderr);
    let evidence: EvidenceEntry | undefined;
    const words = kubectlRead(request.argv);
    if (words && result.exitCode === 0 && !result.timedOut && stdoutText.length > 0) {
      const seq = await journal.nextSeq(id);
      const name = evidenceName(seq, words);
      const content = Buffer.from(stdoutText, 'utf8').subarray(0, config.maxEvidenceBytes);
      evidence = await journal.record(id, { seq, path: name, command: words.join(' '), exit_code: 0, requester },
        content);
      // The agent's copy, for analysis in the workspace. Checks use the journal's copy.
      let note = `saved as ${name}`;
      try {
        await workspaces.write(id, name, content, config.maxEvidenceBytes, (file) => runner.write(id, file, content));
      } catch (error) {
        if (!(error instanceof WorkspaceError)) throw error;
        note = `recorded as evidence ${seq}, but the workspace copy was refused: ${error.message}`;
      }
      stderrText += `${stderrText && !stderrText.endsWith('\n') ? '\n' : ''}[sandbox-worker] ${note}\n`;
    }
    const stdout = cap(stdoutText, config.maxOutputBytes);
    const stderr = cap(stderrText, config.maxOutputBytes);
    await journal.command(id, { requester, argv: request.argv, cwd, exitCode: result.exitCode, timedOut: result.timedOut,
      durationMs: result.durationMs, stdout: stdout.data, stderr: stderr.data, evidenceSeq: evidence?.seq });
    return { stdout: stdout.data, stderr: stderr.data, exit_code: result.exitCode, timed_out: result.timedOut,
      duration_ms: result.durationMs, truncated: stdout.truncated || stderr.truncated,
      evidence_path: evidence?.path ?? '' };
  }

  const server = new grpc.Server({ 'grpc.max_receive_message_length': config.maxFileBytes + 1024 * 1024,
    'grpc.max_send_message_length': config.maxFileBytes + 1024 * 1024 });
  server.addService(loadService(), {
    Info: unary('Info', async () => ({
      worker_id: config.workerId, domain: config.domain,
      isolation: `microVM per session (${config.vmCpus} vCPU, ${config.vmMemoryMib} MiB)`,
      runtime_version: RUNTIME, egress: describeEgress(config), active_sessions: await workspaces.count(),
      max_file_bytes: config.maxFileBytes, workspace_base: workspaces.base, namespaces: config.namespaces,
    })),
    InitSession: unary('InitSession', async (request: { session_id: string }) => {
      const id = validSessionId(request.session_id);
      return sessions.run(id, async () => {
        const { root, created } = await workspaces.init(id);
        if (created) await journal.event(id, 'init', { root });
        return { workspace_root: root, created };
      });
    }),
    Exec: unary('Exec', (request: ExecRequest) =>
      sessions.run(validSessionId(request.session_id), () => exec(request))),
    WriteFile: unary('WriteFile', async (request: { session_id: string; path: string; content: Buffer }) => {
      const id = validSessionId(request.session_id);
      return sessions.run(id, async () => {
        await workspaces.write(id, request.path, request.content, config.maxFileBytes,
          (file) => runner.write(id, file, request.content));
        return { bytes_written: request.content.length };
      });
    }),
    ReadFile: unary('ReadFile', async (request: { session_id: string; path: string; max_bytes: number }) => {
      const id = validSessionId(request.session_id);
      return sessions.run(id, async () => {
        const { data, size } = await workspaces.read(id, request.path, request.max_bytes, config.maxFileBytes);
        return { content: data, size };
      });
    }),
    ListEvidence: unary('ListEvidence', async (request: { session_id: string; after_seq: number }) => {
      const id = validSessionId(request.session_id);
      const entries = await journal.entries(id);
      return { entries: entries.filter((entry) => entry.seq > request.after_seq).map(wire) };
    }),
    ReadEvidence: unary('ReadEvidence', async (request: { session_id: string; seq: number }) => {
      const found = await journal.read(validSessionId(request.session_id), request.seq);
      if (!found) throw new Status(grpc.status.NOT_FOUND, `no evidence ${request.seq}`);
      return { entry: wire(found.entry), content: found.content };
    }),
    Health: unary('Health', () => health()),
    ReadLogs: unary('ReadLogs', (request: ReadLogsRequest) =>
      sessions.run(validSessionId(request.session_id), () => readLogs(request))),
    DestroySession: unary('DestroySession', async (request: { session_id: string; purge_history: boolean }) => {
      const id = validSessionId(request.session_id);
      return sessions.run(id, async () => {
        await runner.destroy(id);
        const existed = await workspaces.destroy(id);
        if (request.purge_history) await journal.purge(id);
        else {
          await journal.event(id, 'destroy', { existed });
          journal.forget(id);
        }
        return { existed };
      });
    }),
  });
  return server;
}

export function log(level: 'info' | 'warn' | 'error', msg: string, fields: object = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }));
}
