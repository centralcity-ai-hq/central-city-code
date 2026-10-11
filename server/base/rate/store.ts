/*
 * Operation Rating R1: the records behind a rating that are not the rating itself. Who an agent is
 * comes from Pay's records (pay/store.ts: confirmed registrations on the wallet network, the agent's
 * own wallet, its passport); a rating is a row of base_wallet_withdrawals (kind 'rate'). Here:
 *
 *   lookups   what a rating lookup showed (base_rate_lookups, migration 94), like base_pay_lookups:
 *             for the account that looked up AND the rater agent and wallet it looked up for, until
 *             it expires; the same lookup at the same block answers the same lookupId; rows past
 *             their expiry are deleted a bounded batch at a time as new ones are issued.
 *   today     how many ratings an account created within the current Berlin calendar day, the day
 *             the spending limits count by (shared/base/spend-limits.ts calendarPeriod('day')):
 *             every rating row it created, in whatever state (signed or not, expired, cancelled).
 *   given     the ratings one wallet made for the account that owns it, newest first: signed ones
 *             in every state, and an unsigned one only while it can still be signed. The rated
 *             agent's passport number (base_short_ids) and public card name (explorer/store.ts
 *             PUBLIC_NAME) as they are now; display only.
 */
import { getAddress } from 'viem';
import type { Transaction } from '../../database.js';
import { calendarPeriod } from '../../../shared/base/spend-limits.js';
import type { WithdrawalState } from '../../../shared/base/withdraw.js';
import { PUBLIC_NAME } from '../explorer/store.js';
import type { RecipientRecord } from '../pay/store.js';

type Queryable = Pick<Transaction, 'query'>;

/** A rating lookup as the server issued it: what the person saw and may rate, until it expires. */
export interface StoredRateLookup {
  lookupId: string;
  raterAgentId: string;
  raterWalletId: string;
  raterBaseId: string;
  /** The rated agent. */
  agentId: string;
  baseId: string;
  short: string;
  /** Checksummed. */
  wallet: string;
  block: bigint;
  blockHash: string;
  issuedAt: number;
  expiresAt: number;
}

const LOOKUP_COLUMNS = `lookup_id, rater_agent_id, rater_wallet_id,
  rater_base_id::text AS rater_base_id, agent_id, base_id::text AS base_id, short_id, wallet,
  block::text AS block, block_hash, issued_at::text AS issued_at, expires_at::text AS expires_at`;

interface LookupRow {
  lookup_id: string;
  rater_agent_id: string;
  rater_wallet_id: string;
  rater_base_id: string;
  agent_id: string;
  base_id: string;
  short_id: string;
  wallet: string;
  block: string;
  block_hash: string;
  issued_at: string;
  expires_at: string;
}

const lookupOf = (row: LookupRow): StoredRateLookup => ({
  lookupId: row.lookup_id,
  raterAgentId: row.rater_agent_id,
  raterWalletId: row.rater_wallet_id,
  raterBaseId: row.rater_base_id,
  agentId: row.agent_id,
  baseId: row.base_id,
  short: row.short_id,
  wallet: getAddress(row.wallet),
  block: BigInt(row.block),
  blockHash: row.block_hash,
  issuedAt: Number(row.issued_at),
  expiresAt: Number(row.expires_at),
});

/** A rating as `given` reads it (base_wallet_withdrawals kind 'rate', its rated agent now). */
export interface GivenRow {
  withdrawal_id: string;
  agent_id: string;
  base_id: string;
  short_id: string | null;
  rating_value: number;
  state: WithdrawalState;
  tx_hash: string | null;
  block_number: string | null;
  created_at: string;
  updated_at: string;
  name: string | null;
}

