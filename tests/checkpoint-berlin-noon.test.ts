import test from 'node:test';
import assert from 'node:assert/strict';
import {
  berlinZoneName,
  cutInstant,
  isCheckpointDue,
  isCheckpointHour,
  nextCheckpointAt,
} from '../shared/count-log/index.js';

/*
 * The daily checkpoint is always 12:00 Europe/Berlin (docs/COUNT_LOG.md). CEST (UTC+2) runs it
 * at 10:00 UTC, CET (UTC+1) at 11:00 UTC; the cron fires in both hours (vercel.json, five-minute
 * grid over 10:00-11:59 UTC) and the handler gate (server/count-log/routes.ts) lets only the
 * Berlin-noon hour act. These dates pin both DST sides and the 2026-10-25 and 2027-03-28 switches.
 */

// A summer Wednesday (CEST, UTC+2): noon Berlin = 10:00 UTC.
const CEST_DAY = Date.parse('2026-07-15T00:00:00Z');
// A winter Wednesday (CET, UTC+1): noon Berlin = 11:00 UTC.
const CET_DAY = Date.parse('2026-12-02T00:00:00Z');
// Switch day 2026-10-25: clocks go back, Berlin is CET from 03:00 CEST; noon Berlin = 11:00 UTC.
const SWITCH_DAY = Date.parse('2026-10-25T00:00:00Z');
// Spring forward 2026-03-29: noon Berlin = 10:00 UTC again (CEST from 03:00 CET).
const SPRING_DAY = Date.parse('2026-03-29T00:00:00Z');
// The 2027 switches: spring forward 2027-03-28 (noon Berlin = 10:00 UTC), fall back 2027-10-31
// (noon Berlin = 11:00 UTC).
const SPRING_2027 = Date.parse('2027-03-28T00:00:00Z');
const SWITCH_2027 = Date.parse('2027-10-31T00:00:00Z');

test('nextCheckpointAt: noon Berlin is 10:00 UTC under CEST and 11:00 UTC under CET', () => {
  assert.equal(nextCheckpointAt(CEST_DAY), Date.parse('2026-07-15T10:00:00Z'));
  assert.equal(nextCheckpointAt(CET_DAY), Date.parse('2026-12-02T11:00:00Z'));
  assert.equal(nextCheckpointAt(SWITCH_DAY), Date.parse('2026-10-25T11:00:00Z'));
  assert.equal(nextCheckpointAt(SPRING_DAY), Date.parse('2026-03-29T10:00:00Z'));
  assert.equal(nextCheckpointAt(SPRING_2027), Date.parse('2027-03-28T10:00:00Z'));
  assert.equal(nextCheckpointAt(SWITCH_2027), Date.parse('2027-10-31T11:00:00Z'));
});

test("nextCheckpointAt: after today's checkpoint, the next one is tomorrow at Berlin noon", () => {
  const after = Date.parse('2026-10-25T11:00:01Z');
  assert.equal(nextCheckpointAt(after), Date.parse('2026-10-26T11:00:00Z'));
  const afterCest = Date.parse('2026-07-15T10:00:01Z');
  assert.equal(nextCheckpointAt(afterCest), Date.parse('2026-07-16T10:00:00Z'));
  // At the checkpoint instant itself, that instant is the answer (the cron gate needs it).
  assert.equal(
    nextCheckpointAt(Date.parse('2026-10-25T11:00:00Z')),
    Date.parse('2026-10-25T11:00:00Z'),
  );
});

test('isCheckpointHour: only the Berlin-noon hour lets the cron act', () => {
  // CEST: Berlin noon is the 10:00 UTC hour; the 11:00 UTC hour is Berlin 13:xx — skipped.
  assert.equal(isCheckpointHour(Date.parse('2026-07-15T10:00:00Z')), true);
  assert.equal(isCheckpointHour(Date.parse('2026-07-15T10:59:00Z')), true);
  assert.equal(isCheckpointHour(Date.parse('2026-07-15T11:00:00Z')), false);
  assert.equal(isCheckpointHour(Date.parse('2026-07-15T09:04:00Z')), false); // before it
  // CET (incl. the 2026-10-25 switch): Berlin noon is the 11:00 UTC hour, 10:00 UTC is skipped.
  assert.equal(isCheckpointHour(Date.parse('2026-10-25T10:30:00Z')), false); // Berlin 11:30
  assert.equal(isCheckpointHour(Date.parse('2026-10-25T11:00:00Z')), true); // Berlin 12:00
  assert.equal(isCheckpointHour(Date.parse('2026-12-02T11:00:00Z')), true);
  assert.equal(isCheckpointHour(Date.parse('2026-12-02T11:30:00Z')), true);
  assert.equal(isCheckpointHour(Date.parse('2026-12-02T11:55:00Z')), true); // last cron tick
  assert.equal(isCheckpointHour(Date.parse('2026-12-02T12:00:00Z')), false); // Berlin 13:00
  assert.equal(isCheckpointHour(Date.parse('2026-12-02T10:30:00Z')), false);
  // The 2027 switches behave the same: 10:00 UTC hour after 2027-03-28, 11:00 UTC from 2027-10-31.
  assert.equal(isCheckpointHour(Date.parse('2027-03-28T10:15:00Z')), true);
  assert.equal(isCheckpointHour(Date.parse('2027-03-28T11:15:00Z')), false);
  assert.equal(isCheckpointHour(Date.parse('2027-10-31T10:15:00Z')), false);
  assert.equal(isCheckpointHour(Date.parse('2027-10-31T11:15:00Z')), true);
});

