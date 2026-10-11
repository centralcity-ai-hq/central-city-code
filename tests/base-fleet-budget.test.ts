import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fleetBudgetFits,
  reserveFleetBudget,
  settleFleetBudget,
} from '../server/base/fleet/budget.js';

test('held uncertainty and fees both consume remaining run cap', () => {
  const principal = { cap: 100n, spent: 30n, held: 50n, requested: 20n };
  const fee = { cap: 10n, spent: 3n, held: 5n, requested: 2n };
  assert.equal(fleetBudgetFits([principal, fee]), true);
  assert.equal(fleetBudgetFits([{ ...principal, requested: 21n }, fee]), false);
  assert.equal(fleetBudgetFits([principal, { ...fee, requested: 3n }]), false);
  assert.equal(fleetBudgetFits([{ ...principal, spent: 101n }]), false);
  assert.equal(fleetBudgetFits([{ ...principal, held: 71n }]), false);
});

test('uint256 bounds and values beyond Number precision fail closed or remain exact', () => {
  const huge = (1n << 255n) + 1n;
  assert.equal(fleetBudgetFits([{ cap: huge, spent: huge - 2n, held: 1n, requested: 1n }]), true);
  assert.equal(fleetBudgetFits([{ cap: huge, spent: huge - 2n, held: 1n, requested: 2n }]), false);
  assert.equal(fleetBudgetFits([]), false);
  for (const field of ['cap', 'spent', 'held', 'requested']) {
    for (const value of [-1n, 1n << 256n, NaN, 1, undefined]) {
      const line = { cap: 10n, spent: 0n, held: 0n, requested: 1n, [field]: value };
      assert.equal(fleetBudgetFits([line as never]), false);
    }
  }
});

test('settling one batch preserves other holds and charges actual cost only', () => {
  const before = { cap: 100n, spent: 20n, held: 70n };
  assert.deepEqual(settleFleetBudget(before, 30n, 17n), { cap: 100n, spent: 37n, held: 40n });
  assert.deepEqual(settleFleetBudget(before, 30n, 0n), { cap: 100n, spent: 20n, held: 40n });
  assert.deepEqual(before, { cap: 100n, spent: 20n, held: 70n });
  const max = (1n << 256n) - 1n;
  assert.deepEqual(settleFleetBudget({ cap: max, spent: max - 7n, held: 7n }, 7n, 7n), {
    cap: max,
    spent: max,
    held: 0n,
  });
});

test('settlement refuses excess charges and corrupt balances without freeing holds', () => {
  const balance = { cap: 100n, spent: 20n, held: 70n };
  for (const [reserved, actual] of [
    [30n, 31n],
    [71n, 0n],
    [-1n, 0n],
    [1n, -1n],
  ])
    assert.throws(() => settleFleetBudget(balance, reserved, actual));
  assert.throws(() => settleFleetBudget({ ...balance, spent: 31n }, 30n, 0n));
  assert.throws(() => settleFleetBudget(balance, 1 as never, 0n));
  assert.deepEqual(balance, { cap: 100n, spent: 20n, held: 70n });
});

test('new holds count against available cap until definitively settled', () => {
  const original = { cap: 100n, spent: 20n, held: 40n };
  const held = reserveFleetBudget(original, 40n);
  assert.deepEqual(held, { cap: 100n, spent: 20n, held: 80n });
  assert.throws(() => reserveFleetBudget(held, 1n));
  const settled = settleFleetBudget(held, 40n, 30n);
  assert.deepEqual(reserveFleetBudget(settled, 10n), { cap: 100n, spent: 50n, held: 50n });
  assert.throws(() => reserveFleetBudget(settled, 11n));
  assert.deepEqual(original, { cap: 100n, spent: 20n, held: 40n });
});
