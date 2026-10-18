/*
 * Operation Base Pay: the records behind a payment. Who a recipient is comes only from Central
 * City's own registration records, the ones the Agent Explorer lists (explorer/store.ts), narrowed
 * to CONFIRMED registrations on the wallet network: the canonical registry of that network, the
 * agent's own wallet on it and its short id, agent_card_uri == https://centralcity.ai/a/<short id>,
 * the final id handed over to that wallet and its mint seen on Base. Base itself is read by the pay
 * service (chain.ts), never here. Names are display only.
 *
 * Who may read a payment: the account that owns the recipient WALLET (base_wallets.owner_account_id)
 * and, on the paying side, the account that owns the sender wallet; never the agent's current
 * workspace or co-owners. An agent transferred or removed takes none of its payments, notes or
 * history to its new owner.
 */
import { getAddress } from 'viem';
import type { Transaction } from '../../database.js';
import type { BaseNetwork } from '../../../shared/base/chains.js';
import { AGENT_URI_ORIGIN } from '../../../shared/base/on-base.js';
import { agentWalletRecipe, DERIVATION_VERSION, deriveAddressLocal } from '../chain/derive.js';
import { PUBLIC_NAME } from '../explorer/store.js';
import { accountIndexFor } from '../wallet/service.js';

type Queryable = Pick<Transaction, 'query'>;

/** A wallet row as readiness needs it (wallet, its owner account's vault). */
interface WalletReadiness {
  agentId: string;
  address: string;
  ownerAccountId: string | null;
  ownerAddress: string;
  derivation: unknown;
  vaultOwner: string | null;
  backupConfirmedAt: string | number | null;
}

/**
 * Whether a wallet may receive or send a payment (interim rule, fail closed). ALL
 * of: it belongs to an owner account (owner_account_id set); its owner address is that account's
 * vault owner key; its stored recipe is exactly [vault owner, SpendPermissionManager] on this
 * network's factory at the agent's own account index, and derives to the stored address; that
 * vault's backup is confirmed. An identity wallet from before the vault (owner typed at
 * registration, no account) fails the first. Only for starting a payment: reads, signing and the
 * tracking of payments already sent never depend on it.
 */
export function walletReady(network: BaseNetwork, w: WalletReadiness): boolean {
  if (!w.ownerAccountId || !w.vaultOwner || w.backupConfirmedAt === null) return false;
  try {
    const vaultOwner = getAddress(w.vaultOwner);
    if (getAddress(w.ownerAddress) !== vaultOwner) return false;
    const expected = agentWalletRecipe(network, vaultOwner, accountIndexFor(w.agentId));
    const d = w.derivation as Record<string, unknown> | null;
    if (
      !d ||
      d.version !== DERIVATION_VERSION ||
      !Array.isArray(d.owners) ||
      d.owners.length !== expected.owners.length ||
      d.owners.some((owner, i) => getAddress(String(owner)) !== expected.owners[i]) ||
      typeof d.factory !== 'string' ||
      getAddress(d.factory) !== expected.factory ||
      d.accountIndex !== expected.index.toString(10)
    )
      return false;
    return deriveAddressLocal(expected) === getAddress(w.address);
  } catch {
    return false;
  }
}

/** The wallet and its owner account's vault, as walletReady needs them; alias w, joins v. */
const READINESS_COLUMNS = `w.owner_account_id, w.owner_address, w.derivation,
  v.owner_address AS vault_owner, v.backup_confirmed_at`;
const VAULT_JOIN = 'LEFT JOIN base_owner_vaults v ON v.operator_id = w.owner_account_id';

interface ReadinessRow {
  owner_account_id: string | null;
  owner_address: string;
  derivation: unknown;
  vault_owner: string | null;
  backup_confirmed_at: string | number | null;
}

const readinessOf = (agentId: string, address: string, row: ReadinessRow): WalletReadiness => ({
  agentId,
  address,
  ownerAccountId: row.owner_account_id,
  ownerAddress: row.owner_address,
  derivation: row.derivation,
  vaultOwner: row.vault_owner,
  backupConfirmedAt: row.backup_confirmed_at,
});

