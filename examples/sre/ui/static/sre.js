// Copyright 2026 openai-agent-mxc contributors
// SPDX-License-Identifier: Apache-2.0
//
// The SRE views of the page: a health board of the workloads the worker can read,
// findings with copyable fixes and checked quotes, and readable evidence: log
// excerpts and kubectl tables. Colour marks state and failures only. Everything from
// the cluster, the sandbox or the model is inserted as text, never as HTML.

import { el, getJSON, plural } from "./dom.js";

const HEALTH_EVERY_MS = 10_000;
let health = { at: 0, status: 0, body: null, pending: null };

const STATE_LABEL = { failing: "failing", degraded: "degraded", healthy: "healthy" };
const BAD = /CrashLoopBackOff|ImagePullBackOff|ErrImagePull|Error|OOMKilled|Unschedulable|CreateContainer|InvalidImage|Failed|Evicted/;
const COUNTS = ["failing", "degraded", "healthy"];
const GOOD = /^(Running|Completed|Succeeded)$/;

function ago(iso) {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

function copyButton(text, label = "Copy") {
  const button = el("button", { type: "button", class: "sre-copy" }, label);
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Select and copy";
    }
    setTimeout(() => { button.textContent = label; }, 1500);
  });
  return button;
}

/* ---------- Health board ---------- */

async function loadHealth() {
  if (health.pending) return health.pending;
  if (Date.now() - health.at < HEALTH_EVERY_MS && health.body) return health;
  health.pending = getJSON("/api/health").then(({ status, body }) => {
    health = { at: Date.now(), status, body, pending: null };
    return health;
  }, () => {
    health = { at: Date.now(), status: 0, body: null, pending: null };
    return health;
  });
  return health.pending;
}

function prompt(workload, namespace) {
  const reasons = workload.reasons.length ? ` (${workload.reasons.join(", ")})` : "";
  return `Why is ${workload.kind.toLowerCase()} ${workload.name} in ${namespace} ${workload.state}${reasons}? `
    + "Find the cause from the evidence and propose a fix.";
}

// What is wrong, as plain text. Kubernetes counts a repeated warning event's occurrences for as long as it
// lasts, so the count only grows; when the latest one happened says more.
function reasons(workload) {
  const warned = workload.warnings && workload.last_warning_at ? `last warning ${ago(workload.last_warning_at)}` : "";
  return [...workload.reasons, workload.restarts ? plural(workload.restarts, "restart") : "", warned, changed(workload)]
    .filter(Boolean).join(", ");
}

const tag = (image) => String(image).split(/[:@]/).slice(1).join(":") || String(image);

// What changed last: a rollout in the last day, or one that changed an image.
function changed(workload) {
  const rollout = workload.rollout;
  if (!rollout || !rollout.at) return "";
  const recent = Date.now() - new Date(rollout.at).getTime() < 86_400_000;
  if (!recent && !rollout.changed?.length) return "";
  const images = (rollout.changed || []).map((item) => `${tag(item.from)} → ${tag(item.to)}`).join(", ");
  return `rolled out ${ago(rollout.at)} (rev ${rollout.revision}${images ? `, ${images}` : ""})`;
}

// An unhealthy workload with an open issue opens that issue, shared by the team; without one, a new conversation.
function workloadRow(suggest, openIssue, workload, namespace, issue) {
  const question = prompt(workload, namespace);
  const action = workload.state === "healthy" ? el("span")
    : issue ? el("button", { type: "button", class: "sre-investigate", title: issue.title,
      onclick: () => openIssue(issue.thread_id, question) }, "Open issue")
      : el("button", { type: "button", class: "sre-investigate", onclick: () => suggest(question) }, "Investigate");
  return el("li", { class: `sre-workload ${workload.state}` },
    el("span", { class: "sre-dot", title: STATE_LABEL[workload.state] }),
    el("span", { class: "sre-name", title: workload.kind }, workload.name),
    el("span", { class: "sre-ready", title: "ready / desired" }, `${workload.ready}/${workload.desired}`),
    el("span", { class: "sre-reasons", title: workload.waiting_message || workload.last_warning || "" }, reasons(workload)),
    action);
}

