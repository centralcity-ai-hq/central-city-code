// Fee router 2 (docs/protocol/FEE_ROUTER_2.md): the routing rule on the exact total, each router's
// own cap in quotes and calls, and the ledger reading both routers without double counting.
import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, type Hex } from 'viem';
import {
  FEE_ROUTER_ABI,
  FeeQuoteError,
  KIND_EXTERNAL,
  KIND_INTERNAL,
  MAX_LISTED_PRICE_ROUTER2,
  MAX_TOTAL,
  MAX_TOTAL_ROUTER2,
  feeCalls,
  feeFor,
  maxTotalOfRouter,
  payCalls,
  quoteFeeIncluded,
  quoteFeeOnTop,
  routeFor,
  totalFor,
} from '../server/protocol/fees/fee-call.js';

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Hex;
const USDC = addr(0xc0);
const ROUTER = addr(0x40);
const ROUTER2 = addr(0x42);
const PAYEE = addr(0x5e);

// Spec section 3: the exact boundary vectors.
const VECTORS: {
  kind: 0 | 1;
  gross: bigint;
  fee: bigint;
  total: bigint;
  route: 'r1' | 'r2' | null;
}[] = [
  { kind: 1, gross: 100_000n, fee: 10_000n, total: 100_000n, route: 'r1' },
  { kind: 1, gross: 100_001n, fee: 10_000n, total: 100_001n, route: 'r2' },
  { kind: 1, gross: 100_000_000n, fee: 10_000_000n, total: 100_000_000n, route: 'r2' },
  { kind: 1, gross: 100_000_001n, fee: 10_000_000n, total: 100_000_001n, route: null },
  { kind: 0, gross: 90_909n, fee: 9_090n, total: 99_999n, route: 'r1' },
  { kind: 0, gross: 90_910n, fee: 9_091n, total: 100_001n, route: 'r2' },
  { kind: 0, gross: 90_909_091n, fee: 9_090_909n, total: 100_000_000n, route: 'r2' },
  { kind: 0, gross: 90_909_092n, fee: 9_090_909n, total: 100_000_001n, route: null },
];

test('router 2 cap is 100 USDC; router 1 keeps 0.10 USDC', () => {
  assert.equal(MAX_TOTAL, 100_000n);
  assert.equal(MAX_TOTAL_ROUTER2, 100_000_000n);
});

test('every boundary vector: fee, total and router exactly as the spec table', () => {
  for (const v of VECTORS) {
    const kind = v.kind === 1 ? KIND_INTERNAL : KIND_EXTERNAL;
    assert.equal(feeFor(v.gross), v.fee, `fee of ${v.gross}`);
    assert.equal(totalFor(kind, v.gross), v.total, `total of ${v.gross} kind ${v.kind}`);
    const route = routeFor({ total: v.total, router: ROUTER, router2: ROUTER2 });
    const want = v.route === 'r1' ? ROUTER : v.route === 'r2' ? ROUTER2 : null;
    assert.equal(route?.router ?? null, want, `route of total ${v.total}`);
    if (route) assert.equal(route.maxTotal, v.route === 'r1' ? MAX_TOTAL : MAX_TOTAL_ROUTER2);
  }
});

test('a kind-0 total of exactly 0.10 USDC is unreachable (no gross gives 100_000)', () => {
  for (let gross = 90_900n; gross <= 90_920n; gross++)
    assert.notEqual(totalFor(KIND_EXTERNAL, gross), 100_000n, `gross ${gross}`);
});

test('router 2 off or missing: every total above 0.10 USDC is refused, router 1 unchanged', () => {
  for (const v of VECTORS) {
    const route = routeFor({ total: v.total, router: ROUTER, router2: null });
    assert.equal(route?.router ?? null, v.route === 'r1' ? ROUTER : null, `total ${v.total}`);
  }
  assert.equal(routeFor({ total: 0n, router: ROUTER, router2: ROUTER2 }), null);
});

test('quotes use the pinned router cap; the default cap is router 1 (behaviour unchanged)', () => {
  // Fee on top.
  assert.deepEqual(quoteFeeOnTop(90_909n), { gross: 90_909n, fee: 9_090n, total: 99_999n });
  assert.throws(
    () => quoteFeeOnTop(90_910n),
    (e: unknown) => e instanceof FeeQuoteError && e.code === 'OVER_CAP',
  );
  assert.throws(() => quoteFeeOnTop(90_910n), /above \$0\.10\./);
  assert.deepEqual(quoteFeeOnTop(90_909_091n, MAX_TOTAL_ROUTER2), {
    gross: 90_909_091n,
    fee: 9_090_909n,
    total: 100_000_000n,
  });
  assert.throws(() => quoteFeeOnTop(90_909_092n, MAX_TOTAL_ROUTER2), /above \$100\./);
  // A 100 USDC external quote totals 110 USDC: refused.
  assert.throws(() => quoteFeeOnTop(100_000_000n, MAX_TOTAL_ROUTER2), /above \$100\./);
  // Fee included.
  assert.deepEqual(quoteFeeIncluded(100_000n), { gross: 100_000n, fee: 10_000n, net: 90_000n });
  assert.throws(() => quoteFeeIncluded(100_001n), /above \$0\.10\./);
  assert.deepEqual(quoteFeeIncluded(100_001n, MAX_TOTAL_ROUTER2), {
    gross: 100_001n,
    fee: 10_000n,
    net: 90_001n,
  });
  assert.deepEqual(quoteFeeIncluded(100_000_000n, MAX_TOTAL_ROUTER2), {
    gross: 100_000_000n,
    fee: 10_000_000n,
    net: 90_000_000n,
  });
  assert.throws(() => quoteFeeIncluded(100_000_001n, MAX_TOTAL_ROUTER2), /above \$100\./);
});

