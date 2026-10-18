import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  parseAbi,
  stringToHex,
  type Hex,
} from 'viem';
import {
  FEE_ROUTER_ABI,
  feeCalls,
  feeEventsOf,
  feeMatches,
  FeeQuoteError,
  feeRef,
  MAX_LISTED_PRICE,
  MAX_TOTAL,
  MIN_INCLUDED,
  payCalls,
  quoteFeeIncluded,
  quoteFeeOnTop,
  settlementMatches,
} from '../server/protocol/fees/fee-call.js';

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Hex;
const USDC = addr(0xc0);
const ROUTER = addr(0x40);
const PAYER = addr(0xa1);
const SELLER = addr(0x5e);

test('quote: listed + 10% fee, floor rounding, total capped at $0.10 including the fee', () => {
  assert.deepEqual(quoteFeeOnTop(90_000n), { gross: 90_000n, fee: 9_000n, total: 99_000n });
  assert.deepEqual(quoteFeeOnTop(19n), { gross: 19n, fee: 1n, total: 20n });
  assert.equal(MAX_LISTED_PRICE, 90_909n);
  assert.deepEqual(quoteFeeOnTop(90_909n), { gross: 90_909n, fee: 9_090n, total: 99_999n });
  const code = (p: bigint) => {
    try {
      quoteFeeOnTop(p);
      return 'OK';
    } catch (e) {
      return (e as FeeQuoteError).code;
    }
  };
  assert.equal(code(90_910n), 'OVER_CAP');
  assert.equal(code(MAX_TOTAL), 'OVER_CAP');
  assert.equal(code(9n), 'FEE_ZERO');
  assert.equal(code(0n), 'INVALID_PRICE');
  assert.equal(code(-5n), 'INVALID_PRICE');
});

test('fee calls: exact-fee approve to the router, then chargeFee with the intent ref', () => {
  const quote = quoteFeeOnTop(50_000n);
  const calls = feeCalls({
    usdc: USDC,
    router: ROUTER,
    payee: SELLER,
    quote,
    paymentIntentId: 'pi_1',
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].to.toLowerCase(), USDC);
  const approve = decodeFunctionData({
    abi: parseAbi(['function approve(address spender, uint256 value) returns (bool)']),
    data: calls[0].data,
  });
  assert.deepEqual([approve.args[0].toLowerCase(), approve.args[1]], [ROUTER, 5_000n]);
  assert.equal(calls[1].to.toLowerCase(), ROUTER);
  const charge = decodeFunctionData({ abi: FEE_ROUTER_ABI, data: calls[1].data });
  assert.equal(charge.functionName, 'chargeFee');
  assert.deepEqual(
    [String(charge.args[0]).toLowerCase(), charge.args[1], charge.args[2]],
    [SELLER, 50_000n, keccak256(stringToHex('pi_1'))],
  );
  assert.ok(calls.every((c) => c.value === 0n));
});

test('fee calls refuse a tampered quote', () => {
  assert.throws(
    () =>
      feeCalls({
        usdc: USDC,
        router: ROUTER,
        payee: SELLER,
        quote: { gross: 50_000n, fee: 1n, total: 50_001n },
        paymentIntentId: 'pi_2',
      }),
    FeeQuoteError,
  );
  assert.throws(() => feeRef(''));
});

test('a fee is confirmed only when every field of the event matches the call', () => {
  const quote = quoteFeeOnTop(60_000n);
  const expected = {
    chainId: 84532,
    router: ROUTER,
    payer: PAYER,
    payee: SELLER,
    quote,
    paymentIntentId: 'pi_3',
  };
  const event = {
    chainId: 84532,
    emitter: ROUTER,
    payer: PAYER,
    payee: SELLER,
    ref: feeRef('pi_3'),
    kind: 0,
    gross: 60_000n,
    fee: 6_000n,
  };
  assert.equal(feeMatches(event, expected), true);
  const changed: Partial<typeof event>[] = [
    { chainId: 8453 },
    { emitter: addr(0x41) },
    { payer: addr(0xa2) },
    { payee: addr(0x5f) },
    { ref: feeRef('pi_other') },
    { kind: 1 },
    { gross: 59_999n },
    { fee: 5_999n },
  ];
  for (const change of changed)
    assert.equal(
      feeMatches({ ...event, ...change }, expected),
      false,
      JSON.stringify(change, (_, v) => (typeof v === 'bigint' ? String(v) : v)),
    );
});

test('fee included: the price split as router.pay does it, within MIN_INCLUDED and MAX_TOTAL', () => {
  assert.equal(MIN_INCLUDED, 50_000n);
  assert.deepEqual(quoteFeeIncluded(50_000n), { gross: 50_000n, fee: 5_000n, net: 45_000n });
  assert.deepEqual(quoteFeeIncluded(99_999n), { gross: 99_999n, fee: 9_999n, net: 90_000n });
  assert.deepEqual(quoteFeeIncluded(MAX_TOTAL), { gross: 100_000n, fee: 10_000n, net: 90_000n });
  const code = (p: bigint) => {
    try {
      quoteFeeIncluded(p);
      return 'OK';
    } catch (e) {
      return (e as FeeQuoteError).code;
    }
  };
  assert.equal(code(49_999n), 'INVALID_PRICE');
  assert.equal(code(10_000n), 'INVALID_PRICE', 'a $0.01 price is below the router minimum');
  assert.equal(code(100_001n), 'OVER_CAP');
  assert.equal(code(0n), 'INVALID_PRICE');
});

