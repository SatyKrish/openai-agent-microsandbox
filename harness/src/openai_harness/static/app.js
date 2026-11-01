// Copyright 2026 openai-agent-substrate contributors
// SPDX-License-Identifier: Apache-2.0
//
// The shared agent UI. ChatKit runs the conversation; around it the page shows the
// turn's result, suggestions, and a side panel with the conversation's files, the
// quotes the host checked and the turn's trace. The panel opens when a turn has
// something to show and stays collapsed once you collapse it. The agent's ui/
// folder configures all of this through /api/config, and its optional agent.js
// renders its own file types.

import { $, el, formatBytes, getJSON, plural, readStorage, writeStorage } from "./dom.js";
import { findQuote, renderCode, renderText } from "./render.js";
import { renderTrace } from "./trace.js";

const media = window.matchMedia("(prefers-color-scheme: dark)");
const wide = window.matchMedia("(min-width: 900px)");
const THREAD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const state = {
  config: { prompts: [], follow_ups: [], starting_files: [] },
  extension: {},
  chatkit: null,
  threadId: null,
  thread: null,
  turn: null, // the turn number the panel shows
  tab: "files",
  view: null, // { path, highlight? }
  panelOpen: false,
  responding: false,
  used: new Map(), // conversation -> suggestions already sent from it
  poll: null,
  themeChoice: "system",
};
const key = (name) => `${state.config.name || "agent"}:${name}`;

function readJSON(name) {
  try { return JSON.parse(readStorage(key(name)) || "{}"); } catch { return {}; }
}

function remember(name, threadKey, value) {
  const map = readJSON(name);
  delete map[threadKey];
  if (value !== null) map[threadKey] = value;
  // Keep the most recent entries only.
  writeStorage(key(name), JSON.stringify(Object.fromEntries(Object.entries(map).slice(-60))));
}

const panelPreference = () => readJSON("panel")[state.threadId || "_new"];
const seenTurn = () => readJSON("seen")[state.threadId] || 0;

/* ---------- Icons ---------- */

const ICON_PATHS = {
  document: ["M6 3h8l4 4v14H6z", "M14 3v4h4", "M9 13h6", "M9 17h4"],
  pulse: ["M3 12h4l3-8 4 16 3-8h4"],
  spark: ["M12 3v4", "M12 17v4", "M3 12h4", "M17 12h4", "M6 6l2.5 2.5", "M15.5 15.5 18 18", "M6 18l2.5-2.5", "M15.5 8.5 18 6"],
};

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [attr, value] of Object.entries({ width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round" })) svg.setAttribute(attr, value);
  for (const d of ICON_PATHS[name] || ICON_PATHS.spark) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/* ---------- Theme ---------- */

function resolvedScheme() {
  return state.themeChoice === "system" ? (media.matches ? "dark" : "light") : state.themeChoice;
}

function applyTheme() {
  document.documentElement.dataset.theme = resolvedScheme();
  for (const button of document.querySelectorAll("[data-theme-choice]")) {
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === state.themeChoice));
  }
  if (state.chatkit) state.chatkit.setOptions(chatkitOptions());
}

/* ---------- ChatKit ---------- */

