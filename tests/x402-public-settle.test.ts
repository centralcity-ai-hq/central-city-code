import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, keccak256, parseAbi, parseTransaction, type Hex } from 'viem';
import { setup } from './helpers/x402-fake-base.js';
import type { FeedPayOp } from '../server/base/chain/feed-pay-chain';
import { FacilitatorError } from '../server/protocol/x402/facilitator';
import {
  PROTOCOL_BASE_MAINNET,
  reservedPayees,
  X402_FACILITATOR_BASE_MAINNET,
} from '../shared/protocol';
import {
  FACILITATOR_NETWORK,
  transferCalldata,
  verifyExactPayment,
  type ExactPayment,
  type VerifyAnswer,
} from '../server/protocol/x402/public-facilitator';
import {
  onceReady,
  publicSettlePaused,
  publicSettleReservedPayees,
  publicSettleScreening,
  createPublicSettle,
  limiterBudget,
  limiterSimulations,
  settleKey,
  unavailablePublicFacilitator,
  type PublicFacilitator,
} from '../server/protocol/x402/public-settle';

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const transferWithAuthorizationAbi = parseAbi([
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
]);
const NOW = 1_792_900_000_000;
const PAYER_A = '0x1111111111111111111111111111111111111111' as Hex;
/** The settle keys of PAYER_A's settlements start with this. */
const payerPrefix = `x402:exact:8453:${PAYER_A}:`;
const payment = (over: Partial<ExactPayment['authorization']> = {}): ExactPayment => ({
  requirements: {
    scheme: 'exact',
    network: FACILITATOR_NETWORK,
    amount: over.value ?? 50_000n,
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    payTo: '0x2222222222222222222222222222222222222222',
    maxTimeoutSeconds: 60,
  },
  authorization: {
    from: '0x1111111111111111111111111111111111111111',
    to: '0x2222222222222222222222222222222222222222',
    value: 50_000n,
    validAfter: 0n,
    validBefore: BigInt(NOW / 1000 + 600),
    nonce: `0x${'ab'.repeat(32)}`,
    ...over,
  },
  signature: `0x${'cd'.repeat(65)}`,
});
const op = (status: FeedPayOp['status'], over: Partial<FeedPayOp> = {}): FeedPayOp => ({
  key: 'k',
  status,
  txHash: status === 'queued' ? null : (`0x${'ee'.repeat(32)}` as Hex),
  blockNumber: null,
  neverSent: false,
  errorCode: null,
  ...over,
});

function harness(opts: {
  enabled?: boolean;
  verify?: () => VerifyAnswer;
  submit?: (input: Parameters<PublicFacilitator['submitCall']>[0]) => Promise<FeedPayOp>;
  known?: FeedPayOp | null;
  /** The intent stored with `known` (default: the default payment's). */
  knownIntent?: Hex;
  canPay?: boolean;
  budget?: boolean;
  screen?: (p: ExactPayment) => Promise<boolean>;
}) {
  const calls = { verify: 0, submit: [] as Parameters<PublicFacilitator['submitCall']>[0][] };
  const facilitator: PublicFacilitator = {
    submitCall: async (input) => {
      calls.submit.push(input);
      return opts.submit ? opts.submit(input) : op('included');
    },
    status: async () => opts.known ?? null,
    storedStatus: async () => opts.known ?? null,
    address: async () => '0x9999999999999999999999999999999999999999',
    storedIntent: async () =>
      opts.known ? (opts.knownIntent ?? keccak256(transferCalldata(payment()))) : null,
    canPay: async () => opts.canPay ?? true,
  };
  const verify = async (): Promise<VerifyAnswer> => {
    calls.verify += 1;
    return opts.verify ? opts.verify() : { isValid: true, payer: payment().authorization.from };
  };
  const sender = createPublicSettle({
    facilitator,
    enabled: () => opts.enabled ?? true,
    now: () => NOW,
    ...(opts.budget === undefined ? {} : { budget: async () => opts.budget! }),
    ...(opts.screen === undefined ? {} : { screen: opts.screen }),
  });
  const settle = (p: ExactPayment) => sender.settle(p, verify);
  return { settle, calls };
}

test('off unless enabled: nothing is sent', async () => {
  const { settle, calls } = harness({ enabled: false });
  const r = await settle(payment());
  assert.deepEqual([r.success, r.errorReason], [false, 'settlement_unavailable']);
  assert.equal(calls.submit.length, 0);
});

test('below the minimum value, or less than 60 s left to send: nothing is sent', async () => {
  const { settle, calls } = harness({});
  assert.equal(
    (await settle(payment({ value: 9_999n }))).errorReason,
    'invalid_exact_evm_payload_authorization_value',
  );
  assert.equal(
    (await settle(payment({ validBefore: BigInt(NOW / 1000 + 30) }))).errorReason,
    'invalid_exact_evm_payload_authorization_valid_before',
  );
  assert.equal(calls.submit.length, 0);
});

test('a payment is sent as exactly the calldata /verify simulated, keyed by payer and nonce', async () => {
  const { settle, calls } = harness({});
  const p = payment();
  const r = await settle(p);
  assert.deepEqual(r, {
    success: true,
    transaction: `0x${'ee'.repeat(32)}`,
    network: FACILITATOR_NETWORK,
    payer: p.authorization.from,
  });
  const sent = calls.submit[0]!;
  assert.equal(sent.key, settleKey(p));
  assert.equal(sent.calldata, transferCalldata(p));
  assert.equal(sent.intentHash, keccak256(sent.calldata));
});

test('a repeated request answers from its stored settlement: no second send', async () => {
  const { settle, calls } = harness({ known: op('final') });
  assert.equal((await settle(payment())).success, true);
  assert.equal(calls.submit.length, 0);
});

