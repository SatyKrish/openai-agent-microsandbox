// Copyright 2026 openai-agent-microsandbox contributors
// SPDX-License-Identifier: Apache-2.0
//
// The read-only API proxy against a stand-in API server over plain HTTP.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { createKubeProxy, kubeconfig, refusal } from '../src/kube-proxy.js';

const seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders }> = [];
let api: http.Server;
let proxy: http.Server;
let tokenFile: string;
let port: number;

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
}

function send(method: string, target: string, headers: http.OutgoingHttpHeaders = {}):
  Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path: target, headers }, (reply) => {
      let body = '';
      reply.on('data', (chunk) => { body += chunk; });
      reply.on('end', () => resolve({ status: reply.statusCode ?? 0, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

before(async () => {
  api = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ kind: 'PodList', path: req.url }));
  });
  const apiPort = await listen(api);
  tokenFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'kube-proxy-')), 'token');
  await fs.writeFile(tokenFile, 'token-one\n');
  proxy = createKubeProxy({ url: new URL(`http://127.0.0.1:${apiPort}`), tokenFile }, 0);
  port = await listen(proxy);
  // The proxy checks proxy-form requests against its own port; rebuild it now that the port is known.
  proxy.close();
  proxy = createKubeProxy({ url: new URL(`http://127.0.0.1:${apiPort}`), tokenFile }, port);
  await new Promise<void>((resolve) => proxy.listen(port, '127.0.0.1', resolve));
});

after(() => {
  proxy.close();
  api.close();
});

test('reads pass with the worker token, and a container cannot choose another identity', async () => {
  const reply = await send('GET', '/api/v1/namespaces/payments/pods?limit=5', {
    authorization: 'Bearer stolen', 'impersonate-user': 'system:admin', 'impersonate-group': 'system:masters' });
  assert.equal(reply.status, 200);
  const request = seen.at(-1)!;
  assert.equal(request.url, '/api/v1/namespaces/payments/pods?limit=5');
  assert.equal(request.headers.authorization, 'Bearer token-one');
  assert.equal(request.headers['impersonate-user'], undefined);
  assert.equal(request.headers['impersonate-group'], undefined);
  // The token is read on every request, so kubelet rotation takes effect at once.
  await fs.writeFile(tokenFile, 'token-two\n');
  await send('GET', '/version');
  assert.equal(seen.at(-1)!.headers.authorization, 'Bearer token-two');
});

test("kubectl's proxy-form requests to the proxy itself are served", async () => {
  const reply = await send('GET', `http://host.microsandbox.internal:${port}/apis/apps/v1/namespaces/payments/deployments`);
  assert.equal(reply.status, 200);
  assert.equal(seen.at(-1)!.url, '/apis/apps/v1/namespaces/payments/deployments');
});

test('writes, streams, other paths and other hosts are refused before reaching the API', async () => {
  const before = seen.length;
  for (const [method, target, headers] of [
    ['POST', '/api/v1/namespaces/payments/pods', {}],
    ['DELETE', '/api/v1/namespaces/payments/pods/x', {}],
    ['PATCH', '/apis/apps/v1/namespaces/payments/deployments/x', {}],
    ['PUT', '/api/v1/namespaces/payments/pods/x', {}],
    ['GET', '/api/v1/namespaces/payments/pods/x/exec?command=sh', {}],
    ['GET', '/api/v1/namespaces/payments/pods/x/portforward', {}],
    ['GET', '/api/v1/namespaces/payments/services/x/proxy/admin', {}],
    ['GET', '/api/v1/namespaces/payments/pods/x/attach', { connection: 'Upgrade', upgrade: 'websocket' }],
    ['GET', '/api/v1/namespaces/payments/pods/x/log?tailLines=100', {}],
    ['GET', '/metrics', {}],
    ['GET', 'http://pypi.org/simple/requests/', {}],
  ] as Array<[string, string, http.OutgoingHttpHeaders]>) {
    const reply = await send(method, target, headers);
    assert.equal(reply.status, 403, `${method} ${target}`);
    assert.equal(JSON.parse(reply.body).reason, 'Forbidden');
  }
  assert.equal(seen.length, before);
  assert.match(refusal('CONNECT', 'pypi.org:443', {}, port) ?? '', /read-only/);
});

test('the kubeconfig points at the proxy and carries no credentials', () => {
  const text = kubeconfig('http://host.microsandbox.internal:18080', 'payments');
  assert.match(text, /server: "http:\/\/host\.microsandbox\.internal:18080"/);
  assert.match(text, /user: \{\}/);
  assert.match(text, /namespace: "payments"/);
  assert.doesNotMatch(text, /token|certificate/);
});
