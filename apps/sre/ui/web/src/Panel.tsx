// Copyright 2026 openai-agent-mxc contributors
// SPDX-License-Identifier: Apache-2.0
//
// The side panel, opened from the conversation: a turn's evidence (each read the worker recorded) and its
// other files (outputs, the workspace's starting files), and its trace. File bodies are drawn by the
// page's own views (../static: log excerpts, kubectl tables, Markdown and code), which build DOM from
// text and never parse HTML. Findings are in the conversation, so findings.json shows as it was written.

import { useEffect, useMemo, useRef, useState } from "react";

import { el, formatBytes } from "../../static/dom.js";
import { findQuote, renderCode, renderText } from "../../static/render.js";
import { renderFile as renderSreFile } from "../../static/sre.js";
import { renderTrace } from "../../static/trace.js";

import type { Config } from "./api";

type File = { path: string; bytes?: number; turn?: number; changed?: boolean; evidence?: boolean; command?: string;
  recorded_at?: string; too_large?: boolean; start?: boolean; status?: { state: string; label: string } };
type Turn = { number: number; status: string; files: File[]; file_status?: Record<string, { state: string; label: string }>;
  otel_trace_id?: string };
export type View = { tab: "files" | "trace"; turn?: number; path?: string; highlight?: string | null };

const GROUPS: [string, string][] = [["evidence/", "Evidence"], ["output/", "Outputs"], ["inputs/", "Inputs"], ["work/", "Work"]];
const groupOf = (path: string) => GROUPS.findIndex(([prefix]) => path.startsWith(prefix));
const time = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");
// One empty list, so the start screen (no conversation yet) does not redraw, and refetch, on every render.
const NO_TURNS: Turn[] = [];

