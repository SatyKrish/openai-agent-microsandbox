// Copyright 2026 openai-agent-mxc contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyLogPolicy, mask } from '../src/log-policy.js';
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
