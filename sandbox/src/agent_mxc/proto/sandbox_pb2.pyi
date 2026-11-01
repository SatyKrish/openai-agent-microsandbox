from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class InfoRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class InfoResponse(_message.Message):
    __slots__ = ("worker_id", "domain", "containment", "mxc_sdk_version", "egress", "active_sessions", "max_file_bytes", "workspace_base", "namespaces")
    WORKER_ID_FIELD_NUMBER: _ClassVar[int]
    DOMAIN_FIELD_NUMBER: _ClassVar[int]
    CONTAINMENT_FIELD_NUMBER: _ClassVar[int]
    MXC_SDK_VERSION_FIELD_NUMBER: _ClassVar[int]
    EGRESS_FIELD_NUMBER: _ClassVar[int]
    ACTIVE_SESSIONS_FIELD_NUMBER: _ClassVar[int]
    MAX_FILE_BYTES_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_BASE_FIELD_NUMBER: _ClassVar[int]
    NAMESPACES_FIELD_NUMBER: _ClassVar[int]
    worker_id: str
    domain: str
    containment: str
    mxc_sdk_version: str
    egress: str
    active_sessions: int
    max_file_bytes: int
    workspace_base: str
    namespaces: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, worker_id: _Optional[str] = ..., domain: _Optional[str] = ..., containment: _Optional[str] = ..., mxc_sdk_version: _Optional[str] = ..., egress: _Optional[str] = ..., active_sessions: _Optional[int] = ..., max_file_bytes: _Optional[int] = ..., workspace_base: _Optional[str] = ..., namespaces: _Optional[_Iterable[str]] = ...) -> None: ...

class InitSessionRequest(_message.Message):
    __slots__ = ("session_id",)
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    def __init__(self, session_id: _Optional[str] = ...) -> None: ...

class InitSessionResponse(_message.Message):
    __slots__ = ("workspace_root", "created")
    WORKSPACE_ROOT_FIELD_NUMBER: _ClassVar[int]
    CREATED_FIELD_NUMBER: _ClassVar[int]
    workspace_root: str
    created: bool
    def __init__(self, workspace_root: _Optional[str] = ..., created: _Optional[bool] = ...) -> None: ...

class ExecRequest(_message.Message):
    __slots__ = ("session_id", "argv", "cwd", "timeout_ms")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    ARGV_FIELD_NUMBER: _ClassVar[int]
    CWD_FIELD_NUMBER: _ClassVar[int]
    TIMEOUT_MS_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    argv: _containers.RepeatedScalarFieldContainer[str]
    cwd: str
    timeout_ms: int
    def __init__(self, session_id: _Optional[str] = ..., argv: _Optional[_Iterable[str]] = ..., cwd: _Optional[str] = ..., timeout_ms: _Optional[int] = ...) -> None: ...

class ExecResponse(_message.Message):
    __slots__ = ("stdout", "stderr", "exit_code", "timed_out", "duration_ms", "truncated", "evidence_path")
    STDOUT_FIELD_NUMBER: _ClassVar[int]
    STDERR_FIELD_NUMBER: _ClassVar[int]
    EXIT_CODE_FIELD_NUMBER: _ClassVar[int]
    TIMED_OUT_FIELD_NUMBER: _ClassVar[int]
    DURATION_MS_FIELD_NUMBER: _ClassVar[int]
    TRUNCATED_FIELD_NUMBER: _ClassVar[int]
    EVIDENCE_PATH_FIELD_NUMBER: _ClassVar[int]
    stdout: bytes
    stderr: bytes
    exit_code: int
    timed_out: bool
    duration_ms: int
    truncated: bool
    evidence_path: str
    def __init__(self, stdout: _Optional[bytes] = ..., stderr: _Optional[bytes] = ..., exit_code: _Optional[int] = ..., timed_out: _Optional[bool] = ..., duration_ms: _Optional[int] = ..., truncated: _Optional[bool] = ..., evidence_path: _Optional[str] = ...) -> None: ...

class WriteFileRequest(_message.Message):
    __slots__ = ("session_id", "path", "content")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    PATH_FIELD_NUMBER: _ClassVar[int]
    CONTENT_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    path: str
    content: bytes
    def __init__(self, session_id: _Optional[str] = ..., path: _Optional[str] = ..., content: _Optional[bytes] = ...) -> None: ...

