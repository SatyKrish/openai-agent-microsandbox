# syntax=docker/dockerfile:1
# Copyright 2026 openai-agent-microsandbox contributors
# SPDX-License-Identifier: Apache-2.0
#
# The SRE agent's harness: the OpenAI Agents SDK loop, the shared UI and the
# sandbox worker provider. Build with the repository root as the context. It holds the model's
# API key at run time (from a Secret) and no Kubernetes credentials.

# The page (apps/sre/ui/web, assistant-ui), built into static/app. It imports the views in static/.
FROM node:24-trixie-slim AS page
WORKDIR /src/apps/sre/ui/web
COPY apps/sre/ui/web/package.json apps/sre/ui/web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/sre/ui/static ../static
COPY apps/sre/ui/web ./
RUN npm run build

FROM python:3.13-slim-trixie
COPY --from=ghcr.io/astral-sh/uv:0.11.7 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /app
COPY pyproject.toml uv.lock .python-version ./
COPY sandbox ./sandbox
COPY harness/pyproject.toml ./harness/
COPY harness/src ./harness/src
RUN uv sync --locked --no-dev --all-packages
COPY apps ./apps
COPY --from=page /src/apps/sre/ui/static/app ./apps/sre/ui/static/app
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin harness && mkdir -p /data && chown 10001 /data
ENV PATH=/app/.venv/bin:$PATH SRE_DATA_DIR=/data PYTHONDONTWRITEBYTECODE=1
USER 10001
EXPOSE 8001
CMD ["python", "-m", "apps.sre.ui"]
