// Copyright 2026 openai-agent-mxc contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { evidenceName, kubectlRead } from '../src/evidence.js';
import { redact } from '../src/redact.js';
import { buildRequest, quote } from '../src/runner.js';
import { Workspaces, WorkspaceError } from '../src/workspace.js';
import { config } from './helpers.js';


test('kubectl reads qualify as evidence only when plain', () => {
  assert.deepEqual(kubectlRead(['sh', '-lc', 'kubectl get pods -n payments -o wide']),
    ['kubectl', 'get', 'pods', '-n', 'payments', '-o', 'wide']);
  assert.ok(kubectlRead(['kubectl', 'logs', 'deploy/checkout', '--previous', '--namespace=payments']));
  assert.ok(kubectlRead(['sh', '-c', 'kubectl -n payments describe pod/api-1']));
  for (const line of [
    'kubectl get pods | grep api', 'kubectl get pods > x', 'kubectl get pods; echo hi', 'kubectl get pods $(id)',
    "kubectl get pods -o jsonpath='{.items}'", 'kubectl delete pod api-1', 'kubectl exec api-1 -- sh',
    'kubectl get pods --server=https://evil', 'kubectl --kubeconfig=x get pods', 'kubectl get --raw /api',
    'kubectl get pods\nkubectl get secrets', 'echo kubectl get pods', 'kubectl', 'kubectl apply -f x.yaml',
  ]) {
    assert.equal(kubectlRead(['sh', '-lc', line]), null, line);
  }
  assert.equal(kubectlRead(['python3', '-c', 'print(1)']), null);
});

test('evidence names are numbered and safe', () => {
  assert.equal(evidenceName(3, ['kubectl', 'get', 'pods', '-n', 'payments']), 'evidence/003-kubectl-get-pods-n-payments.txt');
  assert.match(evidenceName(12, ['kubectl', 'logs', 'deploy/a'.repeat(30)]), /^evidence\/012-kubectl-logs-deploy-[a-z0-9.-]+\.txt$/);
});

test('redaction removes credentials and keeps context', () => {
  const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzeXN0ZW0ifQ.c2lnbmF0dXJlLXZhbHVl';
  const out = redact([
    `token ${jwt}`, 'AKIAABCDEFGHIJKLMNOP', 'DATABASE_URL: postgres://app:hunter2@db:5432/orders',
    'password=s3cr3t-value', 'Authorization: Bearer abcdefghijklmnop1234', 'automountServiceAccountToken: false',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----',
  ].join('\n'));
  assert.ok(!out.includes(jwt) && out.includes('[REDACTED_JWT]'));
  assert.ok(out.includes('[REDACTED_AWS_KEY]'));
  assert.ok(out.includes('postgres://app:[REDACTED]@db:5432/orders'));
  assert.ok(out.includes('password=[REDACTED]'));
  assert.ok(out.includes('Bearer [REDACTED]'));
  assert.ok(out.includes('automountServiceAccountToken: false'));
  assert.ok(out.includes('[REDACTED_PRIVATE_KEY]') && !out.includes('MIIabc'));
});

test('container requests confine the command', () => {
  assert.equal(quote("it's"), `'it'\\''s'`);
  assert.equal(quote('get'), 'get');
  const request = buildRequest(config('/sandboxes'), '/sandboxes/active/s-1', ['sh', '-lc', 'kubectl get pods | wc -l'],
    '/sandboxes/active/s-1', 20_000);
  assert.equal(request.command,
    "exec choom -n 1000 -- prlimit --as=1073741824 --cpu=20 --nofile=4096:4096 -- sh -lc 'kubectl get pods | wc -l'");
  assert.deepEqual(request.filesystem?.readwritePaths, ['/sandboxes/active/s-1']);
  assert.deepEqual(request.containment, { type: 'bubblewrap' });
  assert.equal(request.environment?.HOME, '/tmp');
  assert.deepEqual(request.network, { egress: { default: 'deny', allow: [{ to: [{ cidr: '10.96.0.1/32' }],
    ports: [{ protocol: 'tcp', port: 443 }] }] }, ingress: { default: 'deny', hostLoopback: 'deny' } });
  const closed = buildRequest(config('/sandboxes', { egress: 'none' }), '/w', ['true'], '/w', 1000);
  assert.deepEqual(closed.network?.egress, { default: 'deny' });
});

test('workspace paths stay inside the session', async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'mxc-worker-'));
  const spaces = new Workspaces(data);
  assert.throws(() => spaces.root('../x'), WorkspaceError);
  assert.throws(() => spaces.root('Upper'), WorkspaceError);
  const { root, created } = await spaces.init('conv-1');
  assert.ok(created);
  assert.equal((await spaces.init('conv-1')).created, false);
  await spaces.write('conv-1', 'output/report.md', Buffer.from('hello'), 100);
  assert.equal((await spaces.read('conv-1', path.join(root, 'output/report.md'), 0, 100)).data.toString(), 'hello');
  assert.equal((await spaces.read('conv-1', 'output/report.md', 2, 100)).data.toString(), 'he');
  await assert.rejects(spaces.read('conv-1', '../conv-2/x', 0, 100), /leaves the workspace/);
  await assert.rejects(spaces.write('conv-1', '/etc/passwd', Buffer.from('x'), 100), /leaves the workspace/);
  await assert.rejects(spaces.write('conv-1', 'big', Buffer.alloc(101), 100), (error: WorkspaceError) =>
    error.kind === 'too_large');
  await assert.rejects(spaces.read('conv-1', 'missing.txt', 0, 100), (error: WorkspaceError) => error.kind === 'not_found');
  // Symlinks planted by the agent cannot lead file I/O out of the workspace.
  await fs.mkdir(path.join(data, 'history'));
  await fs.writeFile(path.join(data, 'history', 'secret'), 'journal');
  await fs.symlink(path.join(data, 'history'), path.join(root, 'link'));
  await fs.symlink(path.join(data, 'history', 'secret'), path.join(root, 'file-link'));
  await assert.rejects(spaces.read('conv-1', 'link/secret', 0, 100), /outside the workspace/);
  await assert.rejects(spaces.read('conv-1', 'file-link', 0, 100), /outside the workspace/);
  await assert.rejects(spaces.write('conv-1', 'link/new', Buffer.from('x'), 100), /not a directory/);
  await assert.rejects(spaces.write('conv-1', 'file-link', Buffer.from('x'), 100), /not a regular file/);
  assert.equal(await fs.readFile(path.join(data, 'history', 'secret'), 'utf8'), 'journal');
  assert.equal(await spaces.destroy('conv-1'), true);
  assert.equal(await spaces.exists('conv-1'), false);
  assert.equal(await fs.readFile(path.join(data, 'history', 'secret'), 'utf8'), 'journal');
});
