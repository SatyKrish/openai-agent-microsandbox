# SRE agent

Investigates unhealthy Kubernetes workloads and explains each cause with
evidence. It reads the cluster with kubectl inside its MXC containers, using the
sandbox worker's read-only identity, and cannot change anything. It runs on the
[shared harness](../../harness/src/openai_harness/chat.py) and its UI.

| Where | What runs there |
| --- | --- |
| Harness | The agent loop, the model calls and the host check. No Kubernetes token. |
| MXC containers on the worker | kubectl, the shell, Python and the `kubernetes-triage` skill, over the conversation's workspace. No credentials; network to the worker's read-only API proxy only. |
| The worker's API proxy | Adds the worker's token to kubectl's reads and refuses writes, `exec`, pod logs and anything that is not the Kubernetes API. |
| `pod_logs` tool | Gets a pod's log from the worker as an excerpt: errors and warnings with context, the last lines, repeats collapsed, credentials and personal data masked, at most 40 lines. The raw log never leaves the worker. |
| Worker journal | Every command, and the output of every plain kubectl read as evidence. No container can see it. |
| Host check | Every quote in `output/findings.json` must appear in the worker's copy of the evidence file it cites. |
| Memory | What earlier investigations of this application learned, distilled by the SDK when a conversation's session closes and shared by the harness with later conversations. |

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
and the command's output ends with `[mxc-worker] saved as …`. Each `pod_logs`
excerpt is saved the same way as `evidence/NNN-pod-logs-....txt`. The agent analyzes
the workspace copies with the shell and Python; the harness checks quotes
against the journal's. Editing `evidence/` in the sandbox cannot make a quote
pass.

## Run it

After [local Kubernetes setup](../../docs/local-kubernetes.md), `make ui` opens
<http://localhost:8001>. The demo has a `payments-processor` that exits without
`DATABASE_URL` (CrashLoopBackOff), a `payments-ledger` whose image tag was never
published (ImagePullBackOff), a healthy `payments-gateway`, and a running
`payments-api` that logs customer emails and card numbers on every request and
an upstream timeout every 200: ask why its charges fail, and only masked
excerpts of its log reach the model. Every new
workspace starts with the team's runbooks in `runbooks/`.

The model is live (`OPENAI_MODEL`, `OPENAI_API_KEY`), so every message incurs
model API usage, and so does memory generation when a conversation's session
closes. `make verify` and `make loadtest` use a scripted model instead.

## Using the UI

- **Start screen.** "Cluster now" lists each workload in scope, failing first,
  with its readiness, restarts and why it is unhealthy (waiting reasons, the last
  exit, recent warning events). **Investigate** starts a conversation about one
  workload; **Investigate all** about every unhealthy one. The worker builds
  this summary with its own identity; it is not sent to the model. Below it,
  **What the agent remembers** shows the agent's memory summary.
- **Steps.** Each step is titled with what ran (`kubectl describe pod …`,
  `pod_logs payments-api -n payments match="timeout"`) and where: the sandbox or
  the harness.
- **Findings.** `output/findings.json` opens as cards: the workload, the
  problem, the cause, the proposed fix (marked "not run", with a copy button)
  and each quote with **Show in source**, which opens the evidence file at that
  line. A banner says whether the host check passed.
- **Evidence.** A log excerpt shows its counts (read, shown, withheld, masked),
  errors and warnings highlighted, masked values and collapsed repeats marked.
  A `kubectl get` read shows as a table with status coloured.

## Memory

When a conversation's session closes, after `SRE_SESSION_IDLE_S` without a
message or when the harness stops, the SDK distils it into memory with the
agent's model, guided by [`agent/memory.md`](agent/memory.md): workloads and
their dependencies, causes the evidence confirmed, fixes proposed, and which
reads found the cause. The harness keeps that memory on its volume
(`/data/memory`) and seeds it into every new conversation, where the agent
reads it as a lead and checks it against fresh evidence. The agent cannot edit
memory during a run, memory never holds raw logs, credentials or personal data,
and deleted conversations are not remembered. See
[architecture](../../docs/architecture.md#memory-across-conversations).

## Settings

The harness reads these from its environment (or the matching flags of
`python -m examples.sre.ui`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENAI_MODEL`, `OPENAI_API_KEY` | none | The agent's model and the key for it |
| `SRE_NAMESPACES` | `payments` | The namespaces the agent is told it may read |
| `SRE_MAX_TURNS` | `25` | Model steps per turn; at the limit the agent stops and offers to continue |
| `SRE_SESSION_IDLE_S` | `300` | Seconds a conversation's session stays open after a turn; memory is generated when it closes |
| `SRE_MEMORY_MODEL` | the agent's model | The model that generates memory; `off` turns memory off |
| `SRE_DATA_DIR` | `artifacts/sre` | Threads, history, host copies of outputs and evidence, and memory |

## Layout

```text
agent/
  agent.py                  SandboxAgent: shell, filesystem, skills, compaction, memory
  instructions.md           Standing behavior: plain kubectl reads, evidence, no changes
  memory.md                 What memory may and may not keep
  skills/kubernetes-triage/ Procedure, failure patterns, triage.py
  runbooks/                 The application team's runbooks, seeded into every workspace
  tools/logs.py             The pod_logs tool: logs only through the worker's log policy
  lib/findings.py           Host check of findings.json against the evidence
  spec.py                   AgentSpec for the harness
ui/                         Settings for the shared page, the turn card and the launcher
  static/                   The start screen, findings cards and evidence views
evals/                      Tests against the worker's real gRPC service
verify.py                   In-cluster boundary probes and a scripted investigation
loadtest.py                 Many conversations and users at once
```
