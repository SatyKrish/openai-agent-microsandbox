# Copyright 2026 openai-agent-microsandbox contributors
# SPDX-License-Identifier: Apache-2.0
"""The harness and its shared UI page against the worker's real gRPC service (see the root conftest)."""

import asyncio
import io
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from agents import Runner
from agents.sandbox import Manifest, SandboxAgent
from agents.sandbox.capabilities import Shell
from agents.sandbox.entries import Dir
from starlette.testclient import TestClient

from openai_harness import http
from openai_harness.engine import Harness, preferred_file, running_elsewhere
from openai_harness.memory import MemoryStore, UserMemory, user_key
from openai_harness.spec import AgentSpec
from openai_harness.store import SHARED, NotFound, SQLiteStore, Thread, user_name
from openai_harness.testing import Calls, ask, entries, shell, titles

SPEC = AgentSpec(
    name="test_agent",
    build_agent=lambda manifest, model: SandboxAgent(name="Test", model=model, instructions="Answer.",
                                                     default_manifest=manifest, capabilities=[Shell()]),
    start=lambda conversation, root: Manifest(root=root, entries={"output": Dir(), "work": Dir()}),
    check=lambda conversation, turn, files: {"status": "checked", "files": sorted(files)},
)
STARTING = {"runbooks/notes.md": b"# Notes\n"}


def make_harness(worker, tmp_path, model, **options):
    store = SQLiteStore(tmp_path / "threads.sqlite3")
    return Harness(SPEC, store, worker.client(), model=model, output_dir=tmp_path / "threads", model_label="scripted",
                   **options)


def app_for(harness, worker=None, health=None, **config):
    """The harness's API alone, as a UI would mount it beside its own page."""
    routes = http.api_routes(harness, config={"model": "scripted", **config}, port=8009, jaeger_url=None,
                             starting_files=STARTING, worker=worker, health=health)
    return http.application(routes, on_shutdown=harness.close_all)


async def new_thread(harness, text="First question", user=None):
    thread_id, stream = await ask(harness, text, user=user)
    assert not [event for event in stream if event["type"] == "error"], stream
    return thread_id, stream


async def user_messages(harness, thread_id):
    history = harness.history(thread_id)
    try:
        return [item["content"] for item in await history.get_items() if item.get("role") == "user"]
    finally:
        history.close()


async def test_a_conversation_keeps_one_workspace_and_deleting_it_removes_the_workspace(worker, tmp_path):
    model = Calls([shell("echo $((6*7)) > output/answer.txt && cat output/answer.txt")], answer="42.")
    harness = make_harness(worker, tmp_path, model)
    try:
        thread_id, stream = await new_thread(harness, "What is 6 times 7?")
        thread = await harness.store.load_thread(thread_id, {})
        meta, turn = thread.metadata, thread.metadata["turns"][0]
        workspace = meta["workspace"].split("/", 1)[1]
        assert meta["workspace"].startswith("test-worker/s-") and turn["lifecycle"] == "created"
        assert turn["check"] == {"status": "checked", "files": ["output/answer.txt"]}
        assert (tmp_path / "threads" / thread_id / "turn-1/output/answer.txt").read_text() == "42\n"
        assert [tool["where"] for tool in turn["tools"]] == ["sandbox"]
        card = json.dumps(entries(stream, "card"))
        assert "Turn 1 \\u00b7" in card and "1 step" in card  # the card says the turn and its steps, not the workspace

        _, stream = await ask(harness, "Still there?", conversation=thread_id)
        assert not [event for event in stream if event["type"] == "error"]
        turns = (await harness.store.load_thread(thread_id, {})).metadata["turns"]
        assert turns[1]["lifecycle"] == "continued"  # the session stayed open between turns
        assert (worker.data_dir / "active" / workspace / "output/answer.txt").is_file()

        await harness.store.delete_thread(thread_id, {})
        assert not (worker.data_dir / "active" / workspace).exists()
        assert not (tmp_path / "threads" / thread_id).exists()
        assert (worker.data_dir / "history" / workspace / "journal.jsonl").is_file()
        assert await user_messages(harness, thread_id) == []
    finally:
        harness.store.close()


