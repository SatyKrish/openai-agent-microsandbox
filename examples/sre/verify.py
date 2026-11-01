# Copyright 2026 openai-agent-mxc contributors
# SPDX-License-Identifier: Apache-2.0
"""Verify a deployed harness/worker pair without a model: boundary probes, then a scripted investigation.

Run it in the harness pod (``make verify``). It uses the same settings as the UI.
The probes run real commands in MXC containers on the worker; the investigation
drives the harness with a scripted model, so it reads the real cluster and checks
real evidence without model API usage. Exits nonzero if anything fails.
"""

from __future__ import annotations

import asyncio
import os
import re
import sys
import tempfile
import time
from pathlib import Path

PROBES = [
    # MXC's own proxy-mode tests require all three sets to be zero.
    ("container has no capabilities (bounding, effective, permitted)",
     "test \"$(grep -cE '^Cap(Bnd|Eff|Prm):[[:space:]]+0+$' /proc/self/status)\" = 3", 0, None),
    ("container sees only its own processes", "test \"$(ls /proc | grep -cE '^[0-9]+$')\" -lt 10", 0, None),
    ("worker journal is not mounted", "test ! -e /sandboxes/history", 0, None),
    ("other workspaces are not mounted", 'test "$(ls /sandboxes/active)" = "$(basename "$PWD")"', 0, None),
    ("system files are read-only", "! touch /usr/bin/probe 2>/dev/null && ! touch /etc/probe 2>/dev/null", 0, None),
    ("no model API key in the environment", 'test -z "${OPENAI_API_KEY:-}" && ! env | grep -qi openai', 0, None),
    ("no route to the public internet",
     "python3 -c \"import socket; socket.create_connection(('1.1.1.1', 443), 3)\"", "nonzero", None),
    ("no Kubernetes token in the container",
     "test ! -e /var/run/secrets/kubernetes.io/serviceaccount && test ! -e /run/secrets/kubernetes.io && "
     "! env | grep -q '^KUBERNETES_'", 0, None),
    ("no direct route to the Kubernetes API",
     f"python3 -c \"import socket; socket.create_connection(('{os.environ.get('KUBERNETES_SERVICE_HOST', '10.96.0.1')}', "
     f"{os.environ.get('KUBERNETES_SERVICE_PORT', '443')}), 3)\"", "nonzero", None),
    ("analysis tools are available (python3, jq, rg)", "python3 --version && jq --version && rg --version", 0, "ripgrep"),
    ("Kubernetes API reachable through the worker's proxy", "kubectl version --output=yaml", 0, "serverVersion"),
    ("reads pods in payments", "kubectl get pods -n payments", 0, "payments-"),
    ("cannot read Secrets", "kubectl get secrets -n payments", "nonzero", "Forbidden"),
    ("cannot read other namespaces", "kubectl get pods -n kube-system", "nonzero", "Forbidden"),
    ("writes are refused before they reach the API",
     "kubectl delete pod payments-probe -n payments --dry-run=server", "nonzero", "read-only"),
    ("exec into pods is refused", "kubectl exec -n payments deploy/payments-gateway -- true", "nonzero", None),
    ("raw pod logs are refused in the sandbox", "kubectl logs deploy/payments-gateway -n payments", "nonzero",
     "pod_logs"),
    ("credentials in output are redacted", "echo DATABASE_URL=postgres://app:hunter2@db/orders password=hunter2hunter2",
     0, "postgres://app:[REDACTED]@db/orders password=[REDACTED]"),
]
PODS = "evidence/001-kubectl-get-pods-n-payments-o-wide.txt"


def findings_command(logs_glob: str = "evidence/002-pod-logs-*.txt") -> str:
    """A sandbox command that writes findings citing the log excerpt, whose name holds the real pod's name."""
    return ("python3 - <<'PY'\nimport glob, json\nlogs = sorted(glob.glob('" + logs_glob + "'))[0]\n"
            "json.dump({'findings': [{'resource': 'deployment/payments-processor', 'namespace': 'payments', "
            "'problem': 'CrashLoopBackOff', 'cause': 'DATABASE_URL is not set', "
            "'fix': 'Set DATABASE_URL from the payments-db Secret', 'evidence': ["
            "{'file': logs, 'quote': 'Missing required env var DATABASE_URL'}, "
            # The pod's status alternates between Error and CrashLoopBackOff; its name does not.
            "{'file': '" + PODS + "', 'quote': 'payments-processor-'}]}]}, open('output/findings.json', 'w'))\n"
            "open('output/findings.md', 'w').write('# payments-processor\\n')\nPY")


def report(ok: bool, name: str, detail: str = "") -> bool:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{f'  ({detail})' if detail else ''}", flush=True)
    return ok


