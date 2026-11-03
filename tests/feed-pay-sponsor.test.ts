import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../server/database.js';
import {
  FEED_PAY_SPONSOR_FLEET_CEILING_SQL,
  FEED_PAY_SPONSOR_FLEET_CEILING_40_SQL,
} from '../server/feed/pay/sponsor-ceiling-schema.js';
import { FEED_PAY_SPONSOR_SQL } from '../server/feed/pay/sponsor-schema.js';
import { FEED_PAY_SPONSORED_SQL as SPONSORED_250_SQL } from '../server/feed/pay/sponsored.js';
import { FEED_PAY_SPONSORED_CHAIN_COLUMN_SQL } from '../server/feed/pay/sponsored-count-schema.js';

/** The sponsored calls table as migrations 250 and 359 leave it. */
const FEED_PAY_SPONSORED_SQL = `${SPONSORED_250_SQL}\n${FEED_PAY_SPONSORED_CHAIN_COLUMN_SQL}`;
import {
  createSponsorCredits,
  sponsorConfig,
  SFP_CREDIT_CEILING_RAW,
  SFP_FLEET_CREDIT_CEILING_RAW,
  type SponsorRequest,
} from '../server/feed/pay/sponsor.js';
import { registerSponsorStatsRoute, SFP_STATS_PATH } from '../server/feed/pay/sponsor-routes.js';
import { GOOGLE_SALT_PENDING_NAME } from '../server/google/routes.js';
import { TERMS_VERSION } from '../shared/terms.js';

const START = 1_800_000_000_000;
const SECRET = 's'.repeat(40);
const CHAIN = 8453;

async function setup(
  t: { after: (fn: () => Promise<unknown>) => void },
  extra: Record<string, string> = {},
) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  // Only the base_identities columns the credit reads (the real table: server/base/schema.ts).
  await pg.exec(`CREATE TABLE base_identities (agent_id text, chain_id integer, state text,
    erc8004_agent_id numeric, started_at bigint, updated_at bigint);`);
  // The onboarding gate's tables (server/onboarding.ts), only the columns it reads.
  await pg.exec(`CREATE TABLE operators (id text PRIMARY KEY, salt text, kind text);
    CREATE TABLE account_terms_acceptances (operator_id text, version text);
    CREATE TABLE operator_links (human_operator_id text, ai_operator_id text);
    CREATE TABLE elric_verified_identities (operator_id text);`);
  await pg.exec(FEED_PAY_SPONSOR_SQL);
  // Migrations 260 and 307 widen the credit's CHECK to 40 USDC; only the fleets get there.
  for (const sql of [FEED_PAY_SPONSOR_FLEET_CEILING_SQL, FEED_PAY_SPONSOR_FLEET_CEILING_40_SQL])
    await pg.exec(
      sql
        .split(';')
        .filter((s) => s.includes('feed_pay_sponsor_credits'))
        .join(';'),
    );
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  const env: Record<string, string> = {
    CITY_SFP_ENABLED: '1',
    CITY_SFP_START_MS: String(START),
    CITY_SFP_CREDIT_MAX_RAW: '2000000',
    CITY_SFP_DAILY_BUDGET_RAW: '5000000',
    CITY_SFP_OWNER_DAILY_MAX: '2',
    CITY_SFP_OFFERS: 'offer-1',
    CITY_OPS_SECRET: SECRET,
    ...extra,
  };
  const clock = { now: START + 3_600_000 };
  const credits = createSponsorCredits({ db, env, now: () => clock.now });
  const agent = (
    id: string,
    state = 'confirmed',
    startedAt = START + 1,
    baseId: number | null = 1,
  ) =>
    pg.query('INSERT INTO base_identities VALUES ($1, $2, $3, $4, $5, $5)', [
      id,
      CHAIN,
      state,
      baseId,
      startedAt,
    ]);
  /** An owner account: verified with Google and onboarded unless said otherwise. */
  const owner = async (id: string, o: { verified?: boolean; salt?: string } = {}) => {
    await pg.query('INSERT INTO operators VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [
      id,
      o.salt ?? 'x',
      'owner',
    ]);
    if (o.verified !== false) {
      await pg.query('INSERT INTO elric_verified_identities VALUES ($1)', [id]);
      await pg.query('INSERT INTO account_terms_acceptances VALUES ($1, $2)', [id, TERMS_VERSION]);
    }
  };
  await owner('owner-shared');
  const agentOwned = async (
    id: string,
    ...rest: Parameters<typeof agent> extends [string, ...infer R] ? R : never
  ) => {
    await owner(`owner-${id}`);
    return agent(id, ...rest);
  };
  return { pg, db, env, clock, credits, agent: agentOwned, rawAgent: agent, owner };
}

