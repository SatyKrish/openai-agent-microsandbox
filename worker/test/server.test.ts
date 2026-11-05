// Copyright 2026 openai-agent-mxc contributors
// SPDX-License-Identifier: Apache-2.0
//
// The gRPC service end to end with a stand-in runner: commands run on the test
// host (no VM), and kubectl is a fake that prints a fixed pod table.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import * as grpc from '@grpc/grpc-js';

import { RuntimeError } from 'microsandbox';

import type { Runner } from '../src/runner.js';
import { createServer, loadService } from '../src/server.js';
import { config, fakeHealthSource, fakeLogSource } from './helpers.js';

const PODS = 'NAME READY STATUS\npayments-api-1 0/1 CrashLoopBackOff\ntoken=abcd1234secret\n';

const run: Runner['run'] = async (_id, _root, argv, cwd) => {
  const fake = path.join(cwd, '..', '..', 'bin');
  // A login shell would reset PATH and lose the fake kubectl.
  const words = argv[1] === '-lc' ? [argv[0]!, '-c', ...argv.slice(2)] : [...argv];
  const result = spawnSync(words[0]!, words.slice(1), { cwd, encoding: 'utf8',
    env: { PATH: `${fake}:${process.env.PATH}` } });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? 1, timedOut: false, durationMs: 1 };
};
const fakeRunner: Runner = { run, write: async () => false, destroy: async () => undefined };

let data: string;
let server: grpc.Server;
let client: grpc.Client & Record<string, Function>;

function call<T>(method: string, request: object, metadata = new grpc.Metadata()): Promise<T> {
  return new Promise((resolve, reject) =>
    client[method]!(request, metadata, (error: grpc.ServiceError | null, response: T) =>
      (error ? reject(error) : resolve(response))));
}

before(async () => {
  data = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-server-'));
  await fs.mkdir(path.join(data, 'bin'));
  await fs.writeFile(path.join(data, 'bin', 'kubectl'), `#!/bin/sh\nprintf '${PODS.replace(/\n/g, '\\n')}'\n`,
    { mode: 0o755 });
  server = createServer(config(data, { token: 'pair-token' }), fakeRunner, { logs: fakeLogSource, health: fakeHealthSource });
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, bound) =>
      (error ? reject(error) : resolve(bound))));
  const Client = grpc.makeGenericClientConstructor(loadService(), 'Sandbox');
  client = new Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure()) as never;
});

after(() => {
  client.close();
  server.forceShutdown();
});

function auth(): grpc.Metadata {
  const metadata = new grpc.Metadata();
  metadata.set('authorization', 'Bearer pair-token');
  return metadata;
}

