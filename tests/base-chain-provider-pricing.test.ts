import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseProviderPricing,
  PricingError,
  providerBoundWei,
} from '../server/base/chain/provider-pricing.js';

test('pricing setting: required, strict, versioned', () => {
  assert.deepEqual(parseProviderPricing('2026-10-08:700:0'), {
    version: '2026-10-08',
    markupBps: 700,
    fixedPerOpWei: 0n,
  });
  for (const missing of [undefined, ''])
    assert.throws(
      () => parseProviderPricing(missing),
      (e: unknown) => e instanceof PricingError && e.code === 'PRICING_MISSING',
    );
  for (const bad of ['700', 'v1:7.5:0', 'v1:-1:0', 'v1:10001:0', 'v 1:1:0', 'v1:1:0x10'])
    assert.throws(
      () => parseProviderPricing(bad),
      (e: unknown) => e instanceof PricingError && e.code === 'PRICING_MALFORMED',
      bad,
    );
});

test('total bound: markup rounded up, fixed charge added, never below the on-chain bound', () => {
  const pricing = parseProviderPricing('v1:700:5');
  assert.equal(providerBoundWei(10_000n, pricing), 10_000n + 700n + 5n);
  // 1 wei at 7 % is 0.07 wei → rounds up to 1, never down to 0.
  assert.equal(providerBoundWei(1n, pricing), 1n + 1n + 5n);
  assert.equal(providerBoundWei(0n, parseProviderPricing('v1:0:0')), 0n);
  for (let n = 0n; n < 2_000n; n += 37n)
    assert.ok(providerBoundWei(n, pricing) * 10_000n >= n * 10_700n);
});
