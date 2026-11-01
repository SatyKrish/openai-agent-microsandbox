# Verification record

Date: 2026-11-01.

## Versions and environment

- Host: macOS ARM64.
- Local VM: dedicated Colima profile `openai-agent-mxc`, 4 CPUs and 8 GiB RAM,
  Ubuntu 24.04.4, kernel 6.8.0-117, with
  `kernel.apparmor_restrict_unprivileged_userns=0`.
- Kubernetes: Kind 0.31.0, one node, v1.35.0, Linux ARM64, kindnet.
- Sandbox worker: `node:24-trixie-slim`, `@microsoft/mxc-sdk` 1.0.1 with the
  Bubblewrap backend, kubectl v1.35.0; Kind overlay (privileged container,
  uid 10001).
- Harness: `python:3.13-slim-trixie`, `openai-agents==0.24.0`,
  `openai-chatkit==1.6.5`.
- Live model: `gpt-6.1-terra`.

## Results

| Check | Result |
| --- | --- |
| Worker unit tests | 21 passed: evidence rules, evidence names, redaction, container requests, workspace path guards against planted symlinks, the gRPC service with its pair token, the read-only API proxy, the log policy and `ReadLogs`, a log the kubelet no longer has, and the health summary |
| Python tests, against the worker's real gRPC service on the test host | 35 passed: the provider (files, resume, evidence, timeouts, wrong token, a `SandboxAgent` run, the SDK's not-found error that `Memory` expects), the harness and its UI routes (health, memory), sessions closed when idle and on shutdown with their memory published, memory carried across conversations, each signed-in user's memory apart from others' and the guest's, the user taken only from the configured header, conversations forgotten after 90 days, beyond the newest and when deleted (also after their memory was published), memory over its limits not published, the move of earlier shared memory to the guest's, the step limit, parallel tool calls each keeping their own exit status, the trace summary, and the SRE agent end to end with compaction and the SDK's memory defaults |
| MXC in a Kind pod | Bubblewrap launched in a privileged non-root pod after clearing the VM's AppArmor userns restriction; a plain pod could not mount `/proc`, and a user-namespaced pod did not start |
| Boundary probes (`make verify`), each in its own MXC container | 18 of 18 passed, including raw `kubectl logs` refused: bounding, effective and permitted capability sets all zero (as MXC's own proxy-mode tests require), own PID namespace, journal and other workspaces not mounted, system files read-only, python3, jq and ripgrep available, no API key, no route to 1.1.1.1, no Kubernetes token or `KUBERNETES_*` variable, no direct route to the API, the API reachable through the worker's proxy, pods readable in `payments`, Secrets and `kube-system` forbidden, a server-side dry-run delete refused by the proxy as read-only, `kubectl exec` refused, credentials redacted. The harness pod had no Kubernetes token |
| Logs to the model (`make verify` and live) | Passed: `kubectl logs` was refused in the sandbox; a busy service's 965-line log reached the harness as a 2-line, 614-byte excerpt with 42 values masked. In a live investigation of that service with `gpt-6.1-terra` (60 s, 27 tool calls, 4 `pod_logs` reads, 9 quotes matched), the model's whole conversation history held no email address and no card number; each 500-line read reached it as 2 lines with 498 withheld. An earlier run found a test card number reaching the model through `kubectl describe` of the pod's startup script, which led to masking emails and card numbers in all command output |
| Log policy, worker tests | Passed: errors kept with context and repeats collapsed with counts, the last lines kept, asked-for lines always shown, credentials, emails, card numbers and long identifiers masked, size capped; `ReadLogs` refuses namespaces outside its scope and malformed names, records only the excerpt as evidence and journals only the raw log's size and hash |
| Token leak check | Passed after the proxy change: no token file, variable or header in a container, and none of the readable filesystem matched a JWT. Before it, the mounted token could be printed past redaction (base64, reversed or a partial `head -c`) |
| Read-only API proxy, worker tests | Passed: reads carry the worker's token, which is re-read after rotation; a container's `Authorization` and `Impersonate-*` headers are dropped; POST, PUT, PATCH, DELETE, `CONNECT`, upgrades, `exec`, `attach`, `portforward` and `proxy`, non-API paths and other hosts are refused before reaching the API |
| Scripted investigation (`make verify`) | Passed: 2 kubectl reads recorded as evidence and the findings' quotes matched the worker's copies |
| NetworkPolicy | Passed: a pod in `payments` could not open the worker's gRPC port |
| Live investigation through the UI | Passed: 57 s, 19 tool calls all in MXC containers, 9 kubectl reads recorded, 2 findings (`payments-processor`, `payments-ledger`) whose 10 quotes all matched |
| Follow-up turn | Passed: reopened the same workspace, proposed fixes in 8 s and ran nothing |
| Request to change the cluster and read a Secret | The agent declined both, ran only reads, and its 7 quotes matched |
| Conversation deletion | Passed: the thread was removed and the worker removed the workspace, keeping its journal |
| Harness restart | Passed: conversations, their files and checks survived; the workspace was reopened |
| One user, 6 conversations at once (`make loadtest`) | Passed in 5.0 s; each conversation had its own workspace and saw only it |
| 12 users at once, beyond the worker's 8 command slots | Passed in 8.8 s, every turn under 8.7 s, every check passed |
| 3 users sending to one shared conversation at once | Passed: 3 turns ran one after another, in order, with no errors |
| Workspace cleanup after the load test | Passed: deleting 19 conversations removed 19 workspaces |
| Cross-session isolation (`make isolation`), three workspaces open at once | 37 of 37 passed, twice: A's containers could not list, read, write or delete B's or C's workspace, evidence or notes log, or the worker's journal, by absolute path, `../`, glob or planted symlink, nor see their processes; 28 of 28 file reads and writes aimed there were refused and B's and C's files and evidence were unchanged; evidence listing and numbering were per session; the findings check failed when A cited B's evidence file or text, even after A tampered with its own copy; each journal held only its own session's commands; neither pod's logs held command output |
| 3 users on the live model at once | Passed in 55 s, about one investigation's time; checks passed with 7, 9 and 9 quotes |
| Memory across conversations, live with `gpt-6.1-terra` | Passed: conversation A (48 s, 21 tool calls, 8 quotes matched) closed after its idle time and the SDK's memory generation took 55 s; the harness published 6 files. Conversation B started with them ("Seeded with the agent's memory … (6 files)"), read `MEMORY.md` and A's summary with its second command, re-read the cluster, and answered that the crash matched the earlier cause; its quotes matched this turn's evidence. The stored memory held no email address, card number, token or credential value |
| Harness restart with a conversation open | Passed: deleting the harness pod closed the open conversation during termination and published its memory (49 s; the pod was gone 50 s after the delete). Before this change, a redeploy that replaced the harness during a consolidation lost that conversation's memory |
| Memory with GPT-6 models, live | Passed, each conversation closed when the harness stopped. With `gpt-6-luna` extracting and `gpt-6.1-sol` consolidating, conversation D (40 s, 22 tool calls, quotes matched) took 86 s. With `gpt-6.1-terra` consolidating, the default, conversation E (43 s, 21 tool calls, quotes matched) took 64 s. No errors; the guest's memory then held 4 conversations and no email address, card number, token or credential value |
| How the agent uses memory, live | Before the fixes, every conversation with memory searched `MEMORY.md` before its first cluster read, and each lost a step when `rg` was missing (exit 127, recorded as exit 0 because parallel calls' statuses were swapped). With ripgrep in the worker and the agent's memory rules, conversation F ("Is it the same problem as before?", 51 s, 20 tool calls, 6 quotes matched) searched memory once, confirmed the earlier cause from fresh reads (the deployed command, 103 restarts) and recorded correct statuses |
| Preferences in memory, live | Passed: the guest's memory had kept two one-off requests ("answer briefly", "no findings files") as user preferences, quoted verbatim. The first consolidation under the stricter rule dropped both; memory then held 5 conversations, no standing preferences and no personal data |
| Per-user memory in the cluster | Passed: on upgrade the earlier shared memory moved to the guest's. With `SRE_USER_HEADER=X-Forwarded-Email`, a request naming `ana@example.com` got Ana's own, empty memory, and one without the header got the guest's 3 conversations |
| Previous container's log already removed | The kubelet answered `--previous` with a one-line "unable to retrieve container logs" body, which the worker had recorded as a log excerpt; it is now a `NOT_FOUND` error and is not recorded as evidence |
| Cost of isolation | About 11 ms per MXC container without network; about 110 ms per command with the proxy-only network |

## Unverified

- AKS, Kata or any other runtime than Kind's runc; the AKS overlay has not been
  applied.
- Multi-node clusters, and load beyond a few dozen conversations.
- Production isolation properties beyond the probes above, including
  resistance to kernel exploits from inside an MXC container, which is what the
  Kata layer is for.
