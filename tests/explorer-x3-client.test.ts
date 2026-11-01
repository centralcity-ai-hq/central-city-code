import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import {
  countText,
  loadAgentMetrics,
  loadFinalizing,
  loadHeads,
  loadHistory,
  loadRatingEvents,
  parseAgentMetrics,
  parseFinalizing,
  parseHeads,
  parseHistory,
  parseRatingEvents,
  priceRangeText,
  resetX3Absence,
  X3_ABSENT_RECHECK_MS,
  sparklineSegments,
  type HistorySeries,
} from '../src/explorer/x3Client';

beforeEach(() => resetX3Absence());

const answer = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const TX = `0x${'ab'.repeat(32)}`;
const event = (over: Record<string, unknown> = {}) => ({
  eventId: 'e1',
  block: '53000000',
  transactionHash: TX,
  recordedAt: '2026-10-25 00:10:00+00',
  raterBaseId: '120',
  ratedBaseId: '121',
  raterName: 'Notose',
  ratedName: '',
  stars: 5,
  ...over,
});

test('a deployed endpoint that answers is ok; 404 is absent; anything else is unavailable', async () => {
  assert.equal(
    (await loadRatingEvents(undefined, answer({ rows: [], nextBefore: null, asOf: 1 }))).state,
    'ok',
  );
  assert.equal((await loadRatingEvents(undefined, answer({ error: 'x' }, 404))).state, 'absent');
  resetX3Absence();
  assert.equal(
    (await loadRatingEvents(undefined, answer({ error: 'x' }, 503))).state,
    'unavailable',
  );
  assert.equal(
    (await loadHistory(undefined, answer({ series: 'no' }))).state,
    'unavailable',
    'malformed is never empty',
  );
  const thrower = (async () => {
    throw new Error('network');
  }) as unknown as typeof fetch;
  assert.equal((await loadHistory(undefined, thrower)).state, 'unavailable');
});

test('rating events: only well-formed rows; stars 1 to 5; names may be empty', () => {
  const ok = parseRatingEvents({ rows: [event()], nextBefore: '53000000~abc', asOf: 5 });
  assert.equal(ok?.rows[0]?.raterName, 'Notose');
  assert.equal(ok?.rows[0]?.ratedName, '');
  assert.equal(parseRatingEvents({ rows: [event({ stars: 6 })], nextBefore: null, asOf: 5 }), null);
  assert.equal(
    parseRatingEvents({ rows: [event({ transactionHash: '0x12' })], nextBefore: null, asOf: 5 }),
    null,
  );
  assert.equal(parseRatingEvents({ rows: [], nextBefore: 3, asOf: 5 }), null);
});

test('agent metrics: unknown services stay null, lower bounds keep their +, price range in USDC', async () => {
  const metrics = parseAgentMetrics({
    rows: [
      {
        baseId: '529727',
        offeredServices: {
          count: 11,
          exact: true,
          priceRangeRaw: { min: '50000', max: '20000000', asset: 'USDC', decimals: 6 },
        },
        paidCallsSold: { count: 10001, exact: false, window: 'all_time_recorded' },
      },
      {
        baseId: '121',
        offeredServices: null,
        paidCallsSold: { count: 0, exact: true, window: 'all_time_recorded' },
      },
    ],
  });
  const edward = metrics!.get('529727')!;
  assert.equal(countText(edward.offeredServices), '11');
  assert.equal(countText(edward.paidCallsSold), '10,001+');
  assert.equal(priceRangeText(edward.offeredServices!.priceRangeRaw), '0.05 to 20.00 USDC');
  assert.equal(countText(metrics!.get('121')!.offeredServices), '–', 'unknown is never 0');
  assert.equal(countText(metrics!.get('121')!.paidCallsSold), '0', 'a known zero is 0');
  assert.equal(
    parseAgentMetrics({
      rows: [
        {
          baseId: '1',
          offeredServices: null,
          paidCallsSold: { count: -1, exact: true, window: 'x' },
        },
      ],
    }),
    null,
  );
  const none = await loadAgentMetrics([], undefined, answer({}, 500));
  assert.equal(none.state, 'ok', 'no ids: no request');
});

