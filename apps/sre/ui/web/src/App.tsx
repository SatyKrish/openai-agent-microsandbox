// Copyright 2026 openai-agent-mxc contributors
// SPDX-License-Identifier: Apache-2.0
//
// The SRE agent's page, after Artifacts: on the left, the cluster's health now with the issue for each
// unhealthy workload, then History (your conversations) and Memory (what the agent remembers from them);
// in the middle the conversation, where each turn is a short reply and a card for the findings it wrote;
// and on the right the panel, which holds the findings (a document with a version per turn that rewrote
// them) and everything they rest on. The start screen is the health board. How the agent is contained is
// said once, in the How this works dialog. Everything comes from the harness's API.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { loadHealth, renderHome } from "../../static/sre.js";

import { api, workloadKey, type Config, type Conversation, type Health, type TurnRecord, type Workload } from "./api";
import { Chat } from "./Chat";
import { toMessages, useConversation } from "./conversation";
import { HealthList } from "./Health";
import { MemoryList } from "./Memory";
import { Panel, type View } from "./Panel";
import { CardActionsContext } from "./parts";
import { TurnContext } from "./Turn";

type Theme = "system" | "light" | "dark";
type Tab = "history" | "memory";
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const media = window.matchMedia("(prefers-color-scheme: dark)");
const wide = window.matchMedia("(min-width: 900px)");

function stored(key: string): string | null {
  try { return localStorage.getItem(`sre:${key}`); } catch { return null; }
}
function store(key: string, value: string | null) {
  try { if (value === null) localStorage.removeItem(`sre:${key}`); else localStorage.setItem(`sre:${key}`, value); } catch { /* private window */ }
}

