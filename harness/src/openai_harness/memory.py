# Copyright 2026 openai-agent-mxc contributors
# SPDX-License-Identifier: Apache-2.0
"""An agent's memory across conversations, kept by the harness for each user.

The SDK's ``Memory`` capability keeps memory as files in a sandbox workspace
(``memories/``): it records each run, and when the sandbox session closes it
extracts lessons from the conversation and consolidates them into ``MEMORY.md``
and ``memory_summary.md``, merging with what is already there. The SDK expects
the memories directory to be preserved and reused; here every conversation has
its own workspace, so the harness keeps each user's latest memory on its volume
and:

- seeds it into a conversation's workspace when its session opens, so the agent
  starts with what the user's earlier investigations learned;
- seeds it again just before the session closes, so consolidation builds on what
  the user's other conversations published meanwhile;
- publishes the consolidated result back after the session closes.

A conversation's memory belongs to the user who started it. Without sign-in
every user is the guest, so the guest's memory is shared.

The harness also forgets: conversations last updated longer ago than
``max_age``, all but the newest ``max_conversations``, and deleted
conversations. It removes their raw memories and summaries at once, and the
SDK's own forgetting step removes what ``MEMORY.md`` drew from them at that
user's next consolidation. When nothing is left, the user's memory is removed.
"""

from __future__ import annotations

import hashlib
import io
import logging
import re
import shutil
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

logger = logging.getLogger(__name__)
_NAME = re.compile(r"[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*")
MIB = 1024 * 1024
GUEST = "guest"


def user_key(user: str | None) -> str:
    """A user's directory name: readable, safe as a path, and distinct for distinct users."""
    user = (user or "").strip().lower()
    if not user:
        return GUEST
    slug = re.sub(r"[^a-z0-9._-]+", "-", user).strip("-.")[:40] or "user"
    return f"{slug}-{hashlib.sha256(user.encode()).hexdigest()[:8]}"


