# Copyright 2026 openai-agent-mxc contributors
# SPDX-License-Identifier: Apache-2.0
"""The SRE agent on the harness, against the worker's real gRPC service and a fake kubectl (root conftest)."""

import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from agents.sandbox import MemoryGenerateConfig

from apps.sre.agent.agent import CONSOLIDATE_MODEL, EXTRACT_MODEL
from apps.sre.agent.lib import findings
from apps.sre.agent.spec import REPORT, make_spec, runbooks
from apps.sre.ui.card import check_rows, file_status
from openai_harness.engine import Harness
from openai_harness.spec import Conversation
from openai_harness.store import SQLiteStore, Thread
from openai_harness.testing import Calls, ask, shell, titles

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
    manifest = make_spec({"payments"}).start(None, "/sandboxes/active/s-x")
    assert set(manifest.entries) == {"evidence", "output", "work", "runbooks"}


def conversation_with(tmp_path, text):
    entry = {"seq": 1, "path": LOGS_FILE, "label": "kubectl logs", "turn": 1, "bytes": len(text), "sha256": "x"}
    host = tmp_path / "thr" / "turn-1" / entry["path"]
    host.parent.mkdir(parents=True)
    host.write_text(text)
    thread = Thread(id="thr", created_at=datetime.now(), metadata={"evidence": [entry]})
    return Conversation(thread, tmp_path / "thr")


def findings_file(*evidence, resource="deployment/payments-processor"):
    return {"output/findings.json": json.dumps({"findings": [{"resource": resource, "evidence": list(evidence)}]}).encode(),
            "output/findings.md": b"# Findings"}


def test_findings_quotes_are_checked_against_the_journal_copy(tmp_path):
    conversation = conversation_with(tmp_path, LOGS)
    quote = {"file": LOGS_FILE, "quote": "Missing required env var   DATABASE_URL"}
    passed = findings.check(conversation, findings_file(quote))
    assert passed["status"] == "evidence_passed" and passed["results"][0]["verified"] is True
    assert passed["results"][0]["quotes"][0]["found"] is True
    # Every quote is checked: one found and two not, each with its reason; the finding is unverified.
    checked = findings.check(conversation, findings_file(quote, {**quote, "quote": "OOMKilled"},
                                                         {**quote, "file": "evidence/999-made-up.txt"}))
    assert checked["status"] == "failed" and checked["detail"] == "2 of 3 quotes not found"
    assert [item["found"] for item in checked["results"][0]["quotes"]] == [True, False, False]
    assert [failure["reason"] for failure in checked["failures"]] == [
        "not in the file", "the sandbox worker never recorded this file"]
    assert checked["summary"][0]["verified"] is False and checked["quotes"] == 1 and checked["quotes_total"] == 3
    assert findings.check(conversation, findings_file())["status"] == "failed"
    # A long label is cut to 80 characters and says so.
    long = findings.check(conversation, findings_file(quote, resource="deployment/payments-processor · " + "x" * 80))
    assert len(long["results"][0]["resource"]) == 80 and long["results"][0]["resource"].endswith("x…")
    # Each result names its finding's place, since two findings may name the same resource.
    listed = {"output/findings.json": json.dumps({"findings": ["not an object", {"resource": "deployment/a", "evidence": [quote]},
                                                               {"resource": "deployment/a", "evidence": [quote]}]}).encode()}
    assert [result["index"] for result in findings.check(conversation, listed)["results"]] == [1, 2]
    assert findings.check(conversation, {"output/findings.md": b"x"})["status"] == "no_findings"
    # A failed check asks the agent once to re-read the file it cited.
    prompt = findings.retry_prompt(checked)
    assert '"OOMKilled" in ' + LOGS_FILE + ": not in the file" in prompt and "Re-read each file" in prompt
    assert findings.retry_prompt(passed) is None


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
    harness = Harness(make_spec({"payments"}), store, worker.client(), model=model, output_dir=tmp_path / "threads",
                      model_label="scripted", card=check_rows, file_status=file_status, preferred_output=REPORT)
    try:
        thread_id, stream = await ask(harness, "Why is payments-processor crashing?")
        assert not [event for event in stream if event["type"] == "error"], stream
        assert "[sandbox-worker] saved as evidence/001" in model.outputs[0]
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
        assert "1 finding, 2 quotes found in the evidence" in card
        assert '"value": "CrashLoopBackOff"' in card and '"value": "deployment/payments-processor"' in card
        # Steps name only what is unusual: here, the harness tool.
        shown = titles(stream)
        assert any(title.startswith("pod_logs ") and title.endswith(" · harness") for title in shown)
        assert "kubectl get pods -n payments -o wide" in shown
        assert turn["check"]["summary"] == [{"resource": "deployment/payments-processor", "problem": "CrashLoopBackOff",
                                             "verified": True}]
        assert "the causes are the agent's reasoning" in card
        assert [tool["where"] for tool in turn["tools"]] == ["sandbox", "harness", "harness", "sandbox", "sandbox",
                                                            "sandbox", "sandbox"]
        # A second turn picks up only the new reads.
        model.calls = [shell("kubectl get events -n payments")]
        _, stream = await ask(harness, "Any events?", conversation=thread_id)
        assert not [event for event in stream if event["type"] == "error"]
        thread = await store.load_thread(thread_id, {})
        assert [item["seq"] for item in thread.metadata["evidence"]] == [1, 2, 3, 4]
        assert thread.metadata["turns"][1]["check"]["status"] == "evidence_passed"
    finally:
        store.close()


