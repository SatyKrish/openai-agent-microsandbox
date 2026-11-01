// Copyright 2026 openai-agent-mxc contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { summarize } from '../src/health.js';
import { fakeHealthSource } from './helpers.js';

test('workloads are ranked by health, with the reasons from their pods and events', async () => {
  const [payments] = await fakeHealthSource(['payments']);
  const [processor, gateway] = payments!.workloads;
  assert.equal(processor!.name, 'payments-processor');
  assert.equal(processor!.state, 'failing');
  assert.deepEqual(processor!.reasons, ['CrashLoopBackOff', 'last exit: Error (code 1)']);
  assert.equal(processor!.restarts, 12);
  assert.equal(processor!.warnings, 40);
  assert.equal(processor!.last_warning, 'Back-off restarting failed container processor');
  assert.equal(gateway!.state, 'healthy');
  assert.equal(gateway!.ready, 2);
});

test('partial readiness is degraded, old events are ignored, and event text is redacted', () => {
  const now = Date.parse('2026-11-01T06:00:00Z');
  const [pending, api] = summarize('payments',
    [{ metadata: { name: 'payments-api' }, spec: { replicas: 3 }, status: { readyReplicas: 2 } }], [],
    [{ metadata: { name: 'batch-1' }, status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False' }] } }],
    [{ involvedObject: { kind: 'Deployment', name: 'payments-api' }, message: 'probe failed for ops@example.com',
      lastTimestamp: '2026-11-01T05:30:00Z', metadata: { name: 'e1' } },
    { involvedObject: { kind: 'Deployment', name: 'payments-api' }, message: 'old', lastTimestamp: '2026-11-01T03:00:00Z',
      metadata: { name: 'e2' } }], now);
  assert.equal(pending!.name, 'batch-1');
  assert.equal(pending!.state, 'failing');
  assert.deepEqual(pending!.reasons, ['Unschedulable']);
  assert.equal(api!.state, 'degraded');
  assert.equal(api!.warnings, 1);
  assert.equal(api!.last_warning, 'probe failed for [REDACTED_EMAIL]');
});
