# Copyright 2026 openai-agent-substrate contributors
# SPDX-License-Identifier: Apache-2.0
"""Test helpers for agents on the harness: a scripted streaming model, and asking a harness a question."""

from __future__ import annotations

import asyncio
import json
import uuid

from agents.items import ModelResponse
from agents.models.interface import Model
from agents.usage import Usage
from openai.types.responses import (
    Response, ResponseCompletedEvent, ResponseFunctionToolCall, ResponseOutputItemAddedEvent,
    ResponseOutputItemDoneEvent, ResponseOutputMessage, ResponseOutputText, ResponseUsage,
)
from openai.types.responses.response_usage import InputTokensDetails, OutputTokensDetails

from .store import Thread


def shell(command: str) -> tuple[str, dict]:
    return "exec_command", {"cmd": command, "login": False}


class Calls(Model):
    """Calls each (tool, arguments) once per user message in order, then answers; ``delay`` slows each call.

    A list of (tool, arguments) in ``calls`` is one step whose calls the model makes in parallel.
    """

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
        steps = [step if isinstance(step, list) else [step] for step in self.calls]
        made = 0
        for step in steps:
            if made == len(done):
                break
            made += len(step)
        else:
            step = None
        if step is not None and made == len(done):
            output = [ResponseFunctionToolCall(id=f"fc_{uuid.uuid4().hex}", call_id=f"call_{uuid.uuid4().hex}",
                                               type="function_call", name=name, arguments=json.dumps(arguments))
                      for name, arguments in step]
        else:
            output = [ResponseOutputMessage(id=f"msg_{uuid.uuid4().hex}", role="assistant", type="message", status="completed",
                                            content=[ResponseOutputText(type="output_text", annotations=[], text=self.answer)])]
        # A rough token count, about four characters each, so turns record a plausible use.
        size = len(json.dumps(input, default=str)) // 4
        return ModelResponse(output=output, usage=Usage(requests=1, input_tokens=size, output_tokens=20,
                                                        total_tokens=size + 20), response_id=None)

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
        usage = ResponseUsage.model_construct(
            input_tokens=response.usage.input_tokens, output_tokens=response.usage.output_tokens,
            total_tokens=response.usage.total_tokens, input_tokens_details=InputTokensDetails.model_construct(cached_tokens=0),
            output_tokens_details=OutputTokensDetails.model_construct(reasoning_tokens=0))
        yield ResponseCompletedEvent.model_construct(type="response.completed", sequence_number=sequence, response=Response.model_construct(
            id=f"resp_{uuid.uuid4().hex}", output=list(response.output), usage=usage, object="response", model="scripted"))


async def ask(harness, text: str, *, conversation: str | None = None, user: str | None = None) -> tuple[str, list[dict]]:
    """Send ``text`` as ``user`` (the guest by default), as a UI request would, in a new conversation unless
    ``conversation`` names one; returns the conversation and the events of the turn that answered it.

    A turn that fails ends with an ``error`` event; someone else's conversation raises ``NotFound``."""
    context = {"user": user}
    if conversation is None:
        thread = Thread.new()
        await harness.store.save_thread(thread, context)
        conversation = thread.id
    else:
        await harness.store.load_thread(conversation, context)
    with harness.listen(conversation) as queue:
        sent = await harness.send(conversation, text, requester=user)
        await asyncio.wait({sent.turn})
        collected = []
        while not queue.empty():
            collected.append(queue.get_nowait())
    return conversation, collected


def entries(events: list[dict], kind: str) -> list[dict]:
    """The transcript entries of one kind in a list of events, each as it last was, in order."""
    found: dict[str, dict] = {}
    for event in events:
        entry = event.get("entry") or {}
        if entry.get("kind") == kind:
            found[entry["id"]] = entry
    return list(found.values())


def titles(events: list[dict]) -> list[str]:
    """The titles of every step in a list of events, in order."""
    return [step["title"] for entry in entries(events, "steps") for step in entry["steps"]]
