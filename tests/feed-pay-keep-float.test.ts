import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { calendarSpent } from '../server/base/chain/calendar-limit.js';
import { calendarPeriod } from '../shared/base/spend-limits.js';
import { DEFAULT_FLOAT_RAW } from '../shared/feed-pay.js';
import { BODY, PAY_TO, setup, USDC, type FeedPayApp } from './helpers/feed-pay-app.js';

/*
 * The float is kept across Base periods while the same limit continues (docs/FEED_PAY.md section
 * 8). The end of a Base period alone no longer sweeps it (that sent a nightly wave of sweeps and
 * refill top-ups at 00:00 Berlin); every other reason still does. A payment from a carried-over
 * float counts against the new period's Berlin calendar cap, so no cap is ever exceeded. The whole
 * app (tests/helpers/feed-pay-app.ts) against a fake Base. Nothing reaches a network; no real
 * payment is ever made. Synthetic data.
 */

// Tuesday 20 Oct 2026, 12:00 in Berlin (CEST). The fixture's limit started a day earlier, so its
// current Base period (a day) ends at 12:00 Berlin on Wednesday, a new Berlin day too.
const NOON = Date.UTC(2026, 9, 20, 10, 0, 0);
const DAY_MS = 86_400_000;
const PRICE = 20_000n;

const moves = (f: FeedPayApp, kind: 'top_up' | 'sweep') =>
  f.sql<{ amount_raw: string; reason: string | null }>(
    'SELECT amount_raw::text AS amount_raw, reason FROM feed_pay_float_moves WHERE kind = $1',
    [kind],
  );

const sweepReasons = async (f: FeedPayApp) =>
  (
    await f.sql<{ detail: { reason: string } }>(
      "SELECT detail FROM base_audit_events WHERE kind = 'feed_pay_float_sweep'",
    )
  ).map((event) => event.detail.reason);

/**
 * Past the end of the Base period (and the Berlin day): two half days, with a signed-in request
 * between them so the owner's session (renewed while used, idle for at most a day) stays open.
 */
async function nextPeriod(f: FeedPayApp) {
  f.advance(DAY_MS / 2);
  assert.equal((await f.agents()).statusCode, 200);
  f.advance(DAY_MS / 2 + 60_000);
  // A new Base period: SpendPermissionManager counts the allowance from zero again (the fake Base
  // keeps one counter per wallet, so it starts it over here).
  f.base.state.spent.clear();
}

/** What the calendar counter holds for the Berlin day around `atMs`. */
const spentOnDay = (f: FeedPayApp, atMs: number) =>
  calendarSpent(f.db, { walletId: f.walletId, token: USDC, window: calendarPeriod('day', atMs) });

/** A listed service, the owner's limit and one paid call: a float of 0.98 USDC is left. */
async function withFloat(f: FeedPayApp, at: { end?: number } = {}) {
  await f.list();
  const limit = await f.limit(undefined, at);
  const res = await f.pay();
  assert.equal(res.json().state, 'result_saved', res.body);
  const float = f.base.balanceOf(f.base.spender);
  assert.equal(float, BigInt(DEFAULT_FLOAT_RAW) - PRICE);
  assert.equal((await moves(f, 'top_up')).length, 1);
  return { limit, float };
}

