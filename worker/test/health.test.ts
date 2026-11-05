// Copyright 2026 openai-agent-microsandbox contributors
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
  const [pending, api] = summarize('payments', {
    deployments: [{ metadata: { name: 'payments-api' }, spec: { replicas: 3 }, status: { readyReplicas: 2 } }],
    pods: [{ metadata: { name: 'batch-1' }, status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False' }] } }],
    events: [{ involvedObject: { kind: 'Deployment', name: 'payments-api' }, message: 'probe failed for ops@example.com',
      lastTimestamp: '2026-11-01T05:30:00Z', metadata: { name: 'e1' } },
    { involvedObject: { kind: 'Deployment', name: 'payments-api' }, message: 'old', lastTimestamp: '2026-11-01T03:00:00Z',
      metadata: { name: 'e2' } }],
  }, now);
  assert.equal(pending!.name, 'batch-1');
  assert.equal(pending!.state, 'failing');
  assert.deepEqual(pending!.reasons, ['Unschedulable']);
  assert.equal(api!.state, 'degraded');
  assert.equal(api!.warnings, 1);
  assert.equal(api!.last_warning, 'probe failed for [REDACTED_EMAIL]');
});

test('a deployment says what changed: its rollout, revision and images, and the registry\'s words', () => {
  const now = Date.parse('2026-11-01T06:00:00Z');
  const owned = (name: string, revision: string, image: string, at: string) => ({
    metadata: { name, creationTimestamp: at, annotations: { 'deployment.kubernetes.io/revision': revision },
      ownerReferences: [{ kind: 'Deployment', name: 'payments-ledger' }] },
    spec: { template: { spec: { containers: [{ name: 'ledger', image }] } } } });
  const [ledger] = summarize('payments', {
    deployments: [{ metadata: { name: 'payments-ledger' }, spec: { replicas: 1 }, status: { readyReplicas: 0, conditions: [
      { type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded' }] } }],
    replicasets: [owned('payments-ledger-aaa', '7', 'ledger:2.4.0', '2026-10-30T10:00:00Z'),
      owned('payments-ledger-bbb', '8', 'ledger:2.4.1', '2026-11-01T05:54:00Z')],
    pods: [{ metadata: { name: 'payments-ledger-bbb-x1', ownerReferences: [{ kind: 'ReplicaSet', name: 'payments-ledger-bbb' }] },
      status: { phase: 'Pending', containerStatuses: [{ ready: false, state: { waiting: { reason: 'ImagePullBackOff',
        message: 'Back-off pulling image "ledger:2.4.1": manifest unknown' } } }] } }],
    events: [{ type: 'Normal', reason: 'ScalingReplicaSet', involvedObject: { kind: 'Deployment', name: 'payments-ledger' },
      message: 'Scaled up replica set payments-ledger-bbb to 1', lastTimestamp: '2026-11-01T05:54:00Z', metadata: { name: 'n1' } },
    { type: 'Warning', reason: 'FailedCreate', involvedObject: { kind: 'ReplicaSet', name: 'payments-ledger-bbb' },
      message: 'exceeded quota: compute', lastTimestamp: '2026-11-01T05:55:00Z', metadata: { name: 'w1' } }],
  }, now);
  assert.deepEqual(ledger!.rollout, { revision: 8, at: '2026-11-01T05:54:00Z', images: ['ledger:2.4.1'], previous_revision: 7,
    changed: [{ container: 'ledger', from: 'ledger:2.4.0', to: 'ledger:2.4.1' }] });
  assert.equal(ledger!.waiting_message, 'Back-off pulling image "ledger:2.4.1": manifest unknown');
  assert.deepEqual(ledger!.reasons, ['rollout stuck', 'ImagePullBackOff']);
  // A ReplicaSet's event belongs to its deployment; Normal events are listed but not counted as warnings.
  assert.equal(ledger!.warnings, 1);
  assert.equal(ledger!.last_warning, 'exceeded quota: compute');
  assert.deepEqual(ledger!.events.map((event) => event.reason), ['FailedCreate', 'ScalingReplicaSet']);
});
