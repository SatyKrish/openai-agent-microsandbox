# Copyright 2026 openai-agent-mxc contributors
# SPDX-License-Identifier: Apache-2.0
"""Isolation test: one SRE session's logs and evidence stay out of every other session's reach.

``make isolation`` runs this twice. In the harness pod (no model) it opens three
workspaces A, B and C at once, gives each its own kubectl evidence, a private
marker file and a notes log, and checks from A against B and C while all three
are alive:

1. A's containers cannot list, read, write or delete B's or C's files, or the
   worker's journal, by absolute path, ``../``, globbing or a planted symlink,
   and cannot see their processes;
2. A's file RPCs aimed there are refused, and B's and C's files are unchanged;
3. A's evidence RPCs return only A's entries, numbered per session;
4. the harness's findings check fails when a conversation cites another
   conversation's evidence file or text, even after tampering with its own copy.

It deletes the workspaces, keeps their journals and prints the IDs and markers.
Then, on the host (``--host-check``), it reads each journal on the worker, checks
that it holds only its own session's commands and that neither pod's logs contain
any command output, and purges the test's journals through the worker's RPC.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import hashlib
import io
import json
import os
import secrets
import subprocess
import sys
import tempfile
import time
from pathlib import Path

NAMES = "ABC"
PODS = "evidence/001-kubectl-get-pods-n-payments-o-wide.txt"
EVENTS = "evidence/003-kubectl-get-events-n-payments.txt"
passed = True


def report(ok: bool, name: str, detail: str = "") -> bool:
    global passed
    passed &= ok
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{f'  ({detail})' if detail else ''}", flush=True)
    return ok


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def client_from_env():
    from agent_mxc import MXCSandboxClient

    token_file = os.environ.get("MXC_WORKER_TOKEN_FILE")
    return MXCSandboxClient(os.environ.get("MXC_WORKER_TARGET", "127.0.0.1:50051"),
                            worker=os.environ.get("MXC_WORKER_NAME"),
                            token=Path(token_file).read_text().strip() if token_file else None,
                            workspace_base=os.environ.get("MXC_WORKSPACE_BASE", "/sandboxes/active"))


async def fingerprint(client, workspace: str) -> dict:
    """Every file the session made and every evidence entry, hashed through the session's own RPCs."""
    root = client.workspace_root(workspace)
    entries = await client.transport.list_evidence(workspace)
    files = {}
    for path in ["work/marker.txt", "work/notes.log", *(entry.path for entry in entries)]:
        files[path] = digest((await client.transport.read_file(workspace, f"{root}/{path}")).content)
    trusted = {entry.seq: digest((await client.transport.read_evidence(workspace, entry.seq)).content) for entry in entries}
    return {"files": files, "trusted": trusted}