test('fee included: one operation, approve(router, price) then router.pay(payee, price, ref)', () => {
  const quote = quoteFeeIncluded(70_000n);
  const calls = payCalls({
    usdc: USDC,
    router: ROUTER,
    payee: SELLER,
    quote,
    paymentIntentId: 'fc_1',
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].to.toLowerCase(), USDC);
  const approve = decodeFunctionData({
    abi: parseAbi(['function approve(address spender, uint256 value) returns (bool)']),
    data: calls[0].data,
  });
  assert.deepEqual([approve.args[0].toLowerCase(), approve.args[1]], [ROUTER, 70_000n]);
  assert.equal(calls[1].to.toLowerCase(), ROUTER);
  const pay = decodeFunctionData({ abi: FEE_ROUTER_ABI, data: calls[1].data });
  assert.equal(pay.functionName, 'pay');
  assert.deepEqual(
    [String(pay.args[0]).toLowerCase(), pay.args[1], pay.args[2]],
    [SELLER, 70_000n, keccak256(stringToHex('fc_1'))],
  );
  assert.throws(
    () =>
      payCalls({
        usdc: USDC,
        router: ROUTER,
        payee: SELLER,
        quote: { gross: 70_000n, fee: 6_999n, net: 63_001n },
        paymentIntentId: 'fc_1',
      }),
    FeeQuoteError,
  );
});

test('fee included: FeeCharged kind 1 matches only with every field, and only from the router', () => {
  const quote = quoteFeeIncluded(80_000n);
  const expected = {
    chainId: 8453,
    router: ROUTER,
    payer: PAYER,
    payee: SELLER,
    quote,
    paymentIntentId: 'fc_2',
    kind: 1 as const,
  };
  const log = (emitter: Hex, kind: number, gross: bigint, fee: bigint) => ({
    address: emitter,
    topics: encodeEventTopics({
      abi: FEE_ROUTER_ABI,
      eventName: 'FeeCharged',
      args: { payer: PAYER, payee: SELLER, ref: feeRef('fc_2') },
    }) as Hex[],
    data: encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }],
      [kind, gross, fee],
    ),
  });
  const events = feeEventsOf(8453, ROUTER, [
    log(ROUTER, 1, 80_000n, 8_000n),
    log(addr(0x41), 1, 80_000n, 8_000n),
    { address: USDC, topics: [], data: '0x' },
  ]);
  assert.equal(events.length, 1, 'only the router’s FeeCharged');
  assert.equal(feeMatches(events[0]!, expected), true);
  assert.equal(feeMatches(events[0]!, { ...expected, kind: 0 }), false);
  assert.equal(feeMatches({ ...events[0]!, kind: 0 }, expected), false);
  assert.equal(feeMatches({ ...events[0]!, gross: 88_000n }, expected), false);
  assert.equal(feeMatches({ ...events[0]!, payee: addr(0x5f) }, expected), false);
});

test('seller settlement: success, exact payer -> payee transfer of gross, and the call nonce used', () => {
  const abi = parseAbi([
    'event Transfer(address indexed from, address indexed to, uint256 value)',
    'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  ]);
  const nonce = keccak256(stringToHex('nonce-1'));
  const t = (from: Hex, to: Hex, value: bigint, address: Hex = USDC) => ({
    address,
    topics: encodeEventTopics({ abi, eventName: 'Transfer', args: { from, to } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
  });
  const u = (authorizer: Hex, n: Hex, address: Hex = USDC) => ({
    address,
    topics: encodeEventTopics({
      abi,
      eventName: 'AuthorizationUsed',
      args: { authorizer, nonce: n },
    }) as Hex[],
    data: '0x' as Hex,
  });
  const expected = {
    usdc: USDC,
    payer: PAYER,
    payee: SELLER,
    gross: 90_000n,
    authorizationNonce: nonce,
  };
  const good = [u(PAYER, nonce), t(PAYER, SELLER, 90_000n)];
  assert.equal(settlementMatches({ status: 'success', logs: good }, expected), true);
  assert.equal(settlementMatches({ status: 'reverted', logs: good }, expected), false);
  for (const logs of [
    [u(PAYER, nonce), t(PAYER, SELLER, 89_999n)], // wrong amount
    [u(PAYER, nonce), t(PAYER, addr(0x5f), 90_000n)], // wrong seller
    [u(PAYER, nonce), t(addr(0xa2), SELLER, 90_000n)], // wrong payer
    [u(PAYER, keccak256(stringToHex('other'))), t(PAYER, SELLER, 90_000n)], // other authorization
    [t(PAYER, SELLER, 90_000n)], // plain transfer, no authorization
    [u(PAYER, nonce, addr(0xbad)), t(PAYER, SELLER, 90_000n, addr(0xbad))], // not USDC
  ])
    assert.equal(settlementMatches({ status: 'success', logs }, expected), false);
});
