import assert from 'node:assert/strict';
import test from 'node:test';
import type { RatingGiven } from '../src/base/wallet/rate.js';
import {
  GIVEN_CANCELLED,
  GIVEN_FAILED,
  GIVEN_FINAL,
  GIVEN_NEVER_SENT,
  GIVEN_NOTE,
  GIVEN_ON_BASE,
  GIVEN_ON_ITS_WAY,
  givenDate,
  givenFollowed,
  givenName,
  givenOpen,
  givenStatus,
  latestPerAgent,
} from '../src/agents/v4/ratingsGivenModel.js';

const row = (over: Partial<RatingGiven> = {}): RatingGiven => ({
  withdrawalId: 'w-1',
  ratedAgentId: 'agent-1',
  name: 'Harbor',
  baseId: '12345',
  short: 'Ab3dE9',
  stars: 5,
  state: 'final',
  txHash: null,
  blockNumber: null,
  explorerUrl: null,
  createdAt: 1_000,
  updatedAt: 1_000,
  ...over,
});

test('the status line for each stored state: never final before final', () => {
  assert.equal(GIVEN_FINAL, 'Rated ✓ · on Base');
  assert.equal(GIVEN_ON_BASE, 'On Base · final in about 15 minutes');
  assert.equal(GIVEN_ON_ITS_WAY, 'On its way to Base');
  assert.equal(GIVEN_FAILED, 'Didn’t go through');
  assert.equal(GIVEN_NOTE, 'Your latest rating counts.');
  const cases: Array<[Pick<RatingGiven, 'state' | 'safe'>, string, string]> = [
    [{ state: 'final' }, 'final', GIVEN_FINAL],
    [{ state: 'included' }, 'on_base', GIVEN_ON_BASE],
    [{ state: 'included', safe: true }, 'on_base', GIVEN_ON_BASE],
    // A server that says the block isn't at Base's safe head yet: still on its way.
    [{ state: 'included', safe: false }, 'on_its_way', GIVEN_ON_ITS_WAY],
    [{ state: 'submitted' }, 'on_its_way', GIVEN_ON_ITS_WAY],
    [{ state: 'awaiting_signature' }, 'on_its_way', GIVEN_ON_ITS_WAY],
    [{ state: 'cancel_pending' }, 'on_its_way', GIVEN_ON_ITS_WAY],
    [{ state: 'failed' }, 'failed', GIVEN_FAILED],
    [{ state: 'cancelled' }, 'cancelled', GIVEN_CANCELLED],
    [{ state: 'expired' }, 'expired', GIVEN_NEVER_SENT],
    // A `safe` on a final or a failed rating changes nothing.
    [{ state: 'final', safe: false }, 'final', GIVEN_FINAL],
    [{ state: 'failed', safe: true }, 'failed', GIVEN_FAILED],
  ];
  for (const [input, phase, line] of cases)
    assert.deepEqual(givenStatus(input), { phase, line }, JSON.stringify(input));
  // Only "final" says final; nothing before it claims it.
  for (const [input, , line] of cases)
    if (input.state !== 'final') assert.doesNotMatch(line, /✓|^Final|Rated/);
});

test('open and followed: what is read again while it is on its way', () => {
  for (const state of ['awaiting_signature', 'submitted', 'included', 'cancel_pending'] as const)
    assert.equal(givenOpen({ state }), true, state);
  for (const state of ['final', 'failed', 'expired', 'cancelled'] as const)
    assert.equal(givenOpen({ state }), false, state);
  // Never signed: nothing on Base to follow.
  assert.equal(givenFollowed({ state: 'awaiting_signature' }), false);
  for (const state of ['submitted', 'included', 'cancel_pending'] as const)
    assert.equal(givenFollowed({ state }), true, state);
  assert.equal(givenFollowed({ state: 'final' }), false);
});

test('one row per rated agent, its latest, newest first', () => {
  const rows = [
    row({ withdrawalId: 'h-1', ratedAgentId: 'harbor', stars: 2, createdAt: 1_000 }),
    row({ withdrawalId: 'l-1', ratedAgentId: 'lighthouse', stars: 3, createdAt: 2_000 }),
    row({ withdrawalId: 'h-2', ratedAgentId: 'harbor', stars: 5, createdAt: 3_000 }),
    row({ withdrawalId: 'm-1', ratedAgentId: 'mira', stars: 4, createdAt: 2_500 }),
  ];
  assert.deepEqual(
    latestPerAgent(rows).map((one) => [one.withdrawalId, one.stars]),
    [
      ['h-2', 5],
      ['m-1', 4],
      ['l-1', 3],
    ],
  );
  // The order the server answered in doesn't matter.
  assert.deepEqual(
    latestPerAgent([...rows].reverse()).map((one) => one.withdrawalId),
    ['h-2', 'm-1', 'l-1'],
  );
  assert.deepEqual(latestPerAgent([]), []);
});

test('a latest rating that rated nothing gives way to the one that counts', () => {
  const earlier = row({ withdrawalId: 'h-1', state: 'final', stars: 4, createdAt: 1_000 });
  for (const state of ['failed', 'cancelled', 'expired'] as const)
    assert.deepEqual(
      latestPerAgent([earlier, row({ withdrawalId: 'h-2', state, stars: 1, createdAt: 2_000 })]),
      [earlier],
      state,
    );
  // One on its way is the latest: it is shown, on its way.
  const going = row({ withdrawalId: 'h-3', state: 'submitted', createdAt: 3_000 });
  assert.deepEqual(latestPerAgent([earlier, going]), [going]);
  // Only ratings that rated nothing: the latest shows, so the owner sees it didn't go through.
  const failed = row({ withdrawalId: 'h-4', state: 'failed', createdAt: 4_000 });
  assert.deepEqual(latestPerAgent([row({ withdrawalId: 'h-0', state: 'cancelled' }), failed]), [
    failed,
  ]);
});

test('the name shown: public name, else CC-passport, else Base ID; the date', () => {
  assert.equal(givenName(row()), 'Harbor');
  assert.equal(givenName(row({ name: '  ' })), 'CC-Ab3dE9');
  assert.equal(givenName(row({ name: '', short: '' })), 'Base ID 12345');
  assert.match(givenDate(Date.UTC(2026, 9, 11, 12)), /^Oct 1[01]$/);
});
