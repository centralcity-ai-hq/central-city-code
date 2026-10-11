import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { encodeFunctionData, getAddress, parseAbi, type Hex } from 'viem';
import type { UserOperation } from 'viem/account-abstraction';
import { BASE_NETWORKS } from '../shared/base/chains.js';
import {
  LANE_DOMAIN,
  laneKey,
  LaneKeyError,
  laneNonce,
  nonceKeyOf,
  nonceSeqOf,
  REPLAYABLE_NONCE_KEY,
  usableLaneKey,
} from '../shared/base/lanes.js';
import {
  noopCall,
  ownerOperationHash,
  userOperationToRpc,
  withdrawalCall,
  WITHDRAWAL_CHAIN_ID,
  WITHDRAWAL_ENTRY_POINT,
  type OwnerCallEncoding,
} from '../shared/base/withdraw.js';
import { ApiError } from '../src/api.js';
import { expectedWallet } from '../src/base/wallet/derive.js';
import {
  carryAnchorOver,
  checkOperation,
  dropLaneRecord,
  laneFor,
  laneRefusal,
  lanesOnServer,
  lanesRemembered,
  readAnchor,
  readLaneRecords,
  reconcileSignature,
  rememberLanes,
  saveAnchor,
  saveLaneRecord,
  signatureRefused,
  WALLET_SETTING_UP,
  walletAccountIndex,
  WithdrawalAnchorError,
  WithdrawalCheckError,
  WithdrawalWaitError,
  type RefusalContext,
  type WithdrawalView,
} from '../src/base/wallet/withdraw.js';

/*
 * Pay without waiting (lanes): the nonce key each owner operation gets from its own id
 * (shared/base/lanes.ts), the browser's check that an operation is in exactly that lane (never the
 * replayable key 8453, never the shared lane 0, a cancel at exactly its original's nonce), the one
 * operation that sets a wallet up at a time, the refusals' words, and the records History keeps.
 */

/** A fixed vector, computed with node:crypto here and asserted against laneKey both ways. */
const VECTOR_ID = 'w-1';
const VECTOR_DIGEST = '33dcddf5b7adc944b2369ef6ab8d4c7b4b76516b1eb0ea06d960a73be86a8221';
const VECTOR_LANE = 0x33dcddf5b7adc944b2369ef6ab8d4c7b4b76516b1eb0ea06n;
const UUID_ID = '00000000-0000-4000-8000-000000000001';
const UUID_LANE = 0xb63bf8e4db844d28b38d8c08aabaacdf5cab9f49cce38bccn;

test('laneKey: the high 192 bits of SHA-256("cc.op.v1:" + id), a fixed vector both ways', () => {
  assert.equal(LANE_DOMAIN, 'cc.op.v1:');
  const digest = createHash('sha256').update(`cc.op.v1:${VECTOR_ID}`, 'utf8').digest('hex');
  assert.equal(digest, VECTOR_DIGEST);
  assert.equal(BigInt(`0x${digest}`) >> 64n, VECTOR_LANE);
  assert.equal(laneKey(VECTOR_ID), VECTOR_LANE);
  assert.equal(laneKey(UUID_ID), UUID_LANE);
  assert.equal(
    laneKey(UUID_ID),
    BigInt(`0x${createHash('sha256').update(`cc.op.v1:${UUID_ID}`, 'utf8').digest('hex')}`) >> 64n,
  );
  // 192 bits at most, and every id its own lane.
  assert.ok(VECTOR_LANE < 1n << 192n);
  assert.notEqual(laneKey('w-2'), laneKey('w-1'));
  // A nonce in it: key << 64 | seq, read back.
  const nonce = laneNonce(VECTOR_ID, 3n);
  assert.equal(nonce, (VECTOR_LANE << 64n) | 3n);
  assert.equal(nonceKeyOf(nonce), VECTOR_LANE);
  assert.equal(nonceSeqOf(nonce), 3n);
  assert.equal(nonceKeyOf(7n), 0n);
});

