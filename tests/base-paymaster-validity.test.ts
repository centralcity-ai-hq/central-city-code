import assert from 'node:assert/strict';
import test from 'node:test';
import { sponsoredWithinDeadline, SPONSOR_DATA_BYTES } from '../shared/base/paymasters.js';
import type { Address } from '../shared/base/chains.js';
import type { RpcUserOperation } from '../shared/base/withdraw.js';
import { checkSigningWindow } from '../src/base/wallet/withdraw.js';

const address = `0x${'12'.repeat(20)}` as Address;
const sponsors = { 84532: [address] };
const now = 1_800_000_000_123;
const deadline = now + 600_000;
const seconds = Math.floor(now / 1000);
function data(until: number, after = seconds - 1): string {
  const uint48 = (n: number) => n.toString(16).padStart(12, '0');
  return address + uint48(until) + uint48(after) + '00'.repeat(SPONSOR_DATA_BYTES - 32);
}
const check = (value: string | undefined, at = now, end = deadline) =>
  sponsoredWithinDeadline(84532, value, { now: at, deadline: end }, sponsors);

test('browser rechecks the fixed sponsorship window after an asynchronous unlock', () => {
  const request = {
    lanes: true,
    chainId: 84532,
    expiresAt: deadline,
    userOperation: { paymasterAndData: data(seconds + 60) } as RpcUserOperation,
  };
  assert.doesNotThrow(() => checkSigningWindow(request, now, sponsors));
  assert.throws(() => checkSigningWindow(request, now + 61_000, sponsors));
  assert.throws(() => checkSigningWindow({ ...request, expiresAt: null }, now, sponsors));
  assert.doesNotThrow(() =>
    checkSigningWindow({ ...request, lanes: false }, now + 61_000, sponsors),
  );
});

test('accepts only a currently valid sponsorship bounded by the original deadline', () => {
  assert.equal(check(data(seconds + 600)), true);
  assert.equal(check(data(seconds + 601)), false);
  assert.equal(check(data(seconds)), false);
  assert.equal(check(data(0)), false);
  assert.equal(check(data(2 ** 48 - 1)), false);
  assert.equal(check(data(seconds + 600, seconds + 1)), false);
  assert.equal(check(data(seconds + 600, seconds + 600)), false);
  assert.equal(check(data(seconds + 600), now + 500_000), true);
  assert.equal(check(data(seconds + 601), now + 500_000), false, 'retry cannot extend expiry');
  assert.equal(check(data(seconds + 600), (seconds + 600) * 1000), false);
});

test('requires exact pinned token-free data and valid clock inputs', () => {
  for (const value of [
    undefined,
    '0x',
    data(seconds + 600).slice(0, -2),
    data(seconds + 600) + '00',
  ])
    assert.equal(check(value), false);
  const value = data(seconds + 600);
  assert.equal(check('0x' + '34'.repeat(20) + value.slice(42)), false);
  const tokenOffset = 2 + 51 * 2;
  assert.equal(check(value.slice(0, tokenOffset) + '01' + value.slice(tokenOffset + 2)), false);
  for (const invalid of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(check(value, invalid), false);
    assert.equal(check(value, now, invalid), false);
  }
  assert.equal(check(value, now, now), false);
});
