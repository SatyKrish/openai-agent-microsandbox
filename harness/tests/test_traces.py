# Copyright 2026 openai-agent-mxc contributors
# SPDX-License-Identifier: Apache-2.0
"""The trace panel's summary of a Jaeger trace with the worker provider's span names."""

from openai_harness import traces


def span(span_id, name, start_ms, duration_ms, parent=None, **tags):
    return {"spanID": span_id, "operationName": name, "startTime": start_ms * 1000, "duration": duration_ms * 1000,
            "references": [{"refType": "CHILD_OF", "spanID": parent}] if parent else [],
            "tags": [{"key": key, "value": value} for key, value in tags.items()]}


def test_workspace_setup_and_tool_commands_are_told_apart():
    payload = {"data": [{"traceID": "abc", "spans": [
        span("root", "agents.workflow", 0, 1000),
        span("init", "sandbox.init", 5, 20, "root"),
        span("mkdir", "sandbox.exec", 30, 100, "root", **{"sandbox.exit_code": 0}),
        span("write", "sandbox.write", 140, 10, "root"),
        span("model", "agents.response", 200, 300, "root", **{"gen_ai.usage.total_tokens": 1200}),
        span("tool", "tool.exec_command", 520, 150, "root"),
        span("exec", "sandbox.exec", 530, 120, "tool", **{"sandbox.exit_code": 1}),
    ]}]}
    summary = traces.summarize(payload)
    labels = [row["label"] for row in summary["rows"]]
    assert labels == ["sandbox.init", "workspace setup · 2 sandbox operations", "agents.response", "tool.exec_command"]
    assert summary["tools"]["failed"] == 1 and summary["model"]["total_tokens"] == 1200
    assert summary["rows"][-1]["badge"] == "exit 1"