async def test_messages_sent_at_once_are_answered_together_in_one_turn(worker, tmp_path):
    harness = make_harness(worker, tmp_path, Calls(delay=0.2))
    try:
        thread_id, _ = await new_thread(harness)
        asked = await asyncio.gather(*(ask(harness, text, conversation=thread_id)
                                       for text in ("Second question", "Third question")))
        streams = [stream for _, stream in asked]
        assert not [event for stream in streams for event in stream if event["type"] == "error"]
        # Both see the one turn that answered both messages.
        assert all(entries(stream, "card") for stream in streams)
        thread = await harness.store.load_thread(thread_id, {})
        turns = thread.metadata["turns"]
        assert [turn["number"] for turn in turns] == [1, 2] and all(turn["status"] == "completed" for turn in turns)
        transcript = await harness.store.load_entries(thread_id, {})
        users = [entry for entry in transcript if entry["kind"] == "user"]
        assert [entry["text"] for entry in users] == ["First question", "Second question", "Third question"]
        assert [entry["turn"] for entry in users] == [1, 2, 2] and turns[1]["messages"] == [users[1]["id"], users[2]["id"]]
        assert await user_messages(harness, thread_id) == ["First question", "Second question\n\nThird question"]
    finally:
        await harness.close_all()
        harness.store.close()


async def test_a_failed_run_leaves_no_partial_turn_in_the_history(worker, tmp_path, monkeypatch):
    harness = make_harness(worker, tmp_path, Calls())
    try:
        thread_id, _ = await new_thread(harness)
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
        _, stream = await ask(harness, "This turn fails", conversation=thread_id)
        assert [event for event in stream if event["type"] == "error"]
        assert await user_messages(harness, thread_id) == ["First question"]
    finally:
        harness.store.close()


async def test_an_unreachable_worker_fails_the_turn_with_a_clear_message(tmp_path):
    from sandbox_worker import WorkerSandboxClient

    client = WorkerSandboxClient("127.0.0.1:9", worker="gone-worker")
    harness = Harness(SPEC, SQLiteStore(tmp_path / "threads.sqlite3"), client, model=Calls(),
                      output_dir=tmp_path / "threads")
    try:
        _, stream = await ask(harness, "Hello")
        errors = [event for event in stream if event["type"] == "error"]
        assert errors and "sandbox worker gone-worker is unavailable" in errors[0]["message"]
    finally:
        harness.store.close()


def test_the_api_tells_a_ui_what_the_agent_has_and_shows_its_worker(worker, tmp_path):
    harness = make_harness(worker, tmp_path, Calls())

    async def broken():
        raise RuntimeError("worker restarting")

    with TestClient(app_for(harness, worker=harness.client.info, follow_ups=[{"label": "Next", "prompt": "Go on."}]),
                    base_url="http://localhost:8009") as client:
        # The harness serves no page of its own: a UI serves its page beside these routes.
        assert client.get("/").status_code == 404
        config = client.get("/api/config").json()
        assert config["name"] == "test_agent" and config["worker"] is True
        assert config["follow_ups"] == [{"label": "Next", "prompt": "Go on."}] and config["model"] == "scripted"
        assert config["starting_files"] == [{"path": "runbooks/notes.md", "bytes": len(STARTING["runbooks/notes.md"])}]
        assert client.get("/api/starting-files/runbooks/notes.md").content == STARTING["runbooks/notes.md"]
        for path in ("runbooks/other.md", "runbooks/../threads.sqlite3"):
            assert client.get(f"/api/starting-files/{path}").status_code == 404
        info = client.get("/api/worker").json()
        assert info["status"] == "ok" and info["domain"] == "payments" and "through the worker's proxy" in info["egress"]
        # Only loopback hosts may reach the server, and only same-origin requests start a conversation.
        assert client.get("/api/config", headers={"host": "evil.example"}).status_code == 400
        assert client.post("/api/conversations", json={"text": "Hi"},
                           headers={"origin": "http://evil.example"}).status_code == 403
    with TestClient(app_for(harness, worker=broken), base_url="http://localhost:8009") as client:
        assert client.get("/api/worker").status_code == 503
    with TestClient(app_for(harness), base_url="http://localhost:8009") as client:
        assert client.get("/api/worker").status_code == 404 and client.get("/api/config").json()["worker"] is False
    harness.store.close()


def test_a_turn_running_in_another_process_blocks_a_new_one_until_it_is_stale():
    now = datetime.now(timezone.utc)
    running = {"turns": [{"number": 1, "status": "running", "started_at": now.isoformat()}]}
    assert running_elsewhere(running, set(), "thr_1")
    assert not running_elsewhere(running, {"thr_1"}, "thr_1")
    assert not running_elsewhere({"turns": [{"status": "completed", "started_at": now.isoformat()}]}, set(), "thr_1")
    stale = (now - timedelta(minutes=20)).isoformat()
    assert not running_elsewhere({"turns": [{"status": "running", "started_at": stale}]}, set(), "thr_1")