async def containers(sessions, ids, markers) -> None:
    """Check 1: what A's commands can reach."""
    a = sessions["A"]
    others = [markers[name] for name in "BC"]

    async def probe(name, command, *, fails=False, expect=None):
        result = await a.exec(command, timeout=30)
        output = (result.stdout + result.stderr).decode(errors="replace")
        leaked = [marker for marker in others if marker in output]
        ok = not leaked and (result.exit_code != 0 if fails else True) and (expect is None or expect(output))
        report(ok, name, f"exit {result.exit_code}" + (f", leaked {len(leaked)} marker(s)" if leaked else "")
               + ("" if ok else f": {output.strip()[:200]!r}"))

    for target in "BC":
        other = ids[target]
        await probe(f"A cannot list {target}'s workspace", f"ls -la /sandboxes/active/{other}", fails=True)
        await probe(f"A cannot read {target}'s marker by absolute path",
                    f"cat /sandboxes/active/{other}/work/marker.txt", fails=True)
        await probe(f"A cannot read {target}'s notes log through ../", f"cat ../{other}/work/notes.log", fails=True)
        await probe(f"A cannot read {target}'s evidence", f"cat /sandboxes/active/{other}/evidence/*", fails=True)
        await probe(f"A's symlink to {target}'s workspace leads nowhere",
                    f"ln -sfn /sandboxes/active/{other} link-{target} && cat link-{target}/work/marker.txt", fails=True)
        await probe(f"A's writes and deletes aimed at {target} stay in A's container",
                    f"mkdir -p /sandboxes/active/{other}/work 2>/dev/null; "
                    f"echo pwned > /sandboxes/active/{other}/work/pwned.txt 2>/dev/null; "
                    f"echo pwned > ../{other}/work/marker.txt 2>/dev/null; "
                    f"rm -rf /sandboxes/active/{other} ../{other} 2>/dev/null; true")
    await probe("A's glob over /sandboxes/active/* finds only A's marker", "cat /sandboxes/active/*/work/marker.txt",
                expect=lambda output: markers["A"] in output)
    await probe("../ from A's workspace lists only A", "ls -A ..", expect=lambda output: output.split() == [ids["A"]])
    await probe("A cannot list or read the worker's journal",
                "ls /sandboxes/history || cat /sandboxes/history/*/journal.jsonl", fails=True)
    await probe("A's symlink to the journal leads nowhere",
                "ln -sfn /sandboxes/history link-history && ls link-history/", fails=True)

    # While B runs a process named after its marker, A's /proc must not show it.
    sleeper = f"{markers['B']}-proc"

    async def hold():
        result = await sessions["B"].exec(f"python3 -c 'import time; time.sleep(5)' {sleeper}", timeout=30)
        return result, time.monotonic()

    async def scan():
        await asyncio.sleep(1.5)
        result = await a.exec("for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null; echo; done", timeout=30)
        return result, time.monotonic()

    (held, held_until), (seen, scanned_at) = await asyncio.gather(hold(), scan())
    # The scan sees its own shell (a positive control) and finished while B's process was still running.
    ok = held.ok() and scanned_at < held_until and b"for p in /proc" in seen.stdout and sleeper.encode() not in seen.stdout
    report(ok, "A's /proc does not show B's process while it runs",
           f"{len([line for line in seen.stdout.splitlines() if line.strip()])} processes visible to A")


async def file_rpcs(client, ids) -> None:
    """Check 2: A's ReadFile and WriteFile aimed at B, C and the journal are refused."""
    import grpc

    from agent_mxc import WorkerError

    a, root_a = ids["A"], client.workspace_root(ids["A"])
    for target in "BC":
        other, root = ids[target], client.workspace_root(ids[target])
        reads = [f"{root}/work/marker.txt", f"../{other}/work/marker.txt", f"{root_a}/../{other}/work/notes.log",
                 f"link-{target}/work/marker.txt", f"link-{target}/{PODS}", f"/sandboxes/history/{other}/journal.jsonl",
                 f"../../history/{other}/journal.jsonl", f"link-history/{other}/evidence.jsonl"]
        writes = [f"{root}/work/marker.txt", f"../{other}/work/pwned.txt", f"link-{target}/work/pwned.txt",
                  f"link-{target}/{PODS}", f"link-history/{other}/journal.jsonl",
                  f"../../history/{other}/evidence/000001.txt"]
        refused = []
        for path in reads:
            try:
                await client.transport.read_file(a, path)
            except WorkerError as error:
                refused.append(error.code == grpc.StatusCode.INVALID_ARGUMENT)
            else:
                refused.append(False)
        for path in writes:
            try:
                await client.transport.write_file(a, path, b"pwned\n")
            except WorkerError as error:
                refused.append(error.code == grpc.StatusCode.INVALID_ARGUMENT)
            else:
                refused.append(False)
        report(all(refused), f"A's file RPCs into {target}'s workspace and journal are refused",
               f"{sum(refused)} of {len(refused)} INVALID_ARGUMENT")


