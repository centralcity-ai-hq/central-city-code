/**
 * The sponsored first purchase, paid (docs/protocol/SPONSORED_FIRST_PURCHASE.md, option B2): a
 * call an owner makes for one of its agents with the agent's credit (server/feed/pay/sponsor.ts).
 * Central City's sponsor account pays the whole price through fee router 3: it signs both legs
 * (sponsor-signer.ts) and a facilitator EOA sends them, batched. Which one: with
 * CITY_SFP_SEND_VIA_FACILITATOR=1 the router-3 facilitator (the engine's EOA and nonce lane, the
 * sponsored members in their own batch group 'sfp:'), so the payments count as that facilitator's;
 * otherwise the sponsor's OWN facilitator EOA (its own nonce lane), as before. The sponsor only ever
 * signs the legs (it is the payer either way). A sponsored purchase never touches an agent's wallet,
 * spend permission or float. The agent is the buyer of record; nothing is ever charged to it.
 *
 * A key is always followed and finished on the facilitator that stored it (SponsorPay.previous),
 * so switching the setting either way never strands a settlement already handed over.
 *
 * States: reserved (credit held, row stored) → sent (legs signed, settlement stored with the
 * facilitator) → paid (included on Base, credit used) → delivered | paid_no_result. A call that
 * never paid ends failed; its credit is released only once nothing signed can still move (never
 * broadcast, or past the legs' validBefore), so a credit can never be spent twice.
 *
 * Separate from engine.call on purpose: it reads the hosted offer and runs its kind through the
 * engine's own helpers (hostedForSponsor, runHostedOffer) and changes nothing on the agent path.
 */
import { randomBytes } from 'node:crypto';
import { getAddress, keccak256, stringToHex, type Hex } from 'viem';
import type { Database, Transaction } from '../../database.js';
import type { FeedPayInputs } from '../../../shared/feed-pay.js';
import { BASE_MAINNET } from '../../../shared/base/chains.js';
import { chainParams } from '../../base/chain/chain-params.js';
import type { FeedPayOp } from '../../base/chain/feed-pay-chain.js';
import { feeRef } from '../../protocol/fees/fee-call.js';
import { ROUTER3_VALIDITY_S, type BatchAuthorize, type Router3FacilitatorPort } from './router3.js';
import {
  sponsorConfig,
  type SponsorCreditStatus,
  type SponsorCredits,
  type SponsorRefusal,
} from './sponsor.js';
import type { SponsorSigner } from './sponsor-signer.js';
import { registerMigration, type Migration } from '../../migrations.js';

/** Migration 250 `feed_pay_sponsored_calls`: one new table; nothing else read or changed. */
export const FEED_PAY_SPONSORED_SQL = `
CREATE TABLE IF NOT EXISTS feed_pay_sponsored_calls (
  call_id text PRIMARY KEY,
  owner_account_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  operator_id text NOT NULL,
  agent_id text NOT NULL,
  service_id text NOT NULL,
  offer_id text NOT NULL,
  offer_kind text NOT NULL,
  offer_version integer NOT NULL,
  pay_to text NOT NULL,
  gross_raw numeric(78,0) NOT NULL CHECK (gross_raw > 0 AND gross_raw <= 2000000),
  fee_raw numeric(78,0) NOT NULL CHECK (fee_raw > 0),
  input text NOT NULL,
  state text NOT NULL CHECK (state IN ('reserved','sent','paid','delivered','paid_no_result','failed')),
  failure_code text,
  op_key text NOT NULL UNIQUE,
  valid_before bigint,
  tx_hash text,
  block_number bigint,
  result_text text,
  result_mime text,
  result_format text,
  lease_until bigint NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE (owner_account_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS feed_pay_sponsored_calls_agent ON feed_pay_sponsored_calls (agent_id);
CREATE INDEX IF NOT EXISTS feed_pay_sponsored_calls_updated ON feed_pay_sponsored_calls (updated_at);
CREATE INDEX IF NOT EXISTS feed_pay_sponsored_calls_open
  ON feed_pay_sponsored_calls (updated_at) WHERE state IN ('reserved','sent','paid');`;

export const feedPaySponsoredMigration: Migration = {
  version: 250,
  name: 'feed_pay_sponsored_calls',
  sql: FEED_PAY_SPONSORED_SQL,
};

/** Idempotent; call before runMigrations. */
export function registerFeedPaySponsoredMigration(): void {
  registerMigration(feedPaySponsoredMigration);
}

export type SponsoredState =
  'reserved' | 'sent' | 'paid' | 'delivered' | 'paid_no_result' | 'failed';

/** A sponsored call as its owner reads it. */
export interface SponsoredCallView {
  callId: string;
  agentId: string;
  serviceId: string;
  offerId: string;
  state: SponsoredState;
  sponsored: true;
  priceRaw: string;
  payment: { payer: string; router: 'router3'; txHash: string | null };
  failure: string | null;
  result: { format: string | null; mime: string | null; text: string | null } | null;
}

/** Why a sponsored call was refused before anything was stored. */
export class SponsoredRefusal extends Error {
  constructor(
    readonly code:
      | 'credit_unavailable'
      | 'agent_not_found'
      | 'idempotency_conflict'
      | 'unavailable'
      | 'other_chain',
    readonly reason: SponsorRefusal | null = null,
  ) {
    super(code === 'credit_unavailable' ? `No sponsored purchase: ${reason}.` : code);
  }
  get status() {
    return this.code === 'credit_unavailable'
      ? 402
      : this.code === 'agent_not_found'
        ? 404
        : this.code === 'idempotency_conflict' || this.code === 'other_chain'
          ? 409
          : 503;
  }
}