async def test_steps_say_what_ran_and_where_by_icon(worker, tmp_path):
    harness = make_harness(worker, tmp_path, Calls([shell("echo hi > output/a.txt")], answer="Done."))
    _, stream = await new_thread(harness, "Write a file")
    steps = [step for entry in entries(stream, "steps") for step in entry["steps"]]
    done = [step for step in steps if step["title"].startswith("echo hi")]
    # A sandbox command that exited 0 is just its command; the icon says where it ran.
    assert done[-1]["title"] == "echo hi > output/a.txt" and done[-1]["icon"] == "cube"
    thread = (await harness.store.load_threads({}))[0]
    # Each turn records what it used: two model requests here, the second carrying the first's output.
    usage = thread.metadata["turns"][0]["usage"]
    assert usage["requests"] == 2 and usage["total_tokens"] > 0 and usage["max_input_tokens"] > 0
    assert "tokens" in json.dumps(stream)
    assert thread.metadata["turns"][0]["tools"][0]["summary"] == "echo hi > output/a.txt"
    assert any(step["title"].startswith("Created the workspace") for step in steps)
    effects = [event for event in stream if event["type"] == "effect"]
    assert effects[-1]["data"]["path"] == "output/a.txt"
    harness.store.close()


async def test_parallel_steps_each_keep_their_own_exit_status(worker, tmp_path):
    harness = make_harness(worker, tmp_path, Calls([[shell("exit 3"), shell("echo ok")]], answer="Done."))
    thread_id, stream = await new_thread(harness, "Run both")
    turn = (await harness.store.load_thread(thread_id, {})).metadata["turns"][0]
    assert [(tool["summary"], tool["status"]) for tool in turn["tools"]] == [("exit 3", "exit 3"), ("echo ok", "exit 0")]
    shown = titles(stream)
    assert "exit 3 · exit 3" in shown and "echo ok" in shown
    harness.store.close()


def test_the_panel_opens_a_checked_output_before_the_agents_report():
    turn = {"files": [{"path": "output/report.md", "changed": True}, {"path": "output/data.json", "changed": True},
                      {"path": "work/x.py", "changed": True}],
            "file_status": {"output/data.json": {"state": "checked"}, "output/report.md": {"state": "unchecked"}}}
    assert preferred_file(turn, "output/report.md") == "output/data.json"
    turn["file_status"] = {}
    assert preferred_file(turn, "output/report.md") == "output/report.md"
    assert preferred_file({"files": [{"path": "work/x.py", "changed": True}]}) is None


def test_the_page_serves_an_agents_health_summary(worker, tmp_path):
    harness = make_harness(worker, tmp_path, Calls())

    async def health():
        return {"generated_at": "2026-11-01T06:00:00Z", "namespaces": [{"namespace": "payments", "error": "",
                "workloads": [{"name": "payments-processor", "state": "failing"}]}]}

    async def broken():
        raise RuntimeError("worker restarting")

    with TestClient(app_for(harness, health=health), base_url="http://localhost:8009") as client:
        assert client.get("/api/config").json()["health"] is True
        reply = client.get("/api/health").json()
        assert reply["status"] == "ok" and reply["namespaces"][0]["workloads"][0]["state"] == "failing"
    with TestClient(app_for(harness, health=broken), base_url="http://localhost:8009") as client:
        assert client.get("/api/health").status_code == 503
    with TestClient(app_for(harness), base_url="http://localhost:8009") as client:
        assert client.get("/api/health").status_code == 404 and client.get("/api/config").json()["health"] is False
    harness.store.close()


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


