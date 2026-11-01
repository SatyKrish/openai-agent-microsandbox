// Copyright 2026 openai-agent-substrate contributors
// SPDX-License-Identifier: Apache-2.0
//
// A turn's trace: where the time went, where each step ran (the workspace's lifecycle,
// the harness, the sandbox) and every step on one time axis, in order, slowest first
// or only the tool calls. Jaeger has the span-level detail.

import { el, getJSON, plural, readStorage, seconds, writeStorage } from "./dom.js";

const LANES = [
  { id: "workspace", label: "Workspace", kinds: ["life"] },
  { id: "harness", label: "Harness", kinds: ["model", "harness", "check"] },
  { id: "sandbox", label: "Sandbox", kinds: ["tool", "skill", "error"] },
];
const KIND_LABELS = {
  life: "workspace lifecycle", model: "model call", harness: "harness tool", check: "host check",
  tool: "sandbox command", skill: "skill load", error: "failed command",
};
// Where the time went. An instant two steps share counts once, for the first share
// listed here; failed commands count as sandbox commands.
const SHARES = [
  { label: "Sandbox commands", kind: "tool", kinds: ["tool", "error"] },
  { label: "Skill loads", kind: "skill", kinds: ["skill"] },
  { label: "Harness tools", kind: "harness", kinds: ["harness"] },
  { label: "Host check", kind: "check", kinds: ["check"] },
  { label: "Model", kind: "model", kinds: ["model"] },
  { label: "Workspace", kind: "life", kinds: ["life"] },
];
const TOOL_KINDS = ["tool", "skill", "error", "harness"];
const VIEWS = [
  { id: "order", label: "In order" },
  { id: "slowest", label: "Slowest first" },
  { id: "tools", label: "Tool calls" },
];

// The open step survives the re-renders of a running turn.
let selected = null;

function checkSummary(check) {
  const status = check?.status || "";
  if (status.includes("failed")) return { value: "failed", tone: "err" };
  if (status.includes("passed")) return { value: "passed", tone: "ok" };
  return { value: "not checked", tone: "" };
}

function tile(label, value, sub, tone = "") {
  return el("div", { class: `tile ${tone}` }, el("span", { class: "label" }, label), el("span", { class: "value" }, value),
    sub ? el("span", { class: "sub" }, sub) : null);
}

function percent(ms, total) {
  const value = ms / total * 100;
  return value < 1 ? "<1%" : `${Math.round(value)}%`;
}

function stepName(row) {
  return row.label === "agents.response" ? "model call" : row.label.replace(/^(harness_)?tool\./, "");
}

const stepKey = (row) => `${row.label}@${row.start_ms}`;
const laneOf = (row) => LANES.find((lane) => lane.kinds.includes(row.kind)) || LANES[0];

// Wall-clock time the rows cover, counting overlaps once.
function busy(rows) {
  let sum = 0;
  let end = -Infinity;
  for (const row of [...rows].sort((a, b) => a.start_ms - b.start_ms)) {
    const stop = row.start_ms + row.duration_ms;
    if (stop > end) { sum += stop - Math.max(row.start_ms, end); end = stop; }
  }
  return sum;
}

function shares(rows, total) {
  const edges = [...new Set(rows.flatMap((row) => [row.start_ms, row.start_ms + row.duration_ms]))].sort((a, b) => a - b);
  const sums = SHARES.map(() => 0);
  for (let index = 1; index < edges.length; index += 1) {
    const [from, to] = [edges[index - 1], edges[index]];
    const active = rows.filter((row) => row.start_ms < to && row.start_ms + row.duration_ms > from);
    const share = SHARES.findIndex((item) => active.some((row) => item.kinds.includes(row.kind)));
    if (share >= 0) sums[share] += to - from;
  }
  const parts = SHARES.map((item, index) => ({ ...item, ms: sums[index] })).filter((part) => part.ms > 0)
    .sort((a, b) => b.ms - a.ms);
  const other = total - sums.reduce((sum, ms) => sum + ms, 0);
  if (other >= 1) parts.push({ label: "Other", kind: "other", ms: other });
  return parts;
}

function sorted(rows, view) {
  if (view === "order") return rows;
  return (view === "tools" ? rows.filter((row) => TOOL_KINDS.includes(row.kind)) : [...rows])
    .sort((a, b) => b.duration_ms - a.duration_ms);
}

function axis(total) {
  // About five ticks at 1, 2 or 5 × 10^n milliseconds, labelled in seconds.
  const rough = total / 5;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((factor) => factor * magnitude).find((value) => value >= rough);
  const ticks = [];
  for (let at = 0; at < total * 0.95; at += step) ticks.push(at);
  return el("span", { class: "tl-axis" },
    ticks.map((at) => el("span", { style: `left: ${(at / total * 100).toFixed(2)}%` }, `${Number((at / 1000).toPrecision(3))} s`)));
}

function place(row, total) {
  return `left: ${(row.start_ms / total * 100).toFixed(2)}%; width: ${Math.max(row.duration_ms / total * 100, 0.4).toFixed(2)}%`;
}

