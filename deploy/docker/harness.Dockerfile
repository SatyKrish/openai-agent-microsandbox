# syntax=docker/dockerfile:1
# Copyright 2026 openai-agent-mxc contributors
# SPDX-License-Identifier: Apache-2.0
#
# The SRE agent's harness: the OpenAI Agents SDK loop, the shared UI and the MXC
# provider. Build with the repository root as the context. It holds the model's
# API key at run time (from a Secret) and no Kubernetes credentials.

FROM python:3.13-slim-trixie
COPY --from=ghcr.io/astral-sh/uv:0.11.7 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /app
COPY pyproject.toml uv.lock .python-version ./
COPY provider ./provider
COPY harness/pyproject.toml ./harness/
COPY harness/src ./harness/src
RUN uv sync --locked --no-dev --all-packages
COPY examples ./examples
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin harness && mkdir -p /data && chown 10001 /data
ENV PATH=/app/.venv/bin:$PATH SRE_DATA_DIR=/data PYTHONDONTWRITEBYTECODE=1
USER 10001
EXPOSE 8001
CMD ["python", "-m", "examples.sre.ui"]
