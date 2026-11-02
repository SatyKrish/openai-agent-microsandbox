// Copyright 2026 openai-agent-mxc contributors
// SPDX-License-Identifier: Apache-2.0
//
// What the agent remembers across this user's conversations, in the left column beside History and laid
// out like it: one entry per remembered conversation, grouped by day. Open it, forget it, or forget everything.

import { useCallback, useEffect, useState } from "react";

type Remembered = { id: string; description?: string; updated_at: string; open: boolean };
type Memory = { user: string; shared: boolean; remembered: Remembered[]; text?: string; index?: string };

function dayGroup(when: Date): string {
  const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((day(new Date()) - day(when)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  if (days < 30) return "Previous 30 days";
  return when.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export function MemoryList({ idleMinutes, current, onOpen, onCorrect }: {
  idleMinutes: number; current: string | null; onOpen: (id: string) => void; onCorrect: () => void;
}) {
  const [memory, setMemory] = useState<Memory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => fetch("/api/memory?detail=1").then((response) => (response.ok ? response.json() : Promise.reject()))
    .then((body) => { setMemory(body); setError(null); }, () => setError("Memory is unavailable right now.")), []);
  // A conversation is remembered once its session closes, so the list catches up while it is shown.
  useEffect(() => {
    load();
    const timer = setInterval(() => { if (!document.hidden) load(); }, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const forget = async (item: Remembered | null) => {
    const what = item ? `"${item.description || item.id}" is removed from memory now; what the summary drew from it goes the `
      + "next time memory is updated. The conversation itself stays." : "Everything in this memory is removed now. Your conversations stay.";
    const shared = memory?.shared ? "\n\nEveryone who isn't signed in shares this memory." : "";
    if (!window.confirm(`${item ? "Forget this conversation?" : "Forget everything?"}\n\n${what}${shared}`)) return;
    const url = item ? `/api/memory/conversations/${encodeURIComponent(item.id)}` : "/api/memory";
    const response = await fetch(url, { method: "DELETE" }).catch(() => null);
    if (!response?.ok && response?.status !== 404) setError("Memory could not be changed. The server log has the cause.");
    load();
  };

  const groups = new Map<string, Remembered[]>();
  for (const item of memory?.remembered || []) {
    const group = dayGroup(new Date(item.updated_at));
    groups.set(group, [...(groups.get(group) || []), item]);
  }
  return (
    <div className="ax-memory" role="tabpanel" aria-label="Memory">
      {memory ? <p className="ax-memory-whose">{memory.shared ? "Guest: shared by everyone who isn't signed in" : memory.user}</p> : null}
      {error ? <p className="ax-list-empty err" role="alert">{error}</p> : null}
      {memory && !memory.remembered.length ? (
        <p className="ax-list-empty">Nothing remembered yet. A conversation is remembered once it has been idle for {idleMinutes} minute{idleMinutes === 1 ? "" : "s"}.</p>
      ) : null}
      {[...groups].map(([group, items]) => (
        <div key={group}>
          <h2 className="ax-list-head">{group}</h2>
          <ul className="ax-list">
            {items.map((item) => (
              <li key={item.id} className="ax-memory-entry">
                <button type="button" className="ax-conversation" disabled={!item.open} onClick={() => onOpen(item.id)}
                  aria-current={item.id === current ? "page" : undefined}
                  title={`${item.description || item.id}\n${new Date(item.updated_at).toLocaleString()}${item.open ? "" : "\nThis conversation is no longer here."}`}>
                  <span className="ax-conversation-title">{item.description || item.id}</span>
                </button>
                <button type="button" className="ax-forget" aria-label={`Forget ${item.description || item.id}`}
                  onClick={() => forget(item)}>Forget</button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {memory && memory.remembered.length ? (
        <div className="ax-memory-more">
          {memory.text ? <details><summary>Summary the agent starts with</summary><pre>{memory.text}</pre></details> : null}
          {memory.index ? <details><summary>Everything it remembers (MEMORY.md)</summary><pre>{memory.index}</pre></details> : null}
          <button type="button" className="link-button" onClick={onCorrect}
            title="Tell the agent in a new conversation; it is remembered when that conversation goes idle.">Correct something</button>
          <button type="button" className="link-button danger" onClick={() => forget(null)}>Forget everything…</button>
        </div>
      ) : null}
    </div>
  );
}