test('calls for router 2: exact approval to router 2, router 2 called, refused above its cap', () => {
  const included = quoteFeeIncluded(10_000_000n, MAX_TOTAL_ROUTER2);
  const pay = payCalls({
    usdc: USDC,
    router: ROUTER2,
    payee: PAYEE,
    quote: included,
    paymentIntentId: 'call-10usdc',
    maxTotal: MAX_TOTAL_ROUTER2,
  });
  assert.equal(pay[1]!.to.toLowerCase(), ROUTER2.toLowerCase());
  const approve = decodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'approve',
        inputs: [{ type: 'address' }, { type: 'uint256' }],
        outputs: [{ type: 'bool' }],
        stateMutability: 'nonpayable',
      },
    ],
    data: pay[0]!.data,
  });
  assert.equal((approve.args![0] as string).toLowerCase(), ROUTER2.toLowerCase());
  assert.equal(approve.args![1], 10_000_000n, 'the approval is exactly the price');
  assert.equal(decodeFunctionData({ abi: FEE_ROUTER_ABI, data: pay[1]!.data }).functionName, 'pay');
  // Without the router 2 cap the same quote is refused: a pinned router 2 call never falls back.
  assert.throws(() =>
    payCalls({ usdc: USDC, router: ROUTER2, payee: PAYEE, quote: included, paymentIntentId: 'x' }),
  );
  const onTop = quoteFeeOnTop(9_090_909n, MAX_TOTAL_ROUTER2);
  const fee = feeCalls({
    usdc: USDC,
    router: ROUTER2,
    payee: PAYEE,
    quote: onTop,
    paymentIntentId: 'call-ext',
    maxTotal: MAX_TOTAL_ROUTER2,
  });
  assert.equal(fee[1]!.to.toLowerCase(), ROUTER2.toLowerCase());
  assert.equal(
    decodeFunctionData({ abi: FEE_ROUTER_ABI, data: fee[1]!.data }).functionName,
    'chargeFee',
  );
});

test('the cap of a pinned router: router 2 only when it is the configured router 2', () => {
  assert.equal(maxTotalOfRouter(ROUTER2, ROUTER2), MAX_TOTAL_ROUTER2);
  assert.equal(
    maxTotalOfRouter(ROUTER2.toUpperCase().replace('0X', '0x'), ROUTER2),
    MAX_TOTAL_ROUTER2,
  );
  assert.equal(maxTotalOfRouter(ROUTER, ROUTER2), MAX_TOTAL);
  assert.equal(maxTotalOfRouter(ROUTER2, null), MAX_TOTAL);
});

// Pot rules (FEE_ROUTER_2.md section 6, D1-D3).
import { floatTopUp } from '../server/feed/pay/engine.js';

const USDC1 = 1_000_000n;
const pot = (o: Partial<Parameters<typeof floatTopUp>[0]>) =>
  floatTopUp({
    amount: 0n,
    floatFree: 0n,
    allowanceLeft: 1_000n * USDC1,
    walletFree: 1_000n * USDC1,
    calendar: null,
    ...o,
  });

test('pot D3: a 100 USDC target is filled in ONE top-up when every ceiling allows it', () => {
  assert.equal(pot({ amount: 50_000n, target: 100n * USDC1, scoped: true }), 100n * USDC1);
  // Already partly filled: only the missing part.
  assert.equal(
    pot({ amount: 50_000n, floatFree: 30_000n, target: 100n * USDC1, scoped: true }),
    100n * USDC1 - 30_000n,
  );
});

test('pot D1: target 1, per-call 100, empty pot, call 80 -> one top-up of 80 (the allowed call)', () => {
  assert.equal(pot({ amount: 80n * USDC1, target: USDC1, scoped: true }), 80n * USDC1);
});