/** A Central City agent that can be paid on the wallet network, from our records alone. */
export interface RecipientRecord {
  agentId: string;
  baseId: string;
  short: string;
  walletId: string;
  /** Checksummed. */
  wallet: string;
  /** Display only: the public card name, '' while the card is not public. */
  name: string;
  /**
   * walletReady: the wallet is its owner account's vault wallet, backup confirmed. Not ready (for
   * example the identity wallet of an agent registered on Base before wallets existed, owned by the
   * address typed at registration, no account): nobody could withdraw from it or read what it
   * receives, so the pay service refuses it as a recipient (recipient_not_ready).
   */
  ready: boolean;
  /**
   * Whose agent it is: the wallet's owner account (null for a wallet from before the vault) and
   * the workspace it was registered in. Never shown; a rating refuses one's own agents by them.
   */
  ownerAccountId: string | null;
  workspaceId: string;
}

/** Confirmed registrations; $1 chain id, $2 registry, $3 agent URI origin. Aliases i, w, s. */
const CONFIRMED = `i.chain_id = $1 AND lower(i.registry_address) = lower($2)
  AND i.agent_card_uri = $3 || '/a/' || s.short_id
  AND i.state = 'confirmed' AND i.erc8004_agent_id IS NOT NULL
  AND i.handover_id = i.erc8004_agent_id AND i.mint_seen_at IS NOT NULL
  AND w.state <> 'closed'`;

const FROM = `FROM base_identities i
  JOIN base_wallets w ON w.agent_id = i.agent_id AND w.chain_id = i.chain_id
  JOIN base_short_ids s ON s.agent_id = i.agent_id`;

export type RecipientKey = { baseId: string } | { short: string } | { wallet: string };