function explain(row, lane) {
  if (row.kind === "model") return "A model call from the harness, which holds the API key.";
  if (row.kind === "check") return "The host check, on the host's copies of the files, outside the sandbox.";
  if (row.kind === "harness") return "A harness tool: it runs outside the sandbox with the harness's credentials and saves its output as evidence.";
  if (row.kind === "error") return "A command that exited non-zero in its own MXC container, which holds no model credentials.";
  if (lane.id === "sandbox") return "Ran in its own MXC container on the sandbox worker, which holds no model credentials.";
  if (row.label.startsWith("workspace setup")) return "Copying the conversation's files into its workspace before the first model call.";
  return "Creating, opening or deleting the conversation's workspace on the sandbox worker.";
}

function detail(row, total) {
  const lane = laneOf(row);
  return el("div", { class: "tl-detail" },
    el("div", { class: "tl-detail-head" },
      el("span", { class: `tag tag-${lane.id}` }, lane.id === "workspace" ? "workspace" : `ran in the ${lane.id}`),
      el("code", {}, row.label),
      el("span", { class: "muted tl-detail-time" },
        `at ${seconds(row.start_ms)} · took ${seconds(row.duration_ms)} · ${percent(row.duration_ms, total)} of the turn`)),
    el("span", { class: "muted" }, explain(row, lane)));
}

