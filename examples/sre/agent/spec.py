# Copyright 2026 openai-agent-mxc contributors
# SPDX-License-Identifier: Apache-2.0
"""What the shared harness needs beside the SandboxAgent: the workspace, the scope and the host check."""

from __future__ import annotations

from pathlib import Path

from agents.sandbox import Manifest
from agents.sandbox.entries import Dir, File

from openai_harness.spec import AgentSpec

from .agent import AGENT_ROOT, build_agent
from .lib import findings

# The panel opens this file after a turn that changed it.
REPORT = "output/findings.md"
RUNBOOKS = AGENT_ROOT / "runbooks"


def runbooks() -> dict[str, bytes]:
    """The application team's runbooks, seeded into every new workspace."""
    return {f"runbooks/{path.name}": path.read_bytes() for path in sorted(RUNBOOKS.glob("*.md"))}


def start(conversation, has_uploads: bool, root: str) -> Manifest:
    books = {Path(path).name: File(content=data) for path, data in runbooks().items()}
    return Manifest(root=root, entries={"evidence": Dir(), "output": Dir(), "work": Dir(),
                                        "runbooks": Dir(children=books)})


def make_spec(namespaces) -> AgentSpec:
    scope = ", ".join(sorted(namespaces))
    return AgentSpec(
        name="sre",
        build_agent=build_agent,
        start=start,
        instructions=lambda conversation: f"Namespaces you may read: {scope}.",
        check=lambda conversation, turn, files: findings.check(conversation, files),
        default_question=f"Find unhealthy workloads in {scope} and explain why.",
    )
