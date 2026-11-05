// Copyright 2026 openai-agent-microsandbox contributors
// SPDX-License-Identifier: Apache-2.0
//
// Readable names for what the worker read, from the command that read it: `kubectl get pods -n payments -o wide`
// is "Pods in payments", `pod_logs payments-processor-6957944846-7hfcv --previous` is "Log: payments-processor
// (previous)". A command this does not know is its own name.

const KINDS: Record<string, string> = {
  po: "Pod", pod: "Pod", pods: "Pod", deploy: "Deployment", deployment: "Deployment", deployments: "Deployment",
  rs: "ReplicaSet", replicaset: "ReplicaSet", replicasets: "ReplicaSet", sts: "StatefulSet", statefulset: "StatefulSet",
  statefulsets: "StatefulSet", ds: "DaemonSet", daemonset: "DaemonSet", daemonsets: "DaemonSet", svc: "Service",
  service: "Service", services: "Service", ep: "Endpoints", endpoints: "Endpoints", ev: "Event", event: "Event",
  events: "Event", job: "Job", jobs: "Job", cj: "CronJob", cronjob: "CronJob", cronjobs: "CronJob",
};
// Flags whose value is the next word.
const VALUED = new Set(["-n", "--namespace", "-o", "--output", "-l", "--selector", "-c", "--container", "--sort-by",
  "--tail", "--since", "--field-selector"]);

function parse(command: string) {
  const words = command.trim().split(/\s+/);
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]!;
    if (!word.startsWith("-")) positional.push(word);
    else if (word.includes("=")) flags.set(word.slice(0, word.indexOf("=")), word.slice(word.indexOf("=") + 1));
    else if (VALUED.has(word) && index + 1 < words.length) flags.set(word, words[(index += 1)]!);
    else flags.set(word, "");
  }
  return { tool: words[0], positional, flags };
}

// A pod's workload: a Deployment's pods end in the ReplicaSet's hash and their own.
const workloadOf = (pod: string) => pod.replace(/-[a-z0-9]{8,10}-[a-z0-9]{5}$/, "").replace(/-[a-z0-9]{5}$/, "");

export function readTitle(command?: string): string {
  if (!command) return "";
  const { tool, positional, flags } = parse(command);
  const namespace = flags.get("-n") || flags.get("--namespace");
  const where = namespace ? ` in ${namespace}` : "";
  if (tool === "pod_logs" && positional[0]) return `Log: ${workloadOf(positional[0])}${flags.has("--previous") ? " (previous)" : ""}`;
  if (tool !== "kubectl") return command;
  const [verb, target, named] = positional;
  if (verb === "rollout" && target === "history" && named) return `Rollout history of ${named.split("/").pop()}`;
  if ((verb === "get" || verb === "describe") && target) {
    const [word, slashed] = target.split("/");
    const kind = KINDS[word!.toLowerCase()];
    const name = slashed || named;
    if (!kind) return command;
    if (kind === "Event") return `Events${where}`;
    if (!name) return `${kind === "Endpoints" ? kind : `${kind}s`}${where}`;
    const format = (flags.get("-o") || flags.get("--output") || "").toLowerCase();
    return `${kind} ${name}${verb === "get" && (format === "yaml" || format === "json") ? ` (${format.toUpperCase()})` : ""}`;
  }
  return command;
}
