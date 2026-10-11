import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeFunctionData, getAddress, parseAbi, type Hex } from 'viem';
import type { UserOperation } from 'viem/account-abstraction';
import { BASE_MAINNET, BASE_NETWORKS } from '../shared/base/chains.js';
import { laneNonce, REPLAYABLE_NONCE_KEY } from '../shared/base/lanes.js';
import {
  parseRecipient,
  PAY_NOTE_MAX,
  PAY_RECIPIENT_TTL_MS,
  type PayIncoming,
  type PayRecipientAgent,
} from '../shared/base/pay.js';
import {
  ownerOperationHash,
  userOperationToRpc,
  withdrawalCall,
  WITHDRAWAL_CHAIN_ID,
  WITHDRAWAL_ENTRY_POINT,
} from '../shared/base/withdraw.js';
import {
  amountProblem,
  checkPayment,
  checkRecipient,
  createIncomingFeed,
  INCOMING_PAGES_PER_REFRESH,
  payTo,
  PAY_BASE_RPC,
  confirmOnBase,
  noteProblem,
  NOT_A_RECIPIENT,
  ONLY_AGENTS,
  ownerOnBase,
  receivedStatus,
  RECEIVED_FINAL,
  RECEIVED_HEADLINE,
  RECEIVED_NOTE,
  recipientProblem,
  RecipientError,
  type PaySigningRequest,
  type ReceivedStatus,
} from '../src/base/wallet/pay.js';
import { expectedWallet } from '../src/base/wallet/derive.js';
import { WithdrawalCheckError } from '../src/base/wallet/withdraw.js';
import { BASE_RPC } from '../src/verify/onBaseVerify.js';

/*
 * The browser's checks before an owner pays another Central City agent (src/base/wallet/pay.ts):
 * the recipient the server answered must be the one typed, on this wallet's network and registry;
 * Base, read by this browser, must give that Base ID to that wallet; and the operation must be one
 * USDC transfer of exactly the amount to exactly that wallet. Anything else signs nothing.
 */

const NOW = 1_760_000_000_000;
const REGISTRY = BASE_NETWORKS[WITHDRAWAL_CHAIN_ID].contracts.identityRegistry!;
const OWNER = getAddress(`0x${'7e'.repeat(20)}`);
const AGENT = '11111111-1111-4111-8111-111111111111';
// The paying wallet as production makes it: the owner key's wallet for this agent.
const WALLET = expectedWallet(OWNER, AGENT);
const RECIPIENT_WALLET = getAddress(`0x${'3c'.repeat(20)}`);
const ELSEWHERE = getAddress(`0x${'4d'.repeat(20)}`);
const SPONSOR = getAddress(`0x${'99'.repeat(20)}`);
const SPONSORS = { [WITHDRAWAL_CHAIN_ID]: [SPONSOR] };
const sponsorData = (): Hex =>
  `0x${SPONSOR.slice(2)}${'00'.repeat(31)}${'00'.repeat(20)}${'00'.repeat(58)}${'ab'.repeat(65)}`;

function agent(overrides: Partial<PayRecipientAgent> = {}): PayRecipientAgent {
  const at = overrides.verified?.at ?? NOW - 1_000;
  return {
    kind: 'central_city_agent',
    baseId: '12345',
    short: 'Ab3dE9',
    name: 'Harbor',
    wallet: RECIPIENT_WALLET,
    registry: REGISTRY,
    chainId: WITHDRAWAL_CHAIN_ID,
    verification: 'point_in_time',
    lookupId: 'lk_7f3a9c21e4b04d8a',
    verified: { block: 52_441_231, blockHash: `0x${'aa'.repeat(32)}`, at },
    expiresAt: at + PAY_RECIPIENT_TTL_MS,
    ...overrides,
  };
}

const refused = (run: () => unknown, message: RegExp | string, kind: Function = RecipientError) =>
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof kind, `expected ${kind.name}, got ${String(error)}`);
    if (typeof message === 'string') assert.equal((error as Error).message, message);
    else assert.match((error as Error).message, message);
    return true;
  });

