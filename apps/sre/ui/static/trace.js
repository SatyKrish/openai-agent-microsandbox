// Copyright 2026 openai-agent-substrate contributors
// SPDX-License-Identifier: Apache-2.0
//
// A turn's trace: one line of totals, where each step ran (the workspace's lifecycle,
// the harness, the sandbox) and every step on one time axis, in order, slowest first
// or only the tool calls. Bars take their lane's colour; failed commands are red.
// Exit codes and token counts show when a step is opened, or at once when it failed.
// Jaeger has the span-level detail.

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
const TOOL_KINDS = ["tool", "skill", "error", "harness"];
const VIEWS = [
  { id: "order", label: "In order" },
  { id: "slowest", label: "Slowest first" },
  { id: "tools", label: "Tool calls" },
];

// The open step survives the re-renders of a running turn.
let selected = null;

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

function detail(row) {
  return el("div", { class: "tl-detail" },
    el("code", {}, row.label),
    el("span", { class: "muted" }, [laneOf(row).label, `at ${seconds(row.start_ms)}`, `took ${seconds(row.duration_ms)}`,
      row.badge].filter(Boolean).join(", ")));
}

const colour = (row) => (row.kind === "error" ? "k-error" : `k-${laneOf(row).id}`);

export async function renderTrace({ threadId, turn, body, config, setHead, isCurrent, onLive }) {
  if (!turn.otel_trace_id) {
    setHead(`Turn ${turn.number} trace`, "tracing is off");
    body.replaceChildren(el("div", { class: "empty" },
      el("h3", {}, "Tracing is off"),
      el("p", {}, "Set OTEL_EXPORTER_OTLP_ENDPOINT to an OTLP/HTTP collector such as Jaeger and JAEGER_URL to its " +
        "query address, then restart the harness.")));
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
    body.replaceChildren(el("p", { class: "note err" },
      "Jaeger is not reachable from the harness at its JAEGER_URL.", " ", jaeger));
    return;
  }
  const running = turn.status === "running";
  setHead(`Turn ${turn.number} trace`, `trace ${shortId} · ${data.span_count} spans${running ? " · live" : ""}`);
  const total = data.duration_ms || 1;
  const rows = data.rows;
  const byKey = new Map(rows.map((row) => [stepKey(row), row]));
  const toolRows = rows.filter((row) => TOOL_KINDS.includes(row.kind));
  const viewKey = `${config.name}:trace-view`;
  let view = VIEWS.some((item) => item.id === readStorage(viewKey)) ? readStorage(viewKey) : "order";

  const list = el("div", { class: "tl-list" });
  const lanes = el("div", { class: "tl-lanes" });
  const itemFor = (key) => [...list.children].find((item) => item.dataset.key === key);
  const setOpen = (item, open) => {
    item.classList.toggle("open", open);
    item.firstChild.setAttribute("aria-expanded", String(open));
    item.querySelector(".tl-detail")?.remove();
    if (open) item.append(detail(byKey.get(item.dataset.key)));
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
          row.error && row.badge ? el("span", { class: "pill err" }, row.badge) : null),
        el("span", { class: "tl-track" }, el("span", { class: `step-bar ${colour(row)}`, style: place(row, total) })),
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
        type: "button", class: `lane-bar ${colour(row)}${stepKey(row) === selected ? " selected" : ""}`, "data-key": stepKey(row),
        title: `${stepName(row)} · ${seconds(row.duration_ms)}`,
        "aria-label": [...new Set([stepName(row), KIND_LABELS[row.kind] || row.kind])].concat(seconds(row.duration_ms)).join(", "),
        style: place(row, total), onclick: () => select(row, true),
      }))),
      el("span", { class: "tl-dur" }, laneRows.length ? seconds(busy(laneRows)) : "—"));
  }));

  const failed = data.tools.failed;
  const totals = [running ? `${seconds(total)} so far` : seconds(total), plural(data.model.calls, "model call"),
    `${data.model.total_tokens.toLocaleString()} tokens`, plural(toolRows.length, "tool call"),
    failed ? `${failed} failed` : ""].filter(Boolean).join(", ");

  body.replaceChildren(el("div", { class: "trace" },
    el("p", { class: "trace-totals", title: `${data.model.input_tokens.toLocaleString()} tokens in, `
      + `${data.model.output_tokens.toLocaleString()} out` }, totals, jaeger),
    el("section", { class: "trace-section" },
      el("div", { class: "trace-section-head" }, el("h3", {}, "Steps"),
        el("div", { class: "segmented", role: "group", "aria-label": "Order the steps" }, viewButtons)),
      el("div", { class: "tl" },
        el("div", { class: "tl-row tl-head" }, el("span", {}, "Ran in"), axis(total), el("span", { class: "tl-dur" }, "Busy")),
        lanes,
        el("div", { class: "tl-row tl-head" }, el("span", {}, "Step"), el("span"), el("span", { class: "tl-dur" }, "Took")),
        list))));
  if (running) setTimeout(() => { if (isCurrent()) onLive(); }, 3000);
}
