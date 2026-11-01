# Copyright 2026 openai-agent-mxc contributors
# SPDX-License-Identifier: Apache-2.0
"""The SDK provider against the worker's real gRPC service (see the root conftest)."""

import io
from pathlib import Path

import grpc
import pytest
from agents import Runner
from agents.run import RunConfig
from agents.sandbox import Manifest, SandboxAgent, SandboxRunConfig
from agents.sandbox.capabilities import Filesystem, Shell
from agents.sandbox.entries import Dir, File
from agents.sandbox.errors import ExecTimeoutError

from agent_mxc import MXCSandboxClient, MXCSandboxOptions, WorkerError
from openai_harness.testing import Calls, shell


def manifest(client: MXCSandboxClient, workspace: str) -> Manifest:
    return Manifest(root=client.workspace_root(workspace), entries={
        "runbooks": Dir(children={"payments.md": File(content=b"Check DATABASE_URL first.\n")}),
        "output": Dir()})


async def test_a_session_runs_commands_and_moves_files_in_its_own_workspace(worker):
    client = worker.client()
    session = await client.create(manifest=manifest(client, "s-alpha"), options=MXCSandboxOptions(workspace_id="s-alpha"))
    async with session:
        assert session.state.manifest.root == f"{worker.workspace_base}/s-alpha"
        result = await session.exec("cat runbooks/payments.md && pwd")
        assert result.ok() and result.stdout.decode().splitlines() == [
            "Check DATABASE_URL first.", f"{worker.workspace_base}/s-alpha"]
        await session.write(Path("output/report.md"), io.BytesIO(b"# Findings\n"))
        assert (await session.read(Path("output/report.md"))).read() == b"# Findings\n"
        assert await session.read_bounded(Path("output/report.md"), max_bytes=3) == b"# F"
        failed = await session.exec("exit 3")
        assert failed.exit_code == 3
        with pytest.raises(FileNotFoundError):
            await session.read(Path("output/missing.md"))
        assert await session.running()

    # State round-trips; the workspace outlives the session object.
    state = client.deserialize_session_state(client.serialize_session_state(session.state))
    again = await client.resume(state)
    async with again:
        assert (await again.read(Path("output/report.md"))).read() == b"# Findings\n"
    await client.delete(again)
    assert not (worker.data_dir / "active/s-alpha").exists()
    assert (worker.data_dir / "history/s-alpha/journal.jsonl").is_file()  # the audit journal stays
    await client.aclose()


async def test_kubectl_reads_become_evidence_the_workspace_cannot_forge(worker):
    client = worker.client()
    session = await client.create(manifest=manifest(client, "s-beta"), options=MXCSandboxOptions(workspace_id="s-beta"))
    async with session:
        read = await session.exec("kubectl logs deploy/payments-processor -n payments --previous")
        assert "Missing required env var DATABASE_URL" in read.stdout.decode()
        assert "saved as evidence/001-kubectl-logs-deploy-payments-processor-n-payments-previous.txt" in read.stderr.decode()
        await session.exec("echo forged > evidence/001-kubectl-logs-deploy-payments-processor-n-payments-previous.txt")
        entries = await session._inner.evidence()
        assert [entry["command"] for entry in entries] == [
            "kubectl logs deploy/payments-processor -n payments --previous"]
        trusted = await session._inner.read_evidence(entries[0]["seq"])
        assert b"Missing required env var DATABASE_URL" in trusted
        assert await session._inner.evidence(after_seq=1) == []
    await client.delete(session, purge_history=True)
    assert not (worker.data_dir / "history/s-beta").exists()


async def test_paths_cannot_leave_the_workspace_and_sessions_belong_to_one_worker(worker):
    client = worker.client()
    session = await client.create(manifest=manifest(client, "s-gamma"), options=MXCSandboxOptions(workspace_id="s-gamma"))
    async with session:
        await session.exec(f"ln -s {worker.data_dir}/history escape")
        with pytest.raises(ValueError, match="outside the workspace"):
            await session._inner.read(Path("escape/s-gamma/journal.jsonl"))
        with pytest.raises(WorkerError) as refused:
            await client.transport.read_file("s-gamma", "/etc/passwd")
        assert refused.value.code == grpc.StatusCode.INVALID_ARGUMENT
    with pytest.raises(ValueError, match="manifest root"):
        await client.create(manifest=Manifest(root="/workspace"), options=MXCSandboxOptions(workspace_id="s-delta"))
    other = worker.client()
    other.worker = "another-worker"
    with pytest.raises(ValueError, match="another worker"):
        other.deserialize_session_state(client.serialize_session_state(session.state))
    await client.delete(session)


async def test_timeouts_and_a_wrong_token_surface_as_sdk_errors(worker):
    client = worker.client(exec_timeout=1)
    session = await client.create(manifest=manifest(client, "s-eps"), options=MXCSandboxOptions(workspace_id="s-eps"))
    async with session:
        with pytest.raises(ExecTimeoutError):
            await session.exec("sleep 5")
    await client.delete(session)
    intruder = MXCSandboxClient(worker.target, worker="test-worker", token="wrong", workspace_base=worker.workspace_base)
    session = await intruder.create(manifest=manifest(intruder, "s-zeta"), options=MXCSandboxOptions(workspace_id="s-zeta"))
    with pytest.raises(WorkerError) as refused:
        await session.start()
    assert refused.value.code == grpc.StatusCode.UNAUTHENTICATED


async def test_a_sandbox_agent_runs_its_tools_through_the_worker(worker):
    client = worker.client()
    session = await client.create(manifest=manifest(client, "s-eta"), options=MXCSandboxOptions(workspace_id="s-eta"))
    model = Calls([shell("kubectl get pods -n payments -o wide"),
                   shell("grep -c CrashLoopBackOff evidence/*.txt > output/count.txt && cat output/count.txt")],
                  answer="One pod is crash-looping.")
    agent = SandboxAgent(name="SRE", model=model, instructions="Investigate.", default_manifest=session.state.manifest,
                         capabilities=[Shell(), Filesystem()])
    async with session:
        result = await Runner.run(agent, "What is unhealthy?", run_config=RunConfig(
            sandbox=SandboxRunConfig(session=session), tracing_disabled=True))
        assert result.final_output == "One pod is crash-looping."
        assert "payments-processor-7d9f8c6b5d-x2k4p" in model.outputs[0]
        assert (await session.read(Path("output/count.txt"))).read().strip() == b"1"
    await client.delete(session)


def test_session_ids_are_validated():
    with pytest.raises(ValueError):
        MXCSandboxOptions(workspace_id="../x")
    assert MXCSandboxClient.new_workspace_id().startswith("s-")