test('the Base period ends, the same limit continues: the float is kept and used', async (t) => {
  const f = await setup(t, { now: NOON });
  const { float } = await withFloat(f);
  const dayOne = f.clock();

  // Past the end of the Base period (and the Berlin day): the cron keeps the float.
  await nextPeriod(f);
  await f.cron();
  await f.cron();
  assert.equal(f.base.balanceOf(f.base.spender), float, 'nothing went back');
  assert.deepEqual(await moves(f, 'sweep'), []);
  assert.deepEqual(await sweepReasons(f), []);
  const [settings] = await f.sql<{ float_open: boolean; float_period_end: string }>(
    'SELECT float_open, float_period_end::text AS float_period_end FROM feed_pay_agent_settings WHERE wallet_id = $1',
    [f.walletId],
  );
  assert.equal(settings!.float_open, true);
  // Looked at again when the new Base period ends, not on every cron run.
  assert.equal(settings!.float_period_end, String(Math.floor(NOON / 1000) + 2 * 86_400));

  // A call in the new period pays from the carried-over float: no top-up, no sponsored operation.
  const sends = f.base.state.sends.length;
  const res = await f.pay();
  assert.equal(res.json().state, 'result_saved', res.body);
  assert.equal(f.base.balanceOf(f.base.spender), float - PRICE);
  assert.equal((await moves(f, 'top_up')).length, 1, 'still the one top-up of the first day');
  assert.equal(f.base.state.sends.length, sends, 'nothing sent to Base for the float');
  assert.equal(f.base.balanceOf(PAY_TO), 2n * PRICE);

  // It counts against the new day's calendar cap, the earlier one against its own day.
  assert.equal(await spentOnDay(f, f.clock()), PRICE);
  assert.equal(await spentOnDay(f, dayOne), PRICE);
  // What the agent may still spend now is the new day's cap minus this payment, never the cap
  // plus the carried-over float.
  const agents = (await f.agents()).json() as { agents: Array<{ limitLeftRaw: string | null }> };
  assert.equal(agents.agents[0]!.limitLeftRaw, (5_000_000n - PRICE).toString(10));
});

test('a carried-over float never pays above the new period calendar cap', async (t) => {
  const f = await setup(t, { now: NOON });
  const { float } = await withFloat(f);
  await nextPeriod(f);
  await f.cron();
  assert.equal(f.base.balanceOf(f.base.spender), float);

  // The next call is quoted; then other payments of the new day leave 0.01 USDC of the 5 USDC cap
  // (as earlier calls of the day would), less than the price, while the float still holds 0.98.
  const q = (await f.quote()).json() as { quoteId: string; amount: { raw: string } };
  const id = randomUUID();
  await f.sql(
    `INSERT INTO base_payments (payment_id, operator_id, chain_id, actor_id, source_kind,
       source_ref, payer_wallet_id, intent_version, intent_hash, idempotency_key, token_address,
       recipient_address, amount, kind, state, created_at, updated_at)
     SELECT $1, operator_id, chain_id, actor_id, source_kind, source_ref, payer_wallet_id,
       intent_version, $2, $3, token_address, recipient_address, $4, kind, state, $5, $5
     FROM base_payments WHERE payer_wallet_id = $6 AND kind = 'x402' LIMIT 1`,
    [id, `0x${'cd'.repeat(32)}`, `feed-pay:earlier-${id}`, '4990000', f.clock(), f.walletId],
  );
  assert.equal(await spentOnDay(f, f.clock()), 4_990_000n);

  const res = await f.callService({
    agentId: f.agentId,
    inputs: BODY,
    quoteId: q.quoteId,
    maxAmountRaw: q.amount.raw,
    idempotencyKey: randomUUID(),
  });
  assert.equal(res.json().code, 'over_limit', res.body);
  assert.equal(res.json().limitLeftRaw, '10000');
  // Nothing paid from the float, nothing topped up, nothing counted.
  assert.equal(f.base.balanceOf(f.base.spender), float);
  assert.equal(f.base.balanceOf(PAY_TO), PRICE);
  assert.equal((await moves(f, 'top_up')).length, 1);
  assert.equal(await spentOnDay(f, f.clock()), 4_990_000n);
});

test('an empty float is closed when the Base period ends; the next call opens it again', async (t) => {
  const f = await setup(t, { now: NOON });
  await withFloat(f);
  // The float was used up (as by other calls of the day).
  const float = f.base.balanceOf(f.base.spender);
  f.base.credit(f.base.spender, -float);
  f.base.credit(f.wallet, float);
  await nextPeriod(f);
  await f.cron();
  const closed = await f.sql<{ float_open: boolean }>(
    'SELECT float_open FROM feed_pay_agent_settings WHERE wallet_id = $1',
    [f.walletId],
  );
  assert.equal(closed[0]!.float_open, false);
  assert.deepEqual(await moves(f, 'sweep'), [], 'nothing to send back');
  const res = await f.pay();
  assert.equal(res.json().state, 'result_saved', res.body);
  assert.equal((await moves(f, 'top_up')).length, 2);
  const open = await f.sql<{ float_open: boolean }>(
    'SELECT float_open FROM feed_pay_agent_settings WHERE wallet_id = $1',
    [f.walletId],
  );
  assert.equal(open[0]!.float_open, true);
});

