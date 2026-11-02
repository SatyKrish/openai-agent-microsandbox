# Copyright 2026 openai-agent-substrate contributors
# SPDX-License-Identifier: Apache-2.0
"""The HTTP API of the harness: conversations, their transcripts and live events, and what a UI shows
beside the chat.

A UI serves its own page and adds these routes (the SRE agent's is in ``apps/sre/ui``): list, start,
read, rename and delete conversations, send a message, stop a turn, follow a conversation's events as
server-sent events, and read a turn's files and trace. The server runs a paid model, so it serves
loopback only, refuses cross-site requests, and serves only files it recorded itself.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
import urllib.error
from pathlib import Path
from typing import Awaitable, Callable

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response, StreamingResponse
from starlette.routing import Route

from . import traces
from .engine import Harness, running_elsewhere
from .store import SHARED, NotFound, Thread

logger = logging.getLogger(__name__)
_THREAD_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")
_MAX_TEXT = 20_000
_PING_S = 15
FILE_HEADERS = {"X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox", "Cache-Control": "no-store"}


def api_routes(harness: Harness, *, config: dict, port: int, jaeger_url: str | None,
               state_fields: tuple[str, ...] = (), starting_files: dict[str, bytes] | None = None,
               worker: Callable[[], Awaitable[dict]] | None = None,
               health: Callable[[], Awaitable[dict]] | None = None,
               user_header: str | None = None) -> list[Route]:
    """The API a UI page uses. ``config`` is the UI's own settings, served at ``/api/config`` with what the harness
    knows (starting files, memory, which of worker and health are served); ``starting_files`` are the workspace's
    initial files.

    ``user_header`` names the header in which an authenticating proxy in front of the harness passes the
    signed-in user; it decides whose conversations a request sees and may delete (the store's admins see
    all), whose memory a conversation uses, and which memory ``/api/memory`` shows and forgets. Without it,
    every user is the guest."""
    origins = {f"http://localhost:{port}", f"http://127.0.0.1:{port}"}
    config = {"name": harness.spec.name, **config,
              "starting_files": [{"path": path, "bytes": len(data)} for path, data in (starting_files or {}).items()],
              "worker": worker is not None, "health": health is not None, "memory": harness.memory is not None,
              "memory_max_age_days": _days(harness.memory.for_user(None).max_age) if harness.memory else None,
              "preferred_output": harness.preferred_output}

    def user(request: Request) -> str | None:
        return (request.headers.get(user_header, "").strip()[:256] or None) if user_header else None

    def same_origin(request: Request) -> bool:
        origin = request.headers.get("origin")
        site = request.headers.get("sec-fetch-site")
        return (origin is None or origin in origins) and site in (None, "same-origin", "none")

    async def settings(request: Request):
        return JSONResponse({**config, "jaeger_url": jaeger_url})

    async def load(request: Request):
        """The requested conversation, if it exists and belongs to the requesting user (or an admin)."""
        thread_id = request.path_params["thread_id"]
        if not _THREAD_ID.fullmatch(thread_id):
            return None
        try:
            return await harness.store.load_thread(thread_id, {"user": user(request)})
        except NotFound:
            return None

    def find_turn(thread, number: int):
        return next((turn for turn in thread.metadata.get("turns", []) if turn["number"] == number), None)

    async def thread_state(request: Request):
        thread = await load(request)
        if thread is None:
            return JSONResponse({"error": "thread not found"}, status_code=404)
        meta = thread.metadata
        state = ("running" if thread.id in harness.running
                 else "elsewhere" if running_elsewhere(meta, harness.running, thread.id)
                 else "idle" if meta.get("sandbox") else "not created")
        return JSONResponse({"thread_id": thread.id, "title": thread.title, "workspace": meta.get("workspace"), "state": state,
                             **{field: meta.get(field) for field in state_fields}, "turns": meta.get("turns", [])},
                            headers={"Cache-Control": "no-store"})

    async def file(request: Request):
        thread = await load(request)
        path = request.path_params["path"]
        turn = find_turn(thread, request.path_params["turn"]) if thread else None
        # Only paths the server collected and recorded can be served.
        entry = next((item for item in (turn or {}).get("files", []) if item["path"] == path and not item.get("too_large")), None)
        if entry is None:
            return JSONResponse({"error": "file not found"}, status_code=404)
        target = harness.conversation(thread).turn_dir(turn["number"]) / path
        headers = dict(FILE_HEADERS)
        if path.endswith(".pdf"):
            # A PDF the agent wrote is a download; the browser never renders it.
            headers["Content-Disposition"] = f'attachment; filename="{Path(path).name}"'
            return FileResponse(target, media_type="application/octet-stream", headers=headers)
        if request.query_params.get("download"):
            headers["Content-Disposition"] = f'attachment; filename="{Path(path).name}"'
        return FileResponse(target, media_type="text/plain; charset=utf-8", headers=headers)

    async def starting_file(request: Request):
        path = request.path_params["path"]
        if path not in (starting_files or {}):
            return JSONResponse({"error": "file not found"}, status_code=404)
        headers = dict(FILE_HEADERS)
        if request.query_params.get("download"):
            headers["Content-Disposition"] = f'attachment; filename="{Path(path).name}"'
        return Response(starting_files[path], media_type="text/plain; charset=utf-8", headers=headers)

    async def worker_info(request: Request):
        if worker is None:
            return JSONResponse({"status": "disabled"}, status_code=404)
        try:
            return JSONResponse({"status": "ok", **await worker()}, headers={"Cache-Control": "no-store"})
        except Exception as error:  # the worker may be restarting; the UI shows it as unreachable
            logger.debug("worker unavailable: %s", error)
            return JSONResponse({"status": "unavailable"}, status_code=503)

    async def health_summary(request: Request):
        if health is None:
            return JSONResponse({"status": "disabled"}, status_code=404)
        try:
            return JSONResponse({"status": "ok", **await health()}, headers={"Cache-Control": "no-store"})
        except Exception as error:  # the worker may be restarting; the page says so
            logger.debug("health unavailable: %s", error)
            return JSONResponse({"status": "unavailable"}, status_code=503)

    async def exists(thread_id: str, who: str | None) -> bool:
        try:
            await harness.store.load_thread(thread_id, {"user": who})
            return True
        except NotFound:
            return False

    async def memory_view(request: Request):
        """GET: the user's memory (``?detail=1``: each remembered conversation and MEMORY.md); DELETE: forget it all."""
        if harness.memory is None:
            return JSONResponse({"status": "disabled"}, status_code=404)
        if request.method == "DELETE":
            if not same_origin(request):
                return JSONResponse({"error": "cross-origin request refused"}, status_code=403)
            return JSONResponse({"status": "ok", "forgot": harness.forget_memory(user(request))})
        detail = request.query_params.get("detail") == "1"
        summary = harness.memory.summary(user(request), detail=detail)
        for item in summary.get("remembered", []):
            item["open"] = bool(_THREAD_ID.fullmatch(item["id"])) and await exists(item["id"], user(request))
        return JSONResponse({"status": "ok", **summary}, headers={"Cache-Control": "no-store"})

    async def memory_conversation(request: Request):
        """DELETE: forget one conversation from the user's memory."""
        if harness.memory is None:
            return JSONResponse({"status": "disabled"}, status_code=404)
        if not same_origin(request):
            return JSONResponse({"error": "cross-origin request refused"}, status_code=403)
        if not harness.forget_memory(user(request), request.path_params["conversation"]):
            return JSONResponse({"status": "not_found"}, status_code=404)
        return JSONResponse({"status": "ok", "forgot": True})

    async def trace(request: Request):
        thread = await load(request)
        turn = find_turn(thread, request.path_params["turn"]) if thread else None
        if turn is None or not turn.get("otel_trace_id"):
            return JSONResponse({"status": "disabled"}, status_code=404)
        if not jaeger_url:
            return JSONResponse({"status": "unavailable", "otel_trace_id": turn["otel_trace_id"]}, status_code=503)
        try:
            payload = traces.fetch_trace(jaeger_url, turn["otel_trace_id"])
        except (OSError, ValueError, urllib.error.URLError):
            return JSONResponse({"status": "unavailable", "otel_trace_id": turn["otel_trace_id"]}, status_code=503)
        if payload is None:
            return JSONResponse({"status": "pending", "otel_trace_id": turn["otel_trace_id"]}, status_code=202)
        return JSONResponse({"status": "ok", "otel_trace_id": turn["otel_trace_id"], **traces.summarize(payload)},
                            headers={"Cache-Control": "no-store"})

    def summary(thread: Thread) -> dict:
        meta = thread.metadata
        state = ("running" if thread.id in harness.running
                 else "elsewhere" if running_elsewhere(meta, harness.running, thread.id)
                 else "idle" if meta.get("sandbox") else "not created")
        return {"id": thread.id, "title": thread.title, "created_at": thread.created_at.isoformat(), "state": state,
                "shared": meta.get("owner") == SHARED, "issue": meta.get("issue"),
                "turns": len(meta.get("turns") or [])}

    async def body_text(request: Request) -> str | JSONResponse:
        try:
            body = await request.json()
        except ValueError:
            return JSONResponse({"error": "send JSON"}, status_code=400)
        text = str((body or {}).get("text") or "").strip()
        if not text:
            return JSONResponse({"error": "Type a question to send."}, status_code=400)
        if len(text) > _MAX_TEXT:
            return JSONResponse({"error": f"Messages are limited to {_MAX_TEXT} characters."}, status_code=413)
        return text

    async def conversations(request: Request):
        """GET: the requesting user's conversations and the shared ones; POST {"text"}: start one with that message."""
        who = user(request)
        if request.method == "GET":
            threads = await harness.store.load_threads({"user": who}, limit=200)
            return JSONResponse({"conversations": [summary(thread) for thread in threads]},
                                headers={"Cache-Control": "no-store"})
        if not same_origin(request):
            return JSONResponse({"error": "cross-origin request refused"}, status_code=403)
        text = await body_text(request)
        if isinstance(text, JSONResponse):
            return text
        thread = Thread.new()
        await harness.store.save_thread(thread, {"user": who})
        sent = await harness.send(thread.id, text, requester=who)
        return JSONResponse({"id": thread.id, "message": sent.message}, status_code=202)

    async def conversation(request: Request):
        """GET: the conversation and its transcript (``?after=SEQ``: only later entries); PATCH {"title"}; DELETE."""
        thread = await load(request)
        if thread is None:
            return JSONResponse({"error": "conversation not found"}, status_code=404)
        who = {"user": user(request)}
        if request.method == "GET":
            after = request.query_params.get("after", "0")
            entries = await harness.store.load_entries(thread.id, who, after=int(after) if after.isdigit() else 0)
            return JSONResponse({**summary(thread), "entries": entries}, headers={"Cache-Control": "no-store"})
        if not same_origin(request):
            return JSONResponse({"error": "cross-origin request refused"}, status_code=403)
        if request.method == "PATCH":
            try:
                title = str((await request.json() or {}).get("title") or "").strip()[:120]
            except ValueError:
                return JSONResponse({"error": "send JSON"}, status_code=400)
            thread.title = title or thread.title
            await harness.store.save_thread(thread, who)
            return JSONResponse(summary(thread))
        try:
            await harness.store.delete_thread(thread.id, who)
        except PermissionError as error:
            return JSONResponse({"error": str(error)}, status_code=403)
        return JSONResponse({"deleted": True})

    async def send(request: Request):
        """POST {"text"}: a message; it is answered in the conversation's next turn, in the background."""
        if not same_origin(request):
            return JSONResponse({"error": "cross-origin request refused"}, status_code=403)
        thread = await load(request)
        if thread is None:
            return JSONResponse({"error": "conversation not found"}, status_code=404)
        text = await body_text(request)
        if isinstance(text, JSONResponse):
            return text
        sent = await harness.send(thread.id, text, requester=user(request))
        return JSONResponse({"queued": True, "message": sent.message}, status_code=202)

    async def stop(request: Request):
        if not same_origin(request):
            return JSONResponse({"error": "cross-origin request refused"}, status_code=403)
        thread = await load(request)
        if thread is None:
            return JSONResponse({"error": "conversation not found"}, status_code=404)
        return JSONResponse({"stopped": harness.stop(thread.id)})

    async def follow(request: Request):
        """The conversation's events from now on, as server-sent events, with a comment line to keep it open."""
        thread = await load(request)
        if thread is None:
            return JSONResponse({"error": "conversation not found"}, status_code=404)

        async def stream():
            # The stream ends when the server stops (the page reconnects), so a stop need not wait for it.
            stopping: asyncio.Event = request.app.state.stopping
            with harness.listen(thread.id) as events:
                yield ": following\n\n"
                while not stopping.is_set():
                    waits = [asyncio.ensure_future(events.get()), asyncio.ensure_future(stopping.wait())]
                    done, pending = await asyncio.wait(waits, timeout=_PING_S, return_when=asyncio.FIRST_COMPLETED)
                    for wait in pending:
                        wait.cancel()
                    if waits[0] in done:
                        yield f"data: {json.dumps(waits[0].result())}\n\n"
                    elif not done:
                        if await request.is_disconnected():
                            return
                        yield ": ping\n\n"

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})

    return [
        Route("/api/conversations", conversations, methods=["GET", "POST"]),
        Route("/api/conversations/{thread_id}", conversation, methods=["GET", "PATCH", "DELETE"]),
        Route("/api/conversations/{thread_id}/messages", send, methods=["POST"]),
        Route("/api/conversations/{thread_id}/stop", stop, methods=["POST"]),
        Route("/api/conversations/{thread_id}/events", follow),
        Route("/api/starting-files/{path:path}", starting_file),
        Route("/api/worker", worker_info),
        Route("/api/health", health_summary),
        Route("/api/memory", memory_view, methods=["GET", "DELETE"]),
        Route("/api/memory/conversations/{conversation}", memory_conversation, methods=["DELETE"]),
        Route("/api/config", settings),
        Route("/api/threads/{thread_id}", thread_state),
        Route("/api/threads/{thread_id}/turns/{turn:int}/files/{path:path}", file),
        Route("/api/threads/{thread_id}/turns/{turn:int}/trace", trace),
    ]


