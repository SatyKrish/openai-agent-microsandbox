# Copyright 2026 openai-agent-substrate contributors
# SPDX-License-Identifier: Apache-2.0
"""Host check of output/findings.json: every quote must appear in the host's copy of the evidence it cites.

The host copies come from the sandbox worker's journal, which no container can see, so
editing evidence/ inside the sandbox cannot make a quote pass. Every quote is checked, and
each finding is verified only when all of its quotes are found. Finding a quote proves the
evidence says it; the cause drawn from it is the agent's reasoning, which no check verifies.
"""

from __future__ import annotations

import json
import re

_SHOWN = 160


def _normal(text: str) -> str:
    return " ".join(text.split())


def _short(text: str, shown: int = _SHOWN) -> str:
    return text if len(text) <= shown else text[:shown] + "…"


def check(conversation, files: dict[str, bytes]) -> dict:
    outputs = {name.removeprefix("output/"): data for name, data in files.items() if name.startswith("output/")}
    unchecked = sorted(name for name in outputs if name != "findings.json")
    if "findings.json" not in outputs:
        return {"status": "no_findings", "unchecked": unchecked}
    try:
        findings = json.loads(outputs["findings.json"])["findings"]
        if not isinstance(findings, list):
            raise TypeError
    except (ValueError, KeyError, TypeError):
        return {"status": "failed", "detail": "output/findings.json has no findings list.", "unchecked": unchecked,
                "failures": [{"resource": None, "reason": "output/findings.json has no findings list."}]}
    if not findings:
        return {"status": "no_findings", "unchecked": unchecked}
    evidence = {entry["path"]: entry for entry in conversation.evidence}
    texts: dict[str, str] = {}
    results, failures, resources = [], [], []
    for finding in findings:
        if not isinstance(finding, dict):
            failures.append({"resource": None, "reason": "A finding is not an object."})
            continue
        resource = _short(str(finding.get("resource") or "a finding"), 79)
        quotes = []
        cited = finding.get("evidence")
        if not isinstance(cited, list) or not cited:
            failures.append({"resource": resource, "reason": f"{resource} cites no evidence."})
        for item in cited if isinstance(cited, list) else []:
            path = item.get("file") if isinstance(item, dict) else None
            quote = item.get("quote") if isinstance(item, dict) else None
            reason = None
            if path not in evidence:
                reason = "the sandbox worker never recorded this file"
            elif not isinstance(quote, str) or not _normal(quote):
                reason = "the quote is empty"
            else:
                if path not in texts:
                    text = conversation.host_copy(evidence[path]).read_text(encoding="utf-8", errors="replace")
                    # A log excerpt numbers its lines ("   12| ..."); quotes may span lines without the numbers.
                    texts[path] = _normal(re.sub(r"(?m)^ *\d+\| ", "", text))
                if _normal(quote) not in texts[path]:
                    reason = "not in the file"
            entry = {"file": str(path)[:200], "quote": _short(str(quote or "")), "found": reason is None,
                     "recorded_at": (evidence.get(path) or {}).get("recorded_at")}
            if reason:
                entry["reason"] = reason
                failures.append({"resource": resource, "file": entry["file"], "quote": entry["quote"], "reason": reason})
            quotes.append(entry)
        verified = bool(quotes) and all(item["found"] for item in quotes)
        resources.append(resource)
        results.append({"resource": resource, "problem": str(finding.get("problem") or "")[:60], "verified": verified,
                        "quotes": quotes})
    found = sum(item["found"] for result in results for item in result["quotes"])
    total = sum(len(result["quotes"]) for result in results)
    summary = [{"resource": result["resource"], "problem": result["problem"], "verified": result["verified"]}
               for result in results[:12]]
    common = {"findings": len(findings), "quotes": found, "quotes_total": total, "resources": resources,
              "unchecked": unchecked, "summary": summary, "results": results}
    if failures:
        missing = total - found
        detail = f"{missing} of {total} quotes not found" if missing else failures[0]["reason"]
        return {"status": "failed", "detail": detail, "failures": failures[:40], **common}
    return {"status": "evidence_passed", **common}


def retry_prompt(check: dict) -> str | None:
    """What the agent is asked once when the check fails: re-read each cited file and correct the findings."""
    if check.get("status") != "failed" or not check.get("failures"):
        return None
    lines = []
    for failure in check["failures"][:10]:
        if failure.get("file"):
            lines.append(f'- {failure["resource"]}: "{failure["quote"]}" in {failure["file"]}: {failure["reason"]}')
        else:
            lines.append(f"- {failure['reason']}")
    return ("The host check of output/findings.json failed:\n" + "\n".join(lines) + "\n\n"
            "Re-read each file named above, then correct findings.json: copy each quote exactly as it appears in "
            "the file it cites. If the evidence does not say what a claim needs, read the cluster again for it, or "
            "remove the claim and say in the cause that it was not confirmed. Leave quotes that were found as they "
            "are. Update findings.md to match, and answer in one or two sentences.")
