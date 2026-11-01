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
| Worker unit tests | 7 passed: evidence rules, evidence names, redaction, container requests, workspace path guards against planted symlinks, and the gRPC service with its pair token |
| Python tests, against the worker's real gRPC service on the test host | 19 passed: the provider (files, resume, evidence, timeouts, wrong token, a `SandboxAgent` run), the harness and its UI routes, the trace summary, and the SRE agent end to end |
| MXC in a Kind pod | Bubblewrap launched in a privileged non-root pod after clearing the VM's AppArmor userns restriction; a plain pod could not mount `/proc`, and a user-namespaced pod did not start |
| Boundary probes (`make verify`), each in its own MXC container | 16 of 16 passed: bounding, effective and permitted capability sets all zero (as MXC's own proxy-mode tests require), own PID namespace, journal and other workspaces not mounted, system files read-only, no API key, no route to 1.1.1.1, no Kubernetes token or `KUBERNETES_*` variable, no direct route to the API, the API reachable through the worker's proxy, pods readable in `payments`, Secrets and `kube-system` forbidden, a server-side dry-run delete refused by the proxy as read-only, `kubectl exec` refused, credentials redacted. The harness pod had no Kubernetes token |
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
| Cost of isolation | About 11 ms per MXC container without network; about 110 ms per command with the proxy-only network |

## Unverified

- AKS, Kata or any other runtime than Kind's runc; the AKS overlay has not been
  applied.
- Multi-node clusters, and load beyond a few dozen conversations.
- Production isolation properties beyond the probes above, including
  resistance to kernel exploits from inside an MXC container, which is what the
  Kata layer is for.
