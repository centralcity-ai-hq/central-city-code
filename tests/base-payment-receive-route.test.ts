import assert from 'node:assert/strict';
import test from 'node:test';
import { createReceiveRoute } from '../server/base/payments/receive-route.js';
import { BASE_NETWORKS, BASE_SEPOLIA } from '../shared/base/chains.js';
import type { VerifyResult } from '../server/base/chain/x402-facilitator.js';

test('receive route is hidden by default and only challenges authorized visible resources', async () => {
  let authCalls = 0;
  let workspace: string | null = 'one';
  let visible = true;
  let verifies = 0;
  let runs = 0;
  let verification: VerifyResult = { kind: 'valid', payer: null };
  let throws = false;
  let paid = false;
  let chainId: number = BASE_SEPOLIA;
  let existing = false;
  let failedClaim = false;
  const transaction = `0x${'5'.repeat(64)}` as const;
  const env = {} as { CITY_BASE_X402_RECEIVE?: string };
  const url = 'https://centralcity.ai/configured-resource';
  const route = createReceiveRoute({
    env,
    resourceUrl: url,
    find: async () =>
      existing
        ? { receiptId: 'receipt', acquired: false, state: 'reconciling', transaction }
        : null,
    authenticate: async () => {
      authCalls++;
      return workspace;
    },
    resolveResource: async () =>
      visible
        ? {
            price: '10',
            chainId,
            token: BASE_NETWORKS[BASE_SEPOLIA].tokens.USDC.address,
            recipient: `0x${'2'.repeat(40)}`,
          }
        : null,
    facilitator: {
      verify: async () => {
        verifies++;
        if (throws) throw new Error('private-provider-detail');
        return verification;
      },
      settle: async () => ({ kind: 'unknown' }),
    },
    run: async (binding, _settle, reconcileOnly) => {
      assert.equal(reconcileOnly, existing);
      assert.equal(binding.validBefore, '100', 'the deadline is stored for reconciliation');
      runs++;
      if (failedClaim) return { kind: 'failed', receiptId: 'receipt' };
      if (paid)
        return { kind: 'paid', receiptId: 'receipt', transaction, value: { content: 'paid' } };
      return { kind: 'pending', receiptId: 'receipt' };
    },
  });
  const request = (header?: string) =>
    new Request('https://untrusted.invalid/?secret=ignored', {
      headers: header ? { 'PAYMENT-SIGNATURE': header } : {},
    });
  assert.equal((await route(request(), 'resource')).status, 404);
  assert.equal(authCalls, 0);
  env.CITY_BASE_X402_RECEIVE = '1';
  workspace = null;
  assert.equal((await route(request(), 'resource')).status, 401);
  workspace = 'one';
  visible = false;
  assert.equal((await route(request(), 'resource')).status, 404);
  visible = true;
  const challenge = await route(request(), 'resource');
  assert.equal(challenge.status, 402);
  assert.equal(challenge.headers.get('cache-control'), 'no-store');
  const body = await challenge.json();
  assert.equal(body.resource.url, url);
  assert.deepEqual(
    JSON.parse(Buffer.from(challenge.headers.get('PAYMENT-REQUIRED')!, 'base64').toString()),
    body,
  );
  assert.equal((await route(request('invalid'), 'resource')).status, 400);
  assert.equal(verifies, 0);
  assert.equal(runs, 0);
  const payment = {
    x402Version: 2,
    accepted: body.accepts[0],
    payload: {
      signature: '0x1234',
      authorization: {
        from: `0x${'3'.repeat(40)}`,
        to: body.accepts[0].payTo,
        value: '10',
        validAfter: '1',
        validBefore: '100',
        nonce: `0x${'4'.repeat(64)}`,
      },
    },
  };
  const response = await route(
    request(Buffer.from(JSON.stringify(payment)).toString('base64')),
    'resource',
  );
  assert.equal(response.status, 202);
  assert.equal(verifies, 1);
  assert.equal(runs, 1);
  assert.deepEqual(await response.json(), { state: 'pending', receiptId: 'receipt' });
  const encoded = Buffer.from(JSON.stringify(payment)).toString('base64');
  for (const result of [
    { kind: 'unknown' },
    { kind: 'invalid', reason: 'private-provider-detail' },
    { kind: 'valid', payer: `0x${'6'.repeat(40)}` },
  ] as VerifyResult[]) {
    verification = result;
    const rejected = await route(request(encoded), 'resource');
    assert.equal(rejected.status, result.kind === 'unknown' ? 503 : 400);
    assert.equal((await rejected.text()).includes('private-provider-detail'), false);
    assert.equal(runs, 1);
  }
  throws = true;
  const failed = await route(request(encoded), 'resource');
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: 'UNAVAILABLE' });
  assert.equal(runs, 1);
  throws = false;
  verification = { kind: 'valid', payer: null };
  chainId = 8453;
  assert.equal((await route(request(encoded), 'resource')).status, 503);
  assert.equal(runs, 1);
  chainId = BASE_SEPOLIA;
  paid = true;
  const success = await route(request(encoded), 'resource');
  assert.equal(success.status, 200);
  assert.deepEqual(await success.json(), { content: 'paid' });
  assert.deepEqual(
    JSON.parse(Buffer.from(success.headers.get('PAYMENT-RESPONSE')!, 'base64').toString()),
    {
      success: true,
      transaction,
      network: 'eip155:84532',
      payer: payment.payload.authorization.from,
    },
  );
  assert.equal((await route(new Request(url, { method: 'POST' }), 'resource')).status, 405);
  failedClaim = true;
  const offeredAgain = await route(request(encoded), 'resource');
  assert.equal(offeredAgain.status, 402, 'an unusable authorization is asked for again');
  assert.deepEqual(await offeredAgain.json(), body);
  assert.ok(offeredAgain.headers.get('PAYMENT-REQUIRED'));
  failedClaim = false;
  existing = true;
  throws = true;
  const beforeReplay = verifies;
  assert.equal((await route(request(encoded), 'resource')).status, 200);
  assert.equal(verifies, beforeReplay, 'stored claim recovery bypasses expired/consumed verifier');
});
