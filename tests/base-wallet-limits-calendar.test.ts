import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  concat,
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbiParameters,
  toHex,
  type Hex,
  type PublicClient,
} from 'viem';
import type { Database } from '../server/database.js';
import {
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  BASE_SHARED_ADDITIONS_SQL,
  BASE_WALLET_LIMITS_SQL,
} from '../server/base/schema.js';
import { createPaymentChain, PaymentChainError } from '../server/base/chain/payment-chain.js';
import { FEED_PAY_FEE_SQL } from '../server/feed/pay/fee-schema.js';
import { FEED_PAY_SQL } from '../server/feed/pay/schema.js';
import { createReservationLedger } from '../server/base/chain/reservations.js';
import {
  assertWithinCalendarLimit,
  CalendarLimitError,
  calendarSpent,
} from '../server/base/chain/calendar-limit.js';
import type { ChainOperationStore, StoredOperation } from '../server/base/chain/submit.js';
import type { Address } from '../shared/base/chains.js';
import { SPONSOR_PAYMASTERS } from '../shared/base/paymasters.js';
import { WALLET_CHAIN_ID as CHAIN_ID } from '../shared/base/wallet-network.js';
import { WALLET_EXPECTED, WALLET_NET } from './wallet-network-fixture.js';
import type { SpendPermission } from '../shared/base/types.js';
import {
  LIMIT_PERMISSION_END,
  berlinDate,
  berlinDayStart,
  berlinMidnight,
  calendarPeriod,
  limitPeriodOf,
  nextBerlinMidnight,
  onchainAllowance,
  onchainCapModel,
  permissionFromJson,
  permissionToJson,
  spendPermissionHash,
  type OnchainCapModel,
} from '../shared/base/spend-limits.js';

/** The wallet network (shared/base/wallet-network.ts): Base Sepolia or Base. */
const NETWORK = WALLET_NET;
const USDC = NETWORK.tokens.USDC.address;
const utc = (...parts: [number, number, number, number?, number?]) =>
  Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3] ?? 0, parts[4] ?? 0) / 1000;
const HOUR = 3600;
const DAY = 86_400;

test('Berlin midnight and the next one, in summer, in winter and on both DST switches', () => {
  // CEST (UTC+2) and CET (UTC+1).
  assert.equal(berlinMidnight(2026, 10, 11), utc(2026, 10, 10, 22));
  assert.equal(berlinMidnight(2026, 12, 1), utc(2026, 11, 30, 23));
  // The night of a switch: midnight still exists exactly once.
  assert.equal(berlinMidnight(2026, 10, 25), utc(2026, 10, 24, 22));
  assert.equal(berlinMidnight(2026, 10, 26), utc(2026, 10, 25, 23));
  assert.equal(berlinMidnight(2027, 3, 28), utc(2027, 3, 27, 23));
  assert.equal(berlinMidnight(2027, 3, 29), utc(2027, 3, 28, 22));
  // Overflowing dates roll over (month 13, day 32).
  assert.equal(berlinMidnight(2026, 13, 1), utc(2026, 12, 31, 23));
  assert.equal(berlinMidnight(2026, 10, 32), utc(2026, 10, 31, 23));

  // The next midnight is strictly after now.
  assert.equal(nextBerlinMidnight(utc(2026, 10, 10, 12) * 1000), utc(2026, 10, 10, 22));
  assert.equal(nextBerlinMidnight(utc(2026, 10, 10, 22) * 1000), utc(2026, 10, 11, 22));
  assert.equal(nextBerlinMidnight((utc(2026, 10, 10, 22) - 1) * 1000), utc(2026, 10, 10, 22));
  // During the repeated hour of 25 Oct (02:00-03:00 twice) and after the switch.
  assert.equal(nextBerlinMidnight(utc(2026, 10, 25, 0, 30) * 1000), utc(2026, 10, 25, 23));
  assert.equal(nextBerlinMidnight(utc(2026, 10, 25, 1, 30) * 1000), utc(2026, 10, 25, 23));
  // Around the skipped hour of 28 Mar 2027.
  assert.equal(nextBerlinMidnight(utc(2027, 3, 28, 0, 59) * 1000), utc(2027, 3, 28, 22));
  assert.equal(nextBerlinMidnight(utc(2027, 3, 28, 1, 1) * 1000), utc(2027, 3, 28, 22));
  assert.deepEqual(berlinDate(utc(2026, 10, 25, 22, 30) * 1000), {
    year: 2026,
    month: 10,
    day: 25,
    weekday: 7,
  });
});

