import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeAbiParameters, encodeEventTopics, getAddress, parseAbiItem, type Hex } from 'viem';
import { router3OwnTransfers } from '../server/feed/pay/router3.js';

const CHAIN = 8453;
const ROUTER = getAddress(`0x${'e8'.repeat(20)}`) as Hex;
const USDC = getAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913') as Hex;
const PAYER = getAddress(`0x${'11'.repeat(20)}`) as Hex;
const PAYEE = getAddress(`0x${'22'.repeat(20)}`) as Hex;
const TREASURY = getAddress(`0x${'af'.repeat(20)}`) as Hex;
const transfer = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);
const authUsed = parseAbiItem(
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
);
const feeCharged = parseAbiItem(
  'event FeeCharged(address indexed payer, address indexed payee, bytes32 indexed ref, uint8 kind, uint256 gross, uint256 fee)',
);
const ref = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;

const t = (to: Hex, value: bigint) => ({
  address: USDC,
  topics: encodeEventTopics({
    abi: [transfer],
    eventName: 'Transfer',
    args: { from: PAYER, to },
  }) as Hex[],
  data: encodeAbiParameters([{ type: 'uint256' }], [value]),
});
const au = (n: number) => ({
  address: USDC,
  topics: encodeEventTopics({
    abi: [authUsed],
    eventName: 'AuthorizationUsed',
    args: { authorizer: PAYER, nonce: ref(1000 + n) },
  }) as Hex[],
  data: '0x' as Hex,
});
const fc = (r: Hex, gross: bigint) => ({
  address: ROUTER,
  topics: encodeEventTopics({
    abi: [feeCharged],
    eventName: 'FeeCharged',
    args: { payer: PAYER, payee: PAYEE, ref: r },
  }) as Hex[],
  data: encodeAbiParameters(
    [{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }],
    [1, gross, gross / 10n],
  ),
});
/** One settlement as router 3 emits it on Base. */
const settled = (r: Hex, gross: bigint, n: number) => [
  au(2 * n),
  t(PAYEE, gross - gross / 10n),
  au(2 * n + 1),
  t(TREASURY, gross / 10n),
  fc(r, gross),
];

test('two identical buys in one settleBatch each see only their own two legs', () => {
  // Same payer, payee and price; only the ref differs (the identical pair from the review).
  const logs = [...settled(ref(1), 2_830_000n, 0), ...settled(ref(2), 2_830_000n, 1)];
  for (const r of [ref(1), ref(2)]) {
    const own = router3OwnTransfers(logs, {
      chainId: CHAIN,
      router: ROUTER,
      usdc: USDC,
      payer: PAYER,
      ref: r,
    });
    assert.ok(own);
    assert.equal(own.length, 2);
    assert.equal(own.filter((x) => getAddress(x.to) === PAYEE && x.value === 2_547_000n).length, 1);
    assert.equal(
      own.filter((x) => getAddress(x.to) === TREASURY && x.value === 283_000n).length,
      1,
    );
  }
});

test('a single settle receipt reads exactly as before; a missing FeeCharged is null', () => {
  const logs = settled(ref(5), 1_000_000n, 0);
  const own = router3OwnTransfers(logs, {
    chainId: CHAIN,
    router: ROUTER,
    usdc: USDC,
    payer: PAYER,
    ref: ref(5),
  });
  assert.equal(own?.length, 2);
  assert.equal(
    router3OwnTransfers(logs, {
      chainId: CHAIN,
      router: ROUTER,
      usdc: USDC,
      payer: PAYER,
      ref: ref(6),
    }),
    null,
  );
});

test('a leg dropped from one payment is not borrowed from its neighbour', () => {
  const first = settled(ref(1), 2_000_000n, 0);
  const second = settled(ref(2), 2_000_000n, 1).filter((_, i) => i !== 3); // no fee leg
  const own = router3OwnTransfers([...first, ...second], {
    chainId: CHAIN,
    router: ROUTER,
    usdc: USDC,
    payer: PAYER,
    ref: ref(2),
  });
  assert.equal(
    own?.length,
    1,
    'only its own seller leg; the first payment fee leg is outside its slice',
  );
});