test('sent but not in a block is pending with its transaction; failures map to x402 reasons', async () => {
  const pending = await harness({ submit: async () => op('submitted') }).settle(payment());
  assert.deepEqual(
    [pending.success, pending.errorReason, pending.transaction],
    [false, 'settlement_pending', `0x${'ee'.repeat(32)}`],
  );
  for (const code of ['REFUSED_BEFORE_BROADCAST', 'SIMULATION_REVERTED', 'REVERTED'])
    assert.equal(
      (
        await harness({
          submit: async () => op('failed', { errorCode: code, neverSent: code !== 'REVERTED' }),
        }).settle(payment())
      ).errorReason,
      'invalid_transaction_state',
    );
  const noHash = await harness({ submit: async () => op('included', { txHash: null }) }).settle(
    payment(),
  );
  assert.equal(noHash.success, false, 'no transaction hash, no success');
});

test('below the gas floor or with Base unreachable nothing is sent', async () => {
  const low = harness({ canPay: false });
  assert.equal((await low.settle(payment())).errorReason, 'settlement_unavailable');
  assert.equal(low.calls.submit.length, 0);
  const rpc = harness({
    submit: async () => {
      throw new FacilitatorError('RPC_UNAVAILABLE', 'x');
    },
  });
  assert.equal((await rpc.settle(payment())).errorReason, 'settlement_unavailable');
});

test('right before the first send the payment is checked again (used or expired meanwhile)', async () => {
  let n = 0;
  const { settle } = harness({
    verify: () =>
      ++n === 1
        ? { isValid: true, payer: payment().authorization.from }
        : { isValid: false, invalidReason: 'invalid_transaction_state' },
    submit: async (input) => {
      await assert.rejects(input.beforeBroadcast(), /invalid_transaction_state/);
      return op('failed', { errorCode: 'REFUSED_BEFORE_BROADCAST', neverSent: true });
    },
  });
  assert.equal((await settle(payment())).errorReason, 'invalid_transaction_state');
});

test('end to end on the durable facilitator: one USDC transaction from its own EOA, retried safely', async (t) => {
  const { base, facilitator, row, account } = await setup(t, { router: USDC as Hex });
  const sender = createPublicSettle({ facilitator, enabled: () => true, now: () => NOW });
  const ok = async (): Promise<VerifyAnswer> => ({
    isValid: true,
    payer: payment().authorization.from,
  });
  const settle = (x: ExactPayment) => sender.settle(x, ok);
  const p = payment();
  const first = await settle(p);
  assert.equal(first.errorReason, 'settlement_pending', 'sent, not yet in a block');
  assert.equal(base.sends.length, 1);
  const tx = parseTransaction(base.sends[0]);
  assert.equal(tx.to?.toLowerCase(), USDC);
  assert.equal(
    decodeFunctionData({ abi: transferWithAuthorizationAbi, data: tx.data! }).functionName,
    'transferWithAuthorization',
  );
  const stored = await row(settleKey(p));
  assert.equal(stored.router, USDC);
  assert.equal(stored.facilitator, account.address.toLowerCase());
  await settle(p);
  assert.equal(base.sends.length, 1, 'a retry never sends a second transaction');
});

test('without its key the stand-in never sends, and settle says unavailable', async () => {
  const { settle } = createPublicSettle({
    facilitator: unavailablePublicFacilitator,
    enabled: () => true,
    now: () => NOW,
  });
  const ok = async (): Promise<VerifyAnswer> => ({
    isValid: true,
    payer: payment().authorization.from,
  });
  assert.equal((await settle(payment(), ok)).errorReason, 'settlement_unavailable');
});

test('reviewer #7(2): the same payer and nonce with another recipient never inherits a stored success', async () => {
  const { settle, calls } = harness({ known: op('final') });
  const other = payment({ to: '0x3333333333333333333333333333333333333333' });
  other.requirements.payTo = other.authorization.to;
  const r = await settle(other);
  assert.deepEqual([r.success, r.errorReason], [false, 'invalid_transaction_state']);
  assert.equal(calls.submit.length, 0);
});

test('reviewer #7(3): a completed settlement still answers after its authorization expired', async () => {
  const expired = payment({ validBefore: BigInt(NOW / 1000 - 3_600) });
  const { settle, calls } = harness({
    known: op('final'),
    knownIntent: keccak256(transferCalldata(expired)),
  });
  const r = await settle(expired);
  assert.equal(r.success, true);
  assert.equal(calls.submit.length, 0);
});

test('reviewer #36: a retry whose requirements differ from the signed amount or payee never reuses a stored success', async () => {
  const signed = payment();
  for (const change of [
    (p: ExactPayment) => (p.requirements.amount = 10_000n),
    (p: ExactPayment) => (p.requirements.payTo = '0x3333333333333333333333333333333333333333'),
  ]) {
    const { settle, calls } = harness({
      known: op('final'),
      knownIntent: keccak256(transferCalldata(signed)),
    });
    const retry = payment();
    change(retry);
    const r = await settle(retry);
    assert.equal(r.success, false);
    assert.match(String(r.errorReason), /recipient_mismatch|authorization_value/);
    assert.equal(calls.submit.length, 0);
    assert.equal(calls.verify, 0);
  }
  // Control: the unchanged requirements, after the authorization expired, still get the outcome.
  const expired = payment({ validBefore: BigInt(NOW / 1000 - 3_600) });
  const { settle, calls } = harness({
    known: op('final'),
    knownIntent: keccak256(transferCalldata(expired)),
  });
  assert.equal((await settle(expired)).success, true);
  assert.equal(calls.submit.length, 0);
});

test('the gas budget: when the daily or per-payer cap is spent nothing is stored or sent', async () => {
  const { settle, calls } = harness({ budget: false });
  assert.equal((await settle(payment())).errorReason, 'settlement_unavailable');
  assert.equal(calls.submit.length, 0);
});

test('CCA-766: at least 0.05 USDC: 0.049999 is refused before any chain read, 0.05 settles', async () => {
  const { settle, calls } = harness({});
  assert.equal(
    (await settle(payment({ value: 49_999n }))).errorReason,
    'invalid_exact_evm_payload_authorization_value',
  );
  assert.deepEqual([calls.verify, calls.submit.length], [0, 0]);
  assert.equal((await settle(payment({ value: 50_000n }))).success, true);
});