export function createRateStore(options: { chainId: number; registry: string }) {
  /** Issues (or answers again, at the same block) the lookup of a rated agent for a rater. */
  async function issueLookup(
    db: Queryable,
    input: {
      lookupId: string;
      accountId: string;
      rater: RecipientRecord;
      record: RecipientRecord;
      block: bigint;
      blockHash: string;
      issuedAt: number;
      expiresAt: number;
      purgeBefore: number;
    },
  ): Promise<StoredRateLookup> {
    await db.query(
      `DELETE FROM base_rate_lookups WHERE lookup_id IN (
         SELECT lookup_id FROM base_rate_lookups WHERE expires_at < $1
         ORDER BY expires_at LIMIT 100)`,
      [input.purgeBefore],
    );
    const key = [
      input.accountId,
      input.rater.agentId,
      options.chainId,
      options.registry,
      input.record.agentId,
      input.record.baseId,
      input.record.wallet,
      input.blockHash.toLowerCase(),
    ];
    const issued = await db.query<LookupRow>(
      `INSERT INTO base_rate_lookups (account_id, rater_agent_id, chain_id, registry_address,
         agent_id, base_id, wallet, block_hash, lookup_id, rater_wallet_id, rater_base_id,
         short_id, block, issued_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (account_id, rater_agent_id, chain_id, registry_address, agent_id, base_id,
         wallet, block_hash)
       DO UPDATE SET lookup_id = EXCLUDED.lookup_id, rater_wallet_id = EXCLUDED.rater_wallet_id,
         rater_base_id = EXCLUDED.rater_base_id, short_id = EXCLUDED.short_id,
         block = EXCLUDED.block, issued_at = EXCLUDED.issued_at, expires_at = EXCLUDED.expires_at
         WHERE base_rate_lookups.expires_at < EXCLUDED.issued_at
       RETURNING ${LOOKUP_COLUMNS}`,
      [
        ...key,
        input.lookupId,
        input.rater.walletId,
        input.rater.baseId,
        input.record.short,
        input.block.toString(10),
        input.issuedAt,
        input.expiresAt,
      ],
    );
    if (issued.rows[0]) return lookupOf(issued.rows[0]);
    // Issued before at this very block and still valid: the same lookup.
    const { rows } = await db.query<LookupRow>(
      `SELECT ${LOOKUP_COLUMNS} FROM base_rate_lookups
       WHERE account_id = $1 AND rater_agent_id = $2 AND chain_id = $3 AND registry_address = $4
         AND agent_id = $5 AND base_id = $6::numeric AND wallet = $7 AND block_hash = $8`,
      key,
    );
    if (!rows[0]) throw new Error('The lookup could not be issued.');
    return lookupOf(rows[0]);
  }

  /** A lookup this account was issued for this rater agent; null for anything else. */
  async function lookupFor(
    db: Queryable,
    input: { lookupId: string; accountId: string; raterAgentId: string },
  ): Promise<StoredRateLookup | null> {
    const { rows } = await db.query<LookupRow>(
      `SELECT ${LOOKUP_COLUMNS} FROM base_rate_lookups
       WHERE lookup_id = $1 AND account_id = $2 AND rater_agent_id = $3 AND chain_id = $4
         AND lower(registry_address) = lower($5)`,
      [input.lookupId, input.accountId, input.raterAgentId, options.chainId, options.registry],
    );
    return rows[0] ? lookupOf(rows[0]) : null;
  }

  /** The ratings this account created within the Berlin calendar day of `nowMs`. */
  async function today(db: Queryable, accountId: string, nowMs: number): Promise<number> {
    const day = calendarPeriod('day', nowMs);
    const { rows } = await db.query<{ n: string | number }>(
      `SELECT count(*) AS n FROM base_wallet_withdrawals
       WHERE owner_account_id = $1 AND kind = 'rate' AND created_at >= $2 AND created_at < $3`,
      [accountId, day.start * 1000, day.end * 1000],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * The ratings `walletId` made while `accountId` owned it, newest first, at most `limit`: every
   * signed one, and an unsigned one only until it expires (one never signed in time is left out).
   */
  async function given(
    db: Queryable,
    input: { accountId: string; walletId: string; now: number; limit: number },
  ): Promise<GivenRow[]> {
    const { rows } = await db.query<GivenRow>(
      // The public-name join (explorer/store.ts PUBLIC_NAME) reads l.agent_id: the rated agent.
      `SELECT l.*, p.name FROM (
         SELECT x.withdrawal_id, x.rated_agent_id AS agent_id,
           x.rated_base_id::text AS base_id, s.short_id, x.rating_value, x.state, x.tx_hash,
           x.block_number::text AS block_number, x.created_at::text AS created_at,
           x.updated_at::text AS updated_at
         FROM base_wallet_withdrawals x
         LEFT JOIN base_short_ids s ON s.agent_id = x.rated_agent_id
         WHERE x.owner_account_id = $1 AND x.wallet_id = $2 AND x.kind = 'rate'
           AND x.chain_id = $3
           AND (x.signed_at IS NOT NULL
             OR (x.state = 'awaiting_signature' AND x.expires_at > $4))
         ORDER BY x.created_at DESC, x.withdrawal_id DESC
         LIMIT $5) l
       ${PUBLIC_NAME}
       ORDER BY l.created_at::bigint DESC, l.withdrawal_id DESC`,
      [input.accountId, input.walletId, options.chainId, input.now, input.limit],
    );
    return rows;
  }

  return { issueLookup, lookupFor, today, given };
}

export type RateStore = ReturnType<typeof createRateStore>;
