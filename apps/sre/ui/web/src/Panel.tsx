// Copyright 2026 openai-agent-microsandbox contributors
// SPDX-License-Identifier: Apache-2.0
//
// The side panel, after Artifacts: one thing at a time, named in its header. The findings are the agent's
// document, and each turn that rewrote them is a version, "written after" that turn's question. The title's
// menu reaches everything else: the outputs, each read the worker recorded (by its command and turn), the
// team's runbooks and a turn's trace; an open read has a readable title ("Pods in payments") over its
// command. Rendered or Source, Copy (the findings as Markdown, for an incident channel) and Download act on
// what is open; on a phone they share one menu. Selecting text offers Ask about this, which puts the quote
// and where it came from in the composer, to finish and send. File bodies are drawn by the page's own views
// (../static), which build DOM from text and never parse HTML.

import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { el } from "../../static/dom.js";
import { findQuote, renderCode, renderText } from "../../static/render.js";
import { renderFile as renderSreFile } from "../../static/sre.js";
import { renderTrace } from "../../static/trace.js";

import type { Config, TurnFile, TurnRecord } from "./api";
import { Copy, FINDINGS, findingsMarkdown, findingsUrl, FindingsView, loadFindings, plural, type Finding } from "./Findings";
import { readTitle } from "./reads";
import { fixRequest, sourcesAsOf, TurnContext } from "./Turn";

type File = TurnFile & { turn?: number; start?: boolean };
export type View = { tab: "files" | "trace"; turn?: number; path?: string; highlight?: string | null };

const TITLES: Record<string, string> = { [FINDINGS]: "Findings", "output/findings.md": "Report" };
const nameOf = (path: string) => path.split("/").pop() || path;
const titleOf = (path: string, file?: File) => (file?.evidence ? readTitle(file.command) : "") || TITLES[path] || nameOf(path);
const short = (text: string, limit = 60) => (text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text);
const fileUrl = (threadId: string, turn: number, path: string) =>
  `/api/threads/${encodeURIComponent(threadId)}/turns/${turn}/files/${path.split("/").map(encodeURIComponent).join("/")}`;
const startUrl = (path: string) => `/api/starting-files/${path.split("/").map(encodeURIComponent).join("/")}`;

const Icon = ({ path, size = 18 }: { path: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"
    strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>
);

// A <details> menu that closes when something in it is chosen, on a click elsewhere, or on Escape.
function Menu({ summary, label, className = "", children }: { summary: ReactNode; label: string; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: Event) => {
      const menu = ref.current;
      if (!menu?.open) return;
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !menu.contains(event.target as Node)) menu.open = false;
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("click", close); document.removeEventListener("keydown", close); };
  }, []);
  return (
    <details className={`popover-host ${className}`} ref={ref} onClick={(event) => {
      if ((event.target as HTMLElement).closest("[role=menuitem]") && ref.current) ref.current.open = false;
    }}>
      <summary aria-label={label}>{summary}</summary>
      <div className="popover ax-menu" role="menu" aria-label={label}>{children}</div>
    </details>
  );
}

