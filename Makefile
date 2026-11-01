# Copyright 2026 openai-agent-mxc contributors
# SPDX-License-Identifier: Apache-2.0
#
# Local reference deployment on Kind. Every kubectl call names KUBE_CONTEXT, so
# other clusters in your kubeconfig are never touched. On macOS the cluster runs
# in its own Colima VM (COLIMA_PROFILE); on Linux, set COLIMA_PROFILE= to use the
# local Docker daemon.

CLUSTER        ?= openai-agent-mxc
KUBE_CONTEXT   ?= kind-$(CLUSTER)
COLIMA_PROFILE ?= openai-agent-mxc
COLIMA_CPUS    ?= 4
COLIMA_MEMORY  ?= 8
ENV_FILE       ?= .env
OVERLAY        ?= deploy/kubernetes/overlays/kind
UI_PORT        ?= 8001
WORKER_IMAGE   ?= mxc-sandbox-worker:local
HARNESS_IMAGE  ?= sre-agent-harness:local

ifneq ($(COLIMA_PROFILE),)
export DOCKER_HOST := unix://$(HOME)/.colima/$(COLIMA_PROFILE)/docker.sock
endif
KUBECTL := kubectl --context $(KUBE_CONTEXT)

.PHONY: all cluster images load secrets deploy demo ui verify loadtest isolation journal logs status test test-worker test-python proto clean teardown

all: cluster images load secrets deploy demo

cluster: ## Colima VM (macOS) and the Kind cluster
ifneq ($(COLIMA_PROFILE),)
	@colima status --profile $(COLIMA_PROFILE) >/dev/null 2>&1 || \
	  colima start --profile $(COLIMA_PROFILE) --cpus $(COLIMA_CPUS) --memory $(COLIMA_MEMORY) --disk 40 \
	    --activate=false --ssh-config=false
	@# Ubuntu 24.04 confines unprivileged user namespaces with AppArmor, which Bubblewrap needs.
	@# This VM exists only for this cluster; MXC's own diagnostics suggest the same on an ephemeral host.
	colima ssh --profile $(COLIMA_PROFILE) -- sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
endif
	@kind get clusters 2>/dev/null | grep -qx $(CLUSTER) || { \
	  previous=$$(kubectl config current-context 2>/dev/null); \
	  kind create cluster --name $(CLUSTER) --config deploy/kind/cluster.yaml --wait 120s; \
	  if [ -n "$$previous" ]; then kubectl config use-context "$$previous" >/dev/null; fi; }

images: ## Build the worker and harness images
	docker build -f deploy/docker/worker.Dockerfile -t $(WORKER_IMAGE) .
	docker build -f deploy/docker/harness.Dockerfile -t $(HARNESS_IMAGE) .

load: ## Load the built images into Kind (the demo pulls busybox itself)
	kind load docker-image --name $(CLUSTER) $(WORKER_IMAGE) $(HARNESS_IMAGE)

secrets: ## The harness's OpenAI settings from ENV_FILE, and the harness/worker pair token
	$(KUBECTL) create namespace sre-system --dry-run=client -o yaml | $(KUBECTL) apply -f - >/dev/null
	@test -f $(ENV_FILE) || { echo "Copy .env.example to $(ENV_FILE) and set OPENAI_API_KEY"; exit 1; }
	@grep -E '^OPENAI_[A-Z_]+=.' $(ENV_FILE) > .openai.env.tmp; \
	  $(KUBECTL) -n sre-system create secret generic openai-creds --from-env-file=.openai.env.tmp \
	    --dry-run=client -o yaml | $(KUBECTL) apply -f - ; status=$$?; rm -f .openai.env.tmp; exit $$status
	@$(KUBECTL) -n sre-system get secret sre-payments-pair-token >/dev/null 2>&1 || \
	  $(KUBECTL) -n sre-system create secret generic sre-payments-pair-token \
	    --from-literal=token=$$(openssl rand -hex 32)

deploy: ## Apply the pair and wait for both pods
	$(KUBECTL) apply -k $(OVERLAY)
	$(KUBECTL) -n sre-system rollout status statefulset/sre-sandbox-payments --timeout=180s
	$(KUBECTL) -n sre-system rollout status statefulset/sre-harness-payments --timeout=180s

demo: ## The broken payments workloads
	$(KUBECTL) apply -f deploy/demo/payments.yaml

ui: ## Port-forward the harness UI to http://localhost:$(UI_PORT)
	@echo "SRE agent UI: http://localhost:$(UI_PORT)"
	$(KUBECTL) -n sre-system port-forward pod/sre-harness-payments-0 $(UI_PORT):8001

verify: ## Boundary probes and a scripted investigation, in the cluster, without a model
	$(KUBECTL) -n sre-system exec sre-harness-payments-0 -c harness -- python -m apps.sre.verify

loadtest: ## Many conversations and users at once, in the cluster, without a model
	$(KUBECTL) -n sre-system exec sre-harness-payments-0 -c harness -- python -m apps.sre.loadtest

isolation: ## One session's logs and evidence out of every other's reach, in the cluster and from the host
	@mkdir -p artifacts; status=0; \
	  $(KUBECTL) -n sre-system exec sre-harness-payments-0 -c harness -- python -m apps.sre.isolation \
	    > artifacts/isolation.out 2>&1 || status=1; \
	  grep -v '^STATE ' artifacts/isolation.out; \
	  uv run --locked python -m apps.sre.isolation --host-check artifacts/isolation.out --context $(KUBE_CONTEXT) \
	    || status=1; \
	  rm -f artifacts/isolation.out; exit $$status

journal: ## The worker's audit journal of every command
	$(KUBECTL) -n sre-system exec sre-sandbox-payments-0 -c worker -- \
	  sh -c 'for f in /sandboxes/history/*/journal.jsonl; do echo "== $$f"; cat "$$f"; done'

logs: ## Follow both pods' logs
	$(KUBECTL) -n sre-system logs -f --prefix -l 'app.kubernetes.io/name in (sre-harness,sre-sandbox)' --max-log-requests 4

status:
	$(KUBECTL) -n sre-system get pods,pvc,networkpolicy -o wide
	$(KUBECTL) -n payments get pods -o wide

test: test-worker test-python ## Unit and integration tests, no cluster needed

test-worker:
	cd worker && npm ci --ignore-scripts --no-audit --no-fund && npm test

test-python: ## Needs the worker built (test-worker)
	uv run --locked pytest

proto: ## Regenerate the Python stubs from proto/
	uvx --from grpcio-tools==1.85.1 python -m grpc_tools.protoc -Iproto/mxc/sandbox/v1 \
	  --python_out=sandbox/src/agent_mxc/proto --pyi_out=sandbox/src/agent_mxc/proto \
	  --grpc_python_out=sandbox/src/agent_mxc/proto proto/mxc/sandbox/v1/sandbox.proto
	sed -i.bak 's/^import sandbox_pb2 as sandbox__pb2/from . import sandbox_pb2 as sandbox__pb2/' \
	  sandbox/src/agent_mxc/proto/sandbox_pb2_grpc.py && rm sandbox/src/agent_mxc/proto/sandbox_pb2_grpc.py.bak

clean: ## Remove the pair and the demo; keeps the cluster
	-$(KUBECTL) delete -f deploy/demo/payments.yaml --ignore-not-found
	-$(KUBECTL) delete -k $(OVERLAY) --ignore-not-found

teardown: ## Delete the Kind cluster and stop its Colima VM
	kind delete cluster --name $(CLUSTER)
ifneq ($(COLIMA_PROFILE),)
	colima stop --profile $(COLIMA_PROFILE)
endif