function ago(iso: string): string {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

function initialConversation(): string | null {
  const linked = new URLSearchParams(location.search).get("c");
  const id = linked || stored("conversation");
  return id && ID.test(id) ? id : null;
}

// The left column's icons, the same whether it is open or collapsed.
const ICONS = {
  collapse: "M3 4h18v16H3zM9 4v16M16 10l-2 2 2 2",
  expand: "M3 4h18v16H3zM9 4v16M14 10l2 2-2 2",
  new: "M12 5v14M5 12h14",
  history: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5M12 7v5l4 2",
  memory: "M2 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H2zM22 4h-7a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h8z",
};
const NO_TURNS: TurnRecord[] = [];

function Icon({ path, size = 18 }: { path: string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>;
}

/** The health board on the start screen, drawn by the page's own view (../static/sre.js). */
function Board({ config, onSuggest, onOpenIssue }: {
  config: Config; onSuggest: (text: string) => void; onOpenIssue: (id: string, question: string) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const draw = () => ref.current && renderHome({ container: ref.current, suggest: onSuggest, openIssue: onOpenIssue,
      config, threadId: null, running: false }).catch(() => {});
    draw();
    const timer = setInterval(() => { if (!document.hidden) draw(); }, 10_000);
    return () => clearInterval(timer);
  }, [config, onSuggest, onOpenIssue]);
  return <section className="agent-home ax-board" ref={ref} aria-live="polite" />;
}

/** The left column: its actions as icons with their names, and under them History (health now, the issues and
 * your conversations) or Memory. Collapsed, it is the same icons in the same places, each named on hover, and
 * History keeps its count of unhealthy workloads in view. On a phone it opens over the conversation. */
function Sidebar({ collapsed, onToggle, conversations, current, onSelect, onNew, onInvestigate, tab, onTab, memory, health }: {
  collapsed: boolean; onToggle: () => void; conversations: Conversation[]; current: string | null; onSelect: (id: string) => void;
  onNew: () => void; onInvestigate: (question: string) => void; tab: Tab; onTab: (tab: Tab) => void; memory: ReactNode;
  health: Health | null | undefined;
}) {
  const issues = new Map(conversations.filter((item) => item.issue?.state === "open").map((item) => [item.issue!.fingerprint, item]));
  // Open issues show under Health now, by their workload; the rest (the health board unread, say) are listed here.
  const unhealthy = (health?.namespaces || []).flatMap(({ namespace, workloads }) => workloads
    .filter((workload) => workload.state !== "healthy").map((workload) => workloadKey(namespace, workload.kind, workload.name)));
  const shown = new Set(unhealthy);
  const open = [...issues.values()].filter((item) => !shown.has(item.issue!.fingerprint));
  const mine = conversations.filter((item) => !item.issue);
  const recovered = conversations.filter((item) => item.issue && item.issue.state !== "open");
  const running = conversations.some((item) => item.state === "running");
  const row = (item: Conversation) => (
    <li key={item.id}>
      <button type="button" className="ax-conversation" aria-current={item.id === current ? "page" : undefined}
        onClick={() => onSelect(item.id)} title={item.title || item.id}>
        {item.issue ? <span className={`ax-dot ${item.issue.state === "open" ? "failing" : ""}`} aria-hidden="true" /> : null}
        <span className="ax-conversation-text">
          <span className="ax-conversation-title">{item.title || "New conversation"}</span>
          <span className="ax-conversation-meta">{item.state === "running" ? "running" : [ago(item.issue?.recovered_at || item.created_at),
            item.issue?.state === "recovered" ? "recovered" : "", item.turns ? `${item.turns} turn${item.turns === 1 ? "" : "s"}` : "not investigated"]
            .filter(Boolean).join(" · ")}</span>
        </span>
        {item.state === "running" ? <span className="ax-running" aria-label="running" /> : null}
      </button>
    </li>
  );
  // A section's icon opens it, and opens the column when it is collapsed.
  const show = (name: Tab) => { onTab(name); if (collapsed) onToggle(); };
  const item = (key: string, icon: string, label: string, onClick: () => void, selected = false, badge: ReactNode = null, hint = label) => (
    <button key={key} type="button" className={`ax-nav-item ${key}`} aria-current={selected ? "true" : undefined}
      aria-label={collapsed ? hint : undefined} data-tip={hint} onClick={onClick}>
      <span className="ax-nav-icon"><Icon path={icon} size={key === "new" ? 14 : 18} /></span>
      <span className="ax-nav-label">{label}</span>
      {badge}
    </button>
  );
  const issuesHint = unhealthy.length ? `History: ${unhealthy.length} unhealthy workload${unhealthy.length === 1 ? "" : "s"}` : "History";
  return (
    <nav className="ax-sidebar" data-collapsed={collapsed} aria-label="History and memory">
      <div className="ax-sidebar-head">
        <button type="button" className="icon-button ax-sidebar-toggle" aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand the sidebar" : "Collapse the sidebar"} data-tip={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}
          onClick={onToggle}>
          <Icon path={collapsed ? ICONS.expand : ICONS.collapse} />
        </button>
      </div>
      <div className="ax-nav">
        {item("new", ICONS.new, "New investigation", onNew)}
        {item("history", ICONS.history, "History", () => show("history"), !collapsed && (tab === "history" || !memory),
          unhealthy.length ? <span className="ax-nav-badge" aria-hidden="true">{unhealthy.length}</span>
            : running ? <span className="ax-running ax-nav-badge" aria-hidden="true" /> : null, issuesHint)}
        {memory ? item("memory", ICONS.memory, "Memory", () => show("memory"), !collapsed && tab === "memory") : null}
      </div>
      {collapsed ? null : memory && tab === "memory" ? <div className="ax-sidebar-body">{memory}</div> : (
        <div className="ax-sidebar-body" aria-label="History">
          <HealthList health={health} issues={issues} current={current} onOpen={onSelect} onInvestigate={onInvestigate} />
          {open.length ? <><h2 className="ax-list-head">Open issues</h2><ul className="ax-list">{open.map(row)}</ul></> : null}
          <h2 className="ax-list-head">Conversations</h2>
          {mine.length ? <ul className="ax-list">{mine.map(row)}</ul> : <p className="ax-list-empty">None yet.</p>}
          {recovered.length ? <><h2 className="ax-list-head">Recovered</h2><ul className="ax-list">{recovered.map(row)}</ul></> : null}
        </div>
      )}
    </nav>
  );
}

export function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [current, setCurrent] = useState<string | null>(initialConversation);
  const [thread, setThread] = useState<any>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [view, setView] = useState<View>({ tab: "files" });
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null);
  const [tab, setTab] = useState<Tab>(() => (stored("tab") === "memory" ? "memory" : "history"));
  // Open on a wide screen unless it was collapsed there; on a phone it opens over the conversation when asked.
  const [sidebarOpen, setSidebarOpen] = useState(() => wide.matches && stored("sidebar") !== "collapsed");
  const [theme, setTheme] = useState<Theme>(() => (stored("theme") as Theme) || "system");
  const [worker, setWorker] = useState<any>(null);
  const [workerDown, setWorkerDown] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null | undefined>(undefined);
  const about = useRef<HTMLDialogElement>(null);
  const linked = useRef(new URLSearchParams(location.search).get("c"));
  const settings = useRef<HTMLDetailsElement>(null);

  useEffect(() => { api.config().then(setConfig, () => setNotice("The harness did not answer. Reload when it is back.")); }, []);

  // Theme: the operating system's, or the one chosen here.
  useEffect(() => {
    const apply = () => { document.documentElement.dataset.theme = theme === "system" ? (media.matches ? "dark" : "light") : theme; };
    apply();
    store("theme", theme === "system" ? null : theme);
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  const refreshList = useCallback(() => { api.conversations().then(setConversations, () => {}); }, []);
  const refreshThread = useCallback(() => {
    if (!current) { setThread(null); return; }
    api.thread(current).then(setThread, () => setThread(null));
  }, [current]);
  useEffect(() => {
    refreshList();
    const timer = setInterval(() => { if (!document.hidden) refreshList(); }, 10_000);
    return () => clearInterval(timer);
  }, [refreshList]);
  useEffect(() => {
    refreshThread();
    const url = new URL(location.href);
    if (current) url.searchParams.set("c", current); else url.searchParams.delete("c");
    history.replaceState(null, "", url);
    store("conversation", current);
    setView({ tab: "files" });
  }, [current, refreshThread]);
  useEffect(() => {
    const check = () => fetch("/api/worker").then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((body) => { setWorker(body); setWorkerDown(false); }, () => setWorkerDown(true));
    check();
    const timer = setInterval(() => { if (!document.hidden) check(); }, 15_000);
    return () => clearInterval(timer);
  }, []);

  // The cluster's health, kept beside the conversation; the start screen's board reads the same copy.
  useEffect(() => {
    if (!config?.health) return;
    const read = () => (loadHealth() as Promise<{ status: number; body: Health | null }>).then(({ status, body }) =>
      setHealth(status === 200 && body ? body : null));
    read();
    const timer = setInterval(() => { if (!document.hidden) read(); }, 10_000);
    return () => clearInterval(timer);
  }, [config]);
  const workloads = useMemo(() => new Map<string, Workload>((health?.namespaces || []).flatMap(({ namespace, workloads: items }) =>
    items.map((workload) => [workloadKey(namespace, workload.kind, workload.name), workload] as const))), [health]);

  const conversation = useConversation(current, {
    onTurnEnd: () => { refreshThread(); refreshList(); },
    // A turn that wrote the findings opens them beside the conversation, as a new artifact opens; on a phone the
    // card's Open findings does.
    onEffect: (name, data) => {
      if (name === "open_file" && wide.matches) {
        refreshThread();
        setPanelOpen(true);
        setView({ tab: "files", turn: Number(data.turn), path: String(data.path) });
      }
    },
    onTitle: () => refreshList(),
    // A remembered conversation that is gone opens the start screen; a link to one says why.
    onMissing: (id) => {
      setCurrent(null);
      if (id === linked.current) setNotice("That conversation isn't here: it was deleted, or it isn't yours.");
    },
  });
  const messages = useMemo(() => toMessages(conversation.entries, conversation.streaming, conversation.running),
    [conversation.entries, conversation.streaming, conversation.running]);

  const suggest = useCallback((text: string) => setPrefill({ text, nonce: Date.now() }), []);
  const clearPrefill = useCallback(() => setPrefill(null), []);
  const select = useCallback((id: string | null) => {
    setNotice(null);
    setCurrent(id);
    if (!wide.matches) setSidebarOpen(false);
  }, []);
  const chooseTab = useCallback((name: Tab) => { setTab(name); store("tab", name === "memory" ? name : null); }, []);
  const toggleSidebar = useCallback(() => setSidebarOpen((open) => {
    if (wide.matches) store("sidebar", open ? "collapsed" : null);
    return !open;
  }), []);
  const openIssue = useCallback((id: string, question: string) => { select(id); suggest(question); }, [select, suggest]);
  const investigate = useCallback((question: string) => { select(null); suggest(question); }, [select, suggest]);
  const openView = useCallback((next: View) => { setView(next); setPanelOpen(true); }, []);
  // A question put in the composer from the panel or a card, to finish and send.
  const ask = useCallback((text: string) => {
    suggest(text);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".ax-composer-input")?.focus());
  }, [suggest]);
  const send = useCallback(async (text: string) => {
    setNotice(null);
    try {
      if (current) {
        await api.send(current, text);
      } else {
        const { id } = await api.start(text);
        setCurrent(id);
      }
      refreshList();
    } catch (error) {
      setNotice((error as Error).message);
    }
  }, [current, refreshList]);
  const stop = useCallback(async () => { if (current) await api.stop(current).catch(() => {}); }, [current]);
  // Each turn's question, which names the version of the findings it wrote.
  const questions = useMemo(() => new Map(conversation.entries.flatMap((entry) =>
    entry.kind === "user" && entry.turn != null ? [[entry.turn, entry.text] as const] : [])), [conversation.entries]);
  const turnContext = useMemo(() => ({ threadId: current, turns: thread?.turns || NO_TURNS, workloads, questions, open: openView, ask,
    send: (text: string) => { send(text); } }), [current, thread, workloads, questions, openView, ask, send]);
  const remove = async () => {
    if (!current || !window.confirm("Delete this conversation?\n\nIts workspace, files and history are deleted. "
      + "The worker's audit journal keeps the commands. This can't be undone.")) return;
    try {
      await api.remove(current);
      select(null);
      refreshList();
    } catch (error) {
      setNotice((error as Error & { status?: number }).status === 403 ? "Only an admin can delete an issue the team shares."
        : "The conversation could not be deleted. The server log has the cause.");
    }
  };
  const cardActions = useMemo(() => ({
    onAction: (type: string, payload: Record<string, unknown>) => {
      if (type === "open_file") { refreshThread(); setPanelOpen(true); setView({ tab: "files", turn: Number(payload.turn), path: String(payload.path) }); }
      if (type === "open_trace") { setPanelOpen(true); setView({ tab: "trace", turn: Number(payload.turn) }); }
      if (type === "investigate_issue" && payload.prompt) suggest(String(payload.prompt));
    },
  }), [refreshThread, suggest]);

  if (!config) return <div className="ax-loading">{notice || "Loading…"}</div>;
  const summary = conversations.find((item) => item.id === current);
  const scope = (config.namespaces || []).join(", ");
  // Follow-ups after the agent has answered: not under an issue's opening card.
  const followUps = !conversation.running && summary?.turns && current ? config.follow_ups || [] : [];
  const days = config.memory_max_age_days;
  return (
    <CardActionsContext.Provider value={cardActions}>
     <TurnContext.Provider value={turnContext}>
      <div className="ax-app">
        <header className="topbar">
          <button type="button" className="icon-button ax-menu" aria-label={sidebarOpen ? "Close history and memory" : "Open history and memory"}
            aria-expanded={sidebarOpen} onClick={toggleSidebar}>
            <Icon path="M4 6h16M4 12h16M4 18h16" />
          </button>
          <div className="brand">
            <span className="brand-icon" aria-hidden="true"><Icon path="M3 12h4l3-8 4 16 3-8h4" size={22} /></span>
            <span className="brand-name">SRE agent</span>
          </div>
          <div className="topbar-actions">
            <button type="button" className={`chip wide-only${workerDown ? " warn" : ""}`} onClick={() => about.current?.showModal()}
              aria-haspopup="dialog">
              <span className={`dot${workerDown ? "" : " ok"}`} />{scope}
              <span className="muted">{workerDown ? "worker unreachable" : config.model}</span>
            </button>
            {current ? <details className="popover-host ax-menu-host">
              <summary className="icon-button" aria-label="Conversation actions">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
              </summary>
              <div className="popover" role="menu">
                <button type="button" role="menuitem" onClick={(event) => {
                  navigator.clipboard?.writeText(location.href).catch(() => window.prompt("Copy this link", location.href));
                  (event.currentTarget.closest("details") as HTMLDetailsElement).open = false;
                }}>Copy link to this conversation</button>
                <button type="button" role="menuitem" className="danger" onClick={(event) => {
                  (event.currentTarget.closest("details") as HTMLDetailsElement).open = false;
                  remove();
                }}>Delete conversation…</button>
              </div>
            </details> : null}
            <details className="popover-host" ref={settings}>
              <summary className="icon-button" aria-label="Settings">
                <Icon path="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </summary>
              <div className="popover" role="dialog" aria-label="Settings">
                <span className="settings-label" id="appearance-label">Appearance</span>
                <div className="segmented" role="group" aria-labelledby="appearance-label">
                  {(["system", "light", "dark"] as Theme[]).map((choice) => (
                    <button key={choice} type="button" aria-pressed={theme === choice} onClick={() => setTheme(choice)}>
                      {choice[0]!.toUpperCase() + choice.slice(1)}</button>
                  ))}
                </div>
                <button type="button" className="link-button" onClick={() => { settings.current!.open = false; about.current?.showModal(); }}>How this works</button>
              </div>
            </details>
            {current ? (
              <button type="button" className="icon-button panel-toggle" aria-label={panelOpen ? "Hide the panel" : "Show the panel"}
                title={panelOpen ? "Hide the panel" : "Show the findings and evidence"} aria-expanded={panelOpen} onClick={() => setPanelOpen(!panelOpen)}>
                <Icon path="M3 4h18v16H3zM14 4v16" />
              </button>
            ) : null}
          </div>
        </header>

        <main className="ax-main" data-panel={panelOpen ? "open" : "closed"} data-sidebar={sidebarOpen ? "open" : "closed"}>
          <Sidebar collapsed={!sidebarOpen} onToggle={toggleSidebar} conversations={conversations} current={current} onSelect={select}
            onNew={() => select(null)} onInvestigate={investigate} tab={tab} onTab={chooseTab} health={config.health ? health : undefined}
            memory={config.memory ? <MemoryList idleMinutes={Math.round(((config.idle_close_s as number) || 300) / 60)}
              current={current} onOpen={(id) => select(id)}
              onCorrect={() => { select(null); suggest("Something you remember is wrong: "); }} /> : null} />
          <section className="chat-pane ax-chat-pane" aria-label="Conversation">
            <ChatColumn key={current || "new"} config={config} current={current} summary={summary} messages={messages}
              conversation={conversation} prefill={prefill} send={send} stop={stop} suggest={suggest} openIssue={openIssue}
              followUps={followUps} notice={notice} onPrefilled={clearPrefill} />
          </section>
          {panelOpen && current ? <Panel threadId={current} turns={thread?.turns || NO_TURNS} config={config} view={view} setView={setView}
            onClose={() => setPanelOpen(false)} /> : null}
        </main>

        <dialog className="confirm about" ref={about} aria-labelledby="about-title">
          <form method="dialog">
            <h2 id="about-title">How this works</h2>
            <dl className="about-facts">
              <dt>Reads</dt><dd>{scope}</dd>
              <dt>Model</dt><dd>{config.model}</dd>
              <dt>Worker</dt><dd>{worker ? `${worker.worker_id}, ${worker.isolation}` : "unreachable; new turns fail until it is back"}</dd>
              {worker?.egress ? <><dt>Containers reach</dt><dd>{worker.egress}</dd></> : null}
            </dl>
            <ul className="about-list">
              {(config.about || []).map((line, index) => <li key={index}>{line}</li>)}
              {config.memory ? <li>The agent starts each conversation from what it learned in earlier ones and checks that against the cluster.{days ? ` A conversation is forgotten ${days} day${days === 1 ? "" : "s"} after its last message.` : ""}</li> : null}
            </ul>
            <div className="confirm-actions"><button type="submit" className="secondary">Close</button></div>
          </form>
        </dialog>
      </div>
     </TurnContext.Provider>
    </CardActionsContext.Provider>
  );
}

