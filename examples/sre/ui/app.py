# Copyright 2026 openai-agent-mxc contributors
# SPDX-License-Identifier: Apache-2.0
"""This agent's UI: the harness's shared page, configured here."""

from __future__ import annotations

from pathlib import Path

from openai_harness import http
from openai_harness.chat import HarnessChatServer

# What the shared page shows for this agent; __main__ adds the model, namespaces and prompts.
UI = {
    "title": "SRE agent",
    "icon": "pulse",
    "new_label": "New investigation",
    "greeting": "Investigate unhealthy workloads from an isolated, read-only sandbox",
    "intro": "Every command the agent runs starts in its own Microsoft eXecution Container on this application's "
             "sandbox worker. kubectl there uses the worker's read-only identity and reaches only the Kubernetes API; "
             "the worker never holds the model's API key. Plain kubectl reads are recorded as evidence in the "
             "worker's journal, which no container can edit, and after every turn the harness checks each quote in "
             "findings.json against that copy. The agent proposes fixes; it cannot apply them.",
    "starting_note": "Seeded into every new workspace: the application team's runbooks.",
    "follow_ups": [
        {"label": "How would I fix it?", "prompt": "For each finding, propose the smallest fix as commands I could run "
                                                   "myself. Don't run anything."},
        {"label": "What else could explain it?", "prompt": "What else could explain these failures? Check the evidence "
                                                           "for anything you ruled out too quickly."},
    ],
}


STATIC = Path(__file__).resolve().parent / "static"


def create_app(server: HarnessChatServer, *, config: dict, port: int, jaeger_url: str | None, worker=None,
               health=None, user_header: str | None = None, starting_files: dict[str, bytes] | None = None):
    """``health`` is the worker's summary of its namespaces, shown on the start screen and never sent to the
    model. ``user_header`` carries the signed-in user from an authenticating proxy, whose memory the page
    shows; without it everyone is the guest."""
    return http.ui_application(server, config={**UI, **config}, port=port, jaeger_url=jaeger_url, worker=worker,
                               health=health, user_header=user_header, starting_files=starting_files, static=STATIC)