export function createPayStore(options: {
  chainId: number;
  registry: string;
  network: BaseNetwork;
}) {
  const scope = [options.chainId, options.registry, AGENT_URI_ORIGIN];

  /**
   * The registered agents a Base ID, a short id or a wallet address names: at most two (two means
   * the records are not unambiguous, and the caller refuses).
   */
  async function recipients(db: Queryable, key: RecipientKey): Promise<RecipientRecord[]> {
    const [match, value] =
      'baseId' in key
        ? ['i.erc8004_agent_id = $4::numeric', key.baseId]
        : 'short' in key
          ? ['s.short_id = $4', key.short]
          : ['lower(w.address) = lower($4)', key.wallet];
    const { rows } = await db.query<
      {
        agent_id: string;
        base_id: string;
        short_id: string;
        wallet_id: string;
        address: string;
        operator_id: string;
        name: string | null;
      } & ReadinessRow
    >(
      `SELECT l.*, p.name FROM (
         SELECT i.agent_id, i.erc8004_agent_id::text AS base_id, s.short_id, w.wallet_id, w.address,
           w.operator_id, ${READINESS_COLUMNS}
         ${FROM} ${VAULT_JOIN} WHERE ${CONFIRMED} AND ${match}
         ORDER BY i.agent_id LIMIT 2) l
       ${PUBLIC_NAME}`,
      [...scope, value],
    );
    return rows.map((row) => ({
      agentId: row.agent_id,
      baseId: row.base_id,
      short: row.short_id,
      walletId: row.wallet_id,
      wallet: getAddress(row.address),
      name: row.name ?? '',
      ready: walletReady(options.network, readinessOf(row.agent_id, row.address, row)),
      ownerAccountId: row.owner_account_id,
      workspaceId: row.operator_id,
    }));
  }

  /**
   * The paying agent's own wallet, only for the wallet's owner account; null otherwise (also for a
   * wallet from before the vault, which has no owner account). `ready`: walletReady.
   */
  async function sender(db: Queryable, accountId: string, agentId: string) {
    const { rows } = await db.query<
      { wallet_id: string; address: string; operator_id: string } & ReadinessRow
    >(
      `SELECT w.wallet_id, w.address, w.operator_id, ${READINESS_COLUMNS}
       FROM base_wallets w ${VAULT_JOIN}
       WHERE w.agent_id = $1 AND w.chain_id = $2 AND w.owner_account_id = $3`,
      [agentId, options.chainId, accountId],
    );
    const row = rows[0];
    return row
      ? {
          walletId: row.wallet_id,
          address: getAddress(row.address),
          operatorId: row.operator_id,
          ready: walletReady(options.network, readinessOf(agentId, row.address, row)),
        }
      : null;
  }

  /**
   * Issues the lookup a recipient answer names (base_pay_lookups): one per account, recipient and
   * block, so the same lookup at the same block answers the same lookupId; a row past its expiry
   * is issued again under a new id. Lookups past their expiry (and the clock slack) are deleted
   * here, a bounded batch at a time.
   */
  async function issueLookup(
    db: Queryable,
    input: {
      lookupId: string;
      accountId: string;
      record: RecipientRecord;
      block: bigint;
      blockHash: string;
      issuedAt: number;
      expiresAt: number;
      purgeBefore: number;
    },
  ): Promise<IssuedLookup> {
    await db.query(
      `DELETE FROM base_pay_lookups WHERE lookup_id IN (
         SELECT lookup_id FROM base_pay_lookups WHERE expires_at < $1
         ORDER BY expires_at LIMIT 100)`,
      [input.purgeBefore],
    );
    const values = [
      input.lookupId,
      input.accountId,
      options.chainId,
      options.registry,
      input.record.agentId,
      input.record.baseId,
      input.record.short,
      input.record.wallet,
      input.block.toString(10),
      input.blockHash.toLowerCase(),
      input.issuedAt,
      input.expiresAt,
    ];
    const issued = await db.query<LookupRow>(
      `INSERT INTO base_pay_lookups (lookup_id, account_id, chain_id, registry_address, agent_id,
         base_id, short_id, wallet, block, block_hash, issued_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (account_id, chain_id, registry_address, agent_id, base_id, wallet, block_hash)
       DO UPDATE SET lookup_id = EXCLUDED.lookup_id, short_id = EXCLUDED.short_id,
         block = EXCLUDED.block, issued_at = EXCLUDED.issued_at, expires_at = EXCLUDED.expires_at
         WHERE base_pay_lookups.expires_at < EXCLUDED.issued_at
       RETURNING ${LOOKUP_COLUMNS}`,
      values,
    );
    if (issued.rows[0]) return lookupOf(issued.rows[0]);
    // Issued before at this very block and still valid: the same lookup.
    const { rows } = await db.query<LookupRow>(
      `SELECT ${LOOKUP_COLUMNS} FROM base_pay_lookups
       WHERE account_id = $1 AND chain_id = $2 AND registry_address = $3 AND agent_id = $4
         AND base_id = $5::numeric AND wallet = $6 AND block_hash = $7`,
      [
        input.accountId,
        options.chainId,
        options.registry,
        input.record.agentId,
        input.record.baseId,
        input.record.wallet,
        input.blockHash.toLowerCase(),
      ],
    );
    if (!rows[0]) throw new Error('The lookup could not be issued.');
    return lookupOf(rows[0]);
  }

  /** A lookup this account was issued on this network and registry; null for anything else. */
  async function lookupFor(
    db: Queryable,
    lookupId: string,
    accountId: string,
  ): Promise<IssuedLookup | null> {
    const { rows } = await db.query<LookupRow>(
      `SELECT ${LOOKUP_COLUMNS} FROM base_pay_lookups
       WHERE lookup_id = $1 AND account_id = $2 AND chain_id = $3
         AND lower(registry_address) = lower($4)`,
      [lookupId, accountId, options.chainId, options.registry],
    );
    return rows[0] ? lookupOf(rows[0]) : null;
  }

  /** The payment a key was first used for by this owner account. */
  async function byKey(db: Queryable, accountId: string, key: string) {
    const { rows } = await db.query<{ request_hash: string; recipient_address: string }>(
      `SELECT request_hash, recipient_address FROM base_wallet_payments
       WHERE owner_account_id = $1 AND idempotency_key = $2`,
      [accountId, key],
    );
    return rows[0] ?? null;
  }

  /** Whether a withdrawal went out as a payment (its cancel is never owner-funded). */
  async function isPayment(db: Queryable, withdrawalId: string): Promise<boolean> {
    const { rows } = await db.query('SELECT 1 FROM base_wallet_payments WHERE withdrawal_id = $1', [
      withdrawalId,
    ]);
    return rows.length > 0;
  }

  async function insert(tx: Queryable, row: PaymentInsert) {
    await tx.query(
      `INSERT INTO base_wallet_payments (payment_id, withdrawal_id, chain_id, owner_account_id,
         sender_wallet_id, sender_agent_id, idempotency_key, request_hash, token, amount_raw,
         recipient_kind, recipient_address, recipient_agent_id, recipient_wallet_id,
         recipient_base_id, recipient_short_id, registry_address, lookup_id, issued_block,
         issued_block_hash, issued_expires_at, verified_block, verified_block_hash, verified_at,
         note, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'USDC',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
         $22,$23,$24,$25)`,
      [
        row.paymentId,
        row.withdrawalId,
        options.chainId,
        row.accountId,
        row.senderWalletId,
        row.senderAgentId,
        row.idempotencyKey,
        row.requestHash,
        row.amount,
        row.recipient.kind,
        row.recipient.address,
        row.recipient.agentId ?? null,
        row.recipient.walletId ?? null,
        row.recipient.baseId ?? null,
        row.recipient.short ?? null,
        row.recipient.registry ?? null,
        row.recipient.lookup?.lookupId ?? null,
        row.recipient.lookup?.block ?? null,
        row.recipient.lookup?.blockHash ?? null,
        row.recipient.lookup?.expiresAt ?? null,
        row.recipient.verified?.block ?? null,
        row.recipient.verified?.blockHash ?? null,
        row.recipient.verified?.at ?? null,
        row.note,
        row.at,
      ],
    );
  }

  /** One payment with its recipient's current public name, by the withdrawal it went out as. */
  async function byWithdrawal(db: Queryable, withdrawalId: string) {
    const { rows } = await db.query<StoredPayment>(
      `SELECT l.*, p.name FROM (
         SELECT payment_id, withdrawal_id, recipient_kind, recipient_address,
           recipient_agent_id AS agent_id, recipient_base_id::text AS recipient_base_id,
           recipient_short_id, registry_address, lookup_id, issued_block::text AS issued_block,
           issued_block_hash, issued_expires_at::text AS issued_expires_at,
           verified_block::text AS verified_block, verified_block_hash,
           verified_at::text AS verified_at, note
         FROM base_wallet_payments WHERE withdrawal_id = $1) l
       ${PUBLIC_NAME}`,
      [withdrawalId],
    );
    return rows[0] ?? null;
  }

  /**
   * The withdrawals of payments to wallets this account owns that are signed and not settled yet,
   * least recently brought up to date first (so every one gets its turn), at most `limit`; marked
   * as checked now.
   */
  async function pendingIncoming(
    db: Queryable,
    input: { accountId: string; limit: number; at: number },
  ): Promise<string[]> {
    const { rows } = await db.query<{ withdrawal_id: string }>(
      `UPDATE base_wallet_payments SET checked_at = $4 WHERE payment_id IN (
         SELECT pm.payment_id FROM base_wallet_payments pm
         JOIN base_wallets rw ON rw.wallet_id = pm.recipient_wallet_id
         JOIN base_wallet_withdrawals x ON x.withdrawal_id = pm.withdrawal_id
         WHERE pm.chain_id = $1 AND pm.final_at IS NULL AND rw.owner_account_id = $2
           AND x.state IN ('submitted','included','cancel_pending')
         ORDER BY pm.checked_at ASC NULLS FIRST, pm.created_at ASC LIMIT $3)
       RETURNING withdrawal_id`,
      [options.chainId, input.accountId, input.limit, input.at],
    );
    return rows.map((row) => row.withdrawal_id);
  }

  /**
   * Payments to wallets this account owns, once the payer signed them (an unsigned one was never
   * sent), in whatever state they are, oldest change first, after the cursor (the change's
   * transaction id, then the payment id). Only changes whose transaction is older than every
   * transaction still running are returned, so a later page can never miss one that commits late.
   * What the money did (amount, destination) is the withdrawal's own, and only shown while it is
   * the recipient wallet's. Both agents' names are their public card names.
   */
  async function incoming(
    db: Queryable,
    input: { accountId: string; after: { xid: string; paymentId: string } | null; limit: number },
  ) {
    const { rows } = await db.query<IncomingRow>(
      // Two public-name joins (explorer/store.ts PUBLIC_NAME, on a subquery aliased l): the
      // recipient agent inside, the paying agent outside.
      `SELECT l.*, p.name AS from_name FROM (
         SELECT l.payment_id, l.withdrawal_id, l.sender_agent_id AS agent_id, l.from_wallet,
           l.from_base_id, l.from_short, l.recipient_agent_id, l.destination, l.to_base_id,
           l.to_short, p.name AS to_name, l.amount_raw, l.note, l.state, l.tx_hash, l.sent_at,
           l.updated_at, l.final_at, l.safe_at, l.change_xid
         FROM (
           SELECT pm.payment_id, pm.withdrawal_id, pm.recipient_agent_id AS agent_id,
             pm.sender_agent_id, sw.address AS from_wallet, fi.base_id AS from_base_id,
             fi.short_id AS from_short, pm.recipient_agent_id, x.destination,
             pm.recipient_base_id::text AS to_base_id, pm.recipient_short_id AS to_short,
             x.amount_raw::text AS amount_raw, pm.note, x.state, x.tx_hash,
             x.signed_at::text AS sent_at, x.updated_at::text AS updated_at,
             pm.final_at::text AS final_at,
             CASE WHEN x.error_code IS NULL THEN x.safe_at::text END AS safe_at,
             pm.change_xid::text AS change_xid
           FROM base_wallet_payments pm
           JOIN base_wallets rw ON rw.wallet_id = pm.recipient_wallet_id
           JOIN base_wallets sw ON sw.wallet_id = pm.sender_wallet_id
           JOIN base_wallet_withdrawals x ON x.withdrawal_id = pm.withdrawal_id
           LEFT JOIN LATERAL (
             SELECT i.erc8004_agent_id::text AS base_id, s.short_id ${FROM}
             WHERE i.agent_id = pm.sender_agent_id AND ${CONFIRMED} LIMIT 1) fi ON true
           WHERE pm.chain_id = $1 AND rw.owner_account_id = $4 AND x.signed_at IS NOT NULL
             AND x.token = 'USDC' AND lower(x.destination) = lower(rw.address)
             AND x.wallet_id = pm.sender_wallet_id
             AND pm.change_xid < pg_snapshot_xmin(pg_current_snapshot())
             AND ($5::xid8 IS NULL OR (pm.change_xid, pm.payment_id) > ($5::xid8, $6::text))
           ORDER BY pm.change_xid ASC, pm.payment_id ASC LIMIT $7) l
         ${PUBLIC_NAME}) l
       ${PUBLIC_NAME}
       ORDER BY l.change_xid::xid8 ASC, l.payment_id ASC`,
      [
        ...scope,
        input.accountId,
        input.after?.xid ?? null,
        input.after?.paymentId ?? '',
        input.limit,
      ],
    );
    return rows;
  }

  /**
   * Marks the payment of a withdrawal final, once, inside the transaction that records the
   * withdrawal final, with an audit event for the recipient's agent. Nothing for a withdrawal
   * that is not a payment.
   */
  async function markFinal(tx: Queryable, withdrawalId: string, at: number, txHash: string | null) {
    const { rows } = await tx.query<{
      payment_id: string;
      owner_account_id: string;
      recipient_kind: string;
      recipient_agent_id: string | null;
      recipient_wallet_id: string | null;
      recipient_address: string;
      amount_raw: string;
    }>(
      `UPDATE base_wallet_payments SET final_at = $2
       WHERE withdrawal_id = $1 AND final_at IS NULL
       RETURNING payment_id, owner_account_id, recipient_kind, recipient_agent_id,
         recipient_wallet_id, recipient_address, amount_raw::text AS amount_raw`,
      [withdrawalId, at],
    );
    const row = rows[0];
    if (!row || row.recipient_kind !== 'central_city_agent') return;
    await tx.query(
      `INSERT INTO base_audit_events (at, actor, operator_id, agent_id, kind, detail)
       SELECT $1, $2, w.operator_id, $3, 'payment_received', $4
       FROM base_wallets w WHERE w.wallet_id = $5`,
      [
        at,
        row.owner_account_id,
        row.recipient_agent_id,
        JSON.stringify({
          paymentId: row.payment_id,
          withdrawalId,
          token: 'USDC',
          amount: row.amount_raw,
          to: row.recipient_address,
          txHash,
        }),
        row.recipient_wallet_id,
      ],
    );
  }

  return {
    recipients,
    sender,
    issueLookup,
    lookupFor,
    byKey,
    isPayment,
    insert,
    byWithdrawal,
    pendingIncoming,
    incoming,
    markFinal,
  };
}

