// Copyright 2026 openai-agent-microsandbox contributors
// SPDX-License-Identifier: Apache-2.0
//
// The parts of an agent's message that are not text: a group of steps (tool calls), open while the
// agent works and then a "worked for" line, and a card (Card, Row, Text, Badge, Button, Caption).
// Everything from the cluster or the model is rendered as text, never as HTML.

import { createContext, useContext, useState, type ReactNode } from "react";

import type { CardNode, Entry, Step } from "./api";

export type CardActions = { onAction: (type: string, payload: Record<string, unknown>) => void };
export const CardActionsContext = createContext<CardActions>({ onAction: () => {} });

const ICON: Record<string, string> = { cube: "▣", keys: "⚿" };

function StepRow({ step }: { step: Step }) {
  const [open, setOpen] = useState(false);
  const mark = step.status === "running" ? <span className="ax-spin" aria-label="running" />
    : step.status === "failed" ? <span className="ax-step-failed" aria-label="failed">!</span>
      : <span className="ax-step-icon" aria-hidden="true">{ICON[step.icon || ""] || "·"}</span>;
  return (
    <li className={`ax-step ${step.status}`}>
      <button type="button" className="ax-step-head" aria-expanded={open} onClick={() => setOpen(!open)}
        disabled={!step.detail}>
        {mark}
        <span className="ax-step-title">{step.title}</span>
      </button>
      {open && step.detail ? <pre className="ax-step-detail">{step.detail.replace(/^```\w*\n?|\n?```$/gm, "")}</pre> : null}
    </li>
  );
}

export function StepsPart({ data }: { data: Extract<Entry, { kind: "steps" }> }) {
  const [expanded, setExpanded] = useState(false);
  const open = data.open || expanded;
  const failed = data.steps.some((step) => step.status === "failed");
  const label = data.open ? "Working…" : `Worked for ${data.duration_s ? `${data.duration_s} s` : "a moment"}`;
  return (
    <div className={`ax-steps${failed ? " has-failed" : ""}`}>
      <button type="button" className="ax-steps-head" aria-expanded={open} onClick={() => setExpanded(!expanded)}
        disabled={data.open}>
        <span>{label}</span>
        <span className="ax-muted">{data.steps.length} step{data.steps.length === 1 ? "" : "s"}</span>
        {data.open ? null : (
          <span aria-hidden="true" className="ax-chevron">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
          </span>
        )}
      </button>
      {open ? <ol className="ax-step-list">{data.steps.map((step, index) => <StepRow key={index} step={step} />)}</ol> : null}
    </div>
  );
}

function node(item: CardNode, key: number, actions: CardActions): ReactNode {
  const children = (item.children || []).map((child, index) => node(child, index, actions));
  switch (item.type) {
    case "Card":
      return <div key={key} className="ax-card">{children}</div>;
    case "Row":
      return <div key={key} className="ax-card-row">{children}</div>;
    case "Text":
      return <p key={key} className={`ax-card-text ${item.size || ""} ${item.color || ""} ${item.weight || ""}`}>{item.value}</p>;
    case "Caption":
      return <p key={key} className="ax-card-caption">{item.value}</p>;
    case "Badge":
      return <span key={key} className={`ax-badge ${item.color || ""}`}>{item.label}</span>;
    case "Button":
      return (
        <button key={key} type="button" className={`ax-card-button ${item.style || ""}`}
          onClick={() => item.onClickAction && actions.onAction(item.onClickAction.type, item.onClickAction.payload || {})}>
          {item.label}
        </button>
      );
    default:
      return children.length ? <div key={key}>{children}</div> : null;
  }
}

export function CardPart({ data }: { data: CardNode }) {
  const actions = useContext(CardActionsContext);
  return <>{node(data, 0, actions)}</>;
}

/** The agent's text, with **bold** and `code`; paragraphs and list items by line. */
export function Prose({ text }: { text: string }) {
  const inline = (line: string) => line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((piece, index) =>
    piece.startsWith("**") && piece.endsWith("**") && piece.length > 4 ? <strong key={index}>{piece.slice(2, -2)}</strong>
      : piece.startsWith("`") && piece.endsWith("`") && piece.length > 2 ? <code key={index}>{piece.slice(1, -1)}</code>
        : piece);
  const blocks = text.split(/\n{2,}/);
  return (
    <div className="ax-prose">
      {blocks.map((block, index) => {
        const lines = block.split("\n");
        if (lines.every((line) => /^\s*([-*]|\d+\.)\s+/.test(line))) {
          return <ul key={index}>{lines.map((line, item) => <li key={item}>{inline(line.replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>)}</ul>;
        }
        return <p key={index}>{lines.map((line, item) => <span key={item}>{item ? <br /> : null}{inline(line)}</span>)}</p>;
      })}
    </div>
  );
}
