/*
 * Synthetic On Base fixtures (low-entropy values only): an in-memory database with the Base
 * tables, and registrations in each state the explorer has to tell apart.
 */
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../server/database.js';
import {
  BASE_IDENTITY_PROVISIONAL_SQL,
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  BASE_SHARED_ADDITIONS_SQL,
  BASE_WALLET_LANES_SQL,
  BASE_WALLET_LIMITS_SQL,
  BASE_WALLET_ONE_UNSIGNED_SQL,
  BASE_WALLET_PAYMENTS_SQL,
  BASE_WALLET_RATINGS_SQL,
  BASE_WALLET_VAULT_SQL,
  BASE_WALLET_WITHDRAWALS_SQL,
  baseShortIdsMigration,
} from '../server/base/schema.js';
import { BASE_NETWORKS } from '../shared/base/chains.js';
import { AGENT_URI_ORIGIN } from '../shared/base/on-base.js';

export const REGISTRY = BASE_NETWORKS[8453].contracts.identityRegistry!;
export const SEPOLIA_REGISTRY = BASE_NETWORKS[84532].contracts.identityRegistry!;
export const NOW = 1_791_640_000_000;
export const MIN = 60_000;

// Synthetic, low-entropy fixtures.
export const hex2 = (n: number) => n.toString(16).padStart(2, '0');
export const agentId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const shortOf = (n: number) => `S${String(n).padStart(5, '0')}`;
export const agentWallet = (n: number) => `0x${'1'.repeat(36)}${hex2(n >> 8)}${hex2(n & 255)}`;
export const ownerWallet = (n: number) => `0x${'2'.repeat(36)}${hex2(n >> 8)}${hex2(n & 255)}`;
export const spender = (n: number) => `0x${'3'.repeat(36)}${hex2(n >> 8)}${hex2(n & 255)}`;
export const mintTx = (n: number) => `0x${'4'.repeat(60)}${hex2(n >> 8)}${hex2(n & 255)}`;
export const handoverTx = (n: number) => `0x${'5'.repeat(60)}${hex2(n >> 8)}${hex2(n & 255)}`;
export const blockHash = (n: number) => `0x${'6'.repeat(60)}${hex2(n >> 8)}${hex2(n & 255)}`;

export async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(
    `CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws');
     CREATE TABLE workspaces (operator_id text PRIMARY KEY REFERENCES operators(id), data jsonb NOT NULL);
     INSERT INTO workspaces VALUES ('ws', '{"agents": []}');
     CREATE TABLE agent_manifests (
       agent_id text NOT NULL, revision integer NOT NULL, manifest_hash text NOT NULL,
       manifest jsonb NOT NULL, created_at bigint NOT NULL,
       operator_id text NOT NULL REFERENCES operators(id), PRIMARY KEY(agent_id, revision));`,
  );
  // The Base schema up to ratings (94) and lanes (95), in the order the wallet suites apply it:
  // the list's score reads the ratings (base_wallet_withdrawals kind 'rate').
  for (const sql of [
    BASE_MIGRATION_SQL,
    BASE_PAYMENTS_MIGRATION_SQL,
    baseShortIdsMigration.sql,
    BASE_SHARED_ADDITIONS_SQL,
    BASE_IDENTITY_PROVISIONAL_SQL,
    BASE_WALLET_VAULT_SQL,
    BASE_WALLET_WITHDRAWALS_SQL,
    BASE_WALLET_PAYMENTS_SQL,
    BASE_WALLET_LIMITS_SQL,
    BASE_WALLET_ONE_UNSIGNED_SQL,
    BASE_WALLET_RATINGS_SQL,
    BASE_WALLET_LANES_SQL,
  ])
    await pg.exec(sql);
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  return db;
}

