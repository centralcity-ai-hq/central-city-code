import assert from 'node:assert/strict';
import test from 'node:test';
import {
  sponsoredValidUntil,
  MAX_EXPIRY_SKEW_MS,
  sponsoredWithinDeadline,
  SPONSOR_DATA_BYTES,
} from '../shared/base/paymasters.js';
import type { Address } from '../shared/base/chains.js';
import type { RpcUserOperation } from '../shared/base/withdraw.js';
import {
  checkSigningWindow,
  SIGNING_CLOCK_BEHIND,
  SIGNING_CLOCK_SKEW_MS,
  SIGNING_WINDOW_EXPIRED,
} from '../src/base/wallet/withdraw.js';

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
  // Expired by Base's clock but within a fast device's tolerance: the server decides.
  assert.doesNotThrow(() => checkSigningWindow(request, now + 61_000, sponsors));
  assert.throws(() => checkSigningWindow(request, now + 61_000 + SIGNING_CLOCK_SKEW_MS, sponsors));
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

test('sponsoredValidUntil reads the signed validUntil in ms, or null when there is none', () => {
  assert.equal(sponsoredValidUntil(data(seconds + 90)), (seconds + 90) * 1000);
  // The same field the deadline check reads: valid until exactly then, and not from then on.
  const until = sponsoredValidUntil(data(seconds + 90))!;
  assert.equal(check(data(seconds + 90), until - 1, until), true);
  assert.equal(check(data(seconds + 90), until, until), false);
  assert.equal(sponsoredValidUntil(data(0)), null);
  // Beyond a safe integer of milliseconds: never taken as a time.
  assert.equal(sponsoredValidUntil(data(2 ** 48 - 1)), null);
  assert.equal(sponsoredValidUntil(undefined), null);
  assert.equal(sponsoredValidUntil('0x'), null);
  assert.equal(sponsoredValidUntil(data(seconds + 90).slice(0, -2)), null);
  assert.equal(sponsoredValidUntil(`${data(seconds + 90).slice(0, -2)}zz`), null);
});

test('the browser tolerates a device clock up to a minute fast; the deadline stays the bound', () => {
  // Sponsorship valid for ~2 minutes from prepare, as measured on mainnet.
  const request = {
    lanes: true,
    chainId: 84532,
    expiresAt: now + 120_000,
    userOperation: { paymasterAndData: data(seconds + 120) } as RpcUserOperation,
  };
  // A device 90 s fast signs 40 s after prepare: Base says 40 s, the device says 130 s.
  assert.doesNotThrow(() => checkSigningWindow(request, now + 130_000, sponsors));
  // 60 s fast, right at the end of the real window: still within the tolerance.
  assert.doesNotThrow(() => checkSigningWindow(request, now + 119_000 + 60_000, sponsors));
  // More than a minute past the deadline by this clock: refused as expired.
  assert.throws(
    () => checkSigningWindow(request, now + 120_000 + SIGNING_CLOCK_SKEW_MS, sponsors),
    { message: SIGNING_WINDOW_EXPIRED },
  );
  // The tolerance never lets validUntil pass the server's deadline.
  assert.throws(
    () =>
      checkSigningWindow(
        {
          ...request,
          userOperation: { paymasterAndData: data(seconds + 121) } as RpcUserOperation,
        },
        now,
        sponsors,
      ),
    { message: SIGNING_WINDOW_EXPIRED },
  );
});

test('a slow device clock is not tolerated: it is told its clock is behind', () => {
  // Prepared at `now` on the server, validAfter = now; this device runs 30 s behind.
  const request = {
    lanes: true,
    chainId: 84532,
    expiresAt: now + 120_000,
    userOperation: { paymasterAndData: data(seconds + 120, seconds) } as RpcUserOperation,
  };
  assert.throws(() => checkSigningWindow(request, now - 30_000, sponsors), {
    message: SIGNING_CLOCK_BEHIND,
  });
  // Far behind (validAfter more than a minute ahead): a plain refusal.
  assert.throws(() => checkSigningWindow(request, now - 61_000 - 1_000, sponsors), {
    message: SIGNING_WINDOW_EXPIRED,
  });
  assert.doesNotThrow(() => checkSigningWindow(request, now, sponsors));
});

test('the expiry skew is bounded and leaves validAfter strict', () => {
  const value = data(seconds + 600);
  const at = (now0: number, expirySkewMs?: number, after = seconds - 1) =>
    sponsoredWithinDeadline(
      84532,
      data(seconds + 600, after),
      { now: now0, deadline, expirySkewMs },
      sponsors,
    );
  assert.equal(at(now + 600_000), false, 'no skew: expired');
  assert.equal(at(now + 600_000, 60_000), true, 'fast clock within the skew');
  assert.equal(at(now + 660_000, 60_000), false, 'beyond the skew');
  assert.equal(at(now, 60_000, seconds + 1), false, 'validAfter in the future stays refused');
  for (const bad of [-1, 0.5, MAX_EXPIRY_SKEW_MS + 1, NaN])
    assert.equal(at(now, bad), false, String(bad));
  assert.equal(at(now, MAX_EXPIRY_SKEW_MS), true);
  assert.equal(check(value), true, 'the server path (no skew) is unchanged');
});