export function Panel({ threadId, turns, config, view, setView, onClose }: {
  threadId: string | null; turns: TurnRecord[]; config: Config; view: View; setView: (view: View) => void; onClose: () => void;
}) {
  const { questions, ask, send } = useContext(TurnContext);
  const starting: File[] = useMemo(() => ((config.starting_files as File[]) || []).map((file) => ({ ...file, start: true })), [config]);
  // Every file the conversation has, with the turns that wrote it: an output's versions, the turn of a read.
  const catalog = useMemo(() => {
    const map = new Map<string, { file: File; versions: number[] }>();
    for (const turn of turns) {
      for (const file of turn.files || []) {
        const known = map.get(file.path);
        if (known && !file.changed) continue;
        map.set(file.path, { file: { ...known?.file, ...file, turn: turn.number }, versions: [...(known?.versions || []), turn.number] });
      }
    }
    return map;
  }, [turns]);
  const all = [...catalog.values()];
  const outputs = all.filter(({ file }) => file.path.startsWith("output/"))
    .sort((a, b) => (a.file.path === FINDINGS ? -1 : b.file.path === FINDINGS ? 1 : a.file.path.localeCompare(b.file.path)));
  const reads = all.filter(({ file }) => file.evidence).sort((a, b) => a.file.path.localeCompare(b.file.path));
  const others = all.filter(({ file }) => !file.evidence && !file.path.startsWith("output/"));
  const latest = turns.at(-1)?.number;

  // What is open: the trace of a turn, or a file at a version (the one the view asks for, else the latest before it).
  const trace = view.tab === "trace";
  const known = (path?: string) => Boolean(path && (catalog.has(path) || starting.some((file) => file.path === path)));
  const path = trace ? null : known(view.path) ? view.path!
    : catalog.has(FINDINGS) ? FINDINGS : reads[0]?.file.path || outputs[0]?.file.path || starting[0]?.path || null;
  const entry = path ? catalog.get(path) : undefined;
  const start = path && !entry ? starting.find((file) => file.path === path) : undefined;
  const versions = entry?.versions || [];
  const shown = versions.length ? ([...versions].reverse().find((turn) => view.turn === undefined || turn <= view.turn) ?? versions[0]) : undefined;
  const traceTurn = view.turn ?? latest;
  const file: File | null = entry ? { ...entry.file, turn: shown } : start || null;
  const version = shown !== undefined ? versions.indexOf(shown) + 1 : 0;
  const url = threadId && entry && shown !== undefined ? fileUrl(threadId, shown, entry.file.path) : start ? startUrl(start.path) : null;
  const record = shown !== undefined ? turns.find((turn) => turn.number === shown) : undefined;
  const sources = useMemo(() => sourcesAsOf(turns, shown ?? latest ?? 0), [turns, shown, latest]);

  const [source, setSource] = useState(false);
  useEffect(() => setSource(false), [path]);
  const findingsOpen = !trace && path === FINDINGS && !source && Boolean(threadId) && shown !== undefined;
  const [findings, setFindings] = useState<Finding[] | null | undefined>(undefined);
  useEffect(() => {
    if (!findingsOpen || !threadId || shown === undefined) return;
    let live = true;
    setFindings(undefined);
    loadFindings(findingsUrl(threadId, shown)).then((list) => { if (live) setFindings(list); });
    return () => { live = false; };
  }, [findingsOpen, threadId, shown]);

  // The header: a readable title, and under it where the thing came from.
  const [traceSub, setTraceSub] = useState("");
  const question = shown !== undefined ? questions.get(shown) : undefined;
  const title = trace ? `Trace of turn ${traceTurn ?? ""}` : file ? titleOf(file.path, file) : "Nothing to show yet";
  const sub = trace ? traceSub
    : file?.evidence ? `${file.command || file.path} · turn ${shown}`
      : file?.start ? `${file.path} · the team's runbook, in every new workspace`
        : file ? `Version ${version} of ${versions.length}${question ? `, written after “${short(question)}”` : ""}` : "";

  // The body: the findings as a view of their own, everything else drawn into this element by ../static.
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = body.current;
    if (!target || findingsOpen) return;
    const key = `${threadId}:${trace ? `trace:${traceTurn}` : `${path}@${shown}`}:${source}:${view.highlight || ""}`;
    target.dataset.view = key;
    const isCurrent = () => target.dataset.view === key;
    target.className = "ax-panel-content";
    if (trace) {
      const turn = turns.find((item) => item.number === traceTurn);
      if (!turn || !threadId) {
        target.replaceChildren(el("div", { class: "empty" }, el("p", {}, "A turn's trace shows here.")));
        return;
      }
      const draw = () => renderTrace({ threadId, turn, body: target, config, isCurrent, onLive: draw,
        setHead: (_title: string, detail: string) => isCurrent() && setTraceSub(detail) });
      draw();
      return;
    }
    if (!file || !url) {
      target.replaceChildren(el("div", { class: "empty" }, el("h3", {}, "Findings appear here"),
        el("p", {}, "The findings the agent writes, and every read they rest on.")));
      return;
    }
    if (file.too_large) {
      target.replaceChildren(el("p", { class: "note" }, "Over the transfer limit, so it was not copied."));
      return;
    }
    (async () => {
      if (!source && await renderSreFile({ file, body: target, url, highlight: view.highlight })) return;
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
      } else if (source) {
        nodes.push(renderCode(text));
      } else {
        nodes.push(renderText(nameOf(file.path), text).node);
      }
      target.replaceChildren(...nodes);
    })();
  }, [threadId, trace, traceTurn, path, shown, source, view.highlight, findingsOpen, url, config, turns]);

  // Select to ask: a selection in the body offers to ask about it, naming where it came from.
  const wrapper = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<{ text: string; line?: string; top: number; left: number } | null>(null);
  useEffect(() => setPicked(null), [path, shown, trace, source]);
  const pick = () => {
    const box = wrapper.current;
    const selection = window.getSelection();
    const text = selection?.toString().trim() || "";
    if (!box || !selection || !text || !selection.rangeCount || !box.contains(selection.anchorNode)) { setPicked(null); return; }
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const frame = box.getBoundingClientRect();
    const node = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement;
    const row = node?.closest(".line, .sre-log-line");
    const line = row?.querySelector(".sre-gutter, span:first-child")?.textContent?.trim() || undefined;
    setPicked({ text: text.slice(0, 1200), line, top: Math.max(rect.top - frame.top + box.scrollTop - 44, box.scrollTop + 4),
      left: Math.min(Math.max(rect.left - frame.left, 8), frame.width - 230) });
  };
  const askAbout = () => {
    if (!picked) return;
    const where = trace ? "" : file?.evidence ? `, from ${file.command}` : version ? ` (version ${version})` : "";
    ask(`About ${picked.line ? `line ${picked.line} of ` : ""}${title}${where}:\n“${picked.text}”\n\n`);
    window.getSelection()?.removeAllRanges();
    setPicked(null);
  };

  const copyText = async () => {
    if (path === FINDINGS && !source && findings) {
      return findingsMarkdown(findings, record?.check, `version ${version} of ${versions.length}`, sources);
    }
    const response = url ? await fetch(url) : null;
    if (!response?.ok) throw new Error("not loaded");
    return response.text();
  };
  const copyLabel = path === FINDINGS && !source ? "Copy as Markdown" : "Copy";
  const canSwitch = !trace && Boolean(file) && !file?.too_large;
  const step = (offset: number) => {
    const turn = versions[version - 1 + offset];
    if (turn !== undefined && path) setView({ tab: "files", path, turn });
  };
  const item = (target: View, label: ReactNode, detail: ReactNode, current: boolean, key: string) => (
    <button key={key} type="button" role="menuitem" aria-current={current ? "true" : undefined} onClick={() => setView(target)}
      title={typeof label === "string" ? label : undefined}>
      <span className="ax-menu-label">{label}</span><span className="ax-menu-detail">{detail}</span>
    </button>
  );

  return (
    <section className="side-panel ax-panel" aria-label={title}>
      <div className="ax-panel-head">
        <Menu className="ax-title-menu" label="Open something else" summary={<><h2>{title}</h2><Icon path="m6 9 6 6 6-6" size={16} /></>}>
          {outputs.length ? <p className="ax-menu-group">Outputs</p> : null}
          {outputs.map(({ file: out, versions: written }) => item({ tab: "files", path: out.path }, TITLES[out.path] || nameOf(out.path),
            `version ${written.length}`, !trace && path === out.path, out.path))}
          {reads.length ? <p className="ax-menu-group">Evidence, {plural(reads.length, "read")}</p> : null}
          {reads.map(({ file: read, versions: written }) => item({ tab: "files", path: read.path }, <code title={read.command}>{read.command || nameOf(read.path)}</code>,
            `turn ${written[0]}`, !trace && path === read.path, read.path))}
          {starting.length ? <p className="ax-menu-group">Runbooks</p> : null}
          {starting.map((runbook) => item({ tab: "files", path: runbook.path }, nameOf(runbook.path), "", !trace && path === runbook.path, runbook.path))}
          {others.length ? <p className="ax-menu-group">Other files</p> : null}
          {others.map(({ file: other, versions: written }) => item({ tab: "files", path: other.path, turn: written.at(-1) }, other.path,
            `turn ${written.at(-1)}`, !trace && path === other.path, other.path))}
          {latest !== undefined ? <p className="ax-menu-group">Trace</p> : null}
          {latest !== undefined ? item({ tab: "trace", turn: shown ?? latest }, `Trace of turn ${shown ?? latest}`, "time, model calls, tokens",
            trace, "trace") : null}
        </Menu>
        {!trace && entry && !file?.evidence ? (
          <div className="ax-versions" role="group" aria-label="Versions">
            <button type="button" className="icon-button" aria-label="Previous version" disabled={version <= 1} onClick={() => step(-1)}>
              <Icon path="m15 18-6-6 6-6" /></button>
            <button type="button" className="icon-button" aria-label="Next version" disabled={version >= versions.length} onClick={() => step(1)}>
              <Icon path="m9 18 6-6-6-6" /></button>
          </div>
        ) : null}
        <div className="ax-panel-actions ax-wide-only">
          {canSwitch ? (
            <div className="segmented" role="group" aria-label="View">
              <button type="button" aria-pressed={!source} onClick={() => setSource(false)}>Rendered</button>
              <button type="button" aria-pressed={source} onClick={() => setSource(true)}>Source</button>
            </div>
          ) : null}
          {canSwitch ? <Copy key={`${path}:${copyLabel}`} text={copyText} label={copyLabel} /> : null}
          {canSwitch && url ? <a className="icon-button" href={`${url}?download=1`} aria-label="Download"><Icon path="M12 4v12M7 11l5 5 5-5M5 20h14" /></a> : null}
        </div>
        {canSwitch ? (
          <Menu className="ax-narrow-only" label="More" summary={<span className="icon-button"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg></span>}>
            <button type="button" role="menuitem" onClick={() => setSource(!source)}>{source ? "Rendered" : "Source"}</button>
            <button type="button" role="menuitem" onClick={async () => { try { await navigator.clipboard.writeText(await copyText()); } catch { /* not allowed */ } }}>{copyLabel}</button>
            {url ? <a role="menuitem" href={`${url}?download=1`}>Download</a> : null}
          </Menu>
        ) : null}
        <button type="button" className="icon-button" aria-label="Close the panel" onClick={onClose}><Icon path="M6 6l12 12M18 6 6 18" /></button>
        {sub ? <p className="ax-panel-sub">{sub}</p> : null}
      </div>
      <div className="artifact-body ax-panel-body" ref={wrapper} onMouseUp={pick} onKeyUp={pick}
        onMouseDown={(event) => { if (!(event.target as HTMLElement).closest(".ax-ask")) setPicked(null); }}>
        {findingsOpen ? (findings === undefined ? <p className="empty">Loading…</p>
          : findings ? <FindingsView findings={findings} check={record?.check} first={record?.check_first} sources={sources}
            onQuote={(where, quote) => setView({ tab: "files", path: where, highlight: quote })}
            onFix={() => send(fixRequest(record?.check, sources))} />
            : <p className="note err">The findings could not be read. Source shows the file as the agent wrote it.</p>) : null}
        <div ref={body} hidden={findingsOpen} />
        {picked ? (
          <div className="ax-ask" style={{ top: picked.top, left: picked.left }} role="toolbar" aria-label="Selection">
            <button type="button" className="ax-button primary" onClick={askAbout}>Ask about this</button>
            <Copy text={picked.text} />
          </div>
        ) : null}
      </div>
    </section>
  );
}