test('CCA-766: the budget is charged to the payer, the payee and the calling client, after /verify and before any send', async () => {
  const charged: unknown[][] = [];
  let submits = 0;
  const facilitator: PublicFacilitator = {
    submitCall: async () => (submits++, op('included')),
    status: async () => null,
    storedStatus: async () => null,
    storedIntent: async () => null,
    address: async () => '0x9999999999999999999999999999999999999999',
    canPay: async () => true,
  };
  let refuse = true;
  const sender = createPublicSettle({
    facilitator,
    enabled: () => true,
    now: () => NOW,
    budget: async (...args) => (charged.push(args), !refuse),
  });
  const ok = async (): Promise<VerifyAnswer> => ({
    isValid: true,
    payer: payment().authorization.from,
  });
  const r = await sender.settle(payment(), ok, { client: '198.51.100.7' });
  assert.equal(r.errorReason, 'settlement_unavailable');
  assert.equal(submits, 0, 'a refused budget sends nothing');
  assert.deepEqual(charged, [
    [
      '0x1111111111111111111111111111111111111111',
      { payee: '0x2222222222222222222222222222222222222222', client: '198.51.100.7' },
    ],
  ]);
  refuse = false;
  assert.equal((await sender.settle(payment(), ok, { client: '198.51.100.7' })).success, true);
  assert.equal(submits, 1);
});

test('CCA-704: a payer paying itself is refused before /verify and the budget; nothing is sent', async () => {
  const { settle, calls } = harness({ budget: true });
  const self = payment({ to: '0x1111111111111111111111111111111111111111' });
  self.requirements.payTo = self.authorization.to;
  assert.equal((await settle(self)).errorReason, 'invalid_payment_requirements');
  assert.equal(calls.verify, 0);
  assert.equal(calls.submit.length, 0);
});

test('CCA-766: many payers behind one payee or one client never use up the day; the day cap alerts', async () => {
  const counts = new Map<string, number>();
  const hit = async (key: string, limit: number) => {
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return { allowed: n <= limit };
  };
  const lines: string[] = [];
  let clock = NOW;
  const budget = limiterBudget(hit, { log: (line) => lines.push(line), now: () => clock });
  const payer = (i: number) => `0x${(i + 1).toString(16).padStart(40, '0')}` as Hex;
  const payee = '0x2222222222222222222222222222222222222222' as Hex;
  // 300 distinct payers (each under its own hourly cap) paying ONE payee: 100 pass.
  let passed = 0;
  for (let i = 0; i < 300; i++) if (await budget(payer(i), { payee })) passed++;
  assert.equal(passed, 100, 'one payee gets at most 100 a day');
  assert.equal(counts.get('x402-settle:day'), 100, 'refused payee attempts took no day unit');
  // 300 more payers, each to its own payee, all sent by ONE client: 100 pass.
  passed = 0;
  for (let i = 300; i < 600; i++)
    if (await budget(payer(i), { payee: payer(i + 10_000), client: '198.51.100.7' })) passed++;
  assert.equal(passed, 100, 'one client gets at most 100 a day');
  assert.equal(counts.get('x402-settle:day'), 200, 'refused client attempts took no day unit');
  assert.equal(lines.length, 0, 'no alert while the day has room');
  // Many payees and many clients: the day itself fills at 500, then refuses and alerts once.
  passed = 0;
  for (let i = 600; i < 1_000; i++)
    if (await budget(payer(i), { payee: payer(i + 10_000), client: `client-${i}` })) passed++;
  assert.equal(passed, 300);
  assert.equal(lines.length, 1, 'one ALERT line, not one per refusal');
  assert.deepEqual(JSON.parse(lines[0]!), {
    event: 'x402.settle.daily_cap',
    level: 'ALERT',
    limit: 500,
    refused: 1,
  });
  assert.doesNotMatch(lines[0]!, /0x|client-/, 'no payer, payee or client in the line');
  clock += 3_600_000;
  assert.equal(await budget(payer(2_000), { payee: payer(3_000), client: 'c' }), false);
  assert.equal(lines.length, 2, 'alerts again an hour later');
  assert.equal((JSON.parse(lines[1]!) as { refused: number }).refused, 100);
});

test('CCA-704: a settlement ended at the L1 fee cap answers settlement_unavailable (retry later)', async () => {
  const { settle } = harness({
    submit: async () => op('failed', { errorCode: 'L1_FEE_CAP', neverSent: true, txHash: null }),
  });
  assert.equal((await settle(payment())).errorReason, 'settlement_unavailable');
});

/** The x402 v2 request body of a payment, as a client posts it. */
const bodyOf = (p: ExactPayment) => ({
  x402Version: 2,
  paymentRequirements: {
    ...p.requirements,
    amount: String(p.requirements.amount),
    extra: { name: 'USD Coin', version: '2' },
  },
  paymentPayload: {
    x402Version: 2,
    payload: {
      signature: p.signature,
      authorization: {
        ...p.authorization,
        value: String(p.authorization.value),
        validAfter: String(p.authorization.validAfter),
        validBefore: String(p.authorization.validBefore),
      },
    },
  },
});

test('CCA-704: the shared simulation budget is taken only by a payment that passed the static checks', async () => {
  let taken = 0;
  let simulated = 0;
  const facilitator: PublicFacilitator = {
    submitCall: async () => op('included'),
    status: async () => null,
    storedStatus: async () => null,
    storedIntent: async () => null,
    address: async () => '0x9999999999999999999999999999999999999999',
    canPay: async () => true,
  };
  const { settle } = createPublicSettle({
    facilitator,
    enabled: () => true,
    simulations: async () => (taken++, true),
    now: () => NOW,
  });
  const verifyOf =
    (p: ExactPayment) =>
    (admit?: () => Promise<void>): Promise<VerifyAnswer> =>
      verifyExactPayment(bodyOf(p), {
        reader: { call: async () => (simulated++, '0x') },
        nowSeconds: NOW / 1000,
        admit,
      });
  // Not valid yet: refused on its own terms, no budget unit taken, no simulation.
  const early = payment({ validAfter: BigInt(NOW / 1000 + 60) });
  assert.equal(
    (await settle(early, verifyOf(early))).errorReason,
    'invalid_exact_evm_payload_authorization_valid_after',
  );
  assert.deepEqual([taken, simulated], [0, 0]);
  const good = payment();
  assert.equal((await settle(good, verifyOf(good))).success, true);
  assert.deepEqual([taken, simulated], [1, 1]);
  // Budget spent: refused before the simulation.
  const spent = createPublicSettle({
    facilitator,
    enabled: () => true,
    simulations: async () => false,
    now: () => NOW,
  });
  const next = payment({ nonce: `0x${'ac'.repeat(32)}` });
  simulated = 0;
  assert.equal((await spent.settle(next, verifyOf(next))).errorReason, 'settlement_unavailable');
  assert.equal(simulated, 0);
});