test('the start of the Berlin day (a new limit’s start): at or before now, across both DST switches', () => {
  // 14:00 CEST and 14:00 CET: the midnight that began the day.
  assert.equal(berlinDayStart(utc(2026, 10, 10, 12) * 1000), utc(2026, 10, 9, 22));
  assert.equal(berlinDayStart(utc(2026, 11, 14, 13) * 1000), utc(2026, 11, 13, 23));
  // At midnight itself it is that midnight; a second before, the previous one.
  assert.equal(berlinDayStart(utc(2026, 10, 10, 22) * 1000), utc(2026, 10, 10, 22));
  assert.equal(berlinDayStart(utc(2026, 10, 10, 22) * 1000 - 1), utc(2026, 10, 9, 22));
  assert.equal(berlinDayStart((utc(2026, 10, 10, 22) - 1) * 1000), utc(2026, 10, 9, 22));
  // 25 Oct 2026, the 25-hour day: 00:30 CEST, 02:30 CEST and 02:30 CET (the repeated hour),
  // noon and 23:30 CET all began at 00:00 CEST.
  for (const at of [
    utc(2026, 10, 24, 22, 30),
    utc(2026, 10, 25, 0, 30),
    utc(2026, 10, 25, 1, 30),
    utc(2026, 10, 25, 12),
    utc(2026, 10, 25, 22, 30),
  ])
    assert.equal(
      berlinDayStart(at * 1000),
      utc(2026, 10, 24, 22),
      new Date(at * 1000).toISOString(),
    );
  // The day after starts at 00:00 CET (23:00 UTC): 25 hours after the one before.
  assert.equal(berlinDayStart(utc(2026, 10, 25, 23) * 1000), utc(2026, 10, 25, 23));
  assert.equal(utc(2026, 10, 25, 23) - utc(2026, 10, 24, 22), 25 * HOUR);
  // 28 Mar 2027, the 23-hour day: around the skipped hour (02:00 CET jumps to 03:00 CEST).
  assert.equal(berlinDayStart(utc(2027, 3, 28, 0, 59) * 1000), utc(2027, 3, 27, 23));
  assert.equal(berlinDayStart(utc(2027, 3, 28, 1, 1) * 1000), utc(2027, 3, 27, 23));
  assert.equal(berlinDayStart(utc(2027, 3, 28, 21, 59) * 1000), utc(2027, 3, 27, 23));
  assert.equal(berlinDayStart(utc(2027, 3, 28, 22) * 1000), utc(2027, 3, 28, 22));
  // The other last Sundays: 29 Mar 2026 (23 hours, began at 00:00 CET) and 31 Oct 2027 (25 hours,
  // began at 00:00 CEST; its repeated hour 02:00-03:00 is 00:00-01:00 and 01:00-02:00 UTC).
  for (const at of [utc(2026, 3, 28, 23), utc(2026, 3, 29, 0, 59), utc(2026, 3, 29, 1, 1)])
    assert.equal(berlinDayStart(at * 1000), utc(2026, 3, 28, 23));
  assert.equal(berlinDayStart(utc(2026, 3, 29, 22) * 1000), utc(2026, 3, 29, 22));
  for (const at of [utc(2027, 10, 30, 22), utc(2027, 10, 31, 0, 30), utc(2027, 10, 31, 1, 30)])
    assert.equal(berlinDayStart(at * 1000), utc(2027, 10, 30, 22));
  assert.equal(berlinDayStart(utc(2027, 10, 31, 22, 59) * 1000), utc(2027, 10, 30, 22));
  assert.equal(berlinDayStart(utc(2027, 10, 31, 23) * 1000), utc(2027, 10, 31, 23));
  assert.equal(utc(2026, 3, 29, 22) - utc(2026, 3, 28, 23), 23 * HOUR);
  assert.equal(utc(2027, 10, 31, 23) - utc(2027, 10, 30, 22), 25 * HOUR);
  // The year end and a leap day.
  assert.equal(berlinDayStart(utc(2027, 1, 1, 0, 30) * 1000), utc(2026, 12, 31, 23));
  assert.equal(berlinDayStart(utc(2028, 2, 29, 12) * 1000), utc(2028, 2, 28, 23));
  // Always the calendar day's start, never after now, at most 25 hours before it, on a whole hour,
  // and the next midnight is where the day ends.
  for (let ms = Date.UTC(2026, 9, 1); ms < Date.UTC(2028, 0, 1); ms += 3 * 3_600_000 + 7 * 60_000) {
    const start = berlinDayStart(ms);
    assert.equal(start, calendarPeriod('day', ms).start);
    assert.ok(start * 1000 <= ms);
    assert.ok(ms - start * 1000 < 25 * HOUR * 1000);
    assert.equal(start % HOUR, 0);
    assert.equal(nextBerlinMidnight(ms), calendarPeriod('day', ms).end);
  }
});

