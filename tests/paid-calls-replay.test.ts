import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  accept,
  advance,
  dueTimes,
  nextDue,
  PAID_CALLS_STEP_GAP_MS,
  valueAt,
  type ReplayCopy,
  type ReplayState,
} from '../src/paidCallsReplay.js';
import { PAID_CALLS_SHOW_DELAY_MS } from '../shared/paid-calls.js';

/*
 * Each paid service call at its own moment (src/paidCallsReplay.ts), on a fake clock: a browser
 * that polls every 15 s through an edge that is fresh for 15 s.
 */

const T0 = 1_800_000_000_000;

/** A copy made at server time `madeAt` (the browser's clock agrees), served `age` s later. */
function copyOf(
  total: number,
  blocks: number[],
  madeAt: number,
  options: { arrived?: number; age?: number; complete?: boolean } = {},
): ReplayCopy {
  const recent = blocks
    .map((at) => madeAt - at)
    .filter((ms) => ms <= 120_000)
    .sort((a, b) => a - b)
    .map((ms) => Math.max(0, ms));
  return {
    total,
    asOf: madeAt,
    recentMs: options.complete === false ? recent.slice(0, 64) : recent,
    ageS: options.age ?? 0,
    arrived: options.arrived ?? madeAt + (options.age ?? 0) * 1000,
  };
}

/** Runs a browser from `from` to `to` (ms), polling every 15 s; returns every value shown. */
function run(
  server: (now: number) => ReplayCopy,
  from: number,
  to: number,
  stepMs = 250,
): { shown: Array<[number, number]>; state: ReplayState | null } {
  let state: ReplayState | null = null;
  const shown: Array<[number, number]> = [];
  let nextPoll = from;
  for (let now = from; now <= to; now += stepMs) {
    if (now >= nextPoll) {
      state = accept(state, server(now), now);
      nextPoll += 15_000;
    } else if (state) state = advance(state, now);
    if (state && shown.at(-1)?.[1] !== state.shown) shown.push([now, state.shown]);
  }
  return { shown, state };
}

test('the delay is 45 s: the edge, the poll and the settle check', () => {
  assert.equal(PAID_CALLS_SHOW_DELAY_MS, 45_000);
});

test('each payment shows once, 45 s after its block, as its own +1', () => {
  // 100 paid before; then payments at +10 s, +20 s and +62 s (blocks on the server's clock).
  const blocks = [T0 + 10_000, T0 + 20_000, T0 + 62_000];
  // The edge serves a copy made at the last 15 s mark, so Age grows from 0 to 15 s.
  const server = (now: number) => {
    const made = Math.floor((now - T0) / 15_000) * 15_000 + T0;
    const paid = blocks.filter((at) => at <= made);
    return copyOf(100 + paid.length, paid, made, { arrived: now, age: (now - made) / 1000 });
  };
  const { shown } = run(server, T0 + 1_000, T0 + 200_000);
  // The first value at once, then one +1 per payment, each 45 s after its block (to the step).
  assert.deepEqual(
    shown.map(([, value]) => value),
    [100, 101, 102, 103],
  );
  const at = shown.slice(1).map(([time]) => time - T0);
  assert.deepEqual(
    at.map((ms, index) => ms - (blocks[index]! - T0)),
    at.map(() => 45_000),
  );
});

test('never drops except on a repair; an older copy is ignored', () => {
  const now = T0 + 300_000;
  let state = accept(null, copyOf(500, [], now - 1_000), now);
  assert.equal(state.shown, 500);
  // Another edge's older copy (an earlier as_of), even with a higher or lower total: ignored.
  for (const total of [490, 510]) {
    const older = accept(state, copyOf(total, [], now - 20_000, { arrived: now }), now);
    assert.equal(older, state);
  }
  // Clock jitter: a newer copy lists a payment the browser already showed as not yet due.
  state = accept(state, copyOf(501, [now - 46_000], now - 500), now);
  assert.equal(state.shown, 501);
  const jitter = accept(state, copyOf(501, [now - 44_000], now + 1_000, { arrived: now }), now);
  assert.equal(jitter.shown, 501, 'never back');
  // A lower total from a newer copy is a repair: shown at once, even if lower.
  const repaired = accept(jitter, copyOf(480, [], now + 15_000), now + 15_000);
  assert.equal(repaired.shown, 480);
  // Time passing alone never lowers it.
  assert.equal(advance(repaired, now + 100_000).shown, 480);
});

test('the Age shift is applied: the copy was made Age seconds before it arrived', () => {
  const arrived = T0 + 60_000;
  // A payment 1.2 s before the copy was made; the copy reached this browser 10 s after it was made.
  const copy: ReplayCopy = { total: 10, asOf: 0, recentMs: [1_200], ageS: 10, arrived };
  assert.deepEqual(dueTimes(copy), [arrived - 10_000 - 1_200 + 45_000]);
  assert.equal(valueAt(copy, arrived), 9);
  assert.equal(valueAt(copy, arrived + 33_799), 9);
  assert.equal(valueAt(copy, arrived + 33_800), 10);
  // Without the Age shift it would show 10 s later.
  const fresh = { ...copy, ageS: 0 };
  assert.equal(valueAt(fresh, arrived + 33_800), 9);
  const state = accept(null, copy, arrived);
  assert.equal(nextDue(state, arrived), arrived + 33_800);
  assert.equal(advance(state, arrived + 33_800).shown, 10);
  assert.equal(nextDue(advance(state, arrived + 33_800), arrived + 33_800), null);
});