export type PayStore = ReturnType<typeof createPayStore>;

const LOOKUP_COLUMNS = `lookup_id, agent_id, base_id::text AS base_id, short_id, wallet,
  block::text AS block, block_hash, issued_at::text AS issued_at, expires_at::text AS expires_at`;

interface LookupRow {
  lookup_id: string;
  agent_id: string;
  base_id: string;
  short_id: string;
  wallet: string;
  block: string;
  block_hash: string;
  issued_at: string;
  expires_at: string;
}

/** A lookup as the server issued it: what the person saw and may confirm, until it expires. */
export interface IssuedLookup {
  lookupId: string;
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

const lookupOf = (row: LookupRow): IssuedLookup => ({
  lookupId: row.lookup_id,
  agentId: row.agent_id,
  baseId: row.base_id,
  short: row.short_id,
  wallet: getAddress(row.wallet),
  block: BigInt(row.block),
  blockHash: row.block_hash,
  issuedAt: Number(row.issued_at),
  expiresAt: Number(row.expires_at),
});

export interface PaymentInsert {
  paymentId: string;
  withdrawalId: string;
  accountId: string;
  senderWalletId: string;
  senderAgentId: string;
  idempotencyKey: string;
  requestHash: string;
  amount: string;
  note: string | null;
  at: number;
  recipient: {
    kind: 'central_city_agent' | 'address';
    address: string;
    agentId?: string;
    walletId?: string;
    baseId?: string;
    short?: string;
    registry?: string;
    /** The lookup the person confirmed, as the server issued it. */
    lookup?: { lookupId: string; block: string; blockHash: string; expiresAt: number };
    verified?: { block: string; blockHash: string; at: number };
  };
}

export interface StoredPayment {
  payment_id: string;
  withdrawal_id: string;
  recipient_kind: 'central_city_agent' | 'address';
  recipient_address: string;
  agent_id: string | null;
  recipient_base_id: string | null;
  recipient_short_id: string | null;
  registry_address: string | null;
  lookup_id: string | null;
  issued_block: string | null;
  issued_block_hash: string | null;
  issued_expires_at: string | null;
  verified_block: string | null;
  verified_block_hash: string | null;
  verified_at: string | null;
  note: string | null;
  name: string | null;
}

export interface IncomingRow {
  payment_id: string;
  withdrawal_id: string;
  agent_id: string;
  from_wallet: string;
  from_base_id: string | null;
  from_short: string | null;
  from_name: string | null;
  recipient_agent_id: string;
  /** The withdrawal's own destination: where the money went. */
  destination: string;
  to_base_id: string;
  to_short: string;
  to_name: string | null;
  /** The withdrawal's own amount. */
  amount_raw: string;
  note: string | null;
  /** The withdrawal's state (base_wallet_withdrawals.state). */
  state: string;
  tx_hash: string | null;
  sent_at: string;
  updated_at: string;
  final_at: string | null;
  /**
   * When Base was proven to have settled the paying withdrawal at its safe head, for the receipt
   * it holds now (base_wallet_withdrawals.safe_at, schema.ts migration 96); null when reverted.
   */
  safe_at: string | null;
  /** The change's transaction id: with payment_id, the cursor. */
  change_xid: string;
}
