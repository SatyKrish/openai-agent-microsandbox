# Copyright 2026 openai-agent-substrate contributors
# SPDX-License-Identifier: Apache-2.0
"""The harness's turn engine: conversations, their turns and what each turn shows, with no UI protocol.

A message for a conversation joins its queue. The conversation's turns run one at a time in the
background, so a turn does not depend on the request that asked for it: messages that arrive while
one runs are answered together in the next turn, and every page, terminal or other client that
listens sees the same events.

Each turn continues the conversation's open sandbox session or opens it (creating the workspace on
its MXC sandbox worker the first time), copies uploads into it, runs the agent loop with the
conversation's SDK session history (every command in a fresh MXC container), fetches the cluster
reads the worker recorded as evidence, copies the agent's output folders to the host and runs the
agent's host check.

What a turn shows is kept as the conversation's transcript, a list of entries a UI renders:
``user`` (a message), ``steps`` (a group of tool calls), ``assistant`` (the agent's text) and
``card`` (a declarative card: Card, Row, Text, Badge, Button, Caption). Listeners receive events:
``entry`` (an entry added or changed), ``delta`` (text of an assistant entry as it streams),
``turn`` (a turn started or ended), ``effect`` (a UI hint, such as a file to open) and ``error``.

The session stays open between turns, as the SDK expects for a multi-turn conversation, and
closes after ``idle_close_s`` without a message. Closing is when the SDK's Memory capability
distils the conversation into memory; with a ``UserMemory`` the harness seeds that memory from,
and publishes it back to, the memory of the conversation's owner. Deleting a conversation deletes
its workspace, history and host copies, and it is not remembered; the worker keeps its journal.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import io
import itertools
import json
import logging
import re
import secrets
import shutil
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterator, NamedTuple

from agents import Runner, SQLiteSession, trace
from agents.extensions import ToolOutputTrimmer
from agents.run import RunConfig
from agents.run_error_handlers import RunErrorHandlerResult
from agents.sandbox import SandboxRunConfig
from agents.tracing import gen_trace_id

from agent_mxc import MXCSandboxOptions, WorkerError
from agent_mxc.instrumentation import operation
from agent_mxc.tracing import otel_trace_id, tracing_enabled

from .memory import UserMemory, user_key
from .spec import AgentSpec, Conversation, TurnContext
from .steps import ICONS, clipped, describe_call, describe_output, fenced, headline, step_title
from .uploads import UploadRejected, UploadStore, upload_name

logger = logging.getLogger(__name__)
_MAX_FILES = 40
_FILE_NAME = r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}"
# A turn another process started this recently and never finished is treated as still running there.
_ELSEWHERE_S = 15 * 60
_INTERNAL: dict = {}  # the engine's own store context: it sees every conversation


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(6)}"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def running_elsewhere(metadata: dict, running: set[str], thread_id: str) -> bool:
    """Whether another process is running a turn of this conversation: the queue only covers one process."""
    turns = metadata.get("turns") or []
    if thread_id in running or not turns or turns[-1].get("status") != "running":
        return False
    try:
        started = datetime.fromisoformat(turns[-1]["started_at"])
    except (KeyError, ValueError):
        return False
    return (datetime.now(timezone.utc) - started).total_seconds() < _ELSEWHERE_S


def preferred_file(turn: dict, preferred: str | None = None) -> str | None:
    """The output a UI opens after a turn: a host-checked one first, then the agent's report."""
    changed = [item["path"] for item in turn["files"]
               if item.get("changed") and item["path"].startswith("output/") and not item.get("too_large")]
    status = turn.get("file_status") or {}
    checked = [path for path in changed if (status.get(path) or {}).get("state") == "checked"]
    if checked:
        return preferred if preferred in checked else checked[0]
    if changed:
        return preferred if preferred in changed else changed[0]
    return None


def usage_of(usage) -> dict:
    """A run's token use, for the turn record: what each turn costs and how large its context grows."""
    return {"requests": usage.requests, "input_tokens": usage.input_tokens, "output_tokens": usage.output_tokens,
            "total_tokens": usage.total_tokens,
            "cached_tokens": getattr(usage.input_tokens_details, "cached_tokens", 0) or 0,
            "reasoning_tokens": getattr(usage.output_tokens_details, "reasoning_tokens", 0) or 0,
            # The largest single request: how big the context got.
            "max_input_tokens": max((entry.input_tokens for entry in usage.request_usage_entries), default=0)}


def _added(earlier: dict | None, usage: dict) -> dict:
    """Two runs of a turn's agent loop count together; its largest request is the larger of the two."""
    if not earlier:
        return usage
    return {key: max(earlier[key], usage[key]) if key == "max_input_tokens" else earlier[key] + usage[key]
            for key in usage}


def _requested_by(session, who: str) -> None:
    """Name who the session's next commands are for, in the worker's journal (a person, or the harness itself)."""
    inner = getattr(session, "_inner", session)
    if hasattr(inner, "requester"):
        inner.requester = who