function chatkitOptions() {
  const scheme = resolvedScheme();
  const uploads = state.config.uploads;
  const accept = {};
  for (const [extension, type] of Object.entries(uploads?.types || {})) (accept[type] ||= []).push(extension);
  return {
    // two_phase: attachments.create returns our upload URL, then the browser PUTs the file there.
    api: { url: "/chatkit", domainKey: "local-dev", ...(uploads ? { uploadStrategy: { type: "two_phase" } } : {}) },
    initialThread: state.threadId,
    theme: {
      colorScheme: scheme, radius: "round", density: "normal",
      color: { accent: { primary: scheme === "dark" ? "#97ADE9" : "#2F5BD3", level: 1 } },
    },
    header: { enabled: true, title: { enabled: true } },
    // Deleting a conversation deletes its sandbox, so it goes through this page's own confirmation.
    history: { enabled: true, showDelete: false, showRename: true },
    // Suggestions fill the composer from outside ChatKit, so you can read and edit them first.
    startScreen: { greeting: state.config.greeting || "", prompts: [] },
    composer: {
      placeholder: state.config.placeholder || "Ask the agent…",
      attachments: uploads
        ? { enabled: true, maxCount: uploads.max_count, maxSize: uploads.max_bytes, accept }
        : { enabled: false },
    },
    threadItemActions: { feedback: false, retry: true },
    widgets: {
      async onAction(action) {
        const payload = action.payload || {};
        if (action.type === "open_file") openPanel({ tab: "files", turn: payload.turn, view: { path: payload.path } });
        if (action.type === "open_trace") openPanel({ tab: "trace", turn: payload.turn });
        if (action.type === "open_quotes") openPanel({ tab: "quotes", turn: payload.turn });
      },
    },
  };
}

async function startChat() {
  try {
    await Promise.race([
      customElements.whenDefined("openai-chatkit"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 15000)),
    ]);
  } catch {
    const message = $("chat-error");
    message.textContent = "ChatKit did not load from cdn.platform.openai.com. Check your network, then reload.";
    message.hidden = false;
    return;
  }
  const chatkit = document.createElement("openai-chatkit");
  state.chatkit = chatkit;
  $("chat-host").append(chatkit);
  chatkit.addEventListener("chatkit.thread.change", (event) => selectThread(event.detail.threadId));
  chatkit.addEventListener("chatkit.response.start", () => {
    state.responding = true;
    $("stream-error").hidden = true;
    startPolling();
    refreshWorker();
    render();
  });
  chatkit.addEventListener("chatkit.response.end", async () => {
    state.responding = false;
    await refreshThread({ followLatest: true });
    refreshWorker();
  });
  chatkit.addEventListener("chatkit.effect", async (event) => {
    const { name, data } = event.detail || {};
    if (name === "open_file" && data && data.thread_id === state.threadId) {
      await refreshThread();
      showWhenRoom({ tab: "files", turn: data.turn, view: { path: data.path } });
    }
  });
  chatkit.addEventListener("chatkit.error", (event) => {
    // ChatKit only logs a refused or failed turn; say it where the person is looking.
    const message = event.detail?.error?.message;
    console.warn("ChatKit error", event.detail?.error);
    // The amber banner already says when another window or terminal is running a turn.
    if (message && state.thread?.state !== "elsewhere") {
      $("stream-error").textContent = message;
      $("stream-error").hidden = false;
    }
  });
  chatkit.setOptions(chatkitOptions());
}

function suggest(text) {
  if (!state.chatkit) return;
  const used = state.used.get(state.threadId || "_new") || new Set();
  state.used.set(state.threadId || "_new", used.add(text));
  state.chatkit.setComposerValue({ text });
  state.chatkit.focusComposer();
}

/* ---------- Conversation state ---------- */

function setUrl() {
  const url = new URL(window.location.href);
  if (state.threadId) url.searchParams.set("thread", state.threadId); else url.searchParams.delete("thread");
  window.history.replaceState(null, "", url);
}

function selectThread(threadId) {
  const previous = state.threadId;
  if (previous !== (threadId || null)) $("stream-error").hidden = true;
  state.threadId = threadId || null;
  writeStorage(key("thread"), state.threadId);
  setUrl();
  if (previous === state.threadId) return;
  const firstMessage = !previous && state.threadId && state.responding;
  if (firstMessage && state.panelOpen) remember("panel", state.threadId, "open");
  if (firstMessage && state.used.has("_new")) {
    state.used.set(state.threadId, state.used.get("_new"));
    state.used.delete("_new");
  }
  state.thread = null;
  state.turn = null;
  state.view = null;
  state.tab = "files";
  if (!firstMessage) {
    const preference = panelPreference();
    // A new conversation shows the files it starts with; a saved one opens the panel once it loads, if it has files.
    state.panelOpen = wide.matches && preference !== "closed"
      && (preference === "open" || (!state.threadId && state.config.starting_files.length > 0));
  }
  if (!state.threadId) {
    stopPolling();
    render();
    return;
  }
  refreshThread({ followLatest: true, opening: true });
}

