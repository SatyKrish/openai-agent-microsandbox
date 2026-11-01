# Copyright 2026 openai-agent-mxc contributors
# SPDX-License-Identifier: Apache-2.0
"""The harness and its shared UI page against the worker's real gRPC service (see the root conftest)."""

import asyncio
import io
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

from agents import Runner
from agents.sandbox import Manifest, SandboxAgent
from agents.sandbox.capabilities import Shell
from agents.sandbox.entries import Dir
from starlette.testclient import TestClient

from openai_harness import http
from openai_harness.chat import HarnessChatServer, preferred_file, running_elsewhere
from openai_harness.memory import MemoryStore, UserMemory, user_key
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


def app_for(chat, worker=None, health=None, **config):
    return http.ui_application(chat, config={"title": "<Test> agent", "model": "scripted", **config}, port=8009,
                               jaeger_url=None, starting_files=STARTING, worker=worker, health=health)


async def new_thread(chat, text="First question", user=None):
    stream = await events(chat, {"type": "threads.create", "params": {"input": message(text)}}, user=user)
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
        assert turns[1]["lifecycle"] == "continued"  # the session stayed open between turns
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
        assert info["status"] == "ok" and info["domain"] == "payments" and "through the worker's proxy" in info["egress"]
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


async def test_steps_say_what_ran_and_where(worker, tmp_path):
    chat = make_chat(worker, tmp_path, Calls([shell("echo hi > output/a.txt")], answer="Done."))
    _, stream = await new_thread(chat, "Write a file")
    tasks = [event["update"]["task"] for event in stream if (event.get("update") or {}).get("type") == "workflow.task.updated"]
    done = [task for task in tasks if task["title"].startswith("echo hi")]
    assert done[-1]["title"] == "echo hi > output/a.txt · exit 0 · sandbox"
    thread = (await chat.store.load_threads(10, None, "desc", {})).data[0]
    assert thread.metadata["turns"][0]["tools"][0]["summary"] == "echo hi > output/a.txt"
    assert any(task["title"].startswith("Created the workspace") for task in tasks)
    effects = [event for event in stream if event["type"] == "client_effect"]
    assert effects[-1]["data"]["path"] == "output/a.txt"
    chat.store.close()


async def test_parallel_steps_each_keep_their_own_exit_status(worker, tmp_path):
    chat = make_chat(worker, tmp_path, Calls([[shell("exit 3"), shell("echo ok")]], answer="Done."))
    thread_id, stream = await new_thread(chat, "Run both")
    turn = (await chat.store.load_thread(thread_id, {})).metadata["turns"][0]
    assert [(tool["summary"], tool["status"]) for tool in turn["tools"]] == [("exit 3", "exit 3"), ("echo ok", "exit 0")]
    titles = [event["update"]["task"]["title"] for event in stream
              if (event.get("update") or {}).get("type") == "workflow.task.updated"]
    assert "exit 3 · exit 3 · sandbox" in titles and "echo ok · exit 0 · sandbox" in titles
    chat.store.close()


def test_the_panel_opens_a_checked_output_before_the_agents_report():
    turn = {"files": [{"path": "output/report.md", "changed": True}, {"path": "output/data.json", "changed": True},
                      {"path": "work/x.py", "changed": True}],
            "file_status": {"output/data.json": {"state": "checked"}, "output/report.md": {"state": "unchecked"}}}
    assert preferred_file(turn, "output/report.md") == "output/data.json"
    turn["file_status"] = {}
    assert preferred_file(turn, "output/report.md") == "output/report.md"
    assert preferred_file({"files": [{"path": "work/x.py", "changed": True}]}) is None


