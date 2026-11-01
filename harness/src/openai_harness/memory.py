# Copyright 2026 openai-agent-mxc contributors
# SPDX-License-Identifier: Apache-2.0
"""An agent's memory across conversations, kept by the harness.

The SDK's ``Memory`` capability keeps memory as files in a sandbox workspace
(``memories/``): it records each run, and when the sandbox session closes it
extracts lessons from the conversation and consolidates them into ``MEMORY.md``
and ``memory_summary.md``, merging with what is already there. Here every
conversation has its own workspace, so on its own that memory would never leave
the conversation. The harness keeps the agent's latest memory on its volume and:

- seeds it into a conversation's workspace when its session opens, so the agent
  starts with what earlier investigations learned;
- seeds it again just before the session closes, so consolidation builds on what
  other conversations published meanwhile;
- publishes the consolidated result back after the session closes.

Closing and publishing are serialized across conversations, so two
consolidations never overwrite each other's lessons.
"""

from __future__ import annotations

import io
import logging
import re
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)
_NAME = re.compile(r"[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*")
MIB = 1024 * 1024


class MemoryStore:
    def __init__(self, root: Path, *, memories_dir: str = "memories", max_bytes: int = 8 * MIB, max_files: int = 2000):
        self.root = Path(root)
        self.memories_dir = memories_dir.strip("/")
        self.max_bytes = max_bytes
        self.max_files = max_files

    def files(self) -> dict[str, bytes]:
        """The stored memory files by path relative to the memories directory."""
        if not self.root.is_dir():
            return {}
        return {path.relative_to(self.root).as_posix(): path.read_bytes()
                for path in sorted(self.root.rglob("*")) if path.is_file()}

    async def seed(self, session) -> int:
        """Copy the stored memory into the workspace's memories directory; returns the number of files."""
        files = self.files()
        for name, data in files.items():
            await session.write(Path(f"{self.memories_dir}/{name}"), io.BytesIO(data))
        return len(files)

    async def publish(self, session) -> int:
        """Replace the stored memory with the workspace's, after the SDK consolidated it; returns the file count."""
        listing = await session.exec("find", self.memories_dir, "-type", "f", shell=False)
        if not listing.ok():
            return 0
        prefix = self.memories_dir + "/"
        names = sorted(line[len(prefix):] for line in listing.stdout.decode(errors="replace").splitlines()
                       if line.startswith(prefix) and _NAME.fullmatch(line[len(prefix):]) and ".." not in line)
        if not names:
            return 0
        staged = self.root.with_name(self.root.name + f".new-{time.monotonic_ns()}")
        total = 0
        try:
            for name in names[: self.max_files]:
                with await session.read(Path(prefix + name)) as handle:
                    data = handle.read()
                total += len(data)
                if total > self.max_bytes:
                    logger.warning("Memory exceeds %d bytes; keeping the files that fit", self.max_bytes)
                    break
                target = staged / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
            # Swap in the new tree; a reader sees the old memory or the new, never half of each.
            old = self.root.with_name(self.root.name + f".old-{time.monotonic_ns()}")
            if self.root.exists():
                self.root.rename(old)
            staged.rename(self.root)
            shutil.rmtree(old, ignore_errors=True)
        finally:
            shutil.rmtree(staged, ignore_errors=True)
        return len(self.files())

    def summary(self, limit: int = 4000) -> dict:
        """What the UI shows: the consolidated summary, when it changed, and how many conversations fed it."""
        summary = self.root / "memory_summary.md"
        if not summary.is_file():
            return {"text": "", "updated_at": None, "conversations": 0}
        text = summary.read_text(encoding="utf-8", errors="replace")
        rollouts = self.root / "rollout_summaries"
        return {"text": text[:limit] + ("…" if len(text) > limit else ""),
                "updated_at": datetime.fromtimestamp(summary.stat().st_mtime, timezone.utc).isoformat(),
                "conversations": len(list(rollouts.glob("*.md"))) if rollouts.is_dir() else 0}
