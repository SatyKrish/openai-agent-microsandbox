# Copyright 2026 openai-agent-mxc contributors
# SPDX-License-Identifier: Apache-2.0
"""Concurrency test: many conversations and many users at once, over the harness's HTTP API.

Each user is its own thread and HTTP connection, as browsers would be.

Scripted (``make loadtest``, in the harness pod): starts a second harness on
127.0.0.1:8099 with a scripted model against the real worker, so every turn runs
real kubectl reads and file writes in MXC containers without model API usage.

- one user starts several conversations at once (like several tabs);
- many users start one conversation each, more than the worker's parallel slots;
- several users send to one shared conversation at the same moment: the conversation's turns run one
  at a time, and messages that arrive while one runs are answered together in the next.

Live (``--live http://localhost:8001``): several users each ask the deployed UI
a different question at once. This uses the model.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

LIVE_QUESTIONS = [
    "Which workloads in payments are unhealthy, and why?",
    "Why is payments-ledger not running? Propose a fix.",
    "Is payments-gateway healthy? Check its replicas and recent events.",
    "Why is payments-processor crashing? Propose a fix.",
]


class Harness:
    """One user's view of a harness: plain HTTP, as the UI page uses it."""

    def __init__(self, base: str):
        self.base = base.rstrip("/")

    def request(self, method: str, path: str, payload: dict | None = None) -> dict:
        request = urllib.request.Request(self.base + path, method=method, headers={
            "content-type": "application/json", "origin": self.base},
            data=json.dumps(payload).encode() if payload is not None else None)
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read())

    def get(self, path: str):
        with urllib.request.urlopen(self.base + path, timeout=30) as response:
            body = response.read()
        return json.loads(body) if path.startswith("/api/") and "/files/" not in path else body.decode()

    def wait(self, thread_id: str, message: str, timeout: float = 900) -> list[str]:
        """Wait for the turn that answers ``message`` to end; returns what went wrong, if anything."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            entries = self.get(f"/api/conversations/{thread_id}")["entries"]
            number = next((entry["turn"] for entry in entries if entry["id"] == message), None)
            if number:
                turn = self.get(f"/api/threads/{thread_id}")["turns"][number - 1]
                if turn["status"] != "running":
                    return [] if turn["status"] == "completed" else [f"turn {number} {turn['status']} {turn.get('error', '')}"]
            time.sleep(0.5)
        return ["no answer in time"]

    def start(self, text: str) -> dict:
        began = time.monotonic()
        try:
            sent = self.request("POST", "/api/conversations", {"text": text})
        except urllib.error.URLError as error:
            return {"thread_id": None, "errors": [str(error)], "wall_s": time.monotonic() - began}
        errors = self.wait(sent["id"], sent["message"])
        return {"thread_id": sent["id"], "errors": errors, "wall_s": time.monotonic() - began}

    def send(self, thread_id: str, text: str) -> dict:
        began = time.monotonic()
        try:
            sent = self.request("POST", f"/api/conversations/{thread_id}/messages", {"text": text})
        except urllib.error.URLError as error:
            return {"thread_id": thread_id, "errors": [str(error)], "wall_s": time.monotonic() - began}
        errors = self.wait(thread_id, sent["message"])
        return {"thread_id": thread_id, "errors": errors, "wall_s": time.monotonic() - began}

    def delete(self, thread_id: str) -> None:
        self.request("DELETE", f"/api/conversations/{thread_id}")


def parallel(tasks):
    with ThreadPoolExecutor(max_workers=max(1, len(tasks))) as pool:
        return list(pool.map(lambda task: task(), tasks))


def summary(name: str, results: list[dict], wall: float, harness: Harness, *, scripted: bool) -> bool:
    turns, starts, problems, workspaces = [], [], [], set()
    for result in results:
        if result["errors"] or not result["thread_id"]:
            problems.append(f"{result['thread_id']}: {result['errors']}")
            continue
        state = harness.get(f"/api/threads/{result['thread_id']}")
        workspaces.add(state["workspace"])
        for turn in state["turns"]:
            turns.append(turn["duration_s"])
            starts.append(turn.get("start_s") or 0)
            check = (turn.get("check") or {}).get("status")
            if turn["status"] != "completed":
                problems.append(f"{result['thread_id']} turn {turn['number']}: {turn['status']} {turn.get('error', '')}")
            elif scripted and check != "evidence_passed":
                problems.append(f"{result['thread_id']} turn {turn['number']}: check {check}")
        if scripted:
            visible = harness.get(f"/api/threads/{result['thread_id']}/turns/1/files/work/visible.txt").strip()
            if visible != "1":
                problems.append(f"{result['thread_id']}: its containers saw {visible} workspaces")
    p95 = sorted(turns)[max(0, round(0.95 * len(turns)) - 1)] if turns else 0
    print(f"{name}\n  {len(results)} requests · {len(turns)} turns · {len(workspaces)} workspaces · wall {wall:.1f} s · "
          f"turn p50 {statistics.median(turns) if turns else 0:.1f} s, p95 {p95:.1f} s, max {max(turns, default=0):.1f} s · "
          f"workspace open max {max(starts, default=0):.1f} s", flush=True)
    for problem in problems:
        print(f"  FAIL  {problem}", flush=True)
    print(f"  {'PASS' if not problems else 'FAIL'}", flush=True)
    return not problems


def serve_scripted(port: int, data: Path) -> None:
    """A second harness in this process with a scripted model, against the deployed worker."""
    import uvicorn

    from agent_mxc import MXCSandboxClient
    from openai_harness.engine import Harness as Engine
    from openai_harness.store import SQLiteStore
    from openai_harness.testing import Calls, shell

    from .agent.spec import REPORT, make_spec
    from .ui.app import create_app
    from .ui.card import check_rows, file_status
    from .verify import findings_command

    model = Calls([
        shell("kubectl get pods -n payments -o wide"),
        ("pod_logs", {"pod": "deploy/payments-processor", "namespace": "payments"}),
        # How many workspaces can this container see? Only its own, if sessions are isolated.
        shell("ls /sandboxes/active | wc -l | tr -d ' ' > work/visible.txt && sleep 1 && cat work/visible.txt"),
        shell(findings_command()),
    ], answer="payments-processor crashes at startup: DATABASE_URL is not set.")
    token_file = os.environ.get("MXC_WORKER_TOKEN_FILE")
    client = MXCSandboxClient(os.environ.get("MXC_WORKER_TARGET", "127.0.0.1:50051"),
                              worker=os.environ.get("MXC_WORKER_NAME"),
                              token=Path(token_file).read_text().strip() if token_file else None,
                              workspace_base=os.environ.get("MXC_WORKSPACE_BASE", "/sandboxes/active"))
    spec = make_spec({"payments"})
    engine = Engine(spec, SQLiteStore(data / "threads.sqlite3"), client, model=model, output_dir=data / "threads",
                    model_label="scripted", card=check_rows, file_status=file_status, preferred_output=REPORT)
    app = create_app(engine, config={"model": "scripted"}, port=port, jaeger_url=None, worker=client.info)
    uvicorn_server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    threading.Thread(target=uvicorn_server.run, daemon=True).start()
    while not uvicorn_server.started:
        time.sleep(0.1)


def scripted(port: int, conversations: int, users: int, shared: int) -> bool:
    data = Path(tempfile.mkdtemp(prefix="loadtest-"))
    serve_scripted(port, data)
    harness = Harness(f"http://127.0.0.1:{port}")
    before = harness.get("/api/worker")["active_sessions"]
    print(f"Worker {harness.get('/api/worker')['worker_id']}: {before} sessions before the test\n", flush=True)
    passed, created = True, []

    began = time.monotonic()
    results = parallel([lambda: harness.start("Why is payments-processor crashing?") for _ in range(conversations)])
    passed &= summary(f"One user, {conversations} conversations at once", results, time.monotonic() - began, harness,
                      scripted=True)
    created += [result["thread_id"] for result in results if result["thread_id"]]

    began = time.monotonic()
    results = parallel([lambda: Harness(harness.base).start(f"User {index}: what is unhealthy?") for index in range(users)])
    passed &= summary(f"{users} users, one conversation each, at once", results, time.monotonic() - began, harness,
                      scripted=True)
    created += [result["thread_id"] for result in results if result["thread_id"]]

    first = harness.start("Why is payments-processor crashing?")
    created.append(first["thread_id"])
    began = time.monotonic()
    results = parallel([lambda index=index: Harness(harness.base).send(first["thread_id"], f"User {index}: anything new?")
                        for index in range(shared)])
    ok = summary(f"{shared} users send to one shared conversation at once", [first], time.monotonic() - began, harness,
                 scripted=True)
    turns = harness.get(f"/api/threads/{first['thread_id']}")["turns"]
    errors = [result["errors"] for result in results if result["errors"]]
    serialized = all(earlier["started_at"] < later["started_at"] for earlier, later in zip(turns, turns[1:]))
    answered = sum(len(turn.get("messages") or []) for turn in turns)
    ok &= answered == shared + 1 and not errors and serialized
    print(f"  {answered} messages answered in {len(turns)} turns, in order: {'yes' if serialized else 'NO'} · "
          f"errors: {errors or 'none'}\n  {'PASS' if ok else 'FAIL'}", flush=True)
    passed &= ok

    during = harness.get("/api/worker")["active_sessions"]
    parallel([lambda thread_id=thread_id: harness.delete(thread_id) for thread_id in created])
    after = harness.get("/api/worker")["active_sessions"]
    ok = during - before == len(created) and after == before
    print(f"\nWorkspaces on the worker: {before} before, {during} with the test's {len(created)} conversations, "
          f"{after} after deleting them\n  {'PASS' if ok else 'FAIL'}", flush=True)
    return passed and ok


def live(base: str, users: int) -> bool:
    harness = Harness(base)
    questions = [LIVE_QUESTIONS[index % len(LIVE_QUESTIONS)] for index in range(users)]
    began = time.monotonic()
    results = parallel([lambda question=question: Harness(base).start(question) for question in questions])
    passed = summary(f"{users} users ask the live model at once", results, time.monotonic() - began, harness,
                     scripted=False)
    for result, question in zip(results, questions):
        if result["thread_id"]:
            turn = harness.get(f"/api/threads/{result['thread_id']}")["turns"][-1]
            check = turn.get("check") or {}
            evidence = sum(1 for item in turn["files"] if item.get("evidence"))
            print(f"  {result['thread_id']}  {turn['duration_s']:>5.1f} s  {len(turn['tools']):>2} tools  "
                  f"{evidence} evidence  check {check.get('status')} ({check.get('quotes', 0)} quotes)  {question}")
    return passed


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--live", metavar="URL", help="Test the deployed UI at URL with the live model instead")
    parser.add_argument("--users", type=int, help="Users at once (scripted default 12, live default 3)")
    parser.add_argument("--conversations", type=int, default=6, help="Conversations one user starts at once")
    parser.add_argument("--shared", type=int, default=3, help="Users sending to one conversation at once")
    parser.add_argument("--port", type=int, default=8099)
    args = parser.parse_args(argv)
    if args.live:
        passed = live(args.live, args.users or 3)
    else:
        from agents import set_tracing_disabled

        set_tracing_disabled(True)
        passed = scripted(args.port, args.conversations, args.users or 12, args.shared)
    print("\nAll scenarios passed." if passed else "\nSome scenarios FAILED.", flush=True)
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