test('requests without the pair token are refused', async () => {
  await assert.rejects(call('Info', {}), (error: grpc.ServiceError) => error.code === grpc.status.UNAUTHENTICATED);
  const info = await call<{ domain: string; egress: string }>('Info', {}, auth());
  assert.equal(info.domain, 'payments');
  assert.match(info.egress, /read-only, through the worker's proxy/);
});

test('a session runs commands, records kubectl reads as evidence, and keeps files', async () => {
  const init = await call<{ workspace_root: string; created: boolean }>('InitSession', { session_id: 'conv-a' }, auth());
  assert.equal(init.created, true);
  assert.equal(init.workspace_root, path.join(data, 'active', 'conv-a'));

  const echo = await call<{ stdout: Buffer; exit_code: number; evidence_path: string }>('Exec',
    { session_id: 'conv-a', argv: ['sh', '-lc', 'echo hi > note.txt && cat note.txt'] }, auth());
  assert.equal(echo.stdout.toString(), 'hi\n');
  assert.equal(echo.evidence_path, '');

  const read = await call<{ stdout: Buffer; stderr: Buffer; evidence_path: string }>('Exec',
    { session_id: 'conv-a', argv: ['sh', '-lc', 'kubectl get pods -n payments'], requester: 'ana@example.com\n' },
    auth());
  assert.equal(read.evidence_path, 'evidence/001-kubectl-get-pods-n-payments.txt');
  assert.ok(read.stdout.toString().includes('token=[REDACTED]'));
  assert.match(read.stderr.toString(), /saved as evidence\/001/);

  // A piped read is analysis, not evidence.
  const piped = await call<{ evidence_path: string }>('Exec',
    { session_id: 'conv-a', argv: ['sh', '-lc', 'kubectl get pods -n payments | grep Crash'] }, auth());
  assert.equal(piped.evidence_path, '');

  const listed = await call<{ entries: Array<{ seq: number; path: string; sha256: string }> }>('ListEvidence',
    { session_id: 'conv-a', after_seq: 0 }, auth());
  assert.equal(listed.entries.length, 1);
  const trusted = await call<{ content: Buffer }>('ReadEvidence', { session_id: 'conv-a', seq: 1 }, auth());
  assert.ok(trusted.content.toString().includes('CrashLoopBackOff'));

  // Editing the workspace copy does not change the journal's copy.
  await call('WriteFile', { session_id: 'conv-a', path: 'evidence/001-kubectl-get-pods-n-payments.txt',
    content: Buffer.from('forged') }, auth());
  const again = await call<{ content: Buffer }>('ReadEvidence', { session_id: 'conv-a', seq: 1 }, auth());
  assert.ok(again.content.toString().includes('CrashLoopBackOff'));

  const file = await call<{ content: Buffer; size: number }>('ReadFile',
    { session_id: 'conv-a', path: `${init.workspace_root}/note.txt` }, auth());
  assert.equal(file.content.toString(), 'hi\n');
  await assert.rejects(call('ReadFile', { session_id: 'conv-a', path: '../../history/conv-a/journal.jsonl' }, auth()),
    (error: grpc.ServiceError) => error.code === grpc.status.INVALID_ARGUMENT);
  await assert.rejects(call('Exec', { session_id: 'conv-zzz', argv: ['true'] }, auth()),
    (error: grpc.ServiceError) => error.code === grpc.status.NOT_FOUND);

  const journal = await fs.readFile(path.join(data, 'history', 'conv-a', 'journal.jsonl'), 'utf8');
  assert.equal(journal.trim().split('\n').length, 4); // init and three commands
  // The journal names who asked for a command, when the client said, as printable text.
  const commands = journal.trim().split('\n').map((line) => JSON.parse(line)).filter((entry) => entry.event === 'exec');
  assert.deepEqual(commands.map((entry) => entry.requester), [undefined, 'ana@example.com', undefined]);
  const evidence = await fs.readFile(path.join(data, 'history', 'conv-a', 'evidence.jsonl'), 'utf8');
  assert.equal(JSON.parse(evidence.trim().split('\n')[0] ?? '{}').requester, 'ana@example.com');

  assert.equal((await call<{ existed: boolean }>('DestroySession', { session_id: 'conv-a' }, auth())).existed, true);
  await fs.access(path.join(data, 'history', 'conv-a', 'journal.jsonl'));
  await call('DestroySession', { session_id: 'conv-a', purge_history: true }, auth());
  await assert.rejects(fs.access(path.join(data, 'history', 'conv-a')));
});

test('VM failures are UNAVAILABLE; a running VM gets its files written through it', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-errors-'));
  let fail = true;
  const written: string[] = [];
  const runner: Runner = {
    run: async () => {
      if (fail) throw new RuntimeError('the VM could not start');
      return { stdout: 'ok\n', stderr: '', exitCode: 0, timedOut: false, durationMs: 1 };
    },
    write: async (_id, file) => { written.push(file); return true; },
    destroy: async () => undefined,
  };
  const other = createServer(config(dataDir), runner);
  const port = await new Promise<number>((resolve, reject) =>
    other.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, bound) =>
      (error ? reject(error) : resolve(bound))));
  const Client = grpc.makeGenericClientConstructor(loadService(), 'Sandbox');
  const direct = new Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure()) as grpc.Client & Record<string, Function>;
  const invoke = <T>(method: string, request: object) => new Promise<T>((resolve, reject) =>
    direct[method]!(request, (error: grpc.ServiceError | null, response: T) => (error ? reject(error) : resolve(response))));
  try {
    const { workspace_root: root } = await invoke<{ workspace_root: string }>('InitSession', { session_id: 'conv-e' });
    await assert.rejects(invoke('Exec', { session_id: 'conv-e', argv: ['true'] }),
      (error: grpc.ServiceError) => error.code === grpc.status.UNAVAILABLE && /RuntimeError/.test(error.details));
    fail = false;
    await invoke('Exec', { session_id: 'conv-e', argv: ['true'] });
    // The runner wrote the file; the worker still checked the path and made its directory.
    await invoke('WriteFile', { session_id: 'conv-e', path: 'notes/a.txt', content: Buffer.from('a') });
    assert.deepEqual(written, [path.join(root, 'notes', 'a.txt')]);
    await fs.access(path.join(root, 'notes'));
    await assert.rejects(fs.access(path.join(root, 'notes', 'a.txt')));
    await assert.rejects(invoke('WriteFile', { session_id: 'conv-e', path: '../escape.txt', content: Buffer.from('a') }),
      (error: grpc.ServiceError) => error.code === grpc.status.INVALID_ARGUMENT);
    assert.equal(written.length, 1);
  } finally {
    direct.close();
    other.forceShutdown();
  }
});

