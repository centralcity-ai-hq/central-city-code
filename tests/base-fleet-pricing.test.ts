import assert from 'node:assert/strict';
import test from 'node:test';
import { fleetProviderFee, snapshotFleetPricing } from '../server/base/fleet/pricing.js';

test('persisted pricing preserves markup rounding and fixed costs across config changes', () => {
  const saved = JSON.parse(JSON.stringify(snapshotFleetPricing('test-v1:700:3')));
  const changed = snapshotFleetPricing('test-v2:0:0');
  assert.equal(fleetProviderFee(1n, saved.version, saved.terms), 5n);
  assert.equal(fleetProviderFee(100n, saved.version, saved.terms), 110n);
  assert.equal(fleetProviderFee(100n, changed.version, changed.terms), 100n);
  assert.equal(fleetProviderFee(100n, saved.version, saved.terms), 110n);
});

test('corrupt persisted pricing and oversized amounts fail closed', () => {
  for (const terms of [
    null,
    {},
    { markupBps: -1, fixedPerOpWei: '0' },
    { markupBps: 0.5, fixedPerOpWei: '0' },
    { markupBps: 700, fixedPerOpWei: '01' },
    { markupBps: 700, fixedPerOpWei: 0 },
  ])
    assert.throws(() => fleetProviderFee(1n, 'test-v1', terms));
  const saved = snapshotFleetPricing('test-v1:700:0');
  assert.throws(() => fleetProviderFee(-1n, saved.version, saved.terms));
  assert.throws(() => fleetProviderFee((1n << 256n) - 1n, saved.version, saved.terms));
});
