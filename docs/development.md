# Development

## Layout and boundaries

| Part | Package | Depends on |
| --- | --- | --- |
| `proto/` | The gRPC contract | Nothing |
| `worker/` | `mxc-sandbox-worker` (Node 24, TypeScript) | `@microsoft/mxc-sdk`, `@grpc/grpc-js` |
| `sandbox/` | `openai-agent-mxc`, imported as `agent_mxc` | `openai-agents==0.24.0`, `grpcio`; never the harness or ChatKit |
| `harness/` | `openai-harness`, imported as `openai_harness` | The provider; ChatKit only in its adapter, store view and uploads |
| `examples/sre/` | The SRE agent, its UI settings and its in-cluster checks | The harness |

The repository is a uv workspace (`sandbox`, `harness`); the worker is a
separate npm project. The agents stay in `examples/`: a top-level `agents/`
package would shadow the Agents SDK, whose import name is `agents`.

## Tests

```bash
make test
```

This builds the worker, runs its unit tests with `node --test`, then runs the
Python tests with pytest:

- **Worker** (`worker/test/`): which commands count as evidence, evidence file
  names, redaction, container requests, workspace path guards against planted
  symlinks, and the gRPC service with its token, using a stand-in runner.
- **Python** (`sandbox/tests`, `harness/tests`, `examples/sre/evals`): the
  provider, the harness and its UI routes, the trace summary, and the SRE agent
  end to end with a scripted model.

The Python tests start the worker's real gRPC service from
`worker/dist/test/host-worker.js` with a host runner in place of MXC, and a
fake `kubectl` on its `PATH` (see the root `conftest.py`). They exercise the
actual protocol, path guards, redaction, journal and evidence rules. Commands
run on the test host **without isolation**; the host runner is built into
`dist/test` only and is not in the worker image. MXC itself is exercised in the
cluster by `make verify`, `make loadtest` and `make isolation`.

## The gRPC contract

After changing `proto/mxc/sandbox/v1/sandbox.proto`, regenerate the Python stubs
and commit them:

```bash
make proto
```

The worker loads the proto at run time with `@grpc/proto-loader`; it needs no
generated code.

## Images

```bash
make images load
```

The worker image installs `@microsoft/mxc-sdk` from `package-lock.json` (its
`node-pty` dependency is built from source, so the build stage has a
compiler), bubblewrap, slirp4netns, iptables and util-linux from Debian, and a
checksum-verified kubectl into `/usr/bin`, where MXC's read-only baseline makes
it visible to containers. The harness image installs the uv workspace from
`uv.lock` and runs as uid 10001 with a read-only root filesystem.

## Adding an agent

An agent is a plain `SandboxAgent` plus an `AgentSpec` for the harness: its
starting manifest, extra instructions, optional harness tools, its host check
and which folders to collect. `examples/sre/` is the worked example; its
`ui/__main__.py` shows the launcher, and `verify.py` the in-cluster check.
