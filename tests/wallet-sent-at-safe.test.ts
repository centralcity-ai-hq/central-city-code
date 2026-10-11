import assert from 'node:assert/strict';
import test from 'node:test';
import type { Hex } from 'viem';
import type { RpcUserOperation, WithdrawalState } from '../shared/base/withdraw.js';
import {
  clearAnchor,
  dropReleased,
  readAnchor,
  readReleased,
  releaseAnchor,
  releaseIfDone,
  saveAnchor,
  SENT_HEADLINE,
  SENT_NOTE,
  sentStatus,
} from '../src/base/wallet/withdraw.js';

/*
 * Sent at Base's safe head (src/base/wallet/withdraw.ts): what each screen says for every state the
 * server reads and every `safe` it sends (or doesn't, an older server), and the anchor that is
 * released only while it is still the operation's own.
 */

const STATES: WithdrawalState[] = [
  'awaiting_signature',
  'submitted',
  'included',
  'final',
  'failed',
  'expired',
  'cancel_pending',
  'cancelled',
];
const SAFE = [true, false, undefined] as const;
const NOUNS = ['payment', 'withdrawal'] as const;
/** Words that say it is done; none may show before Base says final. */
const FINAL_WORDS = /\b(paid|done|final|withdrawn)\b|✓/i;

test('included and safe reads “Sent · awaiting finality”, with the quiet note and no countdown', () => {
  for (const noun of NOUNS) {
    const status = sentStatus({ state: 'included', safe: true }, noun);
    assert.equal(status.phase, 'sent');
    assert.equal(status.headline, 'Sent · awaiting finality');
    assert.equal(status.headline, SENT_HEADLINE);
    assert.equal(status.note, 'Final in about 15 minutes.');
    assert.equal(status.note, SENT_NOTE);
    assert.equal(status.released, true);
  }
});

test('every state × safe: nothing final before final, and “Sent” always awaits finality', () => {
  for (const noun of NOUNS)
    for (const state of STATES)
      for (const safe of SAFE) {
        const status = sentStatus({ state, safe }, noun);
        const where = JSON.stringify({ noun, state, safe });
        if (state === 'final') {
          assert.equal(status.phase, 'final', where);
          assert.equal(status.headline, noun === 'payment' ? 'Paid ✓' : 'Withdrawn ✓', where);
          assert.equal(status.short, status.headline, where);
          assert.equal(status.released, true, where);
          continue;
        }
        assert.doesNotMatch(status.headline ?? '', FINAL_WORDS, where);
        assert.doesNotMatch(status.short, FINAL_WORDS, where);
        // The note is only ever the estimate, and only with “Sent”.
        assert.ok(status.note === null || status.note === SENT_NOTE, where);
        assert.equal(status.note !== null, status.phase === 'sent', where);
        for (const text of [status.headline ?? '', status.short])
          if (/\bSent\b/.test(text)) assert.match(text, /awaiting finality/, where);
        // “Sent” needs exactly included and safe true, from the GET read.
        assert.equal(status.phase === 'sent', state === 'included' && safe === true, where);
      }
});

test('without safe (an older server), or safe false, every screen stays as it was', () => {
  for (const noun of NOUNS)
    for (const safe of [false, undefined]) {
      for (const state of ['awaiting_signature', 'submitted', 'included'] as const) {
        const status = sentStatus({ state, safe }, noun);
        assert.equal(status.phase, 'on_its_way');
        assert.equal(status.headline, null);
        assert.equal(status.note, null);
        assert.equal(status.released, false);
      }
      assert.equal(sentStatus({ state: 'cancel_pending', safe }, noun).headline, null);
      assert.equal(sentStatus({ state: 'cancel_pending', safe }, noun).released, false);
      for (const state of ['failed', 'expired', 'cancelled'] as const) {
        assert.equal(sentStatus({ state, safe }, noun).headline, null);
        assert.equal(sentStatus({ state, safe }, noun).released, true);
      }
    }
});

test('a later read that is no longer safe, or no longer included, shows what it says now', () => {
  assert.equal(sentStatus({ state: 'included', safe: true }, 'payment').phase, 'sent');
  assert.equal(sentStatus({ state: 'included', safe: false }, 'payment').short, 'In a block');
  assert.equal(sentStatus({ state: 'submitted', safe: true }, 'payment').short, 'On its way');
  // Never an automatic failure: only the server's own 'failed' says it didn't go through.
  assert.notEqual(sentStatus({ state: 'submitted', safe: false }, 'payment').phase, 'failed');
});

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
}

function withStorage(run: (store: Map<string, string>) => void) {
  const globals = globalThis as { localStorage?: unknown };
  const before = globals.localStorage;
  const storage = memoryStorage();
  globals.localStorage = storage;
  try {
    run(storage.store);
  } finally {
    globals.localStorage = before;
  }
}

const op = {} as RpcUserOperation;
const anchorFor = (withdrawalId: string, hashByte: string) => ({
  withdrawalId,
  userOperation: op,
  userOpHash: `0x${hashByte.repeat(32)}` as Hex,
});