class _Open(NamedTuple):
    """A conversation's sandbox session, open between turns."""
    session: object
    closer: asyncio.Task | None  # closes it once it has been idle
    owner: str | None            # whose memory it draws on and adds to


class TurnError(Exception):
    """A turn failure whose message is safe to show."""

    def __init__(self, message: str, *, retry: bool):
        super().__init__(message)
        self.retry = retry


class Busy(TurnError):
    """Another process is running a turn of the conversation; the message was not answered."""

    def __init__(self):
        super().__init__("A turn of this conversation is running in another window or terminal. "
                         "Wait for it to finish, then send again.", retry=True)


@dataclass
class _Message:
    """A message waiting for its conversation's next turn."""
    entry_id: str
    text: str
    requester: str | None
    attachments: list
    done: asyncio.Future = field(default_factory=lambda: asyncio.get_running_loop().create_future())


class _Steps:
    """The turn's current group of steps: one transcript entry, published each time it changes."""

    def __init__(self, harness: "Harness", thread_id: str, turn: int):
        self.harness, self.thread_id, self.turn = harness, thread_id, turn
        self.entry: dict | None = None
        self.started = 0.0

    async def add(self, title: str, *, icon: str | None = None, detail: str = "", status: str = "running") -> tuple[dict, int]:
        if self.entry is None:
            self.entry = {"id": new_id("wf"), "kind": "steps", "turn": self.turn, "at": _now(), "open": True, "steps": []}
            self.started = time.monotonic()
        self.entry["steps"].append({"title": title, "icon": icon, "detail": detail, "status": status})
        await self.harness.save_entry(self.thread_id, self.entry)
        return self.entry, len(self.entry["steps"]) - 1

    async def update(self, entry: dict, index: int, **fields) -> None:
        entry["steps"][index].update(fields)
        await self.harness.save_entry(self.thread_id, entry)

    async def close(self) -> None:
        """End the group, as a UI's "worked for" summary; the next step starts a new group."""
        if self.entry is not None:
            self.entry["open"] = False
            self.entry["duration_s"] = round(time.monotonic() - self.started)
            await self.harness.save_entry(self.thread_id, self.entry)
            self.entry = None


