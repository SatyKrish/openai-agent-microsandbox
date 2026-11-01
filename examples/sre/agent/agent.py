# Copyright 2026 openai-agent-mxc contributors
# SPDX-License-Identifier: Apache-2.0
"""Authored agent definition; the OpenAI SDK owns the model/tool loop."""

from pathlib import Path

from agents.sandbox import MemoryGenerateConfig, MemoryLayoutConfig, MemoryReadConfig, SandboxAgent
from agents.sandbox.capabilities import Compaction, Filesystem, LocalDirLazySkillSource, Memory, Shell, Skills
from agents.sandbox.entries import LocalDir

AGENT_ROOT = Path(__file__).resolve().parent
MEMORY_DIR = "memories"


def memory(model: str) -> Memory:
    """The SDK's memory, distilled from each conversation when its session closes.

    The agent reads it but does not edit it during a run (``live_update=False``): lessons
    come only from the SDK's extraction and consolidation, guided by memory.md, so text
    from a log cannot plant instructions in memory that later conversations would follow.
    """
    return Memory(
        layout=MemoryLayoutConfig(memories_dir=MEMORY_DIR, sessions_dir="sessions"),
        read=MemoryReadConfig(live_update=False),
        generate=MemoryGenerateConfig(
            phase_one_model=model, phase_two_model=model, max_raw_memories_for_consolidation=64,
            phase_two_max_turns=40, extra_prompt=(AGENT_ROOT / "memory.md").read_text(encoding="utf-8")),
    )


def build_agent(manifest, model, *, memory_model: str | None = None):
    """Sandbox tools only: kubectl, the shell and Python all run in MXC containers on the sandbox worker.

    Compaction keeps a long investigation within the model's context; the SDK includes it by
    default, and an explicit capability list replaces the defaults, so it is listed here.
    """
    skills = Skills(lazy_from=LocalDirLazySkillSource(source=LocalDir(src=AGENT_ROOT / "skills")))
    capabilities = [Shell(), Filesystem(), Compaction(), skills]
    if memory_model:
        capabilities.append(memory(memory_model))
    return SandboxAgent(
        name="SRE", model=model,
        instructions=(AGENT_ROOT / "instructions.md").read_text(encoding="utf-8"),
        default_manifest=manifest, capabilities=capabilities,
    )
