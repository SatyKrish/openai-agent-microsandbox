# Local Kubernetes setup and verification

The local setup runs one harness/worker pair and a broken payments application
on Kind. On macOS the cluster gets its own Colima VM, so it never shares a
Docker daemon or kernel settings with your other clusters.

## Requirements

- macOS with [Colima](https://github.com/abiosoft/colima), or Linux with Docker
- [kind](https://kind.sigs.k8s.io/), kubectl, GNU Make
- Node 24 or later and [uv](https://docs.astral.sh/uv/), for the tests
- An OpenAI API key, for the UI (`make verify` and `make loadtest` need none)

## Set up

```bash
cp .env.example .env    # set OPENAI_API_KEY and OPENAI_MODEL
```

```bash
make all
```

`make all` runs these targets, which also work one at a time:

| Target | What it does |
| --- | --- |
| `cluster` | Starts the `openai-agent-mxc` Colima VM (4 CPUs, 8 GiB) if needed, clears `kernel.apparmor_restrict_unprivileged_userns` on it, and creates the Kind cluster. Your current kubectl context is restored afterwards. |
| `images` | Builds `mxc-sandbox-worker:local` and `sre-agent-harness:local` |
| `load` | Loads both images into Kind |
| `secrets` | Creates `openai-creds` from the `OPENAI_*` lines of `ENV_FILE` (default `.env`) and a random pair token, `sre-payments-pair-token` |
| `deploy` | Applies `deploy/kubernetes/overlays/kind` and waits for both pods |
| `demo` | Applies the broken payments workloads |

Every kubectl call names `KUBE_CONTEXT` (`kind-openai-agent-mxc`). On Linux
without Colima, pass `COLIMA_PROFILE=` and make sure unprivileged user
namespaces are allowed (on Ubuntu 24.04 and later,
`kernel.apparmor_restrict_unprivileged_userns=0`).

### Why the VM setting and the privileged worker

Bubblewrap, MXC's Linux backend, creates unprivileged user namespaces. Ubuntu
24.04 confines those with AppArmor; MXC's own error message names the sysctl
and suggests clearing it on an ephemeral host, which this VM is.

Kind runs pods in containers inside a container. There, `/proc` is masked, which
stops Bubblewrap from mounting each container's own procfs, and `/dev/net/tun`
is hidden, which stops slirp4netns from giving a container its proxy-only
network. User-namespaced pods (`hostUsers: false`), which would allow an
unmasked `/proc`, fail to start in Kind. The Kind overlay therefore runs the
worker container privileged, as the non-root uid 10001. Commands inside MXC
containers still have no capabilities and their own namespaces; `make verify`
checks that.

## Use it

```bash
make ui         # http://localhost:8001
```

The UI binds 127.0.0.1 in the harness pod and has no Service; `make ui` runs
`kubectl port-forward`. When the harness pod is replaced the port-forward ends:
run `make ui` again. If it reports that port 8001 is in use, an earlier
port-forward still holds it; stop that one first, or pass `UI_PORT=8002`.

## Test

| Command | What it checks | Model usage |
| --- | --- | --- |
| `make test` | Worker unit tests and the Python tests, against the worker's real gRPC service with commands on the test host | None |
| `make verify` | Eighteen boundary probes in real MXC containers, a check that a busy service's log reaches the harness only as a masked excerpt, then a scripted investigation through the harness | None |
| `make loadtest` | One user with six conversations, twelve users at once, three users on one shared conversation, and workspace cleanup | None |
| `uv run python -m apps.sre.loadtest --live http://localhost:8001` | Three users asking the deployed UI different questions at once (with `make ui` running) | Three investigations |
| `make isolation` | Three sessions at once: one cannot reach another's workspace, evidence, logs or the journal through containers, file calls or the findings check; journals hold only their own commands; pod logs hold no output | None |
| `make journal` | Prints the worker's audit journal of every command | None |
| `make status`, `make logs` | Pods, volumes and policies; both pods' logs | None |

## Stop, restart and tear down

`colima stop --profile openai-agent-mxc` stops the VM with the cluster in it;
`colima start --profile openai-agent-mxc` brings it back, after which run
`make cluster` once more to clear the AppArmor setting, which does not survive
a VM restart. Workspaces, the journal and conversations are on the pods'
volumes and survive.

`make clean` removes the pair and the demo and keeps the cluster.
`make teardown` deletes the Kind cluster and stops the VM.

## Troubleshooting

- **The worker pod restarts with "MXC self-test failed".** The worker runs one
  MXC container at startup and exits if it cannot. Check `make cluster` ran on
  this VM boot (the AppArmor setting) and that the Kind overlay is applied.
- **A turn fails with "The sandbox worker … is unavailable".** The harness
  cannot reach the worker: check `make status`, and that the pair token Secret
  exists in `sre-system`.
- **`kind load` fails on a multi-platform image.** `make load` loads only the
  two images it builds; the demo pulls `busybox` itself.
