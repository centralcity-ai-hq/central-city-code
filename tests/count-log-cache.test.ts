import test from 'node:test';
import assert from 'node:assert/strict';
import { FEED_SEALING, checkpointsCache, feedCache } from '../server/count-log/routes.js';
import { cutInstant, nextCheckpointAt } from '../shared/count-log/index.js';

const at = (iso: string) => Date.parse(iso);
const day = (time: number) => new Date(time).toISOString().slice(0, 10);
const brief = { browser: 'public, max-age=5, s-maxage=5', edge: 'public, max-age=5' };

/** The longest any cache may keep or serve the response, fresh or stale, per header. */
function lifetimes(header: string): number[] {
  const value = (name: string) =>
    Number(new RegExp(`(?:^|, )${name}=([0-9]+)`).exec(header)?.[1] ?? 0);
  const stale = value('stale-while-revalidate');
  return [value('max-age') + stale, value('s-maxage') + stale];
}

/** The list a server would hold at `now`: today's checkpoint once its cut has passed. */
function latestAt(now: number): string {
  const today = day(now);
  return now >= cutInstant(today) ? today : day(now - 86_400_000);
}

function assertNeverCrossesCut(now: number, latest: string) {
  const cache = checkpointsCache(latest, now);
  const cut = nextCheckpointAt(now + 1);
  for (const header of [cache.browser, cache.edge])
    for (const seconds of lifetimes(header))
      assert.ok(
        now + seconds * 1000 <= cut,
        `${new Date(now).toISOString()} ${header}: ${seconds} s crosses the cut ${new Date(cut).toISOString()}`,
      );
}

test('checkpoint list: no copy, fresh or stale, outlives the next cut (every 7 min over DST and normal days)', () => {
  // 24-27 Oct 2026 spans the switch to CET (25 Oct 01:00 UTC): the cut moves from 10:00 to 11:00 UTC.
  for (const [from, to] of [
    ['2026-10-09T00:00:00Z', '2026-10-11T23:59:00Z'],
    ['2026-10-24T00:00:00Z', '2026-10-27T23:59:00Z'],
    ['2027-03-27T00:00:00Z', '2027-03-29T23:59:00Z'],
  ])
    for (let now = at(from); now <= at(to); now += 7 * 60_000)
      assertNeverCrossesCut(now, latestAt(now));
});

test('checkpoint list: the lifetime parser reads real values', () => {
  assert.deepEqual(
    lifetimes('public, max-age=60, s-maxage=300, stale-while-revalidate=600'),
    [660, 900],
  );
  assert.deepEqual(lifetimes('public, max-age=300, stale-while-revalidate=86100'), [86400, 86100]);
  assert.deepEqual(lifetimes('public, max-age=5'), [5, 0]);
});

test('checkpoint list: the last two seconds before the cut never cross it', () => {
  for (const iso of [
    '2026-10-10T09:59:58.000Z',
    '2026-10-10T09:59:58.900Z',
    '2026-10-10T09:59:59.000Z',
    '2026-10-10T09:59:59.500Z',
    '2026-10-10T09:59:59.999Z',
  ])
    assertNeverCrossesCut(at(iso), '2026-10-09');
  // Under a second left: no caching at all.
  assert.deepEqual(checkpointsCache('2026-10-09', at('2026-10-10T09:59:59.500Z')), {
    browser: 'public, max-age=0, s-maxage=0',
    edge: 'public, max-age=0',
  });
  assert.deepEqual(checkpointsCache('2026-10-09', at('2026-10-10T09:59:59.000Z')), {
    browser: 'public, max-age=1, s-maxage=1',
    edge: 'public, max-age=1',
  });
});

test('checkpoint list: the cases the review asked for', () => {
  // 10 Oct 2026, 11:54 Berlin (CEST, cut 10:00 UTC): 360 s left.
  assert.deepEqual(checkpointsCache('2026-10-09', at('2026-10-10T09:54:00Z')), {
    browser: 'public, max-age=60, s-maxage=300, stale-while-revalidate=60',
    edge: 'public, max-age=300, stale-while-revalidate=60',
  });
  assertNeverCrossesCut(at('2026-10-10T09:54:00Z'), '2026-10-09');
  // The evening before: the usual browser cache; the edge's stale allowance ends at the cut.
  assert.deepEqual(checkpointsCache('2026-10-09', at('2026-10-09T20:00:00Z')), {
    browser: 'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
    edge: 'public, max-age=300, stale-while-revalidate=50100',
  });
  // Seconds before the cut: short and without a stale copy.
  assert.deepEqual(checkpointsCache('2026-10-09', at('2026-10-10T09:59:30Z')), {
    browser: 'public, max-age=30, s-maxage=30',
    edge: 'public, max-age=30',
  });
});

