# Copyright 2026 openai-agent-substrate contributors
# SPDX-License-Identifier: Apache-2.0
"""ChatKit server for any agent: one thread is one conversation backed by one MXC sandbox session.

Each message takes the conversation's lock and reloads the thread, refuses to start
while another process is running a turn of it, continues the conversation's open
sandbox session or opens it (creating the workspace on its MXC sandbox worker the first
time), copies uploads into it, runs the agent loop with the conversation's SDK session
history (every command in a fresh MXC container), fetches the cluster reads the worker
recorded as evidence, copies the agent's output folders to the host and runs the
agent's host check.

The session stays open between turns, as the SDK expects for a multi-turn
conversation, and closes after ``idle_close_s`` without a message. Closing is when the
SDK's Memory capability distils the conversation into memory; with a ``MemoryStore``
the harness seeds that memory from, and publishes it back to, the agent's memory
across conversations. Deleting the thread deletes the workspace, the history and the
host copies without generating memory; the worker keeps its audit journal.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import io
import json
import logging
import re
import shutil
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from agents import Runner, SQLiteSession, trace
from agents.run import RunConfig
from agents.run_error_handlers import RunErrorHandlerResult
from agents.sandbox import SandboxRunConfig
from agents.tracing import gen_trace_id
from chatkit.agents import AgentContext, stream_agent_response
from chatkit.errors import CustomStreamError
from chatkit.server import ChatKitServer
from chatkit.store import NotFoundError
from chatkit.types import (
    AssistantMessageContent, AssistantMessageItem, ClientEffectEvent, CustomTask, ThreadItemAddedEvent,
    ThreadItemDoneEvent, ThreadItemUpdatedEvent, ThreadMetadata,
    UserMessageItem, WidgetItem, Workflow, WorkflowItem, WorkflowTaskAdded, WorkflowTaskUpdated,
)
from chatkit.widgets import DynamicWidgetRoot

from agent_mxc import MXCSandboxOptions, WorkerError
from agent_mxc.instrumentation import operation
from agent_mxc.tracing import otel_trace_id, tracing_enabled

from .memory import MemoryStore
from .spec import AgentSpec, Conversation, TurnContext
from .steps import ToolSteps, fenced, user_text
from .uploads import UploadRejected, UploadStore, upload_name

logger = logging.getLogger(__name__)
_MAX_FILES = 40
_FILE_NAME = r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}"
# A turn another process started this recently and never finished is treated as still running there.
_ELSEWHERE_S = 15 * 60


def running_elsewhere(metadata: dict, running: set[str], thread_id: str) -> bool:
    """Whether another process is running a turn of this conversation: the lock only covers one process."""
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


class TurnError(Exception):
    """A turn failure whose message is safe to show."""

    def __init__(self, message: str, *, retry: bool):
        super().__init__(message)
        self.retry = retry


class HarnessChatServer(ChatKitServer[dict]):
    def __init__(self, spec: AgentSpec, store, client, *, model, output_dir: Path,
                 base_url: str = "http://localhost:8000", model_label: str | None = None, max_turns: int = 25,
                 card: Callable[[Conversation, dict, set[str]], list[dict]] | None = None,
                 file_status: Callable[[Conversation, dict], dict[str, dict]] | None = None,
                 preferred_output: str | None = None, memory: MemoryStore | None = None, idle_close_s: float = 300):
        self.spec = spec
        self.output_dir = Path(output_dir)
        self.uploads = UploadStore(store, self.output_dir / ".staged", base_url, spec.uploads)
        super().__init__(store, attachment_store=self.uploads)
        store.on_delete_thread = self.delete_workspace
        self.client = client
        self.model = model
        self.model_label = model_label or str(model)
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
        # thread id -> (open sandbox session, its idle-close task); a running turn takes its session out.
        self._open: dict[str, tuple[object, asyncio.Task | None]] = {}
        self._memory_lock = asyncio.Lock()

    def conversation(self, thread: ThreadMetadata) -> Conversation:
        return Conversation(thread, self.output_dir / thread.id)

    def history(self, thread_id: str) -> SQLiteSession:
        """The SDK session that holds this conversation's agent history."""
        self.history_path.parent.mkdir(parents=True, exist_ok=True)
        return SQLiteSession(thread_id, self.history_path)

    async def respond(self, thread: ThreadMetadata, input_user_message: UserMessageItem | None, context: dict):
        if input_user_message is None:
            return
        text = user_text(input_user_message)
        attachments = list(input_user_message.attachments)
        limit = self.spec.uploads.max_count if self.spec.uploads else 0
        if len(attachments) > limit:
            message = f"Attach at most {limit} files per message." if limit else "This agent does not accept uploads."
            raise CustomStreamError(message, allow_retry=False)
        if not text and not attachments:
            raise CustomStreamError("Type a question to send.", allow_retry=False)
        text = text or self.spec.default_question
        async with self._locks[thread.id]:
            # ChatKit loaded this thread before the lock: a turn that finished meanwhile must not be overwritten.
            with contextlib.suppress(NotFoundError):
                fresh = await self.store.load_thread(thread.id, context)
                thread.metadata, thread.title = fresh.metadata, fresh.title
            if running_elsewhere(thread.metadata, self.running, thread.id):
                # ChatKit stored the message before calling us; a refused one must not stay without a reply.
                with contextlib.suppress(NotFoundError):
                    await self.store.delete_thread_item(thread.id, input_user_message.id, context)
                raise CustomStreamError("A turn of this conversation is running in another window or terminal. "
                                        "Wait for it to finish, then send again.", allow_retry=True)
            self.running.add(thread.id)
            try:
                async for event in self._turn(thread, text, attachments, context):
                    yield event
            finally:
                self.running.discard(thread.id)

    async def _turn(self, thread: ThreadMetadata, text: str, attachments: list, context: dict):
        conversation = self.conversation(thread)
        meta = thread.metadata
        if not thread.title:
            thread.title = text if len(text) <= 60 else text[:57].rstrip() + "…"
        turns = meta.setdefault("turns", [])
        sdk_trace_id = gen_trace_id()
        traced = tracing_enabled()
        turn = {
            "number": len(turns) + 1, "status": "running", "started_at": datetime.now(timezone.utc).isoformat(),
            "sdk_trace_id": sdk_trace_id if traced else None,
            "otel_trace_id": otel_trace_id(sdk_trace_id) if traced else None,
            "lifecycle": "reopened" if meta.get("sandbox") else "created",
            "model": self.model_label, "tools": [], "files": [], "uploads": [], "check": None,
        }
        turns.append(turn)
        await self.store.save_thread(thread, context)
        context_ = AgentContext(thread=thread, store=self.store, request_context=context)
        started = time.monotonic()
        turn_operation, _ = self.spec.trace_operations
        try:
            with trace(f"{self.spec.name} turn", trace_id=sdk_trace_id, group_id=thread.id, disabled=not traced):
                with operation(turn_operation):
                    async for event in self._run_turn(conversation, context_, turn, text, attachments):
                        yield event
            turn["status"] = "completed"
        except asyncio.CancelledError:
            turn["status"] = "stopped"
            raise
        except Exception as error:
            turn["status"] = "failed"
            turn["error"] = type(error).__name__
            if context_.workflow_item is not None:
                yield ThreadItemDoneEvent(item=context_.workflow_item)
                context_.workflow_item = None
            if isinstance(error, UploadRejected):
                raise CustomStreamError(str(error), allow_retry=False) from error
            if isinstance(error, TurnError):
                logger.warning("Turn %s of %s failed: %s", turn["number"], thread.id, error)
                raise CustomStreamError(str(error), allow_retry=error.retry) from error
            logger.exception("Turn %s of %s failed", turn["number"], thread.id)
            # Exception text can contain command output; the browser gets the type only.
            raise CustomStreamError(f"The turn failed ({type(error).__name__}); the server log has the cause. "
                                    "You can retry.", allow_retry=True) from error
        finally:
            turn["duration_s"] = round(time.monotonic() - started, 1)
            await self.store.save_thread(thread, context)
        yield self._turn_card(conversation, context, turn)
        preferred = preferred_file(turn, self.preferred_output)
        if preferred:
            yield ClientEffectEvent(name="open_file", data={"thread_id": thread.id, "turn": turn["number"], "path": preferred})

    async def _run_turn(self, conversation: Conversation, context_: AgentContext, turn: dict, text: str, attachments: list):
        thread, meta = conversation.thread, conversation.metadata
        opened = self._open.pop(thread.id, None)
        if opened is not None:
            session, closer = opened
            if closer is not None:
                closer.cancel()
            turn["lifecycle"] = "continued"
            try:
                async for event in self._continue_turn(conversation, context_, turn, text, attachments, session):
                    yield event
            finally:
                self._park(thread.id, session)
            return
        created = meta.get("sandbox") is None
        step = CustomTask(title="Creating the workspace" if created else "Reopening the workspace", status_indicator="loading")
        workflow = WorkflowItem(id=context_.generate_id("workflow"), created_at=datetime.now(), thread_id=thread.id,
                                workflow=Workflow(type="custom", tasks=[step], expanded=True))
        context_.workflow_item = workflow
        yield ThreadItemAddedEvent(item=workflow)

        began = time.monotonic()
        if created:
            workspace_id = self.client.new_workspace_id()
            manifest = self.spec.start(conversation, bool(attachments), self.client.workspace_root(workspace_id))
            session = await self.client.create(manifest=manifest, options=MXCSandboxOptions(workspace_id=workspace_id))
            # Save immediately: a failed first turn must still be deletable.
            meta["sandbox"] = self.client.serialize_session_state(session.state)
            meta["workspace"] = f"{self.client.worker}/{workspace_id}"
            await self.store.save_thread(thread, context_.request_context)
        else:
            session = await self.client.resume(self.client.deserialize_session_state(meta["sandbox"]))
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
            remembered = await self.memory.seed(session) if self.memory is not None else 0
            seconds = time.monotonic() - began
            turn["start_s"] = round(seconds, 1)
            verb = "Created" if created else "Reopened"
            detail = (f"Session `{workspace}`: a workspace on the worker's volume. Every command runs in its own "
                      "Microsoft eXecution Container that sees only this workspace." if created
                      else f"Same session `{workspace}`; its workspace still holds the earlier turns' files.")
            if remembered:
                detail += f" Seeded with the agent's memory from earlier conversations ({remembered} files)."
            step = CustomTask(title=f"{verb} the workspace · {seconds:.1f} s", content=detail, status_indicator="complete")
            workflow.workflow.tasks[0] = step
            yield ThreadItemUpdatedEvent(item_id=workflow.id, update=WorkflowTaskUpdated(task=step, task_index=0))
            async for event in self._continue_turn(conversation, context_, turn, text, attachments, session, workflow):
                yield event
        finally:
            self._park(thread.id, session)

    async def _continue_turn(self, conversation: Conversation, context_: AgentContext, turn: dict, text: str,
                             attachments: list, session, workflow: WorkflowItem | None = None):
        """The turn itself, in an open session: uploads, the agent loop, evidence, outputs and the check."""
        thread, meta = conversation.thread, conversation.metadata
        if workflow is None:
            step = CustomTask(title="Continued in the open workspace", status_indicator="complete",
                              content=f"Same session `{meta['workspace']}`, still open from the last turn.")
            workflow = WorkflowItem(id=context_.generate_id("workflow"), created_at=datetime.now(), thread_id=thread.id,
                                    workflow=Workflow(type="custom", tasks=[step], expanded=True))
            context_.workflow_item = workflow
            yield ThreadItemAddedEvent(item=workflow)
            turn["start_s"] = 0.0
        if attachments:
            noun = "upload" if len(attachments) == 1 else "uploads"
            copying = CustomTask(title=f"Copying {len(attachments)} {noun} into the workspace", status_indicator="loading")
            workflow.workflow.tasks.append(copying)
            index = len(workflow.workflow.tasks) - 1
            yield ThreadItemUpdatedEvent(item_id=workflow.id, update=WorkflowTaskAdded(task=copying, task_index=index))
            added = await self._store_uploads(session, conversation, turn, attachments, context_.request_context)
            described = [(item, self._describe_upload(item)) for item in added]
            listing = "\n".join(f"{item['path']}  {item['bytes']} bytes  sha256 {item['sha256'][:12]}…"
                                + (f"  {summary}" if summary else "") for item, summary in described)
            copied = CustomTask(title=f"Copied {len(added)} {noun} to inputs/uploads/", content=fenced(listing),
                                status_indicator="complete")
            workflow.workflow.tasks[index] = copied
            yield ThreadItemUpdatedEvent(item_id=workflow.id, update=WorkflowTaskUpdated(task=copied, task_index=index))
            # Show what the sandbox made of the first upload while the model reads it.
            yield ClientEffectEvent(name="open_file", data={"thread_id": thread.id, "turn": turn["number"],
                                                            "path": added[0]["path"]})
            text += "\n\n[Uploaded to the workspace this turn: " + ", ".join(
                f"{item['path']} ({item['bytes']} bytes" + (f"; {summary}" if summary else "") + ")"
                for item, summary in described) + "]"

        harness_tools = list(self.spec.tools(TurnContext(conversation, turn, session)))
        agent = self.spec.build_agent(session.state.manifest, self.model)
        extra = self.spec.instructions(conversation)
        agent = agent.clone(instructions=agent.instructions + ("\n\n" + extra if extra else ""),
                            tools=[*agent.tools, *harness_tools])
        history = self.history(thread.id)
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
                                     # A misspelled tool name is the model's mistake to correct, not a failed turn.
                                     tool_not_found_behavior="return_error_to_model"))
            steps = ToolSteps(result, context_, turn["tools"], frozenset(tool.name for tool in harness_tools))
            async for event in stream_agent_response(context_, steps):
                yield event
            if out_of_turns:
                turn["step_limit"] = True
                yield ThreadItemDoneEvent(item=AssistantMessageItem(
                    id=self.store.generate_item_id("message", thread, context_.request_context), thread_id=thread.id,
                    created_at=datetime.now(), content=[AssistantMessageContent(text=out_of_turns[0])]))
        except BaseException:
            # The SDK saves items as the run goes; a failed turn must not leave half of itself in the history.
            while len(await history.get_items()) > kept:
                await history.pop_item()
            raise
        finally:
            history.close()
        await self._collect_evidence(session, conversation, turn)
        files = await self._collect(session, conversation, turn)
        _, check_operation = self.spec.trace_operations
        with operation(check_operation):
            turn["check"] = self.spec.check(conversation, turn, files)
        if self.file_status is not None:
            turn["file_status"] = self.file_status(conversation, turn)
        meta["sandbox"] = self.client.serialize_session_state(session.state)

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
                             "bytes": len(data), "sha256": entry["sha256"]})
            turn["files"].append({"path": path, "bytes": len(data), "sha256": entry["sha256"], "new": True,
                                  "changed": True, "evidence": True, "command": entry["command"]})

    def _describe_upload(self, entry: dict) -> str:
        processors = self.spec.uploads.processors if self.spec.uploads else {}
        return "; ".join(processor.describe(entry[processor.key], entry)
                         for processor in processors.values() if processor.key in entry)

    async def _store_uploads(self, session, conversation: Conversation, turn: dict, attachments: list, context: dict) -> list[dict]:
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
        await self.store.save_thread(conversation.thread, context)
        for attachment in attachments:
            await self.uploads.delete_attachment(attachment.id, {})
        return added

    async def _collect(self, session, conversation: Conversation, turn: dict) -> dict[str, bytes]:
        """Copy the agent's output folders to the host while the sandbox is still running."""
        folders = self.spec.collect
        listing = await session.exec("find", *folders, "-maxdepth", "1", "-type", "f", shell=False)
        # Names come from the sandbox: accept only plain file names in the agent's folders.
        pattern = re.compile(f"({'|'.join(map(re.escape, folders))})/{_FILE_NAME}")
        names = sorted({line for line in listing.stdout.decode(errors="replace").splitlines() if pattern.fullmatch(line)})
        previous = {item["path"]: item.get("sha256") for earlier in conversation.metadata["turns"][:-1]
                    for item in earlier["files"]}
        destination = conversation.turn_dir(turn["number"])
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

    def _turn_card(self, conversation: Conversation, context: dict, turn: dict) -> ThreadItemDoneEvent:
        thread = conversation.thread
        changed = {item["path"] for item in turn["files"] if item.get("changed")}
        children = []
        if turn["uploads"]:
            children.append({"type": "Text", "size": "sm", "value": "Uploaded to inputs/uploads/: " + ", ".join(turn["uploads"])})
        rows = self.card(conversation, turn, changed) if self.card is not None else []
        if not any(_has_badge(row) for row in rows) and turn["status"] == "completed":
            # Every turn says what the host checked, even when the answer is that nothing was.
            outputs = any(path.startswith("output/") for path in changed)
            rows.append({"type": "Row", "children": [{"type": "Badge", "variant": "soft", "color": "warning" if outputs
                         else "secondary", "label": "Not checked on the host" if outputs
                         else "No output files changed · nothing to check"}]})
        children += rows
        buttons = [
            {"type": "Button", "label": item["path"].removeprefix("output/"), "style": "secondary", "size": "sm",
             "onClickAction": {"type": "open_file", "handler": "client",
                               "payload": {"thread_id": thread.id, "turn": turn["number"], "path": item["path"]}}}
            for item in turn["files"] if item.get("changed") and item["path"].startswith("output/") and not item.get("too_large")
        ][:4]
        check = turn.get("check") or {}
        quotes = len(check.get("checked_quotes") or []) if check.get("quotes_from", "") in changed else 0
        if quotes:
            buttons.append({"type": "Button", "label": f"Show the quote{'s' if quotes != 1 else ''}", "style": "secondary",
                            "size": "sm", "iconStart": "check-circle",
                            "onClickAction": {"type": "open_quotes", "handler": "client",
                                              "payload": {"thread_id": thread.id, "turn": turn["number"]}}})
        if turn.get("otel_trace_id"):
            buttons.append({"type": "Button", "label": "View trace", "style": "secondary", "size": "sm", "iconStart": "chart",
                            "onClickAction": {"type": "open_trace", "handler": "client",
                                              "payload": {"thread_id": thread.id, "turn": turn["number"]}}})
        if buttons:
            children.append({"type": "Row", "gap": 2, "wrap": "wrap", "children": buttons})
        tools = len(turn["tools"])
        in_harness = sum(1 for tool in turn["tools"] if tool.get("where") == "harness")
        caption = (f"Turn {turn['number']} · {turn['duration_s']} s · {turn['lifecycle']} {conversation.metadata['workspace']} · "
                   f"{tools} tool call{'s' if tools != 1 else ''}")
        if in_harness:
            caption += f", {in_harness} in the harness"
        children.append({"type": "Caption", "size": "sm", "value": caption})
        widget = DynamicWidgetRoot.model_validate({"type": "Card", "size": "full", "children": children})
        return ThreadItemDoneEvent(item=WidgetItem(
            id=self.store.generate_item_id("message", thread, context), thread_id=thread.id,
            created_at=datetime.now(), widget=widget))

    def _park(self, thread_id: str, session) -> None:
        """Keep a conversation's session open after its turn, and close it once it has been idle."""
        self._open[thread_id] = (session, asyncio.get_running_loop().create_task(self._close_when_idle(thread_id)))

    async def _close_when_idle(self, thread_id: str) -> None:
        await asyncio.sleep(self.idle_close_s)
        async with self._locks[thread_id]:
            opened = self._open.get(thread_id)
            if opened is None or opened[1] is not asyncio.current_task():
                return  # a turn took the session meanwhile
            del self._open[thread_id]
            await self._close(thread_id, opened[0], f"after {self.idle_close_s:.0f} s idle")

    async def _close(self, thread_id: str, session, why: str) -> None:
        """Close a session; with a memory store, the SDK's memory generation runs here and its result is published."""
        if self.memory is None:
            await _quietly(session.aclose(), f"closing {thread_id}")
            return
        async with self._memory_lock:
            began = time.monotonic()
            # Consolidate on top of what other conversations published since this one opened. Without that,
            # publishing could drop their lessons, so a failed seed closes the session without publishing.
            if await _quietly(self.memory.seed(session), f"seeding memory for {thread_id}") is False:
                await _quietly(session.aclose(), f"closing {thread_id}")
                return
            if await _quietly(session.aclose(), f"generating memory for {thread_id}") is False:
                return
            files = await _quietly(self.memory.publish(session), f"publishing memory from {thread_id}")
            logger.info("Closed %s %s; memory has %s files (%.1f s)", thread_id, why, files,
                        time.monotonic() - began)

    async def close_all(self) -> None:
        """Close every open session now, as an idle close would (tests and shutdown)."""
        for thread_id in list(self._open):
            async with self._locks[thread_id]:
                opened = self._open.pop(thread_id, None)
                if opened is None:
                    continue
                if opened[1] is not None:
                    opened[1].cancel()
                await self._close(thread_id, opened[0], "on shutdown")

    async def delete_workspace(self, thread_id: str) -> None:
        """Delete the workspace on the worker, the history, then the host copies. The worker keeps its journal.

        A deleted conversation is not remembered: its open session closes without generating memory.
        """
        thread = await self.store.load_thread(thread_id, {})
        state = thread.metadata.get("sandbox")
        async with self._locks[thread_id]:
            opened = self._open.pop(thread_id, None)
            if opened is not None and opened[1] is not None:
                opened[1].cancel()
            if opened is not None:
                await self.client.delete(opened[0])
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


async def _quietly(awaitable, what: str):
    """Memory is best effort: log a failure and carry on. Returns the result, or False on failure."""
    try:
        result = await awaitable
        return True if result is None else result
    except Exception:
        logger.exception("Failed %s", what)
        return False


def _has_badge(node: dict) -> bool:
    return node.get("type") == "Badge" or any(_has_badge(child) for child in node.get("children") or [])