test('laneKey never gives the replayable key 8453, the shared lane 0, or a key for no id', () => {
  assert.equal(REPLAYABLE_NONCE_KEY, 8453n);
  assert.equal(usableLaneKey(8453n), false);
  assert.equal(usableLaneKey(0n), false);
  assert.equal(usableLaneKey(1n << 192n), false);
  assert.equal(usableLaneKey(-1n), false);
  assert.equal(usableLaneKey(8452n), true);
  assert.equal(usableLaneKey(VECTOR_LANE), true);
  assert.throws(() => laneKey(''), LaneKeyError);
  assert.throws(() => laneKey(undefined as unknown as string), LaneKeyError);
});

/* ---------- the browser's check, with lanes ---------- */

const OWNER = getAddress(`0x${'7e'.repeat(20)}`);
const AGENT = '11111111-1111-4111-8111-111111111111';
const WALLET = expectedWallet(OWNER, AGENT);
const TO = getAddress(`0x${'3c'.repeat(20)}`);
const SPONSOR = getAddress(`0x${'99'.repeat(20)}`);
const SPONSORS = { [WITHDRAWAL_CHAIN_ID]: [SPONSOR] };
const sponsorData = (): Hex =>
  `0x${SPONSOR.slice(2)}${'00'.repeat(31)}${'00'.repeat(20)}${'00'.repeat(58)}${'ab'.repeat(65)}` as Hex;
const walletAbi = parseAbi(['function execute(address target, uint256 value, bytes data)']);
const execute = (call: OwnerCallEncoding) =>
  encodeFunctionData({
    abi: walletAbi,
    functionName: 'execute',
    args: [call.target, call.value, call.data],
  });

function operation(callData: Hex, nonce: bigint, initCode: Hex = '0x'): UserOperation<'0.6'> {
  return {
    sender: WALLET,
    nonce,
    initCode,
    callData,
    callGasLimit: 120_000n,
    verificationGasLimit: 300_000n,
    preVerificationGas: 60_000n,
    maxFeePerGas: 2_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
    paymasterAndData: sponsorData(),
    signature: '0x',
  };
}
const request = (op: UserOperation<'0.6'>) => ({
  userOperation: userOperationToRpc(op),
  userOpHash: ownerOperationHash(op),
  entryPoint: WITHDRAWAL_ENTRY_POINT,
  chainId: WITHDRAWAL_CHAIN_ID,
  wallet: WALLET,
  owner: OWNER,
  agentId: AGENT,
  sponsors: SPONSORS,
});
const asked = { kind: 'withdraw' as const, token: 'USDC' as const, amount: '12500000', to: TO };
const transfer = (nonce: bigint, initCode?: Hex) =>
  operation(execute(withdrawalCall('USDC', TO, 12_500_000n)), nonce, initCode);
const refused = (input: Parameters<typeof checkOperation>[0], message: RegExp) =>
  assert.throws(
    () => checkOperation(input),
    (error: unknown) => {
      assert.ok(error instanceof WithdrawalCheckError, String(error));
      assert.match((error as Error).message, message);
      return true;
    },
  );

