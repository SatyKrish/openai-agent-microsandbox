// Copyright 2026 openai-agent-microsandbox contributors
// SPDX-License-Identifier: Apache-2.0
//
// The worker's real gRPC service for the Python tests, with commands run on the
// test host instead of in session VMs: NO ISOLATION. Built into dist/test only;
// the worker image ships dist/src. Prints {"port": N} when it is listening.
//
// FAKE_BIN, when set, is put first on PATH (a fake kubectl for the tests). Pod logs come
// from the fake log source in helpers.ts.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

import * as grpc from '@grpc/grpc-js';

import type { Runner } from '../src/runner.js';
import { createServer } from '../src/server.js';
import { config, fakeHealthSource, fakeLogSource } from './helpers.js';

const run: Runner['run'] = (_id, _root, argv, cwd, timeoutMs) => new Promise((resolve) => {
  // A login shell would reset PATH and lose FAKE_BIN.
  const words = argv[1] === '-lc' ? [argv[0]!, '-c', ...argv.slice(2)] : [...argv];
  const started = performance.now();
  const env = { PATH: `${process.env.FAKE_BIN ? `${process.env.FAKE_BIN}:` : ''}${process.env.PATH}`, HOME: cwd,
    LANG: 'C.UTF-8' };
  const child = spawn(words[0]!, words.slice(1), { cwd, env, timeout: timeoutMs });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  child.on('error', (error) => resolve({ stdout, stderr: error.message, exitCode: 127, timedOut: false,
    durationMs: Math.round(performance.now() - started) }));
  child.on('close', (code, signal) => {
    const timedOut = signal === 'SIGTERM' && performance.now() - started >= timeoutMs - 50;
    resolve({ stdout, stderr, exitCode: timedOut ? 124 : code ?? 1, timedOut,
      durationMs: Math.round(performance.now() - started) });
  });
});
// Files are written on the volume, as for a session whose VM is not running.
const hostRunner: Runner = { run, write: async () => false, destroy: async () => undefined };

const dataDir = process.env.DATA_DIR!;
await fs.mkdir(dataDir, { recursive: true });
const server = createServer(config(dataDir, {
  token: process.env.WORKER_TEST_TOKEN || null, maxOutputBytes: 1024 * 1024, maxFileBytes: 10 * 1024 * 1024,
  maxEvidenceBytes: 4 * 1024 * 1024, timeoutMs: Number(process.env.WORKER_TIMEOUT_MS || 30_000),
}), hostRunner, { logs: fakeLogSource, health: fakeHealthSource });
server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) => {
  if (error) throw error;
  console.log(JSON.stringify({ port }));
});
process.on('SIGTERM', () => server.tryShutdown(() => process.exit(0)));
