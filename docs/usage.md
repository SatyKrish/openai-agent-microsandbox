# Using the sandbox provider

The provider is the `openai-agent-mxc` package in `sandbox/`, imported as
`agent_mxc`. It implements the OpenAI Agents SDK's `BaseSandboxClient` and
`BaseSandboxSession`, so any `SandboxAgent` can run its shell, filesystem and
skill tools on an MXC sandbox worker.

## Integrate into your application

```python
from pathlib import Path

from agents import Runner
from agents.run import RunConfig
from agents.sandbox import Manifest, SandboxAgent, SandboxRunConfig
from agents.sandbox.capabilities import Filesystem, Shell
from agents.sandbox.entries import Dir, File
from agent_mxc import MXCSandboxClient, MXCSandboxOptions

client = MXCSandboxClient(
    "sre-sandbox-payments-0.sre-sandbox-payments.sre-system.svc.cluster.local:50051",
    worker="sre-sandbox-payments-0",  # saved with each session: it resumes only on this worker
    token=Path("/var/run/secrets/mxc/token").read_text().strip(),
)

workspace = client.new_workspace_id()
manifest = Manifest(root=client.workspace_root(workspace), entries={
    "output": Dir(),
    "runbook.md": File(content=b"Check DATABASE_URL and REDIS_HOST if startup fails.\n"),
})
session = await client.create(manifest=manifest, options=MXCSandboxOptions(workspace_id=workspace))
agent = SandboxAgent(name="SRE", model="gpt-6.1-terra", instructions="Investigate; change nothing.",
                     default_manifest=manifest, capabilities=[Shell(), Filesystem()])
async with session:
    result = await Runner.run(agent, "Which pods in payments are unhealthy?",
                              run_config=RunConfig(sandbox=SandboxRunConfig(session=session)))
saved = client.serialize_session_state(session.state)  # store with the conversation
```

The manifest's root must be the session's workspace,
`client.workspace_root(workspace)`: a workspace has the same path inside its
containers as on the worker's volume (`/sandboxes/active/WORKSPACE`). Manifests
hold `File`, `Dir`, `LocalFile` and `LocalDir` entries; accounts, environment
variables and extra path grants are refused.

## Later turns and deletion

```python
session = await client.resume(client.deserialize_session_state(saved))
async with session:
    ...  # the workspace holds what earlier turns left

await client.delete(session)  # removes the workspace; the worker keeps its journal
await client.aclose()         # closes the gRPC channel
```

No process runs between commands, so there is nothing to suspend between
turns. Keep a session open across a conversation's turns, as the SDK expects,
and close it when the conversation goes idle: closing (`aclose()`) runs the
SDK's pre-stop hooks, such as the `Memory` capability's memory generation, which
makes model calls. `client.delete` removes the workspace and shuts the session
down without closing it, as the SDK separates the two, so a conversation
deleted without closing is not remembered; call `aclose()` first to keep its
memory. Run one turn of a conversation at a time; the worker runs one
session's commands in order, but two harnesses resuming the same workspace
would interleave their turns. Different conversations run concurrently.

## Memory

The SDK's `Memory` capability works on this provider unchanged: its files live
in the workspace under `memories/`. Each workspace has its own, so to carry
memory between conversations, copy it in and out around each session, as the
shared harness does for each user
([`memory.py`](../harness/src/openai_harness/memory.py)):

```python
store = UserMemory(Path("/data/memory")).for_user("ana@example.com")  # None: the guest
await session.start()
await store.seed(session)     # earlier conversations' memory into memories/
...                           # the conversation's turns
await store.seed(session)     # again, to consolidate on top of what others published
await session.aclose()        # the SDK generates and consolidates memory here
await store.publish(session)  # the consolidated memories/ back to the store
```