test('lanes on: exactly laneNonce(its own id) passes; another lane, seq, 8453 or lane 0 is refused', () => {
  const lane = { withdrawalId: VECTOR_ID };
  const on = { expected: asked, lanes: true, lane };
  const own = transfer(laneNonce(VECTOR_ID));
  assert.equal(checkOperation({ ...request(own), ...on }), ownerOperationHash(own));
  // Wrong key: another operation's lane (a lane the server chose for another id).
  refused({ ...request(transfer(laneNonce('w-2'))), ...on }, /isn’t in its own lane/);
  refused({ ...request(transfer(laneNonce(UUID_ID))), ...on }, /isn’t in its own lane/);
  // Its own key, but not exactly the lane's first nonce.
  refused({ ...request(transfer(laneNonce(VECTOR_ID, 1n))), ...on }, /isn’t in its own lane/);
  // The replayable key, at any seq.
  refused({ ...request(transfer(REPLAYABLE_NONCE_KEY << 64n)), ...on }, /replayable nonce/);
  refused({ ...request(transfer((REPLAYABLE_NONCE_KEY << 64n) | 5n)), ...on }, /replayable nonce/);
  // The shared, sequential lane (key 0: today's nonces).
  refused({ ...request(transfer(7n)), ...on }, /isn’t in its own lane/);
  refused({ ...request(transfer(0n)), ...on }, /isn’t in its own lane/);
  // The id the lane is derived from is the operation's own: an empty one has none.
  refused(
    { ...request(own), expected: asked, lanes: true, lane: { withdrawalId: '' } },
    /without an id has no lane/,
  );
  // `lanes: true` with no lane to check against: nothing is signed.
  refused({ ...request(own), expected: asked, lanes: true }, /lane couldn’t be checked/);
});

test('lanes absent: the nonce is as before (lane 0, any key), only the replayable key never', () => {
  for (const nonce of [7n, 0n, laneNonce('w-2')]) {
    const op = transfer(nonce);
    assert.equal(checkOperation({ ...request(op), expected: asked }), ownerOperationHash(op));
    // A lane passed without the request's `lanes: true` changes nothing either.
    assert.equal(
      checkOperation({ ...request(op), expected: asked, lane: { withdrawalId: VECTOR_ID } }),
      ownerOperationHash(op),
    );
  }
  // 8453 is never an owner operation's (Coinbase Smart Wallet replays it on every chain).
  refused({ ...request(transfer(REPLAYABLE_NONCE_KEY << 64n)), expected: asked }, /replayable/);
});

test('lanes on: a cancel is the no-op at exactly its original’s nonce, in the original’s lane', () => {
  const lane = { withdrawalId: VECTOR_ID };
  const withdrawal = transfer(laneNonce(VECTOR_ID));
  const original = {
    userOperation: userOperationToRpc(withdrawal),
    userOpHash: ownerOperationHash(withdrawal),
  };
  const noop = (nonce: bigint) => operation(execute(noopCall(WALLET)), nonce);
  const cancelOf = (orig: typeof original) => ({
    expected: { kind: 'noop' as const, original: orig },
    lanes: true,
    lane,
  });
  const cancel = noop(laneNonce(VECTOR_ID));
  assert.equal(
    checkOperation({ ...request(cancel), ...cancelOf(original) }),
    ownerOperationHash(cancel),
  );
  // In another lane: it would cancel nothing.
  refused(
    { ...request(noop(laneNonce('w-2'))), ...cancelOf(original) },
    /lane of the operation it cancels/,
  );
  // The same key at another seq: not the original's full nonce.
  refused(
    { ...request(noop(laneNonce(VECTOR_ID, 1n))), ...cancelOf(original) },
    /lane of the operation it cancels/,
  );
  // At 8453 or in lane 0.
  refused({ ...request(noop(REPLAYABLE_NONCE_KEY << 64n)), ...cancelOf(original) }, /replayable/);
  refused({ ...request(noop(0n)), ...cancelOf(original) }, /lane of the/);
  // An original outside its own lane, its cancel at that same nonce: refused with lanes on.
  const shared = transfer(7n);
  const sharedOriginal = {
    userOperation: userOperationToRpc(shared),
    userOpHash: ownerOperationHash(shared),
  };
  refused(
    { ...request(noop(7n)), ...cancelOf(sharedOriginal) },
    /lane of the operation it cancels/,
  );
  // An original at another seq of its own lane: its cancel at that nonce is refused too.
  const later = transfer(laneNonce(VECTOR_ID, 2n));
  refused(
    {
      ...request(noop(laneNonce(VECTOR_ID, 2n))),
      ...cancelOf({
        userOperation: userOperationToRpc(later),
        userOpHash: ownerOperationHash(later),
      }),
    },
    /lane of the operation it cancels/,
  );
  // Without lanes (an operation from before them): at its nonce, as today; elsewhere, refused.
  assert.ok(
    checkOperation({ ...request(noop(7n)), expected: { kind: 'noop', original: sharedOriginal } }),
  );
  refused(
    { ...request(noop(8n)), expected: { kind: 'noop', original: sharedOriginal } },
    /withdrawal’s nonce/,
  );
});