def _days(age) -> float | None:
    return round(age.total_seconds() / 86400, 2) if age else None


def application(routes: list, *, on_startup: Callable[[], Awaitable[None]] | None = None,
                on_shutdown: Callable[[], Awaitable[None]] | None = None) -> Starlette:
    """``on_startup`` runs before the server takes requests (a UI starts its background work there).
    ``on_shutdown`` runs when the server stops, after in-flight requests finish: the harness
    closes its open sessions there, so a restart does not lose the memory they would have generated."""
    # Reject other Host headers so a rebinding DNS name cannot reach the loopback server.
    middleware = [Middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1"])]

    @contextlib.asynccontextmanager
    async def lifespan(_app):
        if on_startup is not None:
            await on_startup()
        yield
        if on_shutdown is not None:
            await on_shutdown()

    app = Starlette(routes=routes, middleware=middleware, lifespan=lifespan)
    app.state.stopping = asyncio.Event()
    return app


def serve(app: Starlette, *, host: str, port: int, log_level: str = "info") -> None:
    """Runs an ``application`` until it is told to stop. Stopping ends the event streams pages keep open,
    waits briefly for other requests, then runs ``on_shutdown``."""
    import uvicorn

    class Server(uvicorn.Server):
        async def shutdown(self, sockets=None):
            app.state.stopping.set()
            await super().shutdown(sockets)

    Server(uvicorn.Config(app, host=host, port=port, log_level=log_level, timeout_graceful_shutdown=5)).run()
