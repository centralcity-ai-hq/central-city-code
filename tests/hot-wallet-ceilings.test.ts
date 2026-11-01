/*
 * Audit CCA-706: every app-held wallet has a stated hot-balance ceiling. Top-ups are sized to it
 * (clamped, or refused at the ceiling), and balance reads the app already makes log ALERT above
 * the ceiling or on an unplanned outflow. Fake keys and a fake chain only.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Database } from '../server/database.js';
import {
  DEFAULT_HOT_WALLET_CEILINGS,
  createHotWalletWatch,
  hotWalletCeilingsFromEnv,
  sizeTopUp,
  topUpFor,
} from '../server/base/chain/hot-wallets.js';
import { createRouter3Facilitator } from '../server/protocol/x402/facilitator.js';

const USDC = 1_000_000n;
const ETH = 10n ** 18n;

test('hot wallets: every app-held role has a stated ceiling; settings override it', () => {
  for (const role of [
    'sfp_sponsor',
    'router3_facilitator',
    'public_settle',
    'public_offer',
    'paymaster_submitter',
    'paymaster_signer',
  ] as const)
    assert.ok(DEFAULT_HOT_WALLET_CEILINGS[role].eth, `${role} has an ETH ceiling`);
  assert.equal(DEFAULT_HOT_WALLET_CEILINGS.sfp_sponsor.usdc!.ceiling, 500n * USDC);
  assert.equal(DEFAULT_HOT_WALLET_CEILINGS.paymaster_signer.eth!.ceiling, 0n, 'holds no funds');
  const ceilings = hotWalletCeilingsFromEnv({
    CITY_HOT_CEILING_SFP_SPONSOR_USDC: '250000000',
    CITY_HOT_OUTFLOW_SFP_SPONSOR_USDC: '50000000',
    CITY_HOT_CEILING_PUBLIC_SETTLE_ETH: 'lots',
  });
  assert.deepEqual(ceilings.sfp_sponsor.usdc, { ceiling: 250n * USDC, outflowPerHour: 50n * USDC });
  assert.deepEqual(
    ceilings.public_settle.eth,
    DEFAULT_HOT_WALLET_CEILINGS.public_settle.eth,
    'an unparsable value keeps the default',
  );
});

test('hot wallets: top-ups are clamped to the ceiling and refused at or above it', () => {
  assert.deepEqual(sizeTopUp(500n, 100n, 300n), { amount: 300n, clamped: false, refused: false });
  assert.deepEqual(sizeTopUp(500n, 100n, 7_400n), { amount: 400n, clamped: true, refused: false });
  assert.deepEqual(sizeTopUp(500n, 500n, 1n), { amount: 0n, clamped: true, refused: true });
  assert.deepEqual(sizeTopUp(500n, 900n, 0n), { amount: 0n, clamped: false, refused: true });
  assert.throws(() => sizeTopUp(500n, -1n, 1n));
  // The audit's single top-up of about 7,400 USDC to the sponsor: cut to the room under 500 USDC.
  const ceilings = hotWalletCeilingsFromEnv({});
  assert.deepEqual(topUpFor(ceilings, 'sfp_sponsor', 'usdc', 120n * USDC, 7_400n * USDC), {
    amount: 380n * USDC,
    clamped: true,
    refused: false,
  });
  // No stated ceiling (a facilitator's USDC), no top-up.
  assert.equal(topUpFor(ceilings, 'router3_facilitator', 'usdc', 0n, 1n).refused, true);
  assert.equal(topUpFor(ceilings, 'paymaster_signer', 'eth', 0n, ETH).refused, true);
});

test('hot wallets: ALERT above the ceiling and on outflow, at most once an hour each', () => {
  let now = 1_000_000;
  const lines: string[] = [];
  const watch = createHotWalletWatch({
    ceilings: hotWalletCeilingsFromEnv({}),
    log: (line) => lines.push(line),
    now: () => now,
  });
  watch.observe('sfp_sponsor', 'usdc', 400n * USDC);
  assert.deepEqual(lines, [], 'under the ceiling: quiet');
  watch.observe('sfp_sponsor', 'usdc', 28_700n * USDC);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /ALERT sfp_sponsor usdc balance 28700000000 above its ceiling 500000000/);
  now += 60_000;
  watch.observe('sfp_sponsor', 'usdc', 28_700n * USDC);
  assert.equal(lines.length, 1, 'repeated within the hour: one line');
  // Planned spending (under 100 USDC an hour) is quiet; a drain is not.
  now += 60_000;
  watch.observe('sfp_sponsor', 'usdc', 28_650n * USDC);
  assert.equal(lines.length, 1);
  now += 60_000;
  watch.observe('sfp_sponsor', 'usdc', 1n * USDC);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /ALERT sfp_sponsor usdc observed net balance decrease 28699000000 /);
  // Old decreases leave the window; the next read after more than an hour is stale, not ALERT.
  now += 3_600_001;
  assert.deepEqual(watch.observe('sfp_sponsor', 'usdc', 1n * USDC), {
    aboveCeiling: false,
    decreaseAlert: false,
    stale: true,
  });
  assert.equal(lines.length, 3);
  assert.doesNotMatch(lines[2], /ALERT/);
  assert.match(lines[2], /stale/);
  watch.observe('paymaster_signer', 'eth', 1n);
  assert.match(lines[3], /ALERT paymaster_signer eth balance 1 above its ceiling 0/);
  // A broken input never throws from the watch.
  watch.observe('public_settle', 'eth', 'x' as never);
});

/** A watch over the defaults (sponsor USDC: 500 USDC ceiling, 100 USDC planned decrease an hour). */
const watchAt = () => {
  const clock = { now: 5_000_000 };
  const lines: string[] = [];
  const watch = createHotWalletWatch({
    ceilings: hotWalletCeilingsFromEnv({}),
    log: (line) => lines.push(line),
    now: () => clock.now,
  });
  return { clock, lines, watch };
};