test('sparklines break at every missing hour and draw nothing before collection began', () => {
  const H = 3_600_000;
  const base = 10 * H;
  const series = (values: Array<number | null>, collectionStart: number | null): HistorySeries => ({
    metric: 'base',
    points: values.map((value, i) => ({ hour: base + i * H, value })),
    observedHours: values.filter((v) => v !== null).length,
    collectionStart,
  });
  assert.equal(
    sparklineSegments(series([1, 2, 3, null, 4, 5, 6], base), 40, 10).length,
    2,
    'a gap breaks the line',
  );
  assert.equal(
    sparklineSegments(series([1, 2, null, 3, 4, 5], base), 40, 10).length,
    1,
    'a run of 2 next to a gap draws nothing',
  );
  assert.deepEqual(
    sparklineSegments(series([1, null, 3], base), 40, 10),
    [],
    'no run of two points: nothing',
  );
  assert.equal(
    sparklineSegments(series([9, 9, 1, 2, 3], base + 2 * H), 40, 10).length,
    1,
    'points before collectionStart are dropped',
  );
  const parsed = parseHistory({
    series: [
      {
        metric: 'calls',
        points: [{ hour: base, value: 3, observedAt: base + 5 }],
        observedHours: 1,
        collectionStart: base,
      },
    ],
  });
  assert.equal(parsed?.get('calls')?.points[0]?.value, 3);
  assert.equal(
    parseHistory({
      series: [{ metric: 'nope', points: [], observedHours: 0, collectionStart: null }],
    }),
    null,
  );
});

test('a price range outside the contract (USDC, 6 decimals, min <= max) is malformed, never rendered', () => {
  const row = (priceRangeRaw: unknown) => ({
    rows: [
      {
        baseId: '1',
        offeredServices: { count: 2, exact: true, priceRangeRaw },
        paidCallsSold: { count: 0, exact: true, window: 'all_time_recorded' },
      },
    ],
  });
  for (const bad of [
    { min: '1', max: '2', asset: 'USDC', decimals: -1 },
    { min: '1', max: '2', asset: 'USDC', decimals: 1e9 },
    { min: '1', max: '2', asset: 'ETH', decimals: 6 },
    { min: '3', max: '2', asset: 'USDC', decimals: 6 },
  ])
    assert.equal(parseAgentMetrics(row(bad)), null, JSON.stringify(bad));
  assert.ok(parseAgentMetrics(row({ min: '1', max: '2', asset: 'USDC', decimals: 6 })));
});

test('sparse rating pages are followed (bounded); a later failure is unavailable, never empty', async () => {
  const pages = (bodies: Array<unknown | number>) => {
    let n = 0;
    const seen: string[] = [];
    const fetcher = (async (url: string) => {
      seen.push(url);
      const body = bodies[n++];
      return typeof body === 'number'
        ? new Response('{}', { status: body })
        : new Response(JSON.stringify(body));
    }) as unknown as typeof fetch;
    return { fetcher, seen };
  };
  const empty = (next: string | null) => ({ rows: [], nextBefore: next, asOf: 1 });
  const found = pages([empty('9~a'), empty('8~b'), { rows: [event()], nextBefore: null, asOf: 1 }]);
  const ok = await loadRatingEvents(undefined, found.fetcher);
  assert.equal(ok.state === 'ok' && ok.value.rows.length, 1);
  assert.equal(found.seen[1], '/api/public/base/rating-events?before=9~a');
  const none = pages([empty('9~a'), empty('8~b'), empty('7~c'), empty('6~d')]);
  const capped = await loadRatingEvents(undefined, none.fetcher);
  assert.equal(none.seen.length, 3, 'at most 3 pages');
  assert.equal(capped.state === 'ok' && capped.value.exhausted, false, 'not the end of the feed');
  const ended = await loadRatingEvents(undefined, pages([empty(null)]).fetcher);
  assert.equal(ended.state === 'ok' && ended.value.exhausted, true);
  const failing = await loadRatingEvents(undefined, pages([empty('9~a'), 503]).fetcher);
  assert.equal(failing.state, 'unavailable');
});