test('Berlin calendar days: 25 hours on 25 Oct 2026, 23 hours on 28 Mar 2027', () => {
  const autumn = calendarPeriod('day', utc(2026, 10, 25, 12) * 1000);
  assert.deepEqual(autumn, { start: utc(2026, 10, 24, 22), end: utc(2026, 10, 25, 23) });
  assert.equal(autumn.end - autumn.start, 25 * HOUR);
  // 23:30 CET on 25 Oct is still the 25th; 00:00 CET on the 26th is the next day.
  assert.deepEqual(calendarPeriod('day', utc(2026, 10, 25, 22, 30) * 1000), autumn);
  assert.equal(calendarPeriod('day', utc(2026, 10, 25, 23) * 1000).start, utc(2026, 10, 25, 23));
  const spring = calendarPeriod('day', utc(2027, 3, 28, 12) * 1000);
  assert.deepEqual(spring, { start: utc(2027, 3, 27, 23), end: utc(2027, 3, 28, 22) });
  assert.equal(spring.end - spring.start, 23 * HOUR);
  // An ordinary day is 24 hours.
  const plain = calendarPeriod('day', utc(2026, 10, 10, 12) * 1000);
  assert.equal(plain.end - plain.start, DAY);
});

test('Berlin calendar weeks start on Monday and stretch or shrink with DST', () => {
  // Sunday 25 Oct 2026 belongs to the week of Monday 19 Oct (CEST) until Monday 26 Oct (CET).
  const autumn = calendarPeriod('week', utc(2026, 10, 25, 12) * 1000);
  assert.deepEqual(autumn, { start: utc(2026, 10, 18, 22), end: utc(2026, 10, 25, 23) });
  assert.equal(autumn.end - autumn.start, 7 * DAY + HOUR);
  // Monday 00:30 is the new week; Sunday 23:30 is the old one.
  assert.equal(
    calendarPeriod('week', utc(2026, 10, 25, 23, 30) * 1000).start,
    utc(2026, 10, 25, 23),
  );
  assert.equal(
    calendarPeriod('week', utc(2026, 10, 25, 22, 30) * 1000).start,
    utc(2026, 10, 18, 22),
  );
  // The spring week of 22-28 Mar 2027 is an hour short.
  const spring = calendarPeriod('week', utc(2027, 3, 24, 12) * 1000);
  assert.deepEqual(spring, { start: utc(2027, 3, 21, 23), end: utc(2027, 3, 28, 22) });
  assert.equal(spring.end - spring.start, 7 * DAY - HOUR);
  // A week across a month and a year end.
  assert.deepEqual(calendarPeriod('week', utc(2027, 1, 1, 12) * 1000), {
    start: utc(2026, 12, 27, 23),
    end: utc(2027, 1, 3, 23),
  });
  // Monday itself starts its week.
  assert.equal(calendarPeriod('week', utc(2026, 10, 12, 8) * 1000).start, utc(2026, 10, 11, 22));
});

test('Berlin calendar months: from the 1st, across DST, February and the year end', () => {
  // October 2026 has 31 days and gains an hour: 1 Oct 00:00 CEST to 1 Nov 00:00 CET.
  const october = calendarPeriod('month', utc(2026, 10, 31, 22, 59) * 1000);
  assert.deepEqual(october, { start: utc(2026, 9, 30, 22), end: utc(2026, 10, 31, 23) });
  assert.equal(october.end - october.start, 31 * DAY + HOUR);
  // One second later it is November.
  assert.equal(calendarPeriod('month', utc(2026, 10, 31, 23) * 1000).start, utc(2026, 10, 31, 23));
  assert.deepEqual(calendarPeriod('month', utc(2027, 2, 14) * 1000), {
    start: utc(2027, 1, 31, 23),
    end: utc(2027, 2, 28, 23),
  });
  // March 2027 loses an hour.
  const march = calendarPeriod('month', utc(2027, 3, 15) * 1000);
  assert.equal(march.end - march.start, 31 * DAY - HOUR);
  assert.deepEqual(calendarPeriod('month', utc(2026, 12, 31, 22, 59) * 1000), {
    start: utc(2026, 11, 30, 23),
    end: utc(2026, 12, 31, 23),
  });
  // The on-chain month is a fixed 31 days; the calendar month is the server's own counter.
  assert.equal(limitPeriodOf(2_678_400), 'month');
  assert.equal(limitPeriodOf(86_400), 'day');
  assert.equal(limitPeriodOf(604_800), 'week');
  assert.equal(limitPeriodOf(86_401), null);
});

