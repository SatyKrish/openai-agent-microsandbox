# Copyright 2026 openai-agent-mxc contributors
# SPDX-License-Identifier: Apache-2.0
"""What the shared harness needs beside the SandboxAgent: the workspace, the scope and the host check."""

from __future__ import annotations

from functools import partial
from pathlib import Path

from agents.sandbox import Manifest
from agents.sandbox.entries import Dir, File

from openai_harness.spec import AgentSpec

from .agent import AGENT_ROOT, MEMORY_DIR, build_agent
from .lib import findings
from .tools import logs

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


def issue_context(conversation) -> str:
    """What the agent is told about the issue a conversation is about: a lead to confirm from fresh reads.

    The fields are the worker's summary of the cluster, already kept short and printable when the issue opened.
    """
    issue = conversation.metadata.get("issue")
    if not issue:
        return ""
    reasons = ", ".join(issue.get("reasons") or []) or "no reason given"
    return (f"This conversation is an issue the health board opened at {issue['opened_at']}: "
            f"{issue['kind'].lower()} {issue['name']} in {issue['namespace']} was {issue['state_seen']} ({reasons}). "
            "Treat that as a lead and confirm it from fresh reads.")


def make_spec(namespaces, *, memory_models: tuple[str, str] | None = None) -> AgentSpec:
    """``memory_models`` (extraction, consolidation) turn on the SDK's memory; the harness keeps it per user."""
    scope = ", ".join(sorted(namespaces))
    return AgentSpec(
        name="sre",
        build_agent=partial(build_agent, memory_models=memory_models),
        memory_dir=MEMORY_DIR if memory_models else None,
        start=start,
        instructions=lambda conversation: "\n".join(
            line for line in (f"Namespaces you may read: {scope}.", issue_context(conversation)) if line),
        tools=logs.tools,
        check=lambda conversation, turn, files: findings.check(conversation, files),
        default_question=f"Find unhealthy workloads in {scope} and explain why.",
    )
