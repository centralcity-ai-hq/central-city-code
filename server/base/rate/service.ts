/*
 * Operation Rating R1 (server): an owner rates another Central City Base agent 1 to 5 stars on Base,
 * from one of their own agents' wallets, through the ERC-8004 Reputation Registry. A rating IS an
 * owner operation of that wallet (wallet/withdrawals.ts, kind 'rate'): the same two-phase owner
 * signing in the browser, gate 2, and its signing, status and cancel go through the withdrawal
 * routes by its withdrawal id. The call is exactly shared/base/rate.ts rateCall, the one the browser
 * checks (src/base/wallet/rate.ts checkRateOperation). What Rate adds, mirroring Pay
 * (pay/service.ts):
 *
 *   lookup   {baseId, passport}: BOTH values the owner typed, both required (shared/base/rate.ts
 *            RateLookup). baseId is a decimal Base ID above 0 within uint256; passport is the short
 *            id, 6 base62 characters, case-sensitive. Nothing else is read: no free text, no link,
 *            never an address. Each must name a Central City agent in our confirmed registration
 *            records (pay/store.ts: a final Base ID handed over to the agent's own wallet, a
 *            passport at centralcity.ai/a/<short> naming it) and both the SAME agent (else 422
 *            lookup_mismatch; neither naming one is 422 not_rateable). The rater, the agent in the
 *            path, must be one too, with its own wallet ready (409 rater_not_eligible). Then ownerOf
 *            of BOTH Base IDs on Base at ONE block (number and hash): each is its agent's wallet.
 *            Never the rater itself and never an agent of the same person (409 same_person: its
 *            wallet's owner account or its workspace is the person's). The answer (RateTarget)
 *            names what was shown (base_rate_lookups), for that account and rater, until it expires
 *            (PAY_RECIPIENT_TTL_MS).
 *   create   {to: {lookupId}, stars, idempotencyKey}. Right before the operation is prepared
 *            (after gate 2), everything above is checked again from the records and on Base at
 *            one block; anything that differs from the lookup is 409 lookup_changed, a lookup that
 *            is unknown, another account's or rater's, or expired (also when the check ends after
 *            it expired) is 409 lookup_expired. 100 ratings per account per Berlin calendar day
 *            (rate/store.ts today), counted again inside the transaction that stores the rating
 *            with the account row locked: the 101st is 429 rating_limit. Sponsored or nothing; no
 *            money moves. One open owner operation per wallet: 409 operation_pending; with lanes
 *            on (CITY_BASE_LANES=1) its own nonce lane instead, under the open cap and the
 *            sponsor's caps like a payment (wallet/withdrawals.ts).
 *   status   {enabled: true} for the rater's owner while ratings are on (404 otherwise).
 *   given    the ratings the rater's wallet made (shared/base/rate.ts RatingsGiven), for its owner
 *            only: newest first, at most RATINGS_GIVEN_MAX, never one that was never signed in
 *            time. From our records alone, as stored; nothing is read on Base (a rating on its
 *            way is brought up to date by its owner's read of it on the withdrawal route).
 *
 * Off unless CITY_BASE_RATE is exactly '1' (and the wallet routes are on): every route is 404.
 * Names are display only, never a binding. Anything Base cannot prove right now is refused (503).
 */
import { createHash, randomBytes } from 'node:crypto';
import { getAddress, maxUint256 } from 'viem';
import type { Database, Transaction } from '../../database.js';
import { PAY_RECIPIENT_TTL_MS } from '../../../shared/base/pay.js';
import {
  isStars,
  RATINGS_GIVEN_MAX,
  starsOf,
  type RateLookup,
  type RateTarget,
  type RatingGiven,
  type RatingsGiven,
  type Stars,
} from '../../../shared/base/rate.js';
import { WALLET_CHAIN_ID, WALLET_NETWORK } from '../../../shared/base/wallet-network.js';
import type { PayChainReader } from '../pay/chain.js';
import { CLOCK_SLACK_MS } from '../pay/service.js';
import { createPayStore, type RecipientRecord } from '../pay/store.js';
import {
  TX_EXPLORER,
  type RatingSigningRequest,
  type WithdrawalService,
} from '../wallet/withdrawals.js';
import { createRateStore, type GivenRow, type StoredRateLookup } from './store.js';

/** The rating routes exist only when this is exactly '1' (default off: 404). */
export const RATE_SETTING = 'CITY_BASE_RATE';

