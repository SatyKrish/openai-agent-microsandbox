// Copyright 2026 openai-agent-substrate contributors
// SPDX-License-Identifier: Apache-2.0
//
// The SRE agent's UI. ChatKit runs the conversation; around it the page shows the
// cluster's health on the start screen (sre.js), follow-up suggestions, what the agent
// remembers, and a side panel with the conversation's files and the turn's trace. The
// panel opens when a turn has something to show and stays collapsed once you collapse
// it. How the agent is contained is said once, in the How this works dialog. The
// harness's API serves the data.

import { $, el, formatBytes, getJSON, plural, readStorage, writeStorage } from "./dom.js";
import { findQuote, renderCode, renderText } from "./render.js";
import { renderFile as renderSreFile, renderHome as renderSreHome } from "./sre.js";
import { renderTrace } from "./trace.js";

const media = window.matchMedia("(prefers-color-scheme: dark)");
const wide = window.matchMedia("(min-width: 900px)");
const THREAD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const state = {
  config: { follow_ups: [], starting_files: [] },
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
  historyOpen: false, // ChatKit's own history view is showing
  worker: null, // the sandbox worker's description, when it answers
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
  return {
    api: { url: "/chatkit", domainKey: "local-dev" },
    initialThread: state.threadId,
    theme: {
      colorScheme: scheme, radius: "soft", density: "normal",
      color: { accent: { primary: scheme === "dark" ? "#8AA9F0" : "#2557D6", level: 1 } },
    },
    // Memory sits beside ChatKit's own history button; ChatKit draws header buttons from its own icon set.
    header: { enabled: true, title: { enabled: true },
      ...(state.config.memory ? { rightAction: { icon: "book-open", onClick: () => openMemory() } } : {}) },
    // Deleting a conversation deletes its sandbox, so it goes through this page's own confirmation.
    history: { enabled: true, showDelete: false, showRename: true },
    // Suggestions fill the composer from outside ChatKit, so you can read and edit them first.
    startScreen: { greeting: state.config.greeting || "", prompts: [] },
    composer: { placeholder: state.config.placeholder || "Ask the agent…", attachments: { enabled: false } },
    threadItemActions: { feedback: false, retry: true },
    widgets: {
      async onAction(action) {
        const payload = action.payload || {};
        if (action.type === "open_file") openPanel({ tab: "files", turn: payload.turn, view: { path: payload.path } });
        if (action.type === "open_trace") openPanel({ tab: "trace", turn: payload.turn });
        // An issue's card: the question to investigate it, in the composer to read and send.
        if (action.type === "investigate_issue" && payload.prompt) suggest(String(payload.prompt));
        // Cards saved before the Quotes tab went have this button; the findings show each quote with its source.
        if (action.type === "open_quotes") {
          openPanel({ tab: "files", turn: payload.turn, view: { path: "output/findings.json" } });
        }
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
  // While ChatKit shows its history, give it the whole pane.
  chatkit.addEventListener("chatkit.history.open", () => { state.historyOpen = true; render(); });
  chatkit.addEventListener("chatkit.history.close", () => { state.historyOpen = false; render(); });
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
    // A saved conversation opens the panel once it loads, if it has files; a new one starts with it closed.
    state.panelOpen = wide.matches && preference === "open";
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

/* ---------- Rendering ---------- */

function render() {
  renderHeader();
  renderStatus();
  renderSuggestions();
  renderHome();
  renderPanel();
}

function renderHeader() {
  $("conversation-menu-host").hidden = !state.threadId;
  const toggle = $("panel-toggle");
  toggle.setAttribute("aria-expanded", String(state.panelOpen));
  toggle.setAttribute("aria-label", state.panelOpen ? "Collapse files and trace" : "Show files and trace");
  const count = state.panelOpen ? 0 : unseenCount();
  $("panel-count").hidden = !count;
  $("panel-count").textContent = String(count);
  $("panel-count").title = plural(count, "new file");
}

function renderStatus() {
  $("elsewhere").hidden = state.thread?.state !== "elsewhere";
}

function renderSuggestions() {
  const box = $("suggestions");
  const turn = latestTurn();
  const running = state.responding || turn?.status === "running" || state.thread?.state === "elsewhere";
  const used = state.used.get(state.threadId || "_new") || new Set();
  // Follow-ups after a turn; the start screen has the health board instead.
  const items = (running || state.historyOpen || !turn ? [] : state.config.follow_ups).filter((item) => !used.has(item.prompt));
  if (!items?.length) {
    box.hidden = true;
    return;
  }
  box.replaceChildren(el("span", { class: "muted" }, "Next"),
    ...items.map((item) => el("button", { type: "button", title: item.prompt, onclick: () => suggest(item.prompt) }, item.label)));
  box.hidden = false;
}

// The start screen's health board (sre.js).
function renderHome() {
  const home = $("agent-home");
  if (state.historyOpen) {
    home.hidden = true;
    return;
  }
  const running = state.responding || latestTurn()?.status === "running";
  renderSreHome({ container: home, suggest, openIssue, config: state.config, threadId: state.threadId, running })
    .then(() => { if (state.historyOpen) home.hidden = true; })
    .catch((error) => console.warn("renderHome failed", error));
}

// Open an issue's conversation, with the question to investigate it in the composer.
async function openIssue(threadId, question) {
  await state.chatkit?.setThreadId(threadId);
  suggest(question);
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
  return renderFiles(turn, body, isCurrent);
}

function renderFiles(turn, body, isCurrent) {
  const files = filesUpTo(turn ? turn.number : 0);
  if (!files.length) {
    setHead(turn ? `Turn ${turn.number}` : "Workspace files", turn?.status === "running" ? "The agent is working…" : "");
    body.replaceChildren(el("div", { class: "empty" },
      el("h3", {}, turn ? "No files yet" : "Files appear here"),
      el("p", {}, "The evidence the agent reads and the findings it writes.")));
    return;
  }
  const bar = $("file-bar");
  let group = null;
  for (const file of files) {
    const index = groupOf(file.path);
    const label = index >= 0 ? GROUPS[index][1] : "Other";
    if (label !== group) {
      group = label;
      bar.append(el("span", { class: "file-group" }, label));
    }
    // Files from earlier turns are muted; only a failed check is marked.
    const earlier = turn && !file.start && file.turn !== turn.number;
    const failed = file.status?.state === "failed";
    // Evidence is named by the read that produced it; its file name is on hover.
    const name = file.evidence && file.command ? file.command : file.path.replace(/^(output|inputs|evidence|work)\//, "");
    bar.append(el("button", {
      type: "button", class: `file-chip${earlier ? " earlier" : ""}`, "data-path": file.path,
      "aria-pressed": String(state.view?.path === file.path),
      title: [file.path, file.status?.label, earlier ? `from turn ${file.turn}` : ""].filter(Boolean).join("\n"),
      onclick: () => apply({ tab: "files", view: { path: file.path } }),
    }, failed ? el("span", { class: "state-dot failed", "aria-label": "check failed" }) : null,
      el("span", { class: "file-chip-label" }, name)));
  }
  const path = state.view?.path && files.some((file) => file.path === state.view.path) ? state.view.path : defaultPath(turn, files);
  const file = files.find((item) => item.path === path);
  // A long list scrolls; keep the open file's chip in view.
  for (const chip of bar.querySelectorAll(".file-chip")) chip.setAttribute("aria-pressed", String(chip.dataset.path === path));
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
    body.replaceChildren(el("p", { class: "note" }, "Over the transfer limit, so it was not copied."));
    return;
  }
  const url = fileUrl(file);
  const download = $("download-link");
  download.href = `${url}?download=1`;
  download.hidden = false;
  const highlight = state.view?.path === file.path ? state.view.highlight : null;
  const page = state.view?.path === file.path ? state.view.page : null;
  const open = (path, quote = null) => apply({ tab: "files", view: { path, highlight: quote } });
  if (await renderSreFile({ file, body, url, highlight, open, check: turn?.check || null })) return;
  body.replaceChildren(el("div", { class: "empty" }, el("p", {}, "Loading…")));
  const response = await fetch(url);
  const text = response.ok ? await response.text() : "";
  if (!isCurrent()) return;
  const nodes = [];
  if (file.status?.state === "unchecked" && turn && file.turn === turn.number) {
    const checked = Object.entries(turn.file_status || {}).filter(([, item]) => item.state === "checked").map(([path]) => path.split("/").pop());
    nodes.push(el("p", { class: "note" }, `Not checked against the evidence${checked.length ? `; ${checked.join(", ")} is` : ""}.`));
  }
  if (!response.ok) {
    nodes.push(el("p", { class: "note err" }, "The file could not be loaded."));
  } else if (highlight) {
    const range = findQuote(text, highlight);
    if (!range) nodes.push(el("p", { class: "note err" }, "The quote is not in this copy of the file."));
    nodes.push(renderCode(text, range));
  } else {
    const rendered = renderText(name, text);
    if (rendered.document) body.className = "artifact-body document";
    nodes.push(rendered.node);
  }
  body.replaceChildren(...nodes);
}

/* ---------- Sandbox worker ---------- */

// One chip: what the agent reads and with which model, amber when the worker is down; it opens How this works.
async function refreshWorker() {
  if (!state.config.worker) return;
  const chip = $("context-chip");
  const { status, body } = await getJSON("/api/worker").catch(() => ({ status: 0, body: null }));
  state.worker = status === 200 ? body : null;
  chip.hidden = false;
  chip.classList.toggle("warn", !state.worker);
  $("context-dot").classList.toggle("ok", Boolean(state.worker));
  $("context-scope").textContent = (state.config.namespaces || []).join(", ");
  $("context-model").textContent = state.worker ? state.config.model || "" : "worker unreachable";
}

function openAbout() {
  const worker = state.worker;
  const facts = [
    ["Reads", (state.config.namespaces || []).join(", ")],
    ["Model", state.config.model],
    ["Worker", worker ? `${worker.worker_id}, MXC ${worker.containment}` : "unreachable; new turns fail until it is back"],
    ["Containers reach", worker?.egress],
  ].filter(([, value]) => value);
  $("about-facts").replaceChildren(...facts.flatMap(([name, value]) => [el("dt", {}, name), el("dd", {}, value)]));
  const days = state.config.memory_max_age_days;
  const memory = state.config.memory ? ["The agent starts each conversation from what it learned in earlier ones and "
    + `checks that against the cluster.${days ? ` A conversation is forgotten ${plural(days, "day")} after its last message.` : ""}`] : [];
  $("about-list").replaceChildren(...[...(state.config.about || []), ...memory].map((line) => el("li", {}, line)));
  $("about-dialog").showModal();
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

/* ---------- Memory ---------- */

// What the agent remembers across this user's conversations, shown over the chat like ChatKit's history:
// one entry per remembered conversation, grouped by day; open it, forget it, or forget everything.
function dayGroup(when) {
  const day = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((day(new Date()) - day(when)) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  if (days < 30) return "Previous 30 days";
  return when.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

async function renderMemory() {
  const body = $("memory-body");
  const { status, body: memory } = await getJSON("/api/memory?detail=1").catch(() => ({ status: 0, body: null }));
  if (status !== 200 || !memory) {
    body.replaceChildren(el("p", { class: "memory-error" }, "Memory is unavailable right now."));
    return;
  }
  $("memory-whose").textContent = memory.shared ? "Guest" : memory.user;
  $("memory-whose").title = memory.shared ? "Everyone who isn't signed in shares this memory." : "";
  const minutes = Math.round((state.config.idle_close_s || 300) / 60);
  if (!memory.remembered.length) {
    body.replaceChildren(el("p", { class: "memory-empty" }, "Nothing remembered yet. A conversation is remembered "
      + `once it has been idle for ${plural(minutes, "minute")}.`));
    return;
  }
  const groups = new Map();
  for (const item of memory.remembered) {
    const group = dayGroup(new Date(item.updated_at));
    groups.set(group, [...(groups.get(group) || []), item]);
  }
  const entry = (item) => el("li", { class: "memory-entry" },
    el("button", { type: "button", class: "memory-open", disabled: !item.open,
      title: `${item.description || item.id}\n${new Date(item.updated_at).toLocaleString()}`
        + (item.open ? "" : "\nThis conversation is no longer here."),
      onclick: () => openRemembered(item.id) }, item.description || item.id),
    el("button", { type: "button", class: "link-button danger memory-forget", "aria-label": "Forget this conversation",
      onclick: () => forgetMemory(item, memory.shared) }, "Forget"));
  body.replaceChildren(
    ...[...groups].flatMap(([group, items]) => [el("div", { class: "memory-group" }, group),
      el("ul", { class: "memory-list" }, items.map(entry))]),
    el("div", { class: "memory-more" },
      memory.text ? el("details", { class: "memory-section" }, el("summary", {}, "Summary the agent starts with"),
        el("pre", {}, memory.text)) : null,
      memory.index ? el("details", { class: "memory-section" }, el("summary", {}, "Everything it remembers (MEMORY.md)"),
        el("pre", {}, memory.index)) : null,
      el("div", { class: "memory-actions" },
        el("button", { type: "button", class: "link-button", title: "Tell the agent in a new conversation; it is "
          + "remembered when that conversation goes idle.", onclick: correctMemory }, "Correct something"),
        el("button", { type: "button", class: "link-button danger", onclick: () => forgetMemory(null, memory.shared) },
          "Forget everything…"))));
}

function openMemory() {
  $("memory-view").hidden = false;
  $("memory-back").focus();
  renderMemory();
}

function closeMemory() {
  $("memory-view").hidden = true;
}

function openRemembered(threadId) {
  closeMemory();
  state.chatkit?.setThreadId(threadId);
}

async function correctMemory() {
  closeMemory();
  await state.chatkit?.setThreadId(null);
  suggest("Something you remember is wrong: ");
}

async function forgetMemory(item, shared) {
  const dialog = $("forget-dialog");
  $("forget-title").textContent = item ? "Forget this conversation?" : "Forget everything?";
  $("forget-detail").textContent = item
    ? `"${item.description || item.id}" is removed from memory now; what the summary drew from it goes the next time `
      + "memory is updated. The conversation itself stays."
    : "Everything in this memory is removed now. Your conversations stay.";
  $("forget-shared").hidden = !shared;
  $("forget-confirm").textContent = item ? "Forget conversation" : "Forget everything";
  dialog.returnValue = "cancel";
  dialog.showModal();
  await new Promise((resolve) => dialog.addEventListener("close", resolve, { once: true }));
  if (dialog.returnValue !== "forget") return;
  const url = item ? `/api/memory/conversations/${encodeURIComponent(item.id)}` : "/api/memory";
  const response = await fetch(url, { method: "DELETE" }).catch(() => null);
  await renderMemory();
  if (!response?.ok && response?.status !== 404) {
    $("memory-body").prepend(el("p", { class: "memory-error" }, "Memory could not be changed. The server log has the cause."));
  }
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
    $("chat-error").textContent = response.status === 403 ? "Only an admin can delete an issue the team shares."
      : "The conversation could not be deleted. The server log has the cause.";
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

  const setSettings = popover("settings-button", "settings-panel");
  const setMenu = popover("conversation-menu-button", "conversation-menu");
  $("context-chip").addEventListener("click", openAbout);
  $("about-open").addEventListener("click", () => { setSettings(false); openAbout(); });
  if (state.config.memory) {
    $("memory-back").addEventListener("click", closeMemory);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !$("memory-view").hidden && !$("forget-dialog").open) closeMemory();
    });
  }
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
  state.panelOpen = wide.matches && panelPreference() === "open";
  setUrl();
  render();
  if (state.threadId) refreshThread({ followLatest: true, opening: true });
  refreshWorker();
  setInterval(() => { if (!document.hidden) { refreshWorker(); renderHome(); } }, 10000);
  await startChat();
}

main();
