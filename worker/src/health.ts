// Copyright 2026 openai-agent-mxc contributors
// SPDX-License-Identifier: Apache-2.0
//
// A health summary of the workloads in the worker's namespaces, for the people
// using the UI: which deployments are failing and why, from pod status and
// warning events. Metadata only, never logs, and it goes to the UI, not to the
// model. Event messages pass the same redaction as command output.

import type { KubeApi } from './kube-api.js';
import { redact } from './redact.js';

export type WorkloadState = 'failing' | 'degraded' | 'healthy';

export interface Workload {
  namespace: string;
  kind: string;
  name: string;
  desired: number;
  ready: number;
  restarts: number;
  state: WorkloadState;
  reasons: string[];
  warnings: number;
  last_warning: string;
  last_warning_at: string;
}

export interface NamespaceHealth {
  namespace: string;
  workloads: Workload[];
  error: string;
}

export interface HealthSource {
  (namespaces: string[]): Promise<NamespaceHealth[]>;
}

// Waiting reasons that mean a container cannot run as configured.
const FAILING = new Set(['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError',
  'CreateContainerError', 'InvalidImageName', 'RunContainerError']);
const RECENT_MS = 60 * 60 * 1000;

interface Meta { name: string; creationTimestamp?: string; ownerReferences?: Array<{ kind: string; name: string }> }
interface Scalable { metadata: Meta; spec?: { replicas?: number }; status?: { readyReplicas?: number } }
interface ContainerStatus {
  restartCount?: number;
  ready?: boolean;
  state?: { waiting?: { reason?: string } };
  lastState?: { terminated?: { reason?: string; exitCode?: number } };
}
interface Pod {
  metadata: Meta;
  status?: { phase?: string; containerStatuses?: ContainerStatus[]; conditions?: Array<{ type: string; status: string }> };
}
interface Event {
  involvedObject?: { kind?: string; name?: string };
  message?: string;
  count?: number;
  lastTimestamp?: string;
  eventTime?: string;
  metadata: Meta;
}

export function summarize(namespace: string, deployments: Scalable[], statefulsets: Scalable[], pods: Pod[],
  events: Event[], now = Date.now()): Workload[] {
  const workloads = new Map<string, Workload & { reasonSet: Set<string> }>();
  const owner = new Map<string, string>();  // pod name -> workload key
  const add = (kind: string, name: string, desired: number, ready: number) => {
    const key = `${kind}/${name}`;
    workloads.set(key, { namespace, kind, name, desired, ready, restarts: 0, state: 'healthy', reasons: [],
      reasonSet: new Set(), warnings: 0, last_warning: '', last_warning_at: '' });
    return key;
  };
  for (const item of deployments) add('Deployment', item.metadata.name, item.spec?.replicas ?? 1, item.status?.readyReplicas ?? 0);
  for (const item of statefulsets) add('StatefulSet', item.metadata.name, item.spec?.replicas ?? 1, item.status?.readyReplicas ?? 0);
  for (const pod of pods) {
    const reference = pod.metadata.ownerReferences?.[0];
    // A Deployment's ReplicaSet is named <deployment>-<pod-template-hash>.
    let key = reference?.kind === 'ReplicaSet' ? `Deployment/${reference.name.replace(/-[a-z0-9]+$/, '')}`
      : reference?.kind === 'StatefulSet' ? `StatefulSet/${reference.name}` : '';
    const statuses = pod.status?.containerStatuses ?? [];
    if (!workloads.has(key)) {
      key = add('Pod', pod.metadata.name, 1, statuses.length && statuses.every((status) => status.ready) ? 1 : 0);
    }
    owner.set(pod.metadata.name, key);
    const workload = workloads.get(key)!;
    for (const status of statuses) {
      workload.restarts += status.restartCount ?? 0;
      const waiting = status.state?.waiting?.reason;
      if (waiting) workload.reasonSet.add(waiting);
      const terminated = status.lastState?.terminated;
      if (terminated?.reason) workload.reasonSet.add(`last exit: ${terminated.reason} (code ${terminated.exitCode ?? '?'})`);
    }
    const unscheduled = pod.status?.conditions?.some((condition) => condition.type === 'PodScheduled'
      && condition.status === 'False');
    if (pod.status?.phase === 'Pending' && unscheduled) workload.reasonSet.add('Unschedulable');
  }
  for (const event of events) {
    const name = event.involvedObject?.name ?? '';
    const key = owner.get(name) ?? `${event.involvedObject?.kind ?? ''}/${name}`;
    const workload = workloads.get(key);
    const at = event.lastTimestamp || event.eventTime || event.metadata.creationTimestamp || '';
    if (!workload || (at && now - Date.parse(at) > RECENT_MS)) continue;
    workload.warnings += event.count ?? 1;
    if (at >= workload.last_warning_at) {
      workload.last_warning_at = at;
      workload.last_warning = redact(event.message ?? '').replace(/\s+/g, ' ').slice(0, 200);
    }
  }
  const rank: Record<WorkloadState, number> = { failing: 0, degraded: 1, healthy: 2 };
  return [...workloads.values()].map(({ reasonSet, ...workload }) => {
    const reasons = [...reasonSet];
    const blocked = reasons.some((reason) => FAILING.has(reason) || reason === 'Unschedulable');
    const state: WorkloadState = workload.desired > 0 && workload.ready === 0 ? 'failing'
      : workload.ready < workload.desired || blocked ? 'degraded' : 'healthy';
    return { ...workload, reasons, state };
  }).sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
}

export function apiHealthSource(api: KubeApi): HealthSource {
  return (namespaces) => Promise.all(namespaces.map(async (namespace) => {
    try {
      const [deployments, statefulsets, pods, events] = await Promise.all([
        api.json<{ items: Scalable[] }>(`/apis/apps/v1/namespaces/${namespace}/deployments`),
        api.json<{ items: Scalable[] }>(`/apis/apps/v1/namespaces/${namespace}/statefulsets`),
        api.json<{ items: Pod[] }>(`/api/v1/namespaces/${namespace}/pods`),
        api.json<{ items: Event[] }>(`/api/v1/namespaces/${namespace}/events?fieldSelector=type%3DWarning`),
      ]);
      return { namespace, error: '', workloads: summarize(namespace, deployments.items, statefulsets.items, pods.items,
        events.items) };
    } catch (error) {
      return { namespace, workloads: [], error: String((error as Error).message ?? error).slice(0, 300) };
    }
  }));
}