def generates_memory(harness, thread_id: str, text: str) -> None:
    """Make closing the conversation's open session write memory, as the SDK's generation does in a pre-stop hook."""
    session = harness._open[thread_id].session

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
    harness = make_harness(worker, tmp_path, Calls([shell("echo investigating")], answer="Noted."), memory=memory,
                     idle_close_s=0.4)
    try:
        first, _ = await new_thread(harness, "Investigate payments")
        generates_memory(harness, first, "payments-processor needs DATABASE_URL")
        assert first in harness._open and store.files() == {}  # open, and nothing published while it is
        await asyncio.sleep(0.8)
        assert first not in harness._open  # closed when idle, and its memory published
        assert store.files()["MEMORY.md"] == b"payments-processor needs DATABASE_URL\n"
        summary = memory.summary(None)
        assert summary["text"].startswith("Payments: payments-processor") and summary["conversations"] == 1
        assert summary["user"] == "guest" and summary["shared"] is True

        harness.model = Calls([shell("cat memories/MEMORY.md")], answer="I remember.")
        second, stream = await new_thread(harness, "Anything known about payments?")
        assert "payments-processor needs DATABASE_URL" in harness.model.outputs[0]
        assert "Seeded with the agent's memory from earlier conversations (4 files)" in json.dumps(stream)

        # A deleted conversation is not remembered: deleting does not run the hooks where the SDK generates memory.
        generates_memory(harness, second, "forget me")
        await harness.store.delete_thread(second, {})
        assert second not in harness._open
        assert store.files()["MEMORY.md"] == b"payments-processor needs DATABASE_URL\n"
    finally:
        await harness.close_all()
        harness.store.close()


async def test_each_signed_in_user_has_their_own_memory_and_guests_share_one(worker, tmp_path):
    memory = UserMemory(tmp_path / "memory")
    harness = make_harness(worker, tmp_path, Calls([shell("echo investigating")], answer="Noted."), memory=memory,
                     idle_close_s=3600)
    try:
        ana, _ = await new_thread(harness, "Investigate payments", user="ana@example.com")
        assert (await harness.store.load_thread(ana, {})).metadata["owner"] == "ana@example.com"
        generates_memory(harness, ana, "Ana prefers kubectl tables")
        await harness.close_all()
        assert b"Ana prefers" in memory.for_user("ana@example.com").files()["MEMORY.md"]
        assert memory.for_user(None).files() == {} and memory.for_user("bo@example.com").files() == {}
        assert memory.summary("ana@example.com")["shared"] is False

        # Another user, and the guest, start without Ana's memory.
        for user in ("bo@example.com", None):
            harness.model = Calls([shell("cat memories/MEMORY.md || echo none")], answer="Checked.")
            _, stream = await new_thread(harness, "Anything known?", user=user)
            assert "Ana prefers" not in harness.model.outputs[0] and "Seeded" not in json.dumps(stream)
            await harness.close_all()
        # Ana's next conversation starts with hers.
        harness.model = Calls([shell("cat memories/MEMORY.md")], answer="I remember.")
        await new_thread(harness, "Anything known?", user="ana@example.com")
        assert "Ana prefers kubectl tables" in harness.model.outputs[0]
    finally:
        await harness.close_all()
        harness.store.close()


async def test_a_shared_conversation_is_remembered_by_whoever_opened_its_session(worker, tmp_path):
    """An issue belongs to the team; what it teaches goes to the person whose message opened the session."""
    memory = UserMemory(tmp_path / "memory")
    harness = make_harness(worker, tmp_path, Calls([shell("echo looking")], answer="Found it."), memory=memory,
                           idle_close_s=3600)
    try:
        issue = Thread.new(title="payments-ledger: ImagePullBackOff", metadata={"owner": SHARED, "issue": {"state": "open"}})
        await harness.store.save_thread(issue, {})
        await ask(harness, "Why is it failing?", conversation=issue.id, user="bo@example.com")
        generates_memory(harness, issue.id, "ledger tags come from CI")
        # Ana continues in Bo's open session: it is still Bo's memory that the session adds to.
        await ask(harness, "And the fix?", conversation=issue.id, user="ana@example.com")
        await harness.close_all()
        assert b"ledger tags come from CI" in memory.for_user("bo@example.com").files()["MEMORY.md"]
        assert memory.for_user("ana@example.com").files() == {} and memory.for_user(SHARED).files() == {}
        # Deleting the issue forgets it from the memory of everyone who asked in it.
        remember(memory.for_user("bo@example.com").root, issue.id, "lesson from the issue")
        await harness.store.delete_thread(issue.id, {})
        assert f"raw_memories/{issue.id}.md" not in memory.for_user("bo@example.com").files()
    finally:
        await harness.close_all()
        harness.store.close()


