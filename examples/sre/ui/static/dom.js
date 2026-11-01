// Copyright 2026 openai-agent-substrate contributors
// SPDX-License-Identifier: Apache-2.0
//
// Small DOM helpers. Every value from the sandbox, the cluster or the model is
// untrusted, so it is only ever inserted as text, never as HTML.

export const $ = (id) => document.getElementById(id);

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "style") node.style.cssText = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export async function getJSON(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

export function readStorage(key) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

export function writeStorage(key, value) {
  try { value === null ? window.localStorage.removeItem(key) : window.localStorage.setItem(key, value); } catch { /* private mode */ }
}

export function formatBytes(bytes) {
  if (bytes === undefined || bytes === null) return "";
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

export function seconds(ms) {
  return ms > 0 && ms < 1 ? "<1 ms" : ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 1 : 2)} s` : `${Math.round(ms)} ms`;
}

export function plural(count, word, many = `${word}s`) {
  return `${count} ${count === 1 ? word : many}`;
}
