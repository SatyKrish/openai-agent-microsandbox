// Copyright 2026 openai-agent-mxc contributors
// SPDX-License-Identifier: Apache-2.0
//
// One conversation as the page holds it: its transcript, kept current from the harness's event
// stream (entries added or changed, text as it streams, turns starting and ending), and the
// transcript as assistant-ui messages: a person's message, then what the agent did and said.

import type { ThreadMessageLike } from "@assistant-ui/react";
import { useCallback, useEffect, useRef, useState } from "react";

import { api, type Entry, type HarnessEvent } from "./api";

export type Hooks = {
  onTurnEnd?: (turn: number, status: string) => void;
  onEffect?: (name: string, data: Record<string, unknown>) => void;
  onTitle?: (title: string) => void;
  // The conversation is not there: deleted, or someone else's.
  onMissing?: (id: string) => void;
};

export function useConversation(id: string | null, hooks: Hooks) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [streaming, setStreaming] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const hooksRef = useRef(hooks);
  hooksRef.current = hooks;

  const upsert = useCallback((entry: Entry) => {
    setEntries((current) => {
      const index = current.findIndex((item) => item.id === entry.id);
      if (index < 0) return [...current, entry];
      const next = current.slice();
      next[index] = { ...current[index], ...entry };
      return next;
    });
  }, []);

  useEffect(() => {
    setEntries([]);
    setStreaming({});
    setRunning(false);
    setError(null);
    setLoaded(false);
    if (!id) return;
    let closed = false;
    // Follow first, then load: an entry that arrives in between is the same entry, replaced by id.
    const source = api.events(id);
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as HarnessEvent;
      if (event.type === "entry") {
        upsert(event.entry);
        if (event.entry.kind === "assistant") {
          setStreaming((current) => {
            const { [event.entry.id]: _done, ...rest } = current;
            return rest;
          });
        }
      } else if (event.type === "delta") {
        setStreaming((current) => ({ ...current, [event.id]: (current[event.id] || "") + event.delta }));
      } else if (event.type === "turn") {
        if (event.status === "running") {
          setRunning(true);
          setError(null);
          if (event.title) hooksRef.current.onTitle?.(event.title);
        } else if (event.status !== "completed") {
          setRunning(false);
          setStreaming({});
          hooksRef.current.onTurnEnd?.(event.turn, event.status);
        }
      } else if (event.type === "effect") {
        hooksRef.current.onEffect?.(event.name, event.data);
      } else if (event.type === "error") {
        setError(event.message);
        setRunning(false);
      }
    };
    api.conversation(id).then((body) => {
      if (closed) return;
      setEntries((current) => {
        const known = new Set(body.entries.map((entry) => entry.id));
        return [...body.entries, ...current.filter((entry) => !known.has(entry.id))];
      });
      setRunning(body.state === "running");
      setLoaded(true);
    }, (failure: Error & { status?: number }) => {
      if (closed) return;
      if (failure.status === 404) hooksRef.current.onMissing?.(id);
      else setError(failure.message);
    });
    return () => {
      closed = true;
      source.close();
    };
  }, [id, upsert]);

  return { entries, streaming, running, error, loaded, setError };
}

/** The transcript as assistant-ui messages: each person's message, then one message of what the agent did. */
export function toMessages(entries: Entry[], streaming: Record<string, string>, running: boolean): ThreadMessageLike[] {
  const messages: { role: "user" | "assistant"; id: string; createdAt: Date; content: any[] }[] = [];
  let current: (typeof messages)[number] | null = null;
  for (const entry of entries) {
    if (entry.kind === "user") {
      messages.push({ role: "user", id: entry.id, createdAt: new Date(entry.at), content: [{ type: "text", text: entry.text }] });
      current = null;
      continue;
    }
    if (!current) {
      current = { role: "assistant", id: entry.id, createdAt: new Date(entry.at), content: [] };
      messages.push(current);
    }
    if (entry.kind === "steps") current.content.push({ type: "data-steps", data: entry });
    else if (entry.kind === "assistant") current.content.push({ type: "text", text: entry.text });
    else if (entry.kind === "card") current.content.push({ type: "data-card", data: entry.card });
  }
  const pending = Object.entries(streaming).filter(([id]) => !entries.some((entry) => entry.id === id));
  if (pending.length) {
    if (!current) {
      current = { role: "assistant", id: `stream-${pending[0]![0]}`, createdAt: new Date(), content: [] };
      messages.push(current);
    }
    for (const [, text] of pending) current.content.push({ type: "text", text });
  }
  return messages.map((message, index) => ({
    ...message,
    ...(message.role === "assistant" ? { status: running && index === messages.length - 1 ? { type: "running" as const }
      : { type: "complete" as const, reason: "stop" as const } } : {}),
  }));
}