async def test_a_deleted_conversation_is_forgotten_after_its_memory_was_published(worker, tmp_path):
    memory = UserMemory(tmp_path / "memory")
    harness = make_harness(worker, tmp_path, Calls([shell("echo hi")], answer="Done."), memory=memory, idle_close_s=3600)
    try:
        kept, _ = await new_thread(harness, "First", user="ana@example.com")
        gone, _ = await new_thread(harness, "Second", user="ana@example.com")
        await harness.close_all()
        store = memory.for_user("ana@example.com")
        remember(store.root, kept, "kept lesson")
        remember(store.root, gone, "lesson from the deleted conversation")
        await harness.store.delete_thread(gone, {})
        files = store.files()
        assert f"raw_memories/{kept}.md" in files and f"raw_memories/{gone}.md" not in files
        assert not any(name.startswith(f"rollout_summaries/{gone}") for name in files)
        assert b"deleted conversation" not in files["raw_memories.md"]  # what the agent may read is rebuilt
        assert memory.summary("ana@example.com")["conversations"] == 1
        await harness.store.delete_thread(kept, {})
        assert store.files() == {} and not store.root.exists()  # nothing left to remember
    finally:
        await harness.close_all()
        harness.store.close()


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


async def test_people_see_and_delete_only_their_own_conversations(worker, tmp_path):
    harness = make_harness(worker, tmp_path, Calls([shell("echo hi")], answer="Done."))
    try:
        ana, _ = await new_thread(harness, "Investigate payments", user="ana@example.com")
        bo, _ = await new_thread(harness, "Investigate payments too", user="bo@example.com")
        guest, _ = await new_thread(harness, "And as the guest")
        async def ids(user):
            return [thread.id for thread in await harness.store.load_threads({"user": user}, newest_first=False)]
        assert await ids("ana@example.com") == [ana] and await ids("bo@example.com") == [bo] and await ids(None) == [guest]

        # Someone else's conversation reads as not found, here and through the API, and cannot be deleted.
        with pytest.raises(NotFound):
            await harness.store.load_thread(ana, {"user": "bo@example.com"})
        with pytest.raises(NotFound):
            await ask(harness, "Hijack", conversation=ana, user="bo@example.com")
        with pytest.raises(NotFound):
            await harness.store.delete_thread(ana, {"user": "bo@example.com"})
        thread = await harness.store.load_thread(ana, {})
        assert thread.metadata["owner"] == "ana@example.com" and len(thread.metadata["turns"]) == 1
        assert thread.metadata["turns"][0]["requested_by"] == "ana@example.com"

        # The worker's journal names who asked for each command of a turn; the guest's are the guest's.
        async def requesters(thread_id):
            session = (await harness.store.load_thread(thread_id, {})).metadata["workspace"].split("/", 1)[1]
            journal = (worker.data_dir / "history" / session / "journal.jsonl").read_text().splitlines()
            return {json.loads(line).get("requester") for line in journal if '"event":"exec"' in line}
        assert await requesters(ana) == {"ana@example.com"} and await requesters(guest) == {"guest"}

        api = http.application(http.api_routes(harness, config={}, port=8009, jaeger_url=None,
                                               user_header="X-Forwarded-Email"))
        with TestClient(api, base_url="http://localhost:8009") as client:
            assert client.get(f"/api/threads/{ana}", headers={"X-Forwarded-Email": "bo@example.com"}).status_code == 404
            assert client.get(f"/api/threads/{ana}", headers={"X-Forwarded-Email": "ana@example.com"}).status_code == 200

        # An admin sees and deletes everyone's.
        harness.store.admins = frozenset({"lead@example.com"})
        assert set(await ids("lead@example.com")) == {ana, bo, guest}
        await harness.store.delete_thread(bo, {"user": "lead@example.com"})
        assert await ids("bo@example.com") == []
    finally:
        await harness.close_all()
        harness.store.close()


