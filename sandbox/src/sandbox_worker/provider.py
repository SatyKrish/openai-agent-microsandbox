# Copyright 2026 openai-agent-microsandbox contributors
# SPDX-License-Identifier: Apache-2.0
"""OpenAI Agents SDK sandbox client for a paired sandbox worker on Kubernetes.

A session is a workspace directory on the worker's volume, and a microVM there
that the worker starts on the session's first command and stops when it is idle.
The SDK has nothing to suspend: closing a session only closes it on this side,
and the workspace stays until ``delete``. Files move over the worker's own file
RPCs rather than through shell commands.
"""

from __future__ import annotations

import io
import re
import uuid
from pathlib import Path, PurePosixPath
from typing import Literal

import grpc
from pydantic import field_validator

from agents.sandbox import Manifest
from agents.sandbox.entries import BaseEntry, Dir, File, LocalDir, LocalFile
from agents.sandbox.errors import ExecTimeoutError, ExecTransportError, WorkspaceReadNotFoundError
from agents.sandbox.session import SandboxSession, SandboxSessionState
from agents.sandbox.session.base_sandbox_session import BaseSandboxSession
from agents.sandbox.session.sandbox_client import BaseSandboxClient, BaseSandboxClientOptions
from agents.sandbox.snapshot import NoopSnapshot, SnapshotBase, SnapshotSpec
from agents.sandbox.types import ExecResult, User

from .instrumentation import operation, traced_operation
from .transport import MIB, WorkerError, WorkerTransport

BACKEND = "kubernetes-sandbox-worker"
MAX_FILE_BYTES = 10 * MIB
_SESSION_ID = re.compile(r"[a-z0-9][a-z0-9-]{2,62}")


class WorkspaceFileNotFoundError(WorkspaceReadNotFoundError, FileNotFoundError):
    """A missing workspace file. SDK capabilities such as Memory expect the SDK's own not-found error;
    other callers expect a ``FileNotFoundError``. This is both."""


def workspace_id(value: str) -> str:
    """The worker's session ID for a workspace (the SDK's own ``session_id`` is a UUID for its events)."""
    if not _SESSION_ID.fullmatch(value or ""):
        raise ValueError("A workspace ID matches [a-z0-9][a-z0-9-]{2,62}")
    return value


class WorkerSandboxOptions(BaseSandboxClientOptions):
    type: Literal["kubernetes-sandbox-worker"] = BACKEND
    workspace_id: str | None = None

    @field_validator("workspace_id")
    @classmethod
    def _id(cls, value: str | None) -> str | None:
        return workspace_id(value) if value is not None else None


class WorkerSessionState(SandboxSessionState):
    type: Literal["kubernetes-sandbox-worker"] = BACKEND
    workspace_id: str
    worker: str

    @field_validator("workspace_id")
    @classmethod
    def _id(cls, value: str) -> str:
        return workspace_id(value)


def validate_manifest(manifest: Manifest) -> None:
    root = PurePosixPath(manifest.root)
    if not root.is_absolute() or str(root) == "/" or ".." in root.parts:
        raise ValueError("Use an absolute workspace root below /, without '..'")
    if manifest.users or manifest.groups or manifest.extra_path_grants or manifest.environment.value:
        raise NotImplementedError("Worker workspaces hold files and directories only: no accounts, environment or path grants")

    def validate(entry: BaseEntry) -> None:
        if not isinstance(entry, (File, Dir, LocalFile, LocalDir)) or entry.group is not None:
            raise NotImplementedError("Worker workspaces support File, Dir, LocalFile and LocalDir entries without ownership")
        if isinstance(entry, Dir):
            for child in entry.children.values():
                validate(child)

    for entry in manifest.validated_entries().values():
        validate(entry)


def _rollout(message) -> dict:
    return {"revision": message.revision, "at": message.at, "images": list(message.images),
            "previous_revision": message.previous_revision or None,
            "changed": [{"container": item.container, "from": getattr(item, "from"), "to": item.to} for item in message.changed]}


