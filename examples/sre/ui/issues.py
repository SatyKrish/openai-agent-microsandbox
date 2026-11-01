# Copyright 2026 openai-agent-mxc contributors
# SPDX-License-Identifier: Apache-2.0
"""Issues: each workload the health board finds unhealthy becomes a conversation the whole team shares.

The board opens an issue without a model call. Its first item is a card of what the sandbox worker
read: the state, the reasons, restarts, readiness and when it was read. Anyone can investigate in
the issue's conversation, and the agent is told which issue it is in. One issue is open per workload
at a time; when the workload is healthy again, the issue is marked recovered.
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime, timezone

from chatkit.types import ThreadMetadata, WidgetItem
from chatkit.widgets import DynamicWidgetRoot

from openai_harness.store import SHARED

logger = logging.getLogger(__name__)
_INTERNAL: dict = {}  # the harness's own context: it sees every conversation


def fingerprint(namespace: str, workload: dict) -> str:
    return f"{namespace}/{workload['kind'].lower()}/{workload['name']}"


def _plain(text: str, limit: int = 80) -> str:
    """Cluster text, kept printable and short before it is shown or told to the agent."""
    return re.sub(r"[\x00-\x1f\x7f]+", " ", str(text)).strip()[:limit]


def prompt(issue: dict) -> str:
    reasons = ", ".join(issue.get("reasons") or [])
    return (f"Why is {issue['kind'].lower()} {issue['name']} in {issue['namespace']} {issue['state_seen']}"
            f"{f' ({reasons})' if reasons else ''}? Find the cause from the evidence and propose a fix.")


def _time(iso: str) -> str:
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone().strftime("%H:%M")
    except ValueError:
        return iso


class Issues:
    """Keeps one issue open per unhealthy workload, from the worker's health summary every ``every_s``."""

    def __init__(self, server, health, *, every_s: float = 30):
        self.server = server
        self.store = server.store
        self.health = health
        self.every_s = every_s
        self._lock = asyncio.Lock()

    async def run(self) -> None:
        while True:
            try:
                await self.sync(await self.health())
            except asyncio.CancelledError:
                raise
            except Exception as error:  # the worker may be restarting; try again next time
                logger.warning("Checking for issues failed: %s", error)
            await asyncio.sleep(self.every_s)

    async def all(self) -> list[ThreadMetadata]:
        """Every issue, oldest first."""
        found, after = [], None
        while True:
            page = await self.store.load_threads(100, after, "asc", _INTERNAL)
            found += [thread for thread in page.data if thread.metadata.get("issue")]
            if not page.has_more:
                return found
            after = page.after

    async def sync(self, summary: dict) -> None:
        async with self._lock:
            open_now = {thread.metadata["issue"]["fingerprint"]: thread for thread in await self.all()
                        if thread.metadata["issue"]["state"] == "open"}
            read_at = summary.get("generated_at") or datetime.now(timezone.utc).isoformat()
            for item in summary.get("namespaces", []):
                if item.get("error"):
                    continue
                for workload in item["workloads"]:
                    key = fingerprint(item["namespace"], workload)
                    thread = open_now.get(key)
                    if workload["state"] != "healthy" and thread is None:
                        await self._open(item["namespace"], workload, read_at)
                    elif workload["state"] == "healthy" and thread is not None:
                        await self._recover(thread, workload, read_at)

    async def _open(self, namespace: str, workload: dict, read_at: str) -> None:
        reasons = [_plain(reason) for reason in workload.get("reasons") or []][:4]
        issue = {"fingerprint": fingerprint(namespace, workload), "namespace": namespace, "kind": workload["kind"],
                 "name": workload["name"], "state": "open", "state_seen": workload["state"], "reasons": reasons,
                 "opened_by": "health board", "opened_at": read_at}
        title = f"{workload['name']}: {reasons[0] if reasons else workload['state']}"
        thread = ThreadMetadata(id=self.store.generate_thread_id(_INTERNAL), created_at=datetime.now(),
                                title=title[:60], metadata={"owner": SHARED, "issue": issue})
        await self.store.save_thread(thread, _INTERNAL)
        await self._post(thread, self._opened_card(issue, workload, read_at))
        logger.info("Opened issue %s for %s", thread.id, issue["fingerprint"])

    async def _recover(self, thread: ThreadMetadata, workload: dict, read_at: str) -> None:
        thread = await self.store.load_thread(thread.id, _INTERNAL)
        issue = thread.metadata["issue"]
        issue.update(state="recovered", recovered_at=read_at)
        thread.title = f"{thread.title} (recovered)"[:60]
        await self.store.save_thread(thread, _INTERNAL)
        await self._post(thread, {"type": "Card", "size": "full", "children": [
            {"type": "Text", "size": "sm", "value": f"Recovered: {workload['ready']}/{workload['desired']} ready "
                                                    f"at {_time(read_at)}."}]})
        logger.info("Issue %s recovered: %s", thread.id, issue["fingerprint"])

    def _opened_card(self, issue: dict, workload: dict, read_at: str) -> dict:
        rows = [
            {"type": "Row", "gap": 2, "children": [
                {"type": "Text", "weight": "semibold", "value": f"{issue['kind'].lower()}/{issue['name']}"},
                {"type": "Text", "color": "secondary", "value": f"in {issue['namespace']}"}]},
            {"type": "Text", "size": "sm", "color": "danger" if issue["state_seen"] == "failing" else "warning",
             "value": f"{issue['state_seen'].capitalize()}, {workload['ready']}/{workload['desired']} ready"},
        ]
        detail = ", ".join(issue["reasons"] + ([f"{workload['restarts']} restarts"] if workload.get("restarts") else []))
        if detail:
            rows.append({"type": "Text", "size": "sm", "value": detail})
        if workload.get("last_warning"):
            when = f" at {_time(workload['last_warning_at'])}" if workload.get("last_warning_at") else ""
            rows.append({"type": "Text", "size": "sm", "color": "secondary",
                         "value": f"Last warning{when}: {_plain(workload['last_warning'], 200)}"})
        rows.append({"type": "Row", "children": [{"type": "Button", "label": "Investigate", "style": "primary",
                                                  "size": "sm", "onClickAction": {"type": "investigate_issue",
                                                                                  "handler": "client",
                                                                                  "payload": {"prompt": prompt(issue)}}}]})
        rows.append({"type": "Caption", "size": "sm",
                     "value": f"Opened by the health board · read by the sandbox worker at {_time(read_at)}"})
        return {"type": "Card", "size": "full", "children": rows}

    async def _post(self, thread: ThreadMetadata, card: dict) -> None:
        await self.store.add_thread_item(thread.id, WidgetItem(
            id=self.store.generate_item_id("message", thread, _INTERNAL), thread_id=thread.id,
            created_at=datetime.now(), widget=DynamicWidgetRoot.model_validate(card)), _INTERNAL)

    async def listing(self) -> list[dict]:
        """Issues for the page: which workload, its state, and the conversation to open."""
        return [{"thread_id": thread.id, "title": thread.title, **{key: thread.metadata["issue"].get(key) for key in
                 ("fingerprint", "namespace", "kind", "name", "state", "opened_at", "recovered_at")}}
                for thread in await self.all()]
