// Copyright 2026 openai-agent-substrate contributors
// SPDX-License-Identifier: Apache-2.0
//
// Renderers for the files a turn collects: Markdown, CSV, JSON and plain text.
// They build DOM nodes from text; nothing from a file is parsed as HTML.

import { el } from "./dom.js";

export function prettyJson(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

// [start, end) character offsets of a quote in text, ignoring differences in whitespace,
// the same comparison the host checks use.
export function findQuote(text, quote) {
  const normal = [];
  const offsets = [];
  let space = true;
  for (let index = 0; index < text.length; index += 1) {
    if (/\s/.test(text[index])) {
      if (!space) { normal.push(" "); offsets.push(index); space = true; }
    } else {
      normal.push(text[index]); offsets.push(index); space = false;
    }
  }
  const wanted = quote.split(/\s+/).filter(Boolean).join(" ");
  const at = wanted ? normal.join("").indexOf(wanted) : -1;
  return at < 0 ? null : [offsets[at], offsets[at + wanted.length - 1] + 1];
}

// Numbered lines; a highlighted range is marked and scrolled into view.
export function renderCode(text, highlight = null) {
  const lines = text.replace(/\n$/, "").split("\n");
  let offset = 0;
  let first = null;
  const rows = lines.map((line, index) => {
    const start = offset;
    const end = start + line.length;
    offset = end + 1;
    let content = [line];
    let marked = false;
    if (highlight && highlight[0] < end + 1 && highlight[1] > start) {
      marked = true;
      const from = Math.max(highlight[0] - start, 0);
      const to = Math.min(highlight[1] - start, line.length);
      content = [line.slice(0, from), el("mark", {}, line.slice(from, to)), line.slice(to)];
    }
    const row = el("div", { class: `line${marked ? " marked" : ""}` }, el("span", {}, index + 1), el("span", {}, content));
    if (marked && first === null) first = row;
    return row;
  });
  const node = el("div", { class: "code" }, rows);
  if (first) requestAnimationFrame(() => first.scrollIntoView({ block: "center" }));
  return node;
}

function inline(text) {
  // **bold** and `code`; everything else stays text.
  const parts = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const token = match[0];
    parts.push(token.startsWith("**") ? el("strong", {}, token.slice(2, -2)) : el("code", {}, token.slice(1, -1)));
    last = match.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function splitRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function copyButton(text) {
  const button = el("button", { type: "button", class: "copy" }, "Copy");
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Select and copy";
    }
    setTimeout(() => { button.textContent = "Copy"; }, 1600);
  });
  return button;
}

export function renderMarkdown(text) {
  const root = el("article", { class: "doc" });
  const lines = text.split("\n");
  let index = 0;
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) root.append(el("p", {}, inline(paragraph.join(" "))));
    paragraph = [];
  };
  while (index < lines.length) {
    const line = lines[index];
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const fence = /^\s*(`{3,}|~{3,})\s*([\w-]*)\s*$/.exec(line);
    if (fence) {
      // Commands an agent proposes, with a button to copy them; nothing runs from here.
      flush();
      const body = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(fence[1])) body.push(lines[index++]);
      const code = body.join("\n");
      root.append(el("div", { class: "code-block" }, el("pre", {}, code), copyButton(code)));
    } else if (heading) {
      flush();
      root.append(el(`h${heading[1].length}`, {}, inline(heading[2])));
    } else if (/^\s*\|/.test(line) && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] || "")) {
      flush();
      const header = splitRow(line);
      const rows = [];
      index += 2;
      while (index < lines.length && /^\s*\|/.test(lines[index])) rows.push(splitRow(lines[index++]));
      index -= 1;
      root.append(table(header, rows, false));
    } else if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d+\./.test(line);
      const list = el(ordered ? "ol" : "ul");
      while (index < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[index])) {
        list.append(el("li", {}, inline(lines[index++].replace(/^\s*([-*]|\d+\.)\s+/, ""))));
      }
      index -= 1;
      root.append(list);
    } else if (!line.trim()) {
      flush();
    } else {
      paragraph.push(line.trim());
    }
    index += 1;
  }
  flush();
  return root;
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((item) => item.some((value) => value !== ""));
}

export function renderCsv(text) {
  const [header = [], ...rows] = parseCsv(text);
  return el("div", { class: "padded" }, table(header, rows, true));
}

function table(header, rows, monospace) {
  const numeric = header.map((_, column) => rows.length > 0 && rows.every((row) => /^-?\d+(\.\d+)?%?$/.test(row[column] || "")));
  return el("div", { class: `table-box${monospace ? " mono-table" : ""}` }, el("table", {},
    el("thead", {}, el("tr", {}, header.map((cell, column) => el("th", { scope: "col", class: numeric[column] ? "num" : null }, cell)))),
    el("tbody", {}, rows.map((row) => el("tr", {}, header.map((_, column) => el("td", { class: numeric[column] ? "num" : null }, inline(row[column] || "")))))),
  ));
}

// The default view of a text file by its extension.
export function renderText(name, text) {
  if (name.endsWith(".md")) return { node: renderMarkdown(text), document: true };
  if (name.endsWith(".csv")) return { node: renderCsv(text) };
  if (name.endsWith(".json")) return { node: renderCode(prettyJson(text)) };
  return { node: renderCode(text) };
}