const factoryAbi = parseAbi(['function createAccount(bytes[] owners, uint256 nonce)']);
const word = (address: string) => `0x${'00'.repeat(12)}${address.slice(2).toLowerCase()}` as Hex;
const { smartWalletFactory: FACTORY, spendPermissionManager: SPM } =
  BASE_NETWORKS[WITHDRAWAL_CHAIN_ID].contracts;
const SETUP = `${FACTORY}${encodeFunctionData({
  abi: factoryAbi,
  functionName: 'createAccount',
  args: [[word(OWNER), word(SPM!)], walletAccountIndex(AGENT)],
}).slice(2)}` as Hex;

test('lanes on: while one operation sets the wallet up, another that would too isn’t signed', () => {
  const first = transfer(laneNonce(VECTOR_ID), SETUP);
  // Alone (or only itself listed): it passes.
  assert.ok(
    checkOperation({
      ...request(first),
      expected: asked,
      lanes: true,
      lane: { withdrawalId: VECTOR_ID },
    }),
  );
  assert.ok(
    checkOperation({
      ...request(first),
      expected: asked,
      lanes: true,
      lane: { withdrawalId: VECTOR_ID, deploying: [VECTOR_ID] },
    }),
  );
  // Another one setting it up is on its way: wait, with the plain words.
  assert.throws(
    () =>
      checkOperation({
        ...request(first),
        expected: asked,
        lanes: true,
        lane: { withdrawalId: VECTOR_ID, deploying: ['w-2'] },
      }),
    (error: unknown) => {
      assert.ok(error instanceof WithdrawalWaitError);
      assert.equal((error as Error).message, 'Wait a moment: your wallet is being set up on Base.');
      assert.equal((error as Error).message, WALLET_SETTING_UP);
      return true;
    },
  );
  // One that doesn't set the wallet up never waits for that.
  assert.ok(
    checkOperation({
      ...request(transfer(laneNonce(VECTOR_ID))),
      expected: asked,
      lanes: true,
      lane: { withdrawalId: VECTOR_ID, deploying: ['w-2'] },
    }),
  );
  // Lanes absent: as today.
  assert.ok(checkOperation({ ...request(transfer(7n, SETUP)), expected: asked }));
});

/* ---------- what is on its way, from the server and this browser ---------- */

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
}
async function withStorage(run: () => void | Promise<void>, storage: unknown = memoryStorage()) {
  const globals = globalThis as { localStorage?: unknown };
  const before = globals.localStorage;
  globals.localStorage = storage;
  try {
    await run();
  } finally {
    globals.localStorage = before;
  }
}

const viewOf = (id: string, state: WithdrawalView['state'], userOperation?: Hex | null) =>
  ({
    withdrawalId: id,
    state,
    userOpHash: `0x${'11'.repeat(32)}`,
    ...(userOperation === undefined
      ? {}
      : { userOperation: userOperationToRpc(transfer(laneNonce(id), userOperation ?? '0x')) }),
  }) as unknown as WithdrawalView;