export function rateEnabled(env: Record<string, string | undefined>): boolean {
  return env[RATE_SETTING] === '1';
}

/** Ratings per account per Berlin calendar day (rate/store.ts today), unless the setting says. */
export const RATE_DAILY_MAX = 100;
/** Optional: another daily cap, a whole number from 1 (read per request; anything else is 100). */
export const RATE_DAILY_MAX_SETTING = 'CITY_BASE_RATE_DAILY_MAX';

export function rateDailyMax(env: Record<string, string | undefined>): number {
  const raw = env[RATE_DAILY_MAX_SETTING];
  return raw && /^[1-9]\d{0,8}$/.test(raw) ? Number(raw) : RATE_DAILY_MAX;
}

export type RateErrorCode =
  /** Not {baseId, passport} (both strings), or not {to, stars, idempotencyKey}. */
  | 'invalid_body'
  /** A Base ID that is not a decimal above 0 within uint256, or a passport that is not 6 base62. */
  | 'invalid_query'
  /** Not a whole number of stars from 1 to 5. */
  | 'invalid_stars'
  | 'not_found'
  /** The Base ID and the passport do not both name the same Central City agent. */
  | 'lookup_mismatch'
  /** No Central City agent with a final Base ID and a passport naming it, held by its wallet. */
  | 'not_rateable'
  /** The rater itself, or an agent of the person rating (its wallet's owner account or workspace). */
  | 'same_person'
  /** The rating agent itself is no Central City agent with its own ready wallet on Base. */
  | 'rater_not_eligible'
  | 'lookup_changed'
  | 'lookup_expired'
  | 'rating_limit'
  | 'chain_unavailable';

const STATUS: Record<RateErrorCode, number> = {
  invalid_body: 400,
  invalid_query: 400,
  invalid_stars: 400,
  not_found: 404,
  lookup_mismatch: 422,
  not_rateable: 422,
  same_person: 409,
  rater_not_eligible: 409,
  lookup_changed: 409,
  lookup_expired: 409,
  rating_limit: 429,
  chain_unavailable: 503,
};

export class RateError extends Error {
  readonly status: number;
  constructor(
    readonly code: RateErrorCode,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.status = STATUS[code];
  }
}

const notRateable = (message = 'Only Central City agents on Base can be rated.') =>
  new RateError('not_rateable', message);
const mismatch = () =>
  new RateError(
    'lookup_mismatch',
    'This Base ID and passport number don’t belong to the same Central City agent.',
  );
const raterNotEligible = () =>
  new RateError(
    'rater_not_eligible',
    'This agent cannot rate yet: it needs its own wallet with the backup confirmed, a final Base ID and a Central City passport.',
  );
const changed = () =>
  new RateError(
    'lookup_changed',
    'This agent is no longer the one looked up on Base. Look it up again.',
  );
const expired = () =>
  new RateError(
    'lookup_expired',
    'This lookup has expired or is not yours. Look the agent up again and confirm.',
  );
const unavailable = () =>
  new RateError(
    'chain_unavailable',
    'Base cannot be read right now, so the agent is not verified.',
  );
const limitReached = (max: number) =>
  new RateError(
    'rating_limit',
    `An account can send at most ${max} ratings a day (Berlin time). Try again tomorrow.`,
    { max },
  );

export interface RateDeps {
  db: Database;
  withdrawals: WithdrawalService;
  /** The wallet network's Base reader (ownersOf); absent when not configured (verifying is 503). */
  chain?: PayChainReader;
  /** Ratings per account per Berlin day (rateDailyMax); RATE_DAILY_MAX without it. */
  dailyMax?: () => number;
  now?: () => number;
}