async function openIssues(config) {
  if (!config.issues) return new Map();
  const { status, body } = await getJSON("/api/issues").catch(() => ({ status: 0, body: null }));
  const open = status === 200 ? body.issues.filter((issue) => issue.state === "open") : [];
  return new Map(open.map((issue) => [issue.fingerprint, issue]));
}

export async function renderHome({ container, suggest, openIssue, config, threadId, running }) {
  if (!config.health || threadId || running) {
    container.hidden = true;
    return;
  }
  const [{ status, body }, issues] = await Promise.all([loadHealth(), openIssues(config)]);
  if (status !== 200 || !body) {
    container.replaceChildren(el("p", { class: "sre-board-note" }, "Can't reach the sandbox worker for cluster health."));
    container.hidden = false;
    return;
  }
  const updated = body.generated_at ? new Date(body.generated_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  const sections = body.namespaces.map((item) => {
    const counts = { failing: 0, degraded: 0, healthy: 0 };
    for (const workload of item.workloads) counts[workload.state] += 1;
    const unhealthy = item.workloads.filter((workload) => workload.state !== "healthy");
    const all = unhealthy.length > 1 ? el("button", { type: "button", class: "sre-investigate",
      onclick: () => suggest(`Which workloads in ${item.namespace} are unhealthy (${unhealthy.map((workload) =>
        workload.name).join(", ")}), and why? Find each cause from the evidence and propose fixes.`) },
      "Investigate all") : null;
    return el("section", { class: "sre-namespace" },
      el("div", { class: "sre-board-head" },
        el("h2", {}, item.namespace),
        el("span", { class: "sre-counts" }, COUNTS.filter((state) => counts[state] || state === "healthy")
          .map((state) => el("span", { class: state === "failing" ? "failing" : "" }, `${counts[state]} ${state}`))),
        all),
      item.error ? el("p", { class: "sre-board-note" }, `Could not read ${item.namespace}: ${item.error}`)
        : el("ul", { class: "sre-workloads" }, item.workloads.map((workload) => workloadRow(suggest, openIssue,
          workload, item.namespace, issues.get(`${item.namespace}/${workload.kind.toLowerCase()}/${workload.name}`)))));
  });
  container.replaceChildren(el("div", { class: "sre-board" }, sections,
    updated ? el("p", { class: "sre-board-note" }, `As of ${updated}`) : null));
  container.hidden = false;
}

/* ---------- Findings ---------- */

function clock(iso) {
  const when = iso ? new Date(iso) : null;
  return when && !Number.isNaN(when.getTime()) ? when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
}

const FIX_STEPS = [["precheck", "Check first"], ["commands", "Run"], ["verify", "Verify"], ["rollback", "Undo"]];

// A fix is commands for a person to run: what to check first, the change, how to verify it and how to undo it.
// Copy takes the change's commands only. A fix written as prose (older findings) shows as it was written.
function renderFix(fix) {
  if (!fix) return null;
  if (typeof fix !== "object") {
    return el("div", { class: "sre-fix" }, el("div", { class: "sre-label" }, "Proposed fix", copyButton(String(fix))),
      el("pre", {}, String(fix)));
  }
  const lines = (key) => (Array.isArray(fix[key]) ? fix[key] : fix[key] ? [fix[key]] : []).map(String);
  return el("div", { class: "sre-fix" },
    el("div", { class: "sre-label" }, "Proposed fix"),
    fix.summary ? el("p", { class: "sre-fix-summary" }, String(fix.summary)) : null,
    FIX_STEPS.filter(([key]) => lines(key).length).map(([key, label]) => el("div", { class: "sre-fix-step" },
      el("div", { class: "sre-step-label" }, label, key === "commands" ? copyButton(lines(key).join("\n")) : null),
      el("pre", {}, lines(key).join("\n")))),
    !lines("commands").length ? el("p", { class: "note" }, "No command to run: see the summary.") : null,
    fix.risk ? el("p", { class: "sre-risk" }, `Risk: ${fix.risk}`) : null);
}

function renderFindings({ body, open, check, first, sources, text }) {
  let findings;
  try {
    findings = JSON.parse(text).findings;
    if (!Array.isArray(findings)) throw new Error("no findings list");
  } catch {
    return false;
  }
  // The check's result for each finding and quote: what was found, and what was not.
  const results = new Map((check?.results || []).map((result) => [result.resource, result]));
  const passed = check?.status === "evidence_passed";
  const headline = passed ? `${plural(findings.length, "finding")}, ${plural(check.quotes, "quote")} found in the evidence`
    : plural(findings.length, "finding");
  const notes = [
    first ? el("p", { class: "note" }, `First check: ${first.detail || "failed"}. The agent re-read its sources and `
      + "corrected the findings; this is the second check.") : null,
    passed ? el("p", { class: "note" }, "The check finds each quote in the read it cites; the causes are the agent's "
      + "reasoning.") : null,
    check?.status === "failed" ? el("p", { class: "note err" }, `Evidence check failed: ${check.detail || ""}`)
      : !check || check.status === "no_findings" ? el("p", { class: "note" }, "Not checked against the evidence.") : null,
  ];
  const raw = el("pre", { class: "sre-json", hidden: true }, JSON.stringify(findings, null, 2));
  const toggle = el("button", { type: "button", class: "sre-link" }, "View JSON");
  toggle.addEventListener("click", () => {
    raw.hidden = !raw.hidden;
    toggle.textContent = raw.hidden ? "View JSON" : "Hide JSON";
  });
  const cards = findings.map((finding) => {
    const result = results.get(String(finding.resource || "a finding").slice(0, 80));
    const outcome = (item) => result?.quotes?.find((quote) => quote.file === item.file
      && String(item.quote || "").startsWith(String(quote.quote || "").replace(/…$/, "")));
    const ruledOut = Array.isArray(finding.ruled_out) ? finding.ruled_out : [];
    return el("article", { class: "sre-finding" },
      // The problem is the finding's title: a short label, as the triage skill asks for.
      el("h3", {}, String(finding.problem || "Finding"),
        result && !result.verified ? el("span", { class: "sre-unverified" }, "Unverified") : null),
      el("p", { class: "sre-resource" }, finding.resource || "resource",
        finding.namespace ? el("span", { class: "muted" }, ` in ${finding.namespace}`) : null),
      finding.cause ? el("p", { class: "sre-cause" }, finding.cause) : null,
      ruledOut.length ? el("div", { class: "sre-ruled" }, el("div", { class: "sre-label" }, "Ruled out"),
        el("ul", {}, ruledOut.map((item) => el("li", {}, String(item))))) : null,
      renderFix(finding.fix),
      Array.isArray(finding.evidence) && finding.evidence.length ? el("div", { class: "sre-evidence" },
        el("div", { class: "sre-label" }, "Evidence"),
        el("ul", { class: "sre-quotes" }, finding.evidence.map((item) => {
          const found = outcome(item);
          const source = sources?.get(item.file);
          const read = clock(found?.recorded_at || source?.recorded_at);
          return el("li", { class: found && !found.found ? "missing" : "" },
            el("blockquote", {}, item.quote),
            el("div", { class: "sre-source" },
              found && !found.found ? el("span", { class: "sre-missing" }, found.reason === "not in the file"
                ? "Not in this read:" : `Not checked: ${found.reason}.`) : null,
              item.file ? el("button", { type: "button", class: "sre-link", title: item.file,
                onclick: () => open(item.file, item.quote) }, source?.command || String(item.file).replace(/^evidence\//, ""))
                : null,
              read ? el("span", { class: "muted" }, `read ${read}`) : null));
        }))) : null);
  });
  body.replaceChildren(el("div", { class: "sre-findings" },
    el("div", { class: "sre-findings-head" }, el("span", {}, headline), toggle), ...notes, raw, cards));
  return true;
}

/* ---------- Evidence ---------- */

function renderLogExcerpt({ body, text }) {
  const lines = text.split("\n");
  const header = lines[0] || "";
  const stats = /read (\d+) lines; showing (\d+).*?withheld (\d+); (\d+) values masked/s.exec(header);
  const rows = lines.slice(1).filter((line) => line.trim()).map((line) => {
    const match = /^\s*(\d+)\| (.*?)(\s+\[×(\d+) more like this, last at line (\d+)\])?$/.exec(line);
    const number = match?.[1] ?? "";
    const content = match?.[2] ?? line;
    const severity = /\b(fatal|panic|error|exception|traceback|failed|failure|timeout|refused)\b/i.test(content) ? "err"
      : /\b(warn|warning|retrying|backoff)\b/i.test(content) ? "warn" : "";
    const parts = content.split(/(\[REDACTED_[A-Z_]+\])/).map((part) =>
      /^\[REDACTED_[A-Z_]+\]$/.test(part) ? el("span", { class: "sre-masked" }, part.slice(10, -1).toLowerCase()) : part);
    return el("div", { class: `sre-log-line ${severity}` },
      el("span", { class: "sre-gutter" }, number),
      el("span", { class: "sre-log-text" }, parts,
        match?.[4] ? el("span", { class: "sre-repeat" }, `×${match[4]} more, last at line ${match[5]}`) : null));
  });
  const count = (value) => Number(value).toLocaleString();
  body.replaceChildren(el("div", { class: "sre-log" },
    el("p", { class: "note", title: "The worker kept errors and warnings with their context and the last lines, "
      + "collapsed repeats, and masked credentials and personal data." }, stats
      ? `Excerpt: ${count(stats[2])} of ${count(stats[1])} lines, ${count(stats[4])} values masked.`
      : "Excerpt of the log, cut by the worker."),
    rows.length ? el("div", { class: "sre-log-lines" }, rows) : el("p", { class: "empty" }, "The log was empty.")));
  return true;
}

function renderKubectlTable({ body, text }) {
  const lines = text.split("\n").filter((line) => line.trim() && !line.startsWith("[mxc-worker]"));
  if (lines.length < 2 || !/^[A-Z][A-Z -]*\s{2,}/.test(lines[0])) return false;
  // Column starts come from the header, where kubectl aligns every column.
  const starts = [...lines[0].matchAll(/\S+(?: \S+)*/g)].map((match) => match.index);
  const cells = (line) => starts.map((start, index) => line.slice(start, starts[index + 1]).trim());
  const header = cells(lines[0]);
  const status = header.indexOf("STATUS");
  const table = el("table", { class: "sre-table" },
    el("thead", {}, el("tr", {}, header.map((name) => el("th", {}, name)))),
    el("tbody", {}, lines.slice(1).map((line) => el("tr", {}, cells(line).map((value, index) => el("td", {
      class: index === status ? (GOOD.test(value) ? "ok" : BAD.test(value) ? "bad" : value ? "warn" : "") : "",
    }, value))))));
  body.replaceChildren(el("div", { class: "sre-table-wrap" }, table));
  return true;
}

// Renders the file types this agent knows; returns false to leave a file to the page's own views.
export async function renderFile({ file, body, url, highlight, open, check, first, sources }) {
  const path = file.path || "";
  const kind = path === "output/findings.json" ? "findings"
    : /^evidence\/\d+-pod-logs-/.test(path) ? "logs"
      : /^evidence\/\d+-kubectl-get-/.test(path) ? "table" : null;
  // A quote opened in its source uses the page's own view, which highlights it.
  if (!kind || (highlight && kind !== "findings")) return false;
  const response = await fetch(url);
  if (!response.ok) return false;
  const text = await response.text();
  if (kind === "findings") return renderFindings({ body, open, check, first, sources, text });
  if (kind === "logs") return renderLogExcerpt({ body, text });
  return renderKubectlTable({ body, text });
}
