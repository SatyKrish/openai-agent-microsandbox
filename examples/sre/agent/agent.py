# Copyright 2026 openai-agent-mxc contributors
# SPDX-License-Identifier: Apache-2.0
"""Authored agent definition; the OpenAI SDK owns the model/tool loop."""

from pathlib import Path

from agents.sandbox import MemoryGenerateConfig, MemoryLayoutConfig, MemoryReadConfig, SandboxAgent
from agents.sandbox.capabilities import Compaction, Filesystem, LocalDirLazySkillSource, Memory, Shell, Skills
from agents.sandbox.capabilities.compaction import StaticCompactionPolicy
from agents.sandbox.entries import LocalDir

AGENT_ROOT = Path(__file__).resolve().parent
LAYOUT = MemoryLayoutConfig()
MEMORY_DIR = LAYOUT.memories_dir
# The GPT-6 counterparts of the SDK's defaults (gpt-5.4-mini, gpt-5.5): an efficient model extracts each
# conversation, a stronger one, the agent's own, consolidates them.
EXTRACT_MODEL = "gpt-6-luna"
CONSOLIDATE_MODEL = "gpt-6.1-terra"
# How many conversations consolidation draws on, the SDK's default; older ones are forgotten.
REMEMBERED_CONVERSATIONS = MemoryGenerateConfig().max_raw_memories_for_consolidation
# Context size at which the conversation is compacted. The SDK sizes this from the model's context window,
# but it does not know the gpt-6 models and falls back to 240k tokens; an investigation's reads are in
# evidence files, so its context can stay far smaller.
COMPACT_AT_TOKENS = 100_000


def memory(extract_model: str = EXTRACT_MODEL, consolidate_model: str = CONSOLIDATE_MODEL) -> Memory:
    """The SDK's memory, with its defaults except for the models and two choices of this agent's.

    The agent reads memory but does not edit it during a run (``live_update=False``): lessons
    come only from the SDK's extraction and consolidation, guided by memory.md, so text
    from a log cannot plant instructions in memory that later conversations would follow.
    """
    return Memory(
        layout=LAYOUT, read=MemoryReadConfig(live_update=False),
        generate=MemoryGenerateConfig(phase_one_model=extract_model, phase_two_model=consolidate_model,
                                      extra_prompt=(AGENT_ROOT / "memory.md").read_text(encoding="utf-8")),
    )


def build_agent(manifest, model, *, memory_models: tuple[str, str] | None = None):
    """Sandbox tools only: kubectl, the shell and Python all run in MXC containers on the sandbox worker.

    Compaction keeps a long investigation within the model's context; the SDK includes it by
    default, and an explicit capability list replaces the defaults, so it is listed here.
    ``memory_models`` (extraction, consolidation) turns on memory.
    """
    skills = Skills(lazy_from=LocalDirLazySkillSource(source=LocalDir(src=AGENT_ROOT / "skills")))
    capabilities = [Shell(), Filesystem(), Compaction(policy=StaticCompactionPolicy(threshold=COMPACT_AT_TOKENS)), skills]
    if memory_models:
        capabilities.append(memory(*memory_models))
    return SandboxAgent(
        name="SRE", model=model,
        instructions=(AGENT_ROOT / "instructions.md").read_text(encoding="utf-8"),
        default_manifest=manifest, capabilities=capabilities,
    )
