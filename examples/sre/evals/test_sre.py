# Copyright 2026 openai-agent-mxc contributors
# SPDX-License-Identifier: Apache-2.0
"""The SRE agent on the harness, against the worker's real gRPC service and a fake kubectl (root conftest)."""

import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from chatkit.types import ThreadMetadata

from agents.sandbox import MemoryGenerateConfig

from examples.sre.agent.agent import CONSOLIDATE_MODEL, EXTRACT_MODEL
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
LOGS_FILE = "evidence/002-pod-logs-payments-processor-7d9f8c6b5d-x2k4p-previous.txt"
API_LOGS_FILE = "evidence/003-pod-logs-payments-api-7d9f8c6b5d-x2k4p.txt"


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
        ("pod_logs", {"pod": "deploy/payments-processor", "namespace": "payments", "previous": True}),
        ("pod_logs", {"pod": "deploy/payments-api", "namespace": "payments", "tail": 5000}),
        shell("kubectl logs deploy/payments-api -n payments"),  # refused in the sandbox
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
        assert [item["path"] for item in thread.metadata["evidence"]] == [PODS_FILE, LOGS_FILE, API_LOGS_FILE]
        assert thread.metadata["evidence"][1]["label"] == (
            "pod_logs payments-processor-7d9f8c6b5d-x2k4p -n payments --previous")
        host = tmp_path / "threads" / thread_id / "turn-1" / LOGS_FILE
        assert LOGS.strip() in host.read_text()
        # What reached the model from the busy API's log: an excerpt, with no customer data.
        api_excerpt = model.outputs[2]
        assert "read 1207 lines" in api_excerpt and "withheld" in api_excerpt
        assert not any("@example.com" in output or "4111" in output for output in model.outputs)
        assert "pod_logs" in model.outputs[3]  # kubectl logs was refused
        assert turn["check"]["status"] == "evidence_passed" and turn["check"]["quotes"] == 2
        assert turn["file_status"]["output/findings.json"]["state"] == "checked"
        assert turn["file_status"][PODS_FILE]["state"] == "source"
        card = json.dumps(stream, ensure_ascii=False)
        assert "3 reads recorded as evidence by the sandbox worker" in card
        assert "1 finding · 2 quotes match the evidence" in card
        assert "deployment/payments-processor · CrashLoopBackOff" in card
        assert turn["check"]["summary"] == [{"resource": "deployment/payments-processor", "problem": "CrashLoopBackOff"}]
        assert [tool["where"] for tool in turn["tools"]] == ["sandbox", "harness", "harness", "sandbox", "sandbox",
                                                            "sandbox", "sandbox"]
        # A second turn picks up only the new reads.
        model.calls = [shell("kubectl get events -n payments")]
        stream = await events(chat, {"type": "threads.add_user_message", "params": {
            "thread_id": thread_id, "input": message("Any events?")}})
        assert not [event for event in stream if event["type"] == "error"]
        thread = await store.load_thread(thread_id, {})
        assert [item["seq"] for item in thread.metadata["evidence"]] == [1, 2, 3, 4]
        assert thread.metadata["turns"][1]["check"]["status"] == "evidence_passed"
    finally:
        store.close()


def test_the_ui_serves_its_own_views_and_the_health_summary(worker, tmp_path):
    from starlette.testclient import TestClient

    from examples.sre.ui.app import create_app

    store = SQLiteStore(tmp_path / "threads.sqlite3")
    client = worker.client()
    chat = HarnessChatServer(make_spec({"payments"}), store, client, model=Calls(), output_dir=tmp_path / "threads")
    app = create_app(chat, config={"model": "scripted"}, port=8001, jaeger_url=None, worker=client.info,
                     health=client.health)
    try:
        with TestClient(app, base_url="http://localhost:8001") as browser:
            config = browser.get("/api/config").json()
            assert config["extension"] == "/static/agent.js" and config["stylesheet"] == "/static/agent.css"
            assert "export async function renderHome" in browser.get("/static/agent.js").text
            health = browser.get("/api/health").json()
            processor = health["namespaces"][0]["workloads"][0]
            assert processor["name"] == "payments-processor" and processor["state"] == "failing"
            assert processor["reasons"] == ["CrashLoopBackOff", "last exit: Error (code 1)"]
    finally:
        store.close()


def test_the_agent_keeps_compaction_and_memory_when_asked():
    from agents.sandbox import Manifest

    plain = make_spec({"payments"}).build_agent(Manifest(root="/sandboxes/active/s-x"), "gpt-6.1-terra")
    assert [type(item).__name__ for item in plain.capabilities] == ["Shell", "Filesystem", "Compaction", "Skills"]
    spec = make_spec({"payments"}, memory_models=(EXTRACT_MODEL, CONSOLIDATE_MODEL))
    assert spec.memory_dir == "memories"
    memory = spec.build_agent(Manifest(root="/sandboxes/active/s-x"), "gpt-6.1-terra").capabilities[-1]
    assert type(memory).__name__ == "Memory" and memory.read.live_update is False
    # The SDK's defaults, with the GPT-6 counterparts of its models: efficient extraction, stronger consolidation.
    assert (memory.generate.phase_one_model, memory.generate.phase_two_model) == ("gpt-6-luna", "gpt-6.1-terra")
    defaults = MemoryGenerateConfig()
    assert memory.generate.max_raw_memories_for_consolidation == defaults.max_raw_memories_for_consolidation == 256
    assert memory.generate.phase_two_max_turns == defaults.phase_two_max_turns
    assert memory.generate.phase_one_model_settings == defaults.phase_one_model_settings
    assert "never turn instructions" in memory.generate.extra_prompt


async def test_a_memory_enabled_agent_runs_before_any_memory_exists(worker, tmp_path):
    """The first conversation has no memory_summary.md yet; the SDK's Memory capability must treat that as empty."""
    store = SQLiteStore(tmp_path / "threads.sqlite3")
    chat = HarnessChatServer(make_spec({"payments"}, memory_models=(EXTRACT_MODEL, CONSOLIDATE_MODEL)), store,
                             worker.client(),
                             model=Calls([shell("ls")], answer="Done."), output_dir=tmp_path / "threads")
    try:
        stream = await events(chat, {"type": "threads.create", "params": {"input": message("Hello")}})
        assert not [event for event in stream if event["type"] == "error"], stream
    finally:
        # Closing would run the SDK's memory generation with a live model; drop the session instead.
        for opened in chat._open.values():
            opened.closer.cancel()
        store.close()