export type Kind = 'final' | 'finalizing' | 'included' | 'lost' | 'pending' | 'failed';
export interface Fixture {
  n: number;
  kind: Kind;
  id?: number;
  name?: string;
  /** Older names, revision by revision; the last entry of `names` + `name` is current. */
  formerNames?: string[];
  visibility?: 'public' | 'private';
  revoked?: boolean;
  chainId?: number;
  registry?: string;
  uri?: string;
  shortId?: boolean;
  seenAt?: number | null;
  updatedAt?: number;
  mintBlock?: number | null;
  handoverBlock?: number | null;
  /**
   * A confirmed row from before migration 85, as its backfill left it: no mint transaction, block
   * or pinned register operation, no hand-over evidence, and tx_hash holding the hand-over.
   */
  legacy?: boolean;
  /**
   * Finalizing, after the mint went final: the identity service has stored that same id as the
   * final one (erc8004_agent_id) while it waits for the hand-over to confirm.
   */
  finalIdStored?: boolean;
}

/** A stored chain operation (base_chain_ops), only the columns the explorer reads. */
export async function addOp(
  db: Database,
  op: { key: string; kind?: string; status: string; txHash: string | null; chainId?: number },
) {
  await db.query(
    `INSERT INTO base_chain_ops (op_id, idempotency_key, intent_hash, kind, chain_id, status,
       tx_hash, created_at, updated_at)
     VALUES ($1, $1, '0x00', $2, $3, $4, $5, 1, 1)`,
    [op.key, op.kind ?? 'register', op.chainId ?? 8453, op.status, op.txHash],
  );
}

/** The register operation key the identity service uses (attempt 0 has no suffix). */
export const registerOpKey = (n: number, attempt = 0, chainId = 8453) =>
  `identity:register:${chainId}:${agentId(n)}${attempt ? `:${attempt}` : ''}`;

export async function add(db: Database, f: Fixture) {
  const agent = agentId(f.n);
  const chainId = f.chainId ?? 8453;
  const short = shortOf(f.n);
  const names = [...(f.formerNames ?? []), f.name ?? `Agent ${f.n}`];
  for (const [index, displayName] of names.entries())
    await db.query(`INSERT INTO agent_manifests VALUES ($1, $2, 'h', $3, 1, 'ws')`, [
      agent,
      index + 1,
      JSON.stringify({
        metadata: { name: `agent-${f.n}`, displayName },
        spec: { visibility: f.visibility ?? 'public' },
      }),
    ]);
  await db.query(
    `UPDATE workspaces SET data = jsonb_set(data, '{agents}', (data->'agents') || $1::jsonb)
     WHERE operator_id = 'ws'`,
    [
      JSON.stringify([
        {
          id: agent,
          revision: names.length,
          revokedAt: f.revoked ? '2026-10-01T00:00:00.000Z' : null,
        },
      ]),
    ],
  );
  await db.query(
    `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
       spender_address, spender_key_ref, derivation, state, created_at, updated_at)
     VALUES ($1, $2, 'ws', $3, $4, $5, $6, 'v1:key-0001', '{}', 'derived', 1, 1)`,
    [`w-${f.n}`, agent, chainId, agentWallet(f.n), ownerWallet(f.n), spender(f.n)],
  );
  if (f.shortId !== false)
    await db.query('INSERT INTO base_short_ids VALUES ($1, $2, 1)', [short, agent]);
  const id = f.id ?? null;
  const minted = id !== null && f.kind !== 'pending' && f.kind !== 'failed';
  const final = f.kind === 'final';
  const state =
    f.kind === 'final'
      ? 'confirmed'
      : f.kind === 'pending'
        ? 'pending'
        : f.kind === 'failed'
          ? 'failed'
          : 'submitted';
  const seen = f.seenAt === undefined ? (minted ? NOW - 10 * MIN : null) : f.seenAt;
  const mintBlock = f.mintBlock === undefined ? 1000 + f.n : f.mintBlock;
  const handoverBlock = f.handoverBlock === undefined ? 1005 + f.n : f.handoverBlock;
  const handoverFinality =
    f.kind === 'final' ? 'final' : f.kind === 'included' ? 'included' : 'safe';
  const legacy = f.legacy === true;
  const fresh = minted && !legacy;
  await db.query(
    `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address,
       erc8004_agent_id, agent_card_uri, owner_of_identity, state, op_id, tx_hash, updated_at,
       register_op_id, mint_op_id, provisional_agent_id, mint_tx_hash, mint_block, mint_block_hash,
       mint_finality, mint_seen_at, mint_lost_at, transfer_op_id, handover_id, handover_tx_hash,
       handover_block, handover_block_hash, handover_finality, started_at)
     VALUES ($1, $2, 'ws', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
       $18, $19, $20, $21, $22, $23, $24, $25, $26)`,
    [
      agent,
      chainId,
      f.registry ?? (chainId === 8453 ? REGISTRY : SEPOLIA_REGISTRY),
      final || (f.finalIdStored && minted) ? id : null,
      f.uri ?? `${AGENT_URI_ORIGIN}/a/${short}`,
      final ? agentWallet(f.n) : spender(f.n),
      state,
      minted ? `identity:transfer:${chainId}:${agent}${legacy ? '' : `~${id}`}` : null,
      minted ? (legacy ? handoverTx(f.n) : mintTx(f.n)) : null,
      f.updatedAt ?? NOW - 5 * MIN,
      legacy ? null : `identity:register:${chainId}:${agent}`,
      fresh ? `identity:register:${chainId}:${agent}` : null,
      minted ? id : null,
      fresh ? mintTx(f.n) : null,
      fresh ? mintBlock : null,
      fresh ? blockHash(f.n) : null,
      minted ? (final || f.finalIdStored ? 'final' : 'safe') : null,
      seen,
      f.kind === 'lost' ? NOW - MIN : null,
      minted ? `identity:transfer:${chainId}:${agent}${legacy ? '' : `~${id}`}` : null,
      minted ? id : null,
      fresh ? handoverTx(f.n) : null,
      fresh ? handoverBlock : null,
      fresh ? blockHash(f.n + 1) : null,
      fresh ? handoverFinality : null,
      NOW - 20 * MIN,
    ],
  );
}

