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
| `cluster` | Starts the `openai-agent-mxc` Colima VM (4 CPUs, 8 GiB, nested virtualization) if needed, checks that it has `/dev/kvm`, and creates the Kind cluster. Your current kubectl context is restored afterwards. |
| `images` | Builds `sre-sandbox-guest:local` (what the VMs boot) and saves it to `build/guest-image.tar`, then `sandbox-worker:local`, which carries it, and `sre-agent-harness:local` |
| `load` | Loads the worker and harness images into Kind |
| `secrets` | Creates `openai-creds` from the `OPENAI_*` lines of `ENV_FILE` (default `.env`) and a random pair token, `sre-payments-pair-token` |
| `deploy` | Applies `deploy/kubernetes/overlays/kind` and waits for both pods |
| `demo` | Applies the broken payments workloads |

Every kubectl call names `KUBE_CONTEXT` (`kind-openai-agent-mxc`). On Linux
without Colima, pass `COLIMA_PROFILE=` and make sure the host has `/dev/kvm`.

### Why nested virtualization and the privileged worker

Each conversation runs in a microVM on the worker, which needs KVM. On macOS,
the Kind node is a container in Colima's Linux VM, so KVM is there only when
that VM has nested virtualization, which Apple's hypervisor offers on M3 and
later chips with the `vz` VM type. Kind's node is privileged and sees the VM's
`/dev/kvm`; a pod sees it only when privileged too, so the worker container is.
It starts as root only to hand its own copy of `/dev/kvm` and its volume to the
worker's user, then runs as uid 10001 with no capabilities; commands run in the
VMs. A Colima profile created without nested virtualization keeps that setting:
set `nestedVirtualization: true` in `~/.colima/openai-agent-mxc/colima.yaml`
and restart the profile.

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
| `make verify` | Nineteen boundary probes in a real session VM, a check that a busy service's log reaches the harness only as a masked excerpt, then a scripted investigation through the harness | None |
| `make loadtest` | One user with six conversations, twelve users at once, three users on one shared conversation, and workspace cleanup | None |
| `uv run python -m apps.sre.loadtest --live http://localhost:8001` | Three users asking the deployed UI different questions at once (with `make ui` running) | Three investigations |
| `make isolation` | Three sessions at once: one cannot reach another's workspace, disk, evidence, logs or the journal through its VM, file calls or the findings check; journals hold only their own commands; pod logs hold no output | None |
| `make journal` | Prints the worker's audit journal of every command | None |
| `make status`, `make logs` | Pods, volumes and policies; both pods' logs | None |

## Stop, restart and tear down

`colima stop --profile openai-agent-mxc` stops the VM with the cluster in it;
`colima start --profile openai-agent-mxc` brings it back. Workspaces, the
VMs' disks, the journal and conversations are on the pods' volumes and survive;
a conversation's VM starts again on its next command.

`make clean` removes the pair and the demo and keeps the cluster.
`make teardown` deletes the Kind cluster and stops the VM.

## Troubleshooting

- **The worker pod restarts with "VM self-test failed" or cannot open `/dev/kvm`.**
  The worker boots one VM at startup and exits if it cannot. Check that the
  Colima VM has `/dev/kvm` (`make cluster` checks) and that the worker
  container is privileged.
- **A turn fails with "The sandbox worker … is unavailable".** The harness
  cannot reach the worker: check `make status`, and that the pair token Secret
  exists in `sre-system`.
- **`kind load` fails on a multi-platform image.** `make load` loads only the
  two images it builds; the demo pulls `busybox` itself.