interface Row {
  call_id: string;
  owner_account_id: string;
  request_hash: string;
  operator_id: string;
  agent_id: string;
  service_id: string;
  offer_id: string;
  offer_kind: string;
  offer_version: number;
  pay_to: string;
  gross_raw: string;
  fee_raw: string;
  input: string;
  state: SponsoredState;
  failure_code: string | null;
  op_key: string;
  valid_before: string | null;
  tx_hash: string | null;
  created_at: string;
  updated_at: string;
  result_text: string | null;
  result_mime: string | null;
  result_format: string | null;
}

export interface SponsoredDeps {
  db: Database;
  env: Record<string, string | undefined>;
  now: () => number;
  chainId: number;
  /** The chain an agent lives on (agentChainOf); absent: this chain, as with Arc off. */
  agentChain?: (agentId: string) => Promise<number>;
  credits: SponsorCredits;
  /** The engine's hosted-offer helpers (engine.hostedForSponsor / engine.runHostedOffer). */
  hosted: {
    forSponsor(
      serviceId: string,
      inputs: FeedPayInputs,
    ): Promise<{
      offerId: string;
      kind: string;
      version: number;
      payTo: string;
      split: { gross: bigint; fee: bigint; net: bigint };
      input: string;
    }>;
    run(
      offer: { offerId: string; kind: string; version: number },
      input: string,
    ): Promise<
      | { ok: true; text: string; mime: string; format: 'json' | 'text' }
      | { ok: false; failure: string }
    >;
  };
  /** The sponsor's signer and its own facilitator; null while not configured (nothing is paid). */
  pay: () => Promise<SponsorPay | null>;
  /**
   * The pay engine's own checks before a router-3 signature (engine router3PreSign): reserved
   * payee, screening of the payer, payee and fee recipient, router 3's readiness probe and its
   * treasury against the one fixed in code. Null: clear; 'hold': ask again later; else refused.
   */
  preSign: (input: {
    intentId: string;
    payer: string;
    payee: string;
    grossRaw: bigint;
    feeRaw: bigint;
  }) => Promise<string | null>;
  /** A hosted offer's Feed service id (the offer store's serviceIdOf), for the credit view. */
  serviceIdOf?: (offerId: string) => string;
  log?: (line: string) => void;
}

/**
 * The pace guard: most sponsored buys of one chain handed over and not paid yet (state 'sent').
 * CITY_SFP_MAX_SENT, a whole number within 10 to 1,000; default (also when malformed or out of
 * bounds) 120, about a minute of the 2 Nov test's peak, well inside the legs' window.
 */
export const SFP_MAX_SENT_SETTING = 'CITY_SFP_MAX_SENT';
export const SFP_MAX_SENT_DEFAULT = 120;
export function sponsoredMaxSent(env: Record<string, string | undefined>): number {
  const raw = env[SFP_MAX_SENT_SETTING]?.trim();
  const n = raw && /^[0-9]{2,4}$/.test(raw) ? Number(raw) : NaN;
  return n >= 10 && n <= 1_000 ? n : SFP_MAX_SENT_DEFAULT;
}

/** The op key prefix of every sponsored settlement (and its batch group on a shared facilitator). */
export const SPONSORED_KEY_PREFIX = 'sfp:';
/** '1': sponsored settlements are sent by the router-3 facilitator (see the module header). */
export const SFP_SEND_VIA_FACILITATOR_SETTING = 'CITY_SFP_SEND_VIA_FACILITATOR';
export const sponsoredSendsViaFacilitator = (env: Record<string, string | undefined>) =>
  env[SFP_SEND_VIA_FACILITATOR_SETTING]?.trim() === '1';

/**
 * With CITY_SFP_SEND_VIA_FACILITATOR the sponsored gas comes from the engine's facilitator EOA, so
 * first buys pause well above the facilitator's own floor (0.0005 ETH), leaving the rest to the
 * engine's paid calls (review S2). Wei, within 0.001 to 1 ETH; default (also when malformed or out
 * of bounds) 0.02 ETH. Another chain has its own setting, default and bounds, in its own gas asset
 * (chain-params.ts): on Arc 5 USDC of gas, within 2 to 50, in native wei (18 decimals).
 */
export const SFP_SENDER_MIN_ETH_SETTING = chainParams(BASE_MAINNET).settings.sponsoredSenderMin;
export const SFP_SENDER_MIN_ETH_DEFAULT = chainParams(BASE_MAINNET).sponsoredSenderMinWei.fallback;
export function sponsoredSenderMinEthWei(
  env: Record<string, string | undefined>,
  chainId: number = BASE_MAINNET,
): bigint {
  const params = chainParams(chainId);
  const { fallback, min, max } = params.sponsoredSenderMinWei;
  const raw = env[params.settings.sponsoredSenderMin]?.trim();
  if (!raw || !/^[1-9][0-9]{0,19}$/.test(raw)) return fallback;
  const wei = BigInt(raw);
  return wei >= min && wei <= max ? wei : fallback;
}

/**
 * A facilitator sponsored settlements may be stored on. `batch` present: sponsored members may be
 * batched there under the sponsored authority check: `group` is their batch group on that
 * facilitator (the router-3 facilitator's 'sfp:'), absent when its whole batch lane is the
 * sponsor's own. `batch` absent: settlements there are only followed and finished, never batched
 * or judged by the sponsored authority check (its batch lane, if any, belongs to someone else).
 */
export interface SponsorLane {
  facilitator: Router3FacilitatorPort;
  batch?: { group?: string };
}