class WriteFileResponse(_message.Message):
    __slots__ = ("bytes_written",)
    BYTES_WRITTEN_FIELD_NUMBER: _ClassVar[int]
    bytes_written: int
    def __init__(self, bytes_written: _Optional[int] = ...) -> None: ...

class ReadFileRequest(_message.Message):
    __slots__ = ("session_id", "path", "max_bytes")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    PATH_FIELD_NUMBER: _ClassVar[int]
    MAX_BYTES_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    path: str
    max_bytes: int
    def __init__(self, session_id: _Optional[str] = ..., path: _Optional[str] = ..., max_bytes: _Optional[int] = ...) -> None: ...

class ReadFileResponse(_message.Message):
    __slots__ = ("content", "size")
    CONTENT_FIELD_NUMBER: _ClassVar[int]
    SIZE_FIELD_NUMBER: _ClassVar[int]
    content: bytes
    size: int
    def __init__(self, content: _Optional[bytes] = ..., size: _Optional[int] = ...) -> None: ...

class Evidence(_message.Message):
    __slots__ = ("seq", "path", "command", "sha256", "bytes", "exit_code", "recorded_at")
    SEQ_FIELD_NUMBER: _ClassVar[int]
    PATH_FIELD_NUMBER: _ClassVar[int]
    COMMAND_FIELD_NUMBER: _ClassVar[int]
    SHA256_FIELD_NUMBER: _ClassVar[int]
    BYTES_FIELD_NUMBER: _ClassVar[int]
    EXIT_CODE_FIELD_NUMBER: _ClassVar[int]
    RECORDED_AT_FIELD_NUMBER: _ClassVar[int]
    seq: int
    path: str
    command: str
    sha256: str
    bytes: int
    exit_code: int
    recorded_at: str
    def __init__(self, seq: _Optional[int] = ..., path: _Optional[str] = ..., command: _Optional[str] = ..., sha256: _Optional[str] = ..., bytes: _Optional[int] = ..., exit_code: _Optional[int] = ..., recorded_at: _Optional[str] = ...) -> None: ...

class ListEvidenceRequest(_message.Message):
    __slots__ = ("session_id", "after_seq")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    AFTER_SEQ_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    after_seq: int
    def __init__(self, session_id: _Optional[str] = ..., after_seq: _Optional[int] = ...) -> None: ...

class ListEvidenceResponse(_message.Message):
    __slots__ = ("entries",)
    ENTRIES_FIELD_NUMBER: _ClassVar[int]
    entries: _containers.RepeatedCompositeFieldContainer[Evidence]
    def __init__(self, entries: _Optional[_Iterable[_Union[Evidence, _Mapping]]] = ...) -> None: ...

class ReadEvidenceRequest(_message.Message):
    __slots__ = ("session_id", "seq")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    SEQ_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    seq: int
    def __init__(self, session_id: _Optional[str] = ..., seq: _Optional[int] = ...) -> None: ...

class ReadEvidenceResponse(_message.Message):
    __slots__ = ("entry", "content")
    ENTRY_FIELD_NUMBER: _ClassVar[int]
    CONTENT_FIELD_NUMBER: _ClassVar[int]
    entry: Evidence
    content: bytes
    def __init__(self, entry: _Optional[_Union[Evidence, _Mapping]] = ..., content: _Optional[bytes] = ...) -> None: ...

class ReadLogsRequest(_message.Message):
    __slots__ = ("session_id", "namespace", "pod", "container", "previous", "tail_lines", "since_seconds", "match")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    NAMESPACE_FIELD_NUMBER: _ClassVar[int]
    POD_FIELD_NUMBER: _ClassVar[int]
    CONTAINER_FIELD_NUMBER: _ClassVar[int]
    PREVIOUS_FIELD_NUMBER: _ClassVar[int]
    TAIL_LINES_FIELD_NUMBER: _ClassVar[int]
    SINCE_SECONDS_FIELD_NUMBER: _ClassVar[int]
    MATCH_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    namespace: str
    pod: str
    container: str
    previous: bool
    tail_lines: int
    since_seconds: int
    match: str
    def __init__(self, session_id: _Optional[str] = ..., namespace: _Optional[str] = ..., pod: _Optional[str] = ..., container: _Optional[str] = ..., previous: _Optional[bool] = ..., tail_lines: _Optional[int] = ..., since_seconds: _Optional[int] = ..., match: _Optional[str] = ...) -> None: ...