test('CCA-704: a reserved payee is refused before /verify and the budget; an unreadable reserved set refuses everything', async () => {
  let failing = false;
  let verified = 0;
  let sent = 0;
  const { settle } = createPublicSettle({
    facilitator: {
      submitCall: async () => (sent++, op('included')),
      status: async () => null,
      storedStatus: async () => null,
      storedIntent: async () => null,
      address: async () => '0x9999999999999999999999999999999999999999',
      canPay: async () => true,
    },
    enabled: () => true,
    reserved: async () => {
      if (failing) throw new Error('keystore unavailable');
      return new Set(['0x2222222222222222222222222222222222222222']);
    },
    now: () => NOW,
  });
  const verify = async (): Promise<VerifyAnswer> => (
    verified++,
    { isValid: true, payer: payment().authorization.from }
  );
  assert.equal((await settle(payment(), verify)).errorReason, 'invalid_payment_requirements');
  const other = payment({ to: '0x4444444444444444444444444444444444444444' });
  other.requirements.payTo = other.authorization.to;
  assert.equal((await settle(other, verify)).success, true);
  failing = true;
  assert.equal((await settle(other, verify)).errorReason, 'settlement_unavailable');
  assert.deepEqual([verified, sent], [1, 1]);
});

test('CCA-704: the reserved payees: treasury, routers 1-3, both facilitators, the sponsor, the paymaster and our key addresses', () => {
  const sponsor = '0x64e8FFB436a236da487d1c20fF2548A70cf82C13';
  const submitter = '0x5555555555555555555555555555555555555555';
  const paymaster = '0x8Bf5b18b733a864c17Cd92615cD45D833Fcfe105';
  const publicSender = '0x6666666666666666666666666666666666666666';
  const reserved = publicSettleReservedPayees(
    { CITY_X402_PUBLIC_SETTLE_ADDRESS: publicSender, CITY_BASE_PAYMASTER_ADDRESS: paymaster },
    [sponsor, submitter],
  );
  for (const a of [
    PROTOCOL_BASE_MAINNET.treasury,
    PROTOCOL_BASE_MAINNET.feeRouter,
    PROTOCOL_BASE_MAINNET.feeRouter2,
    PROTOCOL_BASE_MAINNET.feeRouter3,
    PROTOCOL_BASE_MAINNET.usdc,
    X402_FACILITATOR_BASE_MAINNET,
    publicSender,
    sponsor,
    submitter,
    paymaster,
  ])
    assert.ok(reserved.has(a.toLowerCase()), a);
  assert.ok(!reserved.has('0x2222222222222222222222222222222222222222'));
});

test('CCA-704: one settlement in flight per payer, refused before /verify and the budget', async () => {
  const open: FeedPayOp[] = [op('submitted', { key: `${payerPrefix}0x01` })];
  let budget = 0;
  const submits: Parameters<PublicFacilitator['submitCall']>[0][] = [];
  const facilitator: PublicFacilitator = {
    submitCall: async (input) => (submits.push(input), op('included')),
    status: async () => open[0] ?? null,
    storedStatus: async () => null,
    storedIntent: async () => null,
    address: async () => '0x9999999999999999999999999999999999999999',
    canPay: async () => true,
    openWithPrefix: async (prefix) => (assert.equal(prefix, payerPrefix), open),
  };
  let verified = 0;
  const { settle } = createPublicSettle({
    facilitator,
    enabled: () => true,
    budget: async () => (budget++, true),
    now: () => NOW,
  });
  const verify = async (): Promise<VerifyAnswer> => (
    verified++,
    { isValid: true, payer: payment().authorization.from }
  );
  const r = await settle(payment(), verify);
  assert.deepEqual([r.success, r.errorReason], [false, 'payer_settlement_in_flight']);
  assert.deepEqual([verified, budget, submits.length], [0, 0, 0]);
  // Once in a block (the payer's balance moved), the next one is sent, held to one in flight.
  open[0] = op('included', { key: `${payerPrefix}0x01` });
  assert.equal((await settle(payment(), verify)).success, true);
  assert.equal(submits[0]?.oneInFlight, payerPrefix);
  // The facilitator's own atomic guard (a concurrent instance won the race) answers the same.
  const raced = createPublicSettle({
    facilitator: {
      ...facilitator,
      openWithPrefix: async () => [],
      submitCall: async () => {
        throw new FacilitatorError('IN_FLIGHT', 'in flight');
      },
    },
    enabled: () => true,
    now: () => NOW,
  });
  assert.equal((await raced.settle(payment(), verify)).errorReason, 'payer_settlement_in_flight');
  // Unreadable: refused (fails closed).
  const unreadable = createPublicSettle({
    facilitator: { ...facilitator, openWithPrefix: async () => Promise.reject(new Error('db')) },
    enabled: () => true,
    now: () => NOW,
  });
  assert.equal((await unreadable.settle(payment(), verify)).errorReason, 'settlement_unavailable');
});

