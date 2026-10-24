/**
 * The sponsored first purchase (room Stress Test #290/#297): Central City pays, from its own
 * sponsor account, for ONE fee-included purchase of a Central City agent service per new Base
 * agent, up to a small price. The agent is the buyer of record; no money ever reaches its wallet,
 * so nothing can be withdrawn. Opt-in per call (use_credit) and never charged to the agent.
 *
 * The credit is implicit: an agent whose Base identity is confirmed (passport final) and was
 * started at or after CITY_SFP_START_MS holds one. It is recorded only when used, so creating an
 * agent writes nothing here. This module decides and records the credit (reserve, use, release)
 * under one advisory lock with every cap; paying from the sponsor is the engine's (a later change).
 *
 * Off unless CITY_SFP_ENABLED is exactly '1' and CITY_SFP_START_MS is set (read per call).
 */
import type { Database, Transaction } from '../../database.js';
import { assertOnboarded } from '../../onboarding.js';

type Env = Record<string, string | undefined>;

export const SFP_ENABLED_SETTING = 'CITY_SFP_ENABLED';
export const SFP_START_SETTING = 'CITY_SFP_START_MS';
export const SFP_CREDIT_MAX_SETTING = 'CITY_SFP_CREDIT_MAX_RAW';
export const SFP_DAILY_BUDGET_SETTING = 'CITY_SFP_DAILY_BUDGET_RAW';
export const SFP_OWNER_DAILY_SETTING = 'CITY_SFP_OWNER_DAILY_MAX';
/**
 * Central City's own stress-test fleets: workspace ids (operator_id) whose EVERY
 * agent gets its first purchase sponsored. For a buyer in one of them the per-owner daily count
 * and the verified-owner check do not apply (one owner runs thousands of agents), and a seller in
 * one of them is not self-dealing (Central City's money stays with Central City's own fleets).
 * The price ceiling, single use and the daily budget still apply.
 */
export const SFP_FLEET_WORKSPACES_SETTING = 'CITY_SFP_FLEET_WORKSPACES';
/**
 * The services those fleets may buy with the credit ("they just buy services we
 * choose"): offer ids (city_offers.offer_id). A fleet agent's sponsored purchase of anything else
 * is refused (service_not_allowed); with the list empty, fleet agents buy nothing sponsored.
 */
export const SFP_FLEET_OFFERS_SETTING = 'CITY_SFP_FLEET_OFFERS';
/**
 * The services real users (outside the fleets) may buy with their credit: Central City's own
 * services only (two colluding accounts could otherwise each list a
 * service and buy the other's). Offer ids; empty: no sponsored purchase for real users.
 */
export const SFP_OFFERS_SETTING = 'CITY_SFP_OFFERS';

/**
 * Defaults: a credit covers a first service up to 2 USDC, fee included; 1,000,000
 * USDC a day in all (the stress test runs through it too); one credit per owner a day.
 */
export const SFP_CREDIT_MAX_DEFAULT_RAW = 2_000_000n;
/** The hard ceiling of a credit (also the table's CHECK): 2 USDC, fee included. */
export const SFP_CREDIT_CEILING_RAW = 2_000_000n;
export const SFP_DAILY_BUDGET_DEFAULT_RAW = 1_000_000_000_000n;
export const SFP_OWNER_DAILY_DEFAULT = 1;
const DAY_MS = 86_400_000;
const LOCK = "SELECT pg_advisory_xact_lock(hashtext('feed_pay_sponsor'))";

export interface SponsorConfig {
  startMs: number;
  creditMaxRaw: bigint;
  dailyBudgetRaw: bigint;
  ownerDailyMax: number;
  fleetWorkspaces: Set<string>;
  fleetOffers: Set<string>;
  offers: Set<string>;
}

const idList = (raw: string | undefined) =>
  new Set(
    (raw ?? '')
      .split(/[\s,]+/)
      .map((id) => id.trim())
      .filter(Boolean),
  );

