import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicClient } from 'viem';
import { spendPermissionManagerAbi } from '../server/base/chain/permissions.js';
import {
  berlinDayStart,
  LIMIT_PERIOD_SECONDS,
  nextBerlinMidnight,
  permissionFromJson,
  type LimitPeriod,
} from '../shared/base/spend-limits.js';
import type { SpendPermission } from '../shared/base/types.js';
import { checkLimit } from '../src/base/wallet/limits.js';
import { CHAIN_ID, json, setup, USDC, type FeedPayApp } from './helpers/feed-pay-app.js';

/*
 * A spending limit works as soon as it is signed (14 Oct 2026: a limit signed in the afternoon
 * started at the next midnight, so "Use with my agent" could not pay until then). The whole app
 * (createApp on PGlite, tests/helpers/feed-pay-app.ts): the owner prepares the limit through the
 * real limit routes, the browser's own check accepts it, the owner key signs it, it is stored, and
 * Feed pay pays right after, against the fake Base, whose SpendPermissionManager refuses any spend
 * before a limit's start as the real one does. Nothing reaches a network; no real payment is ever
 * made. Synthetic data.
 */

// Wednesday 14 Oct 2026, 14:00 in Berlin (CEST); the day began at 00:00 CEST (22:00 UTC).
const AFTERNOON = Date.UTC(2026, 9, 14, 12, 0, 0);
const TODAY = Date.UTC(2026, 9, 13, 22, 0, 0) / 1000;
const MIDNIGHT = Date.UTC(2026, 9, 14, 22, 0, 0) / 1000;

const limitsUrl = (f: FeedPayApp) => `/api/base/agents/${f.agentId}/wallet/limits`;

/**
 * What the Spending limit screen does: prepare, check in the browser, sign with the owner key,
 * store (`storeAfterMs` after the signature: the owner took that long).
 */
async function setLimit(
  f: FeedPayApp,
  body: { capRaw: string; period: LimitPeriod } = { capRaw: '5000000', period: 'day' },
  storeAfterMs = 0,
) {
  const headers = { ...json, cookie: f.owner.cookie };
  const prep = await f.app.inject({
    method: 'POST',
    url: `${limitsUrl(f)}/prepare`,
    headers,
    payload: JSON.stringify(body),
  });
  assert.equal(prep.statusCode, 200, prep.body);
  const prepared = prep.json();
  const checked = checkLimit({
    prepared,
    wallet: f.wallet,
    owner: f.ownerKey.address,
    agentId: f.agentId,
    spender: f.base.spender,
    capRaw: body.capRaw,
    period: body.period,
    now: f.clock(),
  });
  const signature = await f.ownerKey.signTypedData(checked.typedData);
  f.advance(storeAfterMs);
  const stored = await f.app.inject({
    method: 'POST',
    url: limitsUrl(f),
    headers,
    payload: JSON.stringify({
      permission: prepared.permission,
      capRaw: body.capRaw,
      period: body.period,
      signature,
    }),
  });
  return { prepared, checked, stored };
}

/** Base's current period of a limit, as SpendPermissionManager.getCurrentPeriod answers it. */
const currentPeriod = (f: FeedPayApp, permission: SpendPermission) =>
  (f.base.client as PublicClient).readContract({
    address: '0x0000000000000000000000000000000000000000',
    abi: spendPermissionManagerAbi,
    functionName: 'getCurrentPeriod',
    args: [permission],
  });