def test_the_page_serves_an_agents_health_summary(worker, tmp_path):
    chat = make_chat(worker, tmp_path, Calls())

    async def health():
        return {"generated_at": "2026-11-01T06:00:00Z", "namespaces": [{"namespace": "payments", "error": "",
                "workloads": [{"name": "payments-processor", "state": "failing"}]}]}

    async def broken():
        raise RuntimeError("worker restarting")

    with TestClient(app_for(chat, health=health), base_url="http://localhost:8009") as client:
        assert client.get("/api/config").json()["health"] is True
        reply = client.get("/api/health").json()
        assert reply["status"] == "ok" and reply["namespaces"][0]["workloads"][0]["state"] == "failing"
    with TestClient(app_for(chat, health=broken), base_url="http://localhost:8009") as client:
        assert client.get("/api/health").status_code == 503
    with TestClient(app_for(chat), base_url="http://localhost:8009") as client:
        assert client.get("/api/health").status_code == 404 and client.get("/api/config").json()["health"] is False
    chat.store.close()


def raw_memory(conversation: str, updated: datetime, text: str) -> str:
    """A raw memory as the SDK writes it, header first."""
    return (f"rollout_id: {conversation}\nupdated_at: {updated.isoformat()}\nrollout_path: sessions/{conversation}.jsonl\n"
            f"rollout_summary_file: rollout_summaries/{conversation}_incident.md\nterminal_state: completed\n\n---\n"
            f"description: {text}\n")


def remember(root, conversation: str, text: str, updated: datetime | None = None) -> None:
    """Store one conversation's memory on the host, as a published consolidation would leave it."""
    updated = updated or datetime.now(timezone.utc)
    (root / "raw_memories").mkdir(parents=True, exist_ok=True)
    (root / "rollout_summaries").mkdir(parents=True, exist_ok=True)
    (root / "raw_memories" / f"{conversation}.md").write_text(raw_memory(conversation, updated, text))
    (root / "rollout_summaries" / f"{conversation}_incident.md").write_text(f"updated_at: {updated.isoformat()}\n{text}\n")
    with (root / "MEMORY.md").open("a") as handle:
        handle.write(f"- {text}\n")
    (root / "memory_summary.md").write_text("Payments: see MEMORY.md.\n")


def generates_memory(chat, thread_id: str, text: str) -> None:
    """Make closing the conversation's open session write memory, as the SDK's generation does in a pre-stop hook."""
    session = chat._open[thread_id].session

    async def generate():
        files = {"MEMORY.md": f"{text}\n", "memory_summary.md": f"Payments: {text}\n",
                 "raw_memories/thr-earlier.md": raw_memory("thr-earlier", datetime.now(timezone.utc), text),
                 "rollout_summaries/thr-earlier_incident.md": f"{text}\n"}
        for name, data in files.items():
            await session.write(Path(f"memories/{name}"), io.BytesIO(data.encode()))

    session.register_pre_stop_hook(generate)


async def test_memory_carries_across_conversations_through_the_harness(worker, tmp_path):
    """The SDK distils memory into memories/ when a session closes; here the script writes it, as that step would."""
    memory = UserMemory(tmp_path / "memory")
    store = memory.for_user(None)
    chat = make_chat(worker, tmp_path, Calls([shell("echo investigating")], answer="Noted."), memory=memory,
                     idle_close_s=0.4)
    try:
        first, _ = await new_thread(chat, "Investigate payments")
        generates_memory(chat, first, "payments-processor needs DATABASE_URL")
        assert first in chat._open and store.files() == {}  # open, and nothing published while it is
        await asyncio.sleep(0.8)
        assert first not in chat._open  # closed when idle, and its memory published
        assert store.files()["MEMORY.md"] == b"payments-processor needs DATABASE_URL\n"
        summary = memory.summary(None)
        assert summary["text"].startswith("Payments: payments-processor") and summary["conversations"] == 1
        assert summary["user"] == "guest" and summary["shared"] is True

        chat.model = Calls([shell("cat memories/MEMORY.md")], answer="I remember.")
        second, stream = await new_thread(chat, "Anything known about payments?")
        assert "payments-processor needs DATABASE_URL" in chat.model.outputs[0]
        assert "Seeded with the agent's memory from earlier conversations (4 files)" in json.dumps(stream)

        # A deleted conversation is not remembered: deleting does not run the hooks where the SDK generates memory.
        generates_memory(chat, second, "forget me")
        await chat.store.delete_thread(second, {})
        assert second not in chat._open
        assert store.files()["MEMORY.md"] == b"payments-processor needs DATABASE_URL\n"
    finally:
        await chat.close_all()
        chat.store.close()