class ReadLogsResponse(_message.Message):
    __slots__ = ("excerpt", "evidence_path", "lines_read", "lines_shown", "lines_withheld", "redactions")
    EXCERPT_FIELD_NUMBER: _ClassVar[int]
    EVIDENCE_PATH_FIELD_NUMBER: _ClassVar[int]
    LINES_READ_FIELD_NUMBER: _ClassVar[int]
    LINES_SHOWN_FIELD_NUMBER: _ClassVar[int]
    LINES_WITHHELD_FIELD_NUMBER: _ClassVar[int]
    REDACTIONS_FIELD_NUMBER: _ClassVar[int]
    excerpt: str
    evidence_path: str
    lines_read: int
    lines_shown: int
    lines_withheld: int
    redactions: int
    def __init__(self, excerpt: _Optional[str] = ..., evidence_path: _Optional[str] = ..., lines_read: _Optional[int] = ..., lines_shown: _Optional[int] = ..., lines_withheld: _Optional[int] = ..., redactions: _Optional[int] = ...) -> None: ...

class HealthRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class Workload(_message.Message):
    __slots__ = ("namespace", "kind", "name", "desired", "ready", "restarts", "state", "reasons", "warnings", "last_warning", "last_warning_at")
    NAMESPACE_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    DESIRED_FIELD_NUMBER: _ClassVar[int]
    READY_FIELD_NUMBER: _ClassVar[int]
    RESTARTS_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    REASONS_FIELD_NUMBER: _ClassVar[int]
    WARNINGS_FIELD_NUMBER: _ClassVar[int]
    LAST_WARNING_FIELD_NUMBER: _ClassVar[int]
    LAST_WARNING_AT_FIELD_NUMBER: _ClassVar[int]
    namespace: str
    kind: str
    name: str
    desired: int
    ready: int
    restarts: int
    state: str
    reasons: _containers.RepeatedScalarFieldContainer[str]
    warnings: int
    last_warning: str
    last_warning_at: str
    def __init__(self, namespace: _Optional[str] = ..., kind: _Optional[str] = ..., name: _Optional[str] = ..., desired: _Optional[int] = ..., ready: _Optional[int] = ..., restarts: _Optional[int] = ..., state: _Optional[str] = ..., reasons: _Optional[_Iterable[str]] = ..., warnings: _Optional[int] = ..., last_warning: _Optional[str] = ..., last_warning_at: _Optional[str] = ...) -> None: ...

class NamespaceHealth(_message.Message):
    __slots__ = ("namespace", "workloads", "error")
    NAMESPACE_FIELD_NUMBER: _ClassVar[int]
    WORKLOADS_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    namespace: str
    workloads: _containers.RepeatedCompositeFieldContainer[Workload]
    error: str
    def __init__(self, namespace: _Optional[str] = ..., workloads: _Optional[_Iterable[_Union[Workload, _Mapping]]] = ..., error: _Optional[str] = ...) -> None: ...

class HealthResponse(_message.Message):
    __slots__ = ("generated_at", "namespaces")
    GENERATED_AT_FIELD_NUMBER: _ClassVar[int]
    NAMESPACES_FIELD_NUMBER: _ClassVar[int]
    generated_at: str
    namespaces: _containers.RepeatedCompositeFieldContainer[NamespaceHealth]
    def __init__(self, generated_at: _Optional[str] = ..., namespaces: _Optional[_Iterable[_Union[NamespaceHealth, _Mapping]]] = ...) -> None: ...

class DestroySessionRequest(_message.Message):
    __slots__ = ("session_id", "purge_history")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    PURGE_HISTORY_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    purge_history: bool
    def __init__(self, session_id: _Optional[str] = ..., purge_history: _Optional[bool] = ...) -> None: ...

class DestroySessionResponse(_message.Message):
    __slots__ = ("existed",)
    EXISTED_FIELD_NUMBER: _ClassVar[int]
    existed: bool
    def __init__(self, existed: _Optional[bool] = ...) -> None: ...