let calls = 0;
const request = (agentId: string, over: Partial<SponsorRequest> = {}): SponsorRequest => ({
  agentId,
  chainId: CHAIN,
  operatorId: `ws-${agentId}`,
  ownerAccountId: `owner-${agentId}`,
  seller: { operatorId: 'ws-seller', ownerAccountId: 'owner-seller', agentId: 'seller' },
  priceRaw: 1_000_000n,
  offerId: 'offer-1',
  callId: `call-${(calls += 1)}`,
  ...over,
});

test('sponsorConfig is off unless enabled with a start, and clamps the credit to 2 USDC', () => {
  assert.equal(sponsorConfig({}), null);
  assert.equal(sponsorConfig({ CITY_SFP_ENABLED: '1' }), null, 'no start: off');
  assert.equal(sponsorConfig({ CITY_SFP_ENABLED: 'true', CITY_SFP_START_MS: String(START) }), null);
  const config = sponsorConfig({
    CITY_SFP_ENABLED: '1',
    CITY_SFP_START_MS: String(START),
    CITY_SFP_CREDIT_MAX_RAW: '9000000',
  })!;
  assert.equal(config.creditMaxRaw, SFP_CREDIT_CEILING_RAW);
  assert.equal(config.dailyBudgetRaw, 1_000_000_000_000n);
  assert.equal(config.ownerDailyMax, 1);
  // Unset: a first service up to 2 USDC, fee included.
  const plain = sponsorConfig({ CITY_SFP_ENABLED: '1', CITY_SFP_START_MS: String(START) })!;
  assert.equal(plain.creditMaxRaw, 2_000_000n);
  // The fleets' own limit: unset follows the normal limit; set, it is clamped to 40 USDC.
  assert.equal(plain.fleetCreditMaxRaw, 2_000_000n);
  const lower = sponsorConfig({
    CITY_SFP_ENABLED: '1',
    CITY_SFP_START_MS: String(START),
    CITY_SFP_CREDIT_MAX_RAW: '500000',
  })!;
  assert.equal(lower.fleetCreditMaxRaw, 500_000n, 'unset: the normal limit, whatever it is');
  const fleet = (raw: string) =>
    sponsorConfig({
      CITY_SFP_ENABLED: '1',
      CITY_SFP_START_MS: String(START),
      CITY_SFP_FLEET_CREDIT_MAX_RAW: raw,
    })!;
  assert.equal(fleet('20000000').fleetCreditMaxRaw, 20_000_000n);
  assert.equal(fleet('20000000').creditMaxRaw, 2_000_000n, 'real users stay at 2 USDC');
  assert.equal(fleet('40000000').fleetCreditMaxRaw, 40_000_000n);
  assert.equal(fleet('40000000').creditMaxRaw, 2_000_000n, 'real users stay at 2 USDC');
  assert.equal(SFP_FLEET_CREDIT_CEILING_RAW, 40_000_000n);
  assert.equal(fleet('40000001').fleetCreditMaxRaw, 40_000_000n);
  assert.equal(fleet('90000000').fleetCreditMaxRaw, SFP_FLEET_CREDIT_CEILING_RAW);
  assert.equal(fleet('abc').fleetCreditMaxRaw, 2_000_000n, 'unreadable: the normal limit');
});

