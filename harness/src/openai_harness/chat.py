# Copyright 2026 openai-agent-substrate contributors
# SPDX-License-Identifier: Apache-2.0
"""ChatKit's protocol over the harness's engine: one ChatKit thread is one conversation.

A message ChatKit sends goes to the engine's queue for its conversation (``engine.py``); this server
then streams the events of the turn that answers it, as ChatKit events, until the turn has shown its
card. The engine runs the turn and keeps the transcript, which the store serves to ChatKit as items.
Stopping the stream stops the turn, as ChatKit's stop button expects.
"""

from __future__ import annotations

import asyncio
import contextlib
from datetime import datetime
from pathlib import Path

from chatkit.errors import CustomStreamError
from chatkit.server import ChatKitServer
from chatkit.store import NotFoundError
from chatkit.types import (
    AssistantMessageContent, AssistantMessageContentPartAdded, AssistantMessageContentPartDone,
    AssistantMessageContentPartTextDelta, AssistantMessageItem, ClientEffectEvent, ThreadItemAddedEvent,
    ThreadItemDoneEvent, ThreadItemUpdatedEvent, ThreadMetadata, UserMessageItem, WorkflowTaskAdded,
    WorkflowTaskUpdated,
)

from . import chatkit_view
from .engine import Busy, Harness, TurnError, preferred_file, running_elsewhere, usage_of  # noqa: F401  (re-exported)
from .spec import AgentSpec
from .uploads import UploadStore

_ENDED = {"shown", "failed", "stopped"}