async def evidence_rpcs(client, ids) -> None:
    """Check 3: evidence is per session."""
    from agent_mxc import WorkerError

    listed = {name: await client.transport.list_evidence(ids[name]) for name in NAMES}
    commands = {name: [entry.command for entry in entries] for name, entries in listed.items()}
    report(len(commands["A"]) == 2 and commands["A"][0] == "kubectl get pods -n payments -o wide"
           and commands["A"][1].startswith("pod_logs payments-processor-")
           and [entry.seq for entry in listed["A"]] == [1, 2], "A's evidence lists only A's two reads", str(commands["A"]))
    report([entry.seq for entry in listed["B"]] == [1, 2, 3] and "kubectl get events -n payments" in commands["B"]
           and len(listed["C"]) == 2, "B and C number their own evidence", f"B {len(listed['B'])}, C {len(listed['C'])}")
    try:
        await client.transport.read_evidence(ids["A"], 3)
        report(False, "A cannot read evidence 3, which only B has")
    except WorkerError as error:
        report(error.code.name == "NOT_FOUND", "A cannot read evidence 3, which only B has", error.code.name)
    later = await client.transport.list_evidence(ids["B"], after_seq=2)
    report([entry.command for entry in later] == ["kubectl get events -n payments"], "B's evidence after seq 2 is B's own")


async def harness_check(client, namespaces) -> list[str]:
    """Check 4: the findings check rejects another conversation's evidence. Returns the conversations' workspaces."""
    from openai_harness.engine import Harness
    from openai_harness.store import SQLiteStore
    from openai_harness.testing import Calls, ask, shell

    from .agent.spec import REPORT, make_spec
    from .ui.card import check_rows, file_status

    def write_findings(file: str, quote: str) -> str:
        findings = json.dumps({"findings": [{"resource": "deployment/payments-processor", "namespace": "payments",
                                             "evidence": [{"file": file, "quote": quote}]}]})
        encoded = base64.b64encode(findings.encode()).decode()
        return f"echo {encoded} | base64 -d > output/findings.json && echo '# findings' > output/findings.md"

    data = Path(tempfile.mkdtemp(prefix="isolation-"))
    workspaces = []

    async def conversation(name, model, text="Investigate payments."):
        store = SQLiteStore(data / name / "threads.sqlite3")
        harness = Harness(make_spec(namespaces), store, client, model=model, output_dir=data / name / "threads",
                          model_label="scripted", card=check_rows, file_status=file_status, preferred_output=REPORT)
        thread_id, _ = await ask(harness, text)
        return harness, thread_id

    async def last_check(harness, thread_id):
        thread = await harness.store.load_thread(thread_id, {})
        return thread, thread.metadata["turns"][-1].get("check") or {}

    model_b = Calls([shell("kubectl get pods -n payments -o wide"),
                     ("pod_logs", {"pod": "deploy/payments-processor", "namespace": "payments"}),
                     shell("kubectl get events -n payments")], answer="Read.")
    harness_b, thread_b = await conversation("B", model_b)
    thread, _ = await last_check(harness_b, thread_b)
    workspaces.append(thread.metadata["workspace"].split("/", 1)[1])
    events_copy = (data / "B" / "threads" / thread_b / "turn-1" / EVENTS).read_text()
    pods_copy = (data / "B" / "threads" / thread_b / "turn-1" / PODS).read_text()
    # A line only B's events evidence holds: pods output never has an event's columns.
    quote = next(line.strip() for line in events_copy.splitlines()[1:] if line.strip() and line.strip() not in pods_copy)
    model_b.calls = [shell(write_findings(EVENTS, quote))]
    await ask(harness_b, "Write it up.", conversation=thread_b)
    _, check = await last_check(harness_b, thread_b)
    report(check.get("status") == "evidence_passed", "B's findings citing its own events evidence pass", check.get("status"))

    model_a1 = Calls([shell("kubectl get pods -n payments -o wide"), shell(write_findings(EVENTS, quote))], answer="Done.")
    harness_a1, thread_a1 = await conversation("A1", model_a1)
    thread, check = await last_check(harness_a1, thread_a1)
    workspaces.append(thread.metadata["workspace"].split("/", 1)[1])
    reasons = [failure["reason"] for failure in check.get("failures") or []]
    report(check.get("status") == "failed" and any("never recorded" in reason for reason in reasons),
           "A citing B's evidence file name fails the check", "; ".join(reasons)[:120])

    planted = base64.b64encode(quote.encode()).decode()
    model_a2 = Calls([shell("kubectl get pods -n payments -o wide"),
                      shell(f"echo {planted} | base64 -d >> {PODS} && {write_findings(PODS, quote)}")], answer="Done.")
    harness_a2, thread_a2 = await conversation("A2", model_a2)
    thread, check = await last_check(harness_a2, thread_a2)
    workspace = thread.metadata["workspace"].split("/", 1)[1]
    workspaces.append(workspace)
    tampered = (await client.transport.read_file(workspace, f"{client.workspace_root(workspace)}/{PODS}")).content
    reasons = [failure["reason"] for failure in check.get("failures") or []]
    report(quote.encode() in tampered and check.get("status") == "failed" and "not in the file" in reasons,
           "A quoting B's text from its own tampered copy fails the check",
           f"workspace copy tampered: {quote.encode() in tampered}; {'; '.join(reasons)[:80]}")

    for harness, thread_id in ((harness_b, thread_b), (harness_a1, thread_a1), (harness_a2, thread_a2)):
        await harness.store.delete_thread(thread_id, {})
        harness.store.close()
    return workspaces