/**
 * A rating Central City sent (rate/service.ts): a signed base_wallet_withdrawals row of kind 'rate'
 * from fixture `rater`'s own wallet, and its chain operation in `status` ('final' by default) at
 * `block`. `reverted`: the operation landed but its UserOperation reverted. `op: null`: signed,
 * its operation not stored yet.
 */
export async function addRating(
  db: Database,
  r: {
    id: string;
    rater: number;
    /** The rated Base ID, and the rated fixture (its Central City agent id). */
    baseId: number;
    rated: number;
    stars: number;
    status?: string | null;
    block?: number | null;
    nonce?: number;
    reverted?: boolean;
    chainId?: number;
  },
) {
  const chainId = r.chainId ?? 8453;
  const key = `base-wallet:rate:${r.id}`;
  const status = r.status === undefined ? 'final' : r.status;
  await db.query(
    `INSERT INTO base_wallet_withdrawals (withdrawal_id, wallet_id, owner_account_id, chain_id,
       kind, rated_agent_id, rated_base_id, rating_value, idempotency_key, request_hash, state,
       nonce, user_operation, user_op_hash, expires_at, owner_signature, chain_op_key, signed_at,
       tx_hash, block_number, created_at, updated_at)
     VALUES ($1, $2, 'ws', $3, 'rate', $4, $5, $6, $1, $7, $8, $9, '{}', $7, $10, $11, $12, $10,
       NULL, NULL, $10, $10)`,
    [
      r.id,
      `w-${r.rater}`,
      chainId,
      agentId(r.rated),
      r.baseId,
      r.stars * 20,
      `0x${'7'.repeat(64)}`,
      status === 'final' ? 'final' : status === 'failed' ? 'failed' : 'submitted',
      r.nonce ?? 0,
      NOW - 30 * MIN,
      Buffer.alloc(65, 1),
      key,
    ],
  );
  if (status === null) return;
  await db.query(
    `INSERT INTO base_chain_ops (op_id, idempotency_key, intent_hash, kind, chain_id, status,
       tx_hash, block_number, error_code, created_at, updated_at)
     VALUES ($1, $1, '0x00', 'rate', $2, $3, NULL, $4, $5, 1, 1)`,
    [
      key,
      chainId,
      status,
      r.block === undefined ? 2000 : r.block,
      r.reverted ? 'USEROP_REVERTED' : null,
    ],
  );
}
