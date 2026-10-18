import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, type Hex } from 'viem';
import {
  chargeCall,
  ESCROW_ABI,
  COLLECTOR_CONTRACT_ADDRESS,
  ESCROW_CONTRACT_ADDRESS,
  MIN_PRICE,
  payerAgnosticHash,
  paymentInfoHash,
  paymentTerms,
  PaymentTermsError,
  receiveAuthorization,
} from '../server/protocol/fees/escrow-operator.js';

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Hex;
const base = {
  operator: addr(0x0b),
  payer: addr(0xa1),
  seller: addr(0x5e),
  usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Hex,
  treasury: addr(0x7e),
  price: 80_000n,
  paymentIntentId: 'pi_e1',
  issuedAt: 1_791_936_000n,
};

test('terms: exact 10% bounds, treasury as fee receiver, price from $0.05 to $0.10', () => {
  const info = paymentTerms(base);
  assert.deepEqual([info.minFeeBps, info.maxFeeBps], [1000, 1000]);
  assert.equal(info.feeReceiver.toLowerCase(), base.treasury);
  assert.equal(info.maxAmount, 80_000n);
  assert.ok(info.preApprovalExpiry <= info.authorizationExpiry);
  assert.ok(info.authorizationExpiry <= info.refundExpiry);
  assert.equal(paymentTerms(base).salt, info.salt, 'a retry makes the same terms');
  const code = (over: Partial<typeof base>) => {
    try {
      paymentTerms({ ...base, ...over });
      return 'OK';
    } catch (e) {
      return (e as PaymentTermsError).code;
    }
  };
  assert.equal(code({ price: MIN_PRICE }), 'OK');
  assert.equal(code({ price: MIN_PRICE - 1n }), 'BELOW_MINIMUM');
  assert.equal(code({ price: 100_000n }), 'OK');
  assert.equal(code({ price: 100_001n }), 'OVER_CAP');
  assert.equal(code({ seller: base.payer }), 'BAD_PARTY');
  assert.equal(code({ treasury: base.seller }), 'BAD_PARTY');
  assert.equal(code({ paymentIntentId: '' }), 'BAD_TIME');
});

test('the payer signs ReceiveWithAuthorization to the collector with the payer-agnostic hash', () => {
  const info = paymentTerms(base);
  const msg = receiveAuthorization(84532, info);
  assert.equal(msg.message.to, COLLECTOR_CONTRACT_ADDRESS);
  assert.equal(msg.message.value, 80_000n);
  assert.equal(msg.message.nonce, payerAgnosticHash(84532, ESCROW_CONTRACT_ADDRESS, info));
  assert.notEqual(msg.message.nonce, paymentInfoHash(84532, ESCROW_CONTRACT_ADDRESS, info));
  // Any change to a term changes the nonce, so an old signature cannot authorize new terms.
  for (const change of [
    { receiver: addr(0x5f) },
    { feeReceiver: addr(0x7f) },
    { maxAmount: 80_001n },
    { minFeeBps: 0 },
  ])
    assert.notEqual(
      payerAgnosticHash(84532, ESCROW_CONTRACT_ADDRESS, { ...info, ...change }),
      msg.message.nonce,
    );
  assert.notEqual(payerAgnosticHash(8453, ESCROW_CONTRACT_ADDRESS, info), msg.message.nonce);
});

test('charge: full price, fee exactly 10% to the treasury, through the collector', () => {
  const info = paymentTerms(base);
  const call = chargeCall(info, '0x1234');
  assert.equal(call.to, ESCROW_CONTRACT_ADDRESS);
  const decoded = decodeFunctionData({ abi: ESCROW_ABI, data: call.data });
  assert.equal(decoded.functionName, 'charge');
  const [, amount, collector, signature, fee, receiver] = decoded.args as unknown as [
    unknown,
    bigint,
    Hex,
    Hex,
    bigint,
    Hex,
  ];
  assert.deepEqual(
    [amount, collector, signature, fee, receiver.toLowerCase()],
    [80_000n, COLLECTOR_CONTRACT_ADDRESS, '0x1234', 8_000n, base.treasury],
  );
  assert.throws(() => chargeCall({ ...info, maxFeeBps: 2000 }, '0x'), PaymentTermsError);
  assert.throws(() => chargeCall({ ...info, maxAmount: 1n }, '0x'), PaymentTermsError);
});

test('the payer signs in the token’s own domain: "USD Coin" on Base mainnet, "USDC" on Base Sepolia', () => {
  const sepolia = receiveAuthorization(84532, paymentTerms(base));
  assert.equal(sepolia.domain.name, 'USDC');
  const mainnet = receiveAuthorization(
    8453,
    paymentTerms({ ...base, usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }),
  );
  assert.equal(mainnet.domain.name, 'USD Coin');
  assert.equal(mainnet.domain.version, '2');
  // A token without a domain on that chain is refused, never signed with a guessed name.
  assert.throws(() => receiveAuthorization(8453, paymentTerms(base)), PaymentTermsError);
});

test('terms are retry-stable: the same intent and issue time make the same hash and nonce', () => {
  const a = paymentTerms(base);
  const b = paymentTerms({ ...base });
  assert.equal(
    paymentInfoHash(84532, ESCROW_CONTRACT_ADDRESS, a),
    paymentInfoHash(84532, ESCROW_CONTRACT_ADDRESS, b),
  );
  const later = paymentTerms({ ...base, issuedAt: base.issuedAt + 1n });
  assert.notEqual(
    paymentInfoHash(84532, ESCROW_CONTRACT_ADDRESS, a),
    paymentInfoHash(84532, ESCROW_CONTRACT_ADDRESS, later),
    'a different issue time is a different payment, so callers must pass the stored one',
  );
});
