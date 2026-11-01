# SRE agent

Investigates unhealthy Kubernetes workloads and explains each cause with
evidence. It reads the cluster with kubectl inside its MXC containers, using the
sandbox worker's read-only identity, and cannot change anything. It runs on the
[shared harness](../../harness/src/openai_harness/chat.py) and its UI.

| Where | What runs there |
| --- | --- |
| Harness | The agent loop, the model calls and the host check. No Kubernetes token. |
| MXC containers on the worker | kubectl, the shell, Python and the `kubernetes-triage` skill, over the conversation's workspace. No credentials; network to the worker's read-only API proxy only. |
| The worker's API proxy | Adds the worker's token to kubectl's reads and refuses writes, `exec` and anything that is not the Kubernetes API. |
| Worker journal | Every command, and the output of every plain kubectl read as evidence. No container can see it. |
| Host check | Every quote in `output/findings.json` must appear in the worker's copy of the evidence file it cites. |

## Access

`payments-sre-sa` is used only by the worker's API proxy; containers never see
its token. It holds a Role in `payments` that grants `get`, `list` and
`watch` on pods, pod logs, events, services, endpoints, deployments, replica
sets, stateful sets, daemon sets, jobs and cron jobs. It grants nothing on
Secrets or ConfigMaps, no write verbs, no `exec` or port-forward, and nothing
cluster-wide; the proxy refuses writes even if the Role is widened.
`kubectl describe` shows what a pod spec contains, including
literal environment values, so keep secrets in Secrets; the worker redacts the
credential patterns it recognizes.

## Evidence

A plain kubectl read (no pipes, redirections, quotes or `$`) is saved by the
worker in its journal and in the workspace as `evidence/NNN-kubectl-....txt`,
and the command's output ends with `[mxc-worker] saved as …`. The agent analyzes
the workspace copies with the shell and Python; the harness checks quotes
against the journal's. Editing `evidence/` in the sandbox cannot make a quote
pass.

## Run it

After [local Kubernetes setup](../../docs/local-kubernetes.md), `make ui` opens
<http://localhost:8001>. The demo has a `payments-processor` that exits without
`DATABASE_URL` (CrashLoopBackOff), a `payments-ledger` whose image tag was never
published (ImagePullBackOff), and a healthy `payments-gateway`. Every new
workspace starts with the team's runbooks in `runbooks/`.

The model is live (`OPENAI_MODEL`, `OPENAI_API_KEY`), so every message incurs
model API usage. `make verify` and `make loadtest` use a scripted model instead.

## Layout

```text
agent/
  agent.py                  SandboxAgent: shell, filesystem, skills
  instructions.md           Standing behavior: plain kubectl reads, evidence, no changes
  skills/kubernetes-triage/ Procedure, failure patterns, triage.py
  runbooks/                 The application team's runbooks, seeded into every workspace
  lib/findings.py           Host check of findings.json against the evidence
  spec.py                   AgentSpec for the harness
ui/                         Settings for the shared page, the turn card and the launcher
evals/                      Tests against the worker's real gRPC service
verify.py                   In-cluster boundary probes and a scripted investigation
loadtest.py                 Many conversations and users at once
```