def test_the_harness_api_runs_conversations(worker, tmp_path):
    import time

    harness = make_harness(worker, tmp_path, Calls([shell("mkdir -p output && echo 42 > output/answer.txt")], answer="It is 42."))
    api = http.application(http.api_routes(harness, config={}, port=8009, jaeger_url=None, user_header="X-Forwarded-Email"),
                           on_shutdown=harness.close_all)
    ana, bo = {"X-Forwarded-Email": "ana@example.com"}, {"X-Forwarded-Email": "bo@example.com"}

    def settled(client, thread_id, turns):
        for _ in range(100):
            body = client.get(f"/api/conversations/{thread_id}", headers=ana).json()
            if body["turns"] == turns and body["state"] != "running" and body["entries"][-1]["kind"] == "card":
                return body
            time.sleep(0.1)
        raise AssertionError(body)

    with TestClient(api, base_url="http://localhost:8009") as client:
        started = client.post("/api/conversations", json={"text": "What is 6 times 7?"}, headers=ana)
        assert started.status_code == 202
        thread_id = started.json()["id"]
        first = settled(client, thread_id, 1)
        assert [entry["kind"] for entry in first["entries"]] == ["user", "steps", "assistant", "card"]
        assert first["entries"][0]["id"] == started.json()["message"]
        assert first["entries"][0]["requested_by"] == "ana@example.com" and first["entries"][0]["turn"] == 1
        assert first["entries"][2]["text"] == "It is 42." and first["title"] == "What is 6 times 7?"
        listed = client.get("/api/conversations", headers=ana).json()["conversations"]
        assert [item["id"] for item in listed] == [thread_id]
        # A browser reads a time without a zone as its own local time.
        assert datetime.fromisoformat(listed[0]["created_at"]).utcoffset() == timedelta(0)
        assert client.get(f"/api/conversations/{thread_id}", headers=bo).status_code == 404
        assert client.post(f"/api/conversations/{thread_id}/messages", json={"text": "Hijack"}, headers=bo).status_code == 404
        refused = client.post(f"/api/conversations/{thread_id}/messages", json={"text": "x"},
                              headers={**ana, "Origin": "http://evil.example"})
        assert refused.status_code == 403

        # Follow the conversation while a second message is answered: the turn's events arrive as they happen.
        seen = []
        with client.stream("GET", f"/api/conversations/{thread_id}/events", headers=ana) as events:
            sent = client.post(f"/api/conversations/{thread_id}/messages", json={"text": "And 6 times 8?"}, headers=ana)
            assert sent.status_code == 202 and sent.json()["message"].startswith("msg_")
            for line in events.iter_lines():
                if line.startswith("data: "):
                    seen.append(json.loads(line[6:]))
                    if seen[-1]["type"] == "turn" and seen[-1]["status"] == "shown":
                        break
        kinds = [(event["type"], event.get("status") or (event.get("entry") or {}).get("kind")) for event in seen]
        assert kinds[0] == ("entry", "user") and ("turn", "running") in kinds and ("entry", "card") in kinds
        assert kinds.index(("turn", "running")) < kinds.index(("entry", "steps")) < kinds.index(("entry", "card"))
        second = settled(client, thread_id, 2)
        assert [entry["turn"] for entry in second["entries"]] == [1, 1, 1, 1, 2, 2, 2, 2]
        later = client.get(f"/api/conversations/{thread_id}?after={first['entries'][-1]['seq']}", headers=ana).json()
        assert [entry["kind"] for entry in later["entries"]] == ["user", "steps", "assistant", "card"]

        # A turn can be stopped from the API; the conversation says so.
        harness.model = Calls([shell("sleep 5")], answer="Too late.")
        client.post(f"/api/conversations/{thread_id}/messages", json={"text": "Take your time"}, headers=ana)
        for _ in range(50):
            if client.get(f"/api/conversations/{thread_id}", headers=ana).json()["state"] == "running":
                break
            time.sleep(0.1)
        assert client.post(f"/api/conversations/{thread_id}/stop", headers=ana).json() == {"stopped": True}
        for _ in range(50):
            turns = asyncio.run(harness.store.load_thread(thread_id, {})).metadata["turns"]
            if turns[-1]["status"] != "running":
                break
            time.sleep(0.1)
        assert turns[-1]["status"] == "stopped"

        # When the server stops, the streams pages keep open end (the page reconnects), so the stop need not wait.
        with client.stream("GET", f"/api/conversations/{thread_id}/events", headers=ana) as events:
            client.portal.call(api.state.stopping.set)
            assert list(events.iter_lines()) == [": following", ""]
        api.state.stopping.clear()

        assert client.delete(f"/api/conversations/{thread_id}", headers=bo).status_code == 404
        assert client.delete(f"/api/conversations/{thread_id}", headers=ana).json() == {"deleted": True}
        assert client.get("/api/conversations", headers=ana).json()["conversations"] == []
    harness.store.close()