def test_the_ui_serves_its_own_page_and_the_health_summary(worker, tmp_path):
    from starlette.testclient import TestClient

    from apps.sre.ui.app import create_app

    store = SQLiteStore(tmp_path / "threads.sqlite3")
    client = worker.client()
    harness = Harness(make_spec({"payments"}), store, client, model=Calls(), output_dir=tmp_path / "threads")
    app = create_app(harness, config={"model": "scripted"}, port=8001, jaeger_url=None, worker=client.info,
                     health=client.health)
    try:
        with TestClient(app, base_url="http://localhost:8001") as browser:
            # The page is the SRE UI's own, built from web/ into static/app (make page); a checkout that has not
            # built it says so. The harness serves the API.
            page = browser.get("/")
            built = Path(__file__).resolve().parents[1] / "ui" / "static" / "app" / "index.html"
            if built.is_file():
                assert page.status_code == 200 and "<title>SRE agent</title>" in page.text
                assert '<div id="root"></div>' in page.text and page.headers["cache-control"] == "no-store"
                script = page.text.split('src="', 1)[1].split('"', 1)[0]
                assert script.startswith("/static/app/assets/") and browser.get(script).status_code == 200
            else:
                assert page.status_code == 503 and "make page" in page.text
            assert browser.get("/chatkit-ui").status_code == 404 and browser.get("/chatkit").status_code == 404
            assert "export async function renderHome" in browser.get("/static/sre.js").text
            assert browser.get("/static/app.css").status_code == 200 and browser.get("/harness/app.js").status_code == 404
            config = browser.get("/api/config").json()
            assert "extension" not in config and config["greeting"] and len(config["about"]) == 4
            assert config["health"] is True and config["worker"] is True and config["follow_ups"]
            health = browser.get("/api/health").json()
            processor = health["namespaces"][0]["workloads"][0]
            assert processor["name"] == "payments-processor" and processor["state"] == "failing"
            assert processor["reasons"] == ["CrashLoopBackOff", "last exit: Error (code 1)"]
            # What the worker adds for people, through the gRPC contract: events of any type, and the rollout.
            assert processor["events"][0]["reason"] == "BackOff" and processor["rollout"] is None
            assert processor["waiting_message"] == ""
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
    harness = Harness(make_spec({"payments"}, memory_models=(EXTRACT_MODEL, CONSOLIDATE_MODEL)), store, worker.client(),
                      model=Calls([shell("ls")], answer="Done."), output_dir=tmp_path / "threads")
    try:
        _, stream = await ask(harness, "Hello")
        assert not [event for event in stream if event["type"] == "error"], stream
    finally:
        # Closing would run the SDK's memory generation with a live model; drop the session instead.
        for opened in harness._open.values():
            opened.closer.cancel()
        store.close()


def health_summary(*workloads, at="2026-11-01T12:00:00Z"):
    return {"generated_at": at, "namespaces": [{"namespace": "payments", "workloads": list(workloads)}]}


def workload(name, state, reasons=(), ready=0):
    return {"kind": "Deployment", "name": name, "state": state, "ready": ready, "desired": 1, "reasons": list(reasons),
            "restarts": 3 if state != "healthy" else 0, "warnings": 1, "last_warning": "Back-off pulling\x1b[2J image",
            "last_warning_at": "2026-11-01T11:58:00Z"}