test('what may be typed: a Base ID, the passport link or number, an address; nothing else', () => {
  for (const text of [
    '12345',
    'https://centralcity.ai/a/Ab3dE9',
    'centralcity.ai/a/Ab3dE9',
    'CC-Ab3dE9',
    RECIPIENT_WALLET.toLowerCase(),
  ])
    assert.equal(recipientProblem(text), null, text);
  for (const text of [
    'Meridian',
    'cc-Ab3dE9', // the passport number is printed "CC-" in capitals, and only that is taken
    'https://evil.example/a/Ab3dE9',
    'http://centralcity.ai/a/Ab3dE9',
    'centralcity.ai/a/Ab3dE9?x=1',
    '0012345', // a Base ID with a leading zero (and too long for a passport number)
    `0x${'3C'.repeat(19)}3c`, // mixed case without a valid checksum
  ])
    assert.equal(recipientProblem(text), NOT_A_RECIPIENT, text);
});

test('the server’s recipient is accepted only as the agent typed, on this network and registry', () => {
  const byId = parseRecipient('12345');
  const byLink = parseRecipient('https://centralcity.ai/a/Ab3dE9');
  const byWallet = parseRecipient(RECIPIENT_WALLET);
  assert.equal(checkRecipient(agent(), byId, NOW).wallet, RECIPIENT_WALLET);
  assert.equal(checkRecipient(agent(), byLink, NOW).baseId, '12345');
  assert.equal(checkRecipient(agent(), byWallet, NOW).short, 'Ab3dE9');
  // A lower-case wallet in the answer comes back checksummed.
  assert.equal(
    checkRecipient(agent({ wallet: RECIPIENT_WALLET.toLowerCase() }), byId, NOW).wallet,
    RECIPIENT_WALLET,
  );

  // Any other address: Pay is for Central City agents only.
  refused(
    () =>
      checkRecipient(
        {
          kind: 'address',
          address: ELSEWHERE,
          verification: 'none',
          warning: 'not_central_city_agent',
        },
        parseRecipient(ELSEWHERE),
        NOW,
      ),
    ONLY_AGENTS,
  );
  // Another agent than the one typed (the Base ID, the passport or the wallet differs).
  refused(() => checkRecipient(agent({ baseId: '12346' }), byId, NOW), /isn’t the agent/);
  refused(() => checkRecipient(agent({ short: 'Zz9zZ9' }), byLink, NOW), /isn’t the agent/);
  refused(() => checkRecipient(agent({ wallet: ELSEWHERE }), byWallet, NOW), /isn’t the agent/);
  // Another network or another registry than this wallet's. The other Base network: the server
  // was deployed after this page loaded, so reload.
  refused(
    () =>
      checkRecipient(
        agent({ chainId: WITHDRAWAL_CHAIN_ID === BASE_MAINNET ? 84532 : BASE_MAINNET }),
        byId,
        NOW,
      ),
    /^This page is out of date\. Reload it and try again\.$/,
  );
  refused(() => checkRecipient(agent({ chainId: 1 }), byId, NOW), /this wallet’s network/);
  refused(() => checkRecipient(agent({ registry: ELSEWHERE }), byId, NOW), /this wallet’s network/);
  // Malformed: a wallet that isn't one, no evidence, an expiry that isn't the evidence's.
  refused(() => checkRecipient(agent({ wallet: '0x1234' }), byId, NOW), /couldn’t be read/);
  refused(
    () =>
      checkRecipient(
        agent({ verified: { block: 0, blockHash: `0x${'aa'.repeat(32)}`, at: NOW } }),
        byId,
        NOW,
      ),
    /couldn’t be read/,
  );
  refused(
    () => checkRecipient({ ...agent(), expiresAt: NOW + 3_600_000 }, byId, NOW),
    /couldn’t be read/,
  );
  // An answer that doesn't say what its check on Base is (point in time) isn't taken.
  refused(
    () =>
      checkRecipient(
        { ...agent(), verification: 'none' } as unknown as PayRecipientAgent,
        byId,
        NOW,
      ),
    /couldn’t be read/,
  );
  // A check on Base past its expiry is looked up again.
  refused(() => checkRecipient(agent(), byId, NOW + PAY_RECIPIENT_TTL_MS), /too old/);
});

