import assert from 'node:assert/strict';
import test from 'node:test';
import type { Hex, PublicClient } from 'viem';
import { READ_RATE } from '../server/base/wallet/withdraw-routes.js';
import { post, rawSign, read, setup, signedWithdrawal } from './mpr-2-fixture.js';

/**
 * Path 2 review (sponsored withdrawals), finding "the withdrawal POST routes that bring an
 * operation up to date from Base have no per-person rate limit" (R6-4 fix incomplete).
 *
 * R6-4 put READ_RATE (`wallet-read`, 120/min per person) in front of GET …/withdrawals/:id because
 * every read runs advance(): uncached bundler and Base reads on the shared keyed endpoint. The
 * POST …/:id/signature, …/:id/cancel and …/:id/cancel/signature routes
 * (server/base/wallet/withdraw-routes.ts) run the very same advance() on every call but called no
 * limiter at all.
 *
 * Fixed behaviour: all three take the per-person READ_RATE budget before the service runs, so a
 * person who spends it is refused (429) before Base is read again.
 *
 * Before the fix these tests FAIL (no key is charged, nothing is ever refused).
 */

/** A limiter like server/app.ts's: `max` hits per key, then 429. */
function countingLimiter() {
  const hits = new Map<string, number>();
  const keys: string[] = [];
  let max = Infinity;
  return {
    keys,
    hits,
    cap(n: number) {
      max = n;
      hits.clear();
    },
    limit: async (key: string, keyMax: number, windowMs: number) => {
      keys.push(`${key}|${keyMax}|${windowMs}`);
      const n = (hits.get(key) ?? 0) + 1;
      hits.set(key, n);
      if (n > Math.min(max, keyMax))
        throw Object.assign(new Error('Too many requests.'), { statusCode: 429 });
    },
  };
}

function countingClient(counter: { reads: number }) {
  return (client: PublicClient) =>
    new Proxy(client, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          counter.reads++;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as PublicClient;
}

test('mpr-2: POST signature/cancel/cancel-signature take the per-person read budget', async (t) => {
  const limiter = countingLimiter();
  const f = await setup(t, { limit: limiter.limit });
  const body = await signedWithdrawal(f, 1);
  const expected = `${READ_RATE.prefix}:person-1|${READ_RATE.max}|${READ_RATE.windowMs}`;

  limiter.keys.length = 0;
  const asked = await post(f, `${body.withdrawalId}/cancel`, {});
  assert.equal(asked.statusCode, 200, asked.body);
  assert.deepEqual(limiter.keys, [expected], 'POST cancel is charged');

  limiter.keys.length = 0;
  const replay = await post(f, `${body.withdrawalId}/signature`, {
    signature: await rawSign(f.owner, body.userOpHash),
  });
  assert.equal(replay.statusCode, 202, replay.body);
  assert.deepEqual(limiter.keys, [expected], 'POST signature is charged');

  limiter.keys.length = 0;
  const signedCancel = await post(f, `${body.withdrawalId}/cancel/signature`, {
    signature: await rawSign(f.owner, asked.json().cancel.userOpHash as Hex),
  });
  assert.equal(signedCancel.statusCode, 202, signedCancel.body);
  assert.deepEqual(limiter.keys, [expected], 'POST cancel/signature is charged');

  // GET :id keeps the same budget (R6-4).
  limiter.keys.length = 0;
  await read(f, body.withdrawalId);
  assert.deepEqual(limiter.keys, [expected]);
});

test('mpr-2: 50 POSTs on one withdrawal are limited per person before Base is read', async (t) => {
  const limiter = countingLimiter();
  const counter = { reads: 0 };
  const f = await setup(t, { portClient: countingClient(counter), limit: limiter.limit });
  const body = await signedWithdrawal(f, 1);
  const asked = await post(f, `${body.withdrawalId}/cancel`, {});
  assert.equal(asked.statusCode, 200, asked.body);
  assert.equal(asked.json().state, 'cancel_pending');
  const signature = await rawSign(f.owner, body.userOpHash);

  // A budget of 10 for this run: 50 POSTs, 10 served, 40 refused.
  limiter.cap(10);
  const statuses: number[] = [];
  let readsWhenSpent = -1;
  for (let i = 0; i < 25; i++) {
    statuses.push((await post(f, `${body.withdrawalId}/cancel`, {})).statusCode);
    statuses.push((await post(f, `${body.withdrawalId}/signature`, { signature })).statusCode);
    if (i === 4) readsWhenSpent = counter.reads;
  }
  t.diagnostic(`statuses: ${statuses.join(',')}; chain calls: ${counter.reads}`);
  assert.equal(statuses.filter((s) => s === 429).length, 40, 'the 40 POSTs past the budget');
  assert.deepEqual(
    statuses.slice(0, 10),
    [200, 202, 200, 202, 200, 202, 200, 202, 200, 202],
    'the first 10 are served',
  );
  assert.equal(counter.reads, readsWhenSpent, 'no Base read once the budget is spent');
});