test('CCA-704: a payer whose settlement reverted on Base is refused for an hour; others are not', async () => {
  const recorded = new Set<string>();
  const cooldown = {
    record: async (payer: Hex) => void recorded.add(payer.toLowerCase()),
    cooling: async (payer: Hex) => recorded.has(payer.toLowerCase()),
  };
  const open: FeedPayOp[] = [op('included', { key: `${payerPrefix}0x01`, errorCode: 'REVERTED' })];
  let sent = 0;
  const facilitator: PublicFacilitator = {
    submitCall: async () => (sent++, op('included')),
    status: async () => null,
    storedStatus: async () => null,
    storedIntent: async () => null,
    address: async () => '0x9999999999999999999999999999999999999999',
    canPay: async () => true,
    openWithPrefix: async () => open,
  };
  const { settle } = createPublicSettle({
    facilitator,
    enabled: () => true,
    cooldown,
    now: () => NOW,
  });
  const ok = async (): Promise<VerifyAnswer> => ({ isValid: true, payer: PAYER_A });
  assert.equal((await settle(payment(), ok)).errorReason, 'settlement_unavailable');
  assert.equal(recorded.has(PAYER_A.toLowerCase()), true);
  // The reverted one gone from the open list (final now): still cooling down.
  open.length = 0;
  assert.equal((await settle(payment(), ok)).errorReason, 'settlement_unavailable');
  assert.equal(sent, 0);
  const other = payment({ from: '0x7777777777777777777777777777777777777777' });
  assert.equal((await settle(other, ok)).success, true);
  // A stored settlement that reverted, answered to a retry, starts the cool-down too.
  const retried = createPublicSettle({
    facilitator: {
      ...facilitator,
      storedIntent: async () => keccak256(transferCalldata(other)),
      storedStatus: async () => op('failed', { errorCode: 'REVERTED' }),
    },
    enabled: () => true,
    cooldown,
    now: () => NOW,
  });
  assert.equal((await retried.settle(other, ok)).errorReason, 'invalid_transaction_state');
  assert.equal(recorded.has('0x7777777777777777777777777777777777777777'), true);
});

test('CCA-704: nothing new is signed in a fee spike or while the lane head is stuck; unreadable refuses', async () => {
  for (const [over, why] of [
    [{ feeRoom: async () => false }, 'fee spike'],
    [{ feeRoom: async () => Promise.reject(new Error('rpc')) }, 'fees unreadable'],
    [{ laneStuck: async () => true }, 'stuck lane'],
    [{ laneStuck: async () => Promise.reject(new Error('rpc')) }, 'lane unreadable'],
  ] as const) {
    let verified = 0;
    let sent = 0;
    const { settle } = createPublicSettle({
      facilitator: {
        submitCall: async () => (sent++, op('included')),
        status: async () => null,
        storedStatus: async () => null,
        storedIntent: async () => null,
        address: async () => '0x9999999999999999999999999999999999999999',
        canPay: async () => true,
        feeRoom: async () => true,
        laneStuck: async () => false,
        ...over,
      },
      enabled: () => true,
      now: () => NOW,
    });
    const verify = async (): Promise<VerifyAnswer> => (
      verified++,
      { isValid: true, payer: payment().authorization.from }
    );
    assert.equal((await settle(payment(), verify)).errorReason, 'settlement_unavailable', why);
    assert.deepEqual([verified, sent], [0, 0], why);
  }
  // Both fine: settles, and the lane is called stuck after 10 minutes.
  let asked = 0;
  const fine = createPublicSettle({
    facilitator: {
      submitCall: async () => op('included'),
      status: async () => null,
      storedStatus: async () => null,
      storedIntent: async () => null,
      address: async () => '0x9999999999999999999999999999999999999999',
      canPay: async () => true,
      feeRoom: async () => true,
      laneStuck: async (ms) => ((asked = ms), false),
    },
    enabled: () => true,
    now: () => NOW,
  });
  const ok = async (): Promise<VerifyAnswer> => ({ isValid: true, payer: PAYER_A });
  assert.equal((await fine.settle(payment(), ok)).success, true);
  assert.equal(asked, 10 * 60_000);
});

test('CCA-704: the runtime switch: paused, nothing new is checked or sent and Base is not followed; unreadable is paused', async () => {
  let paused: boolean | Error = true;
  let followed = 0;
  let sent = 0;
  let verified = 0;
  let stored: FeedPayOp | null = null;
  const { settle } = createPublicSettle({
    facilitator: {
      submitCall: async () => (sent++, op('included')),
      status: async () => (followed++, stored),
      storedStatus: async () => stored,
      storedIntent: async () => (stored ? keccak256(transferCalldata(payment())) : null),
      address: async () => '0x9999999999999999999999999999999999999999',
      canPay: async () => true,
    },
    enabled: () => true,
    paused: async () => {
      if (paused instanceof Error) throw paused;
      return paused;
    },
    now: () => NOW,
  });
  const verify = async (): Promise<VerifyAnswer> => (
    verified++,
    { isValid: true, payer: payment().authorization.from }
  );
  assert.equal((await settle(payment(), verify)).errorReason, 'settlement_unavailable');
  paused = new Error('db down');
  assert.equal((await settle(payment(), verify)).errorReason, 'settlement_unavailable');
  assert.deepEqual([verified, sent], [0, 0]);
  // A settlement already sent still answers its stored state, without following Base.
  paused = true;
  stored = op('submitted');
  const pending = await settle(payment(), verify);
  assert.equal(pending.errorReason, 'settlement_pending');
  assert.equal(pending.transaction, op('submitted').txHash);
  assert.equal(followed, 0);
  // Switched back on: as before.
  paused = false;
  stored = null;
  assert.equal((await settle(payment(), verify)).success, true);
  assert.deepEqual([verified, sent], [1, 1]);
});