Serialize the close-and-publish step across one user's conversations, or two
consolidations can overwrite each other's lessons. The store also forgets:
`store.prune()` drops conversations past `max_age` (90 days by default) and
beyond the newest `max_conversations` (the SDK's 256), and `store.forget(id)`
drops one, such as a deleted conversation. See
[architecture](architecture.md#memory-across-conversations) for how the SRE
agent constrains what memory may hold.

## Errors

| Situation | What the SDK sees |
| --- | --- |
| A command exits nonzero | An `ExecResult` with its exit code |
| A command exceeds its timeout (60 s by default, `exec_timeout`) | `ExecTimeoutError` |
| The worker is unreachable, refuses the token or cannot launch a container | `ExecTransportError` for commands; `WorkerError` with the gRPC status elsewhere |
| A file is missing | `FileNotFoundError`, which is also the SDK's `WorkspaceReadNotFoundError` |
| A file is over the limit (10 MiB by default) | `ValueError` |
| A path leaves the workspace | `ValueError` (the SDK's own checks usually refuse it first) |

Commands are never retried: one that failed in transit may already have run.

## Logs

Containers cannot read pod logs. Read them through the worker's log policy
(see [architecture](architecture.md#logs-reach-the-model-only-as-excerpts)):

```python
reply = await session._inner.read_logs("payments", "deploy/payments-api", previous=False,
                                       tail_lines=500, match="ledger timeout")
reply["excerpt"]        # the only log text that leaves the worker
reply["evidence_path"]  # the excerpt's copy in the workspace, also recorded as evidence
```

`read_logs` raises `WorkerError` with `INVALID_ARGUMENT` for a namespace outside
the worker's `SRE_NAMESPACES` or a malformed name, and `NOT_FOUND` for a pod
that does not exist or a log the kubelet no longer has (a previous container's,
after it was removed). Give agents a function tool around it, as the SRE agent's
`pod_logs` does (`examples/sre/agent/tools/logs.py`).

## Evidence

The worker records plain kubectl reads and log excerpts as evidence (see
[architecture](architecture.md#evidence-and-checks)). The session lists and
reads them; the SDK's session wrapper does not forward provider methods, so
call them on `session._inner`:

```python
entries = await session._inner.evidence(after_seq=0)  # seq, path, command, sha256, bytes, recorded_at
content = await session._inner.read_evidence(entries[0]["seq"])
```

The shared harness does this after every turn and keeps host copies for the
agent's check.

## Health summary

`await client.health()` returns the worker's summary of the workloads in its
namespaces: each deployment and stateful set, and any pod outside them, with its readiness,
restarts, a state (`failing`, `degraded` or `healthy`) and the reasons (waiting
reasons, the last exit, unschedulable pods, recent warning events, redacted).
The worker reads it with its own identity and caches it for 5 s. It is for
people: the SRE UI's start screen shows it, and it is never sent to the model.

## The worker's contract

[`proto/mxc/sandbox/v1/sandbox.proto`](../proto/mxc/sandbox/v1/sandbox.proto)
defines `Info`, `InitSession`, `Exec`, `WriteFile`, `ReadFile`, `ListEvidence`,
`ReadEvidence`, `ReadLogs`, `Health` and `DestroySession`. The worker takes these settings from its
environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATA_DIR` | `/sandboxes` | Workspaces in `active/`, the journal and evidence in `history/` |
| `MXC_EGRESS` | `kube-api` | `kube-api`: containers reach only the worker's read-only Kubernetes API proxy (MXC proxy-only egress); `none`: no network |
| `MXC_KUBE_PROXY_PORT` | `18080` | The API proxy's port on the worker's loopback; containers reach it as `10.0.2.2` |
| `MXC_KUBE_TOKEN_FILE`, `MXC_KUBE_CA_FILE` | the pod's service-account token and CA | What the proxy authenticates with and verifies the API server against |
| `MXC_TIMEOUT_MS` | `60000` | The longest a command may run |
| `MXC_MAX_CONCURRENT` | `8` | Commands running at once across sessions |
| `MXC_MAX_FILE_BYTES`, `MXC_MAX_OUTPUT_BYTES`, `MXC_MAX_EVIDENCE_BYTES` | 10 MiB, 1 MiB, 4 MiB | Size limits |
| `MXC_LIMIT_AS_BYTES` | 2 GiB | Address space per command (`prlimit`) |
| `MXC_WORKER_TOKEN_FILE` | unset | The pair token every call must carry |
| `SRE_NAMESPACES` | none | The namespaces `ReadLogs` serves |
| `MXC_LOG_TAIL_LINES`, `MXC_LOG_MAX_TAIL_LINES`, `MXC_LOG_MAX_BYTES` | 500, 5000, 4 MiB | How much raw log the worker reads per call, by default and at most |
| `MXC_LOG_EXCERPT_LINES`, `MXC_LOG_EXCERPT_BYTES` | 40, 6000 | The most an excerpt may hold |
| `MXC_LOG_CONTEXT_LINES`, `MXC_LOG_LAST_LINES` | 2, 3 | Context kept around each error, and last lines always kept |
| `MXC_READONLY_PATHS` | none | Extra read-only mounts for every container, beyond MXC's baseline and the kubeconfig directory |