test('extra payments show at once when recent_complete is false', () => {
  const made = T0;
  // A burst: 100 payments in the last 40 s, only the newest 64 listed.
  const blocks = Array.from({ length: 100 }, (_, i) => made - i * 400);
  const copy = copyOf(1_100, blocks, made, { complete: false });
  assert.equal(copy.recentMs.length, 64);
  // Every listed one waits for its moment; the 36 unlisted ones are in the total at once.
  const state = accept(null, copy, made);
  assert.equal(state.shown, 1_100 - 64);
  // Then the listed ones show one by one, each 45 s after its block (the oldest listed: 25.2 s).
  assert.equal(nextDue(state, made), made + 45_000 - 25_200);
  assert.equal(advance(state, made + 45_000 - 25_200).shown, 1_100 - 63);
  assert.equal(advance(state, made + 45_000).shown, 1_100);
});

test('events older than the window show at once', () => {
  const made = T0;
  // Blocks 30 s and 200 s before: only the first is listed (120 s window).
  const copy = copyOf(50, [made - 30_000, made - 200_000], made);
  assert.deepEqual(copy.recentMs, [30_000]);
  const state = accept(null, copy, made);
  assert.equal(state.shown, 49);
  assert.equal(nextDue(state, made), made + 15_000);
  // A payment found late (its block long before): it is in the total, shown at once.
  const late = accept(state, copyOf(51, [made - 30_000], made + 1_000), made + 1_000);
  assert.equal(late.shown, 50);
});

test('no count-in on first load: the first value is the real one, at once', () => {
  const made = T0;
  const state = accept(null, copyOf(1_284, [made - 1_200, made - 9_800], made), made);
  // The total as it stood 45 s ago: never 0, never a count from 0.
  assert.equal(state.shown, 1_282);
  const { shown } = run(
    () => copyOf(1_284, [made - 1_200, made - 9_800], made),
    made,
    made + 60_000,
  );
  assert.equal(shown[0]![1], 1_282);
  assert.ok(shown.every(([, value]) => value >= 1_282));
  assert.equal(shown.at(-1)![1], 1_284);
  // A total of 0 stays 0 (the page hides it); nothing ever goes below 0.
  assert.equal(accept(null, copyOf(0, [], made), made).shown, 0);
  assert.equal(valueAt({ total: 1, asOf: 0, recentMs: [0, 0], ageS: 0, arrived: made }, made), 0);
});

test('payments in one Base block show one by one, each its own +1, a moment apart', () => {
  assert.equal(PAID_CALLS_STEP_GAP_MS, 400);
  const made = T0;
  // Three payments in the same block, 10 s before the copy was made.
  const copy = copyOf(100, [made - 10_000, made - 10_000, made - 10_000], made);
  assert.deepEqual(copy.recentMs, [10_000, 10_000, 10_000]);
  const first = made - 10_000 + 45_000;
  assert.deepEqual(dueTimes(copy), [first, first + 400, first + 800]);
  let state = accept(null, copy, made);
  assert.equal(state.shown, 97);
  // Every step is exactly +1, never +2 or +3 at once.
  const steps: number[] = [];
  let now = made;
  for (let at = nextDue(state, now); at !== null; at = nextDue(state, now)) {
    now = at;
    const before = state.shown;
    state = advance(state, now);
    steps.push(state.shown - before);
  }
  assert.deepEqual(steps, [1, 1, 1]);
  assert.equal(state.shown, 100);
  // Payments already far enough apart keep their own moments.
  const apart = copyOf(10, [made - 3_000, made - 1_000], made);
  assert.deepEqual(dueTimes(apart), [made + 42_000, made + 44_000]);
  // The whole run never steps by more than one.
  const { shown } = run(() => copy, made, made + 60_000, 100);
  for (let i = 1; i < shown.length; i++) assert.equal(shown[i]![1] - shown[i - 1]![1], 1);
});

test('the same read served again (same as_of) is ignored: the copy held keeps its arrival', () => {
  const made = T0;
  const state = accept(null, copyOf(500, [], made), made);
  // The server serves its last good row while its database is slow: same as_of, later arrival.
  const again = accept(state, copyOf(500, [], made, { arrived: made + 60_000 }), made + 60_000);
  assert.equal(again, state);
  assert.equal(again.copy.arrived, made);
});

test('the public "How we count" promises no hard limit: a late-settled payment shows when found', () => {
  // A payment settled late by the reconcile cron, or added by the daily check, is past due when a
  // copy first carries it, so it shows then: minutes (or up to a day) after its block.
  const made = T0;
  const late = copyOf(11, [made - 600_000], made);
  assert.deepEqual(late.recentMs, []);
  const state = accept(accept(null, copyOf(10, [], made - 15_000), made - 15_000), late, made);
  assert.equal(state.shown, 11);
  const sentence = 'Each payment appears on its own, usually within a minute of its Base block.';
  for (const file of ['../docs/FEED_GUIDE.md', '../server/elric/help-index.ts']) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.ok(text.includes(sentence), file);
    assert.ok(!/under a minute after its Base block/.test(text), file);
  }
});
