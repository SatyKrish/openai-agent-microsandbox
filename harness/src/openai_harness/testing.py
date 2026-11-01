# Copyright 2026 openai-agent-substrate contributors
# SPDX-License-Identifier: Apache-2.0
"""Test helpers for agents on the harness: a scripted streaming model and ChatKit request helpers."""

from __future__ import annotations

import asyncio
import json
import uuid

from agents.items import ModelResponse
from agents.models.interface import Model
from agents.usage import Usage
from openai.types.responses import (
    Response, ResponseCompletedEvent, ResponseFunctionToolCall, ResponseOutputItemAddedEvent,
    ResponseOutputItemDoneEvent, ResponseOutputMessage, ResponseOutputText,
)


def shell(command: str) -> tuple[str, dict]:
    return "exec_command", {"cmd": command, "login": False}


class Calls(Model):
    """Calls each (tool, arguments) once per user message in order, then answers; ``delay`` slows each call."""

    def __init__(self, calls=(), answer="Done.", delay: float = 0):
        self.calls = list(calls)
        self.answer = answer
        self.delay = delay
        self.outputs: list[str] = []
        self.inputs: list[list] = []

    def response(self, input) -> ModelResponse:
        self.inputs.append(list(input))
        # Count the tool results that follow this turn's user message.
        last_user = max(index for index, item in enumerate(input) if isinstance(item, dict) and item.get("role") == "user")
        done = [item for item in input[last_user + 1:] if isinstance(item, dict) and item.get("type") == "function_call_output"]
        if done:
            output = done[-1]["output"]
            self.outputs.append(output if isinstance(output, str) else json.dumps(output))
        if len(done) < len(self.calls):
            name, arguments = self.calls[len(done)]
            output = [ResponseFunctionToolCall(id=f"fc_{uuid.uuid4().hex}", call_id=f"call_{uuid.uuid4().hex}",
                                               type="function_call", name=name, arguments=json.dumps(arguments))]
        else:
            output = [ResponseOutputMessage(id=f"msg_{uuid.uuid4().hex}", role="assistant", type="message", status="completed",
                                            content=[ResponseOutputText(type="output_text", annotations=[], text=self.answer)])]
        return ModelResponse(output=output, usage=Usage(), response_id=None)

    async def get_response(self, system_instructions, input, *args, **kwargs):
        return self.response(input)

    async def stream_response(self, system_instructions, input, *args, **kwargs):
        if self.delay:
            await asyncio.sleep(self.delay)
        response = self.response(input)
        sequence = 0
        for index, item in enumerate(response.output):
            yield ResponseOutputItemAddedEvent.model_construct(type="response.output_item.added", item=item,
                                                               output_index=index, sequence_number=sequence)
            yield ResponseOutputItemDoneEvent.model_construct(type="response.output_item.done", item=item,
                                                              output_index=index, sequence_number=sequence + 1)
            sequence += 2
        yield ResponseCompletedEvent.model_construct(type="response.completed", sequence_number=sequence, response=Response.model_construct(
            id=f"resp_{uuid.uuid4().hex}", output=list(response.output), usage=None, object="response", model="scripted"))


def message(text: str, attachments=()) -> dict:
    """A ChatKit user message input."""
    return {"content": [{"type": "input_text", "text": text}], "attachments": list(attachments), "inference_options": {}}


async def events(chat, payload: dict) -> list[dict]:
    """Send one ChatKit request to a harness server and collect its streamed events."""
    result = await chat.process(json.dumps(payload), {})
    collected = []
    async for chunk in result:
        collected += [json.loads(line[6:]) for line in chunk.decode().splitlines() if line.startswith("data: ")]
    return collected


def titles(stream: list[dict]) -> list[str]:
    """The titles of every workflow step in a stream, in order."""
    found = []
    for event in stream:
        item = event.get("item") or {}
        if item.get("type") == "workflow":
            found += [task.get("title") for task in item["workflow"]["tasks"]]
        task = (event.get("update") or {}).get("task")
        if task:
            found.append(task.get("title"))
    return found
