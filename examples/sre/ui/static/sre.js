// Copyright 2026 openai-agent-mxc contributors
// SPDX-License-Identifier: Apache-2.0
//
// The SRE views of the page: a health board of the workloads the worker can read,
// findings as cards with copyable fixes and checked quotes, and readable evidence:
// log excerpts and kubectl tables. Everything from the cluster, the sandbox or the
// model is inserted as text, never as HTML.

import { el, getJSON, plural } from "./dom.js";

const HEALTH_EVERY_MS = 10_000;
let health = { at: 0, status: 0, body: null, pending: null };
let memory = { at: 0, version: 0, body: null };

const STATE_LABEL = { failing: "failing", degraded: "degraded", healthy: "healthy" };
const BAD = /CrashLoopBackOff|ImagePullBackOff|ErrImagePull|Error|OOMKilled|Unschedulable|CreateContainer|InvalidImage|Failed|Evicted/;
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

// Kubernetes counts a repeated warning event's occurrences for as long as it lasts, so the count only grows;
// when the latest one happened says more.
function warningChip(workload) {
  if (!workload.warnings) return null;
  const when = workload.last_warning_at ? ago(workload.last_warning_at) : "";
  return el("span", { class: "sre-chip warn", title: workload.last_warning || "" }, when ? `warning ${when}` : "warnings");
}

function workloadRow(suggest, workload, namespace) {
  return el("li", { class: `sre-workload ${workload.state}` },
    el("span", { class: "sre-dot", title: STATE_LABEL[workload.state] }),
    el("span", { class: "sre-name" }, el("span", { class: "sre-kind" }, workload.kind), workload.name),
    el("span", { class: "sre-ready", title: "ready / desired" }, `${workload.ready}/${workload.desired}`),
    el("span", { class: "sre-reasons" },
      workload.reasons.map((reason) => el("span", { class: `sre-chip${BAD.test(reason) ? " bad" : ""}` }, reason)),
      workload.restarts ? el("span", { class: "sre-chip" }, plural(workload.restarts, "restart")) : null,
      warningChip(workload)),
    workload.state === "healthy" ? el("span") : el("button", { type: "button", class: "sre-investigate",
      onclick: () => suggest(prompt(workload, namespace)) }, "Investigate"));
}

async function loadMemory(version) {
  if (memory.version === version && Date.now() - memory.at < HEALTH_EVERY_MS) return memory.body;
  const { status, body } = await getJSON("/api/memory").catch(() => ({ status: 0, body: null }));
  memory = { at: Date.now(), version, body: status === 200 ? body : null };
  return memory.body;
}

// One line on the start screen; the Memory view, beside the history button, lists and forgets what is remembered.
function memoryLine(config, remembered, openMemory) {
  if (!config.memory) return null;
  const whose = !remembered || remembered.shared ? "The guest memory, shared by everyone not signed in."
    : `${remembered.user}'s memory.`;
  const count = remembered?.conversations || 0;
  return el("p", { class: "sre-board-note sre-memory", title: `${whose} Investigations start from it.` },
    count ? `${plural(count, "remembered conversation")} · ` : "Nothing remembered yet · ",
    el("button", { type: "button", class: "sre-link", onclick: () => openMemory?.() }, "View memory"));
}

export async function renderHome({ container, suggest, config, threadId, running, openMemory, memoryVersion }) {
  if (!config.health || threadId || running) {
    container.hidden = true;
    return;
  }
  const [{ status, body }, remembered] = await Promise.all([loadHealth(),
    config.memory ? loadMemory(memoryVersion) : null]);
  if (status !== 200 || !body) {
    container.replaceChildren(el("p", { class: "sre-board-note" },
      "Cluster health is unavailable: the sandbox worker cannot be reached right now."));
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
      `Investigate all ${unhealthy.length}`) : null;
    return el("div", { class: "sre-namespace" },
      el("div", { class: "sre-board-head" },
        el("strong", {}, item.namespace),
        el("span", { class: "sre-counts" },
          counts.failing ? el("span", { class: "sre-count failing" }, `${counts.failing} failing`) : null,
          counts.degraded ? el("span", { class: "sre-count degraded" }, `${counts.degraded} degraded`) : null,
          el("span", { class: "sre-count healthy" }, `${counts.healthy} healthy`)),
        all),
      item.error ? el("p", { class: "sre-board-note" }, `Could not read ${item.namespace}: ${item.error}`)
        : el("ul", { class: "sre-workloads" }, item.workloads.map((workload) => workloadRow(suggest, workload,
          item.namespace))));
  });
  container.replaceChildren(el("div", { class: "sre-board" },
    el("div", { class: "sre-board-title", title: "Read by the sandbox worker with its read-only identity: "
      + "workload metadata only, never sent to the model." },
      "Cluster now", updated ? el("span", { class: "sre-board-note" }, ` · ${updated}`) : null),
    sections, memoryLine(config, remembered, openMemory)));
  container.hidden = false;
}