test('the on-chain model: half by default, full only when set exactly', () => {
  assert.equal(onchainCapModel(undefined), 'half');
  assert.equal(onchainCapModel(''), 'half');
  assert.equal(onchainCapModel('FULL'), 'half');
  assert.equal(onchainCapModel('full'), 'full');
  assert.equal(onchainAllowance(20_000_000n, 'half'), 10_000_000n);
  assert.equal(onchainAllowance(20_000_001n, 'half'), 10_000_000n);
  assert.equal(onchainAllowance(1n, 'half'), 0n);
  assert.equal(onchainAllowance(20_000_000n, 'full'), 20_000_000n);
  // Half: the burst around a reset (one allowance before, one after) never exceeds the cap.
  for (const cap of [2n, 3n, 19_999_999n, 20_000_000n])
    assert.ok(onchainAllowance(cap, 'half') * 2n <= cap);
});

const permission = (overrides: Partial<SpendPermission> = {}): SpendPermission => ({
  account: getAddress(`0x${'1'.repeat(40)}`),
  spender: getAddress(`0x${'3'.repeat(40)}`),
  token: getAddress(USDC),
  allowance: 10_000_000n,
  period: 86_400,
  start: utc(2026, 10, 10, 22),
  end: LIMIT_PERMISSION_END,
  salt: 2n ** 255n + 12345n,
  extraData: '0x',
  ...overrides,
});

test('the permission hash is SpendPermissionManager.getHash, written out as the contract does', () => {
  const p = permission();
  const typehash = keccak256(
    toHex(
      'SpendPermission(address account,address spender,address token,uint160 allowance,uint48 period,uint48 start,uint48 end,uint256 salt,bytes extraData)',
    ),
  );
  const structHash = keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        'bytes32, address, address, address, uint160, uint48, uint48, uint48, uint256, bytes32',
      ),
      [
        typehash,
        p.account,
        p.spender,
        p.token,
        p.allowance,
        p.period,
        p.start,
        p.end,
        p.salt,
        keccak256(p.extraData),
      ],
    ),
  );
  const domainSeparator = keccak256(
    encodeAbiParameters(parseAbiParameters('bytes32, bytes32, bytes32, uint256, address'), [
      keccak256(
        toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
      ),
      keccak256(toHex('Spend Permission Manager')),
      keccak256(toHex('1')),
      BigInt(WALLET_EXPECTED.chainId),
      NETWORK.contracts.spendPermissionManager,
    ]),
  );
  assert.equal(
    spendPermissionHash(CHAIN_ID, p),
    keccak256(concat(['0x1901', domainSeparator, structHash])),
  );
  // Any field changes the hash.
  assert.notEqual(
    spendPermissionHash(CHAIN_ID, permission({ allowance: 1n })),
    spendPermissionHash(CHAIN_ID, p),
  );
});

test('a permission comes back from JSON only exactly as it was sent', () => {
  const p = permission();
  const json = JSON.parse(JSON.stringify(permissionToJson(p)));
  assert.deepEqual(permissionFromJson(json), p);
  assert.equal(permissionFromJson({ ...json, extra: 1 }), null);
  assert.equal(permissionFromJson({ ...json, allowance: 10 }), null);
  assert.equal(permissionFromJson({ ...json, allowance: '010' }), null);
  assert.equal(permissionFromJson({ ...json, period: 2 ** 48 }), null);
  assert.equal(permissionFromJson({ ...json, start: 1.5 }), null);
  assert.equal(permissionFromJson({ ...json, spender: '0x12' }), null);
  assert.equal(permissionFromJson({ ...json, extraData: '0x1' }), null);
  assert.equal(permissionFromJson(null), null);
  assert.equal(permissionFromJson([json]), null);
});

