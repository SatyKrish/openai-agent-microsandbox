// Copyright 2026 openai-agent-mxc contributors
// SPDX-License-Identifier: Apache-2.0
//
// What of a pod's log may reach the model. Raw logs stay in the worker: the
// policy keeps error and warning lines with a little context, the last lines
// before the log ends, and lines matching text the agent asked for; collapses
// repeats into one line with a count; masks credentials and personal data; and
// caps the excerpt. A header says how much it withheld, so the agent knows it is
// looking at an excerpt and can ask for a narrower one.

import { redact } from './redact.js';

export interface LogPolicy {
  maxLines: number;     // lines in the excerpt, not counting the header
  maxBytes: number;     // bytes in the excerpt
  context: number;      // lines kept before and after each error
  tail: number;         // last lines always kept
  lineChars: number;    // characters kept of any one line
}

export interface Excerpt {
  text: string;
  linesRead: number;
  linesShown: number;
  linesWithheld: number;
  redactions: number;
}

export const DEFAULT_POLICY: LogPolicy = { maxLines: 40, maxBytes: 6000, context: 2, tail: 3, lineChars: 240 };

const ERROR = /\b(fatal|panic|error|err|exception|traceback|caused by|critical|crit|severe|oom|out of memory|killed|segfault|refused|denied|forbidden|unauthori[sz]ed|timed out|timeout|unavailable|failed|failure|cannot|unable|missing|invalid|exit(?:ed)? (?:with )?(?:code|status))\b/i;
const WARNING = /\b(warn|warning|deprecated|retrying|backoff)\b/i;
const LONG_DIGITS = /\b\d{9,}\b/g;

/** Credentials, email addresses and card numbers (redact.ts), and in logs also long numeric identifiers. */
export function mask(line: string): { text: string; count: number } {
  const text = redact(line).replace(LONG_DIGITS, '[REDACTED_NUMBER]');
  return { text, count: (text.match(/\[REDACTED/g) ?? []).length };
}

/** Lines that differ only in timestamps, numbers and identifiers are the same line. */
function signature(line: string): string {
  return line.replace(/\[REDACTED_[A-Z]+\]/g, '#').replace(/[0-9a-f]{8,}/gi, '#').replace(/\d+/g, '#')
    .replace(/\s+/g, ' ').trim();
}

export function applyLogPolicy(raw: string, label: string, policy: LogPolicy = DEFAULT_POLICY,
  match = ''): Excerpt {
  const lines = raw.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const needle = match.toLowerCase();
  const masked = lines.map(mask);
  const keep = new Set<number>();
  const asked = new Set<number>();
  masked.forEach(({ text }, index) => {
    if (needle !== '' && text.toLowerCase().includes(needle)) asked.add(index);
    if (ERROR.test(text) || asked.has(index)) {
      for (let near = Math.max(0, index - policy.context); near <= Math.min(lines.length - 1, index + policy.context); near += 1) {
        keep.add(near);
      }
    } else if (WARNING.test(text)) {
      keep.add(index);
    }
  });
  for (let index = Math.max(0, lines.length - policy.tail); index < lines.length; index += 1) keep.add(index);

  // One line per signature, with how often it recurred among the kept lines. Lines the
  // agent asked for are shown each time: they are what it is looking for.
  const order = [...keep].sort((a, b) => a - b);
  const seen = new Map<string, { at: number; count: number; last: number }>();
  const shown: number[] = [];
  for (const index of order) {
    if (asked.has(index)) {
      shown.push(index);
      continue;
    }
    const key = signature(masked[index]!.text);
    const entry = seen.get(key);
    if (entry) {
      entry.count += 1;
      entry.last = index;
    } else {
      seen.set(key, { at: index, count: 1, last: index });
      shown.push(index);
    }
  }
  const body: string[] = [];
  let bytes = 0;
  let cut = false;
  for (const index of shown) {
    let text = masked[index]!.text;
    if (text.length > policy.lineChars) text = `${text.slice(0, policy.lineChars)}…`;
    const entry = asked.has(index) ? { count: 1, last: index } : seen.get(signature(masked[index]!.text))!;
    const repeats = entry.count > 1 ? `   [×${entry.count - 1} more like this, last at line ${entry.last + 1}]` : '';
    const row = `${String(index + 1).padStart(6)}| ${text}${repeats}`;
    if (body.length >= policy.maxLines || bytes + row.length + 1 > policy.maxBytes) {
      cut = true;
      break;
    }
    body.push(row);
    bytes += row.length + 1;
  }
  const redactions = order.reduce((total, index) => total + masked[index]!.count, 0);
  const withheld = lines.length - body.length;
  const header = lines.length === 0 ? `[log policy] ${label}: the log is empty.` : [
    `[log policy] ${label}: read ${lines.length} lines; showing ${body.length} (errors and warnings with`,
    `${policy.context} lines of context, the last ${policy.tail} lines${needle ? ', and lines containing the text you asked for' : ''}),`,
    `repeated lines collapsed; withheld ${withheld}; ${redactions} values masked${cut ? '; excerpt cut at its size limit' : ''}.`,
    'The raw log never leaves the worker. Ask again with match=... to look for specific text.',
  ].join(' ');
  return { text: [header, ...body].join('\n') + '\n', linesRead: lines.length, linesShown: body.length,
    linesWithheld: withheld, redactions };
}