async def in_pod() -> int:
    from agents.sandbox import Manifest
    from agents.sandbox.entries import Dir

    from agent_mxc import MXCSandboxOptions, WorkerError

    client = client_from_env()
    info = await client.info()
    ids = {name: client.new_workspace_id() for name in NAMES}
    markers = {name: f"MXC-ISOLATION-{name}-{secrets.token_hex(6)}" for name in NAMES}
    print(f"Worker {info['worker_id']}: sessions A, B and C opened at once", flush=True)
    async with contextlib.AsyncExitStack() as stack:
        created = await asyncio.gather(*(client.create(
            manifest=Manifest(root=client.workspace_root(ids[name]), entries={"evidence": Dir(), "work": Dir()}),
            options=MXCSandboxOptions(workspace_id=ids[name])) for name in NAMES))
        sessions = {name: await stack.enter_async_context(session) for name, session in zip(NAMES, created)}

        async def setup(name):
            session = sessions[name]
            for command in ["kubectl get pods -n payments -o wide", "pod_logs",
                            *(["kubectl get events -n payments"] if name == "B" else []),
                            f"echo {markers[name]} > work/marker.txt && cat work/marker.txt"]:
                if command == "pod_logs":
                    # Logs come only through the worker's log policy.
                    await session._inner.read_logs("payments", "deploy/payments-processor")
                    continue
                result = await session.exec(command, timeout=60)
                if not result.ok():
                    raise RuntimeError(f"{name}: {command} exited {result.exit_code}")
            await session.write(Path("work/notes.log"), io.BytesIO(f"{markers[name]} troubleshooting notes\n".encode()))

        await asyncio.gather(*(setup(name) for name in NAMES))
        before = {name: await fingerprint(client, ids[name]) for name in "BC"}

        print("1. A's containers against B, C and the journal:", flush=True)
        await containers(sessions, ids, markers)
        print("2. A's file RPCs against B, C and the journal:", flush=True)
        await file_rpcs(client, ids)
        for name in "BC":
            after = await fingerprint(client, ids[name])
            try:
                await client.transport.read_file(ids[name], f"{client.workspace_root(ids[name])}/work/pwned.txt")
                added = True
            except WorkerError as error:
                added = error.code.name != "NOT_FOUND"
            report(after == before[name] and not added,
                   f"{name}'s files and trusted evidence are unchanged, and nothing was added",
                   f"{len(after['files'])} files, {len(after['trusted'])} evidence entries")
        print("3. Evidence RPCs:", flush=True)
        await evidence_rpcs(client, ids)

    print("4. The harness's findings check across conversations:", flush=True)
    conversations = await harness_check(client, frozenset({"payments"}))
    # Remove the workspaces and keep their journals for the host check, which purges them.
    for name in NAMES:
        await client.transport.destroy(ids[name])
    await client.aclose()
    state = {"sessions": {name: {"id": ids[name], "marker": markers[name]} for name in NAMES},
             "conversations": conversations}
    print("STATE " + json.dumps(state), flush=True)
    print("In-pod checks passed." if passed else "In-pod checks FAILED.", flush=True)
    return 0 if passed else 1