async def probes(client) -> bool:
    from agents.sandbox import Manifest

    from agent_mxc import MXCSandboxOptions

    workspace = client.new_workspace_id()
    session = await client.create(manifest=Manifest(root=client.workspace_root(workspace)),
                                  options=MXCSandboxOptions(workspace_id=workspace))
    passed = True
    async with session:
        for name, command, expected, needle in PROBES:
            began = time.monotonic()
            result = await session.exec(command, timeout=30)
            output = (result.stdout + result.stderr).decode(errors="replace")
            ok = (result.exit_code == 0) if expected == 0 else (result.exit_code != 0)
            ok = ok and (needle is None or needle in output)
            detail = f"exit {result.exit_code}, {(time.monotonic() - began) * 1000:.0f} ms"
            if not ok:
                detail += f": {output.strip()[:300]!r}"
            passed &= report(ok, name, detail)
        # A busy service's log reaches the harness only as a bounded, masked excerpt.
        reply = await session._inner.read_logs("payments", "deploy/payments-api", tail_lines=5000)
        excerpt = reply["excerpt"]
        leaked = re.findall(r"[\w.+-]+@[\w-]+\.[\w.]+|\b4111[ -]?1111", excerpt)
        passed &= report(reply["lines_read"] > 200 and reply["lines_shown"] <= 40 and not leaked
                         and "ERROR" in excerpt, "logs reach the harness only as a policy excerpt",
                         f"read {reply['lines_read']}, shown {reply['lines_shown']}, {reply['redactions']} masked, "
                         f"{len(excerpt)} bytes" + (f", leaked {leaked[:2]}" if leaked else ""))
    await client.delete(session, purge_history=True)
    harness_token = Path("/var/run/secrets/kubernetes.io/serviceaccount/token")
    passed &= report(not harness_token.exists(), "harness pod has no Kubernetes token")
    return passed


async def investigation(client, namespaces) -> bool:
    from openai_harness.chat import HarnessChatServer
    from openai_harness.store import SQLiteStore
    from openai_harness.testing import Calls, events, message, shell

    from .agent.spec import REPORT, make_spec
    from .ui.card import check_rows, file_status

    model = Calls([
        shell("kubectl get pods -n payments -o wide"),
        ("pod_logs", {"pod": "deploy/payments-processor", "namespace": "payments"}),
        shell("grep -c payments-processor evidence/*.txt; grep -c DATABASE_URL runbooks/payments.md"),
        shell(findings_command()),
    ], answer="payments-processor crashes at startup: DATABASE_URL is not set.")
    with tempfile.TemporaryDirectory() as data:
        store = SQLiteStore(Path(data) / "threads.sqlite3")
        chat = HarnessChatServer(make_spec(namespaces), store, client, model=model, output_dir=Path(data) / "threads",
                                 model_label="scripted", card=check_rows, file_status=file_status, preferred_output=REPORT)
        try:
            began = time.monotonic()
            stream = await events(chat, {"type": "threads.create", "params": {
                "input": message("Why is payments-processor crashing?")}})
            errors = [event for event in stream if event["type"] == "error"]
            thread_id = next((event["thread"]["id"] for event in stream if event["type"] == "thread.created"), None)
            thread = await store.load_thread(thread_id, {}) if thread_id else None
            turn = thread.metadata["turns"][0] if thread else {}
            evidence = [entry["label"] for entry in (thread.metadata.get("evidence", []) if thread else [])]
            passed = report(not errors and turn.get("status") == "completed", "scripted turn completed",
                            f"{time.monotonic() - began:.1f} s" + (f": {errors[0].get('message')}" if errors else ""))
            passed &= report(len(evidence) == 2, "kubectl read and log excerpt recorded as evidence", "; ".join(evidence))
            check = turn.get("check") or {}
            passed &= report(check.get("status") == "evidence_passed", "findings quotes match the journal copy",
                             check.get("detail") or f"{check.get('quotes', 0)} quotes")
            if thread_id:
                await store.delete_thread(thread_id, {})
        finally:
            store.close()
    return passed


async def main() -> int:
    from agent_mxc import MXCSandboxClient

    token_file = os.environ.get("MXC_WORKER_TOKEN_FILE")
    client = MXCSandboxClient(os.environ.get("MXC_WORKER_TARGET", "127.0.0.1:50051"),
                              worker=os.environ.get("MXC_WORKER_NAME"),
                              token=Path(token_file).read_text().strip() if token_file else None,
                              workspace_base=os.environ.get("MXC_WORKSPACE_BASE", "/sandboxes/active"))
    namespaces = frozenset(name for name in os.environ.get("SRE_NAMESPACES", "payments").split(",") if name)
    info = await client.info()
    print(f"Worker {info['worker_id']} · domain {info['domain']} · MXC {info['containment']} "
          f"(SDK {info['mxc_sdk_version']}) · egress {info['egress']}", flush=True)
    print("Boundary probes, each in its own MXC container:", flush=True)
    passed = await probes(client)
    print("Scripted investigation through the harness:", flush=True)
    passed &= await investigation(client, namespaces)
    await client.aclose()
    print("All checks passed." if passed else "Some checks FAILED.", flush=True)
    return 0 if passed else 1


if __name__ == "__main__":
    from agents import set_tracing_disabled

    set_tracing_disabled(True)
    sys.exit(asyncio.run(main()))
