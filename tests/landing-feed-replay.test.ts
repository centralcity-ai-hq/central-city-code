import assert from 'node:assert/strict';
import test from 'node:test';
import { FEED_REPLAY, replayPhase } from '../src/landing/FeedReplay';

const raw = (usdc: string) => Math.round(Number(usdc) * 1e6);

test('each replayed payment splits exactly 90% seller and 10% protocol', () => {
  assert.equal(FEED_REPLAY.length, 6);
  for (const p of FEED_REPLAY) {
    assert.equal(raw(p.seller90) + raw(p.fee10), raw(p.price), p.tx);
    assert.equal(raw(p.fee10) * 10, raw(p.price), p.tx);
    assert.match(p.tx, /^0x[0-9a-f]{64}$/);
    assert.match(p.block, /^\d{2},\d{3},\d{3}$/);
  }
  assert.equal(new Set(FEED_REPLAY.map((p) => p.tx)).size, FEED_REPLAY.length);
});

test('the replay signs, pays the router, then splits both branches at once', () => {
  assert.deepEqual(replayPhase(0), { sign: 0, pay: 0, split: 0, fade: 1 });
  const mid = replayPhase(1200);
  assert.equal(mid.sign, 1);
  assert.equal(mid.pay, 1);
  assert.ok(mid.split > 0 && mid.split < 1);
  assert.equal(replayPhase(2000).split, 1);
  assert.equal(replayPhase(4000).fade, 0);
});