test('a note is one line of at most PAY_NOTE_MAX characters, as the server takes it', () => {
  assert.equal(noteProblem('Thanks for the research'), null);
  assert.equal(noteProblem('é'.repeat(PAY_NOTE_MAX)), null);
  assert.match(noteProblem('x'.repeat(PAY_NOTE_MAX + 1))!, /at most/);
  assert.match(noteProblem('two\nlines')!, /one line/);
  assert.match(noteProblem(`pay${String.fromCodePoint(0x202e)}evil`)!, /one line/);
  for (const hidden of ['\u2028', '\u2029', '\u061c', '\u200b', '\u200d', '\u2060', '\ufeff'])
    assert.match(noteProblem(`a${hidden}b`)!, /one line/, JSON.stringify(hidden));
  assert.equal(noteProblem('Zahlung für Café · 12 €'), null);
});

/* ---------- the prepared payment ---------- */

const walletAbi = parseAbi(['function execute(address target, uint256 value, bytes data)']);
function payment(
  to: string,
  amount: bigint,
  paidTo: Partial<PayRecipientAgent> = {},
  sender: `0x${string}` = WALLET,
  nonce = 3n,
) {
  const call = withdrawalCall('USDC', getAddress(to), amount);
  const op: UserOperation<'0.6'> = {
    sender,
    nonce,
    initCode: '0x',
    callData: encodeFunctionData({
      abi: walletAbi,
      functionName: 'execute',
      args: [call.target, call.value, call.data],
    }),
    callGasLimit: 120_000n,
    verificationGasLimit: 300_000n,
    preVerificationGas: 60_000n,
    maxFeePerGas: 2_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
    paymasterAndData: sponsorData(),
    signature: '0x',
  };
  const request = {
    withdrawalId: '00000000-0000-4000-8000-000000000001',
    state: 'awaiting_signature',
    userOperation: userOperationToRpc(op),
    userOpHash: ownerOperationHash(op),
    entryPoint: WITHDRAWAL_ENTRY_POINT,
    chainId: WITHDRAWAL_CHAIN_ID,
    expiresAt: NOW + 600_000,
    summary: {} as PaySigningRequest['summary'],
    payment: { paymentId: 'p1', recipient: agent(paidTo), note: null },
  } as PaySigningRequest;
  return { op, request };
}
const check = (request: PaySigningRequest, amount = '25000000') =>
  checkPayment({
    request,
    recipient: agent(),
    amount,
    wallet: WALLET,
    owner: OWNER,
    agentId: AGENT,
    sponsors: SPONSORS,
  });

test('the payment shown passes: one USDC transfer of exactly the amount to exactly that wallet', () => {
  const { op, request } = payment(RECIPIENT_WALLET, 25_000_000n);
  assert.equal(check(request), ownerOperationHash(op));
});

test('a payment to anyone else, or of another amount, is refused before signing', () => {
  // The operation sends elsewhere, or another amount, than the recipient shown.
  refused(
    () => check(payment(ELSEWHERE, 25_000_000n).request),
    /different address/,
    WithdrawalCheckError,
  );
  refused(
    () => check(payment(RECIPIENT_WALLET, 25_000_001n).request),
    /different amount/,
    WithdrawalCheckError,
  );
  // The server's payment record names another agent or another wallet than the one shown.
  refused(
    () => check(payment(RECIPIENT_WALLET, 25_000_000n, { baseId: '777' }).request),
    /isn’t to the agent shown/,
    WithdrawalCheckError,
  );
  refused(
    () => check(payment(RECIPIENT_WALLET, 25_000_000n, { wallet: ELSEWHERE }).request),
    /isn’t to the agent shown/,
    WithdrawalCheckError,
  );
  // No sponsor this browser allows: the wallet could be charged.
  const { request } = payment(RECIPIENT_WALLET, 25_000_000n);
  refused(
    () =>
      checkPayment({
        request,
        recipient: agent(),
        amount: '25000000',
        wallet: WALLET,
        owner: OWNER,
        agentId: AGENT,
      }),
    /sponsor/,
    WithdrawalCheckError,
  );
});

