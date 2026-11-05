// Copyright 2026 openai-agent-mxc contributors
// SPDX-License-Identifier: Apache-2.0

import type { Config } from '../src/config.js';
import { summarize, type HealthSource } from '../src/health.js';
import { DEFAULT_POLICY } from '../src/log-policy.js';
import { LogError, type LogSource } from '../src/logs.js';

export function config(dataDir: string, overrides: Partial<Config> = {}): Config {
  return { port: 0, bind: '127.0.0.1', dataDir, workerId: 'test', domain: 'payments', namespaces: ['payments'],
    egress: 'kube-api', kubeApi: { host: '10.96.0.1', port: 443 },
    kubeProxyPort: 18080, kubeTokenFile: '/nonexistent/token', kubeCaFile: '/nonexistent/ca.crt',
    guestImage: 'sre-sandbox-guest:local', guestImageArchive: null, vmCpus: 1, vmMemoryMib: 768, maxRunning: 4,
    idleStopMs: 600_000, timeoutMs: 30_000, maxOutputBytes: 1024, maxFileBytes: 4096, maxEvidenceBytes: 2048,
    token: null, logTailLines: 500, logMaxTailLines: 5000, logMaxBytes: 1 << 22,
    logPolicy: DEFAULT_POLICY, ...overrides };
}

/** A busy API's log: customer emails and card numbers on every line, and an upstream timeout every 200 lines. */
export function noisyLog(lines = 1200): string {
  const out: string[] = [];
  for (let index = 1; index <= lines; index += 1) {
    const user = `customer${index % 50}@example.com`;
    out.push(`2026-11-01T05:00:${String(index % 60).padStart(2, '0')}Z INFO request id=${index} user=${user} `
      + `path=/v1/charges card=4111 1111 1111 1111 status=200 latency_ms=${index % 90}`);
    if (index % 200 === 0) {
      out.push(`2026-11-01T05:00:${String(index % 60).padStart(2, '0')}Z ERROR upstream ledger timeout after 3000ms `
        + `id=${index} user=${user}`);
    }
  }
  out.push('2026-11-01T05:01:00Z INFO shutting down after SIGTERM');
  return out.join('\n') + '\n';
}

export const PROCESSOR_LOG = 'payments-processor 3.2.0 starting\n'
  + 'connecting to idempotency cache at payments-redis.payments.svc\n'
  + '[FATAL] Payments startup failed: Missing required env var DATABASE_URL\n';

/** Pod logs for the tests: deploy/NAME resolves to a fixed pod name, as the worker resolves it from the API. */
export const fakeLogSource: LogSource = async (query) => {
  const name = query.pod.replace(/^(?:deploy|deployment|deployments)\//, '');
  if (name.includes('missing')) throw new LogError(404, `pods "${name}" not found`);
  const pod = name === query.pod ? name : `${name}-7d9f8c6b5d-x2k4p`;
  return { pod, text: name.includes('processor') ? PROCESSOR_LOG : noisyLog() };
};

/** The payments demo's health, as the worker summarizes it from the API. */
export const fakeHealthSource: HealthSource = async (namespaces) => namespaces.map((namespace) => ({
  namespace, error: '', workloads: summarize(namespace, {
    deployments: [{ metadata: { name: 'payments-processor' }, spec: { replicas: 1 }, status: {} },
      { metadata: { name: 'payments-gateway' }, spec: { replicas: 2 }, status: { readyReplicas: 2 } }],
    pods: [{ metadata: { name: 'payments-processor-7d9f8c6b5d-x2k4p', ownerReferences: [{ kind: 'ReplicaSet', name: 'payments-processor-7d9f8c6b5d' }] },
      status: { phase: 'Running', containerStatuses: [{ restartCount: 12, ready: false,
        state: { waiting: { reason: 'CrashLoopBackOff' } }, lastState: { terminated: { reason: 'Error', exitCode: 1 } } }] } }],
    events: [{ type: 'Warning', reason: 'BackOff', involvedObject: { kind: 'Pod', name: 'payments-processor-7d9f8c6b5d-x2k4p' },
      count: 40, message: 'Back-off restarting failed container processor', lastTimestamp: new Date().toISOString(),
      metadata: { name: 'e1' } }],
  }),
}));
