# Architecture

This project follows the **harness separate from compute** pattern in the [OpenAI Sandbox Agents guide](https://developers.openai.com/api/docs/guides/agents/sandboxes). The Agents SDK harness runs in a trusted pod. A paired sandbox worker pod provides compute: it runs every command as a workload in its own Microsoft eXecution Container (MXC) over the conversation's workspace. `MXCSandboxClient` adapts the worker to the SDK sandbox interface. MXC terms below (container, backend, workload, policy, create-and-run) follow the [MXC glossary](https://github.com/microsoft/mxc/blob/main/docs/glossary.md).

![Harness separate from compute: the agent harness accesses trusted services while sandbox compute executes commands against a filesystem.](assets/harness-separate-from-compute.png)

*Diagram from the [official OpenAI documentation](https://developers.openai.com/api/docs/guides/agents/sandboxes).*

The following diagram shows one application domain's pair on Kubernetes:

```mermaid
flowchart LR
    Browser -->|kubectl port-forward| UI
    subgraph Harness["sre-harness-payments-0: no Kubernetes token"]
        UI["Shared SRE UI (ChatKit)"] --> Loop["Agents SDK Runner + SandboxAgent"]
        Loop --> Client["MXCSandboxClient"]
        Check["Host check of findings"]
    end
    Loop -->|"OPENAI_API_KEY"| API["OpenAI API"]
    Client -->|"gRPC :50051, pair token"| Worker
    subgraph Sandbox["sre-sandbox-payments-0: payments-sre-sa, Kata in production"]
        Worker["Worker (Node, @microsoft/mxc-sdk)"]
        Worker --> Container["MXC container per command, no credentials"]
        Worker --> Journal["/sandboxes/history: journal and evidence"]
        Container --> Workspace["/sandboxes/active/SESSION"]
        Container -->|"kubectl, proxy-only egress (10.0.2.2)"| Proxy["Read-only API proxy: holds the token"]
    end
    Proxy -->|"GET with the worker's token"| K8s["Kubernetes API: read-only Role in payments"]
    Check -.->|"ListEvidence / ReadEvidence"| Journal
```

## Who holds what

| | Harness pod | Sandbox worker pod | Each MXC container |
| --- | --- | --- | --- |
| Model API key | Yes, from the `openai-creds` Secret | No | No |
| Kubernetes identity | None; its token is not mounted | `payments-sre-sa`: get, list and watch on pods, logs, events, services and workloads in `payments`; no Secrets, ConfigMaps, exec or writes. Only its API proxy uses the token | None. kubectl's kubeconfig names the proxy and carries no credentials |
| Network | DNS, its worker, HTTPS | The API server's ports only (NetworkPolicy) | The worker's API proxy only (MXC proxy-only egress); no DNS, no internet, no direct route to the API |
| Filesystem | Its volume: conversations and host copies | Its volume: every workspace and the journal | Its own workspace, read-write; system directories read-only; no journal, no other workspaces |
| Reached by | `kubectl port-forward`; the UI binds 127.0.0.1 | Its harness only: NetworkPolicy and the pair token | Nothing |

## How a command runs

1. The SDK calls `exec` on the session. `MXCSandboxClient` sends `Exec` to the
   paired worker ([`proto/mxc/sandbox/v1/sandbox.proto`](../proto/mxc/sandbox/v1/sandbox.proto)).
2. The worker runs it as a workload in a transient container: MXC's
   create-and-run operation (`run()` in `@microsoft/mxc-sdk/v1`, captured
   output) with the Bubblewrap backend. Bubblewrap has no persistent container
   lifecycle, so a conversation's state lives in its workspace, not in a
   container. Per MXC's backend documentation, each container gets new user,
   PID, IPC and UTS namespaces; the deny-by-default read-only baseline (`/bin`,
   `/sbin`, `/lib*`, `/usr/bin`, `/usr/sbin`, `/usr/lib*`, `/usr/libexec`,
   `/usr/share`, `/etc`; not `/usr/local`, `/opt`, `/var` or `$HOME`); minimal
   `/dev`, `/proc` and `/tmp`; a cleared environment; a seccomp filter that admits
   only Unix, IPv4, IPv6 and netlink sockets; and the workload runs under
   `sh -c`. The worker's policy adds the session's workspace as the only
   read-write path (at the same path inside), the kubeconfig directory read-only,
   `HOME=/tmp` (MXC sets `HOME` to the working directory otherwise, where
   dotfiles would act as user configuration), and the network policy below.
   Inside, `prlimit` caps address space, CPU time and open files, and `choom`
   makes the workload the kernel's first OOM victim rather than the worker.
3. **Network.** The policy is MXC's proxy-only posture: `egress.default: deny`
   with no rules, ingress and host loopback denied, and
   `runtimeConfig.networkProxy` naming the worker's API proxy on
   `127.0.0.1`. MXC gives the container a private network namespace through
   slirp4netns, admits only the proxy endpoint (seen inside as `10.0.2.2`),
   opens no DNS, and sets `HTTP_PROXY` and `HTTPS_PROXY` for cooperating
   clients. In MXC's terms the worker's proxy is the external proxy that does
   the destination filtering: it serves only the Kubernetes API, adds the
   worker's token, and forwards only reads (below). The worker checks
   `getPlatformSupport().bubblewrapNetwork.proxyEnforcement` at startup and,
   like MXC, never falls back to a weaker network: an unsupported host fails
   the worker's self-test.
4. The worker redacts the output (JWTs, cloud and API keys, bearer tokens, URL
   credentials, `password=`-style pairs, private keys), caps it, records it in
   the session's audit journal with any warnings MXC returned, and returns it.
   MXC's structured errors map to gRPC statuses: `backend_unavailable` and
   `backend_error` to `UNAVAILABLE`, the rest to `FAILED_PRECONDITION`.
5. A plain kubectl read is also **evidence** (below).

## The read-only API proxy

Containers hold no Kubernetes credentials. The worker runs a small HTTP proxy
on its own loopback (`MXC_KUBE_PROXY_PORT`, 18080) and writes a kubeconfig whose
server is that proxy, as `http://10.0.2.2:18080`, with no user credentials. For
each request the proxy:

- forwards only `GET` and `HEAD` of Kubernetes API paths (`/api`, `/apis`,
  `/version`, `/openapi`), so get, list, watch, describe, logs and events work;
- refuses writes of any verb, upgrades, `CONNECT`, the `exec`, `attach`,
  `portforward` and `proxy` subresources, other paths, and requests addressed
  to any other host, with a Kubernetes `Status` that kubectl prints as
  `Forbidden`;
- drops any `Authorization`, cookie or `Impersonate-*` header the container
  sent, adds the worker's token, read from the kubelet-rotated file on every
  request, and forwards over TLS, verifying the API server against the cluster
  CA.

RBAC still decides what the token can read. The proxy keeps writes out even if
the Role is widened later, and a workload can no longer print the token in any
form, because no file, variable or header in the container holds it.

Files move over `WriteFile` and `ReadFile`, outside any container. A path must
stay inside the session's workspace lexically and again after the worker
resolves symlinks the agent may have planted; writes refuse symlinked
components and land by rename. The SDK's own path checks run first.

Commands and file operations of one session run one at a time, in arrival
order, so a checked path cannot change underneath a file operation. Different
sessions run concurrently up to `MXC_MAX_CONCURRENT` commands (8 by default);
further commands wait for a slot.

## Workspaces and conversations

A workspace is a directory on the worker's volume, `/sandboxes/active/SESSION`,
and has the same path inside its containers. Nothing runs between commands, so
there is nothing to suspend between turns.

| Moment | What happens |
| --- | --- |
| First message | The harness names a workspace, builds the agent's manifest under it, and the worker creates it; the SDK writes the manifest's files (the SRE agent's runbooks) |
| During the turn | The agent loop runs in the harness; every tool call runs in its own MXC container |
| End of the turn | The harness fetches new evidence from the worker, copies the agent's `output/` and `work/` files, runs the agent's check, and saves the session state with the thread |
| Next message | The harness reopens the same workspace; its files are as the last turn left them |
| Conversation deleted | The worker removes the workspace and records the deletion; its journal stays |

The harness keeps threads in SQLite and conversation history in an SDK
`SQLiteSession`, both on its own volume, so conversations survive a harness
restart. The worker's volume keeps workspaces and the journal across worker
restarts; a workspace that is gone when a conversation reopens is recreated
from the manifest.

## Evidence and checks

A command counts as evidence only when it is a plain kubectl read: `get`,
`describe`, `logs`, `events`, `top`, `explain`, `api-resources`,
`api-versions` or `version`, with no pipes, redirections, quotes, globs or `$`,
and no flag that points kubectl elsewhere (`--kubeconfig`, `--server`,
`--token`, `--as`, `--context`, `--raw`, `-f` and others). Its output then
comes from the API server as the worker's own read-only identity.

The worker keeps the redacted output under `/sandboxes/history/SESSION`, which no
container can see, and saves a copy in the workspace as
`evidence/NNN-kubectl-....txt` for the agent to analyze. The output comes from
the API server through the worker's own proxy, as the worker's identity. After each turn the
harness fetches new entries with `ListEvidence` and `ReadEvidence`, checks each
against its SHA-256, and keeps a host copy. The SRE agent's check then requires
every quote in `output/findings.json` to appear in the copy of the file it
cites, so editing `evidence/` inside the sandbox cannot make a quote pass.

## Differences from the reference design

The design started from a reference architecture with a TypeScript harness and
hand-built `bwrap` arguments. This implementation differs where the real
components required it:

- **Python harness.** The harness uses the Python Agents SDK (`openai-agents`
  0.24.0) and its `SandboxAgent`, `BaseSandboxClient` and `BaseSandboxSession`,
  so the existing ChatKit SRE UI and harness run on it. The worker is
  TypeScript because MXC's Node SDK is how MXC is embedded.
- **MXC rather than hand-built Bubblewrap.** Mounts, environment, the seccomp
  filter and the slirp4netns proxy-only network come from MXC. MXC's Node SDK offers
  persistent containers only for its Windows backends, so on Linux each command
  is its own container over a persistent workspace directory.
- **Evidence as well as a journal.** The worker classifies kubectl reads and the
  harness checks findings against the worker's copies.
- **Authenticated gRPC.** The pair shares a token from a Secret, on top of
  NetworkPolicy. Mutual TLS would be the production step.

## Limits

- **Kind needs a privileged worker.** Kind's nested containers mask `/proc` and
  hide `/dev/net/tun`, and user-namespaced pods do not start there, so the Kind
  overlay runs the worker container privileged, as uid 10001. Commands in MXC
  containers still have no capabilities. In production the pod's outer
  boundary is a Kata microVM; see [deployment](deployment.md).
- **Redaction is pattern-based.** The worker's identity cannot read Secrets, but
  pod specs' literal environment values and application logs can still hold
  credentials it does not recognize.
- **Evidence proves quotes, not diagnoses.** A log line is evidence of what the
  application printed.
- **What kubectl can read still reaches the model.** The token stays in the
  worker, but anything the Role lets the agent read (pod specs, logs, events)
  can reach the model's context. Keep that Role narrow.
- **MXC's network limits apply.** A slirp4netns that dies mid-run fails the run,
  but one that hangs reaches the workload as an unreachable network; IPv6 has no
  route. MXC's Node SDK caches `getPlatformSupport()` for the process's life,
  so a host change needs a worker restart to be seen.
- **One harness per domain, no sign-in.** Access is Kubernetes RBAC on
  port-forward, and conversations live in SQLite. Several users can share the
  harness: their conversations run concurrently, and messages to one shared
  conversation run one after another.
- **Per-command cost.** An MXC container with the proxy-only network takes
  about 110 ms; a new workspace's manifest takes about fifteen of them.
