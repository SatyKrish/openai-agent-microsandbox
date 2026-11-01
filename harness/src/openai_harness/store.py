# Copyright 2026 openai-agent-substrate contributors
# SPDX-License-Identifier: Apache-2.0
"""SQLite ChatKit store, so threads (and their workspaces) survive a server restart."""

from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

from chatkit.store import NotFoundError, Store
from chatkit.types import Attachment, Page, ThreadItem, ThreadMetadata
from pydantic import TypeAdapter

_ITEM = TypeAdapter(ThreadItem)
_ATTACHMENT = TypeAdapter(Attachment)


class SQLiteStore(Store[dict]):
    """Rows hold ChatKit's own JSON. Thread metadata never reaches the browser."""

    def __init__(self, path: str | Path, *, on_delete_thread=None):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.on_delete_thread = on_delete_thread
        self._lock = threading.Lock()
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.executescript("""
            CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, data TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS items_by_thread ON items (thread_id);
            CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, data TEXT NOT NULL);
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

    def _upsert(self, table: str, columns: tuple[str, ...], values: tuple) -> None:
        # UPDATE first keeps the rowid, which is the insertion order used for paging.
        assignments = ", ".join(f"{column} = ?" for column in columns[1:])
        if not self._write(f"UPDATE {table} SET {assignments} WHERE id = ?", (*values[1:], values[0])):
            self._write(f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})", values)

    def _page(self, sql_rows, limit: int, decode) -> Page:
        data = [decode(row) for row in sql_rows[:limit]]
        has_more = len(sql_rows) > limit
        return Page(data=data, has_more=has_more, after=data[-1].id if has_more and data else None)

    async def load_thread(self, thread_id: str, context: dict) -> ThreadMetadata:
        rows = self._query("SELECT data FROM threads WHERE id = ?", (thread_id,))
        if not rows:
            raise NotFoundError(f"Thread {thread_id} not found")
        return ThreadMetadata.model_validate_json(rows[0][0])

    async def save_thread(self, thread: ThreadMetadata, context: dict) -> None:
        metadata = ThreadMetadata.model_validate(thread.model_dump(exclude={"items"}))
        self._upsert("threads", ("id", "data"), (thread.id, metadata.model_dump_json()))

    async def load_threads(self, limit: int, after: str | None, order: str, context: dict) -> Page[ThreadMetadata]:
        direction, comparison = ("DESC", "<") if order == "desc" else ("ASC", ">")
        cursor = ""
        args: tuple = ()
        if after:
            cursor = f"WHERE rowid {comparison} (SELECT rowid FROM threads WHERE id = ?)"
            args = (after,)
        rows = self._query(f"SELECT data FROM threads {cursor} ORDER BY rowid {direction} LIMIT ?", (*args, limit + 1))
        return self._page(rows, limit, lambda row: ThreadMetadata.model_validate_json(row[0]))

    async def delete_thread(self, thread_id: str, context: dict) -> None:
        if self.on_delete_thread is not None:
            # The server deletes the thread's workspace first; a failure keeps the thread for a retry.
            await self.on_delete_thread(thread_id)
        self._write("DELETE FROM items WHERE thread_id = ?", (thread_id,))
        self._write("DELETE FROM threads WHERE id = ?", (thread_id,))

    async def load_thread_items(self, thread_id: str, after: str | None, limit: int, order: str,
                                context: dict) -> Page[ThreadItem]:
        direction, comparison = ("DESC", "<") if order == "desc" else ("ASC", ">")
        cursor = ""
        args: tuple = (thread_id,)
        if after:
            cursor = f"AND rowid {comparison} (SELECT rowid FROM items WHERE id = ?)"
            args = (thread_id, after)
        rows = self._query(f"SELECT data FROM items WHERE thread_id = ? {cursor} ORDER BY rowid {direction} LIMIT ?",
                           (*args, limit + 1))
        return self._page(rows, limit, lambda row: _ITEM.validate_json(row[0]))

    async def add_thread_item(self, thread_id: str, item: ThreadItem, context: dict) -> None:
        self._upsert("items", ("id", "thread_id", "data"), (item.id, thread_id, item.model_dump_json()))

    async def save_item(self, thread_id: str, item: ThreadItem, context: dict) -> None:
        self._upsert("items", ("id", "thread_id", "data"), (item.id, thread_id, item.model_dump_json()))

    async def load_item(self, thread_id: str, item_id: str, context: dict) -> ThreadItem:
        rows = self._query("SELECT data FROM items WHERE thread_id = ? AND id = ?", (thread_id, item_id))
        if not rows:
            raise NotFoundError(f"Item {item_id} not found")
        return _ITEM.validate_json(rows[0][0])

    async def delete_thread_item(self, thread_id: str, item_id: str, context: dict) -> None:
        self._write("DELETE FROM items WHERE thread_id = ? AND id = ?", (thread_id, item_id))

    async def save_attachment(self, attachment: Attachment, context: dict) -> None:
        self._upsert("attachments", ("id", "data"), (attachment.id, attachment.model_dump_json()))

    async def load_attachment(self, attachment_id: str, context: dict) -> Attachment:
        rows = self._query("SELECT data FROM attachments WHERE id = ?", (attachment_id,))
        if not rows:
            raise NotFoundError(f"Attachment {attachment_id} not found")
        return _ATTACHMENT.validate_json(rows[0][0])

    async def delete_attachment(self, attachment_id: str, context: dict) -> None:
        self._write("DELETE FROM attachments WHERE id = ?", (attachment_id,))