test('laneFor: nothing without lanes; the lane alone unless the operation sets the wallet up', async () => {
  await withStorage(async () => {
    const plain = userOperationToRpc(transfer(laneNonce('w-9')));
    const setup = userOperationToRpc(transfer(laneNonce('w-9'), SETUP));
    const never = async () => {
      throw new Error('not read');
    };
    assert.equal(
      await laneFor(
        AGENT,
        { withdrawalId: 'w-9', userOperation: plain },
        { deployed: true },
        never,
      ),
      undefined,
    );
    assert.deepEqual(
      await laneFor(
        AGENT,
        { lanes: true, withdrawalId: 'w-9', userOperation: plain },
        { deployed: false },
        never,
      ),
      { withdrawalId: 'w-9' },
    );
    // Sets the wallet up: the open list says which others do (signed ones only).
    const list = async () => [
      viewOf('w-1', 'submitted', SETUP),
      viewOf('w-2', 'included', '0x'),
      viewOf('w-3', 'awaiting_signature', SETUP),
      viewOf('w-4', 'submitted'),
      viewOf('w-9', 'awaiting_signature', SETUP),
    ];
    const ask = { lanes: true, withdrawalId: 'w-9', userOperation: setup };
    assert.deepEqual((await laneFor(AGENT, ask, { deployed: true }, list))?.deploying, ['w-1']);
    // One signed elsewhere whose operation isn't known counts while Base has no wallet yet.
    assert.deepEqual((await laneFor(AGENT, ask, { deployed: false }, list))?.deploying, [
      'w-1',
      'w-4',
    ]);
    // The list not read: this browser's own records still count.
    saveLaneRecord(AGENT, {
      withdrawalId: 'w-5',
      userOperation: userOperationToRpc(transfer(laneNonce('w-5'), SETUP)),
      userOpHash: `0x${'55'.repeat(32)}`,
      signedAt: Date.now(),
      laned: true,
    });
    assert.deepEqual((await laneFor(AGENT, ask, { deployed: true }, never))?.deploying, ['w-5']);
  });
});

test('refusals from the lanes, in plain words, with the numbers the server attached', () => {
  const refusal = (code: string, details?: unknown, context?: RefusalContext, settingUp = false) =>
    laneRefusal(new ApiError('Refused.', 409, code, details), context, settingUp);
  const withdraw = { noun: 'withdrawal', token: 'ETH' } as const;
  const cap = '100 payments are still on their way. Wait for one to finish.';
  // The cap.
  assert.equal(refusal('too_many_open', { max: 100, open: 100 }), cap);
  assert.equal(refusal('too_many_open'), cap);
  assert.equal(
    refusal('too_many_open', { max: 250 }),
    '250 payments are still on their way. Wait for one to finish.',
  );
  assert.equal(refusal('too_many_open', { max: '9; drop' }), cap);
  assert.equal(
    refusal('too_many_open', { max: 100 }, withdraw),
    '100 payments and withdrawals are still on their way. Wait for one to finish.',
  );
  // Funds held by what is on its way.
  assert.equal(
    refusal('funds_held', { open: 3, available: { raw: '1', decimals: 6, display: '0.000001' } }),
    'Not enough USDC while 3 payments are still on their way.',
  );
  assert.equal(
    refusal('funds_held', { open: 1 }),
    'Not enough USDC while 1 payment is still on its way.',
  );
  assert.equal(
    refusal('funds_held'),
    'Not enough USDC while some payments are still on their way.',
  );
  assert.equal(
    refusal('funds_held', { open: -2 }),
    'Not enough USDC while some payments are still on their way.',
  );
  assert.equal(
    refusal('funds_held', { open: 2 }, withdraw),
    'Not enough ETH while 2 payments and withdrawals are still on their way.',
  );
  // Funds moved before signing.
  assert.equal(
    refusal('funds_moved', {
      token: 'USDC',
      available: { raw: '2000000', decimals: 6, display: '2' },
      needed: { raw: '12500000', decimals: 6, display: '12.5' },
    }),
    'The wallet no longer holds enough USDC for this payment (12.5 USDC needed, 2 available). Nothing was sent.',
  );
  assert.equal(
    refusal('funds_moved', { needed: { display: '<b>' } }, withdraw),
    'The wallet no longer holds enough ETH for this withdrawal. Nothing was sent.',
  );
  // The sponsor pauses after reverts, or is busy.
  const retryAt = new Date(2026, 9, 11, 14, 5).getTime();
  assert.equal(
    refusal('sponsor_paused', { reverted: 3, retryAt }),
    'Several payments from this wallet didn’t go through on Base, so new ones pause until 14:05.',
  );
  assert.equal(
    refusal('sponsor_paused', {}, withdraw),
    'Several payments or withdrawals from this wallet didn’t go through on Base, so new ones pause for a while.',
  );
  assert.equal(
    refusal('sponsor_busy', { retryAfterSeconds: 60 }),
    'Busy right now. Try again in a minute.',
  );
  assert.equal(
    refusal('sponsor_busy', {}),
    'This payment’s network fee is more than Central City can cover right now. Nothing was sent.',
  );
  assert.equal(
    refusal('lane_collision'),
    'That payment couldn’t be prepared. Nothing was sent. Try again.',
  );
  assert.match(refusal('cancel_over_headroom')!, /can’t be cancelled right now/);
  // One operation sets the wallet up at a time: worded only with lanes on and no wallet on Base.
  assert.equal(refusal('operation_pending'), null);
  assert.equal(refusal('operation_pending', {}, undefined, true), WALLET_SETTING_UP);
  // Anything else: the screen words it as before.
  assert.equal(refusal('expired'), null);
  assert.equal(laneRefusal(new Error('too_many_open')), null);
});

