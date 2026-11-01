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

Closing a session closes it on the client side only: no process runs between
commands, so there is nothing to suspend. Run one turn of a conversation at a
time; the worker runs one session's commands in order, but two harnesses
resuming the same workspace would interleave their turns. Different
conversations run concurrently.

## Errors

| Situation | What the SDK sees |
| --- | --- |
| A command exits nonzero | An `ExecResult` with its exit code |
| A command exceeds its timeout (60 s by default, `exec_timeout`) | `ExecTimeoutError` |
| The worker is unreachable, refuses the token or cannot launch a container | `ExecTransportError` for commands; `WorkerError` with the gRPC status elsewhere |
| A file is missing | `FileNotFoundError` |
| A file is over the limit (10 MiB by default) | `ValueError` |
| A path leaves the workspace | `ValueError` (the SDK's own checks usually refuse it first) |

Commands are never retried: one that failed in transit may already have run.

## Evidence

The worker records plain kubectl reads as evidence (see
[architecture](architecture.md#evidence-and-checks)). The session lists and
reads them; the SDK's session wrapper does not forward provider methods, so
call them on `session._inner`:

```python
entries = await session._inner.evidence(after_seq=0)  # seq, path, command, sha256, bytes, recorded_at
content = await session._inner.read_evidence(entries[0]["seq"])
```

The shared harness does this after every turn and keeps host copies for the
agent's check.

## The worker's contract

[`proto/mxc/sandbox/v1/sandbox.proto`](../proto/mxc/sandbox/v1/sandbox.proto)
defines `Info`, `InitSession`, `Exec`, `WriteFile`, `ReadFile`, `ListEvidence`,
`ReadEvidence` and `DestroySession`. The worker takes these settings from its
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
| `MXC_READONLY_PATHS` | none | Extra read-only mounts for every container, beyond MXC's baseline and the kubeconfig directory |
