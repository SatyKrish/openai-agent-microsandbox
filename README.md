# openai-agent-microsandbox

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

A reference implementation of **a paired sandbox for the OpenAI Agents SDK
`SandboxAgent` on Kubernetes, with a microVM per conversation**. The SDK
harness runs in one pod with the model's API key; every shell command and file
operation runs in a [microsandbox](https://github.com/superradcompany/microsandbox)
microVM on a paired sandbox worker pod that holds the application's read-only
cluster identity instead.

## Harness separate from compute

This project follows the [harness separate from compute pattern](https://developers.openai.com/api/docs/guides/agents/sandboxes) in the official OpenAI Sandbox Agents guide.

![Harness separate from compute: trusted agent orchestration calls sandbox compute for shell execution and filesystem work.](docs/assets/harness-separate-from-compute.png)

*Diagram from the [official OpenAI documentation](https://developers.openai.com/api/docs/guides/agents/sandboxes).*

`WorkerSandboxClient` connects the SDK sandbox interface to the sandbox worker
over gRPC. The worker gives each conversation a workspace on its volume and a
microVM, started on the conversation's first command and stopped when it is
idle, that sees only that workspace. Each application domain gets one pair:

| Harness (`sre-harness-payments-0`) | Sandbox worker (`sre-sandbox-payments-0`) |
| --- | --- |
| The OpenAI Agents SDK, with SDK sessions for history | One workspace per conversation, kept on the worker's volume |
| The SRE UI (assistant-ui) over the harness's conversation API | A microVM per conversation: shell, files, skills, kubectl, Python |
| The model's API key, and no Kubernetes token | A read-only Kubernetes identity, used only by its API proxy, and no model API key |
| Host checks of findings against recorded evidence | An audit journal and recorded evidence that no VM can see |

The model loop, model calls and conversation state stay in the harness. A
command reaches the cluster only from inside its conversation's VM, which has its
own kernel, vCPU and memory limits, no credentials, a network that reaches
nothing but the worker's read-only Kubernetes API proxy, and no view of the
journal or of other conversations. The proxy adds the worker's token and refuses
anything but reads, so the token never enters a VM. Logs never reach the model
raw: VMs cannot read them, and the agent's `pod_logs` tool gets them from the
worker as excerpts, with only the error and warning lines kept, repeats
collapsed, credentials and personal data masked, and a hard size cap. Plain kubectl reads are
recorded as evidence outside the VMs, and the harness checks every quote
in the agent's findings against those copies. See the
[architecture](docs/architecture.md).

## Quick start

Run the SRE agent on a local Kind cluster. You need macOS on Apple silicon (M3
or later, for nested virtualization) with [Colima](https://github.com/abiosoft/colima),
or Linux with Docker and KVM, plus [kind](https://kind.sigs.k8s.io/), kubectl,
Node 24 or later, [uv](https://docs.astral.sh/uv/), and an OpenAI API key.

**1. Add your OpenAI settings.** Set `OPENAI_API_KEY` and `OPENAI_MODEL` in
`.env`. Only the harness pod receives them, through a Secret; the sandbox worker
never does.

```bash
cp .env.example .env
```

**2. Set up the cluster and deploy the pair.** This starts a dedicated Colima
VM with nested virtualization, creates the Kind cluster, builds the guest,
worker and harness images, and deploys them with a payments application that is
broken in two ways, plus a service whose logs are full of customer data. Every
command names the `kind-openai-agent-microsandbox` context, and your current kubectl
context is restored afterwards. See the [local Kubernetes guide](docs/local-kubernetes.md).

```bash
make all
```

**3. Check the boundary.** Nineteen probes run in a real session VM, then a
scripted investigation runs through the harness. No model API usage.

```bash
make verify
```

**4. Open the UI** at <http://localhost:8001>. The start screen lists the
workloads in `payments`, failing first, with why; select **Investigate** on one,
or ask which workloads are unhealthy.

```bash
make ui
```

You see each command as it runs in the conversation's VM. The agent
writes `output/findings.md` and `output/findings.json`. As with an artifact, the
chat says what happened in a few sentences and a card opens the findings beside
it: each finding's cause, its fix as steps to copy and run, and its quotes, each of
which the harness found in the evidence and which opens the kubectl read or log
excerpt it came from. Each turn that rewrites the findings makes a new version.
Later messages continue in the same workspace. When a
conversation goes idle, the SDK distils what it learned into your memory,
which your next conversation starts with; the Memory tab beside History
lists what it remembers, to open or forget. `make loadtest` runs many conversations and users at once;
`make journal` prints the worker's audit journal; `make teardown` deletes the
cluster and stops the VM.

## The SRE agent

The [SRE agent](apps/sre/README.md) investigates unhealthy workloads with
kubectl in its sandbox, using the worker's read-only identity: it can read pods,
logs, events and workload objects in `payments`, and cannot read Secrets or
change anything. It loads a `kubernetes-triage` skill, reads the application
team's runbooks seeded into every workspace, and proposes fixes for a person to
run. It remembers across conversations through the SDK's `Memory` capability:
the harness carries each conversation's distilled lessons into the same user's
later conversations (everyone shares the guest's without sign-in), forgets
them after 90 days, and the agent cannot write memory itself. The SRE UI is this
repository's own page in `apps/sre/ui`, started from
[openai-agent-substrate](https://github.com/SatyKrish/openai-agent-substrate)'s shared UI; the
harness serves only its API.

## Use the provider in your own application

The provider is the `openai-agent-microsandbox` package in `sandbox/`, imported as
`sandbox_worker`. It implements the SDK's `BaseSandboxClient` for any `SandboxAgent`;
the worker is the image built from `worker/`, and the image its VMs boot is
built from `deploy/docker/guest.Dockerfile`. See
[SDK integration](docs/usage.md) and, for a cluster other than Kind, the
[deployment guide](docs/deployment.md).

## Verification

The provider is pinned to `openai-agents==0.24.0` and the worker to
`microsandbox` 0.7.13, which is beta software. See the
[verification record](docs/verification.md) for what has been checked on local
ARM64 Kind, where KVM runs nested under macOS's hypervisor. AKS remains
unverified.

## Tracing

Set `OTEL_EXPORTER_OTLP_ENDPOINT` (OTLP over HTTP, port 4318) for the harness,
and `JAEGER_URL` to its query address, to export each turn's SDK spans and the
provider's workspace and command spans. The UI then shows each turn as a
harness/sandbox timeline. Only span types, tool names and numeric metrics are
exported; prompts, commands and outputs are not. The exporter stays in the
harness.

## Repository layout

```text
pyproject.toml              uv workspace root: dev tools and test settings, no package
proto/sandbox/v1/           The harness/worker gRPC contract
worker/                     The sandbox worker (Node 24, TypeScript, microsandbox), its unit tests and a host runner for tests
sandbox/                    The provider (openai-agent-microsandbox): WorkerSandboxClient, gRPC transport, tracing
harness/                    The agent harness (openai-harness): turn engine, memory and HTTP API, adapted from openai-agent-substrate
apps/sre/                   The SRE agent: SandboxAgent, skill, runbooks, findings check, its UI, verify and load test
deploy/docker/              Guest, worker and harness images
deploy/kubernetes/          Kustomize base (the pair, RBAC, NetworkPolicies) and kind and AKS overlays
deploy/kind/, deploy/demo/  The Kind cluster and the broken payments workloads
docs/                       Architecture, local Kubernetes, deployment, usage, development and verification
```

## Documentation

- [Architecture and limits](docs/architecture.md)
- [Local Kubernetes setup and tests](docs/local-kubernetes.md)
- [Deploying on another cluster](docs/deployment.md)
- [SDK integration and sessions](docs/usage.md)
- [Development](docs/development.md) and the [verification record](docs/verification.md)
- [SRE agent](apps/sre/README.md)

## License

Original project code and documentation are licensed under
[Apache-2.0](LICENSE). The harness and UI derive from openai-agent-substrate
(Apache-2.0); microsandbox is installed from npm under Apache-2.0; the OpenAI
diagram retains its original rights. See [NOTICE](NOTICE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
