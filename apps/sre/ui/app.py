# Copyright 2026 openai-agent-mxc contributors
# SPDX-License-Identifier: Apache-2.0
"""The SRE agent's UI: its own page (``static/``), served beside the harness's API."""

from __future__ import annotations

from pathlib import Path

import asyncio
import contextlib

from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from openai_harness import http
from openai_harness.chat import HarnessChatServer

STATIC = Path(__file__).resolve().parent / "static"

# The page's words that are not code; served at /api/config with what __main__ and the harness add.
UI = {
    "greeting": "Which workload should I look at?",
    # How this works: said once, in the dialog the top bar opens, rather than on every view.
    "about": [
        "Each command runs in its own Microsoft eXecution Container on the sandbox worker. kubectl there has the "
        "worker's read-only identity and reaches only the Kubernetes API. The worker never holds the model's API key.",
        "The worker records each kubectl read as evidence in a journal no container can edit. A pod's log is cut to "
        "an excerpt there, with credentials and personal data masked; the full log never reaches the model.",
        "After each turn the harness checks every quote in findings.json against the journal's copy. Causes are the "
        "agent's reasoning; fixes are proposals it cannot run.",
        "New workspaces start with the application team's runbooks.",
    ],
    "follow_ups": [
        {"label": "How would I fix it?", "prompt": "For each finding, propose the smallest fix as commands I could run "
                                                   "myself. Don't run anything."},
        {"label": "What else could explain it?", "prompt": "What else could explain these failures? Check the evidence "
                                                           "for anything you ruled out too quickly."},
    ],
}


class _Revalidated(StaticFiles):
    """Static files the browser revalidates on every load, so an edited page is never served stale."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


async def _page(request: Request):
    return FileResponse(STATIC / "index.html", media_type="text/html", headers={"Cache-Control": "no-store"})


async def _icon(request: Request):
    return FileResponse(STATIC / "favicon.svg", media_type="image/svg+xml")


def create_app(server: HarnessChatServer, *, config: dict, port: int, jaeger_url: str | None, worker=None,
               health=None, user_header: str | None = None, starting_files: dict[str, bytes] | None = None,
               issues=None):
    """``health`` is the worker's summary of its namespaces, shown on the start screen and never sent to the
    model. ``user_header`` carries the signed-in user from an authenticating proxy, whose memory the page
    shows; without it everyone is the guest. ``issues`` (an ``Issues``) opens an issue for each unhealthy
    workload while the server runs; ``/api/issues`` lists them."""
    api = http.api_routes(server, config={**UI, **config, "issues": issues is not None}, port=port,
                          jaeger_url=jaeger_url, worker=worker, health=health, user_header=user_header,
                          starting_files=starting_files)
    running: list[asyncio.Task] = []

    async def listing(request: Request):
        if issues is None:
            return JSONResponse({"status": "disabled"}, status_code=404)
        return JSONResponse({"status": "ok", "issues": await issues.listing()}, headers={"Cache-Control": "no-store"})

    async def start():
        if issues is not None:
            running.append(asyncio.get_running_loop().create_task(issues.run()))

    async def stop():
        for task in running:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        await server.close_all()

    return http.application([Route("/", _page), Route("/favicon.svg", _icon), Route("/favicon.ico", _icon),
                             Route("/api/issues", listing), *api,
                             Mount("/static", _Revalidated(directory=STATIC), name="static")],
                            on_startup=start, on_shutdown=stop)
