import test from 'node:test';
import assert from 'node:assert/strict';
import {
  perMinuteOf,
  PER_MINUTE_MIN_SPAN_MS,
  PER_MINUTE_WINDOW_MS,
} from '../server/base/explorer/calls.js';
import { PAID_CALLS_RECENT_MAX } from '../shared/paid-calls.js';

const now = 1_000_000_000;

test('below the cap: the calls inside the last minute are counted', () => {
  const recent = [now - 1_000, now - 30_000, now - 59_000, now - 61_000, now - 120_000];
  assert.equal(perMinuteOf(recent, now), 3);
});

test('all kept calls inside the minute: the rate comes from how fast they came, past 64', () => {
  // 64 calls, one every 0.5 s: 120 a minute.
  const recent = Array.from({ length: PAID_CALLS_RECENT_MAX }, (_, i) => now - i * 500);
  assert.equal(perMinuteOf(recent, now), 120);
  // 64 calls, one every 0.6 s: 100 a minute.
  const slower = Array.from({ length: PAID_CALLS_RECENT_MAX }, (_, i) => now - i * 600);
  assert.equal(perMinuteOf(slower, now), 100);
});

test('a full list with older calls outside the minute is counted, never extrapolated', () => {
  const recent = Array.from(
    { length: PAID_CALLS_RECENT_MAX },
    (_, i) => now - (i < 40 ? i * 1_000 : PER_MINUTE_WINDOW_MS + i * 1_000),
  );
  assert.equal(perMinuteOf(recent, now), 40);
});

test('a full list at one instant counts what is there', () => {
  assert.equal(perMinuteOf(Array(PAID_CALLS_RECENT_MAX).fill(now), now), PAID_CALLS_RECENT_MAX);
});

test('a full list from one batch (64 times within a second) is never extrapolated', () => {
  // Sponsored calls recorded paid in one batch: 64 times spanning 801 ms once read as 4,719.
  const batch = Array.from({ length: PAID_CALLS_RECENT_MAX }, (_, i) => now - i * 13);
  assert.equal(perMinuteOf(batch, now), PAID_CALLS_RECENT_MAX);
  // Just under the guard: counted; at the guard: measured from the span again.
  const step = (PER_MINUTE_MIN_SPAN_MS - 1) / (PAID_CALLS_RECENT_MAX - 1);
  const under = Array.from({ length: PAID_CALLS_RECENT_MAX }, (_, i) => now - i * step);
  assert.equal(perMinuteOf(under, now), PAID_CALLS_RECENT_MAX);
  const at = Array.from(
    { length: PAID_CALLS_RECENT_MAX },
    (_, i) => now - (i * PER_MINUTE_MIN_SPAN_MS) / (PAID_CALLS_RECENT_MAX - 1),
  );
  assert.equal(perMinuteOf(at, now), 378);
});