async def test_each_signed_in_user_has_their_own_memory_and_guests_share_one(worker, tmp_path):
    memory = UserMemory(tmp_path / "memory")
    chat = make_chat(worker, tmp_path, Calls([shell("echo investigating")], answer="Noted."), memory=memory,
                     idle_close_s=3600)
    try:
        ana, _ = await new_thread(chat, "Investigate payments", user="ana@example.com")
        assert (await chat.store.load_thread(ana, {})).metadata["owner"] == "ana@example.com"
        generates_memory(chat, ana, "Ana prefers kubectl tables")
        await chat.close_all()
        assert b"Ana prefers" in memory.for_user("ana@example.com").files()["MEMORY.md"]
        assert memory.for_user(None).files() == {} and memory.for_user("bo@example.com").files() == {}
        assert memory.summary("ana@example.com")["shared"] is False

        # Another user, and the guest, start without Ana's memory.
        for user in ("bo@example.com", None):
            chat.model = Calls([shell("cat memories/MEMORY.md || echo none")], answer="Checked.")
            _, stream = await new_thread(chat, "Anything known?", user=user)
            assert "Ana prefers" not in chat.model.outputs[0] and "Seeded" not in json.dumps(stream)
            await chat.close_all()
        # Ana's next conversation starts with hers.
        chat.model = Calls([shell("cat memories/MEMORY.md")], answer="I remember.")
        await new_thread(chat, "Anything known?", user="ana@example.com")
        assert "Ana prefers kubectl tables" in chat.model.outputs[0]
    finally:
        await chat.close_all()
        chat.store.close()


async def test_a_deleted_conversation_is_forgotten_after_its_memory_was_published(worker, tmp_path):
    memory = UserMemory(tmp_path / "memory")
    chat = make_chat(worker, tmp_path, Calls([shell("echo hi")], answer="Done."), memory=memory, idle_close_s=3600)
    try:
        kept, _ = await new_thread(chat, "First", user="ana@example.com")
        gone, _ = await new_thread(chat, "Second", user="ana@example.com")
        await chat.close_all()
        store = memory.for_user("ana@example.com")
        remember(store.root, kept, "kept lesson")
        remember(store.root, gone, "lesson from the deleted conversation")
        await chat.store.delete_thread(gone, {})
        files = store.files()
        assert f"raw_memories/{kept}.md" in files and f"raw_memories/{gone}.md" not in files
        assert not any(name.startswith(f"rollout_summaries/{gone}") for name in files)
        assert b"deleted conversation" not in files["raw_memories.md"]  # what the agent may read is rebuilt
        assert memory.summary("ana@example.com")["conversations"] == 1
        await chat.store.delete_thread(kept, {})
        assert store.files() == {} and not store.root.exists()  # nothing left to remember
    finally:
        await chat.close_all()
        chat.store.close()


def test_memory_forgets_conversations_by_age_and_beyond_the_newest(tmp_path):
    now = datetime.now(timezone.utc)
    store = MemoryStore(tmp_path / "ana", max_age=timedelta(days=90), max_conversations=2)
    for name, days in (("old", 91), ("older-but-kept", 30), ("recent", 2), ("newest", 1)):
        remember(store.root, name, f"lesson {name}", now - timedelta(days=days))
    # "old" is past 90 days; "older-but-kept" falls outside the newest two.
    assert sorted(store.prune(now)) == ["old", "older-but-kept"]
    assert sorted(path.stem for path in (store.root / "raw_memories").glob("*.md")) == ["newest", "recent"]
    assert sorted(path.name for path in (store.root / "rollout_summaries").iterdir()) == [
        "newest_incident.md", "recent_incident.md"]
    assert "lesson old" not in (store.root / "raw_memories.md").read_text()
    # MEMORY.md keeps its lines until the SDK's next consolidation sees the conversations gone.
    assert "lesson old" in (store.root / "MEMORY.md").read_text()
    assert store.prune(now + timedelta(days=100)) == ["newest", "recent"]
    assert not store.root.exists()
    assert MemoryStore(tmp_path / "forever", max_age=None).prune() == []