test('CCA-704: the switch is the feed_flags row x402-settle, read per call; a failed read is paused', async () => {
  let row: { enabled: boolean } | undefined;
  let fail = false;
  const queries: unknown[][] = [];
  const read = publicSettlePaused({
    query: async (sql: string, params?: unknown[]) => {
      queries.push([sql, params]);
      if (fail) throw new Error('db down');
      return { rows: row ? [row] : [] } as never;
    },
  });
  assert.equal(await read(), false, 'no row: on (CITY_X402_PUBLIC_SETTLE decides)');
  row = { enabled: false };
  assert.equal(await read(), true);
  row = { enabled: true };
  assert.equal(await read(), false);
  fail = true;
  assert.equal(await read(), true);
  assert.equal(queries.length, 4, 'never cached');
  assert.match(String(queries[0]![0]), /FROM feed_flags WHERE name = \$1/);
  assert.deepEqual(queries[0]![1], ['x402-settle']);
});

/** CCA-123: our own and infrastructure contracts on Base mainnet, and the sponsor wallet. */
const INFRASTRUCTURE = [
  ['own paymaster', '0x8Bf5b18b733a864c17Cd92615cD45D833Fcfe105'],
  ['EntryPoint v0.6', '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789'],
  ['ERC-8004 IdentityRegistry', '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'],
  ['ERC-8004 ReputationRegistry', '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63'],
  ['sponsor wallet', '0x64e8FFB436a236da487d1c20fF2548A70cf82C13'],
] as const;

test('CCA-123: our paymaster, the EntryPoint, the ERC-8004 registries and the sponsor are reserved payees; /settle refuses each', async () => {
  const defaults = reservedPayees();
  let sent = 0;
  let verified = 0;
  const { settle } = createPublicSettle({
    facilitator: {
      submitCall: async () => (sent++, op('included')),
      status: async () => null,
      storedStatus: async () => null,
      storedIntent: async () => null,
      address: async () => '0x9999999999999999999999999999999999999999',
      canPay: async () => true,
    },
    enabled: () => true,
    // Exactly the app's set, with no configured key or paymaster setting.
    reserved: async () => publicSettleReservedPayees({}, []),
    now: () => NOW,
  });
  const verify = async (): Promise<VerifyAnswer> => (verified++, { isValid: true, payer: PAYER_A });
  for (const [name, address] of INFRASTRUCTURE) {
    assert.ok(defaults.has(address.toLowerCase()), name);
    const p = payment({ to: address });
    p.requirements.payTo = address;
    assert.equal((await settle(p, verify)).errorReason, 'invalid_payment_requirements', name);
  }
  assert.deepEqual([verified, sent], [0, 0]);
});

test('known(): for the route before /verify, null for a new payment, the stored answer for a seen one', async () => {
  const fresh = createPublicSettle({
    facilitator: unavailablePublicFacilitator,
    enabled: () => true,
  });
  assert.equal(await fresh.known(payment()), null);
});

test('/verify runs only for a new payment, after the lookup; its refusal is the answer, nothing sent', async () => {
  const seen = harness({ known: op('final') });
  await seen.settle(payment());
  assert.equal(
    seen.calls.verify,
    0,
    'a stored settlement never re-verifies (its nonce is used now)',
  );
  const fresh = harness({
    verify: () => ({ isValid: false, invalidReason: 'invalid_exact_evm_payload_signature' }),
  });
  assert.equal((await fresh.settle(payment())).errorReason, 'invalid_exact_evm_payload_signature');
  assert.equal(fresh.calls.submit.length, 0);
});

test('reviewer #21: invalid requests never use the gas budget; a valid one then settles', async () => {
  let budget = 0;
  let valid = false;
  const facilitator: PublicFacilitator = {
    submitCall: async () => op('included'),
    status: async () => null,
    storedStatus: async () => null,
    address: async () => '0x9999999999999999999999999999999999999999',
    storedIntent: async () => null,
    canPay: async () => true,
  };
  const { settle } = createPublicSettle({
    facilitator,
    enabled: () => true,
    budget: async () => ++budget <= 1,
    now: () => NOW,
  });
  const verify = async (): Promise<VerifyAnswer> =>
    valid
      ? { isValid: true, payer: payment().authorization.from }
      : { isValid: false, invalidReason: 'invalid_exact_evm_payload_signature' };
  for (let i = 0; i < 5; i++)
    assert.equal(
      (await settle(payment(), verify)).errorReason,
      'invalid_exact_evm_payload_signature',
    );
  assert.equal(budget, 0, 'no budget taken by invalid requests');
  valid = true;
  assert.equal((await settle(payment(), verify)).success, true);
  assert.equal(budget, 1);
});

test('reviewer #21(b): refused right before the send answers the real reason', async () => {
  let n = 0;
  const { settle } = harness({
    verify: () =>
      ++n === 1
        ? { isValid: true, payer: payment().authorization.from }
        : { isValid: false, invalidReason: 'invalid_exact_evm_payload_authorization_valid_before' },
    submit: async (input) => {
      await input.beforeBroadcast().catch(() => {});
      return op('failed', { errorCode: 'REFUSED_BEFORE_BROADCAST', neverSent: true });
    },
  });
  assert.equal(
    (await settle(payment())).errorReason,
    'invalid_exact_evm_payload_authorization_valid_before',
  );
});

test("nothing is sent when the advertised address is not the key's real address", async () => {
  const facilitator: PublicFacilitator = {
    submitCall: async () => op('included'),
    status: async () => null,
    storedStatus: async () => null,
    storedIntent: async () => null,
    address: async () => '0x9999999999999999999999999999999999999999',
    canPay: async () => true,
  };
  let sent = 0;
  const f2 = { ...facilitator, submitCall: async () => (sent++, op('included')) };
  const ok = async (): Promise<VerifyAnswer> => ({
    isValid: true,
    payer: payment().authorization.from,
  });
  const wrong = createPublicSettle({
    facilitator: f2,
    enabled: () => true,
    advertised: '0x8888888888888888888888888888888888888888',
    now: () => NOW,
  });
  assert.equal((await wrong.settle(payment(), ok)).errorReason, 'settlement_unavailable');
  assert.equal(sent, 0);
  const right = createPublicSettle({
    facilitator: f2,
    enabled: () => true,
    advertised: '0x9999999999999999999999999999999999999999',
    now: () => NOW,
  });
  assert.equal((await right.settle(payment(), ok)).success, true);
});

