// Copyright 2026 openai-agent-mxc contributors
// SPDX-License-Identifier: Apache-2.0
//
// The worker reads pod logs itself, with its own token, so raw logs never enter
// a container. Callers get them only through the log policy (log-policy.ts).

import { ApiError, type KubeApi } from './kube-api.js';

export { ApiError as LogError } from './kube-api.js';

export interface LogQuery {
  namespace: string;
  pod: string;              // a pod name, or deploy/NAME (or deployment/NAME) for its newest pod
  container?: string;
  previous: boolean;
  tailLines: number;
  sinceSeconds?: number;
  limitBytes: number;
}

export interface LogSource {
  (query: LogQuery): Promise<{ pod: string; text: string }>;
}

// The kubelet reports some failures, such as a previous container whose log file is
// gone, as a one-line body with a success status. That is not the container's output.
const KUBELET_FAILURE = /^unable to retrieve container logs for \S+\s*$/;

export function apiLogSource(api: Pick<KubeApi, 'get' | 'json'>): LogSource {
  async function resolvePod(namespace: string, name: string): Promise<string> {
    const deployment = /^(?:deploy|deployment|deployments)\/(.+)$/.exec(name)?.[1];
    if (!deployment) return name;
    const spec = await api.json<{ spec?: { selector?: { matchLabels?: Record<string, string> } } }>(
      `/apis/apps/v1/namespaces/${namespace}/deployments/${deployment}`);
    const labels = Object.entries(spec.spec?.selector?.matchLabels ?? {}).map(([key, value]) => `${key}=${value}`);
    if (!labels.length) throw new ApiError(400, `deployment ${deployment} has no label selector`);
    const pods = await api.json<{ items: Array<{ metadata: { name: string; creationTimestamp: string } }> }>(
      `/api/v1/namespaces/${namespace}/pods?labelSelector=${encodeURIComponent(labels.join(','))}`);
    const newest = pods.items.sort((a, b) => b.metadata.creationTimestamp.localeCompare(a.metadata.creationTimestamp))[0];
    if (!newest) throw new ApiError(404, `deployment ${deployment} has no pods`);
    return newest.metadata.name;
  }

  return async (query) => {
    const pod = await resolvePod(query.namespace, query.pod);
    const params = new URLSearchParams({ tailLines: String(query.tailLines), limitBytes: String(query.limitBytes) });
    if (query.container) params.set('container', query.container);
    if (query.previous) params.set('previous', 'true');
    if (query.sinceSeconds) params.set('sinceSeconds', String(query.sinceSeconds));
    const text = await api.get(`/api/v1/namespaces/${query.namespace}/pods/${pod}/log?${params}`);
    if (KUBELET_FAILURE.test(text)) {
      throw new ApiError(404, `the kubelet no longer has the ${query.previous ? 'previous ' : ''}container's log `
        + `for pod ${pod} (${text.trim()})`);
    }
    return { pod, text };
  };
}
