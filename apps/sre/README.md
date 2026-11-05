# SRE agent

Investigates unhealthy Kubernetes workloads and explains each cause with
evidence. It reads the cluster with kubectl inside its session's VM, using the
sandbox worker's read-only identity, and cannot change anything. It runs on the
[shared harness](../../harness/src/openai_harness/engine.py) and its UI.

| Where | What runs there |
| --- | --- |
| Harness | The agent loop, the model calls and the host check. No Kubernetes token. |
| The conversation's VM on the worker | kubectl, the shell, Python and the `kubernetes-triage` skill, over the conversation's workspace. No credentials; network to the worker's read-only API proxy only. |
| The worker's API proxy | Adds the worker's token to kubectl's reads and refuses writes, `exec`, pod logs and anything that is not the Kubernetes API. |
| `pod_logs` tool | Gets a pod's log from the worker as an excerpt: errors, server errors and warnings with context and stack traces, the last lines, repeats collapsed with status codes and addresses kept apart, credentials and personal data masked, at most 40 lines; `since` limits it to recent lines. The raw log never leaves the worker. |
| Worker journal | Every command, and the output of every plain kubectl read as evidence. No VM can see it. |
| Host check | Every quote in `output/findings.json` must appear in the worker's copy of the evidence file it cites. Each quote's result is reported; when one is missing, the agent gets one pass to correct the findings, and the card says so. |
| Memory | What a user's earlier investigations of this application learned, distilled by the SDK when a conversation's session closes and carried by the harness into that user's later conversations. Without sign-in, everyone shares the guest's. |

## Access

`payments-sre-sa` is used only by the worker's API proxy; VMs never see
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
and the command's output ends with `[sandbox-worker] saved as …`. Each `pod_logs`
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
  worker, its isolation and egress, and how the agent is contained, said once
  here rather than on every view. Settings opens it too. In a conversation, the
  panel button shows or hides the side panel.
- **Left column.** A sidebar of icons with their names: New investigation,
  History and Memory, with the section that is open shown under them. The button
  at its top collapses it to the same icons in the same places, each named on
  hover; a collapsed icon opens the sidebar at its section, and the page
  remembers whether it was collapsed. History carries a red count of unhealthy
  workloads, or a green dot while a turn runs, open or collapsed. On a phone the
  menu button opens it over the conversation.
- **History.** The History tab starts with **Health now**: each namespace's
  unhealthy workloads, with readiness and what is wrong, read every 10 s and kept
  while a conversation is open; each opens its issue, or puts a question in the
  composer when it has none, and healthy ones are a count. Then your
  conversations, then recovered issues, each with when it started and how many
  turns it has; a green dot marks a turn that is running. A link to a
  conversation (`?c=ID`) opens it; a link to one that was deleted, or that is
  someone else's, says so. Stop in the composer stops the running turn.
- **Issues.** The health board opens an issue for each unhealthy workload,
  without a model call, and Health now opens it from the workload's row (an open
  issue whose workload is not listed there shows under Open issues).
  An issue is shared: everyone sees it and can investigate in it, and only an
  admin can delete it. It starts with a card of what the worker read (state,
  reasons, restarts, readiness, the latest warning and when it was read);
  **Investigate** puts the question in the composer, and the agent is told
  which issue it is in. When the workload is healthy again, the issue is marked
  recovered; if it fails later, a new issue opens.
- **Start screen.** Above the composer, each namespace lists its workloads,
  failing first, with readiness and why each is unhealthy (waiting reasons, the
  last exit, restarts, when the latest warning happened). Only each workload's
  dot is coloured. Each row also says what changed: the latest rollout, its
  revision and any image it changed, and the kubelet's own message on hover.
  **Open issue** opens a workload's issue with the question
  in the composer (**Investigate** starts a conversation when there is none);
  **Investigate all** asks about every unhealthy one. The worker builds this summary
  with its own identity; it is not sent to the model.
- **Memory.** The left column's Memory tab, beside History, shows what the agent
  remembers the way History shows conversations: one entry per earlier
  conversation, grouped by day, while the conversation stays open beside it. Select one to open it, forget one, or forget
  everything. **Correct something** starts a conversation to tell the agent what
  is wrong; it is remembered when that conversation goes idle.
