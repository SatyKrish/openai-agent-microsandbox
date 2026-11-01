# Copyright 2026 openai-agent-mxc contributors
# SPDX-License-Identifier: Apache-2.0
"""Serve the SRE agent's UI on loopback, against its paired MXC sandbox worker.

In the cluster this runs in the harness pod and binds 127.0.0.1, so the only way
in is ``kubectl port-forward``. Locally it can run against a port-forwarded worker.
"""

from __future__ import annotations

import argparse
import os
from datetime import timedelta
from pathlib import Path

from openai_harness.settings import live_model, load_env_file

ROOT = Path(__file__).resolve().parents[3]


def parse_args(argv=None):
    from ..agent.agent import CONSOLIDATE_MODEL, EXTRACT_MODEL

    env = os.environ.get
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker", default=env("MXC_WORKER_TARGET", "127.0.0.1:50051"),
                        help="The sandbox worker's gRPC address (MXC_WORKER_TARGET)")
    parser.add_argument("--worker-name", default=env("MXC_WORKER_NAME"),
                        help="Stable name saved with each conversation; defaults to --worker (MXC_WORKER_NAME)")
    parser.add_argument("--token-file", type=Path, default=env("MXC_WORKER_TOKEN_FILE"),
                        help="The pair token the worker expects (MXC_WORKER_TOKEN_FILE)")
    parser.add_argument("--workspace-base", default=env("MXC_WORKSPACE_BASE", "/sandboxes/active"),
                        help="The worker's DATA_DIR/active")
    parser.add_argument("--namespace", action="append", dest="namespaces",
                        help="A namespace the worker's identity may read; repeat for more (SRE_NAMESPACES)")
    parser.add_argument("--model", help="OpenAI model ID; defaults to OPENAI_MODEL")
    parser.add_argument("--env-file", type=Path, default=ROOT / ".env", help="Reads OPENAI_* settings only")
    parser.add_argument("--host", default="127.0.0.1", choices=["127.0.0.1", "localhost"],
                        help="Loopback only: the server holds the API key")
    parser.add_argument("--port", type=int, default=int(env("SRE_UI_PORT", "8001")))
    parser.add_argument("--data-dir", type=Path, default=Path(env("SRE_DATA_DIR", str(ROOT / "artifacts/sre"))))
    parser.add_argument("--jaeger-url", default=env("JAEGER_URL", "http://127.0.0.1:16686"),
                        help="Jaeger query URL reachable from this host")
    parser.add_argument("--memory", choices=["on", "off"], default=env("SRE_MEMORY", "on"),
                        help="The agent's memory across each user's conversations")
    parser.add_argument("--memory-extract-model", default=env("MEMORY_EXTRACT_MODEL", EXTRACT_MODEL),
                        help="Model that extracts lessons from each conversation")
    parser.add_argument("--memory-consolidate-model", default=env("MEMORY_CONSOLIDATE_MODEL", CONSOLIDATE_MODEL),
                        help="Model that consolidates a user's lessons into their memory")
    parser.add_argument("--memory-max-age-days", type=float, default=float(env("SRE_MEMORY_MAX_AGE_DAYS", "90")),
                        help="Forget conversations last updated longer ago than this; 0 keeps them")
    parser.add_argument("--user-header", default=env("SRE_USER_HEADER") or None,
                        help="Header in which an authenticating proxy passes the signed-in user; "
                             "without it every user is the guest and shares the guest's memory")
    parser.add_argument("--idle-close", type=float, default=float(env("SRE_SESSION_IDLE_S", "300")),
                        help="Seconds a conversation's session stays open after a turn; memory is distilled on close")
    parser.add_argument("--max-turns", type=int, default=int(env("SRE_MAX_TURNS", "25")),
                        help="Model steps per turn before the agent stops and asks to continue")
    args = parser.parse_args(argv)
    load_env_file(args.env_file)
    try:
        args.model = live_model(args.model)
    except ValueError as error:
        parser.error(str(error))
    namespaces = args.namespaces or [name for name in env("SRE_NAMESPACES", "payments").split(",") if name]
    args.namespaces = frozenset(namespaces)
    args.token = args.token_file.read_text().strip() if args.token_file else None
    args.memory_models = (args.memory_extract_model, args.memory_consolidate_model) if args.memory == "on" else None
    return args


def main(argv=None):
    args = parse_args(argv)
    import logging

    import uvicorn
    from agents import flush_traces

    from agent_mxc import MXCSandboxClient
    from agent_mxc.tracing import configure_tracing, tracing_enabled
    from openai_harness.chat import HarnessChatServer
    from openai_harness.memory import UserMemory
    from openai_harness.store import SQLiteStore

    from ..agent.agent import REMEMBERED_CONVERSATIONS
    from ..agent.spec import REPORT, make_spec, runbooks
    from ..agent.tools.logs import TOOL_NAMES
    from .app import create_app
    from .card import check_rows, file_status

    logging.basicConfig(level=logging.INFO, format="%(levelname)s:     %(name)s: %(message)s")
    spec = make_spec(args.namespaces, memory_models=args.memory_models)
    configure_tracing(operation_names=spec.trace_operations, harness_tools=TOOL_NAMES)
    client = MXCSandboxClient(args.worker, worker=args.worker_name, token=args.token, workspace_base=args.workspace_base)
    store = SQLiteStore(args.data_dir / "threads.sqlite3")
    max_age = timedelta(days=args.memory_max_age_days) if args.memory_max_age_days > 0 else None
    memory = UserMemory(args.data_dir / "memory", memories_dir=spec.memory_dir, max_age=max_age,
                        max_conversations=REMEMBERED_CONVERSATIONS) if spec.memory_dir else None
    server = HarnessChatServer(spec, store, client, model=args.model, output_dir=args.data_dir / "threads",
                               base_url=f"http://localhost:{args.port}", card=check_rows, file_status=file_status,
                               preferred_output=REPORT, memory=memory, idle_close_s=args.idle_close,
                               max_turns=args.max_turns)
    scope = ", ".join(sorted(args.namespaces))
    config = {"model": args.model, "tracing": tracing_enabled(), "namespaces": sorted(args.namespaces),
              "idle_close_s": args.idle_close, "placeholder": f"Ask about workloads in {scope}…"}
    app = create_app(server, config=config, port=args.port, jaeger_url=args.jaeger_url if tracing_enabled() else None,
                     worker=client.info, health=client.health, starting_files=runbooks(),
                     user_header=args.user_header)
    remembering = (f"{' → '.join(args.memory_models)}, kept {f'{args.memory_max_age_days:g} days' if max_age else 'forever'}"
                   if memory else "off")
    print(f"SRE agent UI: http://localhost:{args.port}  (model {args.model}, worker {client.worker}, "
          f"namespaces {scope}, memory {remembering}, users {f'from {args.user_header}' if args.user_header else 'guest'})",
          flush=True)
    try:
        uvicorn.run(app, host=args.host, port=args.port, log_level="info")
    finally:
        flush_traces()
        store.close()


if __name__ == "__main__":
    main()
