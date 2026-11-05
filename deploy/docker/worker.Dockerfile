# syntax=docker/dockerfile:1
# Copyright 2026 openai-agent-mxc contributors
# SPDX-License-Identifier: Apache-2.0
#
# The sandbox worker. Build with the repository root as the context, after the
# guest image is saved to build/guest-image.tar (`make images` does both). The
# worker holds no analysis tools: each session's commands run in a microVM booted
# from the guest image, which microsandbox loads into its store on the worker's
# volume at startup. The microsandbox npm package brings its runtime and guest
# kernel for this platform.

FROM node:24-trixie-slim AS build
WORKDIR /app
COPY worker/package.json worker/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY worker/tsconfig.json worker/tsconfig.build.json ./
COPY worker/src ./src
RUN npx tsc -p tsconfig.build.json && npm prune --omit=dev

FROM node:24-trixie-slim
# ca-certificates: microsandbox's runtime will not start without a CA store, even for a local image.
# setpriv: the entrypoint's drop from root to the worker's user.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates util-linux \
    && (command -v setpriv || apt-get install -y --no-install-recommends setpriv) \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
COPY proto ./proto
# The folder first: COPY --chmod would give a folder it creates the file's mode. `docker save` writes 0600.
RUN mkdir -p -m 0755 /opt/guest /sandboxes
COPY --chmod=0644 build/guest-image.tar /opt/guest/image.tar
COPY --chmod=0755 deploy/docker/worker-entrypoint.sh /usr/local/bin/worker-entrypoint
ENV NODE_ENV=production WORKER_PROTO_ROOT=/app/proto DATA_DIR=/sandboxes MSB_HOME=/sandboxes/msb \
    WORKER_GUEST_IMAGE=sre-sandbox-guest:local WORKER_GUEST_IMAGE_ARCHIVE=/opt/guest/image.tar
EXPOSE 50051
ENTRYPOINT ["/usr/local/bin/worker-entrypoint"]
CMD ["node", "dist/src/main.js"]