async function database(t: { after: (fn: () => Promise<unknown>) => void }) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(
    "CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws-1');",
  );
  await pg.exec(BASE_MIGRATION_SQL);
  await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
  await pg.exec(BASE_SHARED_ADDITIONS_SQL);
  await pg.exec(BASE_WALLET_LIMITS_SQL);
  // The calendar counter also sums the protocol fees of Feed pay calls (migrations 112 and 114).
  await pg.exec(FEED_PAY_SQL);
  await pg.exec(FEED_PAY_FEE_SQL);
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  const wallet = getAddress(`0x${'1'.repeat(40)}`);
  const spender = getAddress(`0x${'3'.repeat(40)}`);
  await pg.query(
    `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
       spender_address, spender_key_ref, derivation, state, created_at, updated_at)
     VALUES ('w-1','a-1','ws-1',${CHAIN_ID},$1,$1,$2,'v1:k','{}','derived',0,0)`,
    [wallet, spender],
  );
  const reserve = (
    ref: string,
    amount: bigint,
    atSeconds: number,
    state = 'consumed',
    kind = 'payment',
    token: string = USDC,
  ) =>
    pg.query(
      `INSERT INTO base_wallet_reservations (reservation_id, wallet_id, chain_id, token, amount,
         holder_kind, holder_ref, intent_hash, state, created_at, updated_at)
       VALUES ($1,'w-1',${CHAIN_ID},$2,$3,$4,$1,'0x00',$5,$6,$6)`,
      [ref, token.toLowerCase(), amount.toString(10), kind, state, atSeconds * 1000],
    );
  return { pg, db, wallet, spender, reserve };
}

test('the calendar counter: what counts, DST days, and a retry never counted twice', async (t) => {
  const { db, reserve } = await database(t);
  // Sunday 25 Oct 2026 (25 hours in Berlin): 00:30 CEST and 23:30 CET are the same day.
  await reserve('early', 5_000_000n, utc(2026, 10, 24, 22, 30));
  await reserve('late', 6_000_000n, utc(2026, 10, 25, 22, 30), 'held');
  await reserve('released', 9_000_000n, utc(2026, 10, 25, 12), 'released');
  await reserve('fleet', 9_000_000n, utc(2026, 10, 25, 12), 'held', 'fleet_job');
  await reserve(
    'eth',
    9_000_000n,
    utc(2026, 10, 25, 12),
    'consumed',
    'payment',
    NETWORK.tokens.ETH.address,
  );
  await reserve('before', 9_000_000n, utc(2026, 10, 24, 21, 59));
  await reserve('next', 9_000_000n, utc(2026, 10, 25, 23));
  const day = calendarPeriod('day', utc(2026, 10, 25, 12) * 1000);
  const spent = (exclude?: string) =>
    calendarSpent(db, { walletId: 'w-1', token: USDC, window: day, excludeHolderRef: exclude });
  assert.equal(await spent(), 11_000_000n);
  assert.equal(await spent('late'), 5_000_000n);

  const check = (amount: bigint, holderRef: string, nowMs = utc(2026, 10, 25, 22, 45) * 1000) =>
    db.transaction((tx) =>
      assertWithinCalendarLimit(tx, {
        walletId: 'w-1',
        chainId: CHAIN_ID,
        token: USDC,
        amount,
        cap: 20_000_000n,
        period: 'day',
        holderRef,
        nowMs,
      }),
    );
  await check(9_000_000n, 'new-1');
  await assert.rejects(check(9_000_001n, 'new-2'), CalendarLimitError);
  // A payment that already holds its reservation passed when it reserved: not re-checked.
  await check(6_000_000n, 'late');
  // Fifteen minutes later it is Monday in Berlin: a new day, where only Monday's 9 count.
  await check(11_000_000n, 'new-3', utc(2026, 10, 25, 23) * 1000);
  await assert.rejects(
    check(11_000_001n, 'new-4', utc(2026, 10, 25, 23) * 1000),
    CalendarLimitError,
  );
  // The week (from Monday 19 Oct) counts the whole Sunday and stops at Monday 26 Oct.
  const week = calendarPeriod('week', utc(2026, 10, 25, 12) * 1000);
  assert.equal(
    await calendarSpent(db, { walletId: 'w-1', token: USDC, window: week }),
    20_000_000n,
  );
});