async function refreshThread({ followLatest = false, opening = false } = {}) {
  if (!state.threadId) return render();
  const threadId = state.threadId;
  const { status, body } = await getJSON(`/api/threads/${encodeURIComponent(threadId)}`);
  if (threadId !== state.threadId) return;
  if (status !== 200) {
    state.thread = null;
    return render();
  }
  const before = state.thread?.turns?.length || 0;
  if (state.thread?.state === "elsewhere" && body.state !== "elsewhere") {
    // The other window or terminal finished its turn: show it in ChatKit, and the refusal no longer applies.
    $("stream-error").hidden = true;
    state.chatkit?.fetchUpdates();
    // The turn's card is stored just after the turn is marked finished.
    setTimeout(() => state.chatkit?.fetchUpdates(), 1500);
  }
  state.thread = body;
  const turns = body.turns || [];
  if (turns.length && (followLatest || state.turn === null || turns.length !== before)) {
    state.turn = turns[turns.length - 1].number;
    if (followLatest && state.tab === "files") state.view = null;
  }
  if (opening && wide.matches && panelPreference() === undefined && turns.some((turn) => (turn.files || []).length)) {
    state.panelOpen = true;
  }
  if (body.state === "running" || body.state === "elsewhere") startPolling(); else stopPolling();
  render();
}

function startPolling() {
  // While a turn runs, refresh the worker's session count too.
  if (!state.poll) state.poll = setInterval(() => { refreshThread(); refreshWorker(); }, 2000);
}
function stopPolling() {
  clearInterval(state.poll);
  state.poll = null;
}

const currentTurn = () => state.thread?.turns?.find((turn) => turn.number === state.turn) || null;
const latestTurn = () => state.thread?.turns?.at(-1) || null;

/* ---------- The panel: when it opens ---------- */

function openPanel({ tab = state.tab, turn = null, view = null } = {}) {
  state.panelOpen = true;
  remember("panel", state.threadId || "_new", "open");
  apply({ tab, turn, view });
}

// A turn wrote something: open the panel there, unless you collapsed it or the screen is narrow.
function showWhenRoom(target) {
  if (wide.matches && panelPreference() !== "closed") {
    state.panelOpen = true;
    apply(target);
  } else {
    render();
  }
}

function apply({ tab, turn, view }) {
  if (turn) state.turn = Number(turn);
  if (tab) state.tab = tab;
  if (view !== undefined) state.view = view;
  render();
}

function closePanel() {
  state.panelOpen = false;
  remember("panel", state.threadId || "_new", "closed");
  render();
  $("panel-toggle").focus();
}

// Output files changed in turns you have not seen in the panel.
function unseenCount() {
  if (!state.thread) return 0;
  const seen = seenTurn();
  return (state.thread.turns || []).filter((turn) => turn.number > seen && turn.status !== "running")
    .reduce((count, turn) => count + (turn.files || []).filter((file) => file.changed && file.path.startsWith("output/")).length, 0);
}

/* ---------- Files ---------- */

const GROUPS = [["output/", "Outputs"], ["inputs/", "Inputs"], ["evidence/", "Evidence"], ["work/", "Work"]];
const groupOf = (path) => GROUPS.findIndex(([prefix]) => path.startsWith(prefix));

function startingFiles() {
  // A conversation that began with uploads has no sample inputs (Document Intelligence records "sources").
  if (state.thread && state.thread.sources && state.thread.sources !== "samples") return [];
  return state.config.starting_files.map((file) => ({ ...file, start: true }));
}