test('fleet credit limit: fleet agents buy up to CITY_SFP_FLEET_CREDIT_MAX_RAW, real users stay at 2 USDC', async (t) => {
  const f = await setup(t, {
    CITY_SFP_FLEET_WORKSPACES: 'ws-fleet-o',
    CITY_SFP_FLEET_OFFERS: 'offer-20',
    CITY_SFP_FLEET_CREDIT_MAX_RAW: '40000000',
    CITY_SFP_DAILY_BUDGET_RAW: '1000000000000',
  });
  await f.owner('owner-fleet', { verified: false });
  const fleetBuy = (agentId: string, priceRaw: bigint) =>
    request(agentId, {
      operatorId: 'ws-fleet-o',
      ownerAccountId: 'owner-fleet',
      offerId: 'offer-20',
      priceRaw,
    });
  await f.rawAgent('f20');
  assert.deepEqual(await f.credits.reserve(fleetBuy('f20', 40_000_000n)), { ok: true });
  const held = await f.pg.query<{ amount_raw: string; fleet: boolean }>(
    "SELECT amount_raw::text AS amount_raw, fleet FROM feed_pay_sponsor_credits WHERE agent_id = 'f20'",
  );
  assert.equal(held.rows[0]!.amount_raw, '40000000', 'the 40 USDC credit fits the table');
  assert.equal(held.rows[0]!.fleet, true, 'stored as a fleet credit, from the server config');
  await f.rawAgent('f21');
  assert.deepEqual(await f.credits.reserve(fleetBuy('f21', 40_000_001n)), {
    ok: false,
    reason: 'over_price',
  });
  // A real user with the same price is refused: the fleets' limit is theirs alone.
  await f.agent('u20');
  assert.deepEqual(await f.credits.reserve(request('u20', { priceRaw: 40_000_000n })), {
    ok: false,
    reason: 'over_price',
  });
  assert.deepEqual(await f.credits.reserve(request('u20', { priceRaw: 2_000_001n })), {
    ok: false,
    reason: 'over_price',
  });
  assert.deepEqual(await f.credits.reserve(request('u20', { priceRaw: 2_000_000n })), { ok: true });
  const user = await f.pg.query<{ fleet: boolean }>(
    "SELECT fleet FROM feed_pay_sponsor_credits WHERE agent_id = 'u20'",
  );
  assert.equal(user.rows[0]!.fleet, false, "a real user's credit is never stored as fleet");
  // The day's budget counts the 40 USDC credit like any other.
  const day = await f.pg.query<{ spent: string }>(
    'SELECT spent_raw::text AS spent FROM feed_pay_sponsor_days',
  );
  assert.equal(day.rows[0]!.spent, '42000000');
});

test('migration 307: fleet CHECKs up to 40 USDC, real users still 2 USDC; old rows stay', async (t) => {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(FEED_PAY_SPONSOR_SQL);
  await pg.exec(FEED_PAY_SPONSORED_SQL);
  await pg.exec(FEED_PAY_SPONSOR_FLEET_CEILING_SQL);
  await pg.exec(
    `INSERT INTO feed_pay_sponsor_credits
       (agent_id, chain_id, owner_account_id, call_id, amount_raw, state, created_at, updated_at, fleet)
     VALUES ('old-fleet', 8453, 'o', 'c-old-fleet', 20000000, 'used', 1, 1, true)`,
  );
  await pg.exec(FEED_PAY_SPONSOR_FLEET_CEILING_40_SQL);
  const credit = (id: string, raw: number, fleet: boolean) =>
    pg.query(
      `INSERT INTO feed_pay_sponsor_credits
         (agent_id, chain_id, owner_account_id, call_id, amount_raw, state, created_at, updated_at, fleet)
       VALUES ($1, 8453, 'o', $2, $3, 'reserved', 1, 1, $4)`,
      [id, `c-${id}`, raw, fleet],
    );
  await credit('fleet-40', 40_000_000, true);
  await assert.rejects(credit('fleet-over', 40_000_001, true), /check/i, 'a fleet: 40 USDC');
  await credit('user-2', 2_000_000, false);
  await assert.rejects(credit('user-over', 2_000_001, false), /check/i, 'a real user: 2 USDC');
  await assert.rejects(credit('user-40', 40_000_000, false), /check/i);
  const call = (id: string, raw: number, fleet: boolean) =>
    pg.query(
      `INSERT INTO feed_pay_sponsored_calls (call_id, owner_account_id, idempotency_key,
         request_hash, operator_id, agent_id, service_id, offer_id, offer_kind, offer_version,
         pay_to, gross_raw, fee_raw, input, state, op_key, created_at, updated_at, fleet)
       VALUES ($1, 'o', $1, 'h', 'w', 'a', 's', 'f', 'k', 1, '0x1', $2, 1, '', 'reserved', $1, 1, 1, $3)`,
      [id, raw, fleet],
    );
  await call('call-fleet-40', 40_000_000, true);
  await assert.rejects(call('call-fleet-over', 40_000_001, true), /check/i);
  await assert.rejects(call('call-user-40', 40_000_000, false), /check/i);
  await assert.rejects(call('call-user-over', 2_000_001, false), /check/i);
  await call('call-user-2', 2_000_000, false);
  // Running it again changes nothing.
  await pg.exec(FEED_PAY_SPONSOR_FLEET_CEILING_40_SQL);
  const { rows } = await pg.query<{ n: number }>(
    'SELECT COUNT(*)::int AS n FROM feed_pay_sponsor_credits',
  );
  assert.equal(rows[0]!.n, 3);
});

