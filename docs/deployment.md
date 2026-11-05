# Deploy on Kubernetes

`deploy/kubernetes/base` is one application domain's pair: the `sre-system`
and `payments` namespaces, the worker's read-only identity, the two
StatefulSets, the worker's headless Service and the NetworkPolicies. Overlays
adapt it: `overlays/kind` for local Kind, `overlays/aks` for AKS on a node
pool with nested virtualization. The AKS overlay has not been deployed in this repository; treat it
as a starting point.

## What the cluster needs

| Need | Why | In the base |
| --- | --- | --- |
| Linux nodes with KVM | Every session runs in a microVM; on cloud VMs that needs a size with nested virtualization | The AKS overlay selects a node pool named `kvm` |
| `/dev/kvm` in the worker | Only a privileged container gets the node's devices | The worker container is privileged and starts as root, then drops to uid 10001 with no capabilities; the namespace has `pod-security.kubernetes.io/enforce: privileged` |
| Memory for the VMs | Each running VM takes up to `WORKER_VM_MEMORY_MIB` | The worker's limit, 4 GiB, covers 4 VMs of 768 MiB |
| A NetworkPolicy-enforcing CNI | The worker accepts only its harness; the harness reaches only DNS, its worker and HTTPS | `network-policies.yaml` |
| A default StorageClass, or one set in an overlay | Workspaces, the journal and conversations survive restarts | `volumeClaimTemplates` |
| `KUBERNETES_SERVICE_HOST` as an IPv4 address | The worker's API proxy dials it by address; the worker's NetworkPolicy allows no DNS | Set by the kubelet |

The worker boots a real VM at startup and checks it: the VM writes its
workspace, sees neither the journal nor a service-account token, and reaches the
Kubernetes API through the worker's proxy. A node without KVM, or a pod without
`/dev/kvm`, fails that self-test, and the pod restarts with the reason in its log.

## Not inside Kata

AKS Pod Sandboxing (`kata-vm-isolation`) cannot host the worker: a Kata pod has
no `/dev/kvm` of its own (Kata's guest kernel is built without KVM, and its
Azure configuration turns guest nesting off), so the worker could not start its
VMs. The isolation comes from each session's VM instead, on a node pool whose VM
size offers nested virtualization. Check before relying on it:

- That the node pool's VM size supports nested virtualization and `/dev/kvm`
  exists on its nodes.
- That `make verify` passes there: it checks the boundary from inside a real
  session VM.
- Instead of a privileged worker, a KVM device plugin can hand pods `/dev/kvm`;
  the entrypoint then needs no root step for the device. Not set up here.

## Images, Secrets and storage

1. Build the images (`make images`: the guest image, saved into the worker
   image, then the worker and the harness) and push the worker and harness
   images to your registry; set them with the overlay's `images:` list.
   Publishing the worker image distributes microsandbox's libkrunfw; see
   [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
2. Create the model settings for the harness only:

   ```bash
   kubectl -n sre-system create secret generic openai-creds --from-env-file=.env
   ```

3. Create the pair token, which the worker requires on every call:

   ```bash
   kubectl -n sre-system create secret generic sre-payments-pair-token --from-literal=token="$(openssl rand -hex 32)"
   ```

4. Pick storage classes in the overlay. The AKS overlay uses
   `managed-csi-premium` and gives the worker 32 GiB.

Apply with `kubectl apply -k deploy/kubernetes/overlays/aks`, then run
`kubectl -n sre-system exec sre-harness-payments-0 -- python -m apps.sre.verify`.

## Another application domain

Copy the base and rename `payments` throughout: the target namespace, the
Role and RoleBinding, the ServiceAccount, both StatefulSets and Services, the
`sre.example.com/domain` labels, the pair token Secret, and the harness's
`WORKER_TARGET`, `WORKER_NAME` and `SRE_NAMESPACES`. Each domain gets
its own pair, identity and token; a harness can reach only its own worker.
Each domain's agent keeps its users' memory on its own harness's volume.

The harness's pod keeps `terminationGracePeriodSeconds: 180`: when it stops, it
closes its open conversations, and the SDK generates each one's memory (about
about 65 s each with the default memory models, so two fit). Lower
`SRE_SESSION_IDLE_S` if more conversations are usually open at a rollout, or
raise the grace period.

## Reaching the UI

The harness binds 127.0.0.1 and has no Service, so access is
`kubectl port-forward` under Kubernetes RBAC. Anyone who can port-forward to
the harness pod can use the agent and its model key, as the guest.

## Signing users in

Each signed-in user has their own memory; without sign-in, everyone is the
guest and shares the guest's. To sign users in, put an authenticating proxy in
front of the UI, such as oauth2-proxy as a sidecar in the harness pod, and set
the harness's `SRE_USER_HEADER` to the header in which it passes the user, for
example `X-Forwarded-Email`. The harness trusts that header, so the proxy must
be the only way users reach the UI, and must set the header on every request,
replacing any the browser sent. `kubectl port-forward` to the harness pod
bypasses the proxy, so anyone allowed to use it can claim any user; keep that
permission to operators. The harness trims and lowercases the name, so
`Ana@Example.com` and `ana@example.com` are one user, with one set of
conversations and one memory. A name starting with `@` is refused with 403:
`@team` owns the shared conversations.

With sign-in, each user sees and may delete only their own conversations;
another user's reads as not found. Issues the health board opens are shared:
everyone sees them and can investigate in them, and only an admin can delete
one. `SRE_ADMIN_USERS` names the admins, who see and may delete everything.
Each turn records who asked, and the worker's journal records it with every
command and log read.

## Replicas follow the state backend

The harness keeps four kinds of state: conversations and their transcripts,
each conversation's history (an SDK session), host copies of the agent's
outputs and evidence, and each user's memory. Today all four are files on its
volume, so the harness is a StatefulSet with one replica per domain.

| State backend | Harness | Replicas |
| --- | --- | --- |
| Files on a volume (today) | StatefulSet with a volume | One per domain |
| Postgres or object storage (not built yet) | Deployment, no volume | Several per domain |

A stateless harness needs all four kinds of state in the backend, not memory
alone: threads and history in Postgres (the SDK has a SQLAlchemy session),
host copies and memory in object storage or Postgres, and the per-conversation
and per-user locks as database or conditional-write locks. A conversation's
open sandbox session also lives in one replica's process between turns, so a
stateless harness must route a conversation's messages to that replica or hand
the session over. The workspace itself stays on the sandbox worker either way.