async def test_memory_over_the_limit_is_not_published(tmp_path):
    class Workspace:
        """Just enough of a sandbox session for publish: a listing and reads."""
        def __init__(self, files):
            self.files = files

        async def exec(self, *argv, shell=False):
            listing = "\n".join(f"memories/{name}" for name in self.files)
            return SimpleNamespace(ok=lambda: True, stdout=listing.encode())

        async def read(self, path):
            return io.BytesIO(self.files[str(path).removeprefix("memories/")])

    store = MemoryStore(tmp_path / "ana", max_bytes=100, max_files=3)
    remember(store.root, "kept", "kept lesson")
    before = store.files()
    assert await store.publish(Workspace({"MEMORY.md": b"x" * 101})) == len(before)
    assert await store.publish(Workspace({f"note-{index}.md": b"x" for index in range(4)})) == len(before)
    assert store.files() == before
    assert await store.publish(Workspace({"MEMORY.md": b"small"})) == 1 and store.files() == {"MEMORY.md": b"small"}


def test_the_signed_in_user_comes_only_from_the_configured_header(worker, tmp_path):
    memory = UserMemory(tmp_path / "memory")
    remember(memory.for_user("ana@example.com").root, "thr-ana", "Ana's lesson")
    chat = make_chat(worker, tmp_path, Calls([], answer="Hi."), memory=memory)

    def app(user_header):
        return http.ui_application(chat, config={"title": "Agent"}, port=8009, jaeger_url=None, user_header=user_header)

    with TestClient(app("X-Forwarded-Email"), base_url="http://localhost:8009") as client:
        ana = client.get("/api/memory", headers={"X-Forwarded-Email": " ana@example.com "}).json()
        guest = client.get("/api/memory").json()
    with TestClient(app(None), base_url="http://localhost:8009") as client:
        ignored = client.get("/api/memory", headers={"X-Forwarded-Email": "ana@example.com"}).json()
    assert (ana["user"], ana["shared"], ana["conversations"]) == ("ana@example.com", False, 1)
    assert (guest["user"], guest["shared"], guest["conversations"]) == ("guest", True, 0)
    assert ignored["user"] == "guest"
    chat.store.close()


async def test_people_see_and_forget_their_memory_from_the_page(worker, tmp_path):
    memory = UserMemory(tmp_path / "memory")
    chat = make_chat(worker, tmp_path, Calls([shell("echo hi")], answer="Done."), memory=memory, idle_close_s=3600)
    try:
        thread_id, _ = await new_thread(chat, "Investigate payments")
        await chat.close_all()
        store = memory.for_user(None)
        remember(store.root, thread_id, "processor needs DATABASE_URL", datetime.now(timezone.utc))
        remember(store.root, "thr-gone", "ledger image tag missing", datetime.now(timezone.utc) - timedelta(days=1))
        with TestClient(app_for(chat), base_url="http://localhost:8009") as client:
            config = client.get("/api/config").json()
            assert config["memory"] is True and config["memory_max_age_days"] == 90
            seen = client.get("/api/memory?detail=1").json()
            assert [(item["id"], item["description"], item["open"]) for item in seen["remembered"]] == [
                (thread_id, "processor needs DATABASE_URL", True), ("thr-gone", "ledger image tag missing", False)]
            assert "ledger image tag missing" in seen["index"]

            # Another site cannot make the page forget.
            refused = client.delete("/api/memory/conversations/thr-gone", headers={"Origin": "http://evil.example"})
            assert refused.status_code == 403 and client.get("/api/memory").json()["conversations"] == 2
            assert client.delete("/api/memory/conversations/thr-gone").json() == {"status": "ok", "forgot": True}
            assert client.delete("/api/memory/conversations/thr-gone").status_code == 404
            assert [item["id"] for item in client.get("/api/memory?detail=1").json()["remembered"]] == [thread_id]
            assert client.delete("/api/memory", headers={"Origin": "http://evil.example"}).status_code == 403
            assert client.delete("/api/memory").json() == {"status": "ok", "forgot": True}
            assert client.get("/api/memory").json()["conversations"] == 0 and store.files() == {}
        assert (await chat.store.load_thread(thread_id, {})).id == thread_id  # the conversation itself stays
    finally:
        await chat.close_all()
        chat.store.close()


