# Copyright 2026 openai-agent-substrate contributors
# SPDX-License-Identifier: Apache-2.0
"""What an agent example hands the harness, beside its SDK SandboxAgent."""

from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from agents.sandbox import Manifest, SandboxAgent
from chatkit.types import ThreadMetadata

MIB = 1024 * 1024


@dataclass
class Conversation:
    """One ChatKit thread: its metadata and the host folder that keeps trusted copies."""

    thread: ThreadMetadata
    root: Path

    @property
    def id(self) -> str:
        return self.thread.id

    @property
    def metadata(self) -> dict:
        return self.thread.metadata

    @property
    def uploads(self) -> list[dict]:
        return self.metadata.get("uploads", [])

    @property
    def evidence(self) -> list[dict]:
        return self.metadata.get("evidence", [])

    def turn_dir(self, number: int) -> Path:
        return self.root / f"turn-{number}"

    def host_copy(self, entry: dict) -> Path:
        """The host's copy of a recorded upload or evidence file, taken before the model could change it."""
        return self.turn_dir(entry["turn"]) / entry["path"]


@dataclass
class TurnContext:
    """Given to an agent's harness tools for one turn."""

    conversation: Conversation
    turn: dict
    session: Any
    max_evidence_bytes: int = 1 * MIB

    async def record(self, label: str, text: str) -> str:
        """Keep a tool's output as evidence: a host copy for checks and a workspace file for the sandbox."""
        evidence = self.conversation.metadata.setdefault("evidence", [])
        data = text.encode()[: self.max_evidence_bytes]
        slug = "".join(char if char.isalnum() or char in "-_." else "-" for char in label)[:60].strip("-.") or "output"
        # The SDK runs parallel tool calls concurrently: take the number before the first await.
        path = f"evidence/{len(evidence) + 1:03d}-{slug}.txt"
        entry = {"path": path, "label": label, "turn": self.turn["number"], "bytes": len(data),
                 "sha256": hashlib.sha256(data).hexdigest()}
        evidence.append(entry)
        target = self.conversation.turn_dir(self.turn["number"]) / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        self.turn["files"].append({**{key: entry[key] for key in ("path", "bytes", "sha256")},
                                   "new": True, "changed": True, "evidence": True})
        await self.session.write(Path(path), io.BytesIO(data))
        return path


@dataclass(frozen=True)
class Processor:
    """Runs on an upload inside the sandbox before the model; its result is stored on the upload under ``key``."""

    key: str
    run: Callable[[Any, Conversation, dict], Awaitable[dict]]
    describe: Callable[[dict, dict], str]
    listing: Callable[[dict, dict], dict] = lambda info, entry: info


@dataclass(frozen=True)
class Uploads:
    """Accepted upload types: extension to MIME type, with limits and optional processors."""

    types: dict[str, str]
    hint: str
    max_bytes: int = 10 * MIB
    max_count: int = 5
    # Binary types must start with their signature; every other type must be UTF-8 text.
    signatures: dict[str, tuple[bytes, str]] = field(default_factory=dict)
    processors: dict[str, Processor] = field(default_factory=dict)


@dataclass(frozen=True)
class AgentSpec:
    """The agent example's part of a turn. The agent itself is the SandboxAgent ``build_agent`` returns."""

    name: str
    build_agent: Callable[[Manifest, Any], SandboxAgent]
    # (conversation, first message has uploads, workspace root) -> the new workspace's manifest
    start: Callable[[Conversation, bool, str], Manifest]
    instructions: Callable[[Conversation], str] = lambda conversation: ""
    tools: Callable[[TurnContext], list] = lambda turn: []
    uploads: Uploads | None = None
    check: Callable[[Conversation, dict, dict[str, bytes]], dict | None] = lambda conversation, turn, files: None
    collect: tuple[str, ...] = ("output", "work")
    default_question: str = "Continue."

    @property
    def trace_operations(self) -> tuple[str, str]:
        return f"{self.name}.turn", f"{self.name}.check"