test('pot D3: ceilings clamp the fill; refused when even the clamp cannot cover the call', () => {
  // target 100, allowance left 20, call 10 -> fill 20.
  assert.equal(
    pot({ amount: 10n * USDC1, allowanceLeft: 20n * USDC1, target: 100n * USDC1, scoped: true }),
    20n * USDC1,
  );
  // wallet holds only 15.
  assert.equal(
    pot({ amount: 10n * USDC1, walletFree: 15n * USDC1, target: 100n * USDC1, scoped: true }),
    15n * USDC1,
  );
  // calendar cap leaves 12 beyond this call (the call itself already counted): the pot may hold
  // the call plus those 12, so the fill is 22.
  assert.equal(
    pot({ amount: 10n * USDC1, calendar: 12n * USDC1, target: 100n * USDC1, scoped: true }),
    22n * USDC1,
  );
  // Cannot cover the call: refused, no partial fill.
  assert.equal(
    pot({ amount: 30n * USDC1, allowanceLeft: 20n * USDC1, target: 100n * USDC1, scoped: true }),
    'over_limit',
  );
  assert.equal(
    pot({ amount: 30n * USDC1, walletFree: 20n * USDC1, target: 100n * USDC1, scoped: true }),
    'insufficient_funds',
  );
});

test('pot D2 default: unscoped calls keep today rule (quarter share), byte-identical numbers', () => {
  // Same inputs as the existing fixes test: default target, allowance 1 USDC, call 0.02.
  const today = floatTopUp({
    amount: 20_000n,
    floatFree: 0n,
    allowanceLeft: USDC1,
    walletFree: 10n * USDC1,
    calendar: null,
  });
  assert.equal(today, 265_000n);
  assert.equal(
    floatTopUp({
      amount: 20_000n,
      floatFree: 0n,
      allowanceLeft: USDC1,
      walletFree: 10n * USDC1,
      calendar: null,
      target: USDC1,
      scoped: false,
    }),
    265_000n,
  );
});

test('router 2 highest external (fee on top) price is 90.909091 USDC: total exactly 100 USDC', () => {
  assert.equal(MAX_LISTED_PRICE_ROUTER2, 90_909_091n);
  assert.equal(totalFor(KIND_EXTERNAL, MAX_LISTED_PRICE_ROUTER2), 100_000_000n);
  assert.ok(totalFor(KIND_EXTERNAL, MAX_LISTED_PRICE_ROUTER2 + 1n) > MAX_TOTAL_ROUTER2);
});

// The per-call maximum editor follows the agent's cap (0.10, or 100 USDC with router 2 on).
import { perCallMaxRaw as typedMax, perCallMaxRange } from '../src/feed/pay/payModel.js';

test('per-call maximum as typed: 0.10 USDC cap by default, 100 USDC with router 2 on', () => {
  assert.equal(typedMax('0.10'), '100000');
  assert.equal(typedMax('0.2'), null, 'above 0.10 by default');
  assert.equal(typedMax('50', '100000000'), '50000000');
  assert.equal(typedMax('100', '100000000'), '100000000');
  assert.equal(typedMax('100.000001', '100000000'), null);
  assert.match(perCallMaxRange(), /^Use an amount from 0\.000001 to 0\.1(0)? USDC\.$/);
  assert.match(perCallMaxRange('100000000'), /to 100(\.00)? USDC/);
});

test('router 2 external boundary calls approve only the fee and bind the quoted seller price', () => {
  const approvalAbi = [
    {
      type: 'function',
      name: 'approve',
      inputs: [{ type: 'address' }, { type: 'uint256' }],
      outputs: [{ type: 'bool' }],
      stateMutability: 'nonpayable',
    },
  ] as const;
  for (const gross of [90_910n, 9_090_909n, 90_909_091n]) {
    const quote = quoteFeeOnTop(gross, MAX_TOTAL_ROUTER2);
    const calls = feeCalls({
      usdc: USDC,
      router: ROUTER2,
      payee: PAYEE,
      quote,
      paymentIntentId: `external-${gross}`,
      maxTotal: MAX_TOTAL_ROUTER2,
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.to.toLowerCase(), USDC.toLowerCase());
    assert.equal(calls[1]!.to.toLowerCase(), ROUTER2.toLowerCase());
    assert.ok(calls.every((call) => call.value === 0n));
    const approval = decodeFunctionData({ abi: approvalAbi, data: calls[0]!.data });
    assert.equal(approval.args[0].toLowerCase(), ROUTER2.toLowerCase());
    assert.equal(approval.args[1], quote.fee);
    assert.notEqual(approval.args[1], gross);
    const charge = decodeFunctionData({ abi: FEE_ROUTER_ABI, data: calls[1]!.data });
    assert.equal(charge.functionName, 'chargeFee');
    assert.equal((charge.args![0] as string).toLowerCase(), PAYEE.toLowerCase());
    assert.equal(charge.args![1], gross);
    assert.throws(
      () =>
        feeCalls({
          usdc: USDC,
          router: ROUTER2,
          payee: PAYEE,
          quote: { ...quote, fee: quote.fee + 1n },
          paymentIntentId: 'tampered-fee',
          maxTotal: MAX_TOTAL_ROUTER2,
        }),
      /quote does not match/,
    );
  }
});
