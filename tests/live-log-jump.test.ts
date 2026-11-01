import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LEAVES_BLOCK,
  LEAVES_PAGE,
  RETRY_WAIT_MAX_MS,
  RetryLater,
  json,
  leavesBetween,
} from '../src/verify/countLogClient';
import { LEAVES_RATE } from '../server/count-log/routes';

/** A fake leaves endpoint that, like the server, answers aligned blocks only. */
function fakeLog(size: number) {
  const asked: string[] = [];
  const get = async (path: string) => {
    asked.push(path);
    const url = new URL(path, 'https://x');
    const from = Number(url.searchParams.get('from'));
    const block = Number(url.searchParams.get('to')) - from;
    if (![LEAVES_PAGE, LEAVES_BLOCK, 1].includes(block) || from % block !== 0)
      throw new Error(`unaligned ${path}`);
    const to = Math.min(from + block, size);
    return {
      leaves: Array.from({ length: Math.max(0, to - from) }, (_, i) => ({ idx: from + i })),
    };
  };
  return { asked, get };
}

test('a jump more than one page below the oldest row loads every leaf in between', async () => {
  const log = fakeLog(29_950);
  const leaves = await leavesBetween(0, 29_950, log.get);
  assert.equal(leaves.length, 29_950);
  assert.ok(leaves.every((leaf, i) => leaf.idx === i));
  assert.equal(log.asked.length, 3);
});

test('a short jump is a single request for the aligned block around it', async () => {
  const log = fakeLog(500);
  assert.deepEqual(
    (await leavesBetween(95, 100, log.get)).map((leaf) => leaf.idx),
    [95, 96, 97, 98, 99],
  );
  assert.deepEqual(log.asked, ['/api/public/count-log/leaves?from=0&to=100']);
});

test('a range across small blocks asks each block once and keeps only the range', async () => {
  const log = fakeLog(500);
  const leaves = await leavesBetween(150, 260, log.get);
  assert.deepEqual(
    leaves.map((leaf) => leaf.idx),
    Array.from({ length: 110 }, (_, i) => 150 + i),
  );
  assert.deepEqual(log.asked, [
    '/api/public/count-log/leaves?from=100&to=200',
    '/api/public/count-log/leaves?from=200&to=300',
  ]);
});

test('a long range unaligned at both ends reads full pages', async () => {
  const log = fakeLog(25_000);
  const leaves = await leavesBetween(3, 20_005, log.get);
  assert.equal(leaves.length, 20_002);
  assert.equal(leaves[0]!.idx, 3);
  assert.equal(leaves.at(-1)!.idx, 20_004);
  assert.deepEqual(log.asked, [
    '/api/public/count-log/leaves?from=0&to=10000',
    '/api/public/count-log/leaves?from=10000&to=20000',
    '/api/public/count-log/leaves?from=20000&to=30000',
  ]);
});

test('stops when the log has nothing more', async () => {
  const log = fakeLog(10);
  assert.equal((await leavesBetween(5, 50, log.get)).length, 5);
});

test('a 429 in the middle of a scan waits for Retry-After and goes on with the same block', async () => {
  const log = fakeLog(35_000);
  const waits: number[] = [];
  let refused = 0;
  const get = async (path: string) => {
    if (path.includes('from=20000') && refused++ === 0) throw new RetryLater(path, 7_000);
    return log.get(path);
  };
  const leaves = await leavesBetween(0, 35_000, get, undefined, async (ms) => {
    waits.push(ms);
  });
  assert.equal(leaves.length, 35_000);
  assert.ok(leaves.every((leaf, i) => leaf.idx === i));
  assert.deepEqual(waits, [7_000]);
  assert.equal(log.asked.filter((path) => path.includes('from=20000')).length, 1);
  // Any other failure still fails the read.
  await assert.rejects(
    leavesBetween(0, 100, async () => {
      throw new Error('/api/public/count-log/leaves 500');
    }),
    /500/,
  );
});

test('one address reads a log of more pages than the per-address limit in full', async () => {
  // Every page an edge miss, against the route's per-address limit over a one-minute window.
  const pages = LEAVES_RATE.perSource * 2 + 37;
  const log = fakeLog(pages * LEAVES_PAGE);
  let now = 0;
  const hits: number[] = [];
  const get = async (path: string) => {
    while (hits.length && hits[0]! <= now - LEAVES_RATE.windowMs) hits.shift();
    if (hits.length >= LEAVES_RATE.perSource)
      throw new RetryLater(path, Math.ceil((hits[0]! + LEAVES_RATE.windowMs - now) / 1000) * 1000);
    hits.push(now);
    now += 50;
    return log.get(path);
  };
  const leaves = await leavesBetween(0, pages * LEAVES_PAGE, get, undefined, async (ms) => {
    now += ms;
  });
  assert.equal(leaves.length, pages * LEAVES_PAGE);
  assert.equal(leaves.at(-1)!.idx, pages * LEAVES_PAGE - 1);
});

test('json turns a 429 into RetryLater with the bounded Retry-After', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let retryAfter: string | null = '12';
  globalThis.fetch = async () =>
    new Response('{}', {
      status: 429,
      headers: retryAfter === null ? {} : { 'retry-after': retryAfter },
    });
  const waitOf = async () => {
    try {
      await json('/api/public/count-log/leaves?from=0&to=100');
    } catch (error) {
      assert.ok(error instanceof RetryLater);
      return error.waitMs;
    }
    assert.fail('no RetryLater');
  };
  assert.equal(await waitOf(), 12_000);
  retryAfter = '3600';
  assert.equal(await waitOf(), RETRY_WAIT_MAX_MS);
  retryAfter = null;
  assert.equal(await waitOf(), 5_000);
});
