// Copyright 2026 openai-agent-mxc contributors
// SPDX-License-Identifier: Apache-2.0
//
// The left column's view of the cluster, kept while a conversation is open: each namespace's unhealthy
// workloads with what is wrong, each opening the issue the health board opened for it (or a new
// investigation without one), and the healthy ones as a count. The worker reads it with its own identity.

import { question } from "../../static/sre.js";

import { workloadKey, type Conversation, type Health, type Workload } from "./api";

const clock = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");
const why = (workload: Workload) => [...workload.reasons,
  workload.restarts ? `${workload.restarts} restart${workload.restarts === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ")
  || workload.last_warning || workload.state;

export function HealthList({ health, issues, current, onOpen, onInvestigate }: {
  health: Health | null | undefined; issues: Map<string, Conversation>; current: string | null;
  onOpen: (id: string) => void; onInvestigate: (question: string) => void;
}) {
  if (health === undefined) return null;
  if (health === null) return <p className="ax-list-empty err">Can't reach the worker for cluster health.</p>;
  return (
    <section className="ax-health" aria-label="Cluster health">
      <h2 className="ax-list-head">Health now<span className="ax-muted">{health.generated_at ? ` as of ${clock(health.generated_at)}` : ""}</span></h2>
      {health.namespaces.map(({ namespace, error, workloads }) => {
        const unhealthy = workloads.filter((workload) => workload.state !== "healthy");
        const healthy = workloads.length - unhealthy.length;
        return (
          <div key={namespace} className="ax-health-ns">
            <div className="ax-health-ns-head">
              <span>{namespace}</span>
              <span className="ax-muted">{error ? "unreadable" : unhealthy.length ? `${unhealthy.length} unhealthy · ${healthy} healthy`
                : `all ${healthy} healthy`}</span>
            </div>
            {error ? <p className="ax-list-empty err" title={error}>Could not read {namespace}.</p> : (
              <ul className="ax-list">
                {unhealthy.map((workload) => {
                  const issue = issues.get(workloadKey(namespace, workload.kind, workload.name));
                  return (
                    <li key={workload.name}>
                      <button type="button" className="ax-workload" aria-current={issue && issue.id === current ? "page" : undefined}
                        title={workload.waiting_message || workload.last_warning || workload.kind}
                        onClick={() => (issue ? onOpen(issue.id) : onInvestigate(question(workload, namespace)))}>
                        <span className={`ax-dot ${workload.state}`} aria-label={workload.state} />
                        <span className="ax-workload-text">
                          <span className="ax-workload-name">{workload.name}<span className="ax-muted"> {workload.ready}/{workload.desired}</span></span>
                          <span className="ax-workload-why">{why(workload)}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </section>
  );
}
