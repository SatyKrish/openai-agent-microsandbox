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
| Memory | What a user's earlier investigations of this application learned, distilled by the SDK when a conversation's session closes and carried by the harness into that user's later conversations. Without sign-in, everyone shares the guest's. |

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

- **Top bar.** One button says what the agent reads and with which model, and
  turns amber when the worker is unreachable. It opens **How this works**: the
  worker, its containment and egress, and how the agent is contained, said once
  here rather than on every view. Settings opens it too.
- **Issues.** The health board opens an issue for each unhealthy workload,
  without a model call, and the history lists it beside your conversations.
  An issue is shared: everyone sees it and can investigate in it, and only an
  admin can delete it. It starts with a card of what the worker read (state,
  reasons, restarts, readiness, the latest warning and when it was read);
  **Investigate** puts the question in the composer, and the agent is told
  which issue it is in. When the workload is healthy again, the issue is marked
  recovered; if it fails later, a new issue opens.
- **Start screen.** Under the composer, each namespace lists its workloads,
  failing first, with readiness and why each is unhealthy (waiting reasons, the
  last exit, restarts, when the latest warning happened). Only each workload's
  dot is coloured. **Open issue** opens a workload's issue with the question
  in the composer (**Investigate** starts a conversation when there is none);
  **Investigate all** asks about every unhealthy one. The worker builds this summary
  with its own identity; it is not sent to the model. The side panel stays
  closed until a conversation has output.
- **Memory.** The book button beside the history button shows what the agent
  remembers the way history shows conversations: one entry per earlier
  conversation, grouped by day. Select one to open it, forget one, or forget
  everything. **Correct something** starts a conversation to tell the agent what
  is wrong; it is remembered when that conversation goes idle. While history
  itself is open, the start screen steps aside.
- **Steps.** Each step is titled with what ran (`kubectl describe pod …`,
  `pod_logs payments-api -n payments match="timeout"`); its icon says where it
  ran. The title adds only what is unusual: a non-zero exit, or `harness` for a
  harness tool.
- **Findings.** `output/findings.json` opens as one section per finding, titled
  by its short problem label: the workload, the cause, the proposed fix as a code
  block with a copy button, and each quote with its evidence file, which opens
  the file at that line. A line above says how many quotes the host check found;
  a failed check is red.
- **Evidence.** The side panel names each evidence file by the read that
  produced it (`kubectl get pods -n payments -o wide`, `pod_logs …`), with the
  file name on hover; files from earlier turns are muted. A log excerpt says how
  many lines it shows of how many, with errors and warnings highlighted and
  masked values and collapsed repeats marked. A `kubectl get` read shows as a
  table; only failing statuses are coloured.
- **Trace.** One line of totals (time, model calls, tokens, tool calls,
  failures), then each lane and step on one time axis. Bars take their lane's
  colour; failed commands are red.

## Memory

When a conversation's session closes, after `SRE_SESSION_IDLE_S` without a
message or when the harness stops, the SDK distils it into memory, guided by
[`agent/memory.md`](agent/memory.md): workloads and their dependencies, causes
the evidence confirmed, fixes proposed, and which reads found the cause.
`gpt-6-luna` extracts each conversation and `gpt-6.1-terra` consolidates; the
rest are the SDK's defaults. Memory belongs to the user who started the
conversation: the signed-in user, or the guest, whose memory everyone without
sign-in shares. The harness keeps each user's memory on its volume
(`/data/memory/users/`) and seeds it into that user's new conversations, where
the agent reads it as a lead and checks it against fresh evidence.

The agent cannot edit memory during a run, and memory never holds raw logs,
credentials or personal data. Conversations are forgotten 90 days after their
last message (`SRE_MEMORY_MAX_AGE_DAYS`), beyond the newest 256, and when
deleted. See [architecture](../../docs/architecture.md#memory-across-conversations).

## Settings

The harness reads these from its environment (or the matching flags of
`python -m examples.sre.ui`). In the cluster, the `OPENAI_*` settings come from
`.env` through the `openai-creds` Secret (`make secrets`), and the rest are in
the harness's manifest
([`harness.yaml`](../../deploy/kubernetes/base/harness.yaml)); apply either and
the harness pod restarts with them.

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENAI_MODEL`, `OPENAI_API_KEY` | none | The agent's model and the key for it |
| `SRE_NAMESPACES` | `payments` | The namespaces the agent is told it may read |
| `SRE_MAX_TURNS` | `25` | Model steps per turn; at the limit the agent stops and offers to continue |
| `SRE_SESSION_IDLE_S` | `300` | Seconds a conversation's session stays open after a turn; memory is generated when it closes |
| `SRE_MEMORY` | `on` | `off` turns memory off |
| `MEMORY_EXTRACT_MODEL`, `MEMORY_CONSOLIDATE_MODEL` | `gpt-6-luna`, `gpt-6.1-terra` | The models that extract each conversation and consolidate a user's memory |
| `SRE_MEMORY_MAX_AGE_DAYS` | `90` | Forget conversations this many days after their last message; `0` keeps them |
| `SRE_USER_HEADER` | unset | The header in which an authenticating proxy passes the signed-in user; unset, everyone is the guest. See [signing users in](../../docs/deployment.md#signing-users-in) |
| `SRE_ADMIN_USERS` | unset | Signed-in users, comma-separated, who see and may delete every conversation and issue |
| `SRE_ISSUES` | `on` | `off` stops the health board opening issues |
| `SRE_ISSUE_EVERY_S` | `30` | Seconds between the health board's checks for issues |
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
ui/                         The UI: its page served beside the harness's API, the turn card and the launcher
  static/                   The page: app.js (chat, panel, memory view), sre.js (health board, findings,
                            log excerpts, kubectl tables), styles, and the trace and file views
evals/                      Tests against the worker's real gRPC service
verify.py                   In-cluster boundary probes and a scripted investigation
loadtest.py                 Many conversations and users at once
```
