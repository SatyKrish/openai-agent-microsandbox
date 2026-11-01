# syntax=docker/dockerfile:1
# Copyright 2026 openai-agent-mxc contributors
# SPDX-License-Identifier: Apache-2.0
#
# The MXC sandbox worker. Build with the repository root as the context.
# Everything a workload can use is baked in here, read-only: MXC's Bubblewrap
# backend mounts a deny-by-default baseline into each container (/bin, /sbin,
# /lib*, /usr/bin, /usr/sbin, /usr/lib*, /usr/libexec, /usr/share and /etc) and
# nothing else from the image; /usr/local is not in it. kubectl goes in /usr/bin
# for that reason.

FROM node:24-trixie-slim AS build
# node-pty, a dependency of the MXC SDK, has no prebuilt Linux binary.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY worker/package.json worker/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY worker/tsconfig.json worker/tsconfig.build.json ./
COPY worker/src ./src
RUN npx tsc -p tsconfig.build.json && npm prune --omit=dev

FROM node:24-trixie-slim
ARG TARGETARCH
ARG KUBECTL_VERSION=v1.35.0
# bubblewrap (0.5 or later): MXC's Linux backend. slirp4netns, iptables (nf_tables),
# iproute2 and util-linux (unshare, nsenter, prlimit, choom): the host tools MXC's
# proxy-only network mode needs, which lets a container reach the worker's
# read-only API proxy and nothing else. python3 and jq: analysis.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bubblewrap slirp4netns iptables iproute2 util-linux ca-certificates python3 jq curl \
    && curl -fsSLo /usr/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" \
    && echo "$(curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl.sha256")  /usr/bin/kubectl" \
       | sha256sum -c - \
    && chmod 0755 /usr/bin/kubectl \
    && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
COPY proto ./proto
RUN mkdir -p /sandboxes && chown 10001:10001 /sandboxes
ENV NODE_ENV=production MXC_PROTO_ROOT=/app/proto DATA_DIR=/sandboxes
USER 10001:10001
EXPOSE 50051
CMD ["node", "dist/src/main.js"]
