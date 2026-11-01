// Copyright 2026 openai-agent-mxc contributors
// SPDX-License-Identifier: Apache-2.0
//
// The gRPC service end to end with a stand-in runner: commands run on the test
// host (no MXC), and kubectl is a fake that prints a fixed pod table.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import * as grpc from '@grpc/grpc-js';

import { createServer, loadService, type Runner } from '../src/server.js';
import { config } from './helpers.js';

const PODS = 'NAME READY STATUS\npayments-api-1 0/1 CrashLoopBackOff\ntoken=abcd1234secret\n';

const fakeRunner: Runner = async (_config, _root, argv, cwd) => {
  const fake = path.join(cwd, '..', '..', 'bin');
  // A login shell would reset PATH and lose the fake kubectl.
  const words = argv[1] === '-lc' ? [argv[0]!, '-c', ...argv.slice(2)] : [...argv];
  const result = spawnSync(words[0]!, words.slice(1), { cwd, encoding: 'utf8',
    env: { PATH: `${fake}:${process.env.PATH}` } });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? 1, timedOut: false, durationMs: 1 };
};

let data: string;
let server: grpc.Server;
let client: grpc.Client & Record<string, Function>;

function call<T>(method: string, request: object, metadata = new grpc.Metadata()): Promise<T> {
  return new Promise((resolve, reject) =>
    client[method]!(request, metadata, (error: grpc.ServiceError | null, response: T) =>
      (error ? reject(error) : resolve(response))));
}

before(async () => {
  data = await fs.mkdtemp(path.join(os.tmpdir(), 'mxc-server-'));
  await fs.mkdir(path.join(data, 'bin'));
  await fs.writeFile(path.join(data, 'bin', 'kubectl'), `#!/bin/sh\nprintf '${PODS.replace(/\n/g, '\\n')}'\n`,
    { mode: 0o755 });
  server = createServer(config(data, { token: 'pair-token', maxConcurrent: 2 }), fakeRunner);
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
  assert.match(info.egress, /Kubernetes API only/);
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
    { session_id: 'conv-a', argv: ['sh', '-lc', 'kubectl get pods -n payments'] }, auth());
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

  assert.equal((await call<{ existed: boolean }>('DestroySession', { session_id: 'conv-a' }, auth())).existed, true);
  await fs.access(path.join(data, 'history', 'conv-a', 'journal.jsonl'));
  await call('DestroySession', { session_id: 'conv-a', purge_history: true }, auth());
  await assert.rejects(fs.access(path.join(data, 'history', 'conv-a')));
});