/** What a check on Base found, at which block, when. */
interface Evidence {
  raterHolds: boolean;
  ratedHolds: boolean;
  block: bigint;
  blockHash: string;
  at: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOOKUP_ID = /^rl_[0-9A-Za-z_-]{32}$/;
/** A Base ID a rating can name: decimal, canonical, above 0 (and within uint256, checked below). */
const BASE_ID = /^[1-9][0-9]{0,77}$/;
/** A passport number: the short id after centralcity.ai/a/, case-sensitive. */
const SHORT = /^[0-9A-Za-z]{6}$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The lookup body: exactly {baseId, passport}, both well formed. Nothing is trimmed or guessed. */
function parseLookup(input: unknown): RateLookup {
  const shape = 'Send baseId and passport: the agent’s Base ID and its passport number, both.';
  if (!isPlainObject(input)) throw new RateError('invalid_body', shape);
  const keys = Object.keys(input).sort().join(',');
  if (keys !== 'baseId,passport') throw new RateError('invalid_body', shape);
  const { baseId, passport } = input;
  if (typeof baseId !== 'string' || typeof passport !== 'string')
    throw new RateError('invalid_body', shape);
  if (!BASE_ID.test(baseId) || BigInt(baseId) > maxUint256)
    throw new RateError(
      'invalid_query',
      'A Base ID is a whole number above 0, digits only (for example 99515).',
    );
  if (!SHORT.test(passport))
    throw new RateError(
      'invalid_query',
      'A passport number is the 6 letters and digits after centralcity.ai/a/.',
    );
  return { baseId, passport };
}

interface RateBody {
  idempotencyKey: string;
  lookupId: string;
  stars: Stars;
}

function parseRate(input: unknown): RateBody {
  if (!isPlainObject(input))
    throw new RateError('invalid_body', 'Send to, stars and idempotencyKey.');
  const body = input;
  // The registry, the tags and the rating wallet are the server's: no other field is taken.
  if (Object.keys(body).some((key) => !['to', 'stars', 'idempotencyKey'].includes(key)))
    throw new RateError('invalid_body', 'Only to, stars and idempotencyKey are taken.');
  if (typeof body.idempotencyKey !== 'string' || !UUID.test(body.idempotencyKey))
    throw new RateError('invalid_body', 'idempotencyKey must be a UUID.');
  const to = body.to;
  if (
    !isPlainObject(to) ||
    Object.keys(to).join(',') !== 'lookupId' ||
    typeof to.lookupId !== 'string' ||
    !LOOKUP_ID.test(to.lookupId)
  )
    throw new RateError('invalid_body', 'to is {lookupId} from the lookup answer.');
  if (!isStars(body.stars))
    throw new RateError('invalid_stars', 'stars is a whole number from 1 to 5.', {
      min: 1,
      max: 5,
    });
  return {
    idempotencyKey: body.idempotencyKey.toLowerCase(),
    lookupId: to.lookupId,
    stars: body.stars,
  };
}

/** The rating as asked for, bound to the rating agent (the idempotency body). */
function requestHash(agentId: string, body: RateBody): string {
  const canonical = JSON.stringify(['rate-request-v1', agentId, body.lookupId, body.stars]);
  return `0x${createHash('sha256').update(canonical).digest('hex')}`;
}

/** A stored rating as RatingsGiven lists it; null for a row that is not a whole rating. */
function givenOf(row: GivenRow): RatingGiven | null {
  const stars = starsOf(BigInt(row.rating_value));
  if (stars === null) return null;
  const txHash = row.tx_hash ?? null;
  return {
    withdrawalId: row.withdrawal_id,
    ratedAgentId: row.agent_id,
    name: row.name ?? '',
    baseId: row.base_id,
    short: row.short_id ?? '',
    stars,
    state: row.state,
    txHash,
    blockNumber: row.block_number === null ? null : Number(row.block_number),
    explorerUrl: txHash ? `${TX_EXPLORER}${txHash}` : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function createRateService(deps: RateDeps) {
  const now = deps.now ?? Date.now;
  const registry = WALLET_NETWORK.contracts.identityRegistry;
  if (!registry) throw new Error('The wallet network has no identity registry.');
  // A reader for another network or registry would verify against the wrong records.
  if (
    deps.chain &&
    (deps.chain.chainId !== WALLET_CHAIN_ID ||
      deps.chain.registry.toLowerCase() !== registry.toLowerCase())
  )
    throw new Error('The Base reader is not the wallet network canonical registry.');
  const pay = createPayStore({ chainId: WALLET_CHAIN_ID, registry, network: WALLET_NETWORK });
  const store = createRateStore({ chainId: WALLET_CHAIN_ID, registry });
  const db = deps.db;

  /** The rating agent's own wallet, only for its owner account; 404 otherwise (not disclosed). */
  async function senderOf(accountId: string, agentId: string) {
    const sender = await pay.sender(db, accountId, agentId);
    if (!sender) throw new RateError('not_found', 'Not found.');
    return sender;
  }

  /**
   * The rating agent as a Central City agent: its wallet ready, and that very wallet the one of its
   * confirmed registration (final Base ID, passport). Refuses anything else.
   */
  async function raterOf(
    agentId: string,
    sender: { walletId: string; address: string; ready: boolean },
  ): Promise<RecipientRecord> {
    if (!sender.ready) throw raterNotEligible();
    const found = await pay.recipients(db, { wallet: sender.address });
    if (found.length !== 1 || found[0].agentId !== agentId || found[0].walletId !== sender.walletId)
      throw raterNotEligible();
    return found[0];
  }

  /**
   * The one Central City agent BOTH typed values name: its final Base ID is `baseId` and its
   * passport is `passport`. Neither naming one is not_rateable; one or both naming one, but not the
   * same, is lookup_mismatch. Two records for one value (our records are not unambiguous): refused.
   */
  async function agentNamedBy(typed: RateLookup): Promise<RecipientRecord> {
    const byBaseId = await pay.recipients(db, { baseId: typed.baseId });
    const byPassport = await pay.recipients(db, { short: typed.passport });
    if (byBaseId.length > 1 || byPassport.length > 1) throw notRateable();
    const [one, other] = [byBaseId[0], byPassport[0]];
    if (!one && !other) throw notRateable();
    if (!one || !other || one.agentId !== other.agentId) throw mismatch();
    // The same record found both ways: exactly the values typed (the short id is case-sensitive).
    if (one.baseId !== typed.baseId || one.short !== typed.passport) throw mismatch();
    return one;
  }

  /** Never the rater itself, never an agent of the same person. */
  async function refuseOwn(accountId: string, rater: RecipientRecord, rated: RecipientRecord) {
    if (
      rated.agentId === rater.agentId ||
      rated.walletId === rater.walletId ||
      rated.wallet.toLowerCase() === rater.wallet.toLowerCase() ||
      rated.baseId === rater.baseId
    )
      throw new RateError('same_person', 'An agent can’t rate itself.');
    // The person's own agents: owned by this account, in its own workspace, in the rater's
    // workspace, or in an AI workspace this person co-owns (operator_links). An agent without an
    // owner account (registered before wallets, or with an outside key) is caught by the last two.
    if (
      rated.ownerAccountId === accountId ||
      rated.workspaceId === accountId ||
      rated.workspaceId === rater.workspaceId
    )
      throw new RateError('same_person', 'You can’t rate your own agents.');
    const { rows } = await db.query(
      'SELECT 1 FROM operator_links WHERE human_operator_id = $1 AND ai_operator_id = $2 LIMIT 1',
      [accountId, rated.workspaceId],
    );
    if (rows.length) throw new RateError('same_person', 'You can’t rate your own agents.');
  }

  /** ownerOf of both Base IDs at one block, read fresh; never cached, never guessed. */
  async function readBoth(rater: RecipientRecord, rated: RecipientRecord): Promise<Evidence> {
    if (!deps.chain?.ownersOf) throw unavailable();
    let read;
    try {
      read = await deps.chain.ownersOf([rated.baseId, rater.baseId]);
    } catch {
      throw unavailable();
    }
    if (read.owners.length !== 2) throw unavailable();
    const holds = (owner: string | null, wallet: string) =>
      owner !== null && owner.toLowerCase() === wallet.toLowerCase();
    return {
      ratedHolds: holds(read.owners[0], rated.wallet),
      raterHolds: holds(read.owners[1], rater.wallet),
      block: read.block,
      blockHash: read.blockHash.toLowerCase(),
      at: now(),
    };
  }

  /** The lookup answer: exactly shared/base/rate.ts RateTarget. */
  const answer = (record: RecipientRecord, lookup: StoredRateLookup): RateTarget => ({
    lookupId: lookup.lookupId,
    agent: {
      agentId: record.agentId,
      name: record.name,
      baseId: record.baseId,
      short: record.short,
    },
    checkedAtBlock: Number(lookup.block),
    expiresAt: lookup.expiresAt,
  });

  return {
    /** Whether ratings are on, for the rater's owner (the routes answer 404 while they are off). */
    async status(accountId: string, agentId: string): Promise<{ enabled: boolean }> {
      await senderOf(accountId, agentId);
      return { enabled: true };
    },

    /** The ratings the rater's wallet made, for its owner; newest first, records only. */
    async given(accountId: string, agentId: string): Promise<RatingsGiven> {
      const sender = await senderOf(accountId, agentId);
      const rows = await store.given(db, {
        accountId,
        walletId: sender.walletId,
        now: now(),
        limit: RATINGS_GIVEN_MAX,
      });
      return {
        ratings: rows.map(givenOf).filter((rating): rating is RatingGiven => rating !== null),
      };
    },

    /** Who a rating would rate, checked with the rater on Base at one block; for this rater. */
    async lookup(accountId: string, agentId: string, input: unknown): Promise<RateTarget> {
      const sender = await senderOf(accountId, agentId);
      const typed = parseLookup(input);
      const rater = await raterOf(agentId, sender);
      const rated = await agentNamedBy(typed);
      await refuseOwn(accountId, rater, rated);
      const evidence = await readBoth(rater, rated);
      if (!evidence.raterHolds) throw raterNotEligible();
      if (!evidence.ratedHolds)
        throw notRateable(
          "This Base ID is not held by its Central City agent's wallet on Base right now.",
        );
      const lookup = await store.issueLookup(db, {
        lookupId: `rl_${randomBytes(24).toString('base64url')}`,
        accountId,
        rater,
        record: rated,
        block: evidence.block,
        blockHash: evidence.blockHash,
        issuedAt: evidence.at,
        expiresAt: evidence.at + PAY_RECIPIENT_TTL_MS,
        purgeBefore: evidence.at - CLOCK_SLACK_MS,
      });
      return answer(rated, lookup);
    },

    /** A rating from the agent's wallet, as an owner operation for its owner to sign (W2 shape). */
    async create(
      accountId: string,
      agentId: string,
      input: unknown,
    ): Promise<RatingSigningRequest> {
      const sender = await senderOf(accountId, agentId);
      const body = parseRate(input);
      // One cap for both counts of this request, read once.
      const dailyMax = deps.dailyMax?.() ?? RATE_DAILY_MAX;
      return deps.withdrawals.rate(accountId, agentId, {
        request: requestHash(agentId, body),
        idempotencyKey: body.idempotencyKey,
        // Only for a new rating (a replay is a read): the lookup this account was issued for this
        // rater, not expired; the cap; the same two agents in our records (the same Base ID AND
        // passport), neither the rater's own nor the same person's; both Base IDs held by their
        // wallets at one block, not a block Base dropped, and that check ended before the lookup
        // expired. Anything else is refused.
        beforePrepare: async () => {
          const lookup = await store.lookupFor(db, {
            lookupId: body.lookupId,
            accountId,
            raterAgentId: agentId,
          });
          if (!lookup || lookup.raterWalletId !== sender.walletId || now() > lookup.expiresAt)
            throw expired();
          if ((await store.today(db, accountId, now())) >= dailyMax) throw limitReached(dailyMax);
          const rater = await raterOf(agentId, sender);
          if (rater.baseId !== lookup.raterBaseId) throw changed();
          const byBaseId = await pay.recipients(db, { baseId: lookup.baseId });
          const byPassport = await pay.recipients(db, { short: lookup.short });
          const again = byBaseId[0];
          if (
            byBaseId.length !== 1 ||
            byPassport.length !== 1 ||
            byPassport[0].agentId !== again.agentId ||
            again.agentId !== lookup.agentId ||
            again.short !== lookup.short ||
            getAddress(again.wallet) !== lookup.wallet
          )
            throw changed();
          await refuseOwn(accountId, rater, again);
          const read = await readBoth(rater, again);
          if (!read.raterHolds) throw raterNotEligible();
          if (!read.ratedHolds) throw changed();
          // The same height with another hash: what was looked up was on a block Base dropped.
          if (read.block === lookup.block && read.blockHash !== lookup.blockHash.toLowerCase())
            throw changed();
          // A check that ended after the lookup expired confirms nothing that was shown.
          if (read.at > lookup.expiresAt) throw expired();
          return { agentId: again.agentId, baseId: BigInt(again.baseId), stars: body.stars };
        },
        // Counted again with the account locked, the new rating included: concurrent ratings of
        // one account (from any of its wallets) are counted one after the other.
        stored: async (tx: Transaction) => {
          await tx.query('SELECT 1 FROM operators WHERE id = $1 FOR UPDATE', [accountId]);
          if ((await store.today(tx, accountId, now())) > dailyMax) throw limitReached(dailyMax);
        },
      });
    },
  };
}

export type RateService = ReturnType<typeof createRateService>;
