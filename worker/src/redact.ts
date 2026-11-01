// Copyright 2026 openai-agent-mxc contributors
// SPDX-License-Identifier: Apache-2.0
//
// Scrubs credentials from command output before it reaches the harness, the
// model's context or the journal. Pattern-based, so it is a backstop, not a
// guarantee: the worker's identity also cannot read Secrets or ConfigMaps.

const RULES: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED_JWT]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, '[REDACTED_API_KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, '$1[REDACTED]'],
  // scheme://user:password@host keeps the user and host.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi, '$1[REDACTED]@'],
  [/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|account[_-]?key|client[_-]?secret)(\s*[=:]\s*)(["']?)[^\s"',;]{4,}/gi,
    '$1$2$3[REDACTED]'],
];

export function redact(text: string): string {
  let result = text;
  for (const [pattern, replacement] of RULES) result = result.replace(pattern, replacement);
  return result;
}