test('pod logs reach the caller only as a policy excerpt, recorded as evidence', async () => {
  await call('InitSession', { session_id: 'conv-logs' }, auth());
  const reply = await call<{ excerpt: string; evidence_path: string; lines_read: number; lines_shown: number;
    lines_withheld: number; redactions: number }>('ReadLogs',
    { session_id: 'conv-logs', namespace: 'payments', pod: 'deploy/payments-api', tail_lines: 5000,
      requester: 'bo@corp.test' }, auth());
  assert.equal(reply.lines_read, 1207);
  assert.ok(reply.lines_shown <= 40 && reply.lines_withheld >= 1167, `${reply.lines_shown} shown`);
  assert.match(reply.excerpt, /^\[log policy\] pod payments-api-7d9f8c6b5d-x2k4p in payments: read 1207 lines/);
  assert.match(reply.excerpt, /ERROR upstream ledger timeout after 3000ms .*\[×5 more like this/);
  assert.doesNotMatch(reply.excerpt, /@example\.com|4111/);
  assert.equal(reply.evidence_path, 'evidence/001-pod-logs-payments-api-7d9f8c6b5d-x2k4p.txt');
  // The evidence, the workspace copy and the excerpt are the same text; the raw log is in none of them.
  const trusted = await call<{ content: Buffer; entry: { command: string } }>('ReadEvidence',
    { session_id: 'conv-logs', seq: 1 }, auth());
  assert.equal(trusted.content.toString(), reply.excerpt);
  assert.equal(trusted.entry.command, 'pod_logs payments-api-7d9f8c6b5d-x2k4p -n payments');
  const copy = await call<{ content: Buffer }>('ReadFile', { session_id: 'conv-logs', path: reply.evidence_path }, auth());
  assert.equal(copy.content.toString(), reply.excerpt);
  const journal = await fs.readFile(path.join(data, 'history', 'conv-logs', 'journal.jsonl'), 'utf8');
  assert.match(journal, /"event":"logs","requester":"bo@corp.test".*"lines_read":1207.*"raw_sha256":"[0-9a-f]{64}"/);
  assert.doesNotMatch(journal, /@example\.com|4111 1111/);

  const asked = await call<{ excerpt: string }>('ReadLogs', { session_id: 'conv-logs', namespace: 'payments',
    pod: 'deploy/payments-api', match: 'id=777 ' }, auth());
  assert.match(asked.excerpt, /id=777 user=\[REDACTED_EMAIL\]/);

  for (const [request, code] of [
    [{ namespace: 'kube-system', pod: 'coredns-1' }, grpc.status.INVALID_ARGUMENT],
    [{ namespace: 'payments', pod: '../etc' }, grpc.status.INVALID_ARGUMENT],
    [{ namespace: 'payments', pod: 'missing-pod' }, grpc.status.NOT_FOUND],
  ] as Array<[object, grpc.status]>) {
    await assert.rejects(call('ReadLogs', { session_id: 'conv-logs', ...request }, auth()),
      (error: grpc.ServiceError) => error.code === code, JSON.stringify(request));
  }
});

test('the health summary is served to the harness with its pair token', async () => {
  await assert.rejects(call('Health', {}), (error: grpc.ServiceError) => error.code === grpc.status.UNAUTHENTICATED);
  const reply = await call<{ generated_at: string; namespaces: Array<{ namespace: string;
    workloads: Array<{ name: string; state: string; reasons: string[] }> }> }>('Health', {}, auth());
  assert.equal(reply.namespaces[0]!.namespace, 'payments');
  assert.deepEqual(reply.namespaces[0]!.workloads.map((item) => [item.name, item.state]),
    [['payments-processor', 'failing'], ['payments-gateway', 'healthy']]);
  assert.ok(Date.parse(reply.generated_at) > 0);
});