class WorkerSandboxClient(BaseSandboxClient[WorkerSandboxOptions]):
    """Bound to one worker. ``worker`` names it in saved session state, so a session
    resumes only on the worker that holds its workspace.

    ``workspace_base`` must match the worker's ``DATA_DIR``/active: a session's
    workspace has the same path inside its VM as on the worker's volume.
    """

    backend_id = BACKEND

    def __init__(self, target: str, *, worker: str | None = None, token: str | None = None,
                 workspace_base: str = "/sandboxes/active", exec_timeout: float = 60,
                 max_file_bytes: int = MAX_FILE_BYTES):
        if max_file_bytes <= 0:
            raise ValueError("max_file_bytes must be positive")
        self.transport = WorkerTransport(target, token=token, max_message_bytes=max_file_bytes + 2 * MIB)
        self.worker = worker or target
        self.workspace_base = workspace_base.rstrip("/")
        self.exec_timeout = exec_timeout
        self.max_file_bytes = max_file_bytes

    @staticmethod
    def new_workspace_id() -> str:
        return f"s-{uuid.uuid4().hex[:20]}"

    def workspace_root(self, workspace: str) -> str:
        return f"{self.workspace_base}/{workspace_id(workspace)}"

    async def info(self) -> dict:
        reply = await self.transport.info()
        return {"worker_id": reply.worker_id, "domain": reply.domain, "isolation": reply.isolation,
                "runtime_version": reply.runtime_version, "egress": reply.egress,
                "active_sessions": reply.active_sessions, "namespaces": list(reply.namespaces)}

    async def health(self) -> dict:
        """The worker's summary of its namespaces' workloads: for people, not for the model."""
        reply = await self.transport.health()
        return {"generated_at": reply.generated_at, "namespaces": [
            {"namespace": item.namespace, "error": item.error, "workloads": [
                {"kind": workload.kind, "name": workload.name, "desired": workload.desired, "ready": workload.ready,
                 "restarts": workload.restarts, "state": workload.state, "reasons": list(workload.reasons),
                 "warnings": workload.warnings, "last_warning": workload.last_warning,
                 "last_warning_at": workload.last_warning_at, "waiting_message": workload.waiting_message,
                 "events": [{"type": event.type, "reason": event.reason, "message": event.message, "at": event.at}
                            for event in workload.events],
                 "rollout": _rollout(workload.rollout) if workload.HasField("rollout") else None}
                for workload in item.workloads]}
            for item in reply.namespaces]}

    @traced_operation("sandbox.create")
    async def create(self, *, options: WorkerSandboxOptions | None = None, manifest: Manifest | None = None,
                     snapshot: SnapshotSpec | SnapshotBase | None = None) -> SandboxSession:
        if snapshot is not None:
            raise NotImplementedError("Workspaces persist on the worker's volume; portable SDK snapshots are unsupported")
        options = options or WorkerSandboxOptions()
        sid = options.workspace_id or self.new_workspace_id()
        root = self.workspace_root(sid)
        manifest = manifest if manifest is not None else Manifest(root=root)
        if manifest.root != root:
            raise ValueError(f"The manifest root must be the session's workspace, {root}")
        self._validate_manifest_for_create(manifest)
        validate_manifest(manifest)
        state = WorkerSessionState(workspace_id=sid, worker=self.worker, manifest=manifest,
                                snapshot=NoopSnapshot(id=uuid.uuid4().hex))
        return self._wrap_session(_WorkerSession(state, self, preserved=False))

    async def resume(self, state: SandboxSessionState) -> SandboxSession:
        if not isinstance(state, WorkerSessionState) or state.worker != self.worker:
            raise ValueError("Resume requires session state from this client's worker")
        state.assert_path_grants_rebound()
        validate_manifest(state.manifest)
        return self._wrap_session(_WorkerSession(state.model_copy(deep=True), self, preserved=True))

    def deserialize_session_state(self, payload: dict[str, object]) -> WorkerSessionState:
        # Conversations saved before the worker ran microVMs name the backend by its old name; the
        # workspace is the same, and its new VM starts on the next command.
        if payload.get("type") == "mxc-kubernetes-worker":
            payload = {**payload, "type": BACKEND}
        state = self._deserialize_session_state_payload(payload, WorkerSessionState)
        if not isinstance(state, WorkerSessionState) or state.worker != self.worker:
            raise ValueError("Session state belongs to another worker")
        return state

    @traced_operation("sandbox.delete")
    async def delete(self, session: SandboxSession, *, purge_history: bool = False) -> SandboxSession:
        inner = session._inner
        if not isinstance(inner, _WorkerSession) or inner.client is not self:
            raise ValueError("Delete requires a session owned by this client")
        if not inner.deleted:
            await self.transport.destroy(inner.state.workspace_id, purge_history=purge_history)
            inner.deleted = True
            # Deleting is not closing: as the SDK separates the two, a caller that wants the session's
            # pre-stop hooks (memory generation among them) calls aclose() first. Without it, the
            # session is only shut down, and a deleted conversation is not remembered.
            await session.shutdown()
        return session

    async def aclose(self) -> None:
        await self.transport.close()


