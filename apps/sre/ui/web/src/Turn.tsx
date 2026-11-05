// Copyright 2026 openai-agent-microsandbox contributors
// SPDX-License-Identifier: Apache-2.0
//
// One turn of the agent in the conversation, after Artifacts: the chat says what happened and the findings
// hold the detail. While the turn runs, its steps show as they happen. After, one line says how long it
// worked (it opens the steps and what the agent said along the way), then its short reply, then, when the
// turn wrote the findings, one card for them: their version, what each finding is about, what the host
// check found, and Open, which shows them in the side panel. A failed check names the quote and the read it
// cites, with Ask the agent to fix. Everything from the cluster or the model is rendered as text.

import { createContext, useContext, useEffect, useRef, useState } from "react";

import type { Check, Entry, TurnFile, TurnRecord, Workload } from "./api";
import type { TurnPartData } from "./conversation";
import { CheckIcon, FINDINGS, plural } from "./Findings";
import type { View } from "./Panel";
import { CardPart, Prose, StepsPart } from "./parts";

export type TurnContextValue = {
  threadId: string | null; turns: TurnRecord[]; workloads: Map<string, Workload>; questions: Map<number, string>;
  open: (view: View) => void; ask: (text: string) => void; send: (text: string) => void;
};
export const TurnContext = createContext<TurnContextValue>({
  threadId: null, turns: [], workloads: new Map(), questions: new Map(), open: () => {}, ask: () => {}, send: () => {},
});

/** The turns that wrote the findings, in order: each is a version. */
export const findingsVersions = (turns: TurnRecord[]) =>
  turns.filter((turn) => (turn.files || []).some((file) => file.path === FINDINGS && file.changed)).map((turn) => turn.number);

/** Where each evidence file came from, as of a turn: the read that produced it, in that turn or an earlier one. */
export function sourcesAsOf(turns: TurnRecord[], turn: number) {
  const sources = new Map<string, TurnFile>();
  for (const item of turns) {
    if (item.number > turn) break;
    for (const file of item.files || []) if (file.evidence) sources.set(file.path, file);
  }
  return sources;
}

/** The next message after a failed check: the quotes that were not found and the reads they cite. */
export function fixRequest(check: Check | null | undefined, sources: Map<string, TurnFile>) {
  const failures = (check?.failures || []).slice(0, 3).map((failure) => `“${failure.quote}” is not in `
    + `${(failure.file && sources.get(failure.file)?.command) || failure.file || "the read it cites"}`);
  return `The evidence check failed: ${failures.join("; ") || check?.detail || "a quote was not found"}. Re-read the reads you cite, `
    + "correct those quotes or the findings that rest on them, and write the findings again.";
}

function Chevron() {
  return (
    <span aria-hidden="true" className="ax-chevron">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
    </span>
  );
}

// What the agent did and said on the way: its step groups, each folded, and its narration between them.
function Path({ entries, streaming = [] }: { entries: Entry[]; streaming?: string[] }) {
  return (
    <>
      {entries.map((entry) => entry.kind === "steps" ? <StepsPart key={entry.id} data={entry} />
        : entry.kind === "assistant" ? <div key={entry.id} className="ax-narration"><Prose text={entry.text} /></div>
          : null)}
      {streaming.map((text, index) => <div key={`stream-${index}`} className="ax-narration"><Prose text={text} /></div>)}
    </>
  );
}

// "Worked for 42 s, 16 steps", which opens how the agent got to its reply.
function WorkedFor({ entries, record }: { entries: Entry[]; record: TurnRecord | null }) {
  const [open, setOpen] = useState(false);
  const steps = record?.tools?.length ?? entries.reduce((count, entry) => count + (entry.kind === "steps" ? entry.steps.length : 0), 0);
  const seconds = record?.duration_s ? Math.round(record.duration_s) : 0;
  const label = `Worked for ${seconds > 1 ? `${seconds} s` : "a moment"}${steps ? `, ${plural(steps, "step")}` : ""}`;
  return (
    <div className="ax-worked">
      <button type="button" className="ax-worked-head" aria-expanded={open} onClick={() => setOpen(!open)} disabled={!entries.length}>
        {label}<Chevron />
      </button>
      {open ? <div className="ax-worked-body"><Path entries={entries} /></div> : null}
    </div>
  );
}