test('migration 260: kind-specific CHECKs, 2 USDC unless fleet, fleet up to 20 USDC; old rows stay', async (t) => {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(FEED_PAY_SPONSOR_SQL);
  await pg.exec(FEED_PAY_SPONSORED_SQL);
  // A row an older build wrote (no fleet column yet).
  await pg.exec(
    "INSERT INTO feed_pay_sponsor_credits VALUES ('old', 8453, 'o', 'c-old', 2000000, 'used', 1, 1)",
  );
  await pg.exec(FEED_PAY_SPONSOR_FLEET_CEILING_SQL);
  const old = await pg.query<{ fleet: boolean }>(
    "SELECT fleet FROM feed_pay_sponsor_credits WHERE agent_id = 'old'",
  );
  assert.equal(old.rows[0]!.fleet, false, 'existing rows are real-user kind');
  const credit = (id: string, raw: number, fleet?: boolean) =>
    fleet === undefined
      ? // An older build's insert: no fleet column, so the default (false) applies.
        pg.query(
          `INSERT INTO feed_pay_sponsor_credits VALUES ($1, 8453, 'o', $2, $3, 'reserved', 1, 1)`,
          [id, `c-${id}`, raw],
        )
      : pg.query(
          `INSERT INTO feed_pay_sponsor_credits
             (agent_id, chain_id, owner_account_id, call_id, amount_raw, state, created_at, updated_at, fleet)
           VALUES ($1, 8453, 'o', $2, $3, 'reserved', 1, 1, $4)`,
          [id, `c-${id}`, raw, fleet],
        );
  await credit('user-2', 2_000_000, false);
  await assert.rejects(credit('user-over', 2_000_001, false), /check/i, 'a real user: 2 USDC');
  await assert.rejects(credit('user-20', 20_000_000, false), /check/i);
  await assert.rejects(credit('legacy-20', 20_000_000), /check/i, 'an older build: 2 USDC');
  await credit('legacy-2', 2_000_000);
  await credit('fleet-20', 20_000_000, true);
  await assert.rejects(credit('fleet-over', 20_000_001, true), /check/i, 'a fleet: 20 USDC');
  await assert.rejects(credit('fleet-zero', 0, true), /check/i);
  // A credit's kind cannot be flipped to hide a dear amount, nor a real user's raised past 2.
  await assert.rejects(
    pg.query("UPDATE feed_pay_sponsor_credits SET fleet = false WHERE agent_id = 'fleet-20'"),
    /check/i,
  );
  await assert.rejects(
    pg.query("UPDATE feed_pay_sponsor_credits SET amount_raw = 3000000 WHERE agent_id = 'user-2'"),
    /check/i,
  );
  // The sponsored call row: the same kind-specific bound.
  const call = (id: string, raw: number, fleet: boolean) =>
    pg.query(
      `INSERT INTO feed_pay_sponsored_calls (call_id, owner_account_id, idempotency_key,
         request_hash, operator_id, agent_id, service_id, offer_id, offer_kind, offer_version,
         pay_to, gross_raw, fee_raw, input, state, op_key, created_at, updated_at, fleet)
       VALUES ($1, 'o', $1, 'h', 'w', 'a', 's', 'f', 'k', 1, '0x1', $2, 1, '', 'reserved', $1, 1, 1, $3)`,
      [id, raw, fleet],
    );
  await call('call-fleet-20', 20_000_000, true);
  await assert.rejects(call('call-fleet-over', 20_000_001, true), /check/i);
  await assert.rejects(call('call-user-20', 20_000_000, false), /check/i);
  await call('call-user-2', 2_000_000, false);
  // Running it again changes nothing (columns IF NOT EXISTS, constraints replaced by name).
  await pg.exec(FEED_PAY_SPONSOR_FLEET_CEILING_SQL);
  const { rows } = await pg.query<{ n: number }>(
    'SELECT COUNT(*)::int AS n FROM feed_pay_sponsor_credits',
  );
  assert.equal(
    rows[0]!.n,
    4,
    'old, user-2, legacy-2 and fleet-20; every refused one wrote nothing',
  );
});

