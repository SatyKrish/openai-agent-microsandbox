# Copyright 2026 openai-agent-mxc contributors
# SPDX-License-Identifier: Apache-2.0
"""The harness and its shared UI page against the worker's real gRPC service (see the root conftest)."""

import asyncio
import json
from datetime import datetime, timedelta, timezone

from agents import Runner
from agents.sandbox import Manifest, SandboxAgent
from agents.sandbox.capabilities import Shell
from agents.sandbox.entries import Dir
from starlette.testclient import TestClient

from openai_harness import http
from openai_harness.chat import HarnessChatServer, preferred_file, running_elsewhere
from openai_harness.spec import AgentSpec
from openai_harness.store import SQLiteStore
from openai_harness.testing import Calls, events, message, shell

SPEC = AgentSpec(
    name="test_agent",
    build_agent=lambda manifest, model: SandboxAgent(name="Test", model=model, instructions="Answer.",
                                                     default_manifest=manifest, capabilities=[Shell()]),
    start=lambda conversation, has_uploads, root: Manifest(root=root, entries={"output": Dir(), "work": Dir()}),
    check=lambda conversation, turn, files: {"status": "checked", "files": sorted(files)},
)
STARTING = {"runbooks/notes.md": b"# Notes\n"}


def make_chat(worker, tmp_path, model, **options):
    store = SQLiteStore(tmp_path / "threads.sqlite3")
    return HarnessChatServer(SPEC, store, worker.client(), model=model, output_dir=tmp_path / "threads",
                             model_label="scripted", **options)


def app_for(chat, worker=None, **config):
    return http.ui_application(chat, config={"title": "<Test> agent", "model": "scripted", **config}, port=8009,
                               jaeger_url=None, starting_files=STARTING, worker=worker)


async def new_thread(chat, text="First question"):
    stream = await events(chat, {"type": "threads.create", "params": {"input": message(text)}})
    assert not [event for event in stream if event["type"] == "error"], stream
    return next(event["thread"]["id"] for event in stream if event["type"] == "thread.created"), stream


async def user_messages(chat, thread_id):
    history = chat.history(thread_id)
    try:
        return [item["content"] for item in await history.get_items() if item.get("role") == "user"]
    finally:
        history.close()


async def test_a_conversation_keeps_one_workspace_and_deleting_it_removes_the_workspace(worker, tmp_path):
    model = Calls([shell("echo $((6*7)) > output/answer.txt && cat output/answer.txt")], answer="42.")
    chat = make_chat(worker, tmp_path, model)
    try:
        thread_id, stream = await new_thread(chat, "What is 6 times 7?")
        thread = await chat.store.load_thread(thread_id, {})
        meta, turn = thread.metadata, thread.metadata["turns"][0]
        workspace = meta["workspace"].split("/", 1)[1]
        assert meta["workspace"].startswith("test-worker/s-") and turn["lifecycle"] == "created"
        assert turn["check"] == {"status": "checked", "files": ["output/answer.txt"]}
        assert (tmp_path / "threads" / thread_id / "turn-1/output/answer.txt").read_text() == "42\n"
        assert [tool["where"] for tool in turn["tools"]] == ["sandbox"]
        card = json.dumps([event for event in stream if event["type"] == "thread.item.done"
                           and event["item"]["type"] == "widget"])
        assert f"created test-worker/{workspace}" in card

        stream = await events(chat, {"type": "threads.add_user_message", "params": {
            "thread_id": thread_id, "input": message("Still there?")}})
        assert not [event for event in stream if event["type"] == "error"]
        turns = (await chat.store.load_thread(thread_id, {})).metadata["turns"]
        assert turns[1]["lifecycle"] == "reopened"
        assert (worker.data_dir / "active" / workspace / "output/answer.txt").is_file()

        await chat.store.delete_thread(thread_id, {})
        assert not (worker.data_dir / "active" / workspace).exists()
        assert not (tmp_path / "threads" / thread_id).exists()
        assert (worker.data_dir / "history" / workspace / "journal.jsonl").is_file()
        assert await user_messages(chat, thread_id) == []
    finally:
        chat.store.close()


async def test_two_messages_sent_at_once_both_keep_their_turn_and_history(worker, tmp_path):
    chat = make_chat(worker, tmp_path, Calls(delay=0.2))
    try:
        thread_id, _ = await new_thread(chat)
        sent = [{"type": "threads.add_user_message", "params": {"thread_id": thread_id, "input": message(text)}}
                for text in ("Second question", "Third question")]
        streams = await asyncio.gather(*(events(chat, payload) for payload in sent))
        assert not [event for stream in streams for event in stream if event["type"] == "error"]
        thread = await chat.store.load_thread(thread_id, {})
        assert [turn["number"] for turn in thread.metadata["turns"]] == [1, 2, 3]
        assert all(turn["status"] == "completed" for turn in thread.metadata["turns"])
        assert await user_messages(chat, thread_id) == ["First question", "Second question", "Third question"]
    finally:
        chat.store.close()