test('lanesOnServer: the open list answers only while lanes are on', async () => {
  assert.equal(await lanesOnServer(AGENT, async () => []), true);
  assert.equal(
    await lanesOnServer(AGENT, async () => {
      throw new ApiError('Not found.', 404);
    }),
    false,
  );
  assert.equal(
    await lanesOnServer(AGENT, async () => {
      throw new ApiError('Busy.', 503);
    }),
    null,
  );
  assert.equal(
    await lanesOnServer(AGENT, async () => {
      throw new TypeError('Failed to fetch');
    }),
    null,
  );
});

test('History records: kept and read back, or nothing is sent; an anchor from before joins them', async () => {
  await withStorage(async () => {
    const record = {
      withdrawalId: 'w-1',
      userOperation: userOperationToRpc(transfer(laneNonce('w-1'))),
      userOpHash: `0x${'11'.repeat(32)}` as Hex,
      payment: { name: 'Harbor', short: 'Ab3dE9', baseId: '12345', note: null },
      signedAt: Date.now(),
      laned: true,
    };
    saveLaneRecord(AGENT, record);
    saveLaneRecord(AGENT, { ...record, withdrawalId: 'w-2', payment: undefined });
    assert.deepEqual(
      readLaneRecords(AGENT).map((entry) => entry.withdrawalId),
      ['w-2', 'w-1'],
    );
    assert.deepEqual(readLaneRecords(AGENT)[1]!.payment, record.payment);
    // A record never blocks: the single anchor stays empty.
    assert.equal(readAnchor(AGENT), null);
    dropLaneRecord(AGENT, 'w-1');
    assert.deepEqual(
      readLaneRecords(AGENT).map((entry) => entry.withdrawalId),
      ['w-2'],
    );
    // An anchor from one-at-a-time becomes a record (cancelled at its nonce, without a lane).
    saveAnchor(AGENT, {
      withdrawalId: 'w-0',
      userOperation: userOperationToRpc(transfer(7n)),
      userOpHash: `0x${'00'.repeat(32)}` as Hex,
    });
    assert.equal(carryAnchorOver(AGENT), true);
    assert.equal(readAnchor(AGENT), null);
    const carried = readLaneRecords(AGENT).find((entry) => entry.withdrawalId === 'w-0');
    assert.equal(carried?.laned, false);
    // Remembered per wallet, for the screen to open on History.
    assert.equal(lanesRemembered(AGENT), false);
    rememberLanes(AGENT, true);
    assert.equal(lanesRemembered(AGENT), true);
    rememberLanes(AGENT, false);
    assert.equal(lanesRemembered(AGENT), false);
  });
  // Storage that can't keep it: refused, so the signature is never sent.
  await withStorage(
    () => {
      assert.throws(
        () =>
          saveLaneRecord(AGENT, {
            withdrawalId: 'w-1',
            userOperation: userOperationToRpc(transfer(laneNonce('w-1'))),
            userOpHash: `0x${'11'.repeat(32)}`,
            signedAt: Date.now(),
            laned: true,
          }),
        WithdrawalAnchorError,
      );
    },
    {
      getItem: () => null,
      setItem: () => {
        throw new Error('Quota exceeded');
      },
      removeItem: () => {},
    },
  );
});

