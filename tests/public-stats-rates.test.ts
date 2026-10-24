import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateTracker, RATE_MAX_SPAN_MS } from '../server/stats/rates.js';

test('a rate is known once two readings are at least 20 s apart', () => {
  const r = createRateTracker();
  r.observe('paid', 1_000, 0);
  r.observe('paid', 1_010, 10_000);
  assert.equal(r.rate('paid', 10_000), null);
  r.observe('paid', 1_030, 30_000);
  assert.equal(r.rate('paid', 30_000), 1);
});

test('repeated or older readings are ignored; a fall gives no rate', () => {
  const r = createRateTracker();
  r.observe('base', 500, 0);
  r.observe('base', 500, 0);
  r.observe('base', 400, -5);
  r.observe('base', 560, 30_000);
  assert.equal(r.rate('base', 30_000), 2);
  r.observe('base', 100, 60_000);
  assert.equal(r.rate('base', 60_000), null);
});

test('readings older than ten minutes drop out; a stale key has no rate', () => {
  const r = createRateTracker();
  r.observe('agents', 0, 0);
  r.observe('agents', 600, 60_000);
  r.observe('agents', 6_000, RATE_MAX_SPAN_MS + 60_000);
  assert.equal(r.rate('agents', RATE_MAX_SPAN_MS + 60_000), (5_400 * 1000) / RATE_MAX_SPAN_MS);
  assert.equal(r.rate('agents', 3 * RATE_MAX_SPAN_MS), null);
});