function ChatColumn({ config, current, summary, messages, conversation, prefill, send, stop, suggest, openIssue, followUps, notice,
  onPrefilled }: {
  config: Config; current: string | null; summary?: Conversation; messages: any[]; conversation: ReturnType<typeof useConversation>;
  prefill: { text: string; nonce: number } | null; send: (text: string) => Promise<void>; stop: () => Promise<void>;
  suggest: (text: string) => void; openIssue: (id: string, question: string) => void;
  followUps: { label: string; prompt: string }[]; notice: string | null; onPrefilled: () => void;
}) {
  const scope = (config.namespaces || []).join(", ");
  const start = (
    <div className="ax-start">
      <p className="ax-greeting">{config.greeting}</p>
      {config.health ? <Board config={config} onSuggest={suggest} onOpenIssue={openIssue} /> : null}
    </div>
  );
  const footer = (
    <>
      {summary?.state === "elsewhere" ? <p className="banner">A turn is running in another window or the terminal. Send when it finishes.</p> : null}
      {conversation.error || notice ? <p className="banner err" role="alert">{conversation.error || notice}</p> : null}
      {followUps.length ? (
        <div className="suggestions">
          <span className="muted">Next</span>
          {followUps.map((item) => <button key={item.label} type="button" title={item.prompt} onClick={() => suggest(item.prompt)}>{item.label}</button>)}
        </div>
      ) : null}
    </>
  );
  return (
    <>
      {current ? <h1 className="ax-title">{summary?.title || "Conversation"}</h1> : null}
      <Chat messages={messages} running={conversation.running} placeholder={config.placeholder || `Ask about workloads in ${scope}…`}
        onSend={send} onStop={stop} empty={current ? null : start} footer={footer} prefill={prefill} onPrefilled={onPrefilled} />
    </>
  );
}
