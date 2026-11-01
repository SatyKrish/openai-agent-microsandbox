# Copyright 2026 openai-agent-mxc contributors
# SPDX-License-Identifier: Apache-2.0
"""The agent's only way to read pod logs: the sandbox worker's log policy.

Containers cannot read logs (the worker's API proxy refuses them), so raw logs
never reach the workspace or the model. The worker fetches a log with its own
identity and returns an excerpt: error and warning lines with context, the last
lines, repeats collapsed, credentials and personal data masked, size capped. It
records the excerpt as evidence and saves it under evidence/ in the workspace.
"""

from __future__ import annotations

from agents import function_tool

from agent_mxc import WorkerError

TOOL_NAMES = ("pod_logs",)


def tools(turn) -> list:
    """This turn's log tool; ``turn`` is the harness's TurnContext."""

    @function_tool
    async def pod_logs(pod: str, namespace: str, container: str | None = None, previous: bool = False,
                       tail: int = 500, match: str | None = None) -> str:
        """Read a pod's log as an excerpt: errors and warnings with context, the last lines, repeats collapsed,
        credentials and personal data masked. You never see the raw log.

        Args:
            pod: A pod name, or deploy/NAME for the deployment's newest pod.
            namespace: A namespace in this agent's scope.
            container: The container, when the pod has more than one.
            previous: Read the last terminated container instead; use this for crash loops.
            tail: How many lines to read from the end before filtering, up to 5000.
            match: Literal text to look for; matching lines are always shown.
        """
        try:
            reply = await turn.session._inner.read_logs(namespace, pod, container=container, previous=previous,
                                                        tail_lines=max(1, min(int(tail), 5000)), match=match)
        except WorkerError as error:
            return f"Refused: {error.details}"
        return f"{reply['excerpt']}\nSaved as {reply['evidence_path']}."

    return [pod_logs]
