# syntax=docker/dockerfile:1
# Copyright 2026 openai-agent-microsandbox contributors
# SPDX-License-Identifier: Apache-2.0
#
# What every session VM boots: the agent's tools and nothing else, with no
# credentials. kubectl reads the kubeconfig the worker mounts read-only at
# /etc/sandbox/kube, which points it at the worker's API proxy. python3, jq and
# ripgrep: analysis; models reach for rg to search files, the SDK's memory among
# them. Built without a context (`make images` pipes this file in) and saved as
# an archive the worker image carries.

FROM debian:trixie-slim
ARG TARGETARCH
ARG KUBECTL_VERSION=v1.35.0
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 jq ripgrep curl \
    && curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" \
    && echo "$(curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl.sha256")  /usr/local/bin/kubectl" \
       | sha256sum -c - \
    && chmod 0755 /usr/local/bin/kubectl \
    && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
