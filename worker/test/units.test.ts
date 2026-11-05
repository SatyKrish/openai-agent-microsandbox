// Copyright 2026 openai-agent-microsandbox contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { evidenceName, kubectlRead } from '../src/evidence.js';
import { apiLogSource, failingFirst, LogError } from '../src/logs.js';
import { redact } from '../src/redact.js';
import { GUEST_KUBE_DIR, vmSpec } from '../src/runner.js';
import { Workspaces, WorkspaceError } from '../src/workspace.js';
import { config } from './helpers.js';


test('kubectl reads qualify as evidence only when plain', () => {
  assert.deepEqual(kubectlRead(['sh', '-lc', 'kubectl get pods -n payments -o wide']),
    ['kubectl', 'get', 'pods', '-n', 'payments', '-o', 'wide']);
  // Logs are never evidence from a command: containers cannot read them.
  assert.equal(kubectlRead(['kubectl', 'logs', 'deploy/checkout', '--previous', '--namespace=payments']), null);
  assert.ok(kubectlRead(['kubectl', 'get', 'events', '--namespace=payments']));
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
  // Long names stop at a word boundary instead of halfway through the namespace.
  assert.equal(evidenceName(6, ['kubectl', 'describe', 'pod', 'payments-processor-6957944846-7hfcv', '-n', 'payments-east-1']),
    'evidence/006-kubectl-describe-pod-payments-processor-6957944846-7hfcv-n-payments-east-1.txt');
  assert.equal(evidenceName(7, ['kubectl', 'logs', 'pod/payments-processor-6957944846-7hfcv', '--previous', '--tail=200', '-n',
    'payments-east-1']), 'evidence/007-kubectl-logs-pod-payments-processor-6957944846-7hfcv-previous-tail-200-n.txt');
});

test('redaction removes credentials and keeps context', () => {
  const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzeXN0ZW0ifQ.c2lnbmF0dXJlLXZhbHVl';
  const out = redact([
    `token ${jwt}`, 'AKIAABCDEFGHIJKLMNOP', 'DATABASE_URL: postgres://app:hunter2@db:5432/orders',
    'password=s3cr3t-value', 'Authorization: Bearer abcdefghijklmnop1234', 'automountServiceAccountToken: false',
    'echo "user=ops@example.com card=4111 1111 1111 1111 replicas=3 resourceVersion=1234567890"',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----',
  ].join('\n'));
  assert.ok(!out.includes(jwt) && out.includes('[REDACTED_JWT]'));
  assert.ok(out.includes('[REDACTED_AWS_KEY]'));
  assert.ok(out.includes('postgres://app:[REDACTED]@db:5432/orders'));
  assert.ok(out.includes('password=[REDACTED]'));
  assert.ok(out.includes('Bearer [REDACTED]'));
  assert.ok(out.includes('automountServiceAccountToken: false'));
  // Personal data in pod specs and events too, without touching ordinary numbers.
  assert.ok(out.includes('user=[REDACTED_EMAIL] card=[REDACTED_CARD] replicas=3 resourceVersion=1234567890'));
  assert.ok(out.includes('[REDACTED_PRIVATE_KEY]') && !out.includes('MIIabc'));
});

test("a session's VM sees its workspace and, with Kubernetes access, only the proxy", () => {
  const spec = vmSpec(config('/sandboxes'), 's-1', '/sandboxes/active/s-1');
  assert.equal(spec.name, 's-1');
  assert.equal(spec.workdir, '/sandboxes/active/s-1');
  // The workspace at the same path inside, and the kubeconfig read-only: nothing else of the worker's volume.
  assert.deepEqual(spec.mounts, [{ guest: '/sandboxes/active/s-1', host: '/sandboxes/active/s-1', readonly: false },
    { guest: GUEST_KUBE_DIR, host: '/sandboxes/kube', readonly: true }]);
  assert.deepEqual(spec.network, { mode: 'proxy', port: 18080 });
  assert.equal(spec.env.KUBECONFIG, `${GUEST_KUBE_DIR}/config`);
  assert.ok(!Object.keys(spec.env).some((name) => name.startsWith('KUBERNETES_')));
  assert.deepEqual([spec.cpus, spec.memoryMib, spec.image], [1, 768, 'sre-sandbox-guest:local']);
  const closed = vmSpec(config('/sandboxes', { egress: 'none' }), 's-2', '/w');
  assert.deepEqual(closed.network, { mode: 'none' });
  assert.deepEqual(closed.mounts, [{ guest: '/w', host: '/w', readonly: false }]);
  assert.equal(closed.env.KUBECONFIG, undefined);
});

test('workspace paths stay inside the session', async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-'));
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

test("a log the kubelet no longer has is an error, not the container's output", async () => {
  const body = { text: 'line one\nline two\n' };
  const source = apiLogSource({ get: async () => body.text, json: async () => { throw new Error('unused'); } });
  const query = { namespace: 'payments', pod: 'p-1', previous: true, tailLines: 10, limitBytes: 1024 };
  assert.equal((await source(query)).text, body.text);
  body.text = 'unable to retrieve container logs for containerd://10d63f5c38de';
  await assert.rejects(source(query), (error: unknown) =>
    error instanceof LogError && error.status === 404 && /no longer has the previous container's log/.test(error.message));
});

test('deploy/NAME reads the pod that is failing, not just the newest', () => {
  const pod = (name: string, at: string, ready: boolean, restarts: number) => ({ metadata: { name, creationTimestamp: at },
    status: { containerStatuses: [{ ready, restartCount: restarts }] } });
  const pods = [pod('new-healthy', '2026-11-01T06:00:00Z', true, 0), pod('old-crashing', '2026-11-01T01:00:00Z', false, 40),
    pod('old-restarting', '2026-11-01T02:00:00Z', true, 3)];
  assert.deepEqual(pods.sort(failingFirst).map((item) => item.metadata.name), ['old-crashing', 'old-restarting', 'new-healthy']);
});

test('rollout history and status are reads; other rollout commands are not', () => {
  assert.ok(kubectlRead(['kubectl', 'rollout', 'history', 'deployment/payments-ledger', '-n', 'payments']));
  assert.ok(kubectlRead(['sh', '-lc', 'kubectl -n payments rollout status deployment/payments-ledger']));
  assert.equal(kubectlRead(['kubectl', 'rollout', 'undo', 'deployment/payments-ledger', '-n', 'payments']), null);
  assert.equal(kubectlRead(['kubectl', 'rollout', 'restart', 'deployment/payments-ledger']), null);
});
