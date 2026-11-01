# Copyright 2026 openai-agent-mxc contributors
# SPDX-License-Identifier: Apache-2.0
"""SDK-only instrumentation; importing the provider does not require the OpenTelemetry SDK or exporter."""

from contextlib import contextmanager
from functools import wraps

from agents import custom_span, get_current_trace


@contextmanager
def operation(name):
    """A payload-free SDK custom span nested under the current SDK tool span."""
    current = get_current_trace()
    if current is None or current.trace_id == "no-op":
        yield None
        return
    with custom_span(name) as span:
        try:
            yield span
        except BaseException:
            span.set_error({"message": "Operation failed", "data": {}})
            raise


def traced_operation(name):
    def decorate(function):
        @wraps(function)
        async def wrapped(*args, **kwargs):
            with operation(name):
                return await function(*args, **kwargs)
        return wrapped
    return decorate