test('one credit per eligible agent: reserved once, released and reserved again, used for good', async (t) => {
  const f = await setup(t);
  await f.agent('a1');
  const first = request('a1');
  assert.deepEqual(await f.credits.reserve(first), { ok: true });
  assert.deepEqual(await f.credits.reserve(request('a1')), { ok: false, reason: 'used' });
  assert.equal(await f.credits.release(first.callId), true);
  const second = request('a1');
  assert.deepEqual(await f.credits.reserve(second), { ok: true });
  assert.equal(await f.credits.use(second.callId), true);
  assert.equal(await f.credits.use(second.callId), false, 'idempotent');
  assert.equal(await f.credits.release(second.callId), false, 'a used credit never comes back');
  assert.deepEqual(await f.credits.reserve(request('a1')), { ok: false, reason: 'used' });
});

test('refusals: disabled, not eligible, over price, self-dealing, per-owner day, budget', async (t) => {
  const f = await setup(t);
  await f.agent('old', 'confirmed', START - 1);
  await f.agent('pending', 'submitted');
  await f.agent('noid', 'confirmed', START + 1, null);
  for (const id of ['a', 'b', 'c', 'd', 'e', 'g']) await f.agent(id);
  const no = (reason: string) => ({ ok: false, reason });
  assert.deepEqual(await f.credits.reserve(request('old')), no('not_eligible'));
  assert.deepEqual(await f.credits.reserve(request('pending')), no('not_eligible'));
  assert.deepEqual(await f.credits.reserve(request('noid')), no('not_eligible'));
  await f.owner('owner-nobody');
  assert.deepEqual(await f.credits.reserve(request('nobody')), no('not_eligible'));
  assert.deepEqual(
    await f.credits.reserve(request('a', { priceRaw: 2_000_001n })),
    no('over_price'),
  );
  const self = (seller: Partial<SponsorRequest['seller']>) =>
    request('a', { seller: { operatorId: 'x', ownerAccountId: 'y', agentId: 'z', ...seller } });
  assert.deepEqual(await f.credits.reserve(self({ agentId: 'a' })), no('self_dealing'));
  // A seller whose owner is unknown: refused (fail closed).
  assert.deepEqual(await f.credits.reserve(self({ ownerAccountId: null })), no('self_dealing'));
  assert.deepEqual(await f.credits.reserve(self({ operatorId: 'ws-a' })), no('self_dealing'));
  assert.deepEqual(
    await f.credits.reserve(self({ ownerAccountId: 'owner-a' })),
    no('self_dealing'),
  );
  // One owner, two credits a day (setting 2): the third agent of that owner is refused.
  const owner = { ownerAccountId: 'owner-shared' };
  assert.deepEqual(await f.credits.reserve(request('a', owner)), { ok: true });
  assert.deepEqual(await f.credits.reserve(request('b', owner)), { ok: true });
  assert.deepEqual(await f.credits.reserve(request('c', owner)), no('owner_daily'));
  // Budget 5 USDC a day: 2 spent above, 2 more fit, the last one does not.
  assert.deepEqual(await f.credits.reserve(request('c', { priceRaw: 2_000_000n })), { ok: true });
  assert.deepEqual(await f.credits.reserve(request('d', { priceRaw: 1_000_000n })), { ok: true });
  assert.deepEqual(await f.credits.reserve(request('e', { priceRaw: 1_000_000n })), no('budget'));
  // The next UTC day has a fresh budget.
  f.clock.now += 86_400_000;
  assert.deepEqual(await f.credits.reserve(request('e', { priceRaw: 1_000_000n })), { ok: true });
  f.env.CITY_SFP_ENABLED = '0';
  assert.deepEqual(await f.credits.reserve(request('g')), no('disabled'));
  const stats = await f.credits.stats();
  assert.equal(stats.enabled, false);
  assert.ok((stats.last_60_min.refused_by_code.disabled ?? 0) >= 1);
});