test('the anchor is cleared only while it is still that operation’s', () => {
  withStorage(() => {
    const older = anchorFor('w-1', '11');
    const newer = anchorFor('w-2', '22');
    saveAnchor('agent-1', newer);
    // An older operation finishing never clears the newer one.
    clearAnchor('agent-1', older);
    assert.equal(readAnchor('agent-1')?.withdrawalId, 'w-2');
    // The same id with another hash isn't it either.
    clearAnchor('agent-1', { withdrawalId: 'w-2', userOpHash: older.userOpHash });
    assert.equal(readAnchor('agent-1')?.withdrawalId, 'w-2');
    // Its own: cleared (the hash in any case).
    clearAnchor('agent-1', { withdrawalId: 'w-2', userOpHash: newer.userOpHash.toUpperCase() });
    assert.equal(readAnchor('agent-1'), null);
    // Another agent's anchor is never touched.
    saveAnchor('agent-2', older);
    clearAnchor('agent-1', older);
    assert.equal(readAnchor('agent-2')?.withdrawalId, 'w-1');
  });
});

test('released at the safe head: recorded first, the anchor cleared only if still its own', () => {
  withStorage((store) => {
    const payment = { name: 'Harbor', short: 'Ab3dE9', baseId: '12345', note: null };
    const first = anchorFor('w-1', '11');
    saveAnchor('agent-1', { ...first, payment });
    assert.equal(releaseAnchor('agent-1', { ...first, payment }), true);
    assert.equal(readAnchor('agent-1'), null);
    assert.deepEqual(
      readReleased('agent-1').map((entry) => [entry.withdrawalId, entry.payment?.name]),
      [['w-1', 'Harbor']],
    );
    // Released again (another tab, a later read): still one record, and a newer anchor stays.
    const second = anchorFor('w-2', '22');
    saveAnchor('agent-1', second);
    releaseAnchor('agent-1', first);
    assert.equal(readAnchor('agent-1')?.withdrawalId, 'w-2');
    assert.equal(readReleased('agent-1').length, 1);
    // Done: its record goes; the others stay.
    releaseAnchor('agent-1', second);
    assert.deepEqual(
      readReleased('agent-1').map((entry) => entry.withdrawalId),
      ['w-2', 'w-1'],
    );
    dropReleased('agent-1', 'w-1');
    assert.deepEqual(
      readReleased('agent-1').map((entry) => entry.withdrawalId),
      ['w-2'],
    );
    dropReleased('agent-1', 'w-2');
    assert.equal(store.has('cc-withdrawal-released:agent-1'), false);
    // Older than a day: no longer listed.
    store.set(
      'cc-withdrawal-released:agent-1',
      JSON.stringify([{ ...first, releasedAt: Date.now() - 25 * 60 * 60_000 }]),
    );
    assert.deepEqual(readReleased('agent-1'), []);
  });
});

test('a record that can’t be kept leaves the anchor in place', () => {
  withStorage(() => {
    const first = anchorFor('w-1', '11');
    saveAnchor('agent-1', first);
    const globals = globalThis as { localStorage?: { setItem: unknown } };
    globals.localStorage!.setItem = () => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    };
    assert.equal(releaseAnchor('agent-1', first), false);
    assert.equal(readAnchor('agent-1')?.withdrawalId, 'w-1');
  });
});

test('already done at the first read: released over an empty form; on its way: kept', () => {
  withStorage(() => {
    const payment = { name: 'Harbor', short: 'Ab3dE9', baseId: '12345', note: null };
    // Anchored before its names were kept, and anchored with them.
    for (const names of [undefined, payment])
      for (const state of STATES) {
        const where = JSON.stringify({ names: !!names, state });
        const anchor = { ...anchorFor('w-1', '11'), payment: names };
        saveAnchor('agent-1', anchor);
        const done = ['final', 'failed', 'expired', 'cancelled'].includes(state);
        const view = { withdrawalId: 'w-1', userOpHash: anchor.userOpHash, state };
        assert.equal(releaseIfDone('agent-1', readAnchor('agent-1')!, view), done, where);
        assert.equal(readAnchor('agent-1')?.withdrawalId, done ? undefined : 'w-1', where);
        const kept = readReleased('agent-1');
        assert.deepEqual(
          kept.map((entry) => [entry.withdrawalId, entry.payment?.name]),
          done ? [['w-1', names?.name]] : [],
          where,
        );
        dropReleased('agent-1', 'w-1');
        clearAnchor('agent-1', anchor);
      }
    // Another operation under its id (another hash) is never released, even final.
    const anchor = anchorFor('w-1', '11');
    saveAnchor('agent-1', anchor);
    const other = { withdrawalId: 'w-1', userOpHash: anchorFor('w-1', '22').userOpHash };
    assert.equal(releaseIfDone('agent-1', anchor, { ...other, state: 'final' }), false);
    assert.equal(
      releaseIfDone('agent-1', anchor, { ...anchorFor('w-2', '11'), state: 'final' }),
      false,
    );
    assert.equal(readAnchor('agent-1')?.withdrawalId, 'w-1');
    assert.deepEqual(readReleased('agent-1'), []);
  });
});

test('done at the first read, but its record can’t be kept: the anchor stays', () => {
  withStorage(() => {
    const anchor = anchorFor('w-1', '11');
    saveAnchor('agent-1', anchor);
    const globals = globalThis as { localStorage?: { setItem: unknown } };
    globals.localStorage!.setItem = () => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    };
    assert.equal(releaseIfDone('agent-1', anchor, { ...anchor, state: 'final' }), false);
    assert.equal(readAnchor('agent-1')?.withdrawalId, 'w-1');
  });
});
