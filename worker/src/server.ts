// Copyright 2026 openai-agent-mxc contributors
// SPDX-License-Identifier: Apache-2.0
//
// The gRPC side of the worker (proto/mxc/sandbox/v1/sandbox.proto). Commands and
// file operations of one session run one at a time, in arrival order; commands of
// different sessions run concurrently up to the worker's limit.

import { existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import type { Config } from './config.js';
import { evidenceName, kubectlRead } from './evidence.js';
import { Journal, type EvidenceEntry } from './journal.js';
import { redact } from './redact.js';
import { describeEgress, runInContainer, type RunResult } from './runner.js';
import { WorkspaceError, Workspaces, validSessionId } from './workspace.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROTO = 'mxc/sandbox/v1/sandbox.proto';
const MXC_VERSION = (createRequire(import.meta.url)('@microsoft/mxc-sdk/package.json') as { version: string }).version;

export function protoRoot(): string {
  const candidates = [process.env.MXC_PROTO_ROOT, path.resolve(here, '../../proto'), path.resolve(here, '../../../proto')];
  const found = candidates.find((dir) => dir && existsSync(path.join(dir, PROTO)));
  if (!found) throw new Error(`cannot find ${PROTO}; set MXC_PROTO_ROOT`);
  return found;
}

export function loadService(): grpc.ServiceDefinition {
  const definition = protoLoader.loadSync(PROTO, { includeDirs: [protoRoot()], keepCase: true, longs: Number,
    enums: String, defaults: true });
  const loaded = grpc.loadPackageDefinition(definition) as unknown as
    { mxc: { sandbox: { v1: { Sandbox: { service: grpc.ServiceDefinition } } } } };
  return loaded.mxc.sandbox.v1.Sandbox.service;
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

class Semaphore {
  private waiting: Array<() => void> = [];

  constructor(private free: number) {}

  async use<T>(task: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free -= 1;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.free += 1;
    }
  }
}

function cap(text: string, limit: number): { data: Buffer; truncated: boolean } {
  const data = Buffer.from(text, 'utf8');
  if (data.length <= limit) return { data, truncated: false };
  const note = Buffer.from(`\n[mxc-worker: output truncated at ${limit} of ${data.length} bytes]\n`);
  return { data: Buffer.concat([data.subarray(0, limit), note]), truncated: true };
}

function wire(entry: EvidenceEntry) {
  return { ...entry };
}

export interface Runner {
  (config: Config, root: string, argv: readonly string[], cwd: string, timeoutMs: number): Promise<RunResult>;
}

export function createServer(config: Config, runner: Runner = runInContainer): grpc.Server {
  const workspaces = new Workspaces(config.dataDir);
  const journal = new Journal(config.dataDir);
  const sessions = new KeyedQueue();
  const slots = new Semaphore(config.maxConcurrent);
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
        } else {
          const detail = error as { code?: string; message?: string };
          if (detail.code && typeof detail.code === 'string' && /backend|unsupported|policy/.test(detail.code)) {
            code = grpc.status.UNAVAILABLE;
            message = `MXC could not launch the container (${detail.code})`;
          }
          log('error', `${name} failed`, { error: String(detail.message ?? error).slice(0, 2000) });
        }
        callback({ code, details: message });
      }
    };
  }

  async function exec(request: { session_id: string; argv: string[]; cwd: string; timeout_ms: number }) {
    const id = validSessionId(request.session_id);
    if (!request.argv.length) throw new Status(grpc.status.INVALID_ARGUMENT, 'argv is empty');
    const root = await workspaces.require(id);
    const cwd = request.cwd ? workspaces.lexical(id, request.cwd) : root;
    const timeoutMs = Math.min(request.timeout_ms || config.timeoutMs, config.timeoutMs);
    const result = await slots.use(() => runner(config, root, request.argv, cwd, timeoutMs));
    const stdoutText = redact(result.stdout);
    let stderrText = redact(result.stderr);
    let evidence: EvidenceEntry | undefined;
    const words = kubectlRead(request.argv);
    if (words && result.exitCode === 0 && !result.timedOut && stdoutText.length > 0) {
      const seq = await journal.nextSeq(id);
      const name = evidenceName(seq, words);
      const content = Buffer.from(stdoutText, 'utf8').subarray(0, config.maxEvidenceBytes);
      evidence = await journal.record(id, { seq, path: name, command: words.join(' '), exit_code: 0 }, content);
      // The agent's copy, for analysis in the workspace. Checks use the journal's copy.
      let note = `saved as ${name}`;
      try {
        await workspaces.write(id, name, content, config.maxEvidenceBytes);
      } catch (error) {
        if (!(error instanceof WorkspaceError)) throw error;
        note = `recorded as evidence ${seq}, but the workspace copy was refused: ${error.message}`;
      }
      stderrText += `${stderrText && !stderrText.endsWith('\n') ? '\n' : ''}[mxc-worker] ${note}\n`;
    }
    const stdout = cap(stdoutText, config.maxOutputBytes);
    const stderr = cap(stderrText, config.maxOutputBytes);
    await journal.command(id, { argv: request.argv, cwd, exitCode: result.exitCode, timedOut: result.timedOut,
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
      containment: config.containment === 'auto' ? 'platform default' : config.containment,
      mxc_sdk_version: MXC_VERSION, egress: describeEgress(config), active_sessions: await workspaces.count(),
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
    Exec: unary('Exec', (request: { session_id: string; argv: string[]; cwd: string; timeout_ms: number }) =>
      sessions.run(validSessionId(request.session_id), () => exec(request))),
    WriteFile: unary('WriteFile', async (request: { session_id: string; path: string; content: Buffer }) => {
      const id = validSessionId(request.session_id);
      return sessions.run(id, async () => {
        await workspaces.write(id, request.path, request.content, config.maxFileBytes);
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
    DestroySession: unary('DestroySession', async (request: { session_id: string; purge_history: boolean }) => {
      const id = validSessionId(request.session_id);
      return sessions.run(id, async () => {
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
