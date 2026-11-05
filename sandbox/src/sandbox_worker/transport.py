# Copyright 2026 openai-agent-microsandbox contributors
# SPDX-License-Identifier: Apache-2.0
"""The gRPC connection to one sandbox worker (proto/sandbox/v1/sandbox.proto).

A ``grpc.aio`` channel belongs to the event loop that created it, so the channel
is opened lazily in the running loop and reopened if a later call runs in another.
Commands are never retried: one that failed in transit may already have run.
"""

from __future__ import annotations

import asyncio

import grpc

from .proto import sandbox_pb2 as pb
from .proto.sandbox_pb2_grpc import SandboxStub

MIB = 1024 * 1024


class WorkerError(RuntimeError):
    """A worker call failed; ``code`` is the gRPC status."""

    def __init__(self, code: grpc.StatusCode, details: str):
        super().__init__(f"{code.name}: {details}")
        self.code = code
        self.details = details


class WorkerTransport:
    def __init__(self, target: str, *, token: str | None = None, max_message_bytes: int = 12 * MIB,
                 call_timeout: float = 30, deadline_margin: float = 120):
        self.target = target
        self._metadata = (("authorization", f"Bearer {token}"),) if token else ()
        self._options = [("grpc.max_receive_message_length", max_message_bytes),
                         ("grpc.max_send_message_length", max_message_bytes)]
        self.call_timeout = call_timeout
        self.deadline_margin = deadline_margin
        self._channel: grpc.aio.Channel | None = None
        self._stub: SandboxStub | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    def _connected(self) -> SandboxStub:
        loop = asyncio.get_running_loop()
        if self._stub is None or self._loop is not loop:
            self._channel = grpc.aio.insecure_channel(self.target, options=self._options)
            self._stub = SandboxStub(self._channel)
            self._loop = loop
        return self._stub

    async def _call(self, method: str, request, timeout: float | None = None):
        try:
            return await getattr(self._connected(), method)(
                request, metadata=self._metadata, timeout=timeout or self.call_timeout)
        except grpc.aio.AioRpcError as error:
            raise WorkerError(error.code(), error.details() or "") from None

    async def info(self) -> pb.InfoResponse:
        return await self._call("Info", pb.InfoRequest())

    async def health(self) -> pb.HealthResponse:
        return await self._call("Health", pb.HealthRequest())

    async def init_session(self, session_id: str) -> pb.InitSessionResponse:
        return await self._call("InitSession", pb.InitSessionRequest(session_id=session_id))

    async def exec(self, session_id: str, argv: list[str], *, cwd: str = "", timeout_s: float,
                   requester: str = "") -> pb.ExecResponse:
        request = pb.ExecRequest(session_id=session_id, argv=argv, cwd=cwd, timeout_ms=int(timeout_s * 1000),
                                 requester=requester)
        # The worker enforces the command's deadline; the call's covers queueing and transfer as well,
        # including waiting for the session's VM to start or for room among the worker's running VMs.
        return await self._call("Exec", request, timeout=timeout_s + self.deadline_margin)

    async def write_file(self, session_id: str, path: str, content: bytes) -> pb.WriteFileResponse:
        return await self._call("WriteFile", pb.WriteFileRequest(session_id=session_id, path=path, content=content))

    async def read_file(self, session_id: str, path: str, max_bytes: int = 0) -> pb.ReadFileResponse:
        return await self._call("ReadFile", pb.ReadFileRequest(session_id=session_id, path=path, max_bytes=max_bytes))

    async def list_evidence(self, session_id: str, after_seq: int = 0) -> list[pb.Evidence]:
        response = await self._call("ListEvidence", pb.ListEvidenceRequest(session_id=session_id, after_seq=after_seq))
        return list(response.entries)

    async def read_evidence(self, session_id: str, seq: int) -> pb.ReadEvidenceResponse:
        return await self._call("ReadEvidence", pb.ReadEvidenceRequest(session_id=session_id, seq=seq))

    async def read_logs(self, session_id: str, namespace: str, pod: str, *, container: str = "", previous: bool = False,
                        tail_lines: int = 0, since_seconds: int = 0, match: str = "",
                        requester: str = "") -> pb.ReadLogsResponse:
        return await self._call("ReadLogs", pb.ReadLogsRequest(
            session_id=session_id, namespace=namespace, pod=pod, container=container, previous=previous,
            tail_lines=tail_lines, since_seconds=since_seconds, match=match, requester=requester), timeout=60)

    async def destroy(self, session_id: str, *, purge_history: bool = False) -> bool:
        response = await self._call("DestroySession",
                                    pb.DestroySessionRequest(session_id=session_id, purge_history=purge_history))
        return response.existed

    async def close(self) -> None:
        if self._channel is not None:
            await self._channel.close()
        self._channel = self._stub = self._loop = None