/** The sponsor's side on Base (runtime.sponsorPay). */
export interface SponsorPay {
  signer: SponsorSigner;
  /** Where NEW settlements are sent; its ETH pays their gas (and pauses first buys when low). */
  facilitator: Router3FacilitatorPort;
  /** The batch lane of `facilitator` (as SponsorLane.batch); left out: its whole lane, as before. */
  batch?: { group?: string };
  /**
   * Facilitators that may still hold sponsored settlements stored before a switch: a key one of
   * them holds is followed and finished there, never sent anywhere else.
   */
  previous?: SponsorLane[];
  /**
   * Least ETH (wei) the SENDING facilitator must hold for a new first buy (review S2; set with
   * CITY_SFP_SEND_VIA_FACILITATOR, whose gas is the engine's facilitator EOA). Left out: only that
   * facilitator's own floor (canPay), as before.
   */
  minSenderEthWei?: bigint;
  /** The sponsor account's USDC balance on Base (raw). */
  usdcBalance: () => Promise<bigint>;
  /**
   * True only when the wall clock is past validBefore (unix s), Base's SAFE block is at or past it,
   * and USDC's authorizationState(sponsor, nonce) is false for every nonce at that block: those
   * authorizations can never move money any more. False (wait) on anything else, a read error too.
   */
  expiredUnused: (nonces: Hex[], validBefore: number) => Promise<boolean>;
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const newId = () => {
  let out = '';
  for (const byte of randomBytes(20)) out += BASE32[byte & 31];
  return `sp_${out}`;
};
export const SPONSORED_CALL_ID = /^sp_[a-z2-7]{20}$/;
/** How long one worker holds a call while it steps it. */
const LEASE_MS = 60_000;
/** How old the sponsor's USDC balance read may be before it is read again. */
const BALANCE_TTL_MS = 10_000;
/** A reservation not handed over by then (twice the legs' window) is ended (review S3). */
const STUCK_RESERVED_MS = 2 * ROUTER3_VALIDITY_S * 1000;
/** Calls one cron pass steps at once (review S5). */
const WORK_PARALLEL = 8;
/**
 * The stranded-credit sweep (review MPR-4): how far back (by the call's updated_at, its failure
 * time) one pass looks for a failed call whose credit is still reserved, and how many it releases.
 * Bounded so the every-minute pass stays one short range read of the updated_at index.
 */
const SWEEP_WINDOW_MS = 3_600_000;
const SWEEP_MAX = 100;
const COLUMNS = `call_id, owner_account_id, request_hash, operator_id, agent_id, service_id,
  offer_id, offer_kind, offer_version, pay_to, gross_raw::text AS gross_raw,
  fee_raw::text AS fee_raw, input, state, failure_code, op_key, valid_before::text AS valid_before,
  tx_hash, created_at::text AS created_at, updated_at::text AS updated_at, result_text, result_mime, result_format`;

const requestHashOf = (input: unknown) => keccak256(stringToHex(JSON.stringify(input)));

export function createSponsoredCalls(deps: SponsoredDeps) {
  const log = deps.log ?? (() => {});
  /** This engine's chain: its rows only (migration 359), each chain has its own engine. */
  const chainId = deps.chainId;
  const load = async (callId: string) =>
    (
      await deps.db.query<Row>(
        `SELECT ${COLUMNS} FROM feed_pay_sponsored_calls WHERE call_id = $1 AND chain_id = $2`,
        [callId, chainId],
      )
    ).rows[0] ?? null;

  /** Moves a call from `from` to its next state (compare-and-set on state and updated_at). */
  const move = async (
    row: Row,
    set: Record<string, unknown>,
    tx: Transaction = deps.db,
  ): Promise<boolean> => {
    const keys = Object.keys(set);
    const { rows } = await tx.query(
      `UPDATE feed_pay_sponsored_calls SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')},
         updated_at = $${keys.length + 3}
       WHERE call_id = $1 AND updated_at = $2 RETURNING call_id`,
      [
        row.call_id,
        row.updated_at,
        ...Object.values(set),
        Math.max(deps.now(), Number(row.updated_at) + 1),
      ],
    );
    return rows.length > 0;
  };

  /**
   * Ends a call that never paid and gives its credit back in ONE transaction (review MPR-4): both
   * commit or neither does, so a failed release write can never leave the credit reserved for a
   * call that is already final. On a rollback the call keeps its open state and the next step
   * decides again (its key is already fenced or its legs already proven unused, so that is safe).
   */
  const failAndRelease = (row: Row, set: Record<string, unknown>): Promise<boolean> =>
    deps.db.transaction(async (tx) => {
      if (!(await move(row, { state: 'failed', ...set }, tx))) return false;
      await deps.credits.release(row.call_id, tx);
      return true;
    });

  const view = (row: Row, payer: string | null): SponsoredCallView => ({
    callId: row.call_id,
    agentId: row.agent_id,
    serviceId: row.service_id,
    offerId: row.offer_id,
    state: row.state,
    sponsored: true,
    priceRaw: row.gross_raw,
    payment: { payer: payer ?? '', router: 'router3', txHash: row.tx_hash },
    failure: row.failure_code,
    result:
      row.state === 'delivered'
        ? { format: row.result_format, mime: row.result_mime, text: row.result_text }
        : null,
  });

  /** The sponsor's USDC, read at most every BALANCE_TTL_MS (one Base read, not one per call). */
  let balance: { at: number; raw: bigint } | null = null;
  /**
   * The sponsor's USDC balance when it can take a new buy at all (configured, ETH above its
   * facilitator's floor, balance readable); null pauses first buys. Read outside the sponsor lock.
   */
  async function sponsorBalance(): Promise<{ at: number; raw: bigint } | null> {
    const pay = await deps.pay().catch(() => null);
    if (!pay) return null;
    // Gas: the sending facilitator (the router-3 facilitator with CITY_SFP_SEND_VIA_FACILITATOR,
    // else the sponsor's own) refuses new settlements below its ETH floor.
    if (!(await pay.facilitator.canPay().catch(() => false))) {
      log(JSON.stringify({ event: 'sfp.paused', why: 'eth' }));
      return null;
    }
    // On the engine's facilitator: well above its floor (review S2). Unreadable, or a port without
    // ethBalance: paused (fail closed). The engine's own submits never read this.
    if (pay.minSenderEthWei !== undefined) {
      const eth = await (pay.facilitator.ethBalance?.() ?? Promise.resolve(null)).catch(() => null);
      if (eth === null || eth < pay.minSenderEthWei) {
        log(JSON.stringify({ event: 'sfp.paused', why: 'eth' }));
        return null;
      }
    }
    const at = deps.now();
    if (!balance || at - balance.at > BALANCE_TTL_MS) {
      const raw = await pay.usdcBalance().catch(() => null);
      if (raw === null) return null;
      balance = { at, raw };
    }
    return balance;
  }

  /**
   * Under the sponsor lock (review S6): the balance covers this buy on top of everything still
   * unpaid (calls reserved or sent) and everything paid since the balance was read (the cached read
   * does not show it yet). Concurrent starts are serialized here, so they can't all pass at once.
   */
  async function fits(
    tx: Transaction,
    read: { at: number; raw: bigint },
    gross: bigint,
  ): Promise<boolean> {
    const { rows } = await tx.query<{ held: string }>(
      `SELECT (
         (SELECT COALESCE(SUM(gross_raw), 0) FROM feed_pay_sponsored_calls
          WHERE state IN ('reserved','sent') AND chain_id = $2)
         + (SELECT COALESCE(SUM(gross_raw), 0) FROM feed_pay_sponsored_calls
            WHERE updated_at >= $1 AND state IN ('paid','delivered','paid_no_result') AND chain_id = $2)
       )::text AS held`,
      [read.at, chainId],
    );
    if (read.raw - BigInt(rows[0]!.held) < gross) {
      log(JSON.stringify({ event: 'sfp.paused', why: 'usdc' }));
      return false;
    }
    // The pace guard (2 Nov 2026: 246 buys sent at once sat in a lane past their legs' window):
    // at most this many of this chain's buys handed over and not paid yet; past it new ones pause
    // (retryable) and the lane catches up first.
    const { rows: open } = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM feed_pay_sponsored_calls
       WHERE state = 'sent' AND chain_id = $1`,
      [chainId],
    );
    if (Number(open[0]!.n) >= sponsoredMaxSent(deps.env)) {
      log(JSON.stringify({ event: 'sfp.paused', why: 'in_flight' }));
      return false;
    }
    return true;
  }

  const payerAddress = async () => (await deps.pay().catch(() => null))?.signer.address ?? null;

  /**
   * The sponsored batch members REFUSED now: every key no longer owed a send (any key that is not a
   * sponsored call's, too). Only ever asked about the sponsored group's members (facilitator groups).
   */
  const authorize: BatchAuthorize = async (keys) => {
    if (!keys.length) return new Set();
    const { rows } = await deps.db.query<{ op_key: string }>(
      `SELECT op_key FROM feed_pay_sponsored_calls WHERE op_key = ANY($1::text[])
         AND state IN ('reserved','sent') AND chain_id = $2`,
      [keys, chainId],
    );
    const live = new Set(rows.map((r) => r.op_key));
    return new Set(keys.filter((k) => !live.has(k)));
  };

  /**
   * The facilitator that holds a key: the sending one, else a previous one that stored it, else
   * (nothing stored yet) the sending one. `current` false: follow and finish only (review: a key is
   * never stored on two facilitators, op keys are one table's primary key, but a settlement must be
   * continued by the EOA that may have signed it).
   */
  async function laneOf(pay: SponsorPay, key: string): Promise<SponsorLane & { current: boolean }> {
    const current = {
      facilitator: pay.facilitator,
      batch: pay.batch ?? {},
      current: true,
    };
    if (!pay.previous?.length) return current;
    if (await pay.facilitator.holds?.(key)) return current;
    for (const lane of pay.previous)
      if (await lane.facilitator.holds?.(key)) return { ...lane, current: false };
    return current;
  }
  /** The sponsored batch option for a lane: only where sponsored members may be batched. */
  const batchOn = (lane: SponsorLane) => (lane.batch ? { batch: { authorize, grant: null } } : {});
  const authorityOn = (lane: SponsorLane) => (lane.batch ? { authorize } : undefined);

  /**
   * Starts a sponsored call for one of the owner's agents: the credit is reserved before anything
   * is stored or signed; a refused credit stores nothing. The same (owner, idempotency key) answers
   * the same call.
   */
  async function start(
    accountId: string,
    input: {
      serviceId: string;
      agentId: string;
      inputs: FeedPayInputs;
      maxAmountRaw: bigint;
      idempotencyKey: string;
    },
  ): Promise<SponsoredCallView> {
    const hash = requestHashOf({ ...input, maxAmountRaw: input.maxAmountRaw.toString(10) });
    const existing = (
      await deps.db.query<Row>(
        `SELECT ${COLUMNS} FROM feed_pay_sponsored_calls
         WHERE owner_account_id = $1 AND idempotency_key = $2`,
        [accountId, input.idempotencyKey],
      )
    ).rows[0];
    if (existing) {
      if (existing.request_hash !== hash) throw new SponsoredRefusal('idempotency_conflict');
      return view(existing, await payerAddress());
    }
    if (!sponsorConfig(deps.env)) throw new SponsoredRefusal('credit_unavailable', 'disabled');
    // The owner's own agent on this chain, with a usable wallet.
    const { rows: agents } = await deps.db.query<{ operator_id: string }>(
      `SELECT operator_id FROM base_wallets
       WHERE agent_id = $1 AND chain_id = $2 AND owner_account_id = $3 AND state <> 'closed'`,
      [input.agentId, deps.chainId, accountId],
    );
    const agent = agents[0];
    if (!agent) throw new SponsoredRefusal('agent_not_found');
    // Credits and sponsored rows are one chain's (each chain has its own engine): an agent that
    // lives on another chain has no first purchase here, also with an old wallet row on this one.
    if (deps.agentChain && (await deps.agentChain(input.agentId)) !== deps.chainId)
      throw new SponsoredRefusal('other_chain');
    // The hosted offer as call() would sell it (its own refusals: not found, not payable, input).
    const offer = await deps.hosted.forSponsor(input.serviceId, input.inputs);
    if (offer.split.gross > input.maxAmountRaw)
      throw new SponsoredRefusal('credit_unavailable', 'over_price');
    const { rows: sellers } = await deps.db.query<{
      operator_id: string;
      agent_id: string;
      owner_account_id: string | null;
    }>(
      `SELECT o.operator_id, o.agent_id, w.owner_account_id
       FROM city_offers o LEFT JOIN base_wallets w ON w.wallet_id = o.wallet_id
       WHERE o.offer_id = $1`,
      [offer.offerId],
    );
    const seller = sellers[0];
    if (!seller) throw new SponsoredRefusal('credit_unavailable', 'self_dealing');
    const callId = newId();
    const request = {
      agentId: input.agentId,
      chainId: deps.chainId,
      operatorId: agent.operator_id,
      ownerAccountId: accountId,
      seller: {
        operatorId: seller.operator_id,
        ownerAccountId: seller.owner_account_id,
        agentId: seller.agent_id,
      },
      offerId: offer.offerId,
      priceRaw: offer.split.gross,
      callId,
    };
    // The credit's database-only checks first (review MPR-4: verified and onboarded owner, agent
    // eligible, credit unused, owner's day), so a request that can never hold a credit makes no
    // Base read. reserve() runs them all again under its lock below.
    const pre = await deps.credits.precheck(request);
    if (!pre.ok) throw new SponsoredRefusal('credit_unavailable', pre.reason);
    // The sponsor must be able to pay this one on top of everything still in flight. Low ETH or
    // USDC pauses first buys (retryable, nothing reserved), never fails one halfway.
    const read = await sponsorBalance();
    if (!read) throw new SponsoredRefusal('unavailable');
    const at = deps.now();
    let conflict = false;
    // The credit and the call row commit together or not at all (review C2/S2), under the sponsor
    // lock where the balance check runs too (S6).
    const credit = await deps.credits.reserve(request, async (tx, kind) => {
      if (!(await fits(tx, read, offer.split.gross))) return 'paused';
      // ON CONFLICT: a concurrent request with the same key won; this one writes nothing (and
      // so takes no credit) and answers that call below.
      const { rows } = await tx.query(
        `INSERT INTO feed_pay_sponsored_calls (call_id, owner_account_id, idempotency_key,
             request_hash, operator_id, agent_id, service_id, offer_id, offer_kind, offer_version,
             pay_to, gross_raw, fee_raw, input, state, op_key, created_at, updated_at, fleet,
             chain_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'reserved',$15,$16,$16,$17,$18)
           ON CONFLICT (owner_account_id, idempotency_key) DO NOTHING RETURNING call_id`,
        [
          callId,
          accountId,
          input.idempotencyKey,
          hash,
          agent.operator_id,
          input.agentId,
          input.serviceId,
          offer.offerId,
          offer.kind,
          offer.version,
          getAddress(offer.payTo),
          offer.split.gross.toString(10),
          offer.split.fee.toString(10),
          offer.input,
          `${SPONSORED_KEY_PREFIX}${callId}`,
          at,
          kind.fleet,
          chainId,
        ],
      );
      if (!rows.length) {
        conflict = true;
        return 'used';
      }
    });
    if (conflict) {
      const again = (
        await deps.db.query<Row>(
          `SELECT ${COLUMNS} FROM feed_pay_sponsored_calls
           WHERE owner_account_id = $1 AND idempotency_key = $2`,
          [accountId, input.idempotencyKey],
        )
      ).rows[0];
      if (again && again.request_hash === hash) return view(again, await payerAddress());
      throw new SponsoredRefusal('idempotency_conflict');
    }
    if (!credit.ok)
      throw credit.reason === 'paused'
        ? new SponsoredRefusal('unavailable')
        : new SponsoredRefusal('credit_unavailable', credit.reason);
    await step(callId).catch(() => {});
    const row = await load(callId);
    return view(row!, await payerAddress());
  }

  const intentOf = (row: Row): Hex =>
    keccak256(stringToHex(`sfp:${row.call_id}:${row.pay_to}:${row.gross_raw}`));

  /** Both stored legs provably can no longer move money (expired and unused on Base). */
  async function unpaidForGood(pay: SponsorPay, row: Row): Promise<boolean> {
    const legs = await pay.signer.stored(row.op_key).catch(() => null);
    if (!legs) return false;
    const validBefore = Number(legs.seller.authorization.validBefore);
    return pay
      .expiredUnused([legs.seller.authorization.nonce, legs.fee.authorization.nonce], validBefore)
      .catch(() => false);
  }

  /** Signs (once) and hands the settlement to the facilitator that holds (or will hold) its key. */
  async function send(row: Row): Promise<boolean> {
    const pay = await deps.pay();
    if (!pay) return false;
    const lane = await laneOf(pay, row.op_key);
    const gross = BigInt(row.gross_raw);
    // Before the first signature, the engine's own pre-send checks (fail closed). A pair already
    // stored is handed over unchanged: refusing it now would not unsign it (it is followed).
    if (!(await pay.signer.stored(row.op_key))) {
      const refusal = await deps
        .preSign({
          intentId: `sfp:${row.call_id}`,
          payer: pay.signer.address,
          payee: row.pay_to,
          grossRaw: gross,
          feeRaw: BigInt(row.fee_raw),
        })
        .catch(() => 'hold' as const);
      if (refusal === 'hold') return false;
      if (refusal) return refuseUnsigned(row, pay, refusal);
    }
    const legs = await pay.signer.router3Legs({
      key: row.op_key,
      payee: getAddress(row.pay_to) as `0x${string}`,
      gross,
      ref: feeRef(row.call_id),
      validitySeconds: ROUTER3_VALIDITY_S,
    });
    // Handed over first, recorded after: the legs and the facilitator's settlement are both stored
    // once per key, so a step that stops in between hands over the same pair again (idempotent),
    // never a second one. A failure is only final once these signatures have expired.
    await lane.facilitator.submit({
      key: row.op_key,
      intentHash: intentOf(row),
      settlement: {
        payer: pay.signer.address as Hex,
        payee: getAddress(row.pay_to) as Hex,
        gross,
        ref: feeRef(row.call_id),
        validAfter: legs.seller.authorization.validAfter,
        validBefore: legs.seller.authorization.validBefore,
        sellerSignature: legs.seller.signature,
        feeSignature: legs.fee.signature,
      },
      beforeBroadcast: async () => {},
      // grant null: no MCP grant applies (an owner's session call), so the facilitator puts it on
      // the sponsored batch lane (review S1); undefined would send every one alone. Only where
      // sponsored members may be batched (laneOf): never on another origin's batch lane.
      ...batchOn(lane),
    });
    if (row.state === 'sent') return true;
    return move(row, {
      state: 'sent',
      valid_before: Number(legs.seller.authorization.validBefore),
    });
  }

  /**
   * A reservation refused before anything was signed: its key is fenced at the facilitator (so
   * nothing can ever be sent under it), then the call fails and its credit comes back.
   */
  async function refuseUnsigned(row: Row, pay: SponsorPay, code: string): Promise<boolean> {
    const lane = await laneOf(pay, row.op_key);
    if (!(await lane.facilitator.endUnsent(row.op_key, intentOf(row)).catch(() => false)))
      return false;
    if (!(await failAndRelease(row, { failure_code: code }))) return false;
    log(JSON.stringify({ event: 'sfp.call_failed', callId: row.call_id, code }));
    return true;
  }

  /** Follows a sent call on Base: paid once included without a revert; failed once it can't pay. */
  async function follow(row: Row): Promise<boolean> {
    const pay = await deps.pay();
    if (!pay) return false;
    const lane = await laneOf(pay, row.op_key);
    let op: FeedPayOp | null | undefined = await lane.facilitator
      .status(row.op_key, authorityOn(lane))
      .catch(() => undefined);
    if (op === undefined) return false;
    // Recorded as sent but unknown to the facilitator: hand the same stored pair over again.
    if (op === null) return send(row);
    // Left queued, never signed, on a facilitator it is no longer sent from, past the legs' whole
    // window: fenced there (endUnsent: only a queued, unsigned, unclaimed settlement outside any
    // batch), then ended as never sent below. E.g. a waiting member after a switch back, on a lane
    // that does not batch sponsored members any more.
    if (
      !lane.current &&
      op.status === 'queued' &&
      !op.txHash &&
      deps.now() - Number(row.created_at) > STUCK_RESERVED_MS &&
      (await lane.facilitator.endUnsent(row.op_key, intentOf(row)).catch(() => false))
    ) {
      op = await lane.facilitator.status(row.op_key).catch(() => undefined);
      if (!op) return false;
    }
    // Stored but never signed or sent (its first send could not reach Base, or the facilitator
    // moved a batch member back to the single path, review SFP #14): nothing else ever sends it.
    // Hand the same key over again; the facilitator continues exactly the stored settlement (same
    // signed pair), so nothing can be paid twice (as the engine does, room x402 #208).
    if (op.status === 'queued' && !op.txHash) {
      await send(row);
      return false;
    }
    if ((op.status === 'included' || op.status === 'final') && !op.errorCode) {
      if (
        !(await move(row, {
          state: 'paid',
          tx_hash: op.txHash,
          block_number: op.blockNumber === null ? null : op.blockNumber.toString(10),
        }))
      )
        return false;
      await deps.credits.use(row.call_id);
      return true;
    }
    const failedForGood =
      op.neverSent || op.status === 'failed' || (op.status === 'final' && !!op.errorCode);
    if (!failedForGood) return false;
    // Never broadcast: nothing signed ever left the server, the credit comes back at once.
    // Otherwise (review C1/C3) a 'failed' can still turn included on a late receipt, and anyone
    // holding broadcast legs could submit them until validBefore: the credit comes back only once
    // Base itself, at a SAFE block at or past validBefore, shows BOTH legs' nonces unused.
    if (!op.neverSent && !(await unpaidForGood(pay, row))) return false;
    if (
      !(await failAndRelease(row, {
        failure_code: op.errorCode ?? 'not_paid',
        tx_hash: op.txHash,
      }))
    )
      return false;
    log(JSON.stringify({ event: 'sfp.call_failed', callId: row.call_id, code: op.errorCode }));
    return true;
  }

  /** Runs the paid offer once and stores its answer. */
  async function deliver(row: Row): Promise<boolean> {
    const outcome = await deps.hosted.run(
      { offerId: row.offer_id, kind: row.offer_kind, version: row.offer_version },
      row.input,
    );
    const current = await load(row.call_id);
    if (!current || current.state !== 'paid') return false;
    if (!outcome.ok)
      return move(current, { state: 'paid_no_result', failure_code: outcome.failure });
    return move(current, {
      state: 'delivered',
      result_text: outcome.text,
      result_mime: outcome.mime,
      result_format: outcome.format,
    });
  }

  /** One step of a call, under its lease (one worker at a time). */
  async function step(callId: string): Promise<boolean> {
    const at = deps.now();
    const { rows } = await deps.db.query<Row>(
      `UPDATE feed_pay_sponsored_calls SET lease_until = $2
       WHERE call_id = $1 AND lease_until < $3 AND state IN ('reserved','sent','paid')
         AND chain_id = $4
       RETURNING ${COLUMNS}`,
      [callId, at + LEASE_MS, at, chainId],
    );
    const row = rows[0];
    if (!row) return false;
    const lease = at + LEASE_MS;
    try {
      if (row.state === 'reserved') {
        // Stuck before its hand-over past the legs' whole window (review S3): fenced at the
        // facilitator so it can never be sent, then failed and its credit released.
        if (deps.now() - Number(row.created_at) > STUCK_RESERVED_MS) return await endStuck(row);
        return await send(row);
      }
      if (row.state === 'sent') return await follow(row);
      return await deliver(row);
    } catch (error) {
      log(
        JSON.stringify({
          event: 'sfp.step_failed',
          callId,
          state: row.state,
          error: error instanceof Error ? error.constructor.name : 'unknown',
        }),
      );
      return false;
    } finally {
      // Only this worker's own lease (another may have taken the call after it ran out).
      await deps.db
        .query(
          'UPDATE feed_pay_sponsored_calls SET lease_until = 0 WHERE call_id = $1 AND lease_until = $2',
          [callId, lease],
        )
        .catch(() => {});
    }
  }

  /**
   * A reservation never handed over: if the facilitator holds it, it is followed as sent; if not,
   * the key is fenced (endUnsent: it can never be sent) and only then failed and released. The
   * legs signed for it never left the server.
   */
  async function endStuck(row: Row): Promise<boolean> {
    const pay = await deps.pay().catch(() => null);
    if (!pay) return false;
    const lane = await laneOf(pay, row.op_key);
    const op = await lane.facilitator.status(row.op_key, authorityOn(lane)).catch(() => undefined);
    if (op === undefined) return false;
    if (op !== null) {
      const legs = await pay.signer.stored(row.op_key).catch(() => null);
      return move(row, {
        state: 'sent',
        valid_before: legs ? Number(legs.seller.authorization.validBefore) : null,
      });
    }
    if (!(await lane.facilitator.endUnsent(row.op_key, intentOf(row)).catch(() => false)))
      return false;
    if (!(await failAndRelease(row, { failure_code: 'not_sent' }))) return false;
    log(JSON.stringify({ event: 'sfp.call_failed', callId: row.call_id, code: 'not_sent' }));
    return true;
  }

  /**
   * The cron's pass (also the stale-reservation sweep, room #304): steps the open calls, oldest
   * first, gives back credits stranded on failed calls (sweepStranded), sends what the sponsored
   * batch lanes hold, and keeps to its budget.
   */
  async function work(limits: { maxCalls: number; budgetMs: number }): Promise<number> {
    const started = deps.now();
    const { rows } = await deps.db.query<{ call_id: string }>(
      `SELECT call_id FROM feed_pay_sponsored_calls
       WHERE state IN ('reserved','sent','paid') AND lease_until < $1 AND chain_id = $3
       ORDER BY updated_at LIMIT $2`,
      [started, limits.maxCalls, chainId],
    );
    let moved = 0;
    let next = 0;
    // WORK_PARALLEL steps at a time (review S5): each is mostly waiting on Base or the database.
    const runner = async () => {
      while (next < rows.length && deps.now() - started <= limits.budgetMs) {
        const { call_id } = rows[next++]!;
        if (await step(call_id)) moved += 1;
      }
    };
    await Promise.all(Array.from({ length: WORK_PARALLEL }, runner));
    if (deps.now() - started <= limits.budgetMs) moved += await sweepStranded(started);
    const pay = await deps.pay().catch(() => null);
    // Every lane where sponsored members may wait (the sending one, and a previous one still
    // holding some), each only for its sponsored batch group.
    const lanes: SponsorLane[] = pay
      ? [{ facilitator: pay.facilitator, batch: pay.batch ?? {} }, ...(pay.previous ?? [])]
      : [];
    for (const lane of lanes)
      if (lane.batch)
        await lane.facilitator
          .flushBatches?.(authorize, false, started + limits.budgetMs, lane.batch.group)
          .catch(() => {});
    return moved;
  }

  /**
   * Gives back credits still 'reserved' for a call that already ended 'failed' (a release that
   * did not commit before mark-failed and release were one transaction). A failed call is final
   * and never paid, so its credit is owed back; each release is a compare-and-set by call id on a
   * still-failed call and a still-reserved credit, so a used credit, or one whose call is paid or
   * still open, is never touched, and running it twice changes nothing.
   */
  async function sweepStranded(at: number): Promise<number> {
    const { rows } = await deps.db
      .query<{ call_id: string }>(
        `SELECT s.call_id FROM feed_pay_sponsored_calls s
         JOIN feed_pay_sponsor_credits c ON c.call_id = s.call_id
         WHERE s.updated_at >= $1 AND s.state = 'failed' AND c.state = 'reserved'
           AND s.chain_id = $3
         ORDER BY s.updated_at LIMIT $2`,
        [at - SWEEP_WINDOW_MS, SWEEP_MAX, chainId],
      )
      .catch(() => ({ rows: [] as { call_id: string }[] }));
    let released = 0;
    for (const { call_id } of rows) {
      const ok = await deps.db
        .transaction(async (tx) => {
          const still = await tx.query(
            `SELECT 1 FROM feed_pay_sponsored_calls WHERE call_id = $1 AND state = 'failed'
             FOR UPDATE`,
            [call_id],
          );
          return still.rows.length > 0 && (await deps.credits.release(call_id, tx));
        })
        .catch(() => false);
      if (!ok) continue;
      released += 1;
      log(JSON.stringify({ event: 'sfp.credit_swept', callId: call_id }));
    }
    return released;
  }

  /** The owner's own sponsored call, or null. */
  async function callFor(accountId: string, callId: string): Promise<SponsoredCallView | null> {
    const row = await load(callId);
    if (!row || row.owner_account_id !== accountId) return null;
    return view(row, await payerAddress());
  }

  /**
   * The owner's view of its credits (GET /api/feed/sponsored-credit): each of its agents on this
   * chain with what its credit can do now (sponsor.ts status(), a hint: start() decides), and the
   * Feed services a real user's credit covers (CITY_SFP_OFFERS), with the most it pays.
   */
  async function credit(accountId: string): Promise<SponsoredCreditView> {
    const config = sponsorConfig(deps.env);
    const { rows } = await deps.db.query<{ agent_id: string; operator_id: string }>(
      `SELECT agent_id, operator_id FROM base_wallets
       WHERE owner_account_id = $1 AND chain_id = $2 AND state <> 'closed'
       LIMIT ${SPONSORED_CREDIT_AGENTS_MAX}`, // no ORDER BY: a fleet owner holds 100k+ wallets; the index stops at the limit
      [accountId, deps.chainId],
    );
    const status = await deps.credits.status({
      ownerAccountId: accountId,
      chainId: deps.chainId,
      agents: rows.map((r) => ({ agentId: r.agent_id, operatorId: r.operator_id })),
    });
    return {
      agents: rows.map((r) => ({ agentId: r.agent_id, ...status.get(r.agent_id)! })),
      serviceIds:
        config && deps.serviceIdOf
          ? [...config.offers].map((offerId) => deps.serviceIdOf!(offerId))
          : [],
      maxPriceRaw: (config?.creditMaxRaw ?? 0n).toString(10),
    };
  }

  return { start, step, work, callFor, authorize, credit };
}

/** Most agents one owner's credit view lists. */
export const SPONSORED_CREDIT_AGENTS_MAX = 200;

/** GET /api/feed/sponsored-credit: the owner's agents' credits and the services they cover. */
export interface SponsoredCreditView {
  agents: ({ agentId: string } & SponsorCreditStatus)[];
  serviceIds: string[];
  maxPriceRaw: string;
}

export type SponsoredCalls = ReturnType<typeof createSponsoredCalls>;

/**
 * The sponsored first purchase on every chain that has an engine (Base's first; Arc's beside it
 * since 2 Nov 2026), behind the one engine's own interface, so the routes are the same: a new
 * call goes to its agent's chain, a call or step is looked up on each chain (a call id is one
 * table's primary key, so exactly one engine holds it), the cron steps every chain (one failing
 * leaves the others' passes as they are), and the credit view lists each chain's agents.
 */
export function sponsoredOnChains(input: {
  /** Base's engine. */
  base: SponsoredCalls;
  /** Engines of other chains, by chain id. */
  others: ReadonlyMap<number, SponsoredCalls>;
  /** The chain an agent lives on (agentChainOf). */
  agentChain: (agentId: string) => Promise<number>;
}): SponsoredCalls {
  const { base, others } = input;
  if (!others.size) return base;
  const all = [base, ...others.values()];
  return {
    async start(accountId, call) {
      const chain = await input.agentChain(call.agentId);
      return (others.get(chain) ?? base).start(accountId, call);
    },
    async step(callId) {
      for (const engine of all) if (await engine.step(callId)) return true;
      return false;
    },
    async work(limits) {
      const moved = await Promise.all(all.map((engine) => engine.work(limits).catch(() => 0)));
      return moved.reduce((sum, n) => sum + n, 0);
    },
    async callFor(accountId, callId) {
      for (const engine of all) {
        const view = await engine.callFor(accountId, callId);
        if (view) return view;
      }
      return null;
    },
    authorize: base.authorize,
    async credit(accountId) {
      const views = await Promise.all(all.map((engine) => engine.credit(accountId)));
      return {
        agents: views.flatMap((view) => view.agents),
        serviceIds: [...new Set(views.flatMap((view) => view.serviceIds))],
        maxPriceRaw: views[0]!.maxPriceRaw,
      };
    },
  };
}
