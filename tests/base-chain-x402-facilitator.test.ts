import assert from 'node:assert/strict';
import test from 'node:test';
import type { Hex } from 'viem';
import { BASE_SEPOLIA, baseNetwork } from '../shared/base/chains.js';
import {
  caip2,
  exactPaymentPayload,
  facilitatorClient,
  FacilitatorError,
  type PaymentRequirements,
} from '../server/base/chain/x402-facilitator.js';
import type { IssuedAuthorization } from '../server/base/chain/x402.js';

const network = baseNetwork(BASE_SEPOLIA)!;
const usdc = network.tokens.USDC;
const payTo = `0x${'2'.repeat(40)}` as Hex;
const issued: IssuedAuthorization = {
  paymentIntentId: 'intent-1',
  chainId: BASE_SEPOLIA,
  token: usdc.address,
  authorization: {
    from: `0x${'1'.repeat(40)}`,
    to: payTo,
    value: 10_000n,
    validAfter: 0n,
    validBefore: 2_000_000_000n,
    nonce: `0x${'ab'.repeat(32)}`,
  },
  signature: `0x${'cd'.repeat(80)}`,
};
const requirements: PaymentRequirements = {
  scheme: 'exact',
  network: caip2(BASE_SEPOLIA),
  amount: '10000',
  asset: usdc.address,
  payTo,
  maxTimeoutSeconds: 60,
  extra: {
    assetTransferMethod: 'eip3009',
    name: usdc.eip712!.name,
    version: usdc.eip712!.version,
  },
};

test('payload: the stored authorization, unchanged, in the v2 exact shape', () => {
  const p = exactPaymentPayload(network, requirements, issued);
  assert.equal(p.x402Version, 2);
  assert.deepEqual(p.accepted, requirements);
  assert.equal(p.payload.signature, issued.signature);
  assert.deepEqual(p.payload.authorization, {
    from: issued.authorization.from,
    to: issued.authorization.to,
    value: '10000',
    validAfter: '0',
    validBefore: '2000000000',
    nonce: issued.authorization.nonce,
  });
});

test('payload: anything that does not match exactly is refused before sending', () => {
  const refused = (r: Partial<PaymentRequirements>, code: string) =>
    assert.throws(
      () => exactPaymentPayload(network, { ...requirements, ...r }, issued),
      (e: unknown) => e instanceof FacilitatorError && e.code === code,
    );
  refused({ scheme: 'upto' }, 'UNSUPPORTED_SCHEME');
  refused({ extra: { assetTransferMethod: 'permit2' } }, 'UNSUPPORTED_METHOD');
  refused({ extra: { assetTransferMethod: 'erc7710' } }, 'UNSUPPORTED_METHOD');
  refused({ network: caip2(8453) }, 'WRONG_NETWORK');
  refused({ asset: `0x${'9'.repeat(40)}` }, 'TOKEN_NOT_ALLOWED');
  refused({ asset: network.tokens.ETH.address }, 'TOKEN_NOT_ALLOWED');
  refused({ amount: '10001' }, 'REQUIREMENTS_MISMATCH');
  refused({ amount: '1e4' }, 'REQUIREMENTS_MISMATCH');
  refused({ payTo: `0x${'3'.repeat(40)}` }, 'REQUIREMENTS_MISMATCH');
  refused(
    { extra: { assetTransferMethod: 'eip3009', name: 'Other', version: '2' } },
    'REQUIREMENTS_MISMATCH',
  );
});

/** A facilitator stub answering with a fixed JSON body (or failing). */
function stub(answer: unknown | Error) {
  const seen: { path: string; body: unknown }[] = [];
  const fetchStub = (async (url: string, init: RequestInit) => {
    seen.push({ path: new URL(url).pathname, body: JSON.parse(String(init.body)) });
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify(answer), {
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return {
    seen,
    client: facilitatorClient({ url: 'https://fac.example.test/x402/', fetch: fetchStub }),
  };
}

test('verify and settle send the v2 request body to the right paths', async () => {
  const payload = exactPaymentPayload(network, requirements, issued);
  const { seen, client } = stub({ isValid: true, payer: issued.authorization.from });
  assert.deepEqual(await client.verify(payload, requirements), {
    kind: 'valid',
    payer: issued.authorization.from,
  });
  assert.equal(seen[0].path, '/x402/verify');
  assert.deepEqual(seen[0].body, {
    x402Version: 2,
    paymentPayload: payload,
    paymentRequirements: requirements,
  });
  const tx = `0x${'ee'.repeat(32)}`;
  const settled = stub({ success: true, transaction: tx, network: caip2(BASE_SEPOLIA) });
  assert.deepEqual(await settled.client.settle(payload, requirements), {
    kind: 'settled',
    transaction: tx,
  });
  assert.equal(settled.seen[0].path, '/x402/settle');
});

test('settlement_pending keeps the broadcast transaction; it is never a refusal', async () => {
  const tx = `0x${'aa'.repeat(32)}`;
  const { client } = stub({ success: false, errorReason: 'settlement_pending', transaction: tx });
  assert.deepEqual(await client.settle({}, requirements), { kind: 'pending', transaction: tx });
  // Pending without its transaction cannot be reconciled: unknown, still not a refusal.
  const noTx = stub({ success: false, errorReason: 'settlement_pending', transaction: '' });
  assert.deepEqual(await noTx.client.settle({}, requirements), { kind: 'unknown' });
});

test('refusals carry safe reasons; failures and odd answers are unknown, never refused', async () => {
  const refused = stub({ success: false, errorReason: 'insufficient_funds', transaction: '' });
  assert.deepEqual(await refused.client.settle({}, requirements), {
    kind: 'refused',
    reason: 'insufficient_funds',
  });
  const invalid = stub({ isValid: false, invalidReason: 'invalid_signature' });
  assert.deepEqual(await invalid.client.verify({}, requirements), {
    kind: 'invalid',
    reason: 'invalid_signature',
  });
  for (const answer of [new Error('socket hang up'), { nonsense: true }, { success: true }]) {
    assert.deepEqual(await stub(answer).client.settle({}, requirements), { kind: 'unknown' });
  }
  assert.deepEqual(await stub(new Error('timeout')).client.verify({}, requirements), {
    kind: 'unknown',
  });
});

test('provider reasons cannot echo credentials or payloads into results', async () => {
  for (const reason of [
    'https://example.invalid/private-key?payload=private-payment',
    'invalid_signature private-payment',
    'insufficient_funds\nprivate-payment',
    'new_provider_reason',
    { secret: 'private-payment' },
    null,
  ]) {
    assert.deepEqual(
      await stub({ isValid: false, invalidReason: reason }).client.verify({}, requirements),
      {
        kind: 'invalid',
        reason: 'unspecified',
      },
    );
    assert.deepEqual(
      await stub({ success: false, errorReason: reason }).client.settle({}, requirements),
      {
        kind: 'refused',
        reason: 'unspecified',
      },
    );
  }
});