test('a 200 the server marks stale is carried as stale, so the page never calls it live', async () => {
  const stale = await loadHistory(undefined, answer({ series: [], stale: true }));
  assert.equal(stale.state === 'ok' && stale.stale, true);
  const fresh = await loadHistory(undefined, answer({ series: [], stale: false }));
  assert.equal(fresh.state === 'ok' && fresh.stale, false);
  const ratings = await loadRatingEvents(
    undefined,
    answer({ rows: [], nextBefore: null, asOf: 1, stale: true }),
  );
  assert.equal(ratings.state === 'ok' && ratings.stale, true);
});

test('a total that moves a little stays a flat line; two points draw nothing', () => {
  const H = 3_600_000;
  const base = 100 * H;
  const series = (values: Array<number | null>): HistorySeries => ({
    metric: 'agents',
    points: values.map((value, i) => ({ hour: base + i * H, value })),
    observedHours: values.filter((v) => v !== null).length,
    collectionStart: base,
  });
  const [line] = sparklineSegments(series([3_017_000, 3_017_050, 3_017_100]), 120, 24);
  const ys = line!.split(' ').map((p) => Number(p.split(',')[1]));
  assert.ok(
    Math.max(...ys) - Math.min(...ys) <= 2,
    `spans ${Math.max(...ys) - Math.min(...ys)} px`,
  );
  assert.deepEqual(sparklineSegments(series([3_017_000, 3_017_100]), 120, 24), [], '2 points');
  const [small] = sparklineSegments(series([30, 33, 40]), 120, 24);
  const smallYs = small!.split(' ').map((p) => Number(p.split(',')[1]));
  assert.ok(Math.max(...smallYs) - Math.min(...smallYs) < 24, 'a real change shows, padded');
});

