// Copyright 2026 openai-agent-mxc contributors
// SPDX-License-Identifier: Apache-2.0

import type { Config } from '../src/config.js';

export function config(dataDir: string, overrides: Partial<Config> = {}): Config {
  return { port: 0, bind: '127.0.0.1', dataDir, workerId: 'test', domain: 'payments', namespaces: ['payments'],
    containment: 'bubblewrap', egress: 'kube-api', kubeApi: { host: '10.96.0.1', port: 443 },
    readonlyPaths: ['/run/secrets/kubernetes.io/serviceaccount'], timeoutMs: 30_000, maxOutputBytes: 1024,
    maxFileBytes: 4096, maxEvidenceBytes: 2048, maxConcurrent: 2, limitAddressSpaceBytes: 1 << 30, token: null,
    ...overrides };
}