function filesUpTo(turnNumber) {
  // The latest copy of every file collected up to this turn, plus the files the workspace started with.
  const latest = new Map();
  for (const file of startingFiles()) latest.set(file.path, file);
  for (const turn of state.thread?.turns || []) {
    if (turn.number > turnNumber) break;
    for (const file of turn.files || []) {
      latest.set(file.path, { ...file, turn: turn.number, status: (turn.file_status || {})[file.path] });
    }
  }
  const order = (path) => { const group = groupOf(path); return group < 0 ? GROUPS.length : group; };
  return [...latest.values()].sort((a, b) => order(a.path) - order(b.path) || a.path.localeCompare(b.path));
}

function fileUrl(file) {
  const parts = file.path.split("/").map(encodeURIComponent).join("/");
  return file.start ? `/api/starting-files/${parts}`
    : `/api/threads/${encodeURIComponent(state.threadId)}/turns/${file.turn}/files/${parts}`;
}

function defaultPath(turn, files) {
  if (!turn) return files[0]?.path || null;
  const status = turn.file_status || {};
  const changed = (turn.files || []).filter((file) => file.changed && file.path.startsWith("output/") && !file.too_large).map((file) => file.path);
  const checked = changed.filter((path) => status[path]?.state === "checked");
  const preferred = state.config.preferred_output;
  if (checked.length) return checked.includes(preferred) ? preferred : checked[0];
  if (changed.length) return changed.includes(preferred) ? preferred : changed[0];
  return files.find((file) => file.path.startsWith("output/"))?.path || files[0]?.path || null;
}

function badgeFor(file, turn) {
  if (!turn || file.turn !== turn.number || !file.changed) return null;
  return file.upload ? "uploaded" : file.evidence ? "read" : file.new ? "new" : "changed";
}

/* ---------- Rendering ---------- */

function render() {
  renderHeader();
  renderStatus();
  renderResult();
  renderSuggestions();
  renderPanel();
}

function renderHeader() {
  $("thread-title").textContent = state.thread?.title || state.config.new_label || "New conversation";
  $("conversation-menu-host").hidden = !state.threadId;
  const toggle = $("panel-toggle");
  toggle.setAttribute("aria-expanded", String(state.panelOpen));
  toggle.setAttribute("aria-label", state.panelOpen ? "Collapse files and trace" : "Show files and trace");
  const count = state.panelOpen ? 0 : unseenCount();
  $("panel-count").hidden = !count;
  $("panel-count").textContent = `${count} new`;
}

function renderStatus() {
  const thread = state.thread;
  const text = $("workspace-text");
  $("workspace-dot").classList.toggle("running", thread?.state === "running" || thread?.state === "elsewhere");
  $("elsewhere").hidden = thread?.state !== "elsewhere";
  if (!thread || !thread.workspace) {
    text.textContent = "No workspace yet · the first message creates an MXC session";
  } else if (thread.state === "running") {
    text.textContent = `Turn running · ${thread.workspace} · each command in its own MXC container`;
  } else if (thread.state === "elsewhere") {
    text.textContent = `Workspace in use by another window · ${thread.workspace}`;
  } else {
    const reopened = (thread.turns || []).filter((turn) => turn.lifecycle === "reopened").length;
    const kept = reopened ? `kept on the worker's volume, reopened ${plural(reopened, "time")}` : "kept on the worker's volume";
    text.textContent = `Workspace idle · ${thread.workspace} · ${kept} · nothing runs between turns`;
  }
}

function checkHeadline(turn) {
  if (turn.status === "failed") return { tone: "err", text: `Turn ${turn.number} failed (${turn.error || "error"})` };
  if (turn.status === "stopped") return { tone: "", text: `Turn ${turn.number} was stopped` };
  const check = turn.check || {};
  const status = turn.file_status || {};
  const changed = (turn.files || []).filter((file) => file.changed && file.path.startsWith("output/")).map((file) => file.path);
  const name = (path) => path.split("/").pop();
  if ((check.status || "").includes("failed")) return { tone: "err", text: `Host check failed${check.detail ? `: ${check.detail}` : ""}` };
  const checked = changed.filter((path) => status[path]?.state === "checked");
  if (checked.length) return { tone: "ok", text: `Checked on the host: ${checked.map(name).join(", ")}` };
  if (changed.length) return { tone: "warn", text: `Not checked on the host: ${changed.map(name).join(", ")}` };
  return { tone: "", text: "No output files changed · nothing to check" };
}

