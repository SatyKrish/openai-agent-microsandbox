# Copyright 2026 openai-agent-mxc contributors
# SPDX-License-Identifier: Apache-2.0
"""The SRE agent on the harness, against the worker's real gRPC service and a fake kubectl (root conftest)."""

import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from chatkit.types import ThreadMetadata

from examples.sre.agent.lib import findings
from examples.sre.agent.spec import REPORT, make_spec, runbooks
from examples.sre.ui.card import check_rows, file_status
from openai_harness.chat import HarnessChatServer
from openai_harness.spec import Conversation
from openai_harness.store import SQLiteStore
from openai_harness.testing import Calls, events, message, shell

TRIAGE = Path(__file__).resolve().parents[1] / "agent/skills/kubernetes-triage/scripts/triage.py"
LOGS = "[FATAL] Payments startup failed: Missing required env var DATABASE_URL\n"
PODS_FILE = "evidence/001-kubectl-get-pods-n-payments-o-wide.txt"
LOGS_FILE = "evidence/002-kubectl-logs-deploy-payments-processor-n-payments-previous.txt"


def test_triage_script_lists_unhealthy_pods(tmp_path):
    (tmp_path / "001.txt").write_text(
        "NAME                                  READY   STATUS             RESTARTS      AGE\n"
        "payments-processor-7d9f8c6b5d-x2k4p   0/1     CrashLoopBackOff   5 (40s ago)   4m\n"
        "payments-gateway-5b7c8d9e6f-a1b2c     1/1     Running            0             4m\n")
    output = subprocess.run([sys.executable, str(TRIAGE), str(tmp_path / "001.txt")],
                            capture_output=True, text=True, check=True).stdout
    assert "payments-processor-7d9f8c6b5d-x2k4p: status CrashLoopBackOff, 5 restarts" in output
    assert "gateway" not in output


def test_every_workspace_starts_with_the_runbooks(tmp_path):
    books = runbooks()
    assert "runbooks/payments.md" in books and b"DATABASE_URL" in books["runbooks/payments.md"]
    manifest = make_spec({"payments"}).start(None, False, "/sandboxes/active/s-x")
    assert set(manifest.entries) == {"evidence", "output", "work", "runbooks"}


def conversation_with(tmp_path, text):
    entry = {"seq": 1, "path": LOGS_FILE, "label": "kubectl logs", "turn": 1, "bytes": len(text), "sha256": "x"}
    host = tmp_path / "thr" / "turn-1" / entry["path"]
    host.parent.mkdir(parents=True)
    host.write_text(text)
    thread = ThreadMetadata(id="thr", created_at=datetime.now(), metadata={"evidence": [entry]})
    return Conversation(thread, tmp_path / "thr")


def findings_file(*evidence, resource="deployment/payments-processor"):
    return {"output/findings.json": json.dumps({"findings": [{"resource": resource, "evidence": list(evidence)}]}).encode(),
            "output/findings.md": b"# Findings"}


def test_findings_quotes_are_checked_against_the_journal_copy(tmp_path):
    conversation = conversation_with(tmp_path, LOGS)
    quote = {"file": LOGS_FILE, "quote": "Missing required env var   DATABASE_URL"}
    assert findings.check(conversation, findings_file(quote))["status"] == "evidence_passed"
    invented = findings.check(conversation, findings_file({**quote, "quote": "OOMKilled"}))
    assert invented["status"] == "failed" and f"Not found in {LOGS_FILE}" in invented["detail"]
    unrecorded = findings.check(conversation, findings_file({**quote, "file": "evidence/999-made-up.txt"}))
    assert unrecorded["status"] == "failed" and "the sandbox worker never recorded" in unrecorded["detail"]
    assert findings.check(conversation, findings_file())["status"] == "failed"
    assert findings.check(conversation, {"output/findings.md": b"x"})["status"] == "no_findings"


async def test_an_investigation_reads_the_cluster_in_the_sandbox_and_is_checked(worker, tmp_path):
    citation = json.dumps({"findings": [{
        "resource": "deployment/payments-processor", "namespace": "payments", "problem": "CrashLoopBackOff",
        "cause": "DATABASE_URL is missing", "fix": "Set DATABASE_URL from the payments-db Secret",
        "evidence": [{"file": LOGS_FILE, "quote": "Missing required env var DATABASE_URL"},
                     {"file": PODS_FILE, "quote": "CrashLoopBackOff"}]}]})
    model = Calls([
        shell("kubectl get pods -n payments -o wide"),
        shell("kubectl logs deploy/payments-processor -n payments --previous"),
        shell("kubectl get pods -n payments | grep Crash"),  # analysis: not evidence
        shell("cat runbooks/payments.md | head -3"),
        # Tamper with the workspace copy of the evidence and cite it anyway: the check reads the journal's copy.
        shell(f"printf '%s' '{citation}' > output/findings.json && echo '# payments-processor' > output/findings.md "
              f"&& echo forged > {LOGS_FILE}"),
    ], answer="payments-processor crashes: DATABASE_URL is not set.")
    store = SQLiteStore(tmp_path / "threads.sqlite3")
    chat = HarnessChatServer(make_spec({"payments"}), store, worker.client(), model=model,
                             output_dir=tmp_path / "threads", model_label="scripted", card=check_rows,
                             file_status=file_status, preferred_output=REPORT)
    try:
        stream = await events(chat, {"type": "threads.create", "params": {
            "input": message("Why is payments-processor crashing?")}})
        assert not [event for event in stream if event["type"] == "error"], stream
        assert "[mxc-worker] saved as evidence/001" in model.outputs[0]
        thread_id = next(event["thread"]["id"] for event in stream if event["type"] == "thread.created")
        thread = await store.load_thread(thread_id, {})
        turn = thread.metadata["turns"][0]
        assert [item["path"] for item in thread.metadata["evidence"]] == [PODS_FILE, LOGS_FILE]
        assert thread.metadata["evidence"][1]["label"] == "kubectl logs deploy/payments-processor -n payments --previous"
        host = tmp_path / "threads" / thread_id / "turn-1" / LOGS_FILE
        assert host.read_text() == LOGS
        assert turn["check"]["status"] == "evidence_passed" and turn["check"]["quotes"] == 2
        assert turn["file_status"]["output/findings.json"]["state"] == "checked"
        assert turn["file_status"][PODS_FILE]["state"] == "source"
        card = json.dumps(stream, ensure_ascii=False)
        assert "2 kubectl reads recorded as evidence by the sandbox worker" in card
        assert "1 finding · 2 quotes match the evidence" in card
        assert [tool["where"] for tool in turn["tools"]] == ["sandbox"] * 5
        # A second turn picks up only the new reads.
        model.calls = [shell("kubectl get events -n payments")]
        stream = await events(chat, {"type": "threads.add_user_message", "params": {
            "thread_id": thread_id, "input": message("Any events?")}})
        assert not [event for event in stream if event["type"] == "error"]
        thread = await store.load_thread(thread_id, {})
        assert [item["seq"] for item in thread.metadata["evidence"]] == [1, 2, 3]
        assert thread.metadata["turns"][1]["check"]["status"] == "evidence_passed"
    finally:
        store.close()