test('hot wallets: a decrease across a gap of more than an hour is stale, not an hourly ALERT', () => {
  const { clock, lines, watch } = watchAt();
  watch.observe('sfp_sponsor', 'usdc', 450n * USDC);
  // Three hours later 300 USDC less: 100 USDC an hour on average, charged to no single hour.
  clock.now += 3 * 3_600_000;
  const read = watch.observe('sfp_sponsor', 'usdc', 150n * USDC);
  assert.deepEqual(read, { aboveCeiling: false, decreaseAlert: false, stale: true });
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /ALERT/);
  assert.match(lines[0], /sfp_sponsor usdc previous read is 10800 s old \(stale\)/);
  // The stale read is the new baseline: a small decrease 10 minutes later is quiet.
  clock.now += 600_000;
  assert.equal(watch.observe('sfp_sponsor', 'usdc', 140n * USDC).decreaseAlert, false);
  assert.equal(lines.length, 1);
});

test('hot wallets: a top-up between reads is not spend and resets the baseline', () => {
  const { clock, lines, watch } = watchAt();
  watch.observe('sfp_sponsor', 'usdc', 100n * USDC);
  clock.now += 600_000;
  // Topped up to 400 USDC: an increase is never counted as negative spend.
  assert.deepEqual(watch.observe('sfp_sponsor', 'usdc', 400n * USDC), {
    aboveCeiling: false,
    decreaseAlert: false,
    stale: false,
  });
  clock.now += 600_000;
  // 60 USDC spent after the top-up: under the 100 USDC planned per hour.
  assert.equal(watch.observe('sfp_sponsor', 'usdc', 340n * USDC).decreaseAlert, false);
  assert.deepEqual(lines, []);
});

test('hot wallets: a decrease above plan within the hour ALERTs', () => {
  const { clock, lines, watch } = watchAt();
  watch.observe('sfp_sponsor', 'usdc', 450n * USDC);
  clock.now += 20 * 60_000;
  assert.equal(watch.observe('sfp_sponsor', 'usdc', 400n * USDC).decreaseAlert, false);
  clock.now += 20 * 60_000;
  const read = watch.observe('sfp_sponsor', 'usdc', 320n * USDC);
  assert.equal(read.decreaseAlert, true, '130 USDC within 40 minutes, plan 100 an hour');
  assert.equal(lines.length, 1);
  assert.match(
    lines[0],
    /^hot wallet: ALERT sfp_sponsor usdc observed net balance decrease 130000000 over 3600 s between reads, above its planned 100000000 per hour$/,
  );
});

test('hot wallets: decreases spanning more than an hour are rated per elapsed time', () => {
  const { clock, lines, watch } = watchAt();
  watch.observe('sfp_sponsor', 'usdc', 450n * USDC);
  // 59 minutes, then 59 more: 110 USDC over 118 minutes is about 56 an hour, under plan.
  clock.now += 59 * 60_000;
  watch.observe('sfp_sponsor', 'usdc', 395n * USDC);
  clock.now += 59 * 60_000;
  assert.equal(watch.observe('sfp_sponsor', 'usdc', 340n * USDC).decreaseAlert, false);
  assert.deepEqual(lines, []);
});

test('hot wallets: the facilitator reports every ETH balance read to the watch', async () => {
  const lines: string[] = [];
  const watch = createHotWalletWatch({
    ceilings: hotWalletCeilingsFromEnv({}),
    log: (line) => lines.push(line),
  });
  const account = privateKeyToAccount(generatePrivateKey());
  const facilitator = createRouter3Facilitator({
    db: { query: async () => ({ rows: [] }) } as unknown as Database,
    client: { getBalance: async () => 3n * ETH } as never,
    keystore: { withSigner: async (_ref, use) => use(account) },
    keyRef: 'v1:00000000-0000-0000-0000-000000000000',
    router: '0x0000000000000000000000000000000000000001',
    chainId: 8453,
    hotWallet: { role: 'public_settle', watch },
  });
  assert.equal(await facilitator.canPay(), true);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /ALERT public_settle eth balance 3000000000000000000 above its ceiling/);
});
