import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LIMIT_PERIOD_SECONDS,
  berlinDayStart,
  berlinMidnight,
  calendarPeriod,
  nextBerlinMidnight,
  onchainAllowance,
  type LimitPeriod,
} from '../shared/base/spend-limits.js';

/*
 * The bound of the "half" model, checked for every Berlin calendar interval (the product owner's
 * decision of 11 October 2026: Base enforces fixed periods of 24 hours, 7 days and 31 days at half
 * the limit; the app counts Berlin days, weeks and months).
 *
 * A grant's first Base period starts at 00:00 Berlin of the day it is signed (`berlinDayStart`, the
 * only start the server prepares and accepts; grants signed before 14 October 2026 start at the next
 * midnight, `nextBerlinMidnight`), and every period is a whole number of days. So every period
 * boundary lies a whole number of hours from a Berlin midnight. A calendar interval is at most one
 * hour longer than its period (a 25-hour day, the week holding it, October), so it could overlap
 * three periods only with a boundary strictly inside its first hour, which a whole-hour offset never
 * is. At most two periods means at most twice half the limit: the limit.
 *
 * Covered here: one grant. A replacement grant starts a new allowance (it needs a new owner
 * signature), and the threat model says so.
 */

/** Every Berlin calendar interval of one kind from the one holding `from` until `to` (unix s). */
function berlinIntervals(kind: LimitPeriod, from: number, to: number) {
  const out: { start: number; end: number }[] = [];
  let at = calendarPeriod(kind, from * 1000);
  while (at.start < to) {
    out.push(at);
    at = calendarPeriod(kind, at.end * 1000);
  }
  return out;
}

/** How many fixed periods of `length` from `start` an interval meets (spends start at `start`). */
function periodsMet(start: number, length: number, interval: { start: number; end: number }) {
  const from = Math.max(interval.start, start);
  if (interval.end <= from) return 0;
  const first = Math.floor((from - start) / length);
  const last = Math.floor((interval.end - 1 - start) / length);
  return last - first + 1;
}

const FIRST = berlinMidnight(2026, 10, 1);
const LAST_START = berlinMidnight(2031, 1, 1);
const HORIZON = 3 * 366 * 86_400;
const KINDS: LimitPeriod[] = ['day', 'week', 'month'];

test('every possible grant start is a Berlin midnight on a whole hour (UTC)', () => {
  for (
    let ms = Date.UTC(2026, 9, 1);
    ms < Date.UTC(2031, 0, 1);
    ms += 7 * 3_600_000 + 13 * 60_000
  ) {
    // Today's (every grant from now on): at or before the signature, so it works at once.
    const today = berlinDayStart(ms);
    assert.ok(today * 1000 <= ms, 'at or before the grant');
    assert.equal(today % 3_600, 0, `${new Date(today * 1000).toISOString()} is on a whole hour`);
    // The next one (grants signed before this change).
    const start = nextBerlinMidnight(ms);
    assert.ok(start * 1000 > ms, 'strictly after the grant');
    assert.equal(start % 3_600, 0, `${new Date(start * 1000).toISOString()} is on a whole hour`);
  }
});

test('a grant from 00:00 Berlin today: the rest of the signing day, week or month meets at most two periods', () => {
  // Every signing instant: the grant starts at the day's 00:00 Berlin (at or before it, so it works
  // at once), and from the signature to the end of that Berlin interval at most two Base periods
  // start or run: at most twice half the limit, so never more than the limit. For a day limit it is
  // one period, except on the 25-hour days (its last hour is the next Base day's).
  for (const kind of KINDS) {
    const length = LIMIT_PERIOD_SECONDS[kind];
    for (
      let ms = Date.UTC(2026, 2, 1);
      ms < Date.UTC(2028, 0, 1);
      ms += 2 * 3_600_000 + 17 * 60_000
    ) {
      const start = berlinDayStart(ms);
      const signed = Math.floor(ms / 1000);
      assert.ok(start <= signed);
      const rest = { start: signed, end: calendarPeriod(kind, ms).end };
      const met = periodsMet(start, length, rest);
      const at = new Date(ms).toISOString();
      assert.ok(met >= 1 && met <= 2, `${kind} signed ${at}: ${met} periods`);
      if (kind === 'day') {
        const day = calendarPeriod('day', ms);
        const long = day.end - day.start === 25 * 3_600;
        assert.equal(met, long && signed < start + length ? 2 : 1, `day signed ${at}`);
      }
    }
  }
});

test('half model: no Berlin day, week or month meets more than two Base periods of one grant', () => {
  for (const kind of KINDS) {
    const length = LIMIT_PERIOD_SECONDS[kind];
    const intervals = berlinIntervals(kind, FIRST, LAST_START + HORIZON);
    let most = 0;
    let checked = 0;
    for (let start = FIRST; start < LAST_START; start = nextBerlinMidnight(start * 1000)) {
      for (const interval of intervals) {
        if (interval.start >= start + HORIZON) break;
        const met = periodsMet(start, length, interval);
        if (!met) continue;
        checked++;
        if (met > most) most = met;
        assert.ok(
          met <= 2,
          `${kind} from ${new Date(interval.start * 1000).toISOString()} meets ${met} periods of a grant from ${new Date(start * 1000).toISOString()}`,
        );
      }
    }
    assert.equal(most, 2, `${kind}: the bound is reached (a reset inside the interval)`);
    assert.ok(checked > 1_000, `${kind}: ${checked} intervals checked`);
  }
});

test('half model: two periods of half the limit never exceed the limit (odd caps round down)', () => {
  for (const cap of [1n, 2n, 3n, 999_999n, 1_000_000n, 25_000_001n, 2n ** 159n + 1n]) {
    assert.ok(2n * onchainAllowance(cap, 'half') <= cap, `cap ${cap}`);
    assert.equal(onchainAllowance(cap, 'full'), cap, 'full: up to twice the limit, disclosed');
  }
});

test('the bound needs the midnight start: a start at 00:30 would let a 25-hour day meet three periods', () => {
  // 25 October 2026 is the 25-hour day (daylight saving time ends).
  const day = calendarPeriod('day', berlinMidnight(2026, 10, 25) * 1000);
  assert.equal(day.end - day.start, 25 * 3_600);
  assert.equal(periodsMet(berlinMidnight(2026, 10, 24), LIMIT_PERIOD_SECONDS.day, day), 2);
  assert.equal(periodsMet(berlinMidnight(2026, 10, 24) + 1_800, LIMIT_PERIOD_SECONDS.day, day), 3);
});