async def test_the_health_board_opens_one_shared_issue_per_unhealthy_workload(worker, tmp_path):
    import pytest
    from starlette.testclient import TestClient

    from apps.sre.agent.spec import issue_context
    from apps.sre.ui.app import create_app
    from apps.sre.ui.issues import Issues
    from openai_harness.store import SHARED

    store = SQLiteStore(tmp_path / "threads.sqlite3", admins=frozenset({"lead@example.com"}))
    harness = Harness(make_spec({"payments"}), store, worker.client(), model=Calls([shell("echo looking")]),
                      output_dir=tmp_path / "threads")
    issues = Issues(harness, None)
    try:
        failing = workload("payments-ledger", "failing", ["ImagePullBackOff"])
        await issues.sync(health_summary(failing, workload("payments-api", "healthy", ready=1)))
        await issues.sync(health_summary(failing))  # still failing: the same issue, not a second one
        [opened] = await issues.listing()
        assert (opened["fingerprint"], opened["state"]) == ("payments/deployment/payments-ledger", "open")
        assert opened["title"] == "payments-ledger: ImagePullBackOff"

        # Opened without a model: a card of what the worker read, with the question to investigate it.
        card = json.dumps((await store.load_entries(opened["thread_id"], {}))[0]["card"])
        assert "ImagePullBackOff, 3 restarts" in card and "\x1b" not in card and "investigate_issue" in card
        assert "Why is deployment payments-ledger in payments failing (ImagePullBackOff)?" in card

        # Everyone sees it and can work in it; only an admin deletes it.
        thread = await store.load_thread(opened["thread_id"], {"user": "bo@example.com"})
        assert thread.metadata["owner"] == SHARED
        for user in ("ana@example.com", "bo@example.com", None):
            assert opened["thread_id"] in [item.id for item in await store.load_threads({"user": user})]
        with pytest.raises(PermissionError):
            await store.delete_thread(opened["thread_id"], {"user": "bo@example.com"})
        assert "issue the health board opened" in issue_context(harness.conversation(thread))
        _, stream = await ask(harness, "Why?", conversation=opened["thread_id"], user="bo@example.com")
        assert not [event for event in stream if event["type"] == "error"], stream
        turn = (await store.load_thread(opened["thread_id"], {})).metadata["turns"][0]
        assert turn["requested_by"] == "bo@example.com"

        # Healthy again: recovered, with a note; failing later opens a new issue.
        await issues.sync(health_summary(workload("payments-ledger", "healthy", ready=1), at="2026-11-01T12:30:00Z"))
        [recovered] = await issues.listing()
        assert recovered["state"] == "recovered" and recovered["title"].endswith("(recovered)")
        await issues.sync(health_summary(failing, at="2026-11-01T13:00:00Z"))
        assert [item["state"] for item in await issues.listing()] == ["recovered", "open"]

        async def unchanged():
            return health_summary(failing, at="2026-11-01T13:00:00Z")
        app = create_app(harness, config={"model": "scripted"}, port=8001, jaeger_url=None, issues=Issues(harness, unchanged))
        with TestClient(app, base_url="http://localhost:8001") as browser:
            assert browser.get("/api/config").json()["issues"] is True
            assert len(browser.get("/api/issues").json()["issues"]) == 2
            assert browser.delete(f"/api/conversations/{opened['thread_id']}").status_code == 403
    finally:
        await harness.close_all()
        store.close()


async def test_a_failed_check_gets_one_corrective_pass_and_the_card_says_so(worker, tmp_path):
    def findings_json(quote):
        return json.dumps({"findings": [{"resource": "deployment/payments-processor", "problem": "CrashLoopBackOff",
                                         "cause": "It crashes.", "evidence": [{"file": PODS_FILE, "quote": quote}]}]})
    # The first pass cites a quote the evidence does not hold; asked to correct it, the agent copies the real text.
    write = (f"mkdir -p output work && if [ -f work/attempt ]; then printf '%s' '{findings_json('CrashLoopBackOff')}' "
             f"> output/findings.json; else printf '%s' '{findings_json('OOMKilled')}' > output/findings.json; "
             "touch work/attempt; fi")
    store = SQLiteStore(tmp_path / "threads.sqlite3")
    harness = Harness(make_spec({"payments"}), store, worker.client(), card=check_rows, file_status=file_status,
                      model=Calls([shell("kubectl get pods -n payments -o wide"), shell(write)], answer="Done."),
                      output_dir=tmp_path / "threads")
    try:
        thread_id, stream = await ask(harness, "Why is it crashing?")
        assert not [event for event in stream if event["type"] == "error"], stream
        turn = (await store.load_thread(thread_id, {})).metadata["turns"][0]
        assert turn["check_first"]["status"] == "failed" and turn["check_first"]["detail"] == "1 of 1 quotes not found"
        assert turn["check"]["status"] == "evidence_passed" and turn["check"]["results"][0]["verified"] is True
        assert turn["file_status"]["output/findings.json"]["state"] == "checked"
        assert turn["usage"]["requests"] >= 4  # both passes count
        shown = json.dumps(stream)
        assert "The host check failed: 1 of 1 quotes not found" in shown
        assert "First check: 1 of 1 quotes not found" in shown and "found in the evidence" in shown
    finally:
        await harness.close_all()
        store.close()


def test_pod_logs_since_takes_a_duration():
    from apps.sre.agent.tools.logs import since_seconds

    assert [since_seconds(value) for value in (None, "", "45s", "10m", "1h30m", "30d")] == [0, 0, 45, 600, 5400, 604800]
    for value in ("ten minutes", "10", "5x"):
        try:
            since_seconds(value)
        except ValueError:
            continue
        raise AssertionError(value)
