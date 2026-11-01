import assert from 'node:assert/strict';
import test from 'node:test';
import { loadRatedIds, readListWithRetry } from '../src/explorer/listRead';
import type { OnBaseList } from '../src/verify/onBaseData';

const LIST = { rows: [] } as unknown as OnBaseList;
const noSleep = async () => {};

test('a failed list read is retried and the later answer is returned', async () => {
  let calls = 0;
  const slept: number[] = [];
  const list = await readListWithRetry(
    () => true,
    [2_000, 5_000],
    async () => {
      calls += 1;
      if (calls < 3) throw new Error(`timeout ${calls}`);
      return LIST;
    },
    async (ms) => {
      slept.push(ms);
    },
  );
  assert.equal(list, LIST);
  assert.equal(calls, 3);
  assert.deepEqual(slept, [2_000, 5_000], 'waits 2 s, then 5 s');
});

test('after three failed reads the last error is thrown, never an empty list', async () => {
  let calls = 0;
  await assert.rejects(
    readListWithRetry(
      () => true,
      [2_000, 5_000],
      async () => {
        calls += 1;
        throw new Error(`timeout ${calls}`);
      },
      noSleep,
    ),
    /timeout 3/,
  );
  assert.equal(calls, 3, 'one read plus two retries, no more');
});

test('leaving the page during a backoff stops any further request', async () => {
  let calls = 0;
  let live = true;
  await assert.rejects(
    readListWithRetry(
      () => live,
      [2_000, 5_000],
      async () => {
        calls += 1;
        throw new Error('timeout');
      },
      async () => {
        live = false;
      },
    ),
    /left/,
  );
  assert.equal(calls, 1, 'no new request after the page was left');
});

const answer = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test('rated IDs: only a well-formed answer counts; an empty list is valid, a malformed one is an error', async () => {
  assert.deepEqual(await loadRatedIds(undefined, answer({ baseIds: ['124', '120'], asOf: 5 })), {
    ids: ['124', '120'],
    asOf: 5,
  });
  assert.deepEqual(await loadRatedIds(undefined, answer({ baseIds: [], asOf: 5 })), {
    ids: [],
    asOf: 5,
  });
  for (const bad of [
    {},
    { baseIds: null, asOf: 5 },
    { baseIds: ['12a'], asOf: 5 },
    { baseIds: [12], asOf: 5 },
    { baseIds: ['1'] },
  ])
    await assert.rejects(loadRatedIds(undefined, answer(bad)), /malformed/, JSON.stringify(bad));
  await assert.rejects(loadRatedIds(undefined, answer({ error: 'x' }, 503)), /503/);
});

test('rated IDs: the request always carries a deadline, combined with the page signal', async () => {
  let seen: AbortSignal | null | undefined;
  const spy = (async (_url: unknown, init?: RequestInit) => {
    seen = init?.signal;
    return new Response(JSON.stringify({ baseIds: [], asOf: 1 }));
  }) as unknown as typeof fetch;
  const page = new AbortController();
  await loadRatedIds(page.signal, spy);
  assert.ok(seen, 'a signal is always passed');
  page.abort();
  assert.equal(seen!.aborted, true, 'leaving the page aborts it');
  seen = undefined;
  await loadRatedIds(undefined, spy);
  const second = seen as AbortSignal | null | undefined;
  assert.ok(second && !second.aborted, 'without a page signal there is still a deadline');
});