export function Panel({ threadId, thread, config, view, setView, onClose }: {
  threadId: string | null; thread: any; config: Config; view: View; setView: (view: View) => void; onClose: () => void;
}) {
  const turns: Turn[] = thread?.turns || NO_TURNS;
  const turn = turns.find((item) => item.number === view.turn) || turns.at(-1) || null;
  const starting: File[] = useMemo(() => ((config.starting_files as File[]) || []).map((file) => ({ ...file, start: true })), [config]);
  const files = useMemo(() => {
    const latest = new Map<string, File>();
    for (const file of starting) latest.set(file.path, file);
    for (const item of turns) {
      if (turn && item.number > turn.number) break;
      for (const file of item.files || []) latest.set(file.path, { ...file, turn: item.number, status: (item.file_status || {})[file.path] });
    }
    const order = (path: string) => { const group = groupOf(path); return group < 0 ? GROUPS.length : group; };
    return [...latest.values()].sort((a, b) => order(a.path) - order(b.path) || a.path.localeCompare(b.path));
  }, [starting, turns, turn]);
  // Opened without a file: the turn's first read, then its outputs.
  const preferred = () => (turn?.files || []).find((file) => file.evidence)?.path
    || (turn?.files || []).find((file) => file.changed && file.path.startsWith("output/") && !file.too_large)?.path || files[0]?.path;
  const path = view.path && files.some((file) => file.path === view.path) ? view.path : preferred();
  const file = files.find((item) => item.path === path) || null;
  const body = useRef<HTMLDivElement>(null);
  const [head, setHead] = useState<{ title: string; sub: string }>({ title: "", sub: "" });
  const [download, setDownload] = useState<string | null>(null);

  useEffect(() => {
    const target = body.current;
    if (!target) return;
    const key = `${threadId}:${turn?.number}:${view.tab}:${path}:${view.highlight || ""}`;
    target.dataset.view = key;
    const isCurrent = () => target.dataset.view === key;
    setDownload(null);
    target.className = "artifact-body";
    if (view.tab === "trace") {
      if (!turn || !threadId) {
        setHead({ title: "Trace", sub: "" });
        target.replaceChildren(el("div", { class: "empty" }, el("p", {}, "A turn's trace shows here.")));
        return;
      }
      const draw = () => renderTrace({ threadId, turn, body: target, config, isCurrent, onLive: draw,
        setHead: (title: string, sub: string) => isCurrent() && setHead({ title, sub }) });
      draw();
      return;
    }
    if (!file) {
      setHead({ title: "Files", sub: "" });
      target.replaceChildren(el("div", { class: "empty" }, el("h3", {}, "Files appear here"),
        el("p", {}, "The evidence the agent reads and the findings it writes.")));
      return;
    }
    const name = file.path.split("/").pop() || file.path;
    const read = file.recorded_at ? `read ${time(file.recorded_at)}` : "";
    setHead({ title: name, sub: [file.path, file.too_large ? "over the transfer limit" : formatBytes(file.bytes || 0), read,
      file.start ? "" : turn && file.turn === turn.number ? `turn ${file.turn}` : `from turn ${file.turn}`,
      file.status?.label || (file.start ? "starting file" : "")].filter(Boolean).join(" · ") });
    if (file.too_large) {
      target.replaceChildren(el("p", { class: "note" }, "Over the transfer limit, so it was not copied."));
      return;
    }
    const parts = file.path.split("/").map(encodeURIComponent).join("/");
    const url = file.start ? `/api/starting-files/${parts}`
      : `/api/threads/${encodeURIComponent(threadId || "")}/turns/${file.turn}/files/${parts}`;
    setDownload(`${url}?download=1`);
    (async () => {
      if (await renderSreFile({ file, body: target, url, highlight: view.highlight })) return;
      target.replaceChildren(el("div", { class: "empty" }, el("p", {}, "Loading…")));
      const response = await fetch(url);
      const text = response.ok ? await response.text() : "";
      if (!isCurrent()) return;
      const nodes: Node[] = [];
      if (!response.ok) {
        nodes.push(el("p", { class: "note err" }, "The file could not be loaded."));
      } else if (view.highlight) {
        const range = findQuote(text, view.highlight);
        if (!range) nodes.push(el("p", { class: "note err" }, "The quote is not in this copy of the file."));
        nodes.push(renderCode(text, range as any));
      } else {
        const rendered = renderText(name, text);
        if (rendered.document) target.className = "artifact-body document";
        nodes.push(rendered.node);
      }
      target.replaceChildren(...nodes);
    })();
  }, [threadId, turn, view.tab, view.highlight, path, file, config]);

  let group = "";
  return (
    <section className="side-panel" aria-label="Evidence and trace">
      <div className="panel-head">
        <div className="panel-tabs" role="tablist" aria-label="Panel views">
          <button type="button" role="tab" aria-selected={view.tab === "files"} onClick={() => setView({ ...view, tab: "files" })}>Evidence</button>
          {threadId ? <button type="button" role="tab" aria-selected={view.tab === "trace"} onClick={() => setView({ ...view, tab: "trace" })}>
            Trace{turn?.status === "running" ? <span className="live-dot" /> : null}</button> : null}
        </div>
        {turns.length > 1 ? (
          <select aria-label="Turn" value={turn?.number} onChange={(event) => setView({ ...view, turn: Number(event.target.value), path: undefined })}>
            {turns.map((item) => <option key={item.number} value={item.number}>Turn {item.number}{item.status === "running" ? " · running" : item.status === "failed" ? " · failed" : ""}</option>)}
          </select>
        ) : null}
        <button type="button" className="icon-button" aria-label="Collapse the panel" onClick={onClose}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </div>
      {view.tab === "files" && files.length ? (
        <div className="file-bar">
          {files.map((item) => {
            const label = groupOf(item.path) >= 0 ? GROUPS[groupOf(item.path)]![1] : "Other";
            const heading = label !== group ? <span className="file-group">{(group = label)}</span> : null;
            const earlier = turn && !item.start && item.turn !== turn.number;
            const name = item.evidence && item.command ? item.command : item.path.replace(/^(output|inputs|evidence|work)\//, "");
            return [heading, (
              <button key={item.path} type="button" className={`file-chip${earlier ? " earlier" : ""}`}
                aria-pressed={item.path === path} title={[item.path, item.status?.label, earlier ? `from turn ${item.turn}` : ""].filter(Boolean).join("\n")}
                onClick={() => setView({ tab: "files", turn: turn?.number, path: item.path })}>
                {item.status?.state === "failed" ? <span className="state-dot failed" aria-label="check failed" /> : null}
                <span className="file-chip-label">{name}</span>
              </button>
            )];
          })}
        </div>
      ) : null}
      <div className="artifact-head">
        <div className="artifact-title"><h2>{head.title}</h2><span className="mono muted">{head.sub}</span></div>
        {download ? <a className="icon-button" href={download} aria-label="Download this file">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v12" /><path d="m7 11 5 5 5-5" /><path d="M5 20h14" /></svg>
        </a> : null}
      </div>
      <div className="artifact-body" ref={body} />
    </section>
  );
}