test('a limit signed at 14:00 Berlin works at once: Use with my agent pays right after', async (t) => {
  const f = await setup(t, { now: AFTERNOON });
  await f.list();
  assert.equal(berlinDayStart(f.clock()), TODAY);

  const { prepared, checked, stored } = await setLimit(f);
  assert.equal(stored.statusCode, 201, stored.body);
  const permission = permissionFromJson(prepared.permission)!;
  // Today's 00:00 Berlin, before the signature: Base's first day is the current one.
  assert.equal(permission.start, TODAY);
  assert.equal(checked.start, TODAY);
  assert.equal(stored.json().start, TODAY);
  assert.equal(permission.period, LIMIT_PERIOD_SECONDS.day);
  assert.ok(permission.start * 1000 <= f.clock());
  const period = await currentPeriod(f, permission);
  assert.equal(Number(period.start), TODAY);
  assert.equal(Number(period.end), MIDNIGHT);

  // The Feed's agent list: ready, with today's whole Base allowance left (half the 5 USDC cap).
  const agents = (await f.agents()).json();
  assert.equal(agents.agents[0].hasLimit, true, JSON.stringify(agents));
  assert.equal(agents.agents[0].ready, true, JSON.stringify(agents));
  assert.equal(agents.agents[0].limitLeftRaw, '2500000');

  // Use with my agent, right after: the float top-up approves the limit and spends under it in
  // one operation on Base, the service is paid and answers.
  const res = await f.pay();
  assert.equal(res.statusCode, 200, res.body);
  const call = res.json();
  assert.equal(call.state, 'result_saved', res.body);
  assert.equal(call.moneyMoved, 'yes');
  assert.equal(call.payment.state, 'settled');
  assert.deepEqual(f.base.state.effects, ['approve', 'spend']);
  const rows = await f.sql<{ state: string; start: number }>(
    `SELECT state, (permission->>'start')::bigint AS start FROM base_spend_permissions`,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.state, 'onchain');
  assert.equal(Number(rows[0]!.start), TODAY);
});

test('a limit that starts at the next midnight (signed before this change) pays from its start', async (t) => {
  const f = await setup(t, { now: AFTERNOON });
  await f.list();
  // Signed this afternoon by the previous version: Base counts from 00:00 tonight, and Feed pay
  // says so (tests/feed-pay-limit-start.test.ts).
  await f.limit(5_000_000n, { start: nextBerlinMidnight(f.clock()) });
  const before = await f.pay();
  assert.equal(before.statusCode, 409, before.body);
  assert.equal(before.json().code, 'limit_not_started', before.body);
  // Nothing was approved or spent on Base, and nothing is held.
  assert.deepEqual(f.base.state.effects, []);
  assert.equal(f.base.state.sends.length, 0);
  const held = await f.sql(`SELECT 1 FROM base_wallet_reservations WHERE state = 'held'`);
  assert.equal(held.length, 0);

  // A new limit is not set over it: one limit per token, a new one only after a revoke.
  const another = await f.app.inject({
    method: 'POST',
    url: `${limitsUrl(f)}/prepare`,
    headers: { ...json, cookie: f.owner.cookie },
    payload: JSON.stringify({ capRaw: '5000000', period: 'day' }),
  });
  assert.equal(another.statusCode, 409, another.body);
  assert.equal(another.json().code, 'limit_exists');

  // From midnight on it pays as before.
  f.advance(MIDNIGHT * 1000 - f.clock() + 60_000);
  const after = await f.pay();
  assert.equal(after.statusCode, 200, after.body);
  assert.equal(after.json().state, 'result_saved', after.body);
  assert.deepEqual(f.base.state.effects, ['approve', 'spend']);
});

test('prepared at 23:58 Berlin, stored at 00:03: the start of the day it was prepared on, and it pays at once', async (t) => {
  const f = await setup(t, { now: MIDNIGHT * 1000 - 2 * 60_000 });
  await f.list();
  const { prepared, checked, stored } = await setLimit(f, undefined, 5 * 60_000);
  assert.equal(stored.statusCode, 201, stored.body);
  const permission = permissionFromJson(prepared.permission)!;
  // 00:00 of 14 Oct, the day it was prepared and signed on; stored on 15 Oct.
  assert.equal(permission.start, TODAY);
  assert.equal(checked.start, TODAY);
  assert.equal(stored.json().start, TODAY);
  assert.ok(f.clock() > MIDNIGHT * 1000);
  // Base's current period is the new day's, with one period's allowance: 14 Oct's period is over
  // and nothing of it carries over (the limit could not be used before it was stored).
  const period = await currentPeriod(f, permission);
  assert.equal(Number(period.start), MIDNIGHT);
  assert.equal(Number(period.end), MIDNIGHT + 86_400);
  assert.equal(period.spend, 0n);
  const agents = (await f.agents()).json();
  assert.equal(agents.agents[0].ready, true, JSON.stringify(agents));
  assert.equal(agents.agents[0].limitLeftRaw, '2500000');
  const res = await f.pay();
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().state, 'result_saved', res.body);
  assert.deepEqual(f.base.state.effects, ['approve', 'spend']);
});

