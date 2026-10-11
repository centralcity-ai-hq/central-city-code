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
  const client = {
    async readContract(request: { functionName: string }) {
      assert.equal(request.functionName, 'getCurrentPeriod');
      const now = Math.floor(clock.now / 1000);
      const start = signed.start + Math.floor((now - signed.start) / DAY) * DAY;
      periodReads.push(start);
      return { start, end: start + DAY, spend: 0n };
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
  return { pg, chain, reserve, intent, periodReads, signed };
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
