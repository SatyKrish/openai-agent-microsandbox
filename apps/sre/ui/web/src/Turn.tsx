// Copyright 2026 openai-agent-mxc contributors
// SPDX-License-Identifier: Apache-2.0
//
// One turn of the agent, verdict first. While it runs, its steps show as they happen. After, its answer
// comes first with what the host check found, then a card per finding: the workload and its state now,
// the cause, and the fix as steps to copy and run. How the agent got there (its steps and what it said
// along the way) folds to one line under them. A quote opens its evidence in the side panel. Everything
// from the cluster or the model is rendered as text, never as HTML.

import { createContext, useContext, useEffect, useRef, useState } from "react";

import { workloadKey, type Check, type Entry, type QuoteResult, type TurnFile, type TurnRecord, type Workload } from "./api";
import type { TurnPartData } from "./conversation";
import type { View } from "./Panel";
import { CardPart, Prose, StepsPart } from "./parts";

export type TurnContextValue = {
  threadId: string | null; turns: TurnRecord[]; workloads: Map<string, Workload>; open: (view: View) => void;
};
export const TurnContext = createContext<TurnContextValue>({ threadId: null, turns: [], workloads: new Map(), open: () => {} });

type Fix = { summary?: string; precheck?: unknown; commands?: unknown; verify?: unknown; rollback?: unknown; risk?: string };
type Finding = {
  resource?: string; namespace?: string; problem?: string; cause?: string; ruled_out?: unknown;
  fix?: Fix | string; evidence?: { file?: string; quote?: string }[];
};

const FINDINGS = "output/findings.json";
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const clock = (iso?: string) => {
  const when = iso ? new Date(iso) : null;
  return when && !Number.isNaN(when.getTime()) ? when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
};

// A turn's findings never change once written, so each is fetched once; a failed fetch is tried again later.
const fetched = new Map<string, Promise<Finding[] | null>>();
function loadFindings(url: string): Promise<Finding[] | null> {
  let pending = fetched.get(url);
  if (!pending) {
    pending = fetch(url).then((response) => (response.ok ? response.json() : null))
      .then((body) => (Array.isArray(body?.findings) ? body.findings as Finding[] : null), () => null)
      .then((findings) => { if (!findings) fetched.delete(url); return findings; });
    fetched.set(url, pending);
  }
  return pending;
}

function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [shown, setShown] = useState(label);
  return (
    <button type="button" className="ax-copy" onClick={async () => {
      try { await navigator.clipboard.writeText(text); setShown("Copied"); } catch { setShown("Select and copy"); }
      setTimeout(() => setShown(label), 1500);
    }}>{shown}</button>
  );
}

function Chevron() {
  return (
    <span aria-hidden="true" className="ax-chevron">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
    </span>
  );
}

/* ---------- The fix ---------- */

const STEPS: [keyof Fix, string][] = [["precheck", "Check first"], ["commands", "Run"], ["verify", "Verify"], ["rollback", "Undo"]];
// A line that starts with a lowercase word (kubectl, helm, git…) is a command; the agent writes advice as sentences.
const isCommand = (line: string) => /^(\$\s*)?[a-z]/.test(line.trim());
const linesOf = (value: unknown) => (Array.isArray(value) ? value : value ? [value] : []).map(String).filter((line) => line.trim());

function FixSteps({ fix }: { fix?: Fix | string }) {
  if (!fix) return null;
  if (typeof fix !== "object") {
    return <section className="ax-fix"><h4>Fix</h4><p className="ax-fix-summary">{String(fix)}</p></section>;
  }
  const steps = STEPS.map(([key, label]) => ({ key, label, lines: linesOf(fix[key]) })).filter((step) => step.lines.length);
  const runs = linesOf(fix.commands).some(isCommand);
  return (
    <section className="ax-fix">
      <h4>Fix</h4>
      {fix.summary ? <p className="ax-fix-summary">{String(fix.summary)}</p> : null}
      {steps.length ? (
        <ol className="ax-fix-steps">
          {steps.map(({ key, label, lines }) => {
            const commands = lines.filter(isCommand);
            return (
              <li key={key} className={`ax-fix-step ${key}`}>
                <div className="ax-fix-label"><span>{label}</span>{commands.length ? <Copy text={commands.join("\n")} /> : null}</div>
                {commands.length ? <pre>{commands.join("\n")}</pre> : null}
                {lines.filter((line) => !isCommand(line)).map((line, index) => <p key={index}>{line}</p>)}
              </li>
            );
          })}
        </ol>
      ) : null}
      {!runs ? <p className="ax-fix-note">No command to run: the change is described above, for whoever owns the manifest.</p> : null}
      {fix.risk ? <p className="ax-fix-risk"><strong>Risk</strong> {String(fix.risk)}</p> : null}
    </section>
  );
}

/* ---------- A finding ---------- */