/** A payment chain whose Base is faked: getCurrentPeriod reports a fresh Base period. */
async function spendPath(
  t: { after: (fn: () => Promise<unknown>) => void },
  model: OnchainCapModel,
  clock: { now: number },
) {
  const { pg, db, wallet, spender, reserve } = await database(t);
  const cap = 20_000_000n;
  // A daily limit signed on 19 Oct for 00:00 CEST 20 Oct: its Base days run 22:00-22:00 UTC, so
  // after the switch to CET (25 Oct) each Base day starts at 23:00 Berlin time.
  const signed = permission({
    account: wallet,
    spender,
    allowance: onchainAllowance(cap, model),
    start: utc(2026, 10, 19, 22),
  });
  await pg.query(
    `INSERT INTO base_spend_permissions (permission_id, wallet_id, chain_id, permission, signature,
       state, token, permission_hash, period_kind, cap_raw, onchain_model, created_at, updated_at)
     VALUES ('perm-1','w-1',${CHAIN_ID},$1,'\\x00','onchain',$2,$3,'day',$4,$5,0,0)`,
    [
      JSON.stringify(permissionToJson(signed)),
      USDC.toLowerCase(),
      spendPermissionHash(CHAIN_ID, signed).toLowerCase(),
      cap.toString(10),
      model,
    ],
  );
  const periodReads: number[] = [];
  const onchain: { spend: bigint; onRead?: () => Promise<void> } = { spend: 0n };
  const client = {
    async readContract(request: { functionName: string }) {
      assert.equal(request.functionName, 'getCurrentPeriod');
      const now = Math.floor(clock.now / 1000);
      const start = signed.start + Math.floor((now - signed.start) / DAY) * DAY;
      periodReads.push(start);
      const spend = onchain.spend;
      await onchain.onRead?.();
      return { start, end: start + DAY, spend };
    },
  } as unknown as PublicClient;
  const rows = new Map<string, StoredOperation>();
  const operations: ChainOperationStore = {
    async get(key) {
      return rows.get(key) ?? null;
    },
    async insert(row) {
      if (!rows.has(row.idempotencyKey)) rows.set(row.idempotencyKey, { ...row });
      return { ...rows.get(row.idempotencyKey)! };
    },
    async update(key, patch) {
      rows.set(key, { ...rows.get(key)!, ...patch });
      return { ...rows.get(key)! };
    },
    async transition(key, from, patch) {
      const row = rows.get(key);
      if (!row || !from.includes(row.status)) return null;
      return this.update(key, patch);
    },
  };
  const chain = createPaymentChain({
    network: NETWORK,
    client,
    db,
    operations,
    bundler: {} as never,
    keystore: {} as never,
    // A fee budget and the pinned sponsors, as Base requires for every agent payment.
    maxCostWeiCap: 10n ** 18n,
    sponsors: SPONSOR_PAYMASTERS,
    // Stops the send right after the reservation: nothing here may sign.
    signerOf: async () => {
      throw new Error('no signing in this test');
    },
    ledger: createReservationLedger({
      chainId: CHAIN_ID,
      balanceOf: async () => ({ balance: 10n ** 12n, blockNumber: 1n }),
      now: () => clock.now,
    }),
    now: () => clock.now,
  });
  const intent = (ref: string, amount: bigint) => ({
    workspaceId: 'ws-1',
    chainId: CHAIN_ID,
    source: { agentId: 'a-1' },
    to: getAddress(`0x${'5'.repeat(40)}`) as Address,
    token: getAddress(USDC) as Address,
    amount: amount.toString(10),
    intentHash: keccak256(toHex(ref)) as Hex,
    operationKey: ref,
  });
  return { pg, chain, reserve, intent, periodReads, signed, onchain };
}

for (const model of ['full', 'half'] as const)
  test(`${model} model: a spend over the Berlin cap is refused while Base would still allow it`, async (t) => {
    // 23:30 CET on Sunday 25 Oct: a new Base day began at 23:00 (22:00 UTC), the Berlin day not.
    const clock = { now: utc(2026, 10, 25, 22, 30) * 1000 };
    const { pg, chain, reserve, intent, periodReads, signed } = await spendPath(t, model, clock);
    // 15 USDC spent earlier that Berlin day, in the previous Base day.
    await reserve('payment:morning', 15_000_000n, utc(2026, 10, 25, 8));
    const amount = model === 'full' ? 10_000_000n : 6_000_000n;
    // Within the Base allowance for the current Base period (nothing spent in it yet) ...
    assert.ok(amount <= signed.allowance);
    // ... but 15 + amount is more than the owner's 20 USDC for the Berlin day.
    await assert.rejects(chain.submit(intent('payment:evening', amount)), (error: unknown) => {
      assert.ok(error instanceof PaymentChainError);
      assert.equal(error.code, 'OVER_CALENDAR_LIMIT');
      return true;
    });
    assert.deepEqual(periodReads, [utc(2026, 10, 25, 22)]);
    const none = await pg.query(
      `SELECT 1 FROM base_wallet_reservations WHERE holder_ref = 'payment:evening'`,
    );
    assert.equal(none.rows.length, 0);

    // Over the Base allowance itself is still refused by the on-chain bound first.
    await assert.rejects(
      chain.submit(intent('payment:big', signed.allowance + 1n)),
      (error: unknown) => {
        assert.ok(error instanceof PaymentChainError);
        assert.equal(error.code, 'OVER_ALLOWANCE');
        return true;
      },
    );

    // Half an hour later it is Monday in Berlin: the counter starts again and the spend passes
    // both checks (it reaches the reservation; this test stops it before anything is signed).
    clock.now = utc(2026, 10, 25, 23, 0) * 1000;
    await assert.rejects(chain.submit(intent('payment:monday', amount)), /no signing in this test/);
    const held = await pg.query<{ state: string; amount: string }>(
      `SELECT state, amount::text AS amount FROM base_wallet_reservations
       WHERE holder_ref = 'payment:monday'`,
    );
    assert.equal(held.rows.length, 1);
    assert.equal(held.rows[0].amount, amount.toString(10));
    // Never sent, so released again right away.
    assert.equal(held.rows[0].state, 'released');
  });