test('checkpoint list: seconds only while the day is due and its checkpoint is not listed', () => {
  // 10 Oct 2026, 12:01 Berlin: the case that hid the 12:04 checkpoint.
  assert.deepEqual(checkpointsCache('2026-10-09', at('2026-10-10T10:01:00Z')), brief);
  assert.deepEqual(checkpointsCache('2026-10-09', at('2026-10-10T19:00:00Z')), brief);
  assert.deepEqual(checkpointsCache(undefined, at('2026-10-10T10:01:00Z')), brief);
  // CET (cut 11:00 UTC): 10:30 UTC is still before the cut, 11:02 is due.
  assert.notDeepEqual(checkpointsCache('2026-11-09', at('2026-11-10T10:30:00Z')), brief);
  assert.deepEqual(checkpointsCache('2026-11-09', at('2026-11-10T11:02:00Z')), brief);
});

test('checkpoint list: at the cut instant with the day already listed, the next cut is tomorrow', () => {
  assert.deepEqual(checkpointsCache('2026-10-10', at('2026-10-10T10:00:00Z')), {
    browser: 'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
    edge: 'public, max-age=300, stale-while-revalidate=86100',
  });
});

const settled = (latest: string | null) => ({
  cursor: true,
  stability: 'checkpoint' as const,
  latest,
});

test('feed page: between the noon cut and the seal a settled page is cached 5 s, not until tomorrow', () => {
  // CEST (cut 10:00 UTC), CET (cut 11:00 UTC) and the 25 Oct 2026 switch day (cut 11:00 UTC).
  for (const [date, cut] of [
    ['2026-10-10', '2026-10-10T10:00:00Z'],
    ['2026-12-02', '2026-12-02T11:00:00Z'],
    ['2026-10-25', '2026-10-25T11:00:00Z'],
  ] as const) {
    const yesterday = day(at(cut) - 86_400_000);
    // The seal is running (today's checkpoint not listed): at the cut, during settle, minutes on.
    for (const offset of [0, 1, 30_000, 4 * 60_000, 3 * 3_600_000])
      assert.equal(
        feedCache(settled(yesterday), at(cut) + offset),
        FEED_SEALING,
        `${date} +${offset}`,
      );
    assert.equal(
      feedCache(settled(null), at(cut) + 60_000),
      FEED_SEALING,
      `${date} no checkpoint yet`,
    );
    // Sealed: cached until the next day's cut, never past it.
    const sealed = feedCache(settled(date), at(cut) + 60_000);
    const age = Number(/max-age=(\d+)/.exec(sealed)![1]);
    assert.equal(at(cut) + 60_000 + age * 1000 <= nextCheckpointAt(at(cut) + 60_001), true, sealed);
    assert.ok(age > 3_600, sealed);
    // Before the cut, yesterday's checkpoint is the latest: cached until today's cut.
    const before = feedCache(settled(yesterday), at(cut) - 60_000);
    assert.equal(before, 'public, max-age=60, s-maxage=60', `${date} before the cut`);
  }
});

test('feed page: the head and pending pages stay live, removed-only pages stay final, in the window too', () => {
  const now = at('2026-10-25T11:02:00Z');
  const latest = '2026-10-24';
  const live = 'public, max-age=2, s-maxage=2, stale-while-revalidate=5';
  assert.equal(feedCache({ cursor: false, stability: 'checkpoint', latest }, now), live);
  assert.equal(feedCache({ cursor: true, stability: 'live', latest }, now), live);
  assert.equal(
    feedCache({ cursor: true, stability: 'final', latest }, now),
    'public, max-age=86400, s-maxage=86400',
  );
});

test('feed page: a settled page never outlives a checkpoint that could change it (every 7 min over DST)', () => {
  for (const [from, to] of [
    ['2026-10-24T00:00:00Z', '2026-10-27T23:59:00Z'],
    ['2027-03-27T00:00:00Z', '2027-03-29T23:59:00Z'],
  ])
    for (let now = at(from); now <= at(to); now += 7 * 60_000) {
      const today = day(now);
      // During the seal (up to 20 min after the cut) today is not listed yet; afterwards it is.
      const latest = now >= cutInstant(today) + 20 * 60_000 ? today : day(now - 86_400_000);
      const cache = feedCache(settled(latest), now);
      const age = Number(/max-age=(\d+)/.exec(cache)![1]);
      const sealing = now >= cutInstant(today) && latest < today;
      const until = sealing ? now + 5_000 : nextCheckpointAt(now + 1);
      assert.ok(
        now + age * 1000 <= Math.max(until, now + 2_000),
        `${new Date(now).toISOString()} ${cache}`,
      );
      assert.equal(cache === FEED_SEALING, sealing, new Date(now).toISOString());
    }
});