test('a paying wallet the owner key doesn’t make for this agent signs nothing', () => {
  // A perfect payment of its own, from a wallet the server substituted, or another agent's.
  for (const [wallet, agentId] of [
    [ELSEWHERE, AGENT],
    [expectedWallet(OWNER, '22222222-2222-4222-8222-222222222222'), AGENT],
  ] as const) {
    refused(
      () =>
        checkPayment({
          request: payment(RECIPIENT_WALLET, 25_000_000n, {}, wallet).request,
          recipient: agent(),
          amount: '25000000',
          wallet,
          owner: OWNER,
          agentId,
          sponsors: SPONSORS,
        }),
      /isn’t the wallet your wallet key makes/,
      WithdrawalCheckError,
    );
  }
});

test('lanes on: a payment only at exactly laneNonce(its own id), the lane never the server’s word', () => {
  const ID = '00000000-0000-4000-8000-000000000001';
  const laned = (nonce: bigint) => {
    const { op, request } = payment(RECIPIENT_WALLET, 25_000_000n, {}, WALLET, nonce);
    return { op, request: { ...request, lanes: true } as PaySigningRequest };
  };
  const own = laned(laneNonce(ID));
  assert.equal(check(own.request), ownerOperationHash(own.op));
  // Another id's lane (the server chose another), another seq, the shared lane, the replayable key.
  for (const nonce of [
    laneNonce('w-other'),
    laneNonce(ID, 1n),
    3n,
    0n,
    REPLAYABLE_NONCE_KEY << 64n,
  ])
    refused(() => check(laned(nonce).request), /own lane|replayable/, WithdrawalCheckError);
  // Without `lanes: true`, the sequential nonce passes as before.
  assert.ok(check(payment(RECIPIENT_WALLET, 25_000_000n).request));
});

/* ---------- this browser's read of Base ---------- */