def test_the_signed_in_user_comes_only_from_the_configured_header(worker, tmp_path):
    memory = UserMemory(tmp_path / "memory")
    remember(memory.for_user("ana@example.com").root, "thr-ana", "Ana's lesson")
    harness = make_harness(worker, tmp_path, Calls([], answer="Hi."), memory=memory)

    def app(user_header):
        return http.application(http.api_routes(harness, config={}, port=8009, jaeger_url=None, user_header=user_header))

    with TestClient(app("X-Forwarded-Email"), base_url="http://localhost:8009") as client:
        ana = client.get("/api/memory", headers={"X-Forwarded-Email": " ana@example.com "}).json()
        guest = client.get("/api/memory").json()
    with TestClient(app(None), base_url="http://localhost:8009") as client:
        ignored = client.get("/api/memory", headers={"X-Forwarded-Email": "ana@example.com"}).json()
    assert (ana["user"], ana["shared"], ana["conversations"]) == ("ana@example.com", False, 1)
    assert (guest["user"], guest["shared"], guest["conversations"]) == ("guest", True, 0)
    assert ignored["user"] == "guest"
    harness.store.close()


def test_a_signed_in_name_is_one_user_whatever_its_case(worker, tmp_path):
    """Conversations and memory key a user alike, so a name's case never reaches another user's memory."""
    memory = UserMemory(tmp_path / "memory")
    remember(memory.for_user("ana@example.com").root, "thr-ana", "Ana's lesson")
    store = SQLiteStore(tmp_path / "threads.sqlite3", admins={" Lead@Example.COM "})
    harness = Harness(SPEC, store, worker.client(), model=Calls([], answer="Hi."), output_dir=tmp_path / "threads",
                      memory=memory)
    ana = Thread.new(title="Ana's", metadata={"owner": "ana@example.com"})
    asyncio.run(store.save_thread(ana, {}))
    api = http.application(http.api_routes(harness, config={}, port=8009, jaeger_url=None, user_header="X-Forwarded-Email"))

    def signed_in(name):
        return {"X-Forwarded-Email": name}

    with TestClient(api, base_url="http://localhost:8009") as client:
        for name in ("ana@example.com", "ANA@EXAMPLE.COM", " Ana@Example.com "):
            listed = client.get("/api/conversations", headers=signed_in(name)).json()["conversations"]
            seen = client.get("/api/memory", headers=signed_in(name)).json()
            assert [item["id"] for item in listed] == [ana.id] and (seen["user"], seen["conversations"]) == ("ana@example.com", 1)
        assert client.get(f"/api/conversations/{ana.id}", headers=signed_in("bo@example.com")).status_code == 404
        assert store.admins == {"lead@example.com"}
        assert client.get(f"/api/conversations/{ana.id}", headers=signed_in("LEAD@example.com")).status_code == 200

        # SHARED owns the conversations everyone sees, so no one signs in as it or any other @ name.
        for method, path in (("POST", "/api/conversations"), ("GET", "/api/conversations"), ("GET", "/api/memory"),
                             ("DELETE", "/api/memory"), ("GET", f"/api/conversations/{ana.id}/events")):
            refused = client.request(method, path, headers=signed_in(SHARED.upper()),
                                     json={"text": "For everyone"} if method == "POST" else None)
            assert refused.status_code == 403 and "reserved" in refused.json()["error"]
    assert [thread.id for thread in asyncio.run(store.load_threads({}))] == [ana.id]
    assert memory.for_user("ana@example.com").files()
    store.close()


async def test_a_follower_that_goes_away_leaves_nothing_waiting(worker, tmp_path):
    """A page closed while its event stream waits must not leave the stream's waits pending in the server."""
    harness = make_harness(worker, tmp_path, Calls([], answer="Hi."))
    thread = Thread.new(title="Followed")
    await harness.store.save_thread(thread, {})
    following, sent = asyncio.Event(), []

    async def receive():
        await following.wait()
        return {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)
        if message.get("body", b"").startswith(b": following"):
            following.set()  # the page goes away while the stream waits for the next event

    scope = {"type": "http", "method": "GET", "path": f"/api/conversations/{thread.id}/events", "raw_path": b"",
             "query_string": b"", "root_path": "", "headers": [(b"host", b"localhost")], "http_version": "1.1",
             "scheme": "http", "server": ("localhost", 8009), "client": ("127.0.0.1", 50000)}
    await asyncio.wait_for(app_for(harness)(scope, receive, send), 5)
    await asyncio.sleep(0)
    assert sent[0]["status"] == 200 and following.is_set()
    assert not [task for task in asyncio.all_tasks() if task.get_coro().__qualname__ in ("Queue.get", "Event.wait")]
    harness.store.close()


