# Copyright 2026 openai-agent-mxc contributors
# SPDX-License-Identifier: Apache-2.0
"""What this agent's UI says about a turn's evidence check: the rows on the turn card and each file's status."""

from __future__ import annotations


def check_rows(conversation, turn: dict, changed: set[str]) -> list[dict]:
    check = turn.get("check") or {}
    evidence = sum(1 for item in turn["files"] if item.get("evidence"))
    rows = []
    if evidence:
        rows.append({"type": "Text", "size": "sm", "color": "secondary", "value":
                     f"{evidence} read{'s' if evidence != 1 else ''} recorded as evidence by the sandbox worker."})
    fresh = "output/findings.json" in changed
    if check.get("status") == "evidence_passed" and fresh:
        count, quotes = check["findings"], check["quotes"]
        rows.append({"type": "Row", "children": [{"type": "Badge", "variant": "soft", "color": "success", "label":
                     f"{count} finding{'s' if count != 1 else ''} · {quotes} quote{'s' if quotes != 1 else ''} match the evidence"}]})
        if check.get("summary"):
            rows.append({"type": "Row", "gap": 2, "wrap": "wrap", "children": [
                {"type": "Badge", "variant": "outline", "color": "danger" if item["problem"] else "secondary",
                 "label": f"{item['resource']} · {item['problem']}" if item["problem"] else item["resource"]}
                for item in check["summary"]]})
        rows.append({"type": "Text", "size": "sm", "color": "secondary", "value":
                     "Fixes are proposals; this agent cannot change the cluster."})
    elif check.get("status") == "evidence_passed":
        rows.append({"type": "Row", "children": [{"type": "Badge", "variant": "soft", "color": "secondary",
                     "label": "No new findings this turn"}]})
    elif check.get("status") == "failed":
        rows.append({"type": "Row", "children": [{"type": "Badge", "label": "Evidence check failed", "color": "danger",
                     "variant": "soft"}]})
        rows.append({"type": "Text", "size": "sm", "value": check.get("detail", "")})
    elif check.get("status") == "no_findings" and any(path.startswith("output/") for path in changed):
        rows.append({"type": "Row", "children": [{"type": "Badge", "variant": "soft", "color": "warning",
                     "label": "No findings.json to check"}]})
    return rows


def file_status(conversation, turn: dict) -> dict[str, dict]:
    """Which of this turn's files the host checked, for the file list."""
    check = turn.get("check") or {}
    status = {}
    for item in turn["files"]:
        path = item["path"]
        if item.get("evidence"):
            status[path] = {"state": "source", "label": f"recorded by the worker · {item.get('command', 'kubectl')}"}
        elif not path.startswith("output/"):
            continue
        elif path == "output/findings.json" and check.get("status") == "evidence_passed":
            status[path] = {"state": "checked", "label": "quotes checked against the evidence"}
        elif path == "output/findings.json" and check.get("status") == "failed":
            status[path] = {"state": "failed", "label": "evidence check failed"}
        else:
            status[path] = {"state": "unchecked", "label": "not checked on the host · fixes are proposals"}
    return status
