// Copyright 2026 openai-agent-microsandbox contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyLogPolicy, mask, signature } from '../src/log-policy.js';
import { noisyLog, PROCESSOR_LOG } from './helpers.js';

test('a noisy log becomes a short excerpt of its errors, with personal data masked', () => {
  const excerpt = applyLogPolicy(noisyLog(), 'pod payments-api-1 in payments');
  assert.equal(excerpt.linesRead, 1207);
  assert.ok(excerpt.linesShown <= 40);
  assert.equal(excerpt.linesWithheld, excerpt.linesRead - excerpt.linesShown);
  // Six timeouts collapse to one line with a count; the INFO noise around them collapses too.
  assert.equal(excerpt.text.match(/ERROR upstream ledger timeout/g)?.length, 1);
  assert.match(excerpt.text, /×5 more like this/);
  assert.match(excerpt.text, /shutting down after SIGTERM/);  // the last lines are always kept
  assert.doesNotMatch(excerpt.text, /@example\.com|4111/);
  assert.ok(excerpt.redactions > 0);
  assert.ok(Buffer.byteLength(excerpt.text) < 7000);
});

test('a short crash log is kept whole', () => {
  const excerpt = applyLogPolicy(PROCESSOR_LOG, 'pod payments-processor-1 in payments');
  assert.equal(excerpt.linesShown, 3);
  assert.match(excerpt.text, /\[FATAL\] Payments startup failed: Missing required env var DATABASE_URL/);
});

test('asked-for text is kept, and an empty log says so', () => {
  assert.match(applyLogPolicy(noisyLog(), 'pod x', undefined, 'id=431 ').text, /id=431 user=\[REDACTED_EMAIL\]/);
  assert.match(applyLogPolicy('', 'pod x').text, /the log is empty/);
});

test('masking covers credentials, emails, card numbers and long identifiers', () => {
  const { text, count } = mask('user=a.b@example.co.uk card=4111-1111-1111-1111 account=123456789012 token=abcdef12345');
  assert.equal(text, 'user=[REDACTED_EMAIL] card=[REDACTED_CARD] account=[REDACTED_NUMBER] token=[REDACTED]');
  assert.equal(count, 4);
  assert.equal(mask('order 1234 5678 shipped').text, 'order 1234 5678 shipped');
});

test('status codes and addresses keep lines apart; epoch times stay, long identifiers do not', () => {
  assert.notEqual(signature('10.0.0.7 - - "GET /pay HTTP/1.1" 502 120'), signature('10.0.0.7 - - "GET /pay HTTP/1.1" 504 120'));
  assert.notEqual(signature('upstream 10.244.0.9:8080 timed out'), signature('upstream 10.244.0.12:8080 timed out'));
  assert.equal(signature('status=503 after 120 ms'), signature('status=503 after 980 ms'));
  assert.equal(mask('at 1793551997 and 1793551997553').text, 'at 1793551997 and 1793551997553');
  assert.equal(mask('account 3051234567 ref 98765432101').text, 'account [REDACTED_NUMBER] ref [REDACTED_NUMBER]');
});

test('server errors in an access log are kept, each status counted apart, and a stack trace stays whole', () => {
  const access = Array.from({ length: 200 }, (_, index) =>
    `10.0.0.${index % 3} - - [01/Nov/2026:06:00:${String(index % 60).padStart(2, '0')}] "POST /charge HTTP/1.1" ${index % 50 === 0 ? 502 : index % 25 === 0 ? 504 : 200} 88`);
  const excerpt = applyLogPolicy(access.join('\n'), 'pod api');
  assert.match(excerpt.text, /" 502 88/);
  assert.match(excerpt.text, /" 504 88/);
  assert.ok(excerpt.linesShown <= 10, `${excerpt.linesShown} shown`);  // of 200: successes only as context and tail
  const trace = ['INFO ok', 'ERROR charge failed', '    at charge (pay.js:10:3)', '    at handle (server.js:5:1)',
    'Caused by: ConnectionRefused', '    at connect (net.js:1:1)', 'INFO next', ...Array(30).fill('INFO idle')];
  const kept = applyLogPolicy(trace.join('\n'), 'pod api').text;
  for (const frame of ['at charge (pay.js:10:3)', 'at handle', 'Caused by: ConnectionRefused', 'at connect']) {
    assert.ok(kept.includes(frame), frame);
  }
});
