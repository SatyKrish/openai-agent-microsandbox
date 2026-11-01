# Copyright 2026 openai-agent-substrate contributors
# SPDX-License-Identifier: Apache-2.0
"""Tool calls as ChatKit workflow steps, with untrusted text fenced."""

from __future__ import annotations

import json
import re
from datetime import datetime

from chatkit.agents import AgentContext
from chatkit.types import CustomTask, UserMessageItem, Workflow, WorkflowItem

_EXIT_CODE = re.compile(r"Process exited with code (-?\d+)")
_TASK_TEXT = 1600
# Where a tool ran, shown on its step: harness tools hold credentials, sandbox tools run in an MXC container.
ICONS = {"harness": "keys", "sandbox": "cube"}


def fenced(text: str, language: str = "") -> str:
    """Fence untrusted text as code, so ChatKit never renders it as Markdown."""
    longest = max((len(run) for run in re.findall(r"`+", text)), default=0)
    fence = "`" * max(3, longest + 1)
    return f"{fence}{language}\n{text}\n{fence}"


def clipped(text: str, limit: int = _TASK_TEXT) -> str:
    return text if len(text) <= limit else text[:limit] + f"\n… {len(text) - limit} more characters"


def user_text(item: UserMessageItem) -> str:
    return "\n".join(part.text for part in item.content if getattr(part, "type", None) == "input_text").strip()


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
    """``kubectl get pods -n payments · exit 0 · sandbox``: what ran, how it ended, and where."""
    return " · ".join(part for part in (summary or name, status, where) if part)


def describe_output(output) -> tuple[str, str]:
    """A status suffix (exit code) and the readable part of a tool's output."""
    text = output if isinstance(output, str) else json.dumps(output, default=str)
    match = _EXIT_CODE.search(text)
    status = f"exit {match[1]}" if match else ""
    if "\nOutput:\n" in text:
        text = text.split("\nOutput:\n", 1)[1]
    return status, text.strip()


class ToolSteps:
    """Adds tool calls to ChatKit's workflow while ChatKit converts the model stream.

    ChatKit's converter renders assistant messages and reasoning but not tool calls,
    and it only reads ``stream_events()`` from the run result.
    """

    def __init__(self, result, context: AgentContext, record: list, harness_tools: frozenset[str] = frozenset()):
        self.result = result
        self.context = context
        self.record = record
        self.harness_tools = harness_tools

    async def stream_events(self):
        pending: dict[str, tuple[WorkflowItem, int, str, str, str]] = {}
        async for event in self.result.stream_events():
            if getattr(event, "type", None) == "run_item_stream_event":
                if event.name == "tool_called":
                    name, call_id, arguments = describe_call(event.item.raw_item)
                    where = "harness" if name in self.harness_tools else "sandbox"
                    summary = headline(name, event.item.raw_item)
                    task = CustomTask(title=step_title(name, where, summary=summary), icon=ICONS[where],
                                      content=fenced(clipped(arguments)), status_indicator="loading")
                    if self.context.workflow_item is None:
                        # Open while the agent works; ChatKit collapses it into "Worked for …" when it ends.
                        self.context.workflow_item = WorkflowItem(
                            id=self.context.generate_id("workflow"), created_at=datetime.now(),
                            thread_id=self.context.thread.id, workflow=Workflow(type="custom", tasks=[], expanded=True))
                    await self.context.add_workflow_task(task)
                    workflow = self.context.workflow_item
                    pending[call_id] = (workflow, workflow.workflow.tasks.index(task), name, where, summary)
                    self.record.append({"tool": name, "status": "running", "where": where, "summary": summary})
                elif event.name == "tool_output":
                    call_id = _field(event.item.raw_item, "call_id") or ""
                    if call_id in pending:
                        workflow, index, name, where, summary = pending.pop(call_id)
                        status, text = describe_output(event.item.output)
                        # The call's arguments are already in the task; the output follows them.
                        content = workflow.workflow.tasks[index].content or ""
                        if text:
                            content += "\n\n" + fenced(clipped(text))
                        task = CustomTask(title=step_title(name, where, status, summary), icon=ICONS[where],
                                          content=content, status_indicator="complete")
                        for entry in reversed(self.record):
                            if entry["tool"] == name and entry["status"] == "running":
                                entry["status"] = status or "done"
                                break
                        if self.context.workflow_item is workflow:
                            await self.context.update_workflow_task(task, index)
            yield event