/* ---------- Findings ---------- */

function problemClass(problem) {
  return BAD.test(problem || "") ? "bad" : "warn";
}

function renderFindings({ body, open, check, text }) {
  let findings;
  try {
    findings = JSON.parse(text).findings;
    if (!Array.isArray(findings)) throw new Error("no findings list");
  } catch {
    return false;
  }
  const banner = check?.status === "evidence_passed"
    ? el("div", { class: "notice ok", title: "Every quote appears in the worker's journal copy of the evidence it cites. "
      + "Causes and fixes are the agent's reasoning; fixes are proposals and were not run." },
      `${plural(check.quotes, "quote")} match the recorded evidence.`)
    : check?.status === "failed" ? el("div", { class: "notice err" }, `Evidence check failed: ${check.detail || ""}`)
      : el("div", { class: "notice warn" }, "Not checked on the host for this turn.");
  const raw = el("pre", { class: "sre-json", hidden: true }, JSON.stringify(findings, null, 2));
  const toggle = el("button", { type: "button", class: "sre-link" }, "View JSON");
  toggle.addEventListener("click", () => {
    raw.hidden = !raw.hidden;
    toggle.textContent = raw.hidden ? "View JSON" : "Hide JSON";
  });
  const cards = findings.map((finding) => el("article", { class: "sre-finding" },
    el("header", {},
      // A short label; agents sometimes write a sentence here, which stays available on hover.
      el("span", { class: `sre-problem ${problemClass(finding.problem)}`, title: finding.problem || "" },
        String(finding.problem || "finding").split(/[;:.]\s|,\s/)[0].slice(0, 40)),
      el("strong", {}, finding.resource || "resource"),
      finding.namespace ? el("span", { class: "sre-muted" }, `in ${finding.namespace}`) : null),
    finding.cause ? el("p", { class: "sre-cause" }, finding.cause) : null,
    finding.fix ? el("div", { class: "sre-fix" },
      el("div", { class: "sre-fix-head" }, el("span", {}, "Proposed fix · not run"), copyButton(String(finding.fix))),
      el("pre", {}, String(finding.fix))) : null,
    Array.isArray(finding.evidence) && finding.evidence.length ? el("ul", { class: "sre-quotes" },
      finding.evidence.map((item) => el("li", {},
        el("blockquote", {}, `“${item.quote}”`),
        el("span", { class: "sre-muted" }, String(item.file || "").replace(/^evidence\//, "")),
        item.file ? el("button", { type: "button", class: "sre-link", onclick: () => open(item.file, item.quote) },
          "Show in source") : null))) : null));
  body.replaceChildren(el("div", { class: "sre-findings" }, banner,
    el("div", { class: "sre-findings-head" }, el("span", {}, plural(findings.length, "finding")), toggle), raw, cards));
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
  body.replaceChildren(el("div", { class: "sre-log" },
    el("div", { class: "notice", title: "The worker's log policy kept errors and warnings with their context and the last "
      + "lines, collapsed repeats, and masked credentials and personal data." },
      el("strong", {}, "Log excerpt"), " · the raw log never left the worker",
      stats ? el("div", { class: "sre-stats" },
        el("span", {}, `${stats[1]} lines read`), el("span", {}, `${stats[2]} shown`),
        el("span", {}, `${stats[3]} withheld`), el("span", {}, `${stats[4]} values masked`)) : null),
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
export async function renderFile({ file, body, url, highlight, open, check }) {
  const path = file.path || "";
  const kind = path === "output/findings.json" ? "findings"
    : /^evidence\/\d+-pod-logs-/.test(path) ? "logs"
      : /^evidence\/\d+-kubectl-get-/.test(path) ? "table" : null;
  // A quote opened in its source uses the page's own view, which highlights it.
  if (!kind || (highlight && kind !== "findings")) return false;
  const response = await fetch(url);
  if (!response.ok) return false;
  const text = await response.text();
  if (kind === "findings") return renderFindings({ body, open, check, text });
  if (kind === "logs") return renderLogExcerpt({ body, text });
  return renderKubectlTable({ body, text });
}