/** Every other reason still sends the float back to the agent wallet. */
const cases: Array<{
  name: string;
  reason: string;
  /** Applied after the Base period ended, before the cron runs. */
  apply: (f: FeedPayApp, limit: { id: string }) => Promise<unknown>;
  end?: (nowS: number) => number;
}> = [
  {
    name: 'Feed pay switched off',
    reason: 'switched_off',
    apply: async () => {
      process.env.CITY_FEED_PAY = '0';
    },
  },
  {
    name: 'the agent paused',
    reason: 'agent_paused',
    apply: (f) =>
      f.sql(
        `UPDATE workspaces SET data = jsonb_set(data, '{agents,0,pausedAt}', to_jsonb($1::text))
         WHERE operator_id = $2`,
        [new Date(f.clock()).toISOString(), f.owner.id],
      ),
  },
  {
    name: 'the agent removed',
    reason: 'agent_paused',
    apply: (f) =>
      f.sql(
        `UPDATE workspaces SET data = jsonb_set(data, '{agents,0,revokedAt}', to_jsonb($1::text))
         WHERE operator_id = $2`,
        [new Date(f.clock()).toISOString(), f.owner.id],
      ),
  },
  {
    name: 'the limit revoked',
    reason: 'limit_changed',
    apply: (f, limit) =>
      f.sql(
        `UPDATE base_spend_permissions SET state = 'revoked', revoked_block = 1
         WHERE permission_id = $1`,
        [limit.id],
      ),
  },
  {
    name: 'the limit revoke pending',
    reason: 'limit_changed',
    apply: (f, limit) =>
      f.sql("UPDATE base_spend_permissions SET state = 'revoke_pending' WHERE permission_id = $1", [
        limit.id,
      ]),
  },
  {
    // The owner signs a new limit: the old one is revoked and the new one is the active limit.
    name: 'the limit replaced',
    reason: 'limit_changed',
    apply: async (f, limit) => {
      await f.sql(
        `UPDATE base_spend_permissions SET state = 'revoked', revoked_block = 1
         WHERE permission_id = $1`,
        [limit.id],
      );
      return f.limit();
    },
  },
  {
    // The limit ends 2 hours into its next Base period: kept at the period's end, swept at its own.
    name: "the permission's end passed",
    reason: 'limit_ended',
    end: (nowS) => nowS + 86_400 + 2 * 3600,
    apply: async (f) => {
      await f.cron();
      await f.cron();
      assert.deepEqual(await sweepReasons(f), [], 'kept while the limit still runs');
      f.advance(2 * 3600_000);
    },
  },
  {
    // A limit with no calendar cap (an on-chain period other than a day, week or month) has only
    // Base's allowance per period: its float still goes back when the period ends.
    name: 'a limit without a calendar cap, its period ended',
    reason: 'period_ended',
    apply: (f, limit) =>
      f.sql(
        `UPDATE base_spend_permissions SET period_kind = NULL,
           permission = jsonb_set(permission, '{period}', to_jsonb(90000))
         WHERE permission_id = $1`,
        [limit.id],
      ),
  },
];

for (const c of cases)
  test(`still swept when ${c.name}`, async (t) => {
    const f = await setup(t, { now: NOON });
    const { limit, float } = await withFloat(
      f,
      c.end ? { end: c.end(Math.floor(NOON / 1000)) } : {},
    );
    const walletBefore = f.base.balanceOf(f.wallet);
    await nextPeriod(f);
    await c.apply(f, limit);
    await f.cron();
    await f.cron();
    assert.equal(f.base.balanceOf(f.base.spender), 0n);
    assert.equal(f.base.balanceOf(f.wallet), walletBefore + float);
    assert.deepEqual(await sweepReasons(f), [c.reason]);
    assert.deepEqual(
      (await moves(f, 'sweep')).map((move) => [move.amount_raw, move.reason]),
      [[float.toString(10), c.reason]],
    );
  });
