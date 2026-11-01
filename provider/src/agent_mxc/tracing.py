# Copyright 2026 openai-agent-mxc contributors
# SPDX-License-Identifier: Apache-2.0
"""Agents SDK trace processor exporting an allowlisted OTLP representation.

Configure once at process startup, before creating any traces. The processor
replaces the hosted OpenAI exporter. No global OpenTelemetry provider is changed.
"""

from __future__ import annotations

import hashlib
import logging
import os
from datetime import datetime
from threading import Lock
from time import time_ns

from agents import get_current_trace, set_trace_processors
from agents.tracing import TracingProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.util.instrumentation import InstrumentationScope
from opentelemetry.trace import SpanContext, SpanKind, Status, StatusCode, TraceFlags

from .instrumentation import operation as operation, traced_operation as traced_operation

logger = logging.getLogger(__name__)
_TYPES = {"agent", "task", "turn", "generation", "response", "function", "custom", "handoff", "guardrail"}
_TOOLS = {"load_skill", "exec_command", "apply_patch", "view_image"}
_OPERATIONS = {"sandbox.create", "sandbox.init", "sandbox.delete", "sandbox.exec", "sandbox.read", "sandbox.write"}


def tracing_enabled() -> bool:
    return (os.getenv("OPENAI_AGENTS_DISABLE_TRACING", "").lower() not in {"1", "true"}
            and bool(os.getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") or os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT")))


def otel_trace_id(sdk_trace_id: str) -> str:
    """Stable mapping to a 128-bit OTel ID, including non-hex SDK IDs."""
    return hashlib.sha256(sdk_trace_id.encode()).hexdigest()[:32]


def _context(trace_id: str, span_id: str) -> SpanContext:
    return SpanContext(trace_id=int(otel_trace_id(trace_id), 16),
                       span_id=int(hashlib.sha256(span_id.encode()).hexdigest()[:16], 16) or 1,
                       is_remote=False, trace_flags=TraceFlags(TraceFlags.SAMPLED))


def _timestamp(value: str) -> int:
    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1_000_000_000)


class OTLPTracingProcessor(TracingProcessor):
    """Preserve SDK parentage/timing without serializing untrusted span payloads.

    Callbacks enqueue already-sanitized ReadableSpans; network I/O runs on the
    OTel batch worker. The bounded queue drops spans under sustained overload.
    Application operation names must be explicitly supplied as trusted constants.
    Unknown names, all metadata, errors, inputs, outputs, commands and paths are
    excluded. Only span type, known tool/operation names and numeric metrics pass.
    """

    def __init__(self, exporter, *, service_name="openai-agent-mxc", operation_names=(), harness_tools=()):
        self.operation_names = frozenset(_OPERATIONS) | frozenset(operation_names)
        # Function tools that run in the harness, not the sandbox; also trusted constants.
        self.harness_tools = frozenset(harness_tools)
        self.resource = Resource({"service.name": service_name})
        self.processor = BatchSpanProcessor(exporter, schedule_delay_millis=1000,
                                            max_queue_size=4096, max_export_batch_size=512)
        self._lock = Lock()
        self._traces = {}

    def on_trace_start(self, trace):
        with self._lock:
            self._traces[trace.trace_id] = time_ns()

    def on_trace_end(self, trace):
        with self._lock:
            started = self._traces.pop(trace.trace_id, None)
        if started is not None:
            self._emit("agents.workflow", trace.trace_id, "root:" + trace.trace_id, None,
                       started, time_ns(), {"openai.span.type": "workflow"})

    def on_span_start(self, span):
        pass

    def on_span_end(self, span):
        try:
            data = span.span_data
            kind = data.type if data.type in _TYPES else "other"
            name = "agents." + kind
            attributes = {"openai.span.type": kind}
            if kind == "function" and data.name in _TOOLS:
                name = "tool." + data.name
                attributes["gen_ai.tool.name"] = data.name
            elif kind == "function" and data.name in self.harness_tools:
                name = "harness_tool." + data.name
                attributes["gen_ai.tool.name"] = data.name
            if kind == "custom" and data.name in self.operation_names:
                name = data.name
                for key in ("exit_code", "stdout_bytes", "stderr_bytes"):
                    value = data.data.get(key)
                    if type(value) is int:
                        attributes["sandbox." + key] = value
            usage = getattr(data, "usage", None)
            if isinstance(usage, dict):
                for key in ("input_tokens", "output_tokens", "total_tokens"):
                    if type(usage.get(key)) is int:
                        attributes["gen_ai.usage." + key] = usage[key]
            # Do not call span.export(): it can serialize prompts and tool outputs.
            self._emit(name, span.trace_id, span.span_id, span.parent_id or "root:" + span.trace_id,
                       _timestamp(span.started_at), _timestamp(span.ended_at), attributes, bool(span.error))
        except Exception:
            # Never log the payload or exception (which could contain content).
            logger.warning("Dropped an invalid Agents tracing span")

    def _emit(self, name, trace_id, span_id, parent_id, started, ended, attributes, error=False):
        self.processor.on_end(ReadableSpan(
            name=name, context=_context(trace_id, span_id),
            parent=_context(trace_id, parent_id) if parent_id else None,
            resource=self.resource, kind=SpanKind.INTERNAL,
            start_time=started, end_time=ended, attributes=attributes,
            status=Status(StatusCode.ERROR if error else StatusCode.UNSET),
            instrumentation_scope=InstrumentationScope("agent_mxc", "0.1.0"),
        ))

    def force_flush(self):
        if not self.processor.force_flush(timeout_millis=10000):
            logger.warning("Timed out flushing Agents traces")

    def shutdown(self):
        self.processor.shutdown()


def configure_tracing(*, operation_names=(), harness_tools=()):
    """Install the OTLP processor, or disable export when no endpoint is set.

    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is the full URL. The generic endpoint gets
    /v1/traces appended per OTLP conventions. TLS/headers use OTel's standard env.
    """
    if not tracing_enabled():
        set_trace_processors([])
        return None
    protocol = os.getenv("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", os.getenv("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf"))
    if protocol != "http/protobuf":
        raise ValueError("Tracing supports OTLP http/protobuf; use Jaeger port 4318")
    exporter = OTLPSpanExporter(timeout=5)
    processor = OTLPTracingProcessor(exporter, service_name=os.getenv("OTEL_SERVICE_NAME", "openai-agent-mxc"),
                                     operation_names=operation_names, harness_tools=harness_tools)
    set_trace_processors([processor])
    return processor


def current_trace_ids():
    current = get_current_trace()
    if not tracing_enabled() or current is None or current.trace_id == "no-op":
        return {"enabled": False}
    return {"enabled": True, "sdk_trace_id": current.trace_id, "otel_trace_id": otel_trace_id(current.trace_id)}