class _WorkerSession(BaseSandboxSession):
    def __init__(self, state: WorkerSessionState, client: WorkerSandboxClient, *, preserved: bool):
        self.state = state
        self.client = client
        self.deleted = False
        self.ready = False
        # Who asked for the current turn, sent with each command and log read for the worker's journal.
        # The harness sets it per turn; it is not part of the saved session state.
        self.requester = ""
        self._set_start_state_preserved(preserved)

    @property
    def transport(self) -> WorkerTransport:
        return self.client.transport

    async def _ensure_backend_started(self) -> None:
        if self.deleted:
            raise RuntimeError("This session has been deleted")
        validate_manifest(self.state.manifest)
        with operation("sandbox.init"):
            reply = await self.transport.init_session(self.state.workspace_id)
        if reply.workspace_root != self.state.manifest.root:
            raise RuntimeError("The worker's workspace path differs from this client's workspace_base")
        if reply.created and self._workspace_state_preserved_on_start():
            # The worker lost the workspace (a new volume): rebuild it from the manifest.
            self._set_start_state_preserved(False)
            self.state.workspace_root_ready = False
        self.ready = True

    async def _exec_internal(self, *command: str | Path, timeout: float | None = None) -> ExecResult:
        if self.deleted or not self.ready:
            raise RuntimeError("Start the sandbox session before executing commands")
        argv = [str(part) for part in command]
        limit = timeout if timeout is not None else self.client.exec_timeout
        try:
            with operation("sandbox.exec") as span:
                reply = await self.transport.exec(self.state.workspace_id, argv, timeout_s=limit,
                                                  requester=self.requester)
                if span is not None:
                    span.span_data.data.update(exit_code=reply.exit_code, stdout_bytes=len(reply.stdout),
                                               stderr_bytes=len(reply.stderr))
                    if reply.exit_code:
                        span.set_error({"message": "Command returned nonzero", "data": {}})
        except WorkerError as error:
            raise ExecTransportError(command=tuple(argv), cause=error, retryable=False,
                                     context={"backend": BACKEND, "retry_safe": False, "status": error.code.name}) from error
        if reply.timed_out:
            raise ExecTimeoutError(command=tuple(argv), timeout_s=limit, context={"backend": BACKEND})
        return ExecResult(stdout=reply.stdout, stderr=reply.stderr, exit_code=reply.exit_code)

    async def running(self) -> bool:
        # The worker starts the session's VM on the next command if it has stopped; a started
        # session is always ready for one. Probing with a command would cost a VM start.
        return self.ready and not self.deleted

    def _file_error(self, error: WorkerError, path: str) -> Exception:
        if error.code == grpc.StatusCode.NOT_FOUND:
            return WorkspaceFileNotFoundError(path=Path(path))
        if error.code == grpc.StatusCode.RESOURCE_EXHAUSTED:
            return ValueError(f"{path} exceeds the {self.client.max_file_bytes / MIB:g} MiB file limit")
        if error.code == grpc.StatusCode.INVALID_ARGUMENT:
            return ValueError(error.details)
        return error

    async def read(self, path: Path, *, user: str | User | None = None) -> io.BytesIO:
        if user is not None:
            raise NotImplementedError("Per-user execution is unsupported")
        target = str(self.normalize_path(path))
        try:
            with operation("sandbox.read"):
                reply = await self.transport.read_file(self.state.workspace_id, target)
        except WorkerError as error:
            raise self._file_error(error, target) from None
        return io.BytesIO(reply.content)

    async def _read_bounded(self, path: Path, *, max_bytes: int) -> bytes:
        target = str(self.normalize_path(path))
        try:
            reply = await self.transport.read_file(self.state.workspace_id, target, max_bytes=max_bytes)
        except WorkerError as error:
            raise self._file_error(error, target) from None
        return reply.content

    async def write(self, path: Path, data: io.IOBase, *, user: str | User | None = None) -> None:
        if user is not None:
            raise NotImplementedError("Per-user execution is unsupported")
        target = str(self.normalize_path(path, for_write=True))
        value = data.read(self.client.max_file_bytes + 1)
        payload = value.encode() if isinstance(value, str) else bytes(value)
        if len(payload) > self.client.max_file_bytes:
            raise ValueError(f"File exceeds the {self.client.max_file_bytes / MIB:g} MiB file limit")
        try:
            with operation("sandbox.write"):
                await self.transport.write_file(self.state.workspace_id, target, payload)
        except WorkerError as error:
            raise self._file_error(error, target) from None

    async def evidence(self, after_seq: int = 0) -> list[dict]:
        """Cluster reads the worker recorded for this session after ``after_seq``."""
        entries = await self.transport.list_evidence(self.state.workspace_id, after_seq)
        return [{"seq": item.seq, "path": item.path, "command": item.command, "sha256": item.sha256,
                 "bytes": item.bytes, "recorded_at": item.recorded_at} for item in entries]

    async def read_evidence(self, seq: int) -> bytes:
        """The worker's own copy of an evidence entry, which no VM can edit."""
        return (await self.transport.read_evidence(self.state.workspace_id, seq)).content

    async def read_logs(self, namespace: str, pod: str, *, container: str | None = None, previous: bool = False,
                        tail_lines: int = 0, since_seconds: int = 0, match: str | None = None) -> dict:
        """A pod's log through the worker's log policy: an excerpt, never the raw log.

        ``pod`` is a pod name or ``deploy/NAME``. The worker records the excerpt as evidence.
        """
        with operation("sandbox.logs"):
            reply = await self.transport.read_logs(
                self.state.workspace_id, namespace, pod, container=container or "", previous=previous,
                tail_lines=tail_lines, since_seconds=since_seconds, match=match or "", requester=self.requester)
        return {"excerpt": reply.excerpt, "evidence_path": reply.evidence_path, "lines_read": reply.lines_read,
                "lines_shown": reply.lines_shown, "lines_withheld": reply.lines_withheld,
                "redactions": reply.redactions}

    async def persist_workspace(self) -> io.IOBase:
        raise NotImplementedError("The workspace persists on the worker's volume")

    async def hydrate_workspace(self, data: io.IOBase) -> None:
        raise NotImplementedError("The workspace persists on the worker's volume")