export async function renderTrace({ threadId, turn, body, config, setHead, isCurrent, onLive }) {
  if (!turn.otel_trace_id) {
    setHead(`Turn ${turn.number} trace`, "tracing is off");
    body.replaceChildren(el("div", { class: "empty" },
      el("h3", {}, "Tracing is off"),
      el("p", {}, "Point the harness at an OTLP/HTTP collector such as Jaeger (OTEL_EXPORTER_OTLP_ENDPOINT, port 4318) " +
        "and set JAEGER_URL to its query address, then restart the harness. Each later turn then has a trace: " +
        "what ran in the harness, what ran in MXC containers, and how long the workspace took to open.")));
    return;
  }
  const shortId = `${turn.otel_trace_id.slice(0, 8)}…${turn.otel_trace_id.slice(-4)}`;
  setHead(`Turn ${turn.number} trace`, `trace ${shortId} · from Jaeger`);
  if (!body.querySelector(".trace")) body.replaceChildren(el("div", { class: "empty" }, el("p", {}, "Loading the trace…")));
  const { status, body: data } = await getJSON(`/api/threads/${encodeURIComponent(threadId)}/turns/${turn.number}/trace`);
  if (!isCurrent()) return;
  const jaeger = config.jaeger_url
    ? el("a", { href: `${config.jaeger_url}/trace/${turn.otel_trace_id}`, target: "_blank", rel: "noopener noreferrer" }, "Open in Jaeger ↗")
    : null;
  if (status === 202) {
    body.replaceChildren(el("div", { class: "empty" }, el("p", {}, "Waiting for spans to reach Jaeger…")));
    setTimeout(() => { if (isCurrent()) onLive(); }, 2000);
    return;
  }
  if (status !== 200) {
    body.replaceChildren(el("div", { class: "notice warn" },
      "Jaeger is not reachable from the harness at its JAEGER_URL.", " ", jaeger));
    return;
  }
  const running = turn.status === "running";
  setHead(`Turn ${turn.number} trace`, `trace ${shortId} · ${data.span_count} spans${running ? " · live" : ""}`);
  const total = data.duration_ms || 1;
  const rows = data.rows;
  const byKey = new Map(rows.map((row) => [stepKey(row), row]));
  const toolRows = rows.filter((row) => TOOL_KINDS.includes(row.kind));
  const slowest = toolRows.reduce((top, row) => (!top || row.duration_ms > top.duration_ms ? row : top), null);
  const viewKey = `${config.name}:trace-view`;
  let view = VIEWS.some((item) => item.id === readStorage(viewKey)) ? readStorage(viewKey) : "order";

  const list = el("div", { class: "tl-list" });
  const lanes = el("div", { class: "tl-lanes" });
  const itemFor = (key) => [...list.children].find((item) => item.dataset.key === key);
  const setOpen = (item, open) => {
    item.classList.toggle("open", open);
    item.firstChild.setAttribute("aria-expanded", String(open));
    item.querySelector(".tl-detail")?.remove();
    if (open) item.append(detail(byKey.get(item.dataset.key), total));
  };
  const select = (row, reveal = false) => {
    const key = stepKey(row);
    selected = selected === key && !reveal ? null : key;
    if (selected && !itemFor(key)) setView("order");
    for (const item of list.children) if (item.dataset.key) setOpen(item, item.dataset.key === selected);
    for (const bar of lanes.querySelectorAll(".lane-bar")) bar.classList.toggle("selected", bar.dataset.key === selected);
    if (reveal) itemFor(key)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  const step = (row) => {
    const item = el("div", { class: "tl-item", "data-key": stepKey(row) },
      el("button", { type: "button", class: "tl-row tl-step", title: row.label, onclick: () => select(row) },
        el("span", { class: "tl-name" }, el("span", { class: "tl-name-text" }, stepName(row)),
          row.badge ? el("span", { class: `pill${row.error ? " err" : ""}` }, row.badge) : null),
        el("span", { class: "tl-track" }, el("span", { class: `step-bar k-${row.kind}`, style: place(row, total) })),
        el("span", { class: "tl-dur" }, seconds(row.duration_ms))));
    setOpen(item, stepKey(row) === selected);
    return item;
  };
  const renderSteps = () => {
    const shown = sorted(rows, view);
    list.replaceChildren(...(shown.length ? shown.map(step)
      : [el("p", { class: "muted tl-none" }, view === "tools" ? "No tool calls in this turn." : "No steps yet.")]));
  };
  const viewButtons = VIEWS.map((item) => el("button", { type: "button", "aria-pressed": String(item.id === view), onclick: () => setView(item.id) }, item.label));
  const setView = (id) => {
    view = id;
    writeStorage(viewKey, id);
    viewButtons.forEach((button, index) => button.setAttribute("aria-pressed", String(VIEWS[index].id === id)));
    renderSteps();
  };
  renderSteps();

  lanes.append(...LANES.map((lane) => {
    const laneRows = rows.filter((row) => lane.kinds.includes(row.kind));
    return el("div", { class: "tl-row" },
      el("span", { class: "tl-name" }, lane.label, el("span", { class: "muted" }, ` ${laneRows.length}`)),
      el("span", { class: "tl-track" }, laneRows.map((row) => el("button", {
        type: "button", class: `lane-bar k-${row.kind}${stepKey(row) === selected ? " selected" : ""}`, "data-key": stepKey(row),
        title: `${stepName(row)} · ${seconds(row.duration_ms)}`,
        "aria-label": [...new Set([stepName(row), KIND_LABELS[row.kind] || row.kind])].concat(seconds(row.duration_ms)).join(", "),
        style: place(row, total), onclick: () => select(row, true),
      }))),
      el("span", { class: "tl-dur" }, laneRows.length ? seconds(busy(laneRows)) : "—"));
  }));

  const check = checkSummary(turn.check);
  const start = turn.start_s !== undefined && turn.start_s !== null ? `${turn.lifecycle} in ${turn.start_s} s` : turn.lifecycle;
  const failed = data.tools.failed;
  const tiles = el("div", { class: "tiles" },
    tile("Turn", seconds(total), running ? "still running" : plural(rows.length, "step")),
    tile("Workspace", start || "—", "kept on the worker's volume"),
    tile("Model", plural(data.model.calls, "call"), [seconds(data.model.ms), turn.model ? ` · ${turn.model}` : null]),
    tile("Tokens", data.model.total_tokens.toLocaleString(),
      `${data.model.input_tokens.toLocaleString()} in · ${data.model.output_tokens.toLocaleString()} out`),
    tile("Tool calls", String(toolRows.length), [
      failed ? el("span", { class: "tile-fail" }, `${failed} failed`) : null, failed && slowest ? " · " : null,
      slowest ? el("button", { type: "button", class: "tile-link", onclick: () => select(slowest, true) },
        `slowest ${stepName(slowest)} ${seconds(slowest.duration_ms)}`) : "none"]),
    tile("Host check", running ? "after the turn" : check.value, null, running ? "" : check.tone));

  const parts = shares(rows, total);
  const split = el("div", { class: "split", role: "img", "aria-label": parts.map((part) => `${part.label} ${seconds(part.ms)}`).join(", ") },
    parts.map((part) => el("span", { class: `k-${part.kind}`, title: `${part.label} · ${seconds(part.ms)}`, style: `flex: ${part.ms} 1 0` })));
  const legend = el("div", { class: "legend" }, parts.map((part) => el("span", {},
    el("span", { class: `swatch k-${part.kind}` }), part.label, el("span", { class: "muted" }, `${seconds(part.ms)} · ${percent(part.ms, total)}`))));

  body.replaceChildren(el("div", { class: "trace" },
    tiles,
    el("section", { class: "trace-section" }, el("h3", {}, "Where the time went"), split, legend),
    el("section", { class: "trace-section" },
      el("div", { class: "trace-section-head" }, el("h3", {}, "Steps"),
        el("div", { class: "segmented", role: "group", "aria-label": "Order the steps" }, viewButtons)),
      el("div", { class: "tl" },
        el("div", { class: "tl-row tl-head" }, el("span", {}, "Ran in"), axis(total), el("span", { class: "tl-dur" }, "Busy")),
        lanes,
        el("div", { class: "tl-row tl-head" }, el("span", {}, "Step"), el("span"), el("span", { class: "tl-dur" }, "Took")),
        list)),
    el("div", { class: "trace-foot" },
      el("span", {}, "Spans carry timing, tool names, exit codes and token counts only; prompts, files and commands stay in the harness."),
      el("span", { style: "flex: 1 1 0" }), jaeger)));
  if (running) setTimeout(() => { if (isCurrent()) onLive(); }, 3000);
}