function renderResult() {
  const bar = $("result-bar");
  const turn = latestTurn();
  if (!turn || state.responding || turn.status === "running" || state.thread?.state === "elsewhere") {
    bar.hidden = true;
    return;
  }
  const headline = checkHeadline(turn);
  const preferred = defaultPath(turn, filesUpTo(turn.number));
  const quotes = (turn.check?.quotes_from && (turn.files || []).some((file) => file.path === turn.check.quotes_from && file.changed)) ? (turn.check.checked_quotes || []).length : 0;
  bar.replaceChildren(
    el("span", { class: `result-state ${headline.tone}` }, headline.text),
    el("span", { class: "muted" }, `Turn ${turn.number}${turn.duration_s !== undefined ? ` · ${turn.duration_s} s` : ""}`),
    el("span", { class: "result-actions" },
      preferred ? el("button", { type: "button", onclick: () => openPanel({ tab: "files", turn: turn.number, view: { path: preferred } }) },
        `Open ${preferred.split("/").pop()}`) : null,
      quotes ? el("button", { type: "button", onclick: () => openPanel({ tab: "quotes", turn: turn.number }) }, `Show ${plural(quotes, "quote")}`) : null,
      turn.otel_trace_id ? el("button", { type: "button", onclick: () => openPanel({ tab: "trace", turn: turn.number }) }, "Trace") : null));
  bar.hidden = false;
}

function renderSuggestions() {
  const box = $("suggestions");
  const turn = latestTurn();
  const running = state.responding || turn?.status === "running" || state.thread?.state === "elsewhere";
  const used = state.used.get(state.threadId || "_new") || new Set();
  const items = (running ? [] : !state.threadId ? state.config.prompts : turn ? state.config.follow_ups : [])
    .filter((item) => !used.has(item.prompt));
  if (!items?.length) {
    box.hidden = true;
    return;
  }
  box.replaceChildren(el("span", { class: "muted" }, state.threadId ? "Next" : "Try"),
    ...items.map((item) => el("button", { type: "button", title: item.prompt, onclick: () => suggest(item.prompt) }, item.label)));
  box.hidden = false;
}

function setHead(title, sub) {
  $("artifact-title").textContent = title;
  $("artifact-sub").textContent = sub;
}

function renderPanel() {
  const panel = $("side-panel");
  $("workspace").dataset.panel = state.panelOpen ? "open" : "closed";
  panel.hidden = !state.panelOpen;
  if (!state.panelOpen) return;
  const latest = latestTurn();
  if (latest && latest.status !== "running") remember("seen", state.threadId, latest.number);
  const turn = currentTurn();
  const quotes = turn?.check?.checked_quotes || [];
  if (state.tab === "quotes" && !quotes.length) state.tab = "files";
  $("tab-quotes").hidden = !quotes.length;
  $("tab-trace").hidden = !state.threadId;
  if (!state.threadId && state.tab === "trace") state.tab = "files";
  for (const tab of document.querySelectorAll("[data-tab]")) tab.setAttribute("aria-selected", String(tab.dataset.tab === state.tab));
  $("trace-live").hidden = turn?.status !== "running";

  const select = $("turn-select");
  const turns = state.thread?.turns || [];
  select.replaceChildren(...turns.map((item) => el("option", { value: item.number, selected: item.number === state.turn },
    `Turn ${item.number}${item.status === "running" ? " · running" : item.status === "failed" ? " · failed" : ""}`)));
  select.hidden = turns.length < 2;

  const body = $("artifact-body");
  body.className = "artifact-body";
  $("download-link").hidden = true;
  $("file-bar").replaceChildren();
  $("file-bar").hidden = state.tab !== "files";
  const viewKey = `${state.threadId}:${state.turn}:${state.tab}:${state.view?.path}:${state.view?.highlight || ""}:${state.view?.page || ""}`;
  body.dataset.view = viewKey;
  const isCurrent = () => body.dataset.view === viewKey;
  if (state.tab === "trace" && turn) {
    return renderTrace({ threadId: state.threadId, turn, body, config: state.config, setHead, isCurrent,
      onLive: () => { if (isCurrent()) renderTrace({ threadId: state.threadId, turn: currentTurn() || turn, body, config: state.config, setHead, isCurrent, onLive: () => renderPanel() }); } });
  }
  if (state.tab === "quotes" && turn) return renderQuotes(turn, quotes, body);
  return renderFiles(turn, body, isCurrent);
}