test('two calls for the same credit at once: exactly one holds it', async (t) => {
  const f = await setup(t);
  await f.agent('a1');
  const results = await Promise.all([
    f.credits.reserve(request('a1')),
    f.credits.reserve(request('a1')),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1);
});

test('GET /api/ops/sfp/stats: 404 without the ops secret, numbers with it', async (t) => {
  const f = await setup(t);
  await f.agent('a1');
  const r = request('a1');
  await f.credits.reserve(r);
  await f.credits.use(r.callId);
  const app = Fastify();
  t.after(() => app.close());
  registerSponsorStatsRoute(app, { db: f.db, env: f.env, now: () => f.clock.now });
  assert.equal((await app.inject({ url: SFP_STATS_PATH })).statusCode, 404);
  assert.equal(
    (await app.inject({ url: SFP_STATS_PATH, headers: { authorization: 'Bearer wrong' } }))
      .statusCode,
    404,
  );
  const res = await app.inject({
    url: SFP_STATS_PATH,
    headers: { authorization: `Bearer ${SECRET}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.enabled, true);
  assert.equal(body.last_10_min.used, 1);
  assert.equal(body.last_10_min.used_raw, '1000000');
  assert.equal(body.budget_left_raw, '4000000');
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('sybil guard: only agents of verified, onboarded owners hold a credit', async (t) => {
  const f = await setup(t);
  await f.rawAgent('u1');
  await f.owner('owner-u1', { verified: false });
  await f.rawAgent('p1');
  await f.owner('owner-p1', { salt: GOOGLE_SALT_PENDING_NAME });
  await f.rawAgent('ghost');
  const no = { ok: false, reason: 'unverified_owner' };
  assert.deepEqual(await f.credits.reserve(request('u1')), no, 'no verified identity');
  assert.deepEqual(await f.credits.reserve(request('p1')), no, 'onboarding pending');
  assert.deepEqual(await f.credits.reserve(request('ghost')), no, 'no such owner account');
  await f.agent('ok1');
  assert.deepEqual(await f.credits.reserve(request('ok1')), { ok: true });
});

test('stress-test fleets: every agent of an allowlisted workspace gets its own sponsored first purchase', async (t) => {
  const f = await setup(t, {
    CITY_SFP_FLEET_WORKSPACES: 'ws-fleet-o, ws-fleet-p',
    CITY_SFP_FLEET_OFFERS: 'offer-chosen',
    CITY_SFP_DAILY_BUDGET_RAW: '1000000000000',
  });
  // One unverified owner (no Google identity) runs the fleet; its agents buy from another fleet.
  await f.owner('owner-fleet', { verified: false });
  const fleetBuy = (agentId: string, seller = 'ws-fleet-p') =>
    request(agentId, {
      operatorId: 'ws-fleet-o',
      ownerAccountId: 'owner-fleet',
      seller: { operatorId: seller, ownerAccountId: 'owner-fleet', agentId: 'fleet-seller' },
      offerId: 'offer-chosen',
    });
  // Only the services Central City chose: any other offer is refused for fleet agents.
  await f.rawAgent('fz');
  assert.deepEqual(await f.credits.reserve({ ...fleetBuy('fz'), offerId: 'offer-other' }), {
    ok: false,
    reason: 'service_not_allowed',
  });
  assert.deepEqual(await f.credits.reserve(fleetBuy('fz')), { ok: true }, 'the chosen one works');
  for (let i = 0; i < 5; i += 1) {
    await f.rawAgent(`fa${i}`);
    assert.deepEqual(await f.credits.reserve(fleetBuy(`fa${i}`)), { ok: true }, `agent ${i}`);
  }
  // Still one credit per agent, and the 2 USDC ceiling holds for fleets too.
  assert.deepEqual(await f.credits.reserve(fleetBuy('fa0')), { ok: false, reason: 'used' });
  await f.rawAgent('fa9');
  assert.deepEqual(await f.credits.reserve({ ...fleetBuy('fa9'), priceRaw: 2_000_001n }), {
    ok: false,
    reason: 'over_price',
  });
  // A fleet buyer paying a seller of the same owner OUTSIDE the fleets is still self-dealing.
  assert.deepEqual(await f.credits.reserve(fleetBuy('fa9', 'ws-private')), {
    ok: false,
    reason: 'self_dealing',
  });
  // Outside the allowlist nothing changes: the same unverified owner gets nothing.
  await f.rawAgent('px');
  assert.deepEqual(
    await f.credits.reserve(
      request('px', { operatorId: 'ws-other', ownerAccountId: 'owner-fleet' }),
    ),
    { ok: false, reason: 'unverified_owner' },
  );
});

test('daily budget: one day row, a released credit gives its amount back, a used one never', async (t) => {
  const f = await setup(t, {
    CITY_SFP_DAILY_BUDGET_RAW: '3000000',
    CITY_SFP_OWNER_DAILY_MAX: '10',
  });
  const day = async () =>
    (
      await f.pg.query<{ spent: string; credits: number }>(
        'SELECT spent_raw::text AS spent, credits FROM feed_pay_sponsor_days',
      )
    ).rows;
  for (const id of ['b1', 'b2', 'b3']) await f.agent(id);
  const one = request('b1', { priceRaw: 2_000_000n });
  assert.deepEqual(await f.credits.reserve(one), { ok: true });
  assert.deepEqual(await day(), [{ spent: '2000000', credits: 1 }]);
  // 2 + 1.5 > 3 USDC: refused, and the day row is unchanged.
  assert.deepEqual(await f.credits.reserve(request('b2', { priceRaw: 1_500_000n })), {
    ok: false,
    reason: 'budget',
  });
  assert.deepEqual(await day(), [{ spent: '2000000', credits: 1 }]);
  // Released: the 2 USDC come back, the next one fits.
  assert.equal(await f.credits.release(one.callId), true);
  assert.deepEqual(await day(), [{ spent: '0', credits: 0 }]);
  const two = request('b2', { priceRaw: 1_500_000n });
  assert.deepEqual(await f.credits.reserve(two), { ok: true });
  assert.equal(await f.credits.use(two.callId), true);
  assert.equal(await f.credits.release(two.callId), false, 'a used credit is never released');
  assert.deepEqual(await day(), [{ spent: '1500000', credits: 1 }]);
  assert.equal((await f.credits.stats()).budget_left_raw, '1500000');
});

test('reserve(within): the caller writes in the same transaction; a refusal or an error writes nothing', async (t) => {
  const f = await setup(t);
  for (const id of ['w1', 'w2', 'w3']) await f.agent(id);
  await f.pg.exec('CREATE TABLE side (call_id text PRIMARY KEY)');
  const count = async (table: string) =>
    (await f.pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;
  // A refusal from within: nothing reserved, nothing counted against the day.
  assert.deepEqual(await f.credits.reserve(request('w1'), async () => 'paused'), {
    ok: false,
    reason: 'paused',
  });
  assert.equal(await count('feed_pay_sponsor_credits'), 0);
  assert.equal(await count('feed_pay_sponsor_days'), 0);
  // An error after the caller's own write: everything rolls back together.
  await assert.rejects(
    f.credits.reserve(request('w2'), async (tx) => {
      await tx.query("INSERT INTO side VALUES ('x')");
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(await count('side'), 0);
  assert.equal(await count('feed_pay_sponsor_credits'), 0);
  // Success: the caller's row and the credit commit together.
  const r = request('w3');
  assert.deepEqual(
    await f.credits.reserve(r, async (tx) => {
      await tx.query('INSERT INTO side VALUES ($1)', [r.callId]);
    }),
    { ok: true },
  );
  assert.equal(await count('side'), 1);
  assert.equal(await count('feed_pay_sponsor_credits'), 1);
});

test('real users: their credit buys only Central City services (CITY_SFP_OFFERS)', async (t) => {
  const f = await setup(t);
  await f.agent('u1');
  assert.deepEqual(await f.credits.reserve(request('u1', { offerId: 'someone-elses' })), {
    ok: false,
    reason: 'service_not_allowed',
  });
  assert.deepEqual(await f.credits.reserve(request('u1')), { ok: true }, 'offer-1 is listed');
  f.env.CITY_SFP_OFFERS = '';
  await f.agent('u2');
  assert.deepEqual(await f.credits.reserve(request('u2')), {
    ok: false,
    reason: 'service_not_allowed',
  });
});

test('status: each agent of an owner reads available, in_progress, used or unavailable with the reason', async (t) => {
  const { credits, rawAgent, owner, env } = await setup(t, { CITY_SFP_OWNER_DAILY_MAX: '5' });
  await owner('owner-z');
  for (const id of ['z-free', 'z-held', 'z-used']) await rawAgent(id);
  await rawAgent('z-old', 'confirmed', START - 1); // registered before the start: never eligible
  const ask = () =>
    credits.status({
      ownerAccountId: 'owner-z',
      chainId: CHAIN,
      agents: ['z-free', 'z-held', 'z-used', 'z-old'].map((agentId) => ({
        agentId,
        operatorId: 'ws-z',
      })),
    });
  const owned = (id: string) => request(id, { ownerAccountId: 'owner-z', operatorId: 'ws-z' });
  assert.deepEqual((await credits.reserve(owned('z-held'))).ok, true);
  const used = owned('z-used');
  assert.equal((await credits.reserve(used)).ok, true);
  assert.equal(await credits.use(used.callId), true);
  const s = await ask();
  assert.deepEqual(s.get('z-free'), { credit: 'available' });
  assert.deepEqual(s.get('z-held'), { credit: 'in_progress' });
  assert.deepEqual(s.get('z-used'), { credit: 'used' });
  assert.deepEqual(s.get('z-old'), { credit: 'unavailable', reason: 'not_eligible' });
  // Read only: asking never takes or changes a credit.
  assert.deepEqual((await ask()).get('z-free'), { credit: 'available' });
  assert.equal((await credits.reserve(owned('z-free'))).ok, true);
  // Off: every agent reads unavailable (disabled).
  env.CITY_SFP_ENABLED = '0';
  assert.deepEqual((await ask()).get('z-free'), { credit: 'unavailable', reason: 'disabled' });
});

test('status: an unverified owner reads unavailable (unverified_owner); a fleet workspace skips that check', async (t) => {
  const { credits, rawAgent, owner } = await setup(t, { CITY_SFP_FLEET_WORKSPACES: 'ws-fleet' });
  await owner('owner-u', { verified: false });
  await rawAgent('u-1');
  await rawAgent('f-1');
  const s = await credits.status({
    ownerAccountId: 'owner-u',
    chainId: CHAIN,
    agents: [
      { agentId: 'u-1', operatorId: 'ws-u' },
      { agentId: 'f-1', operatorId: 'ws-fleet' },
    ],
  });
  assert.deepEqual(s.get('u-1'), { credit: 'unavailable', reason: 'unverified_owner' });
  assert.deepEqual(s.get('f-1'), { credit: 'available' });
});

test('status: an owner at its daily maximum reads unavailable (owner_daily) for its other agents', async (t) => {
  const { credits, rawAgent, owner } = await setup(t, { CITY_SFP_OWNER_DAILY_MAX: '1' });
  await owner('owner-d');
  await rawAgent('d-1');
  await rawAgent('d-2');
  assert.equal(
    (await credits.reserve(request('d-1', { ownerAccountId: 'owner-d', operatorId: 'ws-d' }))).ok,
    true,
  );
  const s = await credits.status({
    ownerAccountId: 'owner-d',
    chainId: CHAIN,
    agents: [
      { agentId: 'd-1', operatorId: 'ws-d' },
      { agentId: 'd-2', operatorId: 'ws-d' },
    ],
  });
  assert.deepEqual(s.get('d-1'), { credit: 'in_progress' });
  assert.deepEqual(s.get('d-2'), { credit: 'unavailable', reason: 'owner_daily' });
});
