import assert from 'node:assert/strict';
import test from 'node:test';
import { fleetWindowOpen } from '../server/base/fleet/window.js';

test('reservation window expires while waiting for a transaction lock', () => {
  assert.equal(fleetWindowOpen(10, 20, 19_999), true);
  assert.equal(fleetWindowOpen(10, 20, 20_000), false);
  assert.equal(fleetWindowOpen(10, 20, 20_001), false);
  assert.equal(fleetWindowOpen(10, 20, 9_999), false);
  assert.equal(fleetWindowOpen(10, 20, 10_000), true);
});

test('reservation window fails closed on invalid clocks and signed timestamps', () => {
  for (const value of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(fleetWindowOpen(10, 20, value), false);
    assert.equal(fleetWindowOpen(value, 20, 15_000), false);
    assert.equal(fleetWindowOpen(10, value, 15_000), false);
  }
  assert.equal(fleetWindowOpen(20, 20, 20_000), false);
  assert.equal(fleetWindowOpen(21, 20, 20_000), false);
  assert.equal(
    fleetWindowOpen(Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    false,
  );
});
