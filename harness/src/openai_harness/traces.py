# Copyright 2026 openai-agent-substrate contributors
# SPDX-License-Identifier: Apache-2.0
"""Reduce a Jaeger trace to the rows and totals the artifact panel shows."""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

LIFECYCLE = {"sandbox.create", "sandbox.resume", "sandbox.proxy", "sandbox.suspend", "sandbox.delete"}


def fetch_trace(query_url: str, otel_trace_id: str, timeout: float = 3):
    """Return the Jaeger payload, or None while the trace has not arrived yet."""
    url = query_url.rstrip("/") + "/api/traces/" + urllib.parse.quote(otel_trace_id, safe="")
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            payload = json.loads(response.read(16 * 1024 * 1024))
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise
    return payload if payload.get("data") else None


def summarize(payload: dict) -> dict:
    trace = payload["data"][0]
    spans = trace["spans"]
    by_id = {span["spanID"]: span for span in spans}

    def parent(span):
        return next((ref["spanID"] for ref in span.get("references", []) if ref.get("refType") == "CHILD_OF"), None)

    def tags(span):
        return {tag["key"]: tag["value"] for tag in span.get("tags", [])}

    def ancestors(span):
        seen = parent(span)
        while seen in by_id:
            yield by_id[seen]
            seen = parent(by_id[seen])

    start = min(span["startTime"] for span in spans)
    end = max(span["startTime"] + span["duration"] for span in spans)
    ordered = sorted(spans, key=lambda span: span["startTime"])
    first_model = next((span["startTime"] for span in ordered if span["operationName"] == "agents.response"), end)
    children: dict[str, list] = {}
    for span in spans:
        children.setdefault(parent(span), []).append(span)

    def exit_code(span):
        stack = list(children.get(span["spanID"], []))
        while stack:
            child = stack.pop(0)
            code = tags(child).get("sandbox.exit_code")
            if child["operationName"] == "sandbox.exec" and isinstance(code, int):
                return code
            stack.extend(children.get(child["spanID"], []))
        return None

    rows, staging = [], []
    model = {"calls": 0, "ms": 0.0, "input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
    tools = {"calls": 0, "failed": 0, "ms": 0.0}
    harness = {"calls": 0, "ms": 0.0}
    for span in ordered:
        name, values = span["operationName"], tags(span)
        offset, duration = (span["startTime"] - start) / 1000, span["duration"] / 1000
        row = {"label": name, "start_ms": round(offset, 1), "duration_ms": round(duration, 1),
               "kind": "life", "badge": None, "error": bool(values.get("error"))}
        if name == "agents.response":
            model["calls"] += 1
            model["ms"] += duration
            for key in ("input_tokens", "output_tokens", "total_tokens"):
                value = values.get("gen_ai.usage." + key)
                if isinstance(value, int):
                    model[key] += value
            row.update(kind="model", badge=f"{values.get('gen_ai.usage.total_tokens', 0):,} tok")
        elif name.startswith("tool."):
            tools["calls"] += 1
            tools["ms"] += duration
            code = exit_code(span) if name == "tool.exec_command" else None
            failed = bool(code) or row["error"]
            tools["failed"] += failed
            row.update(kind="error" if failed else ("skill" if name == "tool.load_skill" else "tool"),
                       badge=f"exit {code}" if code is not None else None, error=failed)
        elif name.startswith("harness_tool."):
            harness["calls"] += 1
            harness["ms"] += duration
            row.update(kind="harness")
        elif name in LIFECYCLE:
            pass
        elif name.endswith((".check", ".verify")):
            row.update(kind="check")
        elif name == "sandbox.exec" and span["startTime"] < first_model and not any(
                ancestor["operationName"].startswith("tool.") for ancestor in ancestors(span)):
            staging.append(span)
            continue
        else:
            continue
        rows.append(row)
    if staging:
        first = min(span["startTime"] for span in staging)
        last = max(span["startTime"] + span["duration"] for span in staging)
        rows.append({"label": f"workspace setup · {len(staging)} × sandbox.exec", "start_ms": round((first - start) / 1000, 1),
                     "duration_ms": round((last - first) / 1000, 1), "kind": "life", "badge": None, "error": False})
        rows.sort(key=lambda row: row["start_ms"])
    return {"trace_id": trace["traceID"], "span_count": len(spans), "duration_ms": round((end - start) / 1000, 1),
            "model": {**model, "ms": round(model["ms"], 1)}, "tools": {**tools, "ms": round(tools["ms"], 1)},
            "harness_tools": {**harness, "ms": round(harness["ms"], 1)}, "rows": rows}
