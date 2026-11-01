# Copyright 2026 openai-agent-substrate contributors
# SPDX-License-Identifier: Apache-2.0
"""The engine's transcript as ChatKit thread items, and back: ChatKit is one view of a conversation."""

from __future__ import annotations

from datetime import datetime

from chatkit.types import (
    AssistantMessageContent, AssistantMessageItem, CustomTask, DurationSummary, ThreadItem, UserMessageItem,
    UserMessageTextContent, WidgetItem, Workflow, WorkflowItem,
)
from chatkit.widgets import DynamicWidgetRoot


def _when(entry: dict) -> datetime:
    """ChatKit shows local, naive times."""
    try:
        return datetime.fromisoformat(entry["at"]).astimezone().replace(tzinfo=None)
    except (KeyError, ValueError):
        return datetime.now()


def task(step: dict) -> CustomTask:
    return CustomTask(title=step["title"], icon=step.get("icon"), content=step.get("detail") or None,
                      status_indicator="loading" if step.get("status") == "running" else "complete")


def workflow(thread_id: str, entry: dict) -> WorkflowItem:
    """A group of steps: open while the agent works, then collapsed into "worked for …"."""
    open_ = entry.get("open", False)
    return WorkflowItem(id=entry["id"], thread_id=thread_id, created_at=_when(entry),
                        workflow=Workflow(type="custom", tasks=[task(step) for step in entry["steps"]], expanded=open_,
                                          summary=None if open_ else DurationSummary(duration=entry.get("duration_s") or 0)))


def text_of(item: UserMessageItem) -> str:
    return "\n".join(part.text for part in item.content if getattr(part, "type", None) == "input_text").strip()


def to_item(thread_id: str, entry: dict) -> ThreadItem | None:
    """A transcript entry as the ChatKit item a ChatKit page renders."""
    kind = entry.get("kind")
    if kind == "user":
        return UserMessageItem(id=entry["id"], thread_id=thread_id, created_at=_when(entry),
                               content=[UserMessageTextContent(text=entry.get("text", ""))], attachments=[],
                               inference_options={})
    if kind == "assistant":
        return AssistantMessageItem(id=entry["id"], thread_id=thread_id, created_at=_when(entry),
                                    content=[AssistantMessageContent(text=entry.get("text", ""), annotations=[])])
    if kind == "steps":
        return workflow(thread_id, entry)
    if kind == "card":
        return WidgetItem(id=entry["id"], thread_id=thread_id, created_at=_when(entry),
                          widget=DynamicWidgetRoot.model_validate(entry["card"]))
    return None


def from_item(item: ThreadItem, *, requested_by: str | None = None) -> dict | None:
    """A ChatKit item as a transcript entry: a message ChatKit stored, or an item from before the engine."""
    at = item.created_at.astimezone().isoformat() if item.created_at else None
    base = {"id": item.id, "turn": None, "at": at}
    if isinstance(item, UserMessageItem):
        return {**base, "kind": "user", "text": text_of(item), "requested_by": requested_by,
                "attachments": [attachment.name for attachment in item.attachments]}
    if isinstance(item, AssistantMessageItem):
        return {**base, "kind": "assistant", "text": "".join(part.text for part in item.content)}
    if isinstance(item, WorkflowItem):
        summary = item.workflow.summary
        return {**base, "kind": "steps", "open": False,
                "duration_s": getattr(summary, "duration", None),
                "steps": [{"title": getattr(task_, "title", None) or getattr(task_, "content", "") or "",
                           "icon": getattr(task_, "icon", None), "detail": getattr(task_, "content", None) or "",
                           "status": "done"} for task_ in item.workflow.tasks]}
    if isinstance(item, WidgetItem):
        return {**base, "kind": "card", "card": item.widget.model_dump(exclude_none=True)}
    return None