/* ---------- a signature's answer: refused before it was taken, or unclear ---------- */

test('signatureRefused: only the refusals the server makes before it takes a signature', () => {
  const refusedBefore = [
    ['invalid_body', 400],
    ['invalid_signature', 400],
    ['not_found', 404],
    ['expired', 410],
    ['signature_mismatch', 422],
    ['operation_mismatch', 409],
    ['funds_moved', 409],
    ['sponsor_paused', 409],
    ['sponsor_busy', 409],
    ['sponsorship_expired', 409],
  ] as const;
  for (const [code, status] of refusedBefore)
    assert.equal(signatureRefused(new ApiError('Refused.', status, code)), true, code);
  // Unclear: it may have been taken. A 5xx (chain_unavailable can follow the stored signature),
  // a refusal code under a 5xx, an unknown or missing code, a 429, a lost answer.
  for (const error of [
    new ApiError('Bad gateway.', 502),
    new ApiError('Server error.', 500, 'internal'),
    new ApiError('Base cannot be read right now.', 503, 'chain_unavailable'),
    new ApiError('Odd.', 503, 'funds_moved'),
    new ApiError('Gateway timeout.', 504),
    new ApiError('Something new.', 409, 'something_new'),
    new ApiError('Refused.', 409),
    new ApiError('Too many requests.', 429, 'rate_limited'),
    new TypeError('Failed to fetch'),
    new Error('The operation was aborted.'),
    undefined,
  ])
    assert.equal(signatureRefused(error), false, String(error));
});

test('reconcileSignature: the same operation read once, never a new one', async () => {
  const op = { withdrawalId: 'w-1', userOpHash: `0x${'11'.repeat(32)}` };
  const reads: string[] = [];
  const answer =
    (state: WithdrawalView['state'] | Error, extra: Partial<WithdrawalView> = {}) =>
    async (_agent: string, id: string) => {
      reads.push(id);
      if (state instanceof Error) throw state;
      return { withdrawalId: id, state, userOpHash: op.userOpHash, ...extra } as WithdrawalView;
    };
  for (const state of ['submitted', 'included', 'final', 'cancel_pending'] as const) {
    const now = await reconcileSignature(AGENT, op, answer(state));
    assert.equal(now.k, 'sent', state);
    assert.equal(now.k === 'sent' && now.view.state, state);
  }
  assert.deepEqual(await reconcileSignature(AGENT, op, answer('awaiting_signature')), {
    k: 'unsigned',
  });
  assert.deepEqual(await reconcileSignature(AGENT, op, answer('expired')), { k: 'never' });
  // Not read, or another operation than the one signed here: unknown, never taken as sent.
  assert.deepEqual(await reconcileSignature(AGENT, op, answer(new Error('502'))), {
    k: 'unknown',
  });
  assert.deepEqual(
    await reconcileSignature(
      AGENT,
      op,
      answer('submitted', { userOpHash: `0x${'22'.repeat(32)}` as Hex }),
    ),
    { k: 'unknown' },
  );
  assert.deepEqual(
    await reconcileSignature(AGENT, op, async () => ({ withdrawalId: 'w-2' }) as WithdrawalView),
    { k: 'unknown' },
  );
  // Only ever the one operation, by its own id.
  assert.ok(reads.every((id) => id === 'w-1'));
});