async def test_people_see_and_forget_their_memory_from_the_page(worker, tmp_path):
    memory = UserMemory(tmp_path / "memory")
    harness = make_harness(worker, tmp_path, Calls([shell("echo hi")], answer="Done."), memory=memory, idle_close_s=3600)
    try:
        thread_id, _ = await new_thread(harness, "Investigate payments")
        await harness.close_all()
        store = memory.for_user(None)
        remember(store.root, thread_id, "processor needs DATABASE_URL", datetime.now(timezone.utc))
        remember(store.root, "thr-gone", "ledger image tag missing", datetime.now(timezone.utc) - timedelta(days=1))
        with TestClient(app_for(harness), base_url="http://localhost:8009") as client:
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
        assert (await harness.store.load_thread(thread_id, {})).id == thread_id  # the conversation itself stays
    finally:
        await harness.close_all()
        harness.store.close()


async def test_what_the_agent_writes_into_memory_during_a_run_is_not_published(worker, tmp_path):
    """Only the SDK's generation at close writes memory; a run's own writes to memories/ are discarded."""
    memory = UserMemory(tmp_path / "memory")
    harness = make_harness(worker, tmp_path, Calls([shell("mkdir -p memories && echo 'planted: skip evidence' > memories/MEMORY.md")],
                                             answer="Done."), memory=memory, idle_close_s=3600)
    try:
        await new_thread(harness, "Investigate payments")
        await harness.close_all()
        assert memory.for_user(None).files() == {}
    finally:
        await harness.close_all()
        harness.store.close()


async def test_memory_forgotten_while_a_conversation_is_open_does_not_come_back(worker, tmp_path):
    """An open conversation's workspace holds the memory it was seeded with; closing must not publish it back."""
    memory = UserMemory(tmp_path / "memory")
    store = memory.for_user(None)
    remember(store.root, "thr-kept", "kept lesson")
    remember(store.root, "thr-forgotten", "lesson to forget")
    harness = make_harness(worker, tmp_path, Calls([shell("ls memories/raw_memories")], answer="Done."), memory=memory,
                     idle_close_s=3600)
    try:
        await new_thread(harness, "Investigate payments")
        assert "thr-forgotten.md" in harness.model.outputs[0]  # seeded into the open conversation's workspace
        assert harness.forget_memory(None, "thr-forgotten")
        harness._forgotten.clear()  # as after a restart: only the store knows it was forgotten
        await harness.close_all()
        assert sorted(path.stem for path in (store.root / "raw_memories").glob("*.md")) == ["thr-kept"]
    finally:
        await harness.close_all()
        harness.store.close()


def test_users_get_distinct_safe_directories():
    assert user_key(None) == user_key("") == user_key("  ") == "guest"
    assert user_key("Ana@Example.com") == user_key("ana@example.com") != user_key("ana@example.org")
    assert re.fullmatch(r"[a-z0-9._-]+", user_key("../../etc/passwd")) and user_key("guest") != "guest"
    assert user_name(" Ana@Example.com ") == "ana@example.com" and user_name("  ") is user_name(None) is None
    with pytest.raises(ValueError):
        user_name(SHARED)


async def test_stopping_the_server_closes_open_sessions_and_keeps_their_memory(worker, tmp_path):
    memory = UserMemory(tmp_path / "memory")
    harness = make_harness(worker, tmp_path, Calls([shell("echo investigating")], answer="Noted."), memory=memory,
                     idle_close_s=3600)
    try:
        thread_id, _ = await new_thread(harness, "Investigate payments")
        assert thread_id in harness._open
        generates_memory(harness, thread_id, "remembered at shutdown")
        app = app_for(harness)
        async with app.router.lifespan_context(app):
            pass
        assert thread_id not in harness._open
        assert memory.for_user(None).files()["MEMORY.md"] == b"remembered at shutdown\n"
    finally:
        await harness.close_all()
        harness.store.close()


async def test_a_turn_that_runs_out_of_steps_ends_with_a_message_instead_of_failing(worker, tmp_path):
    harness = make_harness(worker, tmp_path, Calls([shell("echo one"), shell("echo two"), shell("echo three")], answer="Done."),
                     max_turns=2)
    try:
        thread_id, stream = await new_thread(harness, "Do three things")
        turn = (await harness.store.load_thread(thread_id, {})).metadata["turns"][0]
        assert turn["status"] == "completed" and turn["step_limit"] is True
        assert "limit of 2 model steps" in json.dumps(stream) and "ask me to continue" in json.dumps(stream)
        # The partial turn stays in the history, so "continue" picks up from it.
        assert await user_messages(harness, thread_id) == ["Do three things"]
    finally:
        await harness.close_all()
        harness.store.close()