function renderFiles(turn, body, isCurrent) {
  const files = filesUpTo(turn ? turn.number : 0);
  if (!files.length) {
    setHead(turn ? `Turn ${turn.number}` : "Workspace files", turn?.status === "running" ? "The agent is working…" : "");
    body.replaceChildren(el("div", { class: "empty" },
      el("h3", {}, turn ? "No files yet" : "Files appear here"),
      el("p", {}, state.config.intro || "After each turn the server copies the agent's files here and checks them on the host.")));
    return;
  }
  const bar = $("file-bar");
  if (!state.thread?.turns?.length && state.config.starting_note) bar.append(el("p", { class: "file-note" }, state.config.starting_note));
  let group = null;
  for (const file of files) {
    const index = groupOf(file.path);
    const label = index >= 0 ? GROUPS[index][1] : "Other";
    if (label !== group) {
      group = label;
      bar.append(el("span", { class: "file-group" }, label));
    }
    const badge = badgeFor(file, turn);
    const tone = file.status?.state || (file.start ? "source" : "");
    bar.append(el("button", {
      type: "button", class: `file-chip ${tone}`, "aria-pressed": String(state.view?.path === file.path),
      title: [file.path, file.status?.label].filter(Boolean).join(" · "),
      onclick: () => apply({ tab: "files", view: { path: file.path } }),
    }, tone && tone !== "source" ? el("span", { class: `state-dot ${tone}`, "aria-hidden": "true" }) : null,
      file.path.replace(/^(output|inputs|evidence|work)\//, ""), badge ? el("span", { class: "badge" }, badge) : null));
  }
  const path = state.view?.path && files.some((file) => file.path === state.view.path) ? state.view.path : defaultPath(turn, files);
  const file = files.find((item) => item.path === path);
  // A long list scrolls; keep the open file's chip in view.
  for (const chip of bar.querySelectorAll(".file-chip")) chip.setAttribute("aria-pressed", String(chip.title.split(" · ")[0] === path));
  bar.querySelector('.file-chip[aria-pressed="true"]')?.scrollIntoView({ block: "nearest" });
  if (!file) return;
  renderFile(turn, file, body, isCurrent);
}

async function renderFile(turn, file, body, isCurrent) {
  const name = file.path.split("/").pop();
  const status = file.status?.label || (file.start ? "starting file" : "");
  setHead(name, [file.path, file.too_large ? "over the transfer limit" : formatBytes(file.bytes),
    file.start ? "" : turn && file.turn === turn.number ? `turn ${file.turn}` : `from turn ${file.turn}`, status].filter(Boolean).join(" · "));
  if (file.too_large) {
    body.replaceChildren(el("div", { class: "notice warn" }, "This file is larger than the provider's transfer limit and was not copied."));
    return;
  }
  const url = fileUrl(file);
  const download = $("download-link");
  download.href = `${url}?download=1`;
  download.hidden = false;
  const highlight = state.view?.path === file.path ? state.view.highlight : null;
  const page = state.view?.path === file.path ? state.view.page : null;
  if (state.extension.renderFile && await state.extension.renderFile({ file, turn, threadId: state.threadId, body, el, url, highlight, page })) return;
  body.replaceChildren(el("div", { class: "empty" }, el("p", {}, "Loading…")));
  const response = await fetch(url);
  const text = response.ok ? await response.text() : "";
  if (!isCurrent()) return;
  const nodes = [];
  if (file.status?.state === "unchecked" && turn && file.turn === turn.number) {
    const checked = Object.entries(turn.file_status || {}).filter(([, item]) => item.state === "checked").map(([path]) => path.split("/").pop());
    nodes.push(el("div", { class: "notice warn" }, `Not checked on the host: ${name} is the agent's own work.`,
      checked.length ? ` The host checked ${checked.join(", ")}.` : ""));
  }
  if (!response.ok) {
    nodes.push(el("div", { class: "notice err" }, "The file could not be loaded."));
  } else if (highlight) {
    const range = findQuote(text, highlight);
    nodes.push(el("div", { class: `notice ${range ? "ok" : "warn"}` }, range
      ? "The quote, highlighted in the host's copy of the source."
      : "The quote is not in this copy of the source."));
    nodes.push(renderCode(text, range));
  } else {
    const rendered = renderText(name, text);
    if (rendered.document) body.className = "artifact-body document";
    nodes.push(rendered.node);
  }
  body.replaceChildren(...nodes);
}

function renderQuotes(turn, quotes, body) {
  setHead("Checked quotes", `${plural(quotes.length, "quote")} · each appears in the host's copy of the source it cites`);
  const bySource = new Map();
  for (const quote of quotes) {
    if (!bySource.has(quote.source)) bySource.set(quote.source, []);
    bySource.get(quote.source).push(quote);
  }
  body.replaceChildren(el("div", { class: "quotes" }, [...bySource.entries()].map(([source, items]) => el("section", { class: "quote-group" },
    el("h3", {}, source),
    items.map((quote) => el("figure", { class: `quote ${quote.kind === "visual" ? "visual" : ""}` },
      el("blockquote", {}, `“${quote.quote}”`),
      el("figcaption", {},
        quote.context ? el("span", { class: "muted" }, quote.context) : null,
        quote.page ? el("span", { class: "muted" }, `page ${quote.page}`) : null,
        quote.kind === "visual" ? el("span", { class: "pill" }, "read from the page image · review") : null,
        el("button", { type: "button", onclick: () => apply({ tab: "files", view: { path: source, page: quote.page,
          highlight: quote.page ? null : quote.quote } }) },
          "Show in source"))))))));
}

/* ---------- Sandbox worker ---------- */

async function refreshWorker() {
  if (!state.config.worker) return;
  const chip = $("capacity");
  const { status, body } = await getJSON("/api/worker");
  chip.hidden = false;
  chip.classList.toggle("warn", status !== 200);
  if (status !== 200) {
    chip.textContent = "Sandbox worker unreachable";
    chip.title = "The harness cannot reach its MXC sandbox worker; new turns fail until it is back.";
    return;
  }
  chip.textContent = `${body.worker_id} · MXC ${body.containment} · ${plural(body.active_sessions, "session")}`;
  chip.title = `The paired sandbox worker for ${body.domain}. Egress from its containers: ${body.egress}. MXC SDK ${body.mxc_sdk_version}.`;
}

/* ---------- Menus and dialogs ---------- */

function popover(buttonId, panelId) {
  const button = $(buttonId);
  const panel = $(panelId);
  const setOpen = (open, { returnFocus = false } = {}) => {
    panel.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    if (open) (panel.querySelector('[aria-pressed="true"]') || panel.querySelector("button"))?.focus();
    else if (returnFocus) button.focus();
  };
  button.addEventListener("click", () => setOpen(panel.hidden));
  document.addEventListener("click", (event) => {
    if (!panel.hidden && !button.parentElement.contains(event.target)) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) setOpen(false, { returnFocus: true });
  });
  // Clicks inside ChatKit's frame never reach this document; focus leaving the window does.
  window.addEventListener("blur", () => { if (!panel.hidden) setOpen(false); });
  return setOpen;
}

async function deleteConversation() {
  const threadId = state.threadId;
  const dialog = $("delete-dialog");
  $("delete-workspace").textContent = state.thread?.workspace ? `Session ${state.thread.workspace}` : "This conversation has no workspace yet.";
  dialog.returnValue = "cancel";
  dialog.showModal();
  await new Promise((resolve) => dialog.addEventListener("close", resolve, { once: true }));
  if (dialog.returnValue !== "delete" || threadId !== state.threadId) return;
  const response = await fetch("/chatkit", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "threads.delete", params: { thread_id: threadId } }) });
  if (!response.ok) {
    $("chat-error").textContent = "The conversation could not be deleted. The server log has the cause.";
    $("chat-error").hidden = false;
    return;
  }
  remember("panel", threadId, null);
  remember("seen", threadId, null);
  await state.chatkit?.setThreadId(null);
  selectThread(null);
}

