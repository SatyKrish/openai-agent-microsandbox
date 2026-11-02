// Copyright 2026 openai-agent-mxc contributors
// SPDX-License-Identifier: Apache-2.0
//
// The SRE agent's page: on the left, History (issues the health board opened, shared by the team, and
// your own conversations) and Memory (what the agent remembers from them); the conversation in the
// middle; and a side panel of the turn's files and trace. The start screen is the health board. How the
// agent is contained is said once, in the How this works dialog. Everything comes from the harness's API.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { renderHome } from "../../static/sre.js";

import { api, type Config, type Conversation } from "./api";
import { Chat } from "./Chat";
import { toMessages, useConversation } from "./conversation";
import { MemoryList } from "./Memory";
import { Panel, type View } from "./Panel";
import { CardActionsContext } from "./parts";

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

function initialConversation(): string | null {
  const linked = new URLSearchParams(location.search).get("c");
  const id = linked || stored("conversation");
  return id && ID.test(id) ? id : null;
}

// The left column's icons: the same in its tabs and in the stack it collapses to.
const ICONS = {
  new: "M12 5v14M5 12h14",
  history: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5M12 7v5l4 2",
  memory: "M2 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H2zM22 4h-7a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h8z",
};
const TABS: { name: Tab; label: string }[] = [{ name: "history", label: "History" }, { name: "memory", label: "Memory" }];

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

function Sidebar({ conversations, current, onSelect, onNew, tab, onTab, memory }: {
  conversations: Conversation[]; current: string | null; onSelect: (id: string) => void; onNew: () => void;
  tab: Tab; onTab: (tab: Tab) => void; memory: ReactNode;
}) {
  const open = conversations.filter((item) => item.issue?.state === "open");
  const mine = conversations.filter((item) => !item.issue);
  const recovered = conversations.filter((item) => item.issue && item.issue.state !== "open");
  const row = (item: Conversation) => (
    <li key={item.id}>
      <button type="button" className="ax-conversation" aria-current={item.id === current ? "page" : undefined}
        onClick={() => onSelect(item.id)} title={item.title || item.id}>
        {item.issue ? <span className={`ax-dot ${item.issue.state === "open" ? "failing" : ""}`} aria-hidden="true" /> : null}
        <span className="ax-conversation-title">{item.title || "New conversation"}</span>
        {item.state === "running" ? <span className="ax-running" aria-label="running" /> : null}
      </button>
    </li>
  );
  return (
    <nav className="ax-sidebar" aria-label="History and memory">
      <button type="button" className="ax-new" onClick={onNew}><Icon path={ICONS.new} size={16} />New investigation</button>
      {memory ? (
        <div className="ax-tabs" role="tablist">
          {TABS.map(({ name, label }) => (
            <button key={name} type="button" role="tab" aria-selected={tab === name} onClick={() => onTab(name)}>
              <Icon path={ICONS[name]} size={15} />{label}</button>
          ))}
        </div>
      ) : null}
      {memory && tab === "memory" ? memory : (
        <div role={memory ? "tabpanel" : undefined} aria-label="History">
          {open.length ? <><h2 className="ax-list-head">Open issues</h2><ul className="ax-list">{open.map(row)}</ul></> : null}
          <h2 className="ax-list-head">Conversations</h2>
          {mine.length ? <ul className="ax-list">{mine.map(row)}</ul> : <p className="ax-list-empty">None yet.</p>}
          {recovered.length ? <><h2 className="ax-list-head">Recovered</h2><ul className="ax-list">{recovered.map(row)}</ul></> : null}
        </div>
      )}
    </nav>
  );
}

/** The left column collapsed: its actions as a stack of icons, each opening the column where it leads. */
function Rail({ memory, onNew, onOpen }: { memory: boolean; onNew: () => void; onOpen: (tab: Tab) => void }) {
  return (
    <nav className="ax-rail" aria-label="History and memory">
      <button type="button" className="icon-button" aria-label="New investigation" title="New investigation" onClick={onNew}>
        <Icon path={ICONS.new} /></button>
      {TABS.filter(({ name }) => memory || name === "history").map(({ name, label }) => (
        <button key={name} type="button" className="icon-button" aria-label={label} title={label} onClick={() => onOpen(name)}>
          <Icon path={ICONS[name]} /></button>
      ))}
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
  const [sidebarOpen, setSidebarOpen] = useState(wide.matches);
  const [theme, setTheme] = useState<Theme>(() => (stored("theme") as Theme) || "system");
  const [worker, setWorker] = useState<any>(null);
  const [workerDown, setWorkerDown] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
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

  const conversation = useConversation(current, {
    onTurnEnd: () => { refreshThread(); refreshList(); },
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
  const openIssue = useCallback((id: string, question: string) => { select(id); suggest(question); }, [select, suggest]);
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
      if (type === "open_quotes") { setPanelOpen(true); setView({ tab: "files", turn: Number(payload.turn), path: "output/findings.json" }); }
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
      <div className="ax-app">
        <header className="topbar">
          <button type="button" className="icon-button ax-menu" aria-label={sidebarOpen ? "Collapse history and memory" : "Expand history and memory"}
            aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(!sidebarOpen)}>
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
            <button type="button" className="icon-button panel-toggle" aria-label={panelOpen ? "Hide files and trace" : "Show files and trace"}
              aria-expanded={panelOpen} onClick={() => setPanelOpen(!panelOpen)}>
              <Icon path="M3 4h18v16H3zM14 4v16" />
            </button>
          </div>
        </header>

        <main className="ax-main" data-panel={panelOpen ? "open" : "closed"} data-sidebar={sidebarOpen ? "open" : "closed"}>
          {sidebarOpen ? <Sidebar conversations={conversations} current={current} onSelect={select} onNew={() => select(null)}
            tab={tab} onTab={chooseTab}
            memory={config.memory ? <MemoryList idleMinutes={Math.round(((config.idle_close_s as number) || 300) / 60)}
              current={current} onOpen={(id) => select(id)}
              onCorrect={() => { select(null); suggest("Something you remember is wrong: "); }} /> : null} />
            : <Rail memory={Boolean(config.memory)} onNew={() => select(null)} onOpen={(name) => { chooseTab(name); setSidebarOpen(true); }} />}
          <section className="chat-pane ax-chat-pane" aria-label="Conversation">
            <ChatColumn key={current || "new"} config={config} current={current} summary={summary} messages={messages}
              conversation={conversation} prefill={prefill} send={send} stop={stop} suggest={suggest} openIssue={openIssue}
              followUps={followUps} notice={notice} onPrefilled={clearPrefill} />
          </section>
          {panelOpen ? <Panel threadId={current} thread={thread} config={config} view={view} setView={setView}
            onClose={() => setPanelOpen(false)} /> : null}
        </main>

        <dialog className="confirm about" ref={about} aria-labelledby="about-title">
          <form method="dialog">
            <h2 id="about-title">How this works</h2>
            <dl className="about-facts">
              <dt>Reads</dt><dd>{scope}</dd>
              <dt>Model</dt><dd>{config.model}</dd>
              <dt>Worker</dt><dd>{worker ? `${worker.worker_id}, MXC ${worker.containment}` : "unreachable; new turns fail until it is back"}</dd>
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
