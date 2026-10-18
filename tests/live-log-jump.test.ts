import assert from 'node:assert/strict';
import test from 'node:test';
import { LEAVES_PAGE, leavesBetween } from '../src/verify/countLogClient';

/** A fake leaves endpoint that, like the server, answers at most LEAVES_PAGE leaves per request. */
function fakeLog(size: number) {
  const asked: string[] = [];
  const get = async (path: string) => {
    asked.push(path);
    const url = new URL(path, 'https://x');
    const from = Number(url.searchParams.get('from'));
    const to = Math.min(Number(url.searchParams.get('to')), size, from + LEAVES_PAGE);
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

test('a short jump is a single request', async () => {
  const log = fakeLog(500);
  assert.deepEqual(
    (await leavesBetween(95, 100, log.get)).map((leaf) => leaf.idx),
    [95, 96, 97, 98, 99],
  );
  assert.deepEqual(log.asked, ['/api/public/count-log/leaves?from=95&to=100']);
});

test('stops when the log has nothing more', async () => {
  const log = fakeLog(10);
  assert.equal((await leavesBetween(5, 50, log.get)).length, 5);
});
