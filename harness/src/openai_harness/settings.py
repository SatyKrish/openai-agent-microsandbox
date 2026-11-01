# Copyright 2026 openai-agent-substrate contributors
# SPDX-License-Identifier: Apache-2.0
"""Model settings for a harness launcher: OPENAI_* values from the environment or a local .env file."""

from __future__ import annotations

import os
import re
from pathlib import Path


def load_env_file(path: Path) -> None:
    """Read plain OPENAI_* KEY=VALUE lines; the file is never executed and never overrides the environment."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        key, separator, value = line.strip().partition("=")
        if separator and re.fullmatch(r"OPENAI_[A-Z0-9_]+", key) and key not in os.environ and value:
            os.environ[key] = value


def live_model(requested: str | None = None) -> str:
    """The live model to run; the harness UIs never fall back to a scripted model."""
    model = requested or os.environ.get("OPENAI_MODEL")
    if not model or model == "scripted":
        raise ValueError("Set OPENAI_MODEL or pass --model with a live OpenAI model")
    if not os.environ.get("OPENAI_API_KEY"):
        raise ValueError("Set OPENAI_API_KEY in the trusted harness environment before running a live model")
    return model
