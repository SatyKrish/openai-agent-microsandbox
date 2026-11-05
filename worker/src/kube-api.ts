// Copyright 2026 openai-agent-microsandbox contributors
// SPDX-License-Identifier: Apache-2.0
//
// The worker's own reads of the Kubernetes API, with its token, for what it serves
// outside the containers: log excerpts and the health summary.

import fs from 'node:fs';
import https from 'node:https';

import type { ProxyUpstream } from './kube-proxy.js';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class KubeApi {
  private readonly agent: https.Agent;

  constructor(private readonly upstream: ProxyUpstream) {
    this.agent = new https.Agent({ ca: upstream.ca, keepAlive: true });
  }

  get(path: string): Promise<string> {
    const token = fs.readFileSync(this.upstream.tokenFile, 'utf8').trim();
    return new Promise((resolve, reject) => {
      const request = https.request({ hostname: this.upstream.url.hostname, port: this.upstream.url.port, path,
        agent: this.agent, headers: { authorization: `Bearer ${token}`, accept: 'application/json, */*' } }, (reply) => {
        const chunks: Buffer[] = [];
        reply.on('data', (chunk: Buffer) => chunks.push(chunk));
        reply.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if ((reply.statusCode ?? 500) >= 300) {
            let message = body.slice(0, 500);
            try {
              message = (JSON.parse(body) as { message?: string }).message ?? message;
            } catch { /* not a Status */ }
            reject(new ApiError(reply.statusCode ?? 500, message));
          } else {
            resolve(body);
          }
        });
      });
      request.on('error', () => reject(new ApiError(503, 'the Kubernetes API is unreachable from the worker')));
      request.end();
    });
  }

  async json<T>(path: string): Promise<T> {
    return JSON.parse(await this.get(path)) as T;
  }
}
