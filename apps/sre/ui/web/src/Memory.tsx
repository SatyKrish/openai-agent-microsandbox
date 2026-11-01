// Copyright 2026 openai-agent-mxc contributors
// SPDX-License-Identifier: Apache-2.0
//
// What the agent remembers across this user's conversations, laid out like the conversation list:
// one entry per remembered conversation, grouped by day. Open it, forget it, or forget everything.

import { useEffect, useState } from "react";

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

export function MemoryView({ idleMinutes, onOpen, onCorrect, onClose }: {
  idleMinutes: number; onOpen: (id: string) => void; onCorrect: () => void; onClose: () => void;
}) {
  const [memory, setMemory] = useState<Memory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => fetch("/api/memory?detail=1").then((response) => (response.ok ? response.json() : Promise.reject()))
    .then(setMemory, () => setError("Memory is unavailable right now."));
  useEffect(() => { load(); }, []);

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
    <section className="memory-view" aria-labelledby="memory-title">
      <header className="memory-view-head">
        <button type="button" className="icon-button" aria-label="Back to the conversation" onClick={onClose}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></svg>
        </button>
        <h2 id="memory-title">Memory</h2>
        <span className="memory-whose" title={memory?.shared ? "Everyone who isn't signed in shares this memory." : ""}>
          {memory ? (memory.shared ? "Guest" : memory.user) : ""}</span>
      </header>
      <div className="memory-body">
        {error ? <p className="memory-error">{error}</p> : null}
        {memory && !memory.remembered.length ? (
          <p className="memory-empty">Nothing remembered yet. A conversation is remembered once it has been idle for {idleMinutes} minute{idleMinutes === 1 ? "" : "s"}.</p>
        ) : null}
        {[...groups].map(([group, items]) => (
          <div key={group}>
            <div className="memory-group">{group}</div>
            <ul className="memory-list">
              {items.map((item) => (
                <li key={item.id} className="memory-entry">
                  <button type="button" className="memory-open" disabled={!item.open} onClick={() => onOpen(item.id)}
                    title={`${item.description || item.id}\n${new Date(item.updated_at).toLocaleString()}${item.open ? "" : "\nThis conversation is no longer here."}`}>
                    {item.description || item.id}
                  </button>
                  <button type="button" className="link-button danger memory-forget" aria-label="Forget this conversation"
                    onClick={() => forget(item)}>Forget</button>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {memory && memory.remembered.length ? (
          <div className="memory-more">
            {memory.text ? <details className="memory-section"><summary>Summary the agent starts with</summary><pre>{memory.text}</pre></details> : null}
            {memory.index ? <details className="memory-section"><summary>Everything it remembers (MEMORY.md)</summary><pre>{memory.index}</pre></details> : null}
            <div className="memory-actions">
              <button type="button" className="link-button" onClick={onCorrect}
                title="Tell the agent in a new conversation; it is remembered when that conversation goes idle.">Correct something</button>
              <button type="button" className="link-button danger" onClick={() => forget(null)}>Forget everything…</button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