class Harness:
    """Runs an agent's conversations. ``store`` keeps conversations and transcripts (``SQLiteStore``)."""

    def __init__(self, spec: AgentSpec, store, client, *, model, output_dir: Path, uploads: UploadStore | None = None,
                 model_label: str | None = None, max_turns: int = 25,
                 card: Callable[[Conversation, dict, set[str]], list[dict]] | None = None,
                 file_status: Callable[[Conversation, dict], dict[str, dict]] | None = None,
                 preferred_output: str | None = None, memory: UserMemory | None = None, idle_close_s: float = 300):
        self.spec = spec
        self.store = store
        self.client = client
        self.model = model
        self.model_label = model_label or str(model)
        self.output_dir = Path(output_dir)
        self.uploads = uploads
        self.max_turns = max_turns
        self.card = card
        # path -> {"state": "checked" | "unchecked" | "source", "label": ...}: what the host check covered.
        self.file_status = file_status
        self.preferred_output = preferred_output
        self.history_path = self.output_dir / "history.sqlite3"
        self.running: set[str] = set()
        self._locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
        self.memory = memory
        self.idle_close_s = idle_close_s
        # thread id -> its open sandbox session; a running turn takes its session out.
        self._open: dict[str, _Open] = {}
        # One consolidation at a time per user, so two never overwrite each other's lessons.
        self._memory_locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
        # What a user forgot while their memory may be consolidating: forgotten again once it publishes,
        # since the consolidation started from the memory before.
        self._forgotten: defaultdict[str, set[str]] = defaultdict(set)
        self._cleared: set[str] = set()
        # Each conversation's waiting messages, the task working through them, and who is listening.
        self._queues: defaultdict[str, list[_Message]] = defaultdict(list)
        self._workers: dict[str, asyncio.Task] = {}
        self._listeners: defaultdict[str, set[asyncio.Queue]] = defaultdict(set)
        self._seq = itertools.count(1)

    def conversation(self, thread) -> Conversation:
        return Conversation(thread, self.output_dir / thread.id)

    def history(self, thread_id: str) -> SQLiteSession:
        """The SDK session that holds this conversation's agent history."""
        self.history_path.parent.mkdir(parents=True, exist_ok=True)
        return SQLiteSession(thread_id, self.history_path)

    # ---------- Events ----------

    @contextlib.contextmanager
    def listen(self, thread_id: str) -> Iterator[asyncio.Queue]:
        """A queue of the conversation's events from now on, for as long as the block runs."""
        queue: asyncio.Queue = asyncio.Queue()
        self._listeners[thread_id].add(queue)
        try:
            yield queue
        finally:
            self._listeners[thread_id].discard(queue)
            if not self._listeners[thread_id]:
                del self._listeners[thread_id]

    def publish(self, thread_id: str, event: dict) -> None:
        event = {"seq": next(self._seq), "conversation": thread_id, **event}
        for queue in self._listeners.get(thread_id, ()):
            queue.put_nowait(event)

    async def save_entry(self, thread_id: str, entry: dict) -> None:
        """Add or change a transcript entry, and tell listeners."""
        await self.store.save_entry(thread_id, entry)
        self.publish(thread_id, {"type": "entry", "turn": entry.get("turn"), "entry": entry})

    async def post_card(self, thread_id: str, card: dict, *, turn: int | None = None) -> dict:
        """Add a card to a conversation outside a turn, as the harness itself (an issue's summary, say)."""
        entry = {"id": new_id("card"), "kind": "card", "turn": turn, "at": _now(), "card": card}
        await self.save_entry(thread_id, entry)
        return entry

    # ---------- Messages and turns ----------

    async def send(self, thread_id: str, text: str, *, requester: str | None = None, attachments=(),
                   entry_id: str | None = None) -> asyncio.Future:
        """Queue a message for the conversation and return a future of the turn that answers it.

        The message is added to the transcript unless ``entry_id`` names one already there. Messages
        that arrive while a turn runs are answered together, in one turn, once it ends.
        """
        if entry_id is None:
            entry = {"id": new_id("msg"), "kind": "user", "turn": None, "at": _now(), "text": text,
                     "requested_by": requester}
            await self.save_entry(thread_id, entry)
            entry_id = entry["id"]
        else:
            # Stored by a UI protocol's own path (ChatKit's): other listeners hear of it here.
            entry = await self.store.load_entry(thread_id, entry_id)
            if entry is not None:
                self.publish(thread_id, {"type": "entry", "turn": None, "entry": entry})
        message = _Message(entry_id, text, requester, list(attachments))
        message.done.add_done_callback(_settled)
        self._queues[thread_id].append(message)
        worker = self._workers.get(thread_id)
        if worker is None or worker.done():
            self._workers[thread_id] = asyncio.get_running_loop().create_task(self._work(thread_id))
        return message.done

    def stop(self, thread_id: str) -> bool:
        """Stop the conversation's running turn and drop its waiting messages; returns whether anything stopped."""
        waiting = self._queues.pop(thread_id, [])
        for message in waiting:
            if not message.done.done():
                message.done.cancel()
        worker = self._workers.get(thread_id)
        if worker is not None and not worker.done():
            worker.cancel()
            return True
        return bool(waiting)

    async def _work(self, thread_id: str) -> None:
        try:
            while self._queues.get(thread_id):
                batch, self._queues[thread_id] = self._queues[thread_id], []
                try:
                    turn = await self._turn(thread_id, batch)
                except asyncio.CancelledError:
                    for message in batch:
                        if not message.done.done():
                            message.done.cancel()
                    raise
                except Exception as error:
                    for message in batch:
                        if not message.done.done():
                            message.done.set_exception(error)
                else:
                    for message in batch:
                        if not message.done.done():
                            message.done.set_result(turn)
        finally:
            if self._workers.get(thread_id) is asyncio.current_task():
                del self._workers[thread_id]
            if not self._queues.get(thread_id):
                self._queues.pop(thread_id, None)

    async def _turn(self, thread_id: str, batch: list[_Message]) -> dict:
        messages = [message.entry_id for message in batch]
        text = "\n\n".join(message.text for message in batch)
        requester = batch[-1].requester
        attachments = [item for message in batch for item in message.attachments]
        async with self._locks[thread_id]:
            thread = await self.store.load_thread(thread_id, _INTERNAL)
            if running_elsewhere(thread.metadata, self.running, thread_id):
                error = Busy()
                self.publish(thread_id, {"type": "error", "messages": messages, "message": str(error), "retry": True})
                raise error
            self.running.add(thread_id)
            try:
                return await self._run(thread, text, attachments, requester, messages)
            finally:
                self.running.discard(thread_id)

    async def _run(self, thread, text: str, attachments: list, requester: str | None, messages: list[str]) -> dict:
        conversation = self.conversation(thread)
        meta = thread.metadata
        if not thread.title:
            thread.title = text if len(text) <= 60 else text[:57].rstrip() + "…"
        turns = meta.setdefault("turns", [])
        sdk_trace_id = gen_trace_id()
        traced = tracing_enabled()
        turn = {
            "number": len(turns) + 1, "status": "running", "started_at": _now(),
            "sdk_trace_id": sdk_trace_id if traced else None,
            "otel_trace_id": otel_trace_id(sdk_trace_id) if traced else None,
            "lifecycle": "reopened" if meta.get("sandbox") else "created",
            "model": self.model_label, "tools": [], "files": [], "uploads": [], "check": None,
            "requested_by": requester, "messages": messages,
        }
        turns.append(turn)
        await self.store.save_thread(thread, _INTERNAL)
        for entry_id in messages:
            await self.store.set_entry_turn(thread.id, entry_id, turn["number"])
        self.publish(thread.id, {"type": "turn", "turn": turn["number"], "status": "running", "messages": messages,
                                 "title": thread.title})
        steps = _Steps(self, thread.id, turn["number"])
        started = time.monotonic()
        turn_operation, _ = self.spec.trace_operations
        try:
            with trace(f"{self.spec.name} turn", trace_id=sdk_trace_id, group_id=thread.id, disabled=not traced):
                with operation(turn_operation):
                    await self._run_turn(conversation, turn, text, attachments, steps)
            turn["status"] = "completed"
        except asyncio.CancelledError:
            turn["status"] = "stopped"
            raise
        except Exception as error:
            turn["status"] = "failed"
            turn["error"] = type(error).__name__
            if isinstance(error, UploadRejected):
                failure = TurnError(str(error), retry=False)
            elif isinstance(error, TurnError):
                logger.warning("Turn %s of %s failed: %s", turn["number"], thread.id, error)
                failure = error
            else:
                logger.exception("Turn %s of %s failed", turn["number"], thread.id)
                # Exception text can contain command output; listeners get the type only.
                failure = TurnError(f"The turn failed ({type(error).__name__}); the server log has the cause. "
                                    "You can retry.", retry=True)
            self.publish(thread.id, {"type": "error", "turn": turn["number"], "messages": messages,
                                     "message": str(failure), "retry": failure.retry})
            raise failure from error
        finally:
            await _quietly(steps.close(), "closing the turn's steps")
            turn["duration_s"] = round(time.monotonic() - started, 1)
            await self.store.save_thread(thread, _INTERNAL)
            self.publish(thread.id, {"type": "turn", "turn": turn["number"], "status": turn["status"],
                                     "messages": messages})
        await self.save_entry(thread.id, {"id": new_id("card"), "kind": "card", "turn": turn["number"], "at": _now(),
                                          "card": self._turn_card(conversation, turn)})
        preferred = preferred_file(turn, self.preferred_output)
        if preferred:
            self.publish(thread.id, {"type": "effect", "turn": turn["number"], "name": "open_file",
                                     "data": {"thread_id": thread.id, "turn": turn["number"], "path": preferred}})
        self.publish(thread.id, {"type": "turn", "turn": turn["number"], "status": "shown", "messages": messages})
        return turn

    async def _run_turn(self, conversation: Conversation, turn: dict, text: str, attachments: list, steps: _Steps):
        thread, meta = conversation.thread, conversation.metadata
        requester = turn["requested_by"] or "guest"
        opened = self._open.pop(thread.id, None)
        if opened is not None:
            session, closer, _ = opened
            if closer is not None:
                closer.cancel()
            _requested_by(session, requester)
            turn["lifecycle"] = "continued"
            turn["start_s"] = 0.0
            await steps.add("Continued in the open workspace", status="done",
                            detail=f"Same session `{meta['workspace']}`, still open from the last turn.")
            try:
                await self._continue_turn(conversation, turn, text, attachments, session, steps)
            finally:
                self._park(thread.id, session, meta.get("owner"))
            return
        created = meta.get("sandbox") is None
        entry, index = await steps.add("Creating the workspace" if created else "Reopening the workspace")
        began = time.monotonic()
        if created:
            workspace_id = self.client.new_workspace_id()
            manifest = self.spec.start(conversation, bool(attachments), self.client.workspace_root(workspace_id))
            session = await self.client.create(manifest=manifest, options=MXCSandboxOptions(workspace_id=workspace_id))
            # Save immediately: a failed first turn must still be deletable.
            meta["sandbox"] = self.client.serialize_session_state(session.state)
            meta["workspace"] = f"{self.client.worker}/{workspace_id}"
            await self.store.save_thread(thread, _INTERNAL)
        else:
            session = await self.client.resume(self.client.deserialize_session_state(meta["sandbox"]))
        _requested_by(session, requester)
        workspace = meta["workspace"]
        try:
            await session.start()
        except WorkerError as error:
            raise TurnError(f"The sandbox worker {self.client.worker} is unavailable ({error.code.name}). "
                            "Retry when it is back.", retry=True) from error
        try:
            if created:
                boundary = await session.exec('test -z "${OPENAI_API_KEY:-}"')
                if not boundary.ok():
                    raise RuntimeError("The sandbox must not contain the harness API key")
            remembered = await self.memory.for_user(meta.get("owner")).seed(session) if self.memory is not None else 0
            seconds = time.monotonic() - began
            turn["start_s"] = round(seconds, 1)
            verb = "Created" if created else "Reopened"
            detail = (f"Session `{workspace}`." if created
                      else f"Session `{workspace}`, with the earlier turns' files.")
            if remembered:
                detail += f" Seeded with the agent's memory from earlier conversations ({remembered} files)."
            await steps.update(entry, index, title=f"{verb} the workspace · {seconds:.1f} s", detail=detail,
                               status="done")
            await self._continue_turn(conversation, turn, text, attachments, session, steps)
        finally:
            self._park(thread.id, session, meta.get("owner"))

    async def _continue_turn(self, conversation: Conversation, turn: dict, text: str, attachments: list, session,
                             steps: _Steps):
        """The turn itself, in an open session: uploads, the agent loop, evidence, outputs and the check."""
        thread, meta = conversation.thread, conversation.metadata
        if attachments:
            noun = "upload" if len(attachments) == 1 else "uploads"
            entry, index = await steps.add(f"Copying {len(attachments)} {noun} into the workspace")
            added = await self._store_uploads(session, conversation, turn, attachments)
            described = [(item, self._describe_upload(item)) for item in added]
            listing = "\n".join(f"{item['path']}  {item['bytes']} bytes  sha256 {item['sha256'][:12]}…"
                                + (f"  {summary}" if summary else "") for item, summary in described)
            await steps.update(entry, index, title=f"Copied {len(added)} {noun} to inputs/uploads/",
                               detail=fenced(listing), status="done")
            # Show what the sandbox made of the first upload while the model reads it.
            self.publish(thread.id, {"type": "effect", "turn": turn["number"], "name": "open_file",
                                     "data": {"thread_id": thread.id, "turn": turn["number"], "path": added[0]["path"]}})
            text += "\n\n[Uploaded to the workspace this turn: " + ", ".join(
                f"{item['path']} ({item['bytes']} bytes" + (f"; {summary}" if summary else "") + ")"
                for item, summary in described) + "]"

        harness_tools = list(self.spec.tools(TurnContext(conversation, turn, session)))
        agent = self.spec.build_agent(session.state.manifest, self.model)
        extra = self.spec.instructions(conversation)
        agent = agent.clone(instructions=agent.instructions + ("\n\n" + extra if extra else ""),
                            tools=[*agent.tools, *harness_tools])
        await self._run_agent(thread.id, turn, agent, text, session, steps, harness_tools)
        await steps.close()
        await self._collect_evidence(session, conversation, turn)
        files = await self._collect(session, conversation, turn)
        _, check_operation = self.spec.trace_operations
        with operation(check_operation):
            turn["check"] = self.spec.check(conversation, turn, files)
        correction = self.spec.retry_check(turn["check"]) if turn["check"] and not turn.get("step_limit") else None
        if correction:
            # Once: the agent re-reads its sources and corrects what the check could not find.
            turn["check_first"] = turn["check"]
            await steps.add("The host check failed: " + str(turn["check"].get("detail") or "see the findings"),
                            status="failed", detail=fenced(correction))
            await self._run_agent(thread.id, turn, agent, correction, session, steps, harness_tools)
            await steps.close()
            await self._collect_evidence(session, conversation, turn)
            files = await self._collect(session, conversation, turn, again=True)
            with operation(check_operation):
                turn["check"] = self.spec.check(conversation, turn, files)
        if self.file_status is not None:
            turn["file_status"] = self.file_status(conversation, turn)
        meta["sandbox"] = self.client.serialize_session_state(session.state)

    async def _run_agent(self, thread_id: str, turn: dict, agent, text: str, session, steps: _Steps,
                         harness_tools: list) -> None:
        """One run of the agent loop in the turn, with the conversation's history; a failed run leaves none of itself."""
        history = self.history(thread_id)
        kept = len(await history.get_items())
        out_of_turns: list[str] = []

        def step_limit(data) -> RunErrorHandlerResult:
            # Keep the turn and its evidence instead of failing it: the next message can pick up from here.
            message = (f"I reached this turn's limit of {self.max_turns} model steps before finishing. The evidence "
                       "I gathered is saved in the workspace; ask me to continue and I'll pick up from it.")
            out_of_turns.append(message)
            return RunErrorHandlerResult(final_output=message, include_in_history=True)

        try:
            result = Runner.run_streamed(
                agent, text, session=history, max_turns=self.max_turns, error_handlers={"max_turns": step_limit},
                run_config=RunConfig(sandbox=SandboxRunConfig(session=session), tracing_disabled=not tracing_enabled(),
                                     trace_include_sensitive_data=False,
                                     # Earlier turns' tool output is kept as a preview: the files it came from
                                     # stay in the workspace, so the agent can reread what it needs.
                                     call_model_input_filter=ToolOutputTrimmer(max_output_chars=1000,
                                                                               preview_chars=300),
                                     # A misspelled tool name is the model's mistake to correct, not a failed turn.
                                     tool_not_found_behavior="return_error_to_model"))
            try:
                await self._stream(thread_id, turn, result, steps, frozenset(tool.name for tool in harness_tools))
            finally:
                turn["usage"] = _added(turn.get("usage"), usage_of(result.context_wrapper.usage))
            if out_of_turns:
                turn["step_limit"] = True
                await steps.close()
                await self.save_entry(thread_id, {"id": new_id("msg"), "kind": "assistant", "turn": turn["number"],
                                                  "at": _now(), "text": out_of_turns[0]})
        except BaseException:
            # The SDK saves items as the run goes; a failed turn must not leave half of itself in the history.
            while len(await history.get_items()) > kept:
                await history.pop_item()
            raise
        finally:
            history.close()

    async def _stream(self, thread_id: str, turn: dict, result, steps: _Steps, harness_tools: frozenset[str]) -> None:
        """Turn the run's stream into steps, streamed text and the agent's messages.

        Tool calls can run in parallel, so each output goes back to its own call's step. Reasoning is not
        shown: what the agent says is its messages.
        """
        pending: dict[str, tuple[dict, int, str, str, str, dict]] = {}
        streaming: set[str] = set()
        async for event in result.stream_events():
            kind = getattr(event, "type", None)
            if kind == "run_item_stream_event" and event.name == "tool_called":
                name, call_id, arguments = describe_call(event.item.raw_item)
                where = "harness" if name in harness_tools else "sandbox"
                summary = headline(name, event.item.raw_item)
                entry, index = await steps.add(step_title(name, where, summary=summary), icon=ICONS[where],
                                               detail=fenced(clipped(arguments)))
                record = {"tool": name, "status": "running", "where": where, "summary": summary}
                turn["tools"].append(record)
                pending[call_id] = (entry, index, name, where, summary, record)
            elif kind == "run_item_stream_event" and event.name == "tool_output":
                call_id = getattr(event.item.raw_item, "call_id", None) or (
                    event.item.raw_item.get("call_id") if isinstance(event.item.raw_item, dict) else "") or ""
                if call_id in pending:
                    entry, index, name, where, summary, record = pending.pop(call_id)
                    status, text = describe_output(event.item.output)
                    detail = entry["steps"][index]["detail"]
                    if text:
                        detail += "\n\n" + fenced(clipped(text))
                    await steps.update(entry, index, title=step_title(name, where, status, summary), detail=detail,
                                       status="failed" if status and status != "exit 0" else "done")
                    record["status"] = status or "done"
            elif kind == "raw_response_event":
                data = event.data
                if data.type == "response.output_item.added" and getattr(data.item, "type", None) == "message":
                    # The agent speaks: the steps before it are one group, as a "worked for" summary.
                    await steps.close()
                    streaming.add(data.item.id)
                elif data.type == "response.output_text.delta" and data.item_id in streaming:
                    self.publish(thread_id, {"type": "delta", "turn": turn["number"], "id": data.item_id,
                                             "delta": data.delta})
                elif data.type == "response.output_item.done" and getattr(data.item, "type", None) == "message":
                    streaming.discard(data.item.id)
                    text = "".join(getattr(part, "text", "") or "" for part in data.item.content or [])
                    if text:
                        await self.save_entry(thread_id, {"id": data.item.id, "kind": "assistant",
                                                          "turn": turn["number"], "at": _now(), "text": text})

    async def _collect_evidence(self, session, conversation: Conversation, turn: dict) -> None:
        """Copy the cluster reads the worker recorded this turn from its journal, which no container can edit."""
        evidence = conversation.metadata.setdefault("evidence", [])
        after = max((entry.get("seq", 0) for entry in evidence), default=0)
        destination = conversation.turn_dir(turn["number"])
        for entry in await session._inner.evidence(after):
            data = await session._inner.read_evidence(entry["seq"])
            if hashlib.sha256(data).hexdigest() != entry["sha256"]:
                raise RuntimeError(f"Evidence {entry['seq']} does not match the worker's journal")
            path = entry["path"]
            if not re.fullmatch(r"evidence/[0-9]{3,}-[a-z0-9.-]+\.txt", path):
                raise RuntimeError(f"The worker named evidence {entry['seq']} {path!r}")
            target = destination / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            evidence.append({"seq": entry["seq"], "path": path, "label": entry["command"], "turn": turn["number"],
                             "bytes": len(data), "sha256": entry["sha256"], "recorded_at": entry.get("recorded_at")})
            turn["files"].append({"path": path, "bytes": len(data), "sha256": entry["sha256"], "new": True,
                                  "changed": True, "evidence": True, "command": entry["command"],
                                  "recorded_at": entry.get("recorded_at")})

    def _describe_upload(self, entry: dict) -> str:
        processors = self.spec.uploads.processors if self.spec.uploads else {}
        return "; ".join(processor.describe(entry[processor.key], entry)
                         for processor in processors.values() if processor.key in entry)

    async def _store_uploads(self, session, conversation: Conversation, turn: dict, attachments: list) -> list[dict]:
        """Stage new uploads once; retries restore the original bytes under the same name."""
        policy = self.uploads.policy()
        uploads = conversation.metadata.setdefault("uploads", [])
        by_id = {item["attachment_id"]: item for item in uploads if item.get("attachment_id")}
        taken = {item["name"] for item in uploads}
        destination = conversation.turn_dir(turn["number"])
        added = []
        for attachment in attachments:
            entry = by_id.get(attachment.id)
            is_new = entry is None
            if is_new:
                data = self.uploads.read_file(attachment.id)
                name = upload_name(attachment.name, policy)
                stem, extension = Path(name).stem, Path(name).suffix
                counter = 2
                while name in taken:
                    name, counter = f"{stem}-{counter}{extension}", counter + 1
                taken.add(name)
                entry = {"attachment_id": attachment.id, "name": name, "path": f"inputs/uploads/{name}",
                         "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "turn": turn["number"]}
            else:
                try:
                    data = conversation.host_copy(entry).read_bytes()
                except FileNotFoundError:
                    raise UploadRejected("The retained upload is unavailable; attach the file again.") from None
                if len(data) != entry["bytes"] or hashlib.sha256(data).hexdigest() != entry["sha256"]:
                    raise UploadRejected("The retained upload changed; attach the file again.")
            await session.write(Path(entry["path"]), io.BytesIO(data))
            target = destination / entry["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            processor = policy.processors.get(Path(entry["name"]).suffix)
            if processor is not None:
                entry[processor.key] = await processor.run(session, conversation, entry)
            if is_new:
                uploads.append(entry)
                by_id[attachment.id] = entry
            added.append(entry)
            turn["uploads"].append(entry["name"])
            turn["files"].append({"path": entry["path"], "bytes": entry["bytes"], "sha256": entry["sha256"],
                                  "new": is_new, "changed": is_new, "upload": True,
                                  **({processor.key: entry[processor.key]} if processor else {})})
        listing = {"files": []}
        for item in uploads:
            processor = policy.processors.get(Path(item["name"]).suffix)
            info = {processor.key: processor.listing(item[processor.key], item)} if processor and processor.key in item else {}
            listing["files"].append({**{key: item[key] for key in ("name", "bytes", "sha256")}, **info})
        await session.write(Path("inputs/uploads/MANIFEST.json"), io.BytesIO(json.dumps(listing, indent=2).encode()))
        # Persist the attachment-to-host-copy mapping before removing temporary bytes.
        await self.store.save_thread(conversation.thread, _INTERNAL)
        for attachment in attachments:
            await self.uploads.delete_attachment(attachment.id, {})
        return added

    async def _collect(self, session, conversation: Conversation, turn: dict, *, again: bool = False) -> dict[str, bytes]:
        """Copy the agent's output folders to the host while the sandbox is still running; ``again`` replaces the
        turn's earlier copies, after a corrective pass."""
        folders = self.spec.collect
        listing = await session.exec("find", *folders, "-maxdepth", "1", "-type", "f", shell=False)
        # Names come from the sandbox: accept only plain file names in the agent's folders.
        pattern = re.compile(f"({'|'.join(map(re.escape, folders))})/{_FILE_NAME}")
        names = sorted({line for line in listing.stdout.decode(errors="replace").splitlines() if pattern.fullmatch(line)})
        previous = {item["path"]: item.get("sha256") for earlier in conversation.metadata["turns"][:-1]
                    for item in earlier["files"]}
        destination = conversation.turn_dir(turn["number"])
        if again:
            turn["files"] = [item for item in turn["files"] if item.get("evidence") or item.get("upload")]
        collected = {}
        for name in names[:_MAX_FILES]:
            try:
                with await session.read(Path(name)) as handle:
                    data = handle.read()
            except ValueError:
                turn["files"].append({"path": name, "too_large": True, "changed": True})
                continue
            digest = hashlib.sha256(data).hexdigest()
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            collected[name] = data
            turn["files"].append({"path": name, "bytes": len(data), "sha256": digest,
                                  "new": name not in previous, "changed": previous.get(name) != digest})
        return collected

    def _turn_card(self, conversation: Conversation, turn: dict) -> dict:
        """The card after a turn: what the host checked, the files it changed and what it took."""
        thread = conversation.thread
        changed = {item["path"] for item in turn["files"] if item.get("changed")}
        children = []
        if turn["uploads"]:
            children.append({"type": "Text", "size": "sm", "value": "Uploaded to inputs/uploads/: " + ", ".join(turn["uploads"])})
        rows = self.card(conversation, turn, changed) if self.card is not None else []
        if (not any(_has_badge(row) for row in rows) and turn["status"] == "completed"
                and any(path.startswith("output/") for path in changed)):
            # Outputs the host did not check say so; a turn that only answered in chat needs no badge.
            rows.append({"type": "Row", "children": [{"type": "Badge", "variant": "soft", "color": "warning",
                         "label": "Not checked on the host"}]})
        children += rows
        buttons = [
            {"type": "Button", "label": item["path"].removeprefix("output/"), "style": "secondary", "size": "sm",
             "onClickAction": {"type": "open_file", "handler": "client",
                               "payload": {"thread_id": thread.id, "turn": turn["number"], "path": item["path"]}}}
            for item in turn["files"] if item.get("changed") and item["path"].startswith("output/") and not item.get("too_large")
        ][:4]
        if turn.get("otel_trace_id"):
            buttons.append({"type": "Button", "label": "View trace", "style": "secondary", "size": "sm", "iconStart": "chart",
                            "onClickAction": {"type": "open_trace", "handler": "client",
                                              "payload": {"thread_id": thread.id, "turn": turn["number"]}}})
        if buttons:
            children.append({"type": "Row", "gap": 2, "wrap": "wrap", "children": buttons})
        tools = len(turn["tools"])
        caption = f"Turn {turn['number']} · {turn['duration_s']} s · {tools} step{'s' if tools != 1 else ''}"
        tokens = (turn.get("usage") or {}).get("total_tokens", 0)
        if tokens:
            caption += f" · {tokens / 1000:.0f}k tokens" if tokens >= 1000 else f" · {tokens} tokens"
        children.append({"type": "Caption", "size": "sm", "value": caption})
        return {"type": "Card", "size": "full", "children": children}

    # ---------- Sessions and memory ----------

    def _park(self, thread_id: str, session, owner: str | None) -> None:
        """Keep a conversation's session open after its turn, and close it once it has been idle."""
        closer = asyncio.get_running_loop().create_task(self._close_when_idle(thread_id))
        self._open[thread_id] = _Open(session, closer, owner)

    async def _close_when_idle(self, thread_id: str) -> None:
        await asyncio.sleep(self.idle_close_s)
        async with self._locks[thread_id]:
            opened = self._open.get(thread_id)
            if opened is None or opened.closer is not asyncio.current_task():
                return  # a turn took the session meanwhile
            del self._open[thread_id]
            await self._close(thread_id, opened, f"after {self.idle_close_s:.0f} s idle")

    async def _close(self, thread_id: str, opened: _Open, why: str) -> None:
        """Close a session; with memory, the SDK's memory generation runs here and its result is published."""
        session = opened.session
        _requested_by(session, "harness")
        if self.memory is None:
            await _quietly(session.aclose(), f"closing {thread_id}")
            return
        key = user_key(opened.owner)
        store = self.memory.for_user(opened.owner)
        async with self._memory_locks[key]:
            began = time.monotonic()
            self._cleared.discard(key)  # this close starts from the memory as it is now
            # Consolidate on top of what the user's other conversations published since this one opened. Without
            # that, publishing could drop their lessons, so a failed seed closes the session without publishing.
            if await _quietly(store.seed(session), f"seeding memory for {thread_id}") is False:
                await _quietly(session.aclose(), f"closing {thread_id}")
                return
            if await _quietly(session.aclose(), f"generating memory for {thread_id}") is False:
                return
            files = await _quietly(store.publish(session), f"publishing memory from {thread_id}")
            if key in self._cleared:
                self._cleared.discard(key)
                store.clear()
                files = 0
            for conversation in self._forgotten.pop(key, ()):
                store.forget(conversation)
            logger.info("Closed %s %s; %s's memory has %s files (%.1f s)", thread_id, why, key, files,
                        time.monotonic() - began)

    async def close_all(self) -> None:
        """Stop every turn and close every open session now, as an idle close would (tests and shutdown)."""
        for thread_id in list(self._workers):
            self.stop(thread_id)
        for worker in list(self._workers.values()):
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await worker
        for thread_id in list(self._open):
            async with self._locks[thread_id]:
                opened = self._open.pop(thread_id, None)
                if opened is None:
                    continue
                if opened.closer is not None:
                    opened.closer.cancel()
                await self._close(thread_id, opened, "on shutdown")

    async def delete_workspace(self, thread_id: str) -> None:
        """Delete the workspace on the worker, the history, then the host copies. The worker keeps its journal.

        A deleted conversation is not remembered: its open session is deleted without closing, so the SDK
        generates no memory from it, and what memory already holds from it is forgotten.
        """
        worker = self._workers.get(thread_id)
        if self.stop(thread_id) and worker is not None:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await worker
        thread = await self.store.load_thread(thread_id, _INTERNAL)
        state = thread.metadata.get("sandbox")
        owner = thread.metadata.get("owner")
        async with self._locks[thread_id]:
            opened = self._open.pop(thread_id, None)
            if opened is not None and opened.closer is not None:
                opened.closer.cancel()
            if opened is not None:
                await self.client.delete(opened.session)
            elif state is not None:
                # A workspace that is already gone is not an error: the worker reports it and moves on.
                session = await self.client.resume(self.client.deserialize_session_state(state))
                await self.client.delete(session)
            history = self.history(thread_id)
            try:
                await history.clear_session()
            finally:
                history.close()
            shutil.rmtree(self.output_dir / thread_id, ignore_errors=True)
            self.forget_memory(owner, thread_id)

    def forget_memory(self, user: str | None, conversation: str | None = None) -> bool:
        """Forget one conversation from a user's memory, or with none named, everything they remember;
        returns whether there was anything to forget.

        It is forgotten now, and again after a consolidation of the user's memory that is running, which
        would otherwise publish the memory it started from.
        """
        if self.memory is None:
            return False
        key = user_key(user)
        store = self.memory.for_user(user)
        if conversation is None:
            held = bool(store.files())
            self._cleared.add(key)
            store.clear()
            return held
        self._forgotten[key].add(conversation)
        return store.forget(conversation)


async def _quietly(awaitable, what: str):
    """Best effort: log a failure and carry on. Returns the result, or False on failure."""
    try:
        result = await awaitable
        return True if result is None else result
    except Exception:
        logger.exception("Failed %s", what)
        return False


def _settled(done: asyncio.Future) -> None:
    """A turn's outcome reaches whoever waits for it; with no one waiting, its failure is in the log already."""
    if not done.cancelled():
        done.exception()


def _has_badge(node: dict) -> bool:
    return node.get("type") == "Badge" or any(_has_badge(child) for child in node.get("children") or [])