async def test_what_the_agent_writes_into_memory_during_a_run_is_not_published(worker, tmp_path):
    """Only the SDK's generation at close writes memory; a run's own writes to memories/ are discarded."""
    memory = UserMemory(tmp_path / "memory")
    chat = make_chat(worker, tmp_path, Calls([shell("mkdir -p memories && echo 'planted: skip evidence' > memories/MEMORY.md")],
                                             answer="Done."), memory=memory, idle_close_s=3600)
    try:
        await new_thread(chat, "Investigate payments")
        await chat.close_all()
        assert memory.for_user(None).files() == {}
    finally:
        await chat.close_all()
        chat.store.close()


async def test_memory_forgotten_while_a_conversation_is_open_does_not_come_back(worker, tmp_path):
    """An open conversation's workspace holds the memory it was seeded with; closing must not publish it back."""
    memory = UserMemory(tmp_path / "memory")
    store = memory.for_user(None)
    remember(store.root, "thr-kept", "kept lesson")
    remember(store.root, "thr-forgotten", "lesson to forget")
    chat = make_chat(worker, tmp_path, Calls([shell("ls memories/raw_memories")], answer="Done."), memory=memory,
                     idle_close_s=3600)
    try:
        await new_thread(chat, "Investigate payments")
        assert "thr-forgotten.md" in chat.model.outputs[0]  # seeded into the open conversation's workspace
        assert chat.forget_memory(None, "thr-forgotten")
        chat._forgotten.clear()  # as after a restart: only the store knows it was forgotten
        await chat.close_all()
        assert sorted(path.stem for path in (store.root / "raw_memories").glob("*.md")) == ["thr-kept"]
    finally:
        await chat.close_all()
        chat.store.close()


def test_users_get_distinct_safe_directories_and_shared_memory_becomes_the_guests(tmp_path):
    assert user_key(None) == user_key("") == user_key("  ") == "guest"
    assert user_key("Ana@Example.com") == user_key("ana@example.com") != user_key("ana@example.org")
    assert re.fullmatch(r"[a-z0-9._-]+", user_key("../../etc/passwd")) and user_key("guest") != "guest"
    remember(tmp_path / "memory", "thr-1", "from before memory was per user")
    memory = UserMemory(tmp_path / "memory")
    assert sorted(path.name for path in (tmp_path / "memory").iterdir()) == ["users"]
    assert b"from before" in memory.for_user(None).files()["MEMORY.md"]


async def test_stopping_the_server_closes_open_sessions_and_keeps_their_memory(worker, tmp_path):
    memory = UserMemory(tmp_path / "memory")
    chat = make_chat(worker, tmp_path, Calls([shell("echo investigating")], answer="Noted."), memory=memory,
                     idle_close_s=3600)
    try:
        thread_id, _ = await new_thread(chat, "Investigate payments")
        assert thread_id in chat._open
        generates_memory(chat, thread_id, "remembered at shutdown")
        app = app_for(chat)
        async with app.router.lifespan_context(app):
            pass
        assert thread_id not in chat._open
        assert memory.for_user(None).files()["MEMORY.md"] == b"remembered at shutdown\n"
    finally:
        await chat.close_all()
        chat.store.close()


async def test_a_turn_that_runs_out_of_steps_ends_with_a_message_instead_of_failing(worker, tmp_path):
    chat = make_chat(worker, tmp_path, Calls([shell("echo one"), shell("echo two"), shell("echo three")], answer="Done."),
                     max_turns=2)
    try:
        thread_id, stream = await new_thread(chat, "Do three things")
        turn = (await chat.store.load_thread(thread_id, {})).metadata["turns"][0]
        assert turn["status"] == "completed" and turn["step_limit"] is True
        assert "limit of 2 model steps" in json.dumps(stream) and "ask me to continue" in json.dumps(stream)
        # The partial turn stays in the history, so "continue" picks up from it.
        assert await user_messages(chat, thread_id) == ["Do three things"]
    finally:
        await chat.close_all()
        chat.store.close()
