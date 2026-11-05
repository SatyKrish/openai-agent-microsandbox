# Copyright 2026 openai-agent-microsandbox contributors
# SPDX-License-Identifier: Apache-2.0
"""The agent's only way to read pod logs: the sandbox worker's log policy.

VMs cannot read logs (the worker's API proxy refuses them), so raw logs
never reach the workspace or the model. The worker fetches a log with its own
identity and returns an excerpt: error and warning lines with context, the last
lines, repeats collapsed, credentials and personal data masked, size capped. It
records the excerpt as evidence and saves it under evidence/ in the workspace.
"""

from __future__ import annotations

import re

from agents import function_tool

from sandbox_worker import WorkerError

TOOL_NAMES = ("pod_logs",)
_SINCE = re.compile(r"(\d+)\s*([smhd])")
_SECONDS = {"s": 1, "m": 60, "h": 3600, "d": 86400}


def since_seconds(since: str | None) -> int:
    """``10m``, ``1h30m`` or ``45s`` as seconds; 0 for none. At most a week."""
    if not since:
        return 0
    parts = _SINCE.findall(since.lower())
    if not parts or _SINCE.sub("", since.lower()).strip():
        raise ValueError(f"since={since!r}: use a duration such as 10m, 1h or 1h30m")
    return min(sum(int(amount) * _SECONDS[unit] for amount, unit in parts), 7 * 86400)


def tools(turn) -> list:
    """This turn's log tool; ``turn`` is the harness's TurnContext."""

    @function_tool
    async def pod_logs(pod: str, namespace: str, container: str | None = None, previous: bool = False,
                       tail: int = 500, match: str | None = None, since: str | None = None) -> str:
        """Read a pod's log as an excerpt: errors and warnings with context, the last lines, repeats collapsed,
        credentials and personal data masked. You never see the raw log.

        Args:
            pod: A pod name, or deploy/NAME for the deployment's pod most likely failing (not ready, then most
                restarted, then newest).
            namespace: A namespace in this agent's scope.
            container: The container, when the pod has more than one.
            previous: Read the last terminated container instead; use this for crash loops.
            tail: How many lines to read from the end before filtering, up to 5000.
            match: Literal text to look for; matching lines are always shown.
            since: Only lines from this long ago, such as 10m, 1h or 1h30m.
        """
        try:
            seconds = since_seconds(since)
        except ValueError as error:
            return f"Refused: {error}"
        try:
            reply = await turn.session._inner.read_logs(namespace, pod, container=container, previous=previous,
                                                        tail_lines=max(1, min(int(tail), 5000)), match=match,
                                                        since_seconds=seconds)
        except WorkerError as error:
            return f"Refused: {error.details}"
        return f"{reply['excerpt']}\nSaved as {reply['evidence_path']}."

    return [pod_logs]