/* ---------- Start ---------- */

async function main() {
  const { body: config } = await getJSON("/api/config");
  state.config = { ...state.config, ...config };
  state.themeChoice = readStorage(key("theme")) || "system";
  document.title = state.config.title || document.title;
  $("brand-icon").replaceChildren(icon(state.config.icon));
  $("brand-name").textContent = state.config.title || "Agent";
  $("new-label").textContent = state.config.new_label || "New conversation";
  $("model-name").textContent = state.config.model || "";
  // The specific part first, so a narrow header cuts the cluster name rather than the scope.
  $("scope").textContent = state.config.scope || "";
  $("scope").title = $("scope").textContent;
  $("scope").hidden = !$("scope").textContent;
  if (state.config.stylesheet) document.head.append(el("link", { rel: "stylesheet", href: state.config.stylesheet }));
  if (state.config.extension) {
    try { state.extension = await import(state.config.extension); } catch (error) { console.warn("agent.js failed to load", error); }
  }

  const setSettings = popover("settings-button", "settings-panel");
  const setMenu = popover("conversation-menu-button", "conversation-menu");
  for (const button of document.querySelectorAll("[data-theme-choice]")) {
    button.addEventListener("click", () => {
      state.themeChoice = button.dataset.themeChoice;
      writeStorage(key("theme"), state.themeChoice === "system" ? null : state.themeChoice);
      applyTheme();
      setSettings(true);
    });
  }
  $("copy-link").addEventListener("click", async () => {
    setMenu(false);
    const url = new URL("/", window.location.href);
    url.searchParams.set("thread", state.threadId);
    try { await navigator.clipboard.writeText(url.href); } catch { window.prompt("Copy this link", url.href); }
  });
  $("delete-conversation").addEventListener("click", () => { setMenu(false); deleteConversation(); });
  media.addEventListener("change", () => { if (state.themeChoice === "system") applyTheme(); });
  wide.addEventListener("change", () => render());
  applyTheme();
  // With new files waiting, the toggle opens on the newest; otherwise where you left the panel.
  $("panel-toggle").addEventListener("click", () => (state.panelOpen ? closePanel()
    : openPanel(unseenCount() ? { tab: "files", turn: latestTurn()?.number, view: null } : {})));
  $("panel-close").addEventListener("click", closePanel);
  for (const tab of document.querySelectorAll("[data-tab]")) tab.addEventListener("click", () => apply({ tab: tab.dataset.tab }));
  $("turn-select").addEventListener("change", (event) => apply({ turn: Number(event.target.value), view: null }));
  $("new-conversation").addEventListener("click", () => state.chatkit?.setThreadId(null));

  // A link names its conversation (?thread=); otherwise reopen the one you had open.
  const linked = new URLSearchParams(window.location.search).get("thread");
  const initial = linked && THREAD_ID.test(linked) ? linked : readStorage(key("thread"));
  state.threadId = initial && THREAD_ID.test(initial) ? initial : null;
  const preference = panelPreference();
  state.panelOpen = wide.matches && preference !== "closed"
    && (preference === "open" || (!state.threadId && state.config.starting_files.length > 0));
  setUrl();
  render();
  if (state.threadId) refreshThread({ followLatest: true, opening: true });
  refreshWorker();
  setInterval(() => { if (!document.hidden) refreshWorker(); }, 10000);
  await startChat();
}

main();