class HarnessChatServer(ChatKitServer[dict]):
    """ChatKit's server for an agent. Everything else the harness does is its engine's (``self.engine``)."""

    def __init__(self, spec: AgentSpec, store, client, *, model, output_dir: Path,
                 base_url: str = "http://localhost:8000", **options):
        uploads = UploadStore(store, Path(output_dir) / ".staged", base_url, spec.uploads)
        super().__init__(store, attachment_store=uploads)
        self.engine = Harness(spec, store, client, model=model, output_dir=output_dir, uploads=uploads, **options)
        store.on_delete_thread = self.engine.delete_workspace

    def __getattr__(self, name):
        # The engine's state and operations (memory, sessions, close_all, ...) read through the server.
        engine = self.__dict__.get("engine")
        if engine is None:
            raise AttributeError(name)
        return getattr(engine, name)

    @property
    def model(self):
        return self.engine.model

    @model.setter
    def model(self, value) -> None:
        self.engine.model = value

    async def respond(self, thread: ThreadMetadata, input_user_message: UserMessageItem | None, context: dict):
        if input_user_message is None:
            return
        spec = self.engine.spec
        text = chatkit_view.text_of(input_user_message)
        attachments = list(input_user_message.attachments)
        limit = spec.uploads.max_count if spec.uploads else 0
        if len(attachments) > limit:
            message = f"Attach at most {limit} files per message." if limit else "This agent does not accept uploads."
            raise CustomStreamError(message, allow_retry=False)
        if not text and not attachments:
            raise CustomStreamError("Type a question to send.", allow_retry=False)
        with self.engine.listen(thread.id) as events:
            done = await self.engine.send(thread.id, text or spec.default_question, requester=context.get("user"),
                                          attachments=attachments, entry_id=input_user_message.id)
            try:
                async for event in self._turn_events(thread, events, input_user_message.id, done):
                    yield event
            except asyncio.CancelledError:
                # ChatKit's stop button closes the stream: stop the turn too.
                self.engine.stop(thread.id)
                raise
            finally:
                # The engine owns the conversation's record; ChatKit's copy follows it.
                with contextlib.suppress(NotFoundError):
                    fresh = await self.store.load_thread(thread.id, {})
                    thread.title, thread.metadata = fresh.title, fresh.metadata
        # The turn has shown its card or failed; its outcome settles a moment later.
        await asyncio.wait({done})
        if done.cancelled() or done.exception() is None:
            return
        error = done.exception()
        if isinstance(error, Busy):
            # The refused message must not stay without a reply.
            with contextlib.suppress(NotFoundError):
                await self.store.delete_thread_item(thread.id, input_user_message.id, context)
        if isinstance(error, TurnError):
            raise CustomStreamError(str(error), allow_retry=error.retry)
        raise CustomStreamError(f"The turn failed ({type(error).__name__}); the server log has the cause. "
                                "You can retry.", allow_retry=True)

    async def _turn_events(self, thread: ThreadMetadata, events: asyncio.Queue, message_id: str, done: asyncio.Future):
        """The events of the turn that answers ``message_id``, as ChatKit events."""
        turn = None
        steps: dict[str, list[dict]] = {}   # steps entry id -> the steps ChatKit has been sent; None once done
        speaking: set[str] = set()          # assistant entries whose text is streaming
        while True:
            getter = asyncio.ensure_future(events.get())
            finished, _ = await asyncio.wait({getter, done}, return_when=asyncio.FIRST_COMPLETED)
            if getter not in finished:
                getter.cancel()
                # The turn ended before its events were delivered (a refusal, say); deliver what is queued.
                while not events.empty():
                    async for item in self._convert(thread, events.get_nowait(), turn, steps, speaking):
                        yield item
                return
            event = getter.result()
            if turn is None:
                if message_id in (event.get("messages") or []) and event["type"] == "turn":
                    turn = event["turn"]
                    if event.get("title"):
                        thread.title = event["title"]
                elif message_id in (event.get("messages") or []) and event["type"] == "error":
                    return
                continue
            if event.get("turn") != turn:
                continue
            async for item in self._convert(thread, event, turn, steps, speaking):
                yield item
            if event["type"] == "turn" and event["status"] in _ENDED or event["type"] == "error":
                return

    async def _convert(self, thread: ThreadMetadata, event: dict, turn, steps: dict, speaking: set):
        kind = event["type"]
        if kind == "delta":
            if event["id"] not in speaking:
                speaking.add(event["id"])
                yield ThreadItemAddedEvent(item=AssistantMessageItem(id=event["id"], thread_id=thread.id,
                                                                     created_at=datetime.now(), content=[]))
                yield ThreadItemUpdatedEvent(item_id=event["id"], update=AssistantMessageContentPartAdded(
                    content_index=0, content=AssistantMessageContent(text="", annotations=[])))
            yield ThreadItemUpdatedEvent(item_id=event["id"], update=AssistantMessageContentPartTextDelta(
                content_index=0, delta=event["delta"]))
        elif kind == "entry":
            entry = event["entry"]
            if entry["kind"] == "user":
                return
            if entry["kind"] == "steps":
                if entry["id"] in steps and steps[entry["id"]] is None:
                    # ChatKit has the group as done; a call that ends after it is in the transcript, as on reload.
                    return
                sent = steps.get(entry["id"])
                if sent is None:
                    yield ThreadItemAddedEvent(item=chatkit_view.workflow(thread.id, {**entry, "open": True}))
                else:
                    for index, step in enumerate(entry["steps"]):
                        if index >= len(sent):
                            yield ThreadItemUpdatedEvent(item_id=entry["id"], update=WorkflowTaskAdded(
                                task=chatkit_view.task(step), task_index=index))
                        elif step != sent[index]:
                            yield ThreadItemUpdatedEvent(item_id=entry["id"], update=WorkflowTaskUpdated(
                                task=chatkit_view.task(step), task_index=index))
                steps[entry["id"]] = [dict(step) for step in entry["steps"]]
                if not entry.get("open"):
                    steps[entry["id"]] = None
                    yield ThreadItemDoneEvent(item=chatkit_view.workflow(thread.id, entry))
                return
            if entry["kind"] == "assistant" and entry["id"] in speaking:
                speaking.discard(entry["id"])
                yield ThreadItemUpdatedEvent(item_id=entry["id"], update=AssistantMessageContentPartDone(
                    content_index=0, content=AssistantMessageContent(text=entry["text"], annotations=[])))
            item = chatkit_view.to_item(thread.id, entry)
            if item is not None:
                yield ThreadItemDoneEvent(item=item)
        elif kind == "effect":
            yield ClientEffectEvent(name=event["name"], data=event["data"])