- **A turn.** The chat says what happened and the findings hold the detail, as
  with an artifact. While the agent works, its steps show as they run, its
  narration muted between them, with a Working line while the model thinks. When
  the turn ends, one line ("Worked for 42 s, 16 steps") opens the steps and
  narration, then comes the reply of two or three sentences and, when the turn
  wrote the findings, one card for them: "Findings" (or "Findings, version 2"),
  what each finding is about (`payments-ledger · ImagePullBackOff`), what the host
  check found, and **Open**, with the turn's time, steps and tokens. On a wide
  screen a turn that wrote the findings opens them in the side panel. A failed
  check names the quote that was not found and the read it cites, with **Ask the
  agent to fix**, which sends that back as the next message. Each step is titled
  with what ran (`kubectl describe pod …`,
  `pod_logs payments-api -n payments match="timeout"`); its icon says where it
  ran. The title adds only what is unusual: a non-zero exit, or `harness` for a
  harness tool.
- **The side panel.** It shows one thing at a time, named in its header. The
  title is a menu of everything else: the outputs (Findings, the Report in
  Markdown, with their versions), the evidence (each read by its command and
  turn), the team's runbooks, and a turn's trace. Under the title: "Version 2 of
  2, written after …" for an output, or a read's command and turn. Arrows step
  through an output's versions, one per turn that rewrote it. **Rendered** or
  **Source**, **Copy** and **Download** act on what is open; on a phone the panel
  is a full-screen sheet and those three share one menu.
- **Findings.** A line says what the host check found ("2 findings; every quote
  is in the evidence it cites", and that the causes are the agent's reasoning),
  or how many quotes were not, with Ask the agent to fix; a correction after a
  failed first check is said. Each finding has its short problem label, the
  workload and its state now as the worker reads it, the cause, the proposed fix
  as steps (check first, run, verify, undo) where each command block has Copy
  and advice shows as text, its risk, and Ruled out. Under Evidence each quote
  shows the read it came from and when, and opens that read with the quote
  highlighted. A finding whose quote was not found is marked Unverified, with
  that quote in red. **Copy as Markdown** copies the check, each finding, its fix
  and its quotes with their reads, for an incident channel.
- **Evidence.** An open read has a readable title over its command: `kubectl get
  pods -n payments -o wide` is "Pods in payments", a previous container's log is
  "Log: payments-processor (previous)". A log excerpt says how many lines it
  shows of how many, with errors and warnings highlighted and masked values and
  collapsed repeats marked. A `kubectl get` read shows as a table; only failing
  statuses are coloured. Selecting text in the panel offers **Ask about this**,
  which puts the quote, its line and the read it came from in the composer, to
  finish and send; nothing is sent until you send it.
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
sign-in shares. In an issue, which the team shares, it belongs to whoever's
message opened that session. The harness keeps each user's memory on its volume
(`/data/memory/users/`) and seeds it into that user's new conversations, where
the agent reads it as a lead and checks it against fresh evidence.

The agent cannot edit memory during a run, and memory never holds raw logs,
credentials or personal data. Conversations are forgotten 90 days after their
last message (`SRE_MEMORY_MAX_AGE_DAYS`), beyond the newest 256, and when
deleted. See [architecture](../../docs/architecture.md#memory-across-conversations).

## Settings

The harness reads these from its environment (or the matching flags of
`python -m apps.sre.ui`). In the cluster, the `OPENAI_*` settings come from
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
| `SRE_USER_HEADER` | unset | The header in which an authenticating proxy passes the signed-in user, compared without regard to case; names starting with `@` are refused. Unset, everyone is the guest. See [signing users in](../../docs/deployment.md#signing-users-in) |
| `SRE_ADMIN_USERS` | unset | Signed-in users, comma-separated and compared without regard to case, who see and may delete every conversation and issue |
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
  web/                      The page (assistant-ui, React): health now, History and Memory, turns and
                            their findings cards, the side panel and the findings; built into static/app and served at /
  static/                   The views the page imports: sre.js (health board, log excerpts, kubectl
                            tables), the trace and file views, and the shared styles
evals/                      Tests against the worker's real gRPC service
verify.py                   In-cluster boundary probes and a scripted investigation
loadtest.py                 Many conversations and users at once
```
