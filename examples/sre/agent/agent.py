# Copyright 2026 openai-agent-mxc contributors
# SPDX-License-Identifier: Apache-2.0
"""Authored agent definition; the OpenAI SDK owns the model/tool loop."""

from pathlib import Path

from agents.sandbox import SandboxAgent
from agents.sandbox.capabilities import Filesystem, LocalDirLazySkillSource, Shell, Skills
from agents.sandbox.entries import LocalDir

AGENT_ROOT = Path(__file__).resolve().parent


def build_agent(manifest, model):
    """Sandbox tools only: kubectl, the shell and Python all run in MXC containers on the sandbox worker."""
    skills = Skills(lazy_from=LocalDirLazySkillSource(source=LocalDir(src=AGENT_ROOT / "skills")))
    return SandboxAgent(
        name="SRE", model=model,
        instructions=(AGENT_ROOT / "instructions.md").read_text(encoding="utf-8"),
        default_manifest=manifest, capabilities=[Shell(), Filesystem(), skills],
    )
