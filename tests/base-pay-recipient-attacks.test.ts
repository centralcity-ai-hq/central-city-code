import assert from 'node:assert/strict';
import test from 'node:test';
import { getAddress } from 'viem';
import { parseRecipient, PAY_QUERY_MAX } from '../shared/base/pay.js';

test('recipient links reject deceptive authorities and noncanonical paths', () => {
  const bad = [
    'centralcity.ai.evil.com/a/abcdef',
    'evil.com/centralcity.ai/a/abcdef',
    'https://centralcity.ai@evil.com/a/abcdef',
    'https://evil.com@centralcity.ai/a/abcdef',
    'centralcity.ai:443/a/abcdef',
    'centralcity.ai./a/abcdef',
    'centrаlcity.ai/a/abcdef',
    'centralcity.aі/a/abcdef',
    'xn--centralcity-9jg.ai/a/abcdef',
    'XN--CENTRALCITY-9JG.AI/a/abcdef',
    'http://centralcity.ai/a/abcdef',
    'javascript:centralcity.ai/a/abcdef',
    '//centralcity.ai/a/abcdef',
    'centralcity.ai/a/abcdef?q=1',
    'centralcity.ai/a/abcdef#x',
    'centralcity.ai/a/abcdef/',
    'centralcity.ai//a/abcdef',
    'centralcity.ai/a/%2Fabcde',
    'centralcity.ai/a/abc def',
    'centralcity.ai/a/abc\u200bdef',
    'centralcity.ai/a/abc\0def',
    'x'.repeat(PAY_QUERY_MAX + 1),
  ];
  for (const input of bad) assert.deepEqual(parseRecipient(input), [], input);
});

test('canonical link casing preserves case-sensitive passport identity', () => {
  for (const input of [
    'https://centralcity.ai/a/Ab3dE6',
    'HTTPS://CENTRALCITY.AI/a/Ab3dE6',
    ' centralcity.ai/a/Ab3dE6 ',
  ])
    assert.deepEqual(parseRecipient(input), [{ kind: 'short', short: 'Ab3dE6' }]);
  assert.deepEqual(parseRecipient('centralcity.ai/A/Ab3dE6'), []);
});

test('numeric ambiguity is preserved without interpreting numeric syntax', () => {
  assert.deepEqual(parseRecipient('123456'), [
    { kind: 'baseId', baseId: '123456' },
    { kind: 'short', short: '123456' },
  ]);
  assert.deepEqual(parseRecipient('000001'), [{ kind: 'short', short: '000001' }]);
  for (const input of ['01', '+1', '1e3', '0x10', '-1', '9'.repeat(79)])
    assert.deepEqual(parseRecipient(input), [], input);
  assert.deepEqual(parseRecipient('Pinakο'), []); // Greek omicron, not a passport or name lookup.
});

test('address parsing enforces shape and checksum without URL interpretation', () => {
  const lower = '0x52908400098527886e0f7030069857d2e4169ee7';
  assert.deepEqual(parseRecipient(lower), [{ kind: 'address', address: getAddress(lower) }]);
  assert.deepEqual(parseRecipient('0x52908400098527886E0F7030069857D2E4169Ee7'), []);
  for (const input of [`0x${'1'.repeat(39)}`, `0x${'1'.repeat(41)}`, `0X${'1'.repeat(40)}`])
    assert.deepEqual(parseRecipient(input), [], input);
  // The parser recognizes the address form; lookup must refuse this non-agent address.
  assert.deepEqual(parseRecipient(`0x${'0'.repeat(40)}`), [
    { kind: 'address', address: `0x${'0'.repeat(40)}` },
  ]);
});

test('hostile queries reach neither storage nor network through the real lookup route', async (t) => {
  const { default: Fastify } = await import('fastify');
  const { createPayService } = await import('../server/base/pay/service.js');
  const { registerPayRoutes } = await import('../server/base/pay/routes.js');
  let reads = 0;
  const db = {
    query: async () => {
      reads++;
      throw new Error('Unexpected storage read');
    },
  };
  const service = createPayService({
    db: db as never,
    withdrawals: {} as never,
    anyAddress: () => false,
  });
  const app = Fastify();
  t.after(() => app.close());
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetches++;
    throw new Error('Unexpected fetch');
  });
  registerPayRoutes(app, {
    enabled: () => true,
    person: async () => ({ ok: true, accountId: 'owner' }),
    service,
  });
  for (const query of [
    'https://centralcity.ai@evil.example/a/abcdef',
    'https://centralcity.ai.evil.example/a/abcdef',
    'https://centralcity.ai/a/%2Fabcde',
    'Pinakο',
    'abc\u200bdef',
    'abc\0def',
    'x'.repeat(PAY_QUERY_MAX + 1),
  ]) {
    const response = await app.inject({
      url: `/api/base/pay/recipient?q=${encodeURIComponent(query)}`,
    });
    assert.equal(response.statusCode, 400, query);
    assert.equal(response.json().code, 'invalid_query', query);
  }
  assert.equal(reads, 0);
  assert.equal(fetches, 0);
});