// The check shortens long quotes and ends them with an ellipsis; a result matches the quote it starts.
const resultFor = (results: QuoteResult[] | undefined, item: { file?: string; quote?: string }) => results?.find((quote) =>
  quote.file === item.file && String(item.quote || "").startsWith(String(quote.quote || "").replace(/…$/, "")));

function FindingCard({ finding, turn, result, sources }: {
  finding: Finding; turn: number; result?: { verified: boolean; quotes: QuoteResult[] };
  sources: Map<string, TurnFile>;
}) {
  const { workloads, open } = useContext(TurnContext);
  const [kind, name] = String(finding.resource || "").split("/");
  const live = kind && name && finding.namespace ? workloads.get(workloadKey(finding.namespace, kind, name)) : undefined;
  const evidence = Array.isArray(finding.evidence) ? finding.evidence : [];
  const ruledOut = linesOf(finding.ruled_out);
  const unverified = result?.verified === false;
  const missing = evidence.filter((item) => resultFor(result?.quotes, item)?.found === false).length;
  return (
    <article className={`ax-finding ${live?.state || "unknown"}`}>
      <header className="ax-finding-head">
        <div className="ax-finding-title">
          <h3>{String(finding.problem || "Finding")}</h3>
          <p className="ax-finding-resource"><code>{finding.resource || "resource"}</code>
            {finding.namespace ? <span> in {finding.namespace}</span> : null}</p>
        </div>
        <div className="ax-finding-badges">
          {unverified ? <span className="ax-badge danger">Unverified</span> : null}
          {live ? (
            <span className={`ax-live ${live.state}`} title="As the worker reads it now">
              <span className={`ax-dot ${live.state}`} aria-hidden="true" />{live.state} now · {live.ready}/{live.desired} ready
            </span>
          ) : null}
        </div>
      </header>
      {finding.cause ? <p className="ax-finding-cause">{finding.cause}</p> : null}
      <FixSteps fix={finding.fix} />
      {evidence.length ? (
        <details className="ax-finding-more" open={unverified}>
          <summary><Chevron />Evidence <span className="ax-muted">{plural(evidence.length, "quote")}
            {missing ? `, ${missing} not found` : ""}</span></summary>
          <ul className="ax-quotes">
            {evidence.map((item, index) => {
              const outcome = resultFor(result?.quotes, item);
              const source = item.file ? sources.get(item.file) : undefined;
              const read = clock(outcome?.recorded_at || source?.recorded_at);
              return (
                <li key={index} className={outcome && !outcome.found ? "missing" : ""}>
                  <button type="button" className="ax-quote" disabled={!item.file} title={item.file}
                    onClick={() => item.file && open({ tab: "files", turn, path: item.file, highlight: item.quote || null })}>
                    <blockquote>{item.quote}</blockquote>
                    <span className="ax-quote-source">
                      {outcome && !outcome.found ? <strong>{outcome.reason === "not in the file" ? "Not in this read: "
                        : `Not checked (${outcome.reason}): `}</strong> : null}
                      <code>{source?.command || String(item.file || "").replace(/^evidence\//, "")}</code>
                      {read ? <span> · read {read}</span> : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
      {ruledOut.length ? (
        <details className="ax-finding-more">
          <summary><Chevron />Ruled out <span className="ax-muted">{ruledOut.length}</span></summary>
          <ul className="ax-ruled">{ruledOut.map((item, index) => <li key={index}>{item}</li>)}</ul>
        </details>
      ) : null}
    </article>
  );
}

function Findings({ threadId, record, sources }: { threadId: string; record: TurnRecord; sources: Map<string, TurnFile> }) {
  const url = `/api/threads/${encodeURIComponent(threadId)}/turns/${record.number}/files/${FINDINGS}`;
  const [findings, setFindings] = useState<Finding[] | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    loadFindings(url).then((list) => { if (live) setFindings(list); });
    return () => { live = false; };
  }, [url]);
  if (findings === undefined) return <p className="ax-muted ax-findings-loading">Loading the findings…</p>;
  if (!findings) return <p className="ax-muted">The findings could not be read.</p>;
  const results = new Map((record.check?.results || []).map((result) => [result.index, result]));
  return (
    <div className="ax-findings">
      {findings.map((finding, index) => <FindingCard key={index} finding={finding} turn={record.number}
        result={results.get(index)} sources={sources} />)}
    </div>
  );
}

/* ---------- The verdict and how the agent got there ---------- */

// What the host check found, in one line above the answer: it finds the quotes, the causes are the agent's.
function CheckLine({ check, first, fresh, outputs }: { check?: Check | null; first?: Check | null; fresh: boolean; outputs: boolean }) {
  const lines = [];
  if (first) {
    lines.push(<p key="first" className="ax-check note">The first check failed ({first.detail || "a quote was not found"}); the agent
      re-read its sources and corrected the findings.</p>);
  }
  if (check?.status === "evidence_passed" && fresh) {
    lines.push(<p key="check" className="ax-check ok"><span className="ax-check-mark" aria-hidden="true">✓</span>
      <span><strong>Evidence checked.</strong> {check.quotes_total && check.quotes_total !== check.quotes
        ? `${check.quotes} of ${plural(check.quotes_total, "quote")}` : `All ${plural(check.quotes || 0, "quote")}`} found in what the
      worker read. The causes are the agent's reasoning from them.</span></p>);
  } else if (check?.status === "failed") {
    lines.push(<p key="check" className="ax-check err"><span className="ax-check-mark" aria-hidden="true">!</span>
      <span><strong>Evidence check failed.</strong> {check.detail || ""}</span></p>);
  } else if (outputs && !(check?.status === "evidence_passed")) {
    lines.push(<p key="check" className="ax-check warn"><span className="ax-check-mark" aria-hidden="true">?</span>
      <span>Not checked on the host.</span></p>);
  }
  return lines.length ? <>{lines}</> : null;
}

function HowIGotHere({ entries, record, threadId }: { entries: Entry[]; record: TurnRecord | null; threadId: string | null }) {
  const { open } = useContext(TurnContext);
  const [expanded, setExpanded] = useState(false);
  const steps = record?.tools?.length ?? entries.reduce((count, entry) => count + (entry.kind === "steps" ? entry.steps.length : 0), 0);
  const tokens = record?.usage?.total_tokens || 0;
  const facts = [steps ? plural(steps, "step") : "", record?.duration_s ? `${Math.round(record.duration_s)} s` : "",
    tokens ? `${tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : tokens} tokens` : ""].filter(Boolean).join(" · ");
  const evidence = (record?.files || []).filter((file) => file.evidence);
  const outputs = (record?.files || []).filter((file) => file.changed && file.path.startsWith("output/") && file.path !== FINDINGS
    && !file.too_large);
  if (!entries.length && !record) return null;
  return (
    <div className="ax-fold">
      <div className="ax-fold-row">
        <button type="button" className="ax-fold-head" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}
          disabled={!entries.length}>
          <Chevron />How I got here <span className="ax-muted">{facts}</span>
        </button>
        {record && threadId ? (
          <span className="ax-fold-links">
            {evidence.length ? <button type="button" onClick={() => open({ tab: "files", turn: record.number,
              path: evidence[0]!.path })}>Evidence ({evidence.length})</button> : null}
            {outputs.map((file) => <button key={file.path} type="button" onClick={() => open({ tab: "files", turn: record.number,
              path: file.path })}>{file.path.replace(/^output\//, "")}</button>)}
            {record.otel_trace_id ? <button type="button" onClick={() => open({ tab: "trace", turn: record.number })}>Trace</button> : null}
          </span>
        ) : null}
      </div>
      {expanded ? <div className="ax-fold-body"><Path entries={entries} /></div> : null}
    </div>
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

export function TurnPart({ data }: { data: TurnPartData }) {
  const { threadId, turns } = useContext(TurnContext);
  const record = turns.find((item) => item.number === data.turn) || null;
  const running = data.running || record?.status === "running" || (!record && !data.entries.some((entry) => entry.kind === "card"));
  // A turn that ends while watched scrolls to its verdict, which is above what the agent did last.
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
  // The answer is what the agent said after its last step; everything before it is how it got there.
  const last = data.entries.map((entry) => entry.kind).lastIndexOf("steps");
  const path = data.entries.slice(0, last + 1).filter((entry) => entry.kind !== "card");
  const answer = data.entries.slice(last + 1).filter((entry) => entry.kind === "assistant");
  const changed = new Set((record?.files || []).filter((file) => file.changed).map((file) => file.path));
  const fresh = changed.has(FINDINGS);
  // Where each evidence file came from: the read that produced it, in this turn or an earlier one.
  const sources = new Map<string, TurnFile>();
  for (const item of turns) {
    if (item.number > data.turn) break;
    for (const file of item.files || []) if (file.evidence) sources.set(file.path, file);
  }
  return (
    <div className={`ax-turn ${record?.status || ""}`} ref={top}>
      {record?.status === "stopped" ? <p className="ax-check note">Stopped.</p> : null}
      {record?.status === "failed" ? <p className="ax-check err"><span className="ax-check-mark" aria-hidden="true">!</span>
        <span><strong>The turn failed.</strong> {record.error || ""}</span></p> : null}
      {record ? <CheckLine check={record.check} first={record.check_first} fresh={fresh}
        outputs={[...changed].some((path) => path.startsWith("output/"))} /> : null}
      {answer.map((entry) => <div key={entry.id} className="ax-answer"><Prose text={(entry as { text: string }).text} /></div>)}
      {record && threadId && fresh && record.check?.status !== "no_findings"
        ? <Findings threadId={threadId} record={record} sources={sources} /> : null}
      {/* Before the harness's record of the turn loads, its card says what the check found. */}
      {!record ? data.entries.filter((entry) => entry.kind === "card")
        .map((entry) => <CardPart key={entry.id} data={(entry as { card: any }).card} />) : null}
      <HowIGotHere entries={path} record={record} threadId={threadId} />
    </div>
  );
}
