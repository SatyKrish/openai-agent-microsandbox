# Copyright 2026 openai-agent-substrate contributors
# SPDX-License-Identifier: Apache-2.0
"""How a tool call reads as a step: its title, where it ran, and its text fenced as untrusted."""

from __future__ import annotations

import json
import re

_EXIT_CODE = re.compile(r"Process exited with code (-?\d+)")
_TASK_TEXT = 1600
# Where a tool ran, shown on its step: harness tools hold credentials, sandbox tools run in an MXC container.
# The icon says it for every step; the title names only the exception, the harness.
ICONS = {"harness": "keys", "sandbox": "cube"}


def fenced(text: str, language: str = "") -> str:
    """Fence untrusted text as code, so a UI never renders it as Markdown."""
    longest = max((len(run) for run in re.findall(r"`+", text)), default=0)
    fence = "`" * max(3, longest + 1)
    return f"{fence}{language}\n{text}\n{fence}"


def clipped(text: str, limit: int = _TASK_TEXT) -> str:
    return text if len(text) <= limit else text[:limit] + f"\n… {len(text) - limit} more characters"


def _field(raw, name):
    return raw.get(name) if isinstance(raw, dict) else getattr(raw, name, None)


def describe_call(raw) -> tuple[str, str, str]:
    """Tool name, call id and a short, human-readable view of the call arguments."""
    name = _field(raw, "name") or _field(raw, "type") or "tool"
    call_id = _field(raw, "call_id") or _field(raw, "id") or ""
    arguments = _field(raw, "arguments")
    if arguments is None:
        arguments = _field(raw, "input") or ""
    if isinstance(arguments, str):
        try:
            parsed = json.loads(arguments)
        except ValueError:
            parsed = None
        if isinstance(parsed, dict):
            arguments = parsed.get("cmd") or parsed.get("skill_name") or json.dumps(parsed)
    elif isinstance(arguments, dict):
        arguments = arguments.get("cmd") or arguments.get("skill_name") or json.dumps(arguments)
    return str(name), str(call_id), str(arguments)


def headline(name: str, raw) -> str:
    """What a step did, in one line: the command it ran, or the tool and its main arguments."""
    arguments = _field(raw, "arguments")
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments)
        except ValueError:
            arguments = None
    if not isinstance(arguments, dict):
        return name
    if isinstance(arguments.get("cmd"), str):
        line = " ".join(arguments["cmd"].split())
        return line if len(line) <= 90 else line[:89] + "…"
    if isinstance(arguments.get("skill_name"), str):
        return f"{name} {arguments['skill_name']}"
    if name == "pod_logs" and isinstance(arguments.get("pod"), str):
        flags = [f"-n {arguments['namespace']}" if arguments.get("namespace") else "",
                 f"-c {arguments['container']}" if arguments.get("container") else "",
                 "--previous" if arguments.get("previous") else "",
                 f"match={json.dumps(arguments['match'])}" if arguments.get("match") else ""]
        return " ".join(part for part in (name, arguments["pod"], *flags) if part)
    return name


def step_title(name: str, where: str, status: str = "", summary: str = "") -> str:
    """``kubectl logs api -n payments · exit 1``: what ran, and only what is unusual about it, a failure or a
    harness tool; a sandbox command that exited 0 is just its command."""
    return " · ".join(part for part in (summary or name, "" if status == "exit 0" else status,
                                        "harness" if where == "harness" else "") if part)


def describe_output(output) -> tuple[str, str]:
    """A status suffix (exit code) and the readable part of a tool's output."""
    text = output if isinstance(output, str) else json.dumps(output, default=str)
    match = _EXIT_CODE.search(text)
    status = f"exit {match[1]}" if match else ""
    if "\nOutput:\n" in text:
        text = text.split("\nOutput:\n", 1)[1]
    return status, text.strip()
