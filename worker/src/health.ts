// Copyright 2026 openai-agent-microsandbox contributors
// SPDX-License-Identifier: Apache-2.0
//
// A health summary of the workloads in the worker's namespaces, for the people
// using the UI: which deployments are failing and why, from pod status and
// events, and what changed last: a deployment's rollout, its revision and the
// images it changed. Metadata only, never logs, and it goes to the UI, not to
// the model. Event and status messages pass the same redaction as command output.

import type { KubeApi } from './kube-api.js';
import { redact } from './redact.js';

export type WorkloadState = 'failing' | 'degraded' | 'healthy';

export interface Rollout {
  revision: number;
  at: string;                     // when its ReplicaSet was created
  images: string[];
  previous_revision: number | null;
  changed: Array<{ container: string; from: string; to: string }>;
}

export interface WorkloadEvent { type: string; reason: string; message: string; at: string }

export interface Workload {
  namespace: string;
  kind: string;
  name: string;
  desired: number;
  ready: number;
  restarts: number;
  state: WorkloadState;
  reasons: string[];
  waiting_message: string;        // the kubelet's own words, such as the registry's reply to a pull
  warnings: number;
  last_warning: string;
  last_warning_at: string;
  events: WorkloadEvent[];        // the latest few, of any type
  rollout: Rollout | null;
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
const EVENTS_KEPT = 3;
const REVISION = 'deployment.kubernetes.io/revision';

interface Meta {
  name: string;
  creationTimestamp?: string;
  annotations?: Record<string, string>;
  ownerReferences?: Array<{ kind: string; name: string }>;
}
interface Condition { type: string; status: string; reason?: string; message?: string }
interface Scalable {
  metadata: Meta;
  spec?: { replicas?: number };
  status?: { readyReplicas?: number; conditions?: Condition[] };
}
interface ReplicaSet { metadata: Meta; spec?: { template?: { spec?: { containers?: Array<{ name: string; image?: string }> } } } }
interface ContainerStatus {
  restartCount?: number;
  ready?: boolean;
  state?: { waiting?: { reason?: string; message?: string } };
  lastState?: { terminated?: { reason?: string; exitCode?: number } };
}
interface Pod {
  metadata: Meta;
  status?: { phase?: string; containerStatuses?: ContainerStatus[]; conditions?: Condition[] };
}
interface Event {
  type?: string;
  reason?: string;
  involvedObject?: { kind?: string; name?: string };
  message?: string;
  count?: number;
  lastTimestamp?: string;
  eventTime?: string;
  metadata: Meta;
}

export interface Resources {
  deployments: Scalable[];
  statefulsets?: Scalable[];
  replicasets?: ReplicaSet[];
  pods: Pod[];
  events: Event[];
}

function plain(text: string | undefined, limit = 200): string {
  return redact(text ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

/** A deployment's latest rollout from its ReplicaSets: the newest revision and what it changed from the one before. */
export function rollout(deployment: string, replicasets: ReplicaSet[]): Rollout | null {
  const sets = replicasets
    .filter((set) => set.metadata.ownerReferences?.some((owner) => owner.kind === 'Deployment' && owner.name === deployment))
    .map((set) => ({ revision: Number(set.metadata.annotations?.[REVISION] ?? 0), at: set.metadata.creationTimestamp ?? '',
      containers: set.spec?.template?.spec?.containers ?? [] }))
    .sort((a, b) => b.revision - a.revision);
  const [current, previous] = sets;
  if (!current) return null;
  const before = new Map((previous?.containers ?? []).map((container) => [container.name, container.image ?? '']));
  const changed = previous ? current.containers
    .filter((container) => before.get(container.name) !== (container.image ?? ''))
    .map((container) => ({ container: container.name, from: before.get(container.name) ?? '', to: container.image ?? '' }))
    : [];
  return { revision: current.revision, at: current.at, images: current.containers.map((container) => container.image ?? ''),
    previous_revision: previous ? previous.revision : null, changed };
}

export function summarize(namespace: string, resources: Resources, now = Date.now()): Workload[] {
  const { deployments, statefulsets = [], replicasets = [], pods, events } = resources;
  const workloads = new Map<string, Workload & { reasonSet: Set<string> }>();
  const owner = new Map<string, string>();  // pod or ReplicaSet name -> workload key
  const add = (kind: string, name: string, desired: number, ready: number) => {
    const key = `${kind}/${name}`;
    workloads.set(key, { namespace, kind, name, desired, ready, restarts: 0, state: 'healthy', reasons: [],
      reasonSet: new Set(), waiting_message: '', warnings: 0, last_warning: '', last_warning_at: '', events: [],
      rollout: null });
    return key;
  };
  for (const item of deployments) {
    const key = add('Deployment', item.metadata.name, item.spec?.replicas ?? 1, item.status?.readyReplicas ?? 0);
    const workload = workloads.get(key)!;
    workload.rollout = rollout(item.metadata.name, replicasets);
    for (const condition of item.status?.conditions ?? []) {
      if (condition.type === 'Progressing' && condition.status === 'False' && condition.reason === 'ProgressDeadlineExceeded') {
        workload.reasonSet.add('rollout stuck');
      }
      if (condition.type === 'ReplicaFailure' && condition.status === 'True') {
        workload.reasonSet.add(condition.reason ?? 'ReplicaFailure');
      }
    }
  }
  for (const item of statefulsets) add('StatefulSet', item.metadata.name, item.spec?.replicas ?? 1, item.status?.readyReplicas ?? 0);
  for (const set of replicasets) {
    const deployment = set.metadata.ownerReferences?.find((reference) => reference.kind === 'Deployment');
    if (deployment) owner.set(`ReplicaSet/${set.metadata.name}`, `Deployment/${deployment.name}`);
  }
  for (const pod of pods) {
    const reference = pod.metadata.ownerReferences?.[0];
    // A Deployment's ReplicaSet is named <deployment>-<pod-template-hash>.
    let key = reference?.kind === 'ReplicaSet'
      ? owner.get(`ReplicaSet/${reference.name}`) ?? `Deployment/${reference.name.replace(/-[a-z0-9]+$/, '')}`
      : reference?.kind === 'StatefulSet' ? `StatefulSet/${reference.name}` : '';
    const statuses = pod.status?.containerStatuses ?? [];
    if (!workloads.has(key)) {
      key = add('Pod', pod.metadata.name, 1, statuses.length && statuses.every((status) => status.ready) ? 1 : 0);
    }
    owner.set(`Pod/${pod.metadata.name}`, key);
    const workload = workloads.get(key)!;
    for (const status of statuses) {
      workload.restarts += status.restartCount ?? 0;
      const waiting = status.state?.waiting;
      if (waiting?.reason) workload.reasonSet.add(waiting.reason);
      if (waiting?.message && !workload.waiting_message) workload.waiting_message = plain(waiting.message, 300);
      const terminated = status.lastState?.terminated;
      if (terminated?.reason) workload.reasonSet.add(`last exit: ${terminated.reason} (code ${terminated.exitCode ?? '?'})`);
    }
    const unscheduled = pod.status?.conditions?.some((condition) => condition.type === 'PodScheduled'
      && condition.status === 'False');
    if (pod.status?.phase === 'Pending' && unscheduled) workload.reasonSet.add('Unschedulable');
  }
  for (const event of events) {
    const kind = event.involvedObject?.kind ?? '';
    const name = event.involvedObject?.name ?? '';
    const key = owner.get(`${kind}/${name}`) ?? `${kind}/${name}`;
    const workload = workloads.get(key);
    const at = event.lastTimestamp || event.eventTime || event.metadata.creationTimestamp || '';
    if (!workload || (at && now - Date.parse(at) > RECENT_MS)) continue;
    workload.events.push({ type: event.type ?? 'Normal', reason: event.reason ?? '', message: plain(event.message), at });
    if ((event.type ?? 'Warning') !== 'Warning') continue;
    workload.warnings += event.count ?? 1;
    if (at >= workload.last_warning_at) {
      workload.last_warning_at = at;
      workload.last_warning = plain(event.message);
    }
  }
  const rank: Record<WorkloadState, number> = { failing: 0, degraded: 1, healthy: 2 };
  return [...workloads.values()].map(({ reasonSet, ...workload }) => {
    const reasons = [...reasonSet];
    const blocked = reasons.some((reason) => FAILING.has(reason) || reason === 'Unschedulable' || reason === 'rollout stuck'
      || reason === 'FailedCreate');
    const state: WorkloadState = workload.desired > 0 && workload.ready === 0 ? 'failing'
      : workload.ready < workload.desired || blocked ? 'degraded' : 'healthy';
    const latest = workload.events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, EVENTS_KEPT);
    return { ...workload, reasons, state, events: latest };
  }).sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
}

export function apiHealthSource(api: KubeApi): HealthSource {
  return (namespaces) => Promise.all(namespaces.map(async (namespace) => {
    try {
      const [deployments, statefulsets, replicasets, pods, events] = await Promise.all([
        api.json<{ items: Scalable[] }>(`/apis/apps/v1/namespaces/${namespace}/deployments`),
        api.json<{ items: Scalable[] }>(`/apis/apps/v1/namespaces/${namespace}/statefulsets`),
        api.json<{ items: ReplicaSet[] }>(`/apis/apps/v1/namespaces/${namespace}/replicasets`),
        api.json<{ items: Pod[] }>(`/api/v1/namespaces/${namespace}/pods`),
        api.json<{ items: Event[] }>(`/api/v1/namespaces/${namespace}/events`),
      ]);
      return { namespace, error: '', workloads: summarize(namespace, { deployments: deployments.items,
        statefulsets: statefulsets.items, replicasets: replicasets.items, pods: pods.items, events: events.items }) };
    } catch (error) {
      return { namespace, workloads: [], error: String((error as Error).message ?? error).slice(0, 300) };
    }
  }));
}
