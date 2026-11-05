// Copyright 2026 openai-agent-microsandbox contributors
// SPDX-License-Identifier: Apache-2.0
//
// The findings: the document the agent writes and each turn may rewrite, shown in the side panel. A line
// says what the host check found; then one section per finding: its short problem label, the workload and
// its state now, the cause, the proposed fix (steps to copy and run) and the evidence, each quote with the
// read it came from, which opens that read. The same findings copy as Markdown for an incident channel.
// Everything from the cluster or the model is rendered as text, never as HTML.

import { useContext, useState } from "react";

import { workloadKey, type Check, type QuoteResult, type TurnFile } from "./api";
import { TurnContext } from "./Turn";

type Fix = { summary?: string; precheck?: unknown; commands?: unknown; verify?: unknown; rollback?: unknown; risk?: string };
export type Finding = {
  resource?: string; namespace?: string; problem?: string; cause?: string; ruled_out?: unknown;
  fix?: Fix | string; evidence?: { file?: string; quote?: string }[];
};

export const FINDINGS = "output/findings.json";
export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const clock = (iso?: string) => {
  const when = iso ? new Date(iso) : null;
  return when && !Number.isNaN(when.getTime()) ? when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
};

export const findingsUrl = (threadId: string, turn: number) =>
  `/api/threads/${encodeURIComponent(threadId)}/turns/${turn}/files/${FINDINGS}`;

// A version of the findings never changes once written, so each is fetched once; a failed fetch is tried again.
const fetched = new Map<string, Promise<Finding[] | null>>();
export function loadFindings(url: string): Promise<Finding[] | null> {
  let pending = fetched.get(url);
  if (!pending) {
    pending = fetch(url).then((response) => (response.ok ? response.json() : null))
      .then((body) => (Array.isArray(body?.findings) ? body.findings as Finding[] : null), () => null)
      .then((findings) => { if (!findings) fetched.delete(url); return findings; });
    fetched.set(url, pending);
  }
  return pending;
}

export function Copy({ text, label = "Copy", className = "ax-button" }: { text: string | (() => Promise<string>); label?: string;
  className?: string }) {
  const [shown, setShown] = useState(label);
  return (
    <button type="button" className={className} onClick={async () => {
      try {
        await navigator.clipboard.writeText(typeof text === "string" ? text : await text());
        setShown("Copied");
      } catch {
        setShown("Could not copy");
      }
      setTimeout(() => setShown(label), 1500);
    }}>{shown}</button>
  );
}

export const CheckIcon = ({ failed = false }: { failed?: boolean }) => failed ? (
  <svg className="ax-check-icon err" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.5h.01" /></svg>
) : (
  <svg className="ax-check-icon ok" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></svg>
);

/* ---------- The fix ---------- */

const STEPS: [keyof Fix, string][] = [["precheck", "Check first"], ["commands", "Run"], ["verify", "Verify"], ["rollback", "Undo"]];
// A line that starts with a lowercase word (kubectl, helm, git…) is a command; the agent writes advice as sentences.
const isCommand = (line: string) => /^(\$\s*)?[a-z]/.test(line.trim());
const linesOf = (value: unknown) => (Array.isArray(value) ? value : value ? [value] : []).map(String).filter((line) => line.trim());

function ProposedFix({ fix }: { fix?: Fix | string }) {
  if (!fix) return null;
  if (typeof fix !== "object") {
    return (
      <section className="ax-fix">
        <div className="ax-fix-head"><h4>Proposed fix</h4><Copy text={String(fix)} /></div>
        <p className="ax-fix-summary">{String(fix)}</p>
      </section>
    );
  }
  const steps = STEPS.map(([key, label]) => ({ key, label, lines: linesOf(fix[key]) })).filter((step) => step.lines.length);
  return (
    <section className="ax-fix">
      <div className="ax-fix-head"><h4>Proposed fix</h4></div>
      {fix.summary ? <p className="ax-fix-summary">{String(fix.summary)}</p> : null}
      {steps.map(({ key, label, lines }) => {
        const commands = lines.filter(isCommand);
        return (
          <div key={key} className={`ax-fix-step ${key}`}>
            <div className="ax-fix-label"><span>{label}</span>{commands.length ? <Copy text={commands.join("\n")} /> : null}</div>
            {commands.length ? <pre>{commands.join("\n")}</pre> : null}
            {lines.filter((line) => !isCommand(line)).map((line, index) => <p key={index}>{line}</p>)}
          </div>
        );
      })}
      {!linesOf(fix.commands).some(isCommand) ? <p className="ax-fix-note">No command to run: the change is described above, for whoever owns the manifest.</p> : null}
      {fix.risk ? <p className="ax-fix-risk"><strong>Risk</strong> {String(fix.risk)}</p> : null}
    </section>
  );
}

/* ---------- The findings ---------- */

// The check shortens long quotes and ends them with an ellipsis; a result matches the quote it starts.
export const resultFor = (results: QuoteResult[] | undefined, item: { file?: string; quote?: string }) => results?.find((quote) =>
  quote.file === item.file && String(item.quote || "").startsWith(String(quote.quote || "").replace(/…$/, "")));

// What the check found, said once above the findings; a failure names the quote and the read it cites.
export function checkSummary(check: Check | null | undefined, count: number) {
  const total = check?.quotes_total ?? check?.quotes ?? 0;
  if (check?.status === "evidence_passed") return { failed: false, text: `${plural(count, "finding")}; every quote is in the evidence it cites` };
  if (check?.status === "failed") {
    const missing = total - (check.quotes ?? 0);
    return { failed: true, text: total && missing > 0 ? `Evidence check failed: ${missing} of ${plural(total, "quote")} ${missing === 1 ? "is" : "are"} not in the read it cites.`
      : `Evidence check failed: ${check.detail || "a quote was not found"}.` };
  }
  return { failed: false, text: `${plural(count, "finding")}; not checked against the evidence` };
}