test('an endpoint that answered 404 is not asked again for ten minutes, in any view', async () => {
  resetX3Absence();
  let calls = 0;
  const notFound = (async () => {
    calls += 1;
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  assert.equal((await loadRatingEvents(undefined, notFound)).state, 'absent');
  assert.equal((await loadRatingEvents(undefined, notFound)).state, 'absent');
  assert.equal(calls, 1, 'the second read did not hit the network');
  assert.equal((await loadAgentMetrics(['1'], undefined, notFound)).state, 'absent');
  assert.equal((await loadAgentMetrics(['2', '3'], undefined, notFound)).state, 'absent');
  assert.equal(calls, 2, 'agent-metrics is remembered by its path, whatever the ids');
  resetX3Absence();
});

test('the 404 cooldown expires at ten minutes and a deployed endpoint is found again', async () => {
  let t = 1_000_000;
  resetX3Absence(() => t);
  let deployed = false;
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return deployed
      ? new Response(JSON.stringify({ rows: [], nextBefore: null, asOf: 1 }))
      : new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  assert.equal((await loadRatingEvents(undefined, fetcher)).state, 'absent');
  deployed = true;
  t += X3_ABSENT_RECHECK_MS - 1;
  assert.equal((await loadRatingEvents(undefined, fetcher)).state, 'absent', 'just before');
  assert.equal(calls, 1);
  t += 1;
  assert.equal((await loadRatingEvents(undefined, fetcher)).state, 'ok', 'at ten minutes');
  assert.equal(calls, 2);
  assert.equal((await loadRatingEvents(undefined, fetcher)).state, 'ok', 'stays found');
  resetX3Absence();
});

// ---- finalizing registrations and Base heads (#621) ----

const heads = (over: Record<string, unknown> = {}) => ({
  chainId: 8453,
  latest: '52431207',
  safe: '52431107',
  finalized: '52430000',
  asOf: 1_792_890_000_000,
  stale: false,
  ...over,
});

test('heads: decimal strings kept exact as BigInt, ordered finalized <= safe <= latest', () => {
  const big = '123456789012345678901234567890';
  assert.deepEqual(parseHeads(heads({ latest: big, safe: big, finalized: big })), {
    latest: BigInt(big),
    safe: BigInt(big),
    finalized: BigInt(big),
    asOf: 1_792_890_000_000,
  });
  assert.equal(parseHeads(heads())!.latest - parseHeads(heads())!.finalized, 1207n);
  // Out of order, another chain, numbers instead of strings, negatives or a missing asOf: malformed.
  for (const bad of [
    heads({ finalized: '52431108' }),
    heads({ safe: '52431208' }),
    heads({ chainId: 84532 }),
    heads({ latest: 52431207 }),
    heads({ finalized: '-1' }),
    heads({ safe: '0x10' }),
    heads({ asOf: undefined }),
  ])
    assert.equal(parseHeads(bad), null);
});

test('heads: 404 is absent, 503 or a malformed body is unavailable, a stale 200 stays stale', async () => {
  assert.equal((await loadHeads(undefined, answer({}, 404))).state, 'absent');
  resetX3Absence();
  assert.equal(
    (await loadHeads(undefined, answer({ error: 'heads_unavailable' }, 503))).state,
    'unavailable',
  );
  assert.equal((await loadHeads(undefined, answer(heads({ safe: '1' })))).state, 'unavailable');
  const stale = await loadHeads(undefined, answer(heads({ stale: true })));
  assert.equal(stale.state === 'ok' && stale.stale, true);
});

const OWNER = `0x${'12'.repeat(20)}`;
const waitingRow = (over: Record<string, unknown> = {}) => ({
  baseId: '1130452',
  name: 'Harbor',
  owner: OWNER,
  short: 'Hb7x2Q',
  status: 'finalizing',
  finalizingSince: 1_792_889_640_000,
  registrationBlock: '52431200',
  handoverBlock: null,
  ...over,
});
const CURSOR = `1130401~${'a'.repeat(32)}`;

test('finalizing: rows in the On Base row shape; an empty page may still carry nextBefore', () => {
  const page = parseFinalizing({ rows: [waitingRow()], nextBefore: CURSOR, asOf: 5 });
  assert.deepEqual(page, {
    rows: [
      {
        baseId: '1130452',
        name: 'Harbor',
        owner: OWNER,
        short: 'Hb7x2Q',
        status: 'finalizing',
        finalizingSince: 1_792_889_640_000,
      },
    ],
    nextBefore: CURSOR,
    asOf: 5,
  });
  // Every candidate removed by the public listing rules: no rows, and the scan goes on.
  assert.deepEqual(parseFinalizing({ rows: [], nextBefore: CURSOR, asOf: 5 }), {
    rows: [],
    nextBefore: CURSOR,
    asOf: 5,
  });
  assert.equal(parseFinalizing({ rows: [], nextBefore: null, asOf: 5 })!.nextBefore, null);
});

test('finalizing: one malformed row or cursor makes the whole page malformed, never partial', () => {
  for (const bad of [
    { rows: [waitingRow({ baseId: '01' })], nextBefore: null, asOf: 5 },
    { rows: [waitingRow({ owner: '0x12' })], nextBefore: null, asOf: 5 },
    { rows: [waitingRow({ short: 'toolong1' })], nextBefore: null, asOf: 5 },
    { rows: [waitingRow({ status: 'pending' })], nextBefore: null, asOf: 5 },
    { rows: [waitingRow({ finalizingSince: -1 })], nextBefore: null, asOf: 5 },
    { rows: [waitingRow({ mintTx: '0xabc' })], nextBefore: null, asOf: 5 },
    { rows: [waitingRow()], nextBefore: '1130401', asOf: 5 },
    { rows: [waitingRow()], nextBefore: `1130401~${'A'.repeat(32)}`, asOf: 5 },
    { items: [waitingRow()], nextBefore: null, asOf: 5 },
    { rows: [waitingRow()], nextBefore: null },
  ])
    assert.equal(parseFinalizing(bad), null);
});

test('finalizing: the cursor goes out encoded as before=; a 404 cools down the path for both pages', async () => {
  const seen: string[] = [];
  const fetcher = (async (url: string) => {
    seen.push(url);
    return new Response(JSON.stringify({ rows: [], nextBefore: null, asOf: 1 }), { status: 200 });
  }) as unknown as typeof fetch;
  await loadFinalizing(CURSOR, undefined, fetcher);
  assert.deepEqual(seen, [`/api/public/base/finalizing?before=${encodeURIComponent(CURSOR)}`]);
  assert.equal((await loadFinalizing(null, undefined, answer({}, 404))).state, 'absent');
  // The cooldown is per endpoint path, so the cursor page is not asked either.
  assert.equal((await loadFinalizing(CURSOR, undefined, fetcher)).state, 'absent');
  assert.equal(seen.length, 1);
});

test('typed search: strict rows, a malformed cursor is unavailable, sparse name pages are followed', async () => {
  const { loadTypedSearch, parseTypedSearch } = await import('../src/explorer/x3Client');
  const row = {
    baseId: '529727',
    name: 'Edward',
    owner: `0x${'52'.repeat(20)}`,
    short: 'XeAK9B',
    status: 'final',
  };
  assert.ok(parseTypedSearch({ rows: [row], nextBefore: null }));
  assert.equal(parseTypedSearch({ rows: [{ ...row, status: 'other' }], nextBefore: null }), null);
  assert.equal(parseTypedSearch({ rows: [], nextBefore: 'not a cursor' }), null);
  const tie = 'a'.repeat(32);
  const seen: string[] = [];
  const fetcher = (async (url: string) => {
    seen.push(url);
    const body =
      seen.length === 1
        ? { rows: [], nextBefore: `900~${tie}` }
        : { rows: [row], nextBefore: `800~${tie}` };
    return new Response(JSON.stringify(body));
  }) as unknown as typeof fetch;
  const page = await loadTypedSearch('name', 'Edward', null, undefined, fetcher);
  assert.equal(page.state === 'ok' && page.value.rows.length, 1);
  assert.equal(page.state === 'ok' && page.value.nextBefore, `800~${tie}`, 'more may follow');
  assert.match(seen[0]!, /kind=name&q=Edward$/);
  assert.match(seen[1]!, new RegExp(`before=900%7E${tie}`));
});

test('typed search preserves observation time and stale sparse-page evidence', async () => {
  const { loadTypedSearch, parseTypedSearch } = await import('../src/explorer/x3Client');
  assert.equal(parseTypedSearch({ rows: [], nextBefore: null, asOf: 123 })?.asOf, 123);
  assert.equal(
    parseTypedSearch({ rows: [], nextBefore: null, asOf: Number.MAX_SAFE_INTEGER })?.asOf,
    null,
  );
  let n = 0;
  const fetcher = (async () =>
    new Response(
      JSON.stringify(
        ++n === 1
          ? { rows: [], nextBefore: `900~${'a'.repeat(32)}`, asOf: 123, stale: true }
          : { rows: [], nextBefore: null, asOf: 456, stale: false },
      ),
    )) as typeof fetch;
  const result = await loadTypedSearch('name', 'sample', null, undefined, fetcher);
  assert.equal(result.state === 'ok' && result.stale, true);
  assert.equal(result.state === 'ok' && result.value.asOf, 123);
});