class MemoryStore:
    """One user's memory: the SDK's memories directory as files under ``root``."""

    def __init__(self, root: Path, *, memories_dir: str = "memories", max_age: timedelta | None = timedelta(days=90),
                 max_conversations: int = 256, max_bytes: int = 8 * MIB, max_files: int = 2000):
        self.root = Path(root)
        self.memories_dir = memories_dir.strip("/")
        self.max_age = max_age
        self.max_conversations = max_conversations
        self.max_bytes = max_bytes
        self.max_files = max_files

    def files(self) -> dict[str, bytes]:
        """The stored memory files by path relative to the memories directory."""
        if not self.root.is_dir():
            return {}
        return {path.relative_to(self.root).as_posix(): path.read_bytes()
                for path in sorted(self.root.rglob("*")) if path.is_file()}

    async def seed(self, session) -> int:
        """Make the workspace's memories directory the stored memory; returns the number of files.

        The directory is replaced, not overlaid: a conversation forgotten since this workspace was last
        seeded must not stay in it, where consolidation would find it and publish it back.
        """
        self.prune()
        files = self.files()
        cleared = await session.exec("rm", "-rf", self.memories_dir, shell=False)
        if not cleared.ok():
            raise RuntimeError(f"could not clear {self.memories_dir}/ in the workspace")
        for name, data in files.items():
            await session.write(Path(f"{self.memories_dir}/{name}"), io.BytesIO(data))
        return len(files)

    async def publish(self, session) -> int:
        """Replace the stored memory with the workspace's, after the SDK consolidated it; returns the file count.

        Memory over the limits is not published at all, so the stored memory stays whole.
        """
        listing = await session.exec("find", self.memories_dir, "-type", "f", shell=False)
        if not listing.ok():
            return 0
        prefix = self.memories_dir + "/"
        names = sorted(line[len(prefix):] for line in listing.stdout.decode(errors="replace").splitlines()
                       if line.startswith(prefix) and _NAME.fullmatch(line[len(prefix):]) and ".." not in line)
        if not names:
            return 0
        if len(names) > self.max_files:
            logger.error("Memory has %d files, over %d; keeping the stored memory", len(names), self.max_files)
            return len(self.files())
        staged = self.root.with_name(self.root.name + f".new-{time.monotonic_ns()}")
        total = 0
        try:
            for name in names:
                with await session.read(Path(prefix + name)) as handle:
                    data = handle.read()
                total += len(data)
                if total > self.max_bytes:
                    logger.error("Memory exceeds %d bytes; keeping the stored memory", self.max_bytes)
                    return len(self.files())
                target = staged / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
            # Swap in the new tree; a reader sees the old memory or the new, never half of each.
            old = self.root.with_name(self.root.name + f".old-{time.monotonic_ns()}")
            self.root.parent.mkdir(parents=True, exist_ok=True)
            if self.root.exists():
                self.root.rename(old)
            staged.rename(self.root)
            shutil.rmtree(old, ignore_errors=True)
        finally:
            shutil.rmtree(staged, ignore_errors=True)
        self.prune()
        return len(self.files())

    def prune(self, now: datetime | None = None) -> list[str]:
        """Forget conversations last updated more than ``max_age`` ago and all but the newest
        ``max_conversations``; returns their ids."""
        now = now or datetime.now(timezone.utc)
        dropped = []
        for index, (updated, conversation, summary) in enumerate(self._conversations()):
            expired = self.max_age is not None and now - updated > self.max_age
            if (index >= self.max_conversations or expired) and self._drop(conversation, summary):
                dropped.append(conversation)
        if dropped:
            logger.info("Forgot %d conversations from %s's memory", len(dropped), self.root.name)
            self._settle()
        return dropped

    def forget(self, conversation: str) -> bool:
        """Forget one conversation, such as a deleted one; returns whether memory held it."""
        if not _NAME.fullmatch(conversation) or "/" in conversation:
            return False
        summary = next((summary for _, rid, summary in self._conversations() if rid == conversation), None)
        if not self._drop(conversation, summary):
            return False
        self._settle()
        return True

    def clear(self) -> None:
        """Forget everything."""
        shutil.rmtree(self.root, ignore_errors=True)

    def conversations(self) -> list[dict]:
        """The remembered conversations, newest first: id, when last updated, and the SDK's one-line description."""
        return [{"id": conversation, "updated_at": updated.isoformat(),
                 "description": _description(self.root / "raw_memories" / f"{conversation}.md")}
                for updated, conversation, _ in self._conversations()]

    def index(self, limit: int = 64 * 1024) -> str:
        """MEMORY.md, the consolidated memory the agent searches."""
        path = self.root / "MEMORY.md"
        text = path.read_text(encoding="utf-8", errors="replace") if path.is_file() else ""
        return text[:limit] + ("…" if len(text) > limit else "")

    def summary(self, limit: int = 4000) -> dict:
        """What the UI shows: the consolidated summary, when it changed, and how many conversations fed it."""
        self.prune()
        summary = self.root / "memory_summary.md"
        if not summary.is_file():
            return {"text": "", "updated_at": None, "conversations": 0}
        text = summary.read_text(encoding="utf-8", errors="replace")
        return {"text": text[:limit] + ("…" if len(text) > limit else ""),
                "updated_at": datetime.fromtimestamp(summary.stat().st_mtime, timezone.utc).isoformat(),
                "conversations": len(self._conversations())}

    def _conversations(self) -> list[tuple[datetime, str, str | None]]:
        """(last updated, id, summary file) for each conversation with a raw memory, newest first."""
        raw = self.root / "raw_memories"
        found = []
        for path in raw.glob("*.md") if raw.is_dir() else []:
            header = _header(path)
            updated = _timestamp(header.get("updated_at")) or datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
            found.append((updated, path.stem, header.get("rollout_summary_file")))
        return sorted(found, reverse=True)

    def _drop(self, conversation: str, summary: str | None) -> bool:
        raw = self.root / "raw_memories" / f"{conversation}.md"
        held = raw.is_file()
        raw.unlink(missing_ok=True)
        if summary and summary.startswith("rollout_summaries/") and _NAME.fullmatch(summary) and ".." not in summary:
            candidates = [self.root / summary]
        else:
            candidates = list((self.root / "rollout_summaries").glob(f"{conversation}_*.md"))
        for path in candidates:
            held = held or path.is_file()
            path.unlink(missing_ok=True)
        return held

    def _settle(self) -> None:
        """After forgetting: with no conversation left, remove the memory; otherwise rebuild the raw
        memories the agent may read from the ones that remain, as the SDK builds them."""
        remaining = self._conversations()
        if not remaining:
            shutil.rmtree(self.root, ignore_errors=True)
            return
        joined = "\n\n".join((self.root / "raw_memories" / f"{conversation}.md").read_text(
            encoding="utf-8", errors="replace").rstrip("\n") for _, conversation, _ in remaining)
        (self.root / "raw_memories.md").write_text(joined, encoding="utf-8")


class UserMemory:
    """Each user's memory under ``root/users``; without sign-in everyone is the guest."""

    def __init__(self, root: Path, **options):
        self.root = Path(root)
        self.options = options

    def for_user(self, user: str | None) -> MemoryStore:
        return MemoryStore(self.root / "users" / user_key(user), **self.options)

    def summary(self, user: str | None, *, detail: bool = False) -> dict:
        """What the UI shows of a user's memory; ``detail`` adds each remembered conversation and MEMORY.md."""
        store = self.for_user(user)
        summary = {"user": (user or "").strip() or GUEST, "shared": user_key(user) == GUEST, **store.summary()}
        if detail:
            summary |= {"remembered": store.conversations(), "index": store.index()}
        return summary


def _header(path: Path) -> dict[str, str]:
    """The ``key: value`` lines the SDK writes at the top of a raw memory, before ``---``."""
    header = {}
    with path.open(encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if line.strip() == "---":
                break
            key, colon, value = line.partition(":")
            if colon:
                header[key.strip()] = value.strip()
    return header


def _description(path: Path) -> str:
    """The ``description:`` line the SDK writes after a raw memory's header."""
    with path.open(encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if line.startswith("description:"):
                return line.partition(":")[2].strip()[:300]
    return ""


def _timestamp(value: str | None) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value) if value else None
    except ValueError:
        return None
    if parsed is not None and parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed
