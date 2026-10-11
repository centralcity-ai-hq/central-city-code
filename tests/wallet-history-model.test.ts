import assert from 'node:assert/strict';
import test from 'node:test';
import type { Hex } from 'viem';
import {
  DONE_SHOWN_MS,
  explorerOf,
  merged,
  nextSweep,
  OUTCOME_READS_PER_TICK,
  pollDelay,
  POLL_MS,
  SAFE_POLL_MS,
  stateOf,
  textOf,
  toReadAlone,
  visibleLines,
  type Line,
} from '../src/agents/v4/walletHistoryModel.js';
import type { LaneRecord, WithdrawalView } from '../src/base/wallet/withdraw.js';

/*
 * History (pay without waiting): what each line says (the status screens' own words), which lines
 * show and for how long once done, which operations are read alone, and when the list is read next.
 */

const HASH = `0x${'11'.repeat(32)}` as Hex;
const TX = `0x${'ee'.repeat(32)}`;
const HARBOR = { name: 'Harbor', short: 'Ab3dE9', baseId: '12345', note: null };

const view = (
  id: string,
  state: WithdrawalView['state'],
  extra: Partial<WithdrawalView> = {},
): WithdrawalView =>
  ({
    withdrawalId: id,
    state,
    token: 'USDC',
    amount: { raw: '12500000', decimals: 6, display: '12.5' },
    to: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    userOpHash: HASH,
    txHash: state === 'submitted' ? null : TX,
    blockNumber: state === 'submitted' ? null : 52_441_300,
    explorerUrl: state === 'submitted' ? null : `https://basescan.org/tx/${TX}`,
    cancel: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...extra,
  }) as WithdrawalView;

const line = (id: string, state: WithdrawalView['state'], at: number, extra = {}): Line => ({
  view: view(id, state, extra),
  payment: HARBOR,
  at,
});

test('a line: amount, recipient name or short address, and the status screens’ own words', () => {
  assert.equal(textOf(line('w-1', 'submitted', 1)), '12.50 USDC to Harbor');
  assert.equal(textOf({ view: view('w-1', 'submitted') }), '12.50 USDC to 0x3C44…93BC');
  assert.equal(
    textOf({ view: view('w-1', 'submitted'), payment: { ...HARBOR, name: ' ' } }),
    '12.50 USDC to CC-Ab3dE9',
  );
  const words = (state: WithdrawalView['state'], safe?: boolean, payment = true) =>
    stateOf({ view: view('w-1', state, { safe }), payment: payment ? HARBOR : undefined }).short;
  assert.equal(words('submitted'), 'On its way');
  assert.equal(words('included'), 'In a block');
  assert.equal(words('included', false), 'In a block');
  assert.equal(words('included', true), 'Sent · awaiting finality');
  assert.equal(words('final', true), 'Paid ✓');
  assert.equal(words('final', true, false), 'Withdrawn ✓');
  assert.equal(words('failed'), 'Didn’t go through');
  assert.equal(words('cancel_pending'), 'Cancelling');
  assert.equal(words('cancelled'), 'Cancelled');
  // Kept here after an unclear answer, the server still awaiting its signature: never on its way.
  assert.equal(words('awaiting_signature'), 'Not sent yet');
  assert.equal(words('expired'), 'Never sent');
});

test('Basescan only for an operation in a block, and only a Basescan transaction link', () => {
  assert.equal(explorerOf(view('w-1', 'submitted')), null);
  assert.equal(explorerOf(view('w-1', 'included')), `https://basescan.org/tx/${TX}`);
  assert.equal(
    explorerOf(view('w-1', 'included', { explorerUrl: `https://sepolia.basescan.org/tx/${TX}` })),
    `https://sepolia.basescan.org/tx/${TX}`,
  );
  for (const explorerUrl of [
    `https://basescan.org.evil.example/tx/${TX}`,
    `http://basescan.org/tx/${TX}`,
    `javascript:alert(1)//https://basescan.org/tx/${TX}`,
    `https://basescan.org/address/${TX}`,
  ])
    assert.equal(explorerOf(view('w-1', 'included', { explorerUrl })), null, explorerUrl);
});

test('a line keeps this browser’s record only while its hash is the server’s', () => {
  const record: LaneRecord = {
    withdrawalId: 'w-1',
    userOperation: {} as LaneRecord['userOperation'],
    userOpHash: HASH,
    payment: HARBOR,
    signedAt: 500,
    laned: true,
  };
  const mine = merged(undefined, view('w-1', 'submitted'), record);
  assert.equal(mine.record, record);
  assert.deepEqual(mine.payment, HARBOR);
  assert.equal(mine.at, 500);
  // Read again without the record: still bound, still named, same place in the list.
  const again = merged(mine, view('w-1', 'included'), undefined);
  assert.equal(again.record, record);
  assert.equal(again.at, 500);
  // Another operation under that id: never cancelled from here as the one signed here.
  const other = merged(
    mine,
    view('w-1', 'submitted', { userOpHash: `0x${'22'.repeat(32)}` }),
    record,
  );
  assert.equal(other.record, undefined);
  // Signed elsewhere: no record, placed by when the server made it.
  const elsewhere = merged(undefined, view('w-9', 'submitted', { createdAt: 42 }), undefined);
  assert.equal(elsewhere.record, undefined);
  assert.equal(elsewhere.payment, undefined);
  assert.equal(elsewhere.at, 42);
});

test('newest first; a finished line shows how it ended, then leaves after DONE_SHOWN_MS', () => {
  const known = new Map<string, Line>([
    ['w-1', line('w-1', 'final', 100, { safe: true })],
    ['w-2', line('w-2', 'submitted', 300)],
    ['w-3', line('w-3', 'included', 200)],
  ]);
  const done = new Map<string, number>([['w-1', 10_000]]);
  let shown = visibleLines(known, done, 10_000 + DONE_SHOWN_MS - 1);
  assert.deepEqual(
    shown.map((each) => [each.view.withdrawalId, each.done]),
    [
      ['w-2', false],
      ['w-3', false],
      ['w-1', true],
    ],
  );
  assert.equal(nextSweep(known, done, 10_000), DONE_SHOWN_MS);
  assert.equal(nextSweep(known, done, 10_000 + DONE_SHOWN_MS - 1), 250);
  shown = visibleLines(known, done, 10_000 + DONE_SHOWN_MS);
  assert.deepEqual(
    shown.map((each) => each.view.withdrawalId),
    ['w-2', 'w-3'],
  );
  // Gone from the list, still known as done (never read again), and nothing left to sweep.
  assert.equal(known.has('w-1'), false);
  assert.equal(done.has('w-1'), true);
  assert.equal(nextSweep(known, done, 10_000 + DONE_SHOWN_MS), null);
});

test('read alone: what left the open list (or all, when it can’t be read), a few per tick', () => {
  const known = new Map<string, Line>([
    ['w-1', line('w-1', 'submitted', 1)],
    ['w-2', line('w-2', 'submitted', 2)],
    ['w-3', line('w-3', 'final', 3)],
  ]);
  const done = new Map<string, number>([['w-3', 1]]);
  const kept = [{ withdrawalId: 'w-4' }, { withdrawalId: 'w-2' }, { withdrawalId: 'w-3' }];
  assert.deepEqual(toReadAlone(known, done, new Set(['w-2']), kept), ['w-1', 'w-4']);
  assert.deepEqual(toReadAlone(known, done, null, kept), ['w-1', 'w-2', 'w-4']);
  const many = Array.from({ length: 10 }, (_, at) => ({ withdrawalId: `k-${at}` }));
  assert.equal(toReadAlone(new Map(), new Map(), null, many).length, OUTCOME_READS_PER_TICK);
});

test('read again every 3 s while one moves, slower once all are safe, never when nothing is open', () => {
  const done = new Map<string, number>();
  const moving = new Map<string, Line>([
    ['w-1', line('w-1', 'included', 1, { safe: true })],
    ['w-2', line('w-2', 'submitted', 2)],
  ]);
  assert.equal(pollDelay(moving, done, false, true), POLL_MS);
  // The list can't be read: slower, from this browser's records.
  assert.equal(pollDelay(moving, done, false, false), SAFE_POLL_MS);
  const safe = new Map<string, Line>([['w-1', line('w-1', 'included', 1, { safe: true })]]);
  assert.equal(pollDelay(safe, done, false, true), SAFE_POLL_MS);
  // Done ones don't count; nothing open and nothing kept: no more reads.
  const finished = new Map<string, Line>([['w-1', line('w-1', 'final', 1)]]);
  assert.equal(pollDelay(finished, new Map([['w-1', 1]]), false, true), null);
  assert.equal(pollDelay(new Map(), done, false, true), null);
  // Something this browser signed isn't shown yet: read on.
  assert.equal(pollDelay(new Map(), done, true, true), SAFE_POLL_MS);
});