def kubectl(context: str, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["kubectl", "--context", context, "-n", "sre-system", *args], capture_output=True, text=True)


def host_check(state_file: Path, context: str) -> int:
    lines = [line for line in state_file.read_text().splitlines() if line.startswith("STATE ")]
    if not lines:
        print("No STATE line: the in-pod run did not finish.", flush=True)
        return 1
    state = json.loads(lines[-1][6:])
    sessions = state["sessions"]
    ids = [session["id"] for session in sessions.values()] + state["conversations"]
    markers = [session["marker"] for session in sessions.values()]
    worker, harness = "sre-sandbox-payments-0", "sre-harness-payments-0"
    print("5. Journals and pod logs, read on the worker and from the host:", flush=True)
    for workspace in ids:
        own = next((session["marker"] for session in sessions.values() if session["id"] == workspace), None)
        journal = kubectl(context, "exec", worker, "-c", "worker", "--", "cat", f"/sandboxes/history/{workspace}/journal.jsonl")
        records = [json.loads(line) for line in journal.stdout.splitlines() if line.strip()]
        commands = [record for record in records if record.get("event") == "exec"]
        # Every record ran in this workspace, and no other session's private marker appears: not in a command
        # (each session's own commands write its marker) and not in output. Other sessions' IDs may appear, but
        # only because A's probes name their paths.
        foreign = [marker for marker in markers if marker != own and marker in journal.stdout]
        named = [other for other in ids if other != workspace and other in journal.stdout]
        cwd_ok = all(record["cwd"].startswith(f"/sandboxes/active/{workspace}") for record in commands)
        gone = kubectl(context, "exec", worker, "-c", "worker", "--", "test", "!", "-e", f"/sandboxes/active/{workspace}")
        report(journal.returncode == 0 and commands and cwd_ok and not foreign and gone.returncode == 0,
               f"journal of {workspace} holds only its own {len(commands)} commands; workspace removed",
               f"other sessions' markers: {len(foreign)}; other IDs named by its own probes: {len(named)}")
    for pod, container in ((worker, "worker"), (harness, "harness")):
        logs = kubectl(context, "logs", pod, "-c", container).stdout
        leaked = [marker for marker in markers if marker in logs]
        report(not leaked, f"{container} pod logs hold no command output", f"{len(logs.splitlines())} log lines")
    purge = kubectl(context, "exec", harness, "-c", "harness", "--", "python", "-m", "apps.sre.isolation",
                    "--purge", *ids)
    remaining = kubectl(context, "exec", worker, "-c", "worker", "--", "sh", "-c",
                        " ".join(f"test -e /sandboxes/history/{workspace} && echo {workspace};" for workspace in ids))
    report(purge.returncode == 0 and not remaining.stdout.strip(), "the test's journals are purged through the worker",
           f"{len(ids)} sessions")
    print("All isolation checks passed." if passed else "Some isolation checks FAILED.", flush=True)
    return 0 if passed else 1


async def purge(ids: list[str]) -> int:
    client = client_from_env()
    for workspace in ids:
        await client.transport.destroy(workspace, purge_history=True)
    await client.aclose()
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host-check", type=Path, metavar="OUTPUT", help="Check journals and logs from the host")
    parser.add_argument("--context", default="kind-openai-agent-mxc")
    parser.add_argument("--purge", nargs="+", metavar="ID", help="Purge these sessions' journals (in the pod)")
    args = parser.parse_args(argv)
    if args.host_check:
        return host_check(args.host_check, args.context)
    if args.purge:
        return asyncio.run(purge(args.purge))
    from agents import set_tracing_disabled

    set_tracing_disabled(True)
    return asyncio.run(in_pod())


if __name__ == "__main__":
    sys.exit(main())