// The card for the findings a turn wrote: like an artifact in a chat, it names its subject and opens it.
function FindingsCard({ record, version }: { record: TurnRecord; version: number }) {
  const { turns, open, send } = useContext(TurnContext);
  const check = record.check;
  const about = (check?.summary || []).map((item) => `${item.resource.split("/").pop()} · ${item.problem || "finding"}`).join(", ");
  const failed = check?.status === "failed";
  const total = check?.quotes_total ?? check?.quotes ?? 0;
  const failure = (check?.failures || [])[0];
  const sources = sourcesAsOf(turns, record.number);
  const show = () => open({ tab: "files", turn: record.number, path: FINDINGS });
  const tokens = record.usage?.total_tokens || 0;
  const caption = [`Turn ${record.number}`, record.duration_s ? `${Math.round(record.duration_s)} s` : "",
    record.tools?.length ? plural(record.tools.length, "step") : "", tokens ? `${tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : tokens} tokens` : ""]
    .filter(Boolean).join(" · ");
  return (
    <div className={`ax-findings-card${failed ? " failed" : ""}`}>
      <div className="ax-findings-card-head">
        <span className="ax-doc-icon" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" /></svg>
        </span>
        <button type="button" className="ax-findings-card-title" onClick={show}>
          <strong>{version > 1 ? `Findings, version ${version}` : "Findings"}</strong>
          <span className="ax-muted">{about || "Open to read them"}</span>
        </button>
        <button type="button" className="ax-button ax-open" onClick={show} aria-label="Open the findings">Open<span className="ax-narrow-only" aria-hidden="true">findings</span></button>
      </div>
      {failed ? (
        <div className="ax-card-check failed">
          <CheckIcon failed />
          <span><strong>Evidence check failed</strong>{failure ? <>. “{failure.quote}” is not in{" "}
            <button type="button" className="ax-link" onClick={() => failure.file && open({ tab: "files", turn: record.number, path: failure.file })}>
              {(failure.file && sources.get(failure.file)?.command) || failure.file}</button>.</> : check?.detail ? `: ${check.detail}` : null}</span>
          <button type="button" className="ax-button" onClick={() => send(fixRequest(check, sources))}>Ask the agent to fix</button>
        </div>
      ) : check?.status === "evidence_passed" ? (
        <div className="ax-card-check"><CheckIcon />{total && total === check.quotes ? `All ${plural(total, "quote")} found in the evidence`
          : `${plural(check.quotes || 0, "quote")} found in the evidence`}</div>
      ) : <div className="ax-card-check muted">Not checked against the evidence</div>}
      {record.check_first ? <p className="ax-card-note">Corrected after a failed first check.</p> : null}
      <span className="ax-card-caption">{caption}</span>
    </div>
  );
}

export function TurnPart({ data }: { data: TurnPartData }) {
  const { turns } = useContext(TurnContext);
  const record = turns.find((item) => item.number === data.turn) || null;
  const running = data.running || record?.status === "running" || (!record && !data.entries.some((entry) => entry.kind === "card"));
  // A turn that ends while watched scrolls to its reply, which is above what the agent did last.
  const top = useRef<HTMLDivElement>(null);
  const watched = useRef(false);
  useEffect(() => {
    if (running) watched.current = true;
    else if (watched.current) {
      watched.current = false;
      top.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }, [running]);
  if (running) {
    // Between groups of steps, while the model thinks, a line says the agent is still at it.
    const working = data.running && !data.streaming.length && !data.entries.some((entry) => entry.kind === "steps" && entry.open);
    return (
      <div className="ax-turn running" ref={top}>
        <Path entries={data.entries} streaming={data.streaming} />
        {working ? <p className="ax-working"><span className="ax-spin" aria-hidden="true" />Working…</p> : null}
      </div>
    );
  }
  // The reply is what the agent said after its last step; everything before it is how it got there.
  const last = data.entries.map((entry) => entry.kind).lastIndexOf("steps");
  const path = data.entries.slice(0, last + 1).filter((entry) => entry.kind !== "card");
  const reply = data.entries.slice(last + 1).filter((entry) => entry.kind === "assistant");
  const version = record ? findingsVersions(turns).indexOf(record.number) + 1 : 0;
  return (
    <div className={`ax-turn ${record?.status || ""}`} ref={top}>
      <WorkedFor entries={path} record={record} />
      {record?.status === "stopped" ? <p className="ax-turn-status">Stopped.</p> : null}
      {record?.status === "failed" ? <p className="ax-turn-status err">The turn failed. {record.error || ""}</p> : null}
      {reply.map((entry) => <div key={entry.id} className="ax-reply"><Prose text={(entry as { text: string }).text} /></div>)}
      {record && version ? <FindingsCard record={record} version={version} /> : null}
      {/* Before the harness's record of the turn loads, its card says what the check found. */}
      {!record ? data.entries.filter((entry) => entry.kind === "card")
        .map((entry) => <CardPart key={entry.id} data={(entry as { card: any }).card} />) : null}
    </div>
  );
}