test('half model: payments sent but not on Base yet count against the Base period', async (t) => {
  // Wednesday 21 Oct, 10:00 UTC: the Base day began at 22:00 UTC, the Berlin day at the same time.
  const clock = { now: utc(2026, 10, 21, 10) * 1000 };
  const { pg, chain, reserve, intent, signed } = await spendPath(t, 'half', clock);
  assert.equal(signed.allowance, 10_000_000n);
  // A payment from the previous Base day never counts; one sent an hour ago is not on Base yet
  // (the fake Base reports nothing spent in this period).
  await reserve('payment:yesterday', 9_000_000n, utc(2026, 10, 20, 21));
  await reserve('payment:in-flight', 6_000_000n, utc(2026, 10, 21, 9), 'held');
  const refused = (ref: string, amount: bigint) =>
    assert.rejects(chain.submit(intent(ref, amount)), (error: unknown) => {
      assert.ok(error instanceof PaymentChainError);
      assert.equal(error.code, 'OVER_ALLOWANCE');
      return true;
    });
  // 6 + 6 fits the owner's 20 for the Berlin day, but not Base's 10 for its period.
  await refused('payment:second', 6_000_000n);
  const none = await pg.query(
    `SELECT 1 FROM base_wallet_reservations WHERE holder_ref = 'payment:second'`,
  );
  assert.equal(none.rows.length, 0);
  // 6 + 4 fits: it reaches the reservation (this test stops it before anything is signed).
  await assert.rejects(chain.submit(intent('payment:fits', 4_000_000n)), /no signing in this test/);
  // Payments before the limit was created spent under another limit and never count against it.
  await pg.query(`UPDATE base_spend_permissions SET created_at = $1`, [
    utc(2026, 10, 21, 9, 30) * 1000,
  ]);
  await assert.rejects(
    chain.submit(intent('payment:new-limit', 6_000_000n)),
    /no signing in this test/,
  );
});

test('half model: a payment held from before the Base period began still counts in this one', async (t) => {
  // Wednesday 21 Oct, 10:00 UTC; the Base period began at 22:00 UTC on 20 Oct.
  const clock = { now: utc(2026, 10, 21, 10) * 1000 };
  const { chain, reserve, intent } = await spendPath(t, 'half', clock);
  // Reserved at 21:59 UTC (the previous period), still held: it may land in this period, and the
  // fake Base reports nothing spent in this period yet.
  await reserve('payment:boundary', 6_000_000n, utc(2026, 10, 20, 21, 59), 'held');
  // A consumed one from the previous period does not count.
  await reserve('payment:old-done', 9_000_000n, utc(2026, 10, 20, 20));
  await assert.rejects(chain.submit(intent('payment:new', 6_000_000n)), (error: unknown) => {
    assert.ok(error instanceof PaymentChainError);
    assert.equal(error.code, 'OVER_ALLOWANCE');
    return true;
  });
  // 6 held + 4 fits the 10.
  await assert.rejects(
    chain.submit(intent('payment:small', 4_000_000n)),
    /no signing in this test/,
  );
});

test('half model: a payment settled between the Base read and the admission still counts', async (t) => {
  const clock = { now: utc(2026, 10, 21, 10) * 1000 };
  const { pg, chain, reserve, intent, onchain } = await spendPath(t, 'half', clock);
  await reserve('payment:landing', 6_000_000n, utc(2026, 10, 21, 9), 'held');
  // Base answers "0 spent", and while that answer is on its way the held payment becomes final
  // and is settled here: neither the read nor the held sum includes it any more.
  onchain.onRead = async () => {
    await pg.query(
      `UPDATE base_wallet_reservations SET state = 'consumed', updated_at = $1
       WHERE holder_ref = 'payment:landing'`,
      [clock.now + 1],
    );
  };
  await assert.rejects(chain.submit(intent('payment:next', 6_000_000n)), (error: unknown) => {
    assert.ok(error instanceof PaymentChainError);
    assert.equal(error.code, 'OVER_ALLOWANCE');
    return true;
  });
});

