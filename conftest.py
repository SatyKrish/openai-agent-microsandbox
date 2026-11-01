# Copyright 2026 openai-agent-mxc contributors
# SPDX-License-Identifier: Apache-2.0
"""Shared fixtures: the worker's real gRPC service on loopback, with a host runner in place of MXC.

The Python tests exercise the provider, harness and agent against the worker's
actual protocol, path guards, redaction, journal and evidence rules. Commands
run on the test host without isolation; MXC itself is exercised on Kind
(``make verify``). Build the worker first: ``npm --prefix worker run build``.
"""

import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import pytest
from agents import set_tracing_disabled

ROOT = Path(__file__).resolve().parent
HOST_WORKER = ROOT / "worker/dist/test/host-worker.js"
FAKE_KUBECTL = """#!/bin/sh
# A stand-in for kubectl: fixed answers for the payments demo.
case "$*" in
  "get pods"*) printf '%s\\n' \
    'NAME                                  READY   STATUS             RESTARTS      AGE   IP           NODE' \
    'payments-processor-7d9f8c6b5d-x2k4p   0/1     CrashLoopBackOff   5 (40s ago)   4m    10.244.0.7   kind' \
    'payments-gateway-5b7c8d9e6f-a1b2c     1/1     Running            0             4m    10.244.0.6   kind' ;;
  "logs"*) echo "Error from server (Forbidden): pod logs are not readable from the sandbox; use the pod_logs tool" >&2
     exit 1 ;;
  "get events"*) printf '%s\\n' 'LAST SEEN   TYPE      REASON    OBJECT    MESSAGE' \
    '30s         Warning   BackOff   pod/payments-processor-7d9f8c6b5d-x2k4p   Back-off restarting failed container' ;;
  *) echo "fake kubectl: unsupported: $*" >&2; exit 1 ;;
esac
"""


@pytest.fixture(autouse=True)
def disable_hosted_tracing():
    set_tracing_disabled(True)


@dataclass
class Worker:
    target: str
    data_dir: Path
    token: str

    @property
    def workspace_base(self) -> str:
        return str(self.data_dir / "active")

    def client(self, **options):
        from agent_mxc import MXCSandboxClient

        return MXCSandboxClient(self.target, worker="test-worker", token=self.token,
                                workspace_base=self.workspace_base, **options)


@pytest.fixture
def worker(tmp_path):
    node = shutil.which("node")
    if node is None or not HOST_WORKER.is_file():
        pytest.skip("build the worker first: npm --prefix worker ci && npm --prefix worker run build")
    # Resolve symlinks (macOS /var -> /private/var): the worker reports real paths.
    data_dir = (tmp_path / "worker").resolve()
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    (fake_bin / "kubectl").write_text(FAKE_KUBECTL)
    (fake_bin / "kubectl").chmod(0o755)
    env = {**os.environ, "DATA_DIR": str(data_dir), "FAKE_BIN": str(fake_bin), "MXC_TEST_TOKEN": "pair-token"}
    process = subprocess.Popen([node, str(HOST_WORKER)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
                               text=True)
    line = process.stdout.readline()
    if not line:
        process.kill()
        raise RuntimeError(f"host worker failed to start: {process.stderr.read()}")
    try:
        yield Worker(f"127.0.0.1:{json.loads(line)['port']}", data_dir, "pair-token")
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