test('reviewer #70: a payer over its hourly cap never uses up the day; another payer still settles', async () => {
  const counts = new Map<string, number>();
  const hit = async (key: string, limit: number) => {
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return { allowed: n <= limit };
  };
  const budget = limiterBudget(hit);
  const a = '0x1111111111111111111111111111111111111111';
  const b = '0x2222222222222222222222222222222222222222';
  const payee = '0x3333333333333333333333333333333333333333';
  for (let i = 0; i < 20; i++) assert.equal(await budget(a, { payee }), true);
  for (let i = 0; i < 30; i++) assert.equal(await budget(a, { payee }), false, 'over 20/h refused');
  assert.equal(counts.get('x402-settle:day'), 20, 'the 30 refused attempts took no day unit');
  assert.equal(counts.get(`x402-settle:payee:${payee}`), 20, 'nor a payee unit');
  assert.equal(await budget(b, { payee }), true, 'another payer settles');
  assert.equal(counts.get('x402-settle:day'), 21);
});

test('retries read the stored state; Base is followed at most once per 10 s per settlement', async () => {
  let followed = 0;
  let clock = NOW;
  const facilitator: PublicFacilitator = {
    submitCall: async () => op('submitted'),
    status: async () => (followed++, op('submitted')),
    storedStatus: async () => op('submitted'),
    storedIntent: async () => keccak256(transferCalldata(payment())),
    address: async () => '0x9999999999999999999999999999999999999999',
    canPay: async () => true,
  };
  const { settle } = createPublicSettle({ facilitator, enabled: () => true, now: () => clock });
  const ok = async (): Promise<VerifyAnswer> => ({
    isValid: true,
    payer: payment().authorization.from,
  });
  for (let i = 0; i < 50; i++) await settle(payment(), ok);
  assert.equal(followed, 1, '50 retries within 10 s follow Base once');
  clock += 10_000;
  await settle(payment(), ok);
  assert.equal(followed, 2);
  const final = createPublicSettle({
    facilitator: { ...facilitator, storedStatus: async () => op('final') },
    enabled: () => true,
    now: () => clock,
  });
  assert.equal((await final.settle(payment(), ok)).success, true);
  assert.equal(followed, 2, 'a final settlement never reads Base again');
});

test('reviewer #10 bounded work: at most maxInFlight new payments at once; the rest refused at once', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  let simulated = 0;
  const facilitator: PublicFacilitator = {
    submitCall: async () => (await gate, op('included')),
    status: async () => null,
    storedStatus: async () => null,
    storedIntent: async () => null,
    address: async () => '0x9999999999999999999999999999999999999999',
    canPay: async () => true,
  };
  const { settle } = createPublicSettle({
    facilitator,
    enabled: () => true,
    maxInFlight: 2,
    now: () => NOW,
  });
  const verify = async (): Promise<VerifyAnswer> => (
    simulated++,
    { isValid: true, payer: payment().authorization.from }
  );
  const nonce = (i: number) => `0x${i.toString(16).padStart(64, '0')}` as Hex;
  const running = [
    settle(payment({ nonce: nonce(1) }), verify),
    settle(payment({ nonce: nonce(2) }), verify),
  ];
  await new Promise((r) => setTimeout(r, 10));
  const third = await settle(payment({ nonce: nonce(3) }), verify);
  assert.equal(third.errorReason, 'settlement_unavailable');
  assert.equal(simulated, 2, 'the refused one never simulated');
  release();
  await Promise.all(running);
  assert.equal((await settle(payment({ nonce: nonce(4) }), verify)).success, true, 'free again');
});

test('reviewer #10 bounded work: the shared simulation cap refuses before any chain read', async () => {
  const counts = new Map<string, number>();
  const hit = async (key: string, limit: number) => {
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return { allowed: n <= limit };
  };
  const sims = limiterSimulations(hit);
  let simulated = 0;
  const { settle } = createPublicSettle({
    facilitator: {
      submitCall: async () => op('included'),
      status: async () => null,
      storedStatus: async () => null,
      storedIntent: async () => null,
      address: async () => '0x9999999999999999999999999999999999999999',
      canPay: async () => true,
    },
    enabled: () => true,
    simulations: sims,
    now: () => NOW,
  });
  // As /verify: admission to the simulation (the shared cap) right before simulating.
  const verify = async (admit?: () => Promise<void>): Promise<VerifyAnswer> => {
    await admit?.();
    simulated++;
    return { isValid: true, payer: payment().authorization.from };
  };
  for (let i = 0; i < 125; i++)
    await settle(payment({ nonce: `0x${(i + 1).toString(16).padStart(64, '0')}` as Hex }), verify);
  assert.equal(simulated, 120, 'only 120 simulations a minute');
});

test('sanctions screening (reviewer #95): payer and payee are screened after /verify and before the budget; refused or unanswered means nothing is sent', async () => {
  for (const screen of [async () => false, async () => Promise.reject(new Error('oracle down'))]) {
    const { settle, calls } = harness({ screen, budget: true });
    const r = await settle(payment());
    assert.deepEqual([r.success, r.errorReason], [false, 'settlement_unavailable']);
    assert.equal(calls.verify, 1);
    assert.equal(calls.submit.length, 0);
  }
  const screened: ExactPayment[] = [];
  const ok = harness({ screen: async (p) => (screened.push(p), true) });
  assert.equal((await ok.settle(payment())).success, true);
  assert.equal(screened.length, 1);
  assert.equal(ok.calls.submit.length, 1);
  // Not for a payment /verify refuses, and not for a retry answered from the stored settlement.
  const invalid = harness({
    verify: () => ({
      isValid: false,
      invalidReason: 'invalid_exact_evm_payload_signature',
      payer: payment().authorization.from,
    }),
    screen: async () => assert.fail('screened an invalid payment'),
  });
  assert.equal((await invalid.settle(payment())).success, false);
  const retry = harness({
    known: op('final'),
    screen: async () => assert.fail('screened a stored settlement'),
  });
  assert.equal((await retry.settle(payment())).success, true);
});

