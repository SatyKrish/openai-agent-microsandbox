# Copyright 2026 openai-agent-mxc contributors
# SPDX-License-Identifier: Apache-2.0
"""What this agent's UI says about a turn's evidence check: the rows on the turn card and each file's status."""

from __future__ import annotations


def _plural(count: int, word: str) -> str:
    return f"{count} {word}{'s' if count != 1 else ''}"


def check_rows(conversation, turn: dict, changed: set[str]) -> list[dict]:
    """One badge for the check's result, then each finding as a line of text: its problem and resource."""
    check = turn.get("check") or {}
    rows = []
    fresh = "output/findings.json" in changed
    if check.get("status") == "evidence_passed" and fresh:
        count, quotes = check["findings"], check["quotes"]
        rows.append({"type": "Row", "children": [{"type": "Badge", "variant": "soft", "color": "success", "label":
                     f"{_plural(count, 'finding')}, {_plural(quotes, 'quote')} found in the evidence"}]})
        for item in check.get("summary") or []:
            rows.append({"type": "Row", "gap": 2, "wrap": "wrap", "children": [
                {"type": "Text", "size": "sm", "weight": "semibold", "value": item["problem"] or "Finding"},
                {"type": "Text", "size": "sm", "color": "secondary", "value": item["resource"]}]})
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
            status[path] = {"state": "source", "label": f"evidence: {item.get('command', 'kubectl')}"}
        elif not path.startswith("output/"):
            continue
        elif path == "output/findings.json" and check.get("status") == "evidence_passed":
            status[path] = {"state": "checked", "label": "quotes checked"}
        elif path == "output/findings.json" and check.get("status") == "failed":
            status[path] = {"state": "failed", "label": "evidence check failed"}
        else:
            status[path] = {"state": "unchecked", "label": "not checked"}
    return status