const rawSetting = (raw: string | undefined, fallback: bigint, ceiling?: bigint) => {
  if (!raw || !/^[1-9]\d{0,17}$/.test(raw.trim())) return fallback;
  const value = BigInt(raw.trim());
  return ceiling !== undefined && value > ceiling ? ceiling : value;
};

/** The live configuration, or null while the sponsored purchase is off. */
export function sponsorConfig(env: Env): SponsorConfig | null {
  if (env[SFP_ENABLED_SETTING] !== '1') return null;
  const start = env[SFP_START_SETTING]?.trim();
  if (!start || !/^[1-9]\d{9,15}$/.test(start)) return null;
  const owner = env[SFP_OWNER_DAILY_SETTING]?.trim();
  return {
    startMs: Number(start),
    creditMaxRaw: rawSetting(
      env[SFP_CREDIT_MAX_SETTING],
      SFP_CREDIT_MAX_DEFAULT_RAW,
      SFP_CREDIT_CEILING_RAW,
    ),
    dailyBudgetRaw: rawSetting(env[SFP_DAILY_BUDGET_SETTING], SFP_DAILY_BUDGET_DEFAULT_RAW),
    ownerDailyMax: owner && /^[1-9]\d{0,5}$/.test(owner) ? Number(owner) : SFP_OWNER_DAILY_DEFAULT,
    fleetWorkspaces: idList(env[SFP_FLEET_WORKSPACES_SETTING]),
    fleetOffers: idList(env[SFP_FLEET_OFFERS_SETTING]),
    offers: idList(env[SFP_OFFERS_SETTING]),
  };
}

/** Why a credit was not usable; the call is refused with credit_unavailable and this reason. */
export type SponsorRefusal =
  | 'disabled'
  | 'not_eligible'
  /** The buyer's owner account has no verified (Sign in with Google) identity, or is not onboarded. */
  | 'unverified_owner'
  | 'used'
  | 'over_price'
  /** Same agent, workspace or owner as the seller, or a seller whose owner is unknown (fail closed). */
  | 'self_dealing'
  | 'owner_daily'
  /** A fleet agent asked for a service that is not on CITY_SFP_FLEET_OFFERS. */
  | 'service_not_allowed'
  /** The sponsor cannot pay it now (low ETH or USDC): first buys wait, nothing is held. */
  | 'paused'
  | 'budget';

export interface SponsorRequest {
  agentId: string;
  chainId: number;
  /**
   * The buyer's workspace and owner account (the paying agent's). ownerAccountId is the agent
   * wallet's base_wallets.owner_account_id, which REFERENCES operators(id) (server/base/schema.ts):
   * the same operator id elric_verified_identities and the onboarding gate are keyed by.
   */
  operatorId: string;
  ownerAccountId: string;
  /** The service's seller: its workspace and the owner account of its wallet. */
  seller: { operatorId: string; ownerAccountId: string | null; agentId: string };
  /** The hosted offer bought (city_offers.offer_id). */
  offerId: string;
  /** Total price, fee included. */
  priceRaw: bigint;
  callId: string;
}

/** UTC day start of `at`. */
const dayStart = (at: number) => at - (at % DAY_MS);

