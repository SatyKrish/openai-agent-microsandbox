// Copyright 2026 openai-agent-mxc contributors
// SPDX-License-Identifier: Apache-2.0
//
// Scrubs credentials and personal data (email addresses, card numbers) from
// command output before it reaches the harness, the model's context or the
// journal. Pod specs and events can carry them as well as logs. Pattern-based,
// so it is a backstop, not a guarantee: the worker's identity also cannot read
// Secrets or ConfigMaps, and logs pass a stricter policy (log-policy.ts).

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

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const CARD = /\b(?:\d[ -]?){12,18}\d\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
    sum += digit;
  }
  return sum % 10 === 0;
}

export function redact(text: string): string {
  let result = text;
  for (const [pattern, replacement] of RULES) result = result.replace(pattern, replacement);
  result = result.replace(EMAIL, '[REDACTED_EMAIL]');
  // 13 to 19 digits that pass the Luhn check: a payment card number.
  return result.replace(CARD, (value) => {
    const digits = value.replace(/\D/g, '');
    return digits.length >= 13 && luhn(digits) ? '[REDACTED_CARD]' : value;
  });
}