test('half model: a payment final in this period plus one still held count together', async (t) => {
  const clock = { now: utc(2026, 10, 21, 10) * 1000 };
  const { chain, reserve, intent, onchain } = await spendPath(t, 'half', clock);
  // Reserved in the previous period and final in this one (consumed here, 6 in Base's count), plus
  // a payment of this period still held (4): 10 committed, so another 4 would make 14 of 10.
  await reserve('payment:old-final', 6_000_000n, utc(2026, 10, 20, 21, 59), 'consumed');
  await reserve('payment:pending', 4_000_000n, utc(2026, 10, 21, 9), 'held');
  onchain.spend = 6_000_000n;
  await assert.rejects(chain.submit(intent('payment:another', 4_000_000n)), (error: unknown) => {
    assert.ok(error instanceof PaymentChainError);
    assert.equal(error.code, 'OVER_ALLOWANCE');
    return true;
  });
});

test('half model: a Feed pay float top-up not on Base yet counts against the Base period', async (t) => {
  // Both spend the same limit through SpendPermissionManager.spend: Base's 10 for the period.
  const clock = { now: utc(2026, 10, 21, 10) * 1000 };
  const { pg, chain, reserve, intent, onchain } = await spendPath(t, 'half', clock);
  const overAllowance = (error: unknown) => {
    assert.ok(error instanceof PaymentChainError);
    assert.equal(error.code, 'OVER_ALLOWANCE');
    return true;
  };
  // A top-up of 6 held (sent, not in a block yet): Base reports nothing spent.
  await reserve('feed-pay:top-up:held', 6_000_000n, utc(2026, 10, 21, 9), 'held', 'float');
  await assert.rejects(chain.submit(intent('payment:after-held', 6_000_000n)), overAllowance);
  // 6 + 4 fits.
  await assert.rejects(chain.submit(intent('payment:fits', 4_000_000n)), /no signing in this test/);
  await pg.query(`DELETE FROM base_wallet_reservations`);

  // A top-up that became final and was settled here while Base's answer was on its way.
  await reserve('feed-pay:top-up:landing', 6_000_000n, utc(2026, 10, 21, 9), 'held', 'float');
  onchain.onRead = async () => {
    await pg.query(
      `UPDATE base_wallet_reservations SET state = 'consumed', updated_at = $1
       WHERE holder_ref = 'feed-pay:top-up:landing'`,
      [clock.now + 1],
    );
  };
  await assert.rejects(chain.submit(intent('payment:after-landing', 6_000_000n)), overAllowance);
  onchain.onRead = undefined;
  await pg.query(`DELETE FROM base_wallet_reservations`);

  // A top-up planned (its float move pending) whose hold is not taken yet counts too.
  await pg.query(
    `INSERT INTO feed_pay_float_moves (move_id, wallet_id, chain_id, kind, amount_raw, op_key,
       intent_hash, state, created_at, updated_at)
     VALUES ('m-1','w-1',${CHAIN_ID},'top_up',6000000,'feed-pay:top-up:m-1','0x00','pending',$1,$1)`,
    [utc(2026, 10, 21, 9) * 1000],
  );
  await assert.rejects(chain.submit(intent('payment:after-planned', 6_000_000n)), overAllowance);
  // Once it holds its reservation, it is counted once, not twice: 6 + 4 still fits.
  await reserve('feed-pay:top-up:m-1', 6_000_000n, utc(2026, 10, 21, 9), 'held', 'float');
  await assert.rejects(
    chain.submit(intent('payment:fits-once', 4_000_000n)),
    /no signing in this test/,
  );
  // A failed (released) top-up never spends.
  await pg.query(`UPDATE feed_pay_float_moves SET state = 'failed'`);
  await pg.query(
    `UPDATE base_wallet_reservations SET state = 'released' WHERE holder_kind = 'float'`,
  );
  await pg.query(
    `UPDATE base_wallet_reservations SET state = 'released' WHERE holder_kind = 'payment'`,
  );
  await assert.rejects(
    chain.submit(intent('payment:after-failed', 6_000_000n)),
    /no signing in this test/,
  );
});

test('a revoke request blocks the agent at once', async (t) => {
  const clock = { now: utc(2026, 10, 21, 10) * 1000 };
  const { pg, chain, intent } = await spendPath(t, 'half', clock);
  await pg.query(`UPDATE base_spend_permissions SET state = 'revoke_pending'`);
  await assert.rejects(
    chain.submit(intent('payment:after-revoke', 1_000_000n)),
    (error: unknown) => {
      assert.ok(error instanceof PaymentChainError);
      assert.equal(error.code, 'NO_PERMISSION');
      return true;
    },
  );
});
