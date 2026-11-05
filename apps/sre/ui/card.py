# Copyright 2026 openai-agent-microsandbox contributors
# SPDX-License-Identifier: Apache-2.0
"""What this agent's UI says about a turn's evidence check: the rows on the turn card and each file's status.

The check finds each quote in the evidence it cites; it does not judge the cause drawn from it, and the
card says so. A finding with a quote that was not found is unverified, and a correction after a failed
first check is shown as one.
"""

from __future__ import annotations


def _plural(count: int, word: str) -> str:
    return f"{count} {word}{'s' if count != 1 else ''}"


def _finding_rows(check: dict) -> list[dict]:
    rows = []
    for item in check.get("summary") or []:
        children = [{"type": "Text", "size": "sm", "weight": "semibold", "value": item["problem"] or "Finding"},
                    {"type": "Text", "size": "sm", "color": "secondary", "value": item["resource"]}]
        if item.get("verified") is False:
            children.append({"type": "Badge", "variant": "outline", "color": "danger", "label": "Unverified"})
        rows.append({"type": "Row", "gap": 2, "wrap": "wrap", "children": children})
    return rows


def check_rows(conversation, turn: dict, changed: set[str]) -> list[dict]:
    """One badge for the check's result, each finding as a line, and what the check does not cover."""
    check = turn.get("check") or {}
    first = turn.get("check_first") or {}
    rows = []
    fresh = "output/findings.json" in changed
    if first:
        rows.append({"type": "Text", "size": "sm", "color": "secondary", "value":
                     f"First check: {first.get('detail', 'failed')}. The agent re-read its sources and corrected the "
                     "findings, and they were checked again."})
    if check.get("status") == "evidence_passed" and fresh:
        count, quotes = check["findings"], check["quotes"]
        rows.append({"type": "Row", "children": [{"type": "Badge", "variant": "soft", "color": "success", "label":
                     f"{_plural(count, 'finding')}, {_plural(quotes, 'quote')} found in the evidence"}]})
        rows += _finding_rows(check)
        rows.append({"type": "Text", "size": "sm", "color": "secondary",
                     "value": "The check finds the quotes; the causes are the agent's reasoning."})
    elif check.get("status") == "evidence_passed":
        rows.append({"type": "Row", "children": [{"type": "Badge", "variant": "soft", "color": "secondary",
                     "label": "No new findings this turn"}]})
    elif check.get("status") == "failed":
        rows.append({"type": "Row", "children": [{"type": "Badge", "variant": "soft", "color": "danger",
                     "label": f"Evidence check failed: {check.get('detail', '')}"}]})
        rows += _finding_rows(check)
        for failure in (check.get("failures") or [])[:3]:
            where = f" in {failure['file']}" if failure.get("file") else ""
            quote = f"“{failure['quote']}”" if failure.get("quote") else ""
            rows.append({"type": "Text", "size": "sm", "value": f"{quote}{where}: {failure['reason']}".strip(": ")})
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
