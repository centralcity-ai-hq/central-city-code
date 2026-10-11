import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReceivePayload } from '../server/base/payments/receive-payload.js';

test('receive payload bounds and binds server requirements without forwarding unchecked fields', () => {
  const requirements = {
    scheme: 'exact',
    network: 'eip155:84532',
    amount: '10',
    asset: `0x${'1'.repeat(40)}`,
    payTo: `0x${'2'.repeat(40)}`,
    maxTimeoutSeconds: 60,
    extra: { name: 'USDC', version: '2' },
  };
  const url = 'https://centralcity.ai/resource';
  const payment = {
    x402Version: 2,
    accepted: requirements,
    payload: {
      signature: '0x1234',
      authorization: {
        from: `0x${'3'.repeat(40)}`,
        to: requirements.payTo,
        value: '10',
        validAfter: '1',
        validBefore: '100',
        nonce: `0x${'4'.repeat(64)}`,
      },
    },
  };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
  const parse = (value: unknown) => parseReceivePayload(encode(value), requirements, url);
  const valid = parse(payment);
  assert.ok(valid);
  requirements.extra.name = 'changed';
  assert.equal(valid.accepted.extra.name, 'USDC');
  requirements.extra.name = 'USDC';
  for (const change of [
    { network: 'eip155:8453' },
    { amount: '11' },
    { maxTimeoutSeconds: 61 },
    { asset: payment.payload.authorization.from },
    { payTo: payment.payload.authorization.from },
    { extra: { name: 'USDC', version: '2', assetTransferMethod: 'permit2' } },
  ])
    assert.equal(parse({ ...payment, accepted: { ...requirements, ...change } }), null);
  for (const change of [
    { value: '11' },
    { to: payment.payload.authorization.from },
    { validAfter: '100' },
    { validBefore: '-1' },
    { value: (1n << 256n).toString() },
    { nonce: '0x12' },
  ])
    assert.equal(
      parse({
        ...payment,
        payload: {
          ...payment.payload,
          authorization: { ...payment.payload.authorization, ...change },
        },
      }),
      null,
    );
  assert.equal(parse({ ...payment, resource: { url: 'https://untrusted.invalid' } }), null);
  assert.equal(parse({ ...payment, extensions: { unknown: {} } }), null);
  assert.equal(parse({ ...payment, secret: 'must not forward' }), null);
  for (const header of ['', '!!!!', 'a'.repeat(32772), encode(payment) + '\n'])
    assert.equal(parseReceivePayload(header, requirements, url), null);
});