test('berlinZoneName: the public label follows the date (CEST before the switch, CET after)', () => {
  assert.equal(berlinZoneName(CEST_DAY), 'CEST');
  assert.equal(berlinZoneName(CET_DAY), 'CET');
  assert.equal(berlinZoneName(nextCheckpointAt(SWITCH_DAY)), 'CET'); // the checkpoint itself is CET
  assert.equal(berlinZoneName(nextCheckpointAt(SPRING_DAY - 1)), 'CEST'); // March 29 noon is CEST
  // Spring-switch midnight itself is still standard time; the label must never claim otherwise.
  assert.equal(berlinZoneName(SPRING_DAY), 'CET');
});

test('isCheckpointDue: from Berlin noon until midnight, so a missed run is caught up the same day', () => {
  // CEST: Berlin noon is 10:00 UTC, midnight 22:00 UTC.
  assert.equal(isCheckpointDue(Date.parse('2026-10-09T09:59:00Z')), false); // Berlin 11:59
  assert.equal(isCheckpointDue(Date.parse('2026-10-09T10:00:00Z')), true); // Berlin 12:00
  assert.equal(isCheckpointDue(Date.parse('2026-10-09T17:30:00Z')), true); // Berlin 19:30
  assert.equal(isCheckpointDue(Date.parse('2026-10-09T21:55:00Z')), true); // Berlin 23:55
  assert.equal(isCheckpointDue(Date.parse('2026-10-09T22:00:00Z')), false); // next day 00:00
  // CET: Berlin noon is 11:00 UTC; the 10:00 UTC firings are Berlin 11:xx and do nothing.
  assert.equal(isCheckpointDue(Date.parse('2026-12-02T10:55:00Z')), false); // Berlin 11:55
  assert.equal(isCheckpointDue(Date.parse('2026-12-02T11:00:00Z')), true);
  assert.equal(isCheckpointDue(Date.parse('2026-12-02T21:55:00Z')), true); // Berlin 22:55
});

const DAY = 86_400_000;

test('cutInstant: 12:00 Berlin of the date, on both DST sides and the switch days', () => {
  assert.equal(cutInstant('2026-07-15'), Date.parse('2026-07-15T10:00:00Z')); // CEST
  assert.equal(cutInstant('2026-12-02'), Date.parse('2026-12-02T11:00:00Z')); // CET
  // Fall back 2026-10-25 at 01:00 UTC: noon that day is already CET; the day before is CEST.
  assert.equal(cutInstant('2026-10-24'), Date.parse('2026-10-24T10:00:00Z'));
  assert.equal(cutInstant('2026-10-25'), Date.parse('2026-10-25T11:00:00Z'));
  assert.equal(cutInstant('2026-10-26'), Date.parse('2026-10-26T11:00:00Z'));
  // Spring forward 2027-03-28 at 01:00 UTC: noon that day is already CEST; the day before is CET.
  assert.equal(cutInstant('2027-03-27'), Date.parse('2027-03-27T11:00:00Z'));
  assert.equal(cutInstant('2027-03-28'), Date.parse('2027-03-28T10:00:00Z'));
  assert.equal(cutInstant('2026-03-29'), Date.parse('2026-03-29T10:00:00Z'));
  assert.equal(cutInstant('2027-10-31'), Date.parse('2027-10-31T11:00:00Z'));
  // Every day of two years: the cut is the first Berlin-noon instant of that UTC day, its first
  // millisecond is 12:00 Berlin and the one before is still 11:59.
  for (let time = Date.parse('2026-01-01'); time < Date.parse('2028-01-01'); time += DAY) {
    const date = new Date(time).toISOString().slice(0, 10);
    const cut = cutInstant(date);
    assert.equal(cut, nextCheckpointAt(time), date);
    assert.equal(isCheckpointHour(cut), true, date);
    assert.equal(isCheckpointHour(cut - 1), false, date);
  }
  for (const bad of ['2026-1-01', 'tomorrow', '', '2026-10-25T00:00:00Z'])
    assert.throws(() => cutInstant(bad), /YYYY-MM-DD/, bad);
});