const MAINNET_REGISTRY = BASE_NETWORKS[BASE_MAINNET].contracts.identityRegistry!;
const onMainnet = agent({ chainId: BASE_MAINNET, registry: MAINNET_REGISTRY });
type Call = { method: string; params: unknown[] };
function base(answer: (call: Call) => unknown, calls: Call[] = []) {
  return (async (_url: string, init: RequestInit) => {
    const call = JSON.parse(String(init.body)) as Call;
    calls.push(call);
    const body = answer(call);
    if (body instanceof Error) throw body;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}
const owner = (address: string) => `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
const answers =
  (result: unknown) =>
  ({ method }: Call) =>
    method === 'eth_blockNumber' ? { jsonrpc: '2.0', id: 1, result: '0x3203a4f' } : result;

test('Base, read here: ownerOf(Base ID) in the registry at one block must be the wallet shown', async () => {
  const calls: Call[] = [];
  const block = await confirmOnBase(onMainnet, {
    fetch: base(answers({ jsonrpc: '2.0', id: 1, result: owner(RECIPIENT_WALLET) }), calls),
  });
  assert.equal(block, 0x3203a4f);
  assert.deepEqual(calls[1], {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [
      { to: MAINNET_REGISTRY, data: `0x6352211e${(12345).toString(16).padStart(64, '0')}` },
      '0x3203a4f',
    ],
  } as unknown as Call);

  // Another owner on Base, or none (the call reverts): the wallet changed, nothing is signed.
  await assert.rejects(
    confirmOnBase(onMainnet, {
      fetch: base(answers({ jsonrpc: '2.0', id: 1, result: owner(ELSEWHERE) })),
    }),
    /changed since it was checked/,
  );
  await assert.rejects(
    confirmOnBase(onMainnet, {
      fetch: base(
        answers({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } }),
      ),
    }),
    /changed since it was checked/,
  );
});

test('when Base can’t be read here, or isn’t Base mainnet, nothing is signed', async () => {
  const unreachable = /Couldn’t check on Base/;
  await assert.rejects(
    ownerOnBase(onMainnet, { fetch: base(() => new TypeError('Failed to fetch')) }),
    unreachable,
  );
  await assert.rejects(
    ownerOnBase(onMainnet, {
      fetch: base(answers({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'busy' } })),
    }),
    unreachable,
  );
  await assert.rejects(
    ownerOnBase(onMainnet, { fetch: base(answers({ jsonrpc: '2.0', id: 1, result: '0x1234' })) }),
    unreachable,
  );
  // An answer wider than an address is not one.
  await assert.rejects(
    ownerOnBase(onMainnet, {
      fetch: base(answers({ jsonrpc: '2.0', id: 1, result: `0x${'11'.repeat(32)}` })),
    }),
    unreachable,
  );
  // Only Base mainnet can be read from this site; the test network signs nothing.
  await assert.rejects(
    ownerOnBase(agent({ chainId: 84532 }), {
      fetch: base(() => assert.fail('nothing is read off Base mainnet')),
    }),
    /only check recipients on Base itself/,
  );
});

test('the payment names the lookup the owner saw, by its id only', () => {
  assert.deepEqual(payTo(agent()), { lookupId: 'lk_7f3a9c21e4b04d8a' });
  // An answer without its lookup id can't be paid.
  refused(
    () =>
      checkRecipient(
        { ...agent(), lookupId: '' } as PayRecipientAgent,
        parseRecipient('12345'),
        NOW,
      ),
    /couldn’t be read/,
  );
});

test('a payment is at least 0.01 USDC', () => {
  assert.equal(amountProblem(10_000n), null);
  assert.equal(amountProblem(25_000_000n), null);
  assert.equal(amountProblem(9_999n), 'The smallest payment is 0.01 USDC.');
  assert.equal(amountProblem(1n), 'The smallest payment is 0.01 USDC.');
});

test('incoming: the feed keeps its cursor; past one refresh nothing is dropped, newest included', async () => {
  // 550 payments over 11 pages of 50; p1's last change (final) arrives on the very last page.
  const payment = (n: number, state = 'pending') =>
    ({ paymentId: `p${n}`, state, updatedAt: n }) as unknown as PayIncoming;
  const pages: Array<{ payments: PayIncoming[]; cursor: string; hasMore: boolean }> = [];
  for (let page = 0; page < 11; page += 1) {
    const payments = Array.from({ length: 50 }, (_, k) => payment(page * 50 + k + 1));
    if (page === 10) payments.push(payment(1, 'final'));
    pages.push({ payments, cursor: `c${page + 1}`, hasMore: page < 10 });
  }
  const asked: Array<string | null> = [];
  const read = async (cursor: string | null) => {
    asked.push(cursor);
    const at = cursor === null ? 0 : Number(cursor.slice(1));
    return pages[at] ?? { payments: [], cursor, hasMore: false };
  };
  const feed = createIncomingFeed(read as never);
  const first = await feed.refresh();
  assert.equal(asked.length, INCOMING_PAGES_PER_REFRESH);
  assert.equal(first.more, true);
  assert.ok(!first.payments.some((each) => each.paymentId === 'p550'));
  // Each later refresh continues where the last stopped, never from the beginning.
  const second = await feed.refresh();
  assert.equal(asked[INCOMING_PAGES_PER_REFRESH], `c${INCOMING_PAGES_PER_REFRESH}`);
  assert.equal(second.more, true);
  const third = await feed.refresh();
  assert.equal(third.more, false);
  assert.equal(asked.length, 11);
  assert.ok(!asked.slice(1).includes(null), 'never back to the first page');
  const byId = new Map(third.payments.map((each) => [each.paymentId, each]));
  assert.equal(byId.size, 550);
  assert.ok(byId.has('p550'), 'the newest payment is read');
  assert.equal(byId.get('p1')!.state, 'final', 'a state change past the first refresh wins');
  // Nothing new: one read from the last cursor. A new page later: read from there, once.
  const idle = await feed.refresh();
  assert.equal(asked.at(-1), 'c11');
  assert.equal(idle.more, false);
  pages.push({ payments: [payment(551)], cursor: 'c12', hasMore: false });
  const after = await feed.refresh();
  assert.equal(asked.at(-1), 'c11');
  assert.ok(after.payments.some((each) => each.paymentId === 'p551'));
});

test('incoming: a server that repeats its cursor with hasMore never loops', async () => {
  let reads = 0;
  const feed = createIncomingFeed((async () => {
    reads += 1;
    return { payments: [], cursor: 'same', hasMore: true };
  }) as never);
  // The first answer moves the cursor; the next one repeats it: nothing more for now.
  assert.equal((await feed.refresh()).more, false);
  assert.equal(reads, 2);
  // A later refresh asks once from that cursor; still no busy loop.
  assert.equal((await feed.refresh()).more, false);
  assert.equal(reads, 3);
});

test('Pay reads the same Base endpoint as Verify, without loading Verify', () => {
  assert.equal(PAY_BASE_RPC, BASE_RPC);
});

test('received: every state × safe true / false / absent; "Received" only at safe, final only at final', () => {
  const asBefore = (onItsWay: boolean, phase: ReceivedStatus['phase'] = 'on_its_way') => ({
    phase,
    headline: null,
    note: null,
    onItsWay,
    amount: 'off',
  });
  const final = {
    phase: 'final',
    headline: RECEIVED_FINAL,
    note: null,
    onItsWay: false,
    amount: 'in',
  };
  const expected: Record<PayIncoming['state'], Record<'true' | 'false' | 'absent', unknown>> = {
    pending: { true: asBefore(true), false: asBefore(true), absent: asBefore(true) },
    included: {
      true: {
        phase: 'received',
        headline: RECEIVED_HEADLINE,
        note: RECEIVED_NOTE,
        onItsWay: false,
        amount: 'plain',
      },
      false: asBefore(true),
      absent: asBefore(true),
    },
    final: { true: final, false: final, absent: final },
    failed: {
      true: asBefore(false, 'failed'),
      false: asBefore(false, 'failed'),
      absent: asBefore(false, 'failed'),
    },
  };
  for (const [state, bySafe] of Object.entries(expected) as Array<
    [PayIncoming['state'], Record<string, unknown>]
  >)
    for (const [safe, want] of Object.entries(bySafe)) {
      const row = safe === 'absent' ? { state } : { state, safe: safe === 'true' };
      assert.deepEqual(receivedStatus(row), want, `${state}, safe ${safe}`);
    }
  assert.equal(RECEIVED_HEADLINE, 'Received · awaiting finality');
  assert.equal(RECEIVED_NOTE, 'Final in about 15 minutes.');
  assert.equal(RECEIVED_FINAL, 'Received ✓');
  // Nothing claims final before final: no ✓ and no "Final" headline in any other state.
  for (const state of ['pending', 'included', 'failed'] as const)
    for (const safe of [true, false, undefined]) {
      const status = receivedStatus({ state, safe });
      assert.ok(!status.headline?.includes('✓'), `${state}, safe ${safe}`);
      assert.ok(!/^final/i.test(status.headline ?? ''), `${state}, safe ${safe}`);
      assert.notEqual(status.amount, 'in', `${state}, safe ${safe}`);
    }
});

test('received: only exactly true counts; a later answer always wins, never a failure', () => {
  for (const safe of ['true', 1, 'yes', {}, null])
    assert.equal(receivedStatus({ state: 'included', safe }).phase, 'on_its_way', String(safe));
  // A state this browser doesn't know: as before (never paid, never received, never failed).
  assert.deepEqual(receivedStatus({ state: 'reorged' as never, safe: true }), {
    phase: 'on_its_way',
    headline: null,
    note: null,
    onItsWay: false,
    amount: 'off',
  });
  // Safe, then the next read says not safe (or back to pending): shown as the server says now.
  assert.equal(receivedStatus({ state: 'included', safe: true }).phase, 'received');
  assert.equal(receivedStatus({ state: 'included', safe: false }).headline, null);
  assert.equal(receivedStatus({ state: 'pending', safe: true }).headline, null);
});

test('incoming: a row that is no longer safe reads as its latest answer, never a stale "Received"', async () => {
  const row = (safe: boolean | undefined, n: number) =>
    ({ paymentId: 'p1', state: 'included', safe, updatedAt: n }) as unknown as PayIncoming;
  const pages = [
    { payments: [row(true, 1)], cursor: 'c1', hasMore: false },
    { payments: [row(false, 2)], cursor: 'c2', hasMore: false },
  ];
  let at = 0;
  const feed = createIncomingFeed(
    (async () => pages[at++] ?? { payments: [], cursor: 'c2', hasMore: false }) as never,
  );
  const first = await feed.refresh();
  assert.equal(receivedStatus(first.payments[0]!).headline, RECEIVED_HEADLINE);
  const second = await feed.refresh();
  assert.equal(second.payments.length, 1);
  assert.equal(receivedStatus(second.payments[0]!).headline, null);
  assert.equal(receivedStatus(second.payments[0]!).onItsWay, true);
});
