import assert from 'node:assert/strict';
import test from 'node:test';
import type { StatsResponse } from '../src/agentCount';
import { createPollState, feedStatus, mergeStats, searchKind } from '../src/explorer/homeModel';

const stats = (over: Partial<StatsResponse>): StatsResponse => ({
  agents: null,
  paid: null,
  base: null,
  ageS: 0,
  arrived: 1,
  ...over,
});

test('a partial stats answer keeps the last known numbers instead of erasing them', () => {
  const first = stats({
    agents: { total: 3_009_850, at: 1 },
    paid: {
      total: 656_470,
      asOf: 1,
      recentMs: [],
      recentComplete: true,
      valueRaw: null,
    },
    base: { total: 1_017_416, asOf: 1 },
  });
  const partial = stats({ agents: { total: 3_009_900, at: 2 }, arrived: 2 });
  const merged = mergeStats(first, partial);
  assert.equal(merged.agents?.total, 3_009_900, 'a new number replaces the old one');
  assert.equal(merged.paid?.total, 656_470, 'a missing number keeps its last value');
  assert.equal(merged.base, first.base);
  assert.equal(merged.arrived, 2);
  assert.equal(mergeStats(null, partial), partial, 'nothing known yet: take the answer as is');
});

test('a transaction hash searches paid calls; anything else searches agents on Base', () => {
  assert.equal(searchKind(`0x${'ab'.repeat(32)}`), 'tx');
  assert.equal(searchKind('  426846 '), 'agents');
  assert.equal(searchKind('Edward'), 'agents');
  assert.equal(searchKind('0x524c'), 'agents', 'a short hex is a wallet or name search');
  assert.equal(searchKind('   '), 'empty');
});

test('a feed says loading, live, stale or failed, never live without a recent answer', () => {
  const every = 15_000;
  assert.equal(feedStatus({ lastOk: null, failed: false }, 0, every), 'loading');
  assert.equal(feedStatus({ lastOk: null, failed: true }, 0, every), 'failed', 'first read failed');
  assert.equal(feedStatus({ lastOk: 1_000, failed: false }, 10_000, every), 'live');
  assert.equal(
    feedStatus({ lastOk: 1_000, failed: true }, 10_000, every),
    'stale',
    'a read failed after a success: the last answer is shown as not refreshed',
  );
  assert.equal(
    feedStatus({ lastOk: 1_000, failed: false }, 1_000 + every * 3 + 1, every),
    'stale',
    'no answer for three refreshes',
  );
});

test('the poller: one read at a time, a stuck read stops blocking, a late read commits nothing', () => {
  const poll = createPollState(30_000);
  const a = poll.begin(0)!;
  assert.equal(poll.begin(10_000), null, 'a read in flight blocks the next');
  const b = poll.begin(31_000);
  assert.ok(b, 'after 30 s the stuck read no longer blocks');
  assert.equal(a.isCurrent(), false, 'the superseded read is no longer current');
  assert.equal(b!.isCurrent(), true);
  a.done();
  assert.equal(poll.begin(32_000), null, "the late read's done() does not clear the newer read");
  b!.done();
  const c = poll.begin(33_000);
  assert.ok(c, 'after the newest read settles, the next one starts');
  poll.stop();
  assert.equal(c!.isCurrent(), false, 'stopping makes every read stale');
});

test('typed search kinds: wallet, transaction, Base ID, short id, name; a forced name wins', async () => {
  const { typedKind, couldBeName } = await import('../src/explorer/homeModel');
  assert.equal(typedKind(`0x${'ab'.repeat(20)}`), 'address');
  assert.equal(typedKind(`0x${'ab'.repeat(32)}`), 'txHash');
  assert.equal(typedKind(' 426816 '), 'baseId');
  assert.equal(typedKind('XeAK9B'), 'shortId');
  assert.equal(typedKind('Edward Scout'), 'name');
  assert.equal(typedKind('E'), null, 'a 1-character name is refused, as the server does');
  assert.equal(typedKind('426816', true), 'name');
  assert.equal(couldBeName('426816'), true, 'digits may be a name');
  assert.equal(couldBeName('XeAK9B'), true, 'six characters may be a name');
  assert.equal(couldBeName(`0x${'ab'.repeat(20)}`), false);
});
