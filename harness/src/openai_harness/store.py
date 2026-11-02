# Copyright 2026 openai-agent-substrate contributors
# SPDX-License-Identifier: Apache-2.0
"""SQLite store of conversations and their transcripts, so both (and their workspaces) survive a restart.

A conversation's record (``Thread``) holds its title and its metadata, which is the harness's: its
turns, sandbox state, owner and, for an issue, the issue. Its transcript is the engine's list of
entries (``engine.py``). A request may rename a conversation but never replaces its metadata.

A conversation belongs to the user who started it (``None``: the guest, everyone when no one
signs in), or to everyone (``SHARED``: one the harness opened itself, such as an issue). A request's
context carries its user under ``"user"``; such a request sees and changes that user's conversations
and the shared ones, and deletes only its own, or any as one of ``admins``. The harness's own calls
pass a context without ``"user"`` and see everything. Someone else's conversation reads as not found,
so its existence is not revealed.

A signed-in name is trimmed and lowercased (``user_name``), as memory keys users, so its case never
makes two users; a name starting with ``@`` is refused, since ``SHARED`` is one.
"""

from __future__ import annotations

import json
import secrets
import sqlite3
import threading
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

SHARED = "@team"  # the owner of a conversation everyone may see


def user_name(signed_in: str | None) -> str | None:
    """The harness's name for a signed-in user: trimmed and lowercased; ``None`` (the guest) when empty.
    A name starting with ``@`` raises ValueError: whoever signed in as ``SHARED`` would start conversations
    everyone sees."""
    name = (signed_in or "").strip()[:256].lower()
    if name.startswith("@"):
        raise ValueError("User names starting with @ are reserved.")
    return name or None


class NotFound(LookupError):
    """A conversation that does not exist, or that the request may not see."""


@dataclass
class Thread:
    """A conversation's record: its title and the harness's metadata. Metadata never reaches the browser."""

    id: str
    created_at: datetime
    title: str | None = None
    metadata: dict = field(default_factory=dict)

    @classmethod
    def new(cls, *, title: str | None = None, metadata: dict | None = None) -> "Thread":
        return cls(id=f"thr_{secrets.token_hex(4)}", created_at=datetime.now(), title=title, metadata=metadata or {})

    @classmethod
    def from_json(cls, data: str) -> "Thread":
        record = json.loads(data)
        return cls(id=record["id"], created_at=datetime.fromisoformat(record["created_at"]), title=record.get("title"),
                   metadata=record.get("metadata") or {})

    def to_json(self) -> str:
        return json.dumps({"id": self.id, "created_at": self.created_at.isoformat(), "title": self.title,
                           "metadata": self.metadata})


class SQLiteStore:
    """Conversation records and their transcripts."""

    def __init__(self, path: str | Path, *, on_delete_thread=None, admins: frozenset[str] = frozenset()):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.on_delete_thread = on_delete_thread
        self.admins = frozenset(name for name in map(user_name, admins) if name)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.executescript("""
            CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, data TEXT NOT NULL, owner TEXT);
            CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, seq INTEGER NOT NULL,
                                                data TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS entries_by_thread ON entries (thread_id, seq);
        """)

    def close(self) -> None:
        with self._lock:
            self._db.close()

    def _query(self, sql: str, args=()):
        with self._lock:
            return self._db.execute(sql, args).fetchall()

    def _write(self, sql: str, args=()) -> int:
        with self._lock, self._db:
            return self._db.execute(sql, args).rowcount

    def _sees_all(self, context: dict) -> bool:
        return "user" not in context or context["user"] in self.admins

    def _owner(self, thread_id: str, context: dict) -> str | None:
        """The thread's owner, or NotFound when it does not exist or this context may not see it."""
        rows = self._query("SELECT owner FROM threads WHERE id = ?", (thread_id,))
        if not rows or not (self._sees_all(context) or rows[0][0] in (context["user"], SHARED)):
            raise NotFound(f"Conversation {thread_id} not found")
        return rows[0][0]

    # ---------- Conversations ----------

    async def load_thread(self, thread_id: str, context: dict) -> Thread:
        self._owner(thread_id, context)
        rows = self._query("SELECT data FROM threads WHERE id = ?", (thread_id,))
        return Thread.from_json(rows[0][0])

    async def save_thread(self, thread: Thread, context: dict) -> None:
        rows = self._query("SELECT data FROM threads WHERE id = ?", (thread.id,))
        if rows:
            self._owner(thread.id, context)
            if "user" in context:
                # A request renames a conversation; its metadata stays the harness's.
                stored = Thread.from_json(rows[0][0])
                stored.title = thread.title
                thread = stored
        elif "user" in context:
            # A new conversation belongs to whoever started it.
            thread.metadata.setdefault("owner", context["user"])
        owner = thread.metadata.get("owner")
        # UPDATE first keeps the rowid, which is the order conversations are listed in.
        if not self._write("UPDATE threads SET data = ?, owner = ? WHERE id = ?", (thread.to_json(), owner, thread.id)):
            self._write("INSERT INTO threads (id, data, owner) VALUES (?, ?, ?)", (thread.id, thread.to_json(), owner))

    async def load_threads(self, context: dict, *, newest_first: bool = True, limit: int = -1) -> list[Thread]:
        """The conversations this context may see, newest first unless asked otherwise; ``limit`` -1 is all."""
        where, args = ("WHERE owner IS ? OR owner = ?", (context["user"], SHARED)) if not self._sees_all(context) else ("", ())
        rows = self._query(f"SELECT data FROM threads {where} ORDER BY rowid {'DESC' if newest_first else 'ASC'} LIMIT ?",
                           (*args, limit))
        return [Thread.from_json(row[0]) for row in rows]

    async def delete_thread(self, thread_id: str, context: dict) -> None:
        if self._owner(thread_id, context) == SHARED and not self._sees_all(context):
            raise PermissionError("Only an admin can delete a shared conversation")
        if self.on_delete_thread is not None:
            # The engine deletes the thread's workspace first; a failure keeps the thread for a retry.
            await self.on_delete_thread(thread_id)
        self._write("DELETE FROM entries WHERE thread_id = ?", (thread_id,))
        self._write("DELETE FROM threads WHERE id = ?", (thread_id,))

    # ---------- Transcripts ----------

    async def save_entry(self, thread_id: str, entry: dict) -> None:
        """Add an entry at the end of the transcript, or change one in place."""
        data = json.dumps(entry)
        if not self._write("UPDATE entries SET data = ? WHERE id = ? AND thread_id = ?", (data, entry["id"], thread_id)):
            self._write("INSERT INTO entries (id, thread_id, seq, data) VALUES "
                        "(?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM entries WHERE thread_id = ?), ?)",
                        (entry["id"], thread_id, thread_id, data))

    async def set_entry_turn(self, thread_id: str, entry_id: str, turn: int) -> None:
        self._write("UPDATE entries SET data = json_set(data, '$.turn', ?) WHERE id = ? AND thread_id = ?",
                    (turn, entry_id, thread_id))

    async def load_entries(self, thread_id: str, context: dict, *, after: int = 0) -> list[dict]:
        """The transcript in order, each entry with its position (``seq``), from after ``after``."""
        self._owner(thread_id, context)
        rows = self._query("SELECT seq, data FROM entries WHERE thread_id = ? AND seq > ? ORDER BY seq",
                           (thread_id, after))
        return [{**json.loads(data), "seq": seq} for seq, data in rows]