export function FindingsView({ findings, check, first, sources, onQuote, onFix }: {
  findings: Finding[]; check?: Check | null; first?: Check | null; sources: Map<string, TurnFile>;
  onQuote: (file: string, quote: string) => void; onFix: () => void;
}) {
  const { workloads } = useContext(TurnContext);
  const results = new Map((check?.results || []).map((result) => [result.index, result]));
  const summary = checkSummary(check, findings.length);
  return (
    <div className="ax-findings-doc">
      {first ? <p className="ax-doc-note">The first check failed ({first.detail || "a quote was not found"}); the agent re-read its
        sources and corrected the findings.</p> : null}
      <div className={`ax-doc-check${summary.failed ? " failed" : ""}`}>
        <CheckIcon failed={summary.failed} /><span>{summary.text}</span>
        {summary.failed ? <button type="button" className="ax-button" onClick={onFix}>Ask the agent to fix</button> : null}
      </div>
      {check?.status !== "failed" ? <p className="ax-doc-note">The check finds each quote in what the worker read; the causes are the agent's
        reasoning from them.</p> : null}
      {findings.map((finding, index) => {
        const result = results.get(index);
        const [kind, name] = String(finding.resource || "").split("/");
        const live = kind && name && finding.namespace ? workloads.get(workloadKey(finding.namespace, kind, name)) : undefined;
        const evidence = Array.isArray(finding.evidence) ? finding.evidence : [];
        const ruledOut = linesOf(finding.ruled_out);
        return (
          <article key={index} className="ax-finding">
            <header className="ax-finding-head">
              <h3>{String(finding.problem || "Finding")}</h3>
              {result?.verified === false ? <span className="ax-badge danger">Unverified</span> : null}
              {live ? (
                <span className={`ax-live ${live.state}`} title="As the worker reads it now">
                  <span className={`ax-dot ${live.state}`} aria-hidden="true" />{live.state} now · {live.ready}/{live.desired} ready
                </span>
              ) : null}
            </header>
            <p className="ax-finding-resource"><code>{finding.resource || "resource"}</code>
              {finding.namespace ? <span> in {finding.namespace}</span> : null}</p>
            {finding.cause ? <p className="ax-finding-cause">{finding.cause}</p> : null}
            <ProposedFix fix={finding.fix} />
            {ruledOut.length ? (
              <details className="ax-ruled">
                <summary>Ruled out <span className="ax-muted">{ruledOut.length}</span></summary>
                <ul>{ruledOut.map((item, line) => <li key={line}>{item}</li>)}</ul>
              </details>
            ) : null}
            {evidence.length ? (
              <>
                <h4 className="ax-doc-label">Evidence</h4>
                <ul className="ax-quotes">
                  {evidence.map((item, line) => {
                    const outcome = resultFor(result?.quotes, item);
                    const source = item.file ? sources.get(item.file) : undefined;
                    const read = clock(outcome?.recorded_at || source?.recorded_at);
                    const missing = outcome && !outcome.found;
                    return (
                      <li key={line} className={missing ? "missing" : ""}>
                        <span className="ax-quote-text">{item.quote}</span>
                        <span className="ax-quote-source">
                          {missing ? <strong>{outcome.reason === "not in the file" ? "Not in this read: " : `Not checked (${outcome.reason}): `}</strong> : null}
                          {item.file ? <button type="button" className="ax-link" title={item.file}
                            onClick={() => onQuote(item.file!, String(item.quote || ""))}>{source?.command || item.file.replace(/^evidence\//, "")}</button> : null}
                          {read ? <span className="ax-muted"> · read {read}</span> : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

/** The findings as Markdown, for an incident channel: the check, then each finding with its fix and its quotes. */
export function findingsMarkdown(findings: Finding[], check: Check | null | undefined, version: string, sources: Map<string, TurnFile>) {
  const lines = [`**Findings** (${version}): ${checkSummary(check, findings.length).text}.`];
  for (const finding of findings) {
    lines.push("", `### ${finding.problem || "Finding"}: \`${finding.resource || "resource"}\`${finding.namespace ? ` in ${finding.namespace}` : ""}`);
    if (finding.cause) lines.push("", finding.cause);
    const fix = finding.fix;
    if (fix && typeof fix === "object") {
      lines.push("", `**Proposed fix.** ${fix.summary || ""}`.trim());
      for (const [key, label] of STEPS) {
        const steps = linesOf(fix[key]);
        if (!steps.length) continue;
        const commands = steps.filter(isCommand);
        lines.push("", `${label}:`);
        if (commands.length) lines.push("```", ...commands, "```");
        lines.push(...steps.filter((line) => !isCommand(line)));
      }
      if (fix.risk) lines.push("", `Risk: ${fix.risk}`);
    } else if (fix) {
      lines.push("", `**Proposed fix.** ${fix}`);
    }
    const evidence = Array.isArray(finding.evidence) ? finding.evidence : [];
    if (evidence.length) lines.push("", "Evidence:");
    for (const item of evidence) {
      const source = item.file ? sources.get(item.file) : undefined;
      const read = clock(source?.recorded_at);
      lines.push(`- \`${String(item.quote || "").replace(/\s*\n\s*/g, " ")}\` (${source?.command || item.file}${read ? `, read ${read}` : ""})`);
    }
  }
  return lines.join("\n");
}
