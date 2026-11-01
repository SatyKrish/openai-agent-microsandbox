# Copyright 2026 openai-agent-substrate contributors
# SPDX-License-Identifier: Apache-2.0
"""List unhealthy pods from saved `kubectl get pods -o wide` evidence files.

Usage: python3 triage.py evidence/*.txt
"""

import sys

HEALTHY = {"Running", "Completed", "Succeeded"}


def pods(path):
    with open(path, encoding="utf-8", errors="replace") as handle:
        lines = handle.read().splitlines()
    if not lines or not lines[0].split()[:3] == ["NAME", "READY", "STATUS"]:
        return
    for line in lines[1:]:
        fields = line.split()
        if len(fields) < 4:
            continue
        name, ready, status, restarts = fields[0], fields[1], fields[2], fields[3]
        yield name, ready, status, restarts


def main(paths):
    found = 0
    for path in paths:
        for name, ready, status, restarts in pods(path):
            have, _, want = ready.partition("/")
            reasons = []
            if status not in HEALTHY:
                reasons.append(f"status {status}")
            if status == "Running" and have != want:
                reasons.append(f"ready {ready}")
            if restarts.split("(")[0] not in ("0", ""):
                reasons.append(f"{restarts.split('(')[0]} restarts")
            if reasons:
                found += 1
                print(f"{name}: {', '.join(reasons)}  [{path}]")
    if not found:
        print("No unhealthy pods in these files.")


if __name__ == "__main__":
    main(sys.argv[1:])
