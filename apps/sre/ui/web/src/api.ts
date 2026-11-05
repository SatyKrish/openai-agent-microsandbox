// Copyright 2026 openai-agent-microsandbox contributors
// SPDX-License-Identifier: Apache-2.0
//
// The harness's conversation API (harness/src/openai_harness/http.py) and the shapes it returns:
// conversations, their transcript entries and the events a conversation's turns publish.

export type Step = { title: string; icon?: string | null; detail?: string; status: "running" | "done" | "failed" };

export type Entry =
  | { id: string; kind: "user"; turn: number | null; at: string; seq?: number; text: string; requested_by?: string | null }
  | { id: string; kind: "assistant"; turn: number | null; at: string; seq?: number; text: string }
  | { id: string; kind: "steps"; turn: number | null; at: string; seq?: number; open: boolean; steps: Step[];
      duration_s?: number }
  | { id: string; kind: "card"; turn: number | null; at: string; seq?: number; card: CardNode };

export type CardNode = {
  type: string;
  children?: CardNode[];
  value?: string;
  label?: string;
  size?: string;
  color?: string;
  weight?: string;
  variant?: string;
  style?: string;
  onClickAction?: { type: string; payload?: Record<string, unknown> };
};

export type Issue = {
  fingerprint: string; namespace: string; kind: string; name: string; state: "open" | "recovered";
  opened_at: string; recovered_at?: string; reasons?: string[];
};

export type Conversation = {
  id: string; title: string | null; created_at: string; state: "running" | "elsewhere" | "idle" | "not created";
  shared: boolean; issue: Issue | null; turns: number;
};

// The worker's read of each workload (/api/health), as the health board and the findings show it.
export type Workload = {
  kind: string; name: string; state: "failing" | "degraded" | "healthy"; ready: number; desired: number; restarts: number;
  reasons: string[]; last_warning?: string; last_warning_at?: string; waiting_message?: string;
};
export type Health = { generated_at?: string; namespaces: { namespace: string; error?: string; workloads: Workload[] }[] };
export const workloadKey = (namespace: string, kind: string, name: string) => `${namespace}/${kind.toLowerCase()}/${name}`;

// A turn as the harness records it (/api/threads/ID): its files, the host's check of its findings and what it took.
export type TurnFile = { path: string; bytes?: number; changed?: boolean; evidence?: boolean; command?: string;
  recorded_at?: string; too_large?: boolean };
export type QuoteResult = { file?: string; quote?: string; found: boolean; reason?: string; recorded_at?: string };
export type Check = {
  status: "evidence_passed" | "failed" | "no_findings"; detail?: string; findings?: number; quotes?: number; quotes_total?: number;
  results?: { index: number; verified: boolean; quotes: QuoteResult[] }[];
  summary?: { resource: string; problem: string; verified?: boolean }[];
  failures?: { file?: string; quote?: string; reason: string }[];
};
export type TurnRecord = {
  number: number; status: string; files: TurnFile[]; check?: Check | null; check_first?: Check | null; tools?: unknown[];
  duration_s?: number; usage?: { total_tokens?: number }; otel_trace_id?: string; error?: string;
};

export type HarnessEvent =
  | { seq: number; type: "entry"; turn: number | null; entry: Entry }
  | { seq: number; type: "delta"; turn: number; id: string; delta: string }
  | { seq: number; type: "turn"; turn: number; status: "running" | "completed" | "failed" | "stopped" | "shown";
      messages: string[]; title?: string }
  | { seq: number; type: "effect"; turn: number; name: string; data: Record<string, unknown> }
  | { seq: number; type: "error"; turn?: number; messages?: string[]; message: string; retry: boolean };

export type Config = {
  name?: string; model?: string; namespaces?: string[]; greeting?: string; placeholder?: string;
  about?: string[]; follow_ups?: { label: string; prompt: string }[]; memory?: boolean; issues?: boolean;
  health?: boolean; worker?: boolean; memory_max_age_days?: number; idle_close_s?: number; tracing?: boolean;
  preferred_output?: string; [key: string]: unknown;
};

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers || {}) } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw Object.assign(new Error(body.error || `${response.status} ${response.statusText}`), { status: response.status });
  }
  return response.json() as Promise<T>;
}

export const api = {
  config: () => json<Config>("/api/config"),
  conversations: () => json<{ conversations: Conversation[] }>("/api/conversations").then((body) => body.conversations),
  conversation: (id: string) => json<Conversation & { entries: Entry[] }>(`/api/conversations/${encodeURIComponent(id)}`),
  start: (text: string) => json<{ id: string }>("/api/conversations", { method: "POST", body: JSON.stringify({ text }) }),
  send: (id: string, text: string) =>
    json(`/api/conversations/${encodeURIComponent(id)}/messages`, { method: "POST", body: JSON.stringify({ text }) }),
  stop: (id: string) => json(`/api/conversations/${encodeURIComponent(id)}/stop`, { method: "POST" }),
  rename: (id: string, title: string) =>
    json(`/api/conversations/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  remove: (id: string) => json(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }),
  thread: (id: string) => json<{ turns: TurnRecord[] }>(`/api/threads/${encodeURIComponent(id)}`),
  events: (id: string) => new EventSource(`/api/conversations/${encodeURIComponent(id)}/events`),
};