test('reviewer #95: an authorization valid for more than 15 minutes from now is refused before anything else', async () => {
  const { settle, calls } = harness({});
  const far = payment({ validBefore: BigInt(NOW / 1000 + 15 * 60 + 1) });
  const r = await settle(far);
  assert.deepEqual(
    [r.success, r.errorReason],
    [false, 'invalid_exact_evm_payload_authorization_valid_before'],
  );
  assert.equal(calls.verify, 0);
  assert.equal(calls.submit.length, 0);
  assert.equal(
    (await harness({}).settle(payment({ validBefore: BigInt(NOW / 1000 + 15 * 60) }))).success,
    true,
  );
});

test('reviewer #97: with screening switched off nothing settles; on, payer and payee are screened with the exact binding', async () => {
  const requests: unknown[] = [];
  const screen = async (r: unknown) => (
    requests.push(r),
    { allowed: true, outcome: 'allowed', reason: 'clear', decisionId: 'd1' }
  );
  const off = harness({ screen: publicSettleScreening({ enabled: () => false, screen }) });
  const r = await off.settle(payment());
  assert.deepEqual([r.success, r.errorReason], [false, 'settlement_unavailable']);
  assert.equal(off.calls.submit.length, 0);
  assert.equal(requests.length, 0);
  const on = harness({ screen: publicSettleScreening({ enabled: () => true, screen }) });
  assert.equal((await on.settle(payment())).success, true);
  const p = payment().authorization;
  assert.deepEqual(requests, [
    {
      chainId: 8453,
      token: payment().requirements.asset,
      amountRaw: p.value,
      intentId: `x402-settle:${p.from.toLowerCase()}:${p.nonce.toLowerCase()}`,
      parties: [
        { role: 'payer', address: p.from },
        { role: 'payee', address: p.to },
      ],
    },
  ]);
  const blocked = harness({
    screen: publicSettleScreening({
      enabled: () => true,
      screen: async () => ({
        allowed: false,
        outcome: 'blocked',
        reason: 'sanctioned',
        decisionId: 'd2',
      }),
    }),
  });
  assert.equal((await blocked.settle(payment())).success, false);
  assert.equal(blocked.calls.submit.length, 0);
});

test('reviewer #73: concurrent first callers share one sender; an unready one is rebuilt, a ready one kept', async () => {
  let builds = 0;
  let ready = false;
  const get = onceReady(async () => {
    builds += 1;
    await new Promise((r) => setTimeout(r, 20));
    return { value: { n: builds }, ready };
  });
  const first = await Promise.all(Array.from({ length: 10 }, () => get()));
  assert.equal(builds, 1);
  assert.ok(first.every((s) => s === first[0]));
  ready = true;
  const second = await Promise.all(Array.from({ length: 10 }, () => get()));
  assert.equal(builds, 2);
  assert.ok(second.every((s) => s === second[0]));
  assert.equal(await get(), second[0]);
  assert.equal(builds, 2);
});

test('security gate (CCA-766): a client at its cap never spends a victim payee budget; another client still settles to it', async () => {
  const counts = new Map<string, number>();
  const hit = async (key: string, limit: number) => {
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return { allowed: n <= limit };
  };
  const budget = limiterBudget(hit, { log: () => {} });
  const payer = (i: number) => `0x${(i + 1).toString(16).padStart(40, '0')}` as Hex;
  const victim = '0x00000000000000000000000000000000000000aa' as Hex;
  // The attacker's client uses up its own 100 a day on payees of its own.
  for (let i = 0; i < 100; i++)
    assert.equal(await budget(payer(i), { payee: payer(i + 5_000), client: 'attacker' }), true);
  // Then it keeps sending valid requests to the victim payee from fresh payers: all refused …
  for (let i = 100; i < 300; i++)
    assert.equal(await budget(payer(i), { payee: victim, client: 'attacker' }), false);
  // … before the victim's bucket or the day was touched.
  assert.equal(counts.get(`x402-settle:payee:${victim}`), undefined, 'victim budget untouched');
  assert.equal(counts.get('x402-settle:day'), 100);
  // Another client settles to the victim payee.
  assert.equal(await budget(payer(1_000), { payee: victim, client: 'honest' }), true);
  assert.equal(counts.get(`x402-settle:payee:${victim}`), 1);
});

test('security gate: the screening decision is logged without the Fastify logger, codes only, no address', async (t) => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  t.after(() => {
    console.error = original;
  });
  const p = payment();
  const answers: (() => Promise<{
    allowed: boolean;
    outcome: string;
    reason: string;
    decisionId: string | null;
  }>)[] = [
    async () => ({ allowed: true, outcome: 'allowed', reason: 'clear', decisionId: 'd-1' }),
    async () => ({ allowed: false, outcome: 'blocked', reason: 'sanctioned', decisionId: 'd-2' }),
    // A reason that is not a plain code (here an address) never reaches the log.
    async () => ({
      allowed: false,
      outcome: 'blocked',
      reason: p.authorization.from,
      decisionId: 'd-3',
    }),
    async () => {
      throw Object.assign(new Error(`oracle refused ${p.authorization.to}`), {
        code: 'ETIMEDOUT',
      });
    },
  ];
  for (const answer of answers) {
    // The production default: no log sink passed (app.ts passes only options.logLine, if any).
    const screen = publicSettleScreening({ enabled: () => true, screen: answer });
    await screen(p).catch(() => false);
  }
  assert.deepEqual(
    lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    [
      { event: 'x402_settle_screening', outcome: 'allowed', reason: 'clear' },
      { event: 'x402_settle_screening', outcome: 'blocked', reason: 'sanctioned' },
      { event: 'x402_settle_screening', outcome: 'blocked', reason: 'other' },
      { event: 'x402_settle_screening', outcome: 'error', reason: 'ETIMEDOUT' },
    ],
  );
  for (const line of lines) {
    assert.doesNotMatch(line, /0x[0-9a-f]/i, 'no address');
    assert.doesNotMatch(line, /d-[0-9]|oracle refused/, 'no decision id, no raw message');
  }
});
