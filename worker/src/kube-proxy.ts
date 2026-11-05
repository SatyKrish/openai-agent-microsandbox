// Copyright 2026 openai-agent-mxc contributors
// SPDX-License-Identifier: Apache-2.0
//
// The only way session VMs reach Kubernetes: a read-only API proxy on the
// worker's loopback. VMs get no service-account token. kubectl in a VM talks
// plain HTTP to this proxy (the VM's network policy makes it the one reachable
// address, as host.microsandbox.internal); the proxy adds the worker's token, which
// it reads from the kubelet-rotated file on every request, and forwards over TLS to
// the API server. It forwards only reads (GET and HEAD) of API paths, never
// upgrades or the exec, attach, port-forward and proxy subresources, and drops any
// credential or impersonation header a VM sends. Pod logs are refused too:
// they reach the agent only through the worker's log policy (ReadLogs). RBAC still
// decides what the token can read; the proxy keeps writes out even if the Role grows.

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

export interface ProxyUpstream {
  url: URL;             // https://KUBERNETES_SERVICE_HOST:PORT
  ca?: Buffer;          // the cluster CA; required for https
  tokenFile: string;
}

const API_PATH = /^\/(api|apis|version|openapi)(\/|$)/;
const STREAMING = /\/(exec|attach|portforward|proxy)(\/|$)/;
const POD_LOG = /\/pods\/[^/]+\/log$/;
// Hop-by-hop headers, and every header that could carry or change an identity.
const DROPPED = new Set(['authorization', 'proxy-authorization', 'cookie', 'connection', 'proxy-connection', 'keep-alive',
  'upgrade', 'te', 'trailer', 'transfer-encoding', 'host']);

function refuse(res: http.ServerResponse, code: number, reason: string, message: string): void {
  const body = JSON.stringify({ kind: 'Status', apiVersion: 'v1', metadata: {}, status: 'Failure', message, reason,
    code });
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/** Why a request may not pass, or null. */
export function refusal(method: string | undefined, rawUrl: string | undefined, headers: http.IncomingHttpHeaders,
  port: number): string | null {
  if (method !== 'GET' && method !== 'HEAD') {
    return `the sandbox's Kubernetes access is read-only; ${method} is not allowed`;
  }
  if (headers.upgrade) return 'streaming connections (exec, attach, port-forward) are not allowed';
  let url: URL;
  try {
    url = new URL(rawUrl ?? '/', 'http://kube-proxy');
  } catch {
    return 'malformed request target';
  }
  // A request in proxy form names its destination: only the proxy itself, as the API server, is served.
  if (/^https?:\/\//i.test(rawUrl ?? '') && url.port !== String(port)) {
    return 'only the Kubernetes API is reachable from the sandbox';
  }
  if (!API_PATH.test(url.pathname)) return `${url.pathname} is not a Kubernetes API path`;
  if (STREAMING.test(url.pathname)) return 'exec, attach, port-forward and proxy subresources are not allowed';
  if (POD_LOG.test(url.pathname)) {
    return "pod logs are not readable from the sandbox; use the pod_logs tool, which returns an excerpt through the worker's log policy";
  }
  return null;
}

export function createKubeProxy(upstream: ProxyUpstream, port: number,
  onRefused: (method: string, path: string, reason: string) => void = () => {}): http.Server {
  const secure = upstream.url.protocol === 'https:';
  const agent = secure ? new https.Agent({ ca: upstream.ca, keepAlive: true }) : new http.Agent({ keepAlive: true });
  const server = http.createServer((req, res) => {
    const reason = refusal(req.method, req.url, req.headers, port);
    const target = new URL(req.url ?? '/', 'http://kube-proxy');
    if (reason) {
      onRefused(req.method ?? '', target.pathname, reason);
      refuse(res, 403, 'Forbidden', reason);
      req.resume();
      return;
    }
    let token: string;
    try {
      token = fs.readFileSync(upstream.tokenFile, 'utf8').trim();
    } catch {
      refuse(res, 503, 'ServiceUnavailable', "the worker's service-account token is unavailable");
      return;
    }
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!DROPPED.has(name) && !name.startsWith('impersonate-') && value !== undefined) headers[name] = value;
    }
    headers.authorization = `Bearer ${token}`;
    headers.host = upstream.url.host;
    const request = (secure ? https : http).request({
      protocol: upstream.url.protocol, hostname: upstream.url.hostname, port: upstream.url.port, agent,
      method: req.method, path: target.pathname + target.search, headers,
    }, (reply) => {
      const forwarded: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(reply.headers)) {
        if (!DROPPED.has(name) && value !== undefined) forwarded[name] = value;
      }
      res.writeHead(reply.statusCode ?? 502, forwarded);
      reply.pipe(res);
    });
    request.on('error', () => {
      if (!res.headersSent) refuse(res, 502, 'BadGateway', 'the Kubernetes API is unreachable from the worker');
      else res.destroy();
    });
    // A watch ends when kubectl goes away.
    res.on('close', () => request.destroy());
    request.end();
  });
  return server;
}

/** The kubeconfig every VM uses: the proxy, as the API server, with no credentials. */
export function kubeconfig(server: string, namespace: string): string {
  return [
    'apiVersion: v1',
    'kind: Config',
    'clusters:',
    `- name: in-cluster`,
    `  cluster: {server: ${JSON.stringify(server)}}`,
    'users:',
    '- name: sandbox',
    '  user: {}',
    'contexts:',
    '- name: sandbox',
    `  context: {cluster: in-cluster, user: sandbox, namespace: ${JSON.stringify(namespace)}}`,
    'current-context: sandbox',
    '',
  ].join('\n');
}