test('signed at 23:58 Berlin and sent at 00:11, past the signing window: refused, nothing stored', async (t) => {
  const f = await setup(t, { now: MIDNIGHT * 1000 - 2 * 60_000 });
  await f.list();
  const { stored } = await setLimit(f, undefined, 13 * 60_000);
  assert.equal(stored.statusCode, 422, stored.body);
  assert.equal(stored.json().code, 'permission_mismatch');
  assert.equal((await f.sql('SELECT 1 FROM base_spend_permissions')).length, 0);
  const agents = (await f.agents()).json();
  assert.equal(agents.agents[0].hasLimit, false, JSON.stringify(agents));
  assert.deepEqual(f.base.state.effects, []);
});

test('on the days the clocks change, a new limit starts at that day’s true 00:00 Berlin and pays at once', async (t) => {
  // The last Sundays of March and October 2026 and 2027, at noon UTC: each day began at 00:00
  // Berlin, 23:00 UTC the day before in winter time (CET) and 22:00 UTC in summer time (CEST).
  for (const [noon, start] of [
    [Date.UTC(2026, 2, 29, 12), Date.UTC(2026, 2, 28, 23) / 1000], // 23 hours, began in CET
    [Date.UTC(2026, 9, 25, 12), Date.UTC(2026, 9, 24, 22) / 1000], // 25 hours, began in CEST
    [Date.UTC(2027, 2, 28, 12), Date.UTC(2027, 2, 27, 23) / 1000], // 23 hours, began in CET
    [Date.UTC(2027, 9, 31, 12), Date.UTC(2027, 9, 30, 22) / 1000], // 25 hours, began in CEST
  ] as const) {
    const day = new Date(noon).toISOString().slice(0, 10);
    const f = await setup(t, { now: noon });
    await f.list();
    assert.equal(berlinDayStart(noon), start, day);
    const { prepared, stored } = await setLimit(f);
    assert.equal(stored.statusCode, 201, `${day}: ${stored.body}`);
    const permission = permissionFromJson(prepared.permission)!;
    assert.equal(permission.start, start, day);
    // Base's first day is the current one: 24 hours from that midnight, whatever the Berlin day's
    // length (the bound test covers the 23- and 25-hour days).
    const period = await currentPeriod(f, permission);
    assert.equal(Number(period.start), start, day);
    assert.equal(Number(period.end), start + 86_400, day);
    const res = await f.pay();
    assert.equal(res.statusCode, 200, `${day}: ${res.body}`);
    assert.equal(res.json().state, 'result_saved', `${day}: ${res.body}`);
    assert.deepEqual(f.base.state.effects, ['approve', 'spend'], day);
  }
});

test('the first period allows one period’s allowance, never more; the Berlin day’s count still applies', async (t) => {
  const f = await setup(t, { now: AFTERNOON });
  await f.list();
  // This morning the agent spent 4.99 USDC from this wallet (under an earlier limit, since
  // revoked): the Berlin day's count is per wallet, across limits.
  await f.sql(
    `INSERT INTO base_wallet_reservations (reservation_id, wallet_id, chain_id, token, amount,
       holder_kind, holder_ref, intent_hash, state, created_at, updated_at)
     VALUES ('morning-spend', $1, $2, $3, 4990000, 'payment', 'morning-spend', '0x00', 'consumed',
       $4, $4)`,
    [f.walletId, CHAIN_ID, USDC.toLowerCase(), AFTERNOON - 5 * 3_600_000],
  );
  const { prepared, stored } = await setLimit(f);
  assert.equal(stored.statusCode, 201, stored.body);
  const permission = permissionFromJson(prepared.permission)!;
  // Base: the first period is today's, with exactly one period's allowance (half the 5 USDC cap).
  assert.equal(permission.allowance, 2_500_000n);
  const period = await currentPeriod(f, permission);
  assert.equal(Number(period.start), TODAY);
  assert.equal(period.spend, 0n);
  // Central City: 0.01 USDC is left of today's 5.00, so that is all the agent has left today.
  const agents = (await f.agents()).json();
  assert.equal(agents.agents[0].limitLeftRaw, '10000', JSON.stringify(agents));
  // A call for 0.02 USDC is refused before anything is signed or sent.
  const res = await f.pay();
  assert.equal(res.json().code, 'over_limit', res.body);
  assert.deepEqual(f.base.state.effects, []);
  assert.equal(f.base.state.sends.length, 0);
});