export function createSponsorCredits(deps: { db: Database; env: Env; now: () => number }) {
  const refused = async (code: SponsorRefusal) => {
    const at = deps.now();
    await deps.db
      .query(
        `INSERT INTO feed_pay_sponsor_refusals (minute, code, n) VALUES ($1, $2, 1)
         ON CONFLICT (minute, code) DO UPDATE SET n = feed_pay_sponsor_refusals.n + 1`,
        [at - (at % 60_000), code],
      )
      .catch(() => {});
    return { ok: false as const, reason: code };
  };

  /**
   * Holds the agent's credit for this call, or says why not. Every check runs under one advisory
   * lock in one transaction, so two calls can never both take the credit or the last budget.
   */
  async function reserve(
    request: SponsorRequest,
    /**
     * Runs inside the same transaction and lock once every credit check passed, before anything
     * is written: the caller's own checks and writes (the sponsored call row, room SFP #11 C2), so
     * the credit and its call commit together or not at all. A refusal it answers writes nothing.
     */
    within?: (tx: Transaction) => Promise<SponsorRefusal | void>,
  ): Promise<{ ok: true } | { ok: false; reason: SponsorRefusal }> {
    const config = sponsorConfig(deps.env);
    if (!config) return refused('disabled');
    if (request.priceRaw <= 0n || request.priceRaw > config.creditMaxRaw)
      return refused('over_price');
    const fleet = config.fleetWorkspaces.has(request.operatorId);
    const sellerFleet = config.fleetWorkspaces.has(request.seller.operatorId);
    // Fleet agents buy only the services Central City chose for them.
    if (fleet && !config.fleetOffers.has(request.offerId)) return refused('service_not_allowed');
    // Real users: only Central City's own services (no farming between colluding accounts).
    if (!fleet && !config.offers.has(request.offerId)) return refused('service_not_allowed');
    if (
      request.seller.agentId === request.agentId ||
      (!(fleet && sellerFleet) &&
        (request.seller.operatorId === request.operatorId ||
          request.seller.ownerAccountId === null ||
          request.seller.ownerAccountId === request.ownerAccountId))
    )
      return refused('self_dealing');
    const at = deps.now();
    const outcome = await deps.db.transaction(async (tx) => {
      // Sybil guard: credits go only to agents of verified, onboarded humans, so many
      // fresh owner accounts do not mean many credits. Read before the lock, to keep it short.
      if (!fleet) {
        const verified = await tx.query(
          'SELECT 1 FROM elric_verified_identities WHERE operator_id = $1',
          [request.ownerAccountId],
        );
        if (verified.rows.length === 0) return 'unverified_owner' as const;
        try {
          await assertOnboarded(tx, request.ownerAccountId);
        } catch {
          return 'unverified_owner' as const;
        }
      }
      // One more global lock (like feed_pay_unfinal): its wait is bounded here, whatever the
      // pooler does with the session's own lock_timeout (#551), and the transaction stays tiny.
      await tx.query("SET LOCAL lock_timeout = '5s'");
      await tx.query(LOCK);
      const eligible = await tx.query(
        `SELECT 1 FROM base_identities
         WHERE agent_id = $1 AND chain_id = $2 AND state = 'confirmed'
           AND erc8004_agent_id IS NOT NULL AND started_at >= $3`,
        [request.agentId, request.chainId, config.startMs],
      );
      if (eligible.rows.length === 0) return 'not_eligible' as const;
      const held = await tx.query<{ state: string }>(
        'SELECT state FROM feed_pay_sponsor_credits WHERE agent_id = $1',
        [request.agentId],
      );
      if (held.rows[0] && held.rows[0].state !== 'released') return 'used' as const;
      const today = dayStart(at);
      // Per owner (real users only): their own few credits today, through the owner index.
      if (!fleet) {
        const { rows: owned } = await tx.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM feed_pay_sponsor_credits
           WHERE owner_account_id = $1 AND created_at >= $2 AND state <> 'released'`,
          [request.ownerAccountId, today],
        );
        if (Number(owned[0]!.n) >= config.ownerDailyMax) return 'owner_daily' as const;
      }
      // The day's budget: one row, never a sum over the day's credits.
      const { rows: day } = await tx.query<{ spent: string }>(
        'SELECT spent_raw::text AS spent FROM feed_pay_sponsor_days WHERE day = $1',
        [today],
      );
      if (BigInt(day[0]?.spent ?? '0') + request.priceRaw > config.dailyBudgetRaw)
        return 'budget' as const;
      const theirs = within ? await within(tx) : undefined;
      if (theirs) return theirs;
      await tx.query(
        `INSERT INTO feed_pay_sponsor_days (day, spent_raw, credits) VALUES ($1, $2, 1)
         ON CONFLICT (day) DO UPDATE SET spent_raw = feed_pay_sponsor_days.spent_raw + $2,
           credits = feed_pay_sponsor_days.credits + 1`,
        [today, request.priceRaw.toString()],
      );
      await tx.query(
        `INSERT INTO feed_pay_sponsor_credits
           (agent_id, chain_id, owner_account_id, call_id, amount_raw, state, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'reserved', $6, $6)
         ON CONFLICT (agent_id) DO UPDATE SET chain_id = $2, owner_account_id = $3, call_id = $4,
           amount_raw = $5, state = 'reserved', created_at = $6, updated_at = $6
         WHERE feed_pay_sponsor_credits.state = 'released'`,
        [
          request.agentId,
          request.chainId,
          request.ownerAccountId,
          request.callId,
          request.priceRaw.toString(),
          at,
        ],
      );
      return 'ok' as const;
    });
    return outcome === 'ok' ? { ok: true } : refused(outcome);
  }

  /** The call was paid: the credit is spent for good. Idempotent. */
  async function use(callId: string, tx: Transaction = deps.db): Promise<boolean> {
    const { rows } = await tx.query(
      `UPDATE feed_pay_sponsor_credits SET state = 'used', updated_at = $2
       WHERE call_id = $1 AND state = 'reserved' RETURNING agent_id`,
      [callId, deps.now()],
    );
    return rows.length > 0;
  }

  /** The call was never paid (refused, expired, unpaid): the agent may use its credit again. */
  async function release(callId: string, tx: Transaction = deps.db): Promise<boolean> {
    const { rows } = await tx.query<{ amount_raw: string; created_at: string }>(
      `UPDATE feed_pay_sponsor_credits SET state = 'released', updated_at = $2
       WHERE call_id = $1 AND state = 'reserved'
       RETURNING amount_raw::text AS amount_raw, created_at::text AS created_at`,
      [callId, deps.now()],
    );
    const released = rows[0];
    if (!released) return false;
    // Its day gets the amount back (the day it was reserved on).
    await tx.query(
      `UPDATE feed_pay_sponsor_days SET spent_raw = GREATEST(spent_raw - $2, 0),
         credits = GREATEST(credits - 1, 0)
       WHERE day = $1`,
      [dayStart(Number(released.created_at)), released.amount_raw],
    );
    return true;
  }

  /** The ops numbers (GET /api/ops/sfp/stats): the last 10 and 60 minutes, and today's budget. */
  async function stats() {
    const at = deps.now();
    const config = sponsorConfig(deps.env);
    const window = async (minutes: number) => {
      const since = at - minutes * 60_000;
      // Only this feature's own tables, by index (no scan of base_identities at fleet scale).
      const [credits, refusals] = await Promise.all([
        deps.db.query<{ state: string; n: string; raw: string }>(
          `SELECT state, COUNT(*)::text AS n, COALESCE(SUM(amount_raw), 0)::text AS raw
           FROM feed_pay_sponsor_credits WHERE updated_at >= $1 GROUP BY state`,
          [since],
        ),
        deps.db.query<{ code: string; n: string }>(
          `SELECT code, SUM(n)::text AS n FROM feed_pay_sponsor_refusals
           WHERE minute >= $1 GROUP BY code`,
          [since - (since % 60_000)],
        ),
      ]);
      const by = Object.fromEntries(credits.rows.map((r) => [r.state, r]));
      return {
        reserved: Number(by.reserved?.n ?? 0),
        used: Number(by.used?.n ?? 0),
        released: Number(by.released?.n ?? 0),
        used_raw: by.used?.raw ?? '0',
        refused_by_code: Object.fromEntries(refusals.rows.map((r) => [r.code, Number(r.n)])),
      };
    };
    const spent =
      (
        await deps.db.query<{ spent: string }>(
          'SELECT spent_raw::text AS spent FROM feed_pay_sponsor_days WHERE day = $1',
          [dayStart(at)],
        )
      ).rows[0]?.spent ?? '0';
    return {
      enabled: config !== null,
      credit_max_raw: config?.creditMaxRaw.toString() ?? null,
      budget_raw: config?.dailyBudgetRaw.toString() ?? null,
      budget_left_raw: config
        ? (config.dailyBudgetRaw > BigInt(spent)
            ? config.dailyBudgetRaw - BigInt(spent)
            : 0n
          ).toString()
        : null,
      last_10_min: await window(10),
      last_60_min: await window(60),
    };
  }

  /**
   * What each of an owner's agents can expect from its credit now, read only (no lock, nothing
   * written): reserve()'s own checks in its order, for the owner's panel and the service cards. A
   * hint, never a promise: reserve() decides under its lock (the day budget is left to it).
   */
  async function status(input: {
    ownerAccountId: string;
    chainId: number;
    agents: { agentId: string; operatorId: string }[];
  }): Promise<Map<string, SponsorCreditStatus>> {
    const out = new Map<string, SponsorCreditStatus>();
    const config = sponsorConfig(deps.env);
    if (!input.agents.length) return out;
    if (!config) {
      for (const a of input.agents)
        out.set(a.agentId, { credit: 'unavailable', reason: 'disabled' });
      return out;
    }
    const realUser = input.agents.some((a) => !config.fleetWorkspaces.has(a.operatorId));
    let verified = true;
    if (realUser) {
      const { rows } = await deps.db.query(
        'SELECT 1 FROM elric_verified_identities WHERE operator_id = $1',
        [input.ownerAccountId],
      );
      verified = rows.length > 0;
      if (verified)
        verified = await assertOnboarded(deps.db, input.ownerAccountId).then(
          () => true,
          () => false,
        );
    }
    const ids = input.agents.map((a) => a.agentId);
    const { rows: eligible } = await deps.db.query<{ agent_id: string }>(
      `SELECT agent_id FROM base_identities
       WHERE agent_id = ANY($1::text[]) AND chain_id = $2 AND state = 'confirmed'
         AND erc8004_agent_id IS NOT NULL AND started_at >= $3`,
      [ids, input.chainId, config.startMs],
    );
    const ok = new Set(eligible.map((r) => r.agent_id));
    const { rows: held } = await deps.db.query<{ agent_id: string; state: string }>(
      'SELECT agent_id, state FROM feed_pay_sponsor_credits WHERE agent_id = ANY($1::text[])',
      [ids],
    );
    const state = new Map(held.map((r) => [r.agent_id, r.state]));
    let ownerFull = false;
    if (realUser) {
      const { rows } = await deps.db.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM feed_pay_sponsor_credits
         WHERE owner_account_id = $1 AND created_at >= $2 AND state <> 'released'`,
        [input.ownerAccountId, dayStart(deps.now())],
      );
      ownerFull = Number(rows[0]?.n ?? 0) >= config.ownerDailyMax;
    }
    for (const a of input.agents) {
      const fleet = config.fleetWorkspaces.has(a.operatorId);
      const held = state.get(a.agentId);
      if (held === 'used') out.set(a.agentId, { credit: 'used' });
      else if (held === 'reserved') out.set(a.agentId, { credit: 'in_progress' });
      else if (!fleet && !verified)
        out.set(a.agentId, { credit: 'unavailable', reason: 'unverified_owner' });
      else if (!ok.has(a.agentId))
        out.set(a.agentId, { credit: 'unavailable', reason: 'not_eligible' });
      else if (!fleet && ownerFull)
        out.set(a.agentId, { credit: 'unavailable', reason: 'owner_daily' });
      else out.set(a.agentId, { credit: 'available' });
    }
    return out;
  }

  return { reserve, use, release, stats, status };
}

export type SponsorCredits = ReturnType<typeof createSponsorCredits>;

/** An agent's credit as its owner sees it (status()): unavailable carries reserve()'s reason. */
export type SponsorCreditStatus =
  | { credit: 'available' | 'in_progress' | 'used' }
  | {
      credit: 'unavailable';
      reason: 'disabled' | 'unverified_owner' | 'not_eligible' | 'owner_daily';
    };