async def test_a_failed_run_leaves_no_partial_turn_in_the_history(worker, tmp_path, monkeypatch):
    chat = make_chat(worker, tmp_path, Calls())
    try:
        thread_id, _ = await new_thread(chat)
        original = Runner.run_streamed

        def failing(*args, **kwargs):
            result = original(*args, **kwargs)
            stream = result.stream_events

            async def broken():
                async for event in stream():
                    yield event
                raise RuntimeError("simulated failure after the model answered")
            result.stream_events = broken
            return result

        monkeypatch.setattr(Runner, "run_streamed", failing)
        stream = await events(chat, {"type": "threads.add_user_message", "params": {
            "thread_id": thread_id, "input": message("This turn fails")}})
        assert [event for event in stream if event["type"] == "error"]
        assert await user_messages(chat, thread_id) == ["First question"]
    finally:
        chat.store.close()


async def test_an_unreachable_worker_fails_the_turn_with_a_clear_message(tmp_path):
    from agent_mxc import MXCSandboxClient

    client = MXCSandboxClient("127.0.0.1:9", worker="gone-worker")
    chat = HarnessChatServer(SPEC, SQLiteStore(tmp_path / "threads.sqlite3"), client, model=Calls(),
                             output_dir=tmp_path / "threads")
    try:
        stream = await events(chat, {"type": "threads.create", "params": {"input": message("Hello")}})
        errors = [event for event in stream if event["type"] == "error"]
        assert errors and "sandbox worker gone-worker is unavailable" in errors[0]["message"]
    finally:
        chat.store.close()


def test_the_shared_page_is_configured_by_the_agent_and_shows_its_worker(worker, tmp_path):
    chat = make_chat(worker, tmp_path, Calls())

    async def broken():
        raise RuntimeError("worker restarting")

    with TestClient(app_for(chat, worker=chat.client.info, follow_ups=[{"label": "Next", "prompt": "Go on."}]),
                    base_url="http://localhost:8009") as client:
        page = client.get("/")
        assert page.status_code == 200 and "<title>&lt;Test&gt; agent</title>" in page.text and "<Test>" not in page.text
        assert client.get("/harness/app.js").status_code == 200 and client.get("/harness/trace.js").status_code == 200
        config = client.get("/api/config").json()
        assert config["name"] == "test_agent" and config["uploads"] is None and config["worker"] is True
        assert config["starting_files"] == [{"path": "runbooks/notes.md", "bytes": len(STARTING["runbooks/notes.md"])}]
        assert client.get("/api/starting-files/runbooks/notes.md").content == STARTING["runbooks/notes.md"]
        for path in ("runbooks/other.md", "runbooks/../threads.sqlite3"):
            assert client.get(f"/api/starting-files/{path}").status_code == 404
        info = client.get("/api/worker").json()
        assert info["status"] == "ok" and info["domain"] == "payments" and "Kubernetes API only" in info["egress"]
        # Only loopback hosts may reach the server, and only same-origin requests reach ChatKit.
        assert client.get("/", headers={"host": "evil.example"}).status_code == 400
        assert client.post("/chatkit", content=b"{}", headers={"origin": "http://evil.example"}).status_code == 403
    with TestClient(app_for(chat, worker=broken), base_url="http://localhost:8009") as client:
        assert client.get("/api/worker").status_code == 503
    with TestClient(app_for(chat), base_url="http://localhost:8009") as client:
        assert client.get("/api/worker").status_code == 404 and client.get("/api/config").json()["worker"] is False
    chat.store.close()


def test_a_turn_running_in_another_process_blocks_a_new_one_until_it_is_stale():
    now = datetime.now(timezone.utc)
    running = {"turns": [{"number": 1, "status": "running", "started_at": now.isoformat()}]}
    assert running_elsewhere(running, set(), "thr_1")
    assert not running_elsewhere(running, {"thr_1"}, "thr_1")
    assert not running_elsewhere({"turns": [{"status": "completed", "started_at": now.isoformat()}]}, set(), "thr_1")
    stale = (now - timedelta(minutes=20)).isoformat()
    assert not running_elsewhere({"turns": [{"status": "running", "started_at": stale}]}, set(), "thr_1")


async def test_steps_say_where_they_ran(worker, tmp_path):
    chat = make_chat(worker, tmp_path, Calls([shell("echo hi > output/a.txt")], answer="Done."))
    _, stream = await new_thread(chat, "Write a file")
    tasks = [event["update"]["task"] for event in stream if (event.get("update") or {}).get("type") == "workflow.task.updated"]
    done = [task for task in tasks if task["title"].startswith("exec_command")]
    assert done[-1]["title"] == "exec_command · exit 0 · sandbox"
    assert any(task["title"].startswith("Created the workspace") for task in tasks)
    effects = [event for event in stream if event["type"] == "client_effect"]
    assert effects[-1]["data"]["path"] == "output/a.txt"
    chat.store.close()


def test_the_panel_opens_a_checked_output_before_the_agents_report():
    turn = {"files": [{"path": "output/report.md", "changed": True}, {"path": "output/data.json", "changed": True},
                      {"path": "work/x.py", "changed": True}],
            "file_status": {"output/data.json": {"state": "checked"}, "output/report.md": {"state": "unchecked"}}}
    assert preferred_file(turn, "output/report.md") == "output/data.json"
    turn["file_status"] = {}
    assert preferred_file(turn, "output/report.md") == "output/report.md"
    assert preferred_file({"files": [{"path": "work/x.py", "changed": True}]}) is None
