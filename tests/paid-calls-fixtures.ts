import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import type { Database } from '../server/database.js';
import { listMigrations, runMigrations } from '../server/migrations.js';
import { paidCallCountMigration } from '../server/feed/pay/count-schema.js';
import { paidCallCountDropMigration } from '../server/feed/pay/count-drop-schema.js';

/*
 * Shared by the paid service calls tests (tests/paid-calls-count.test.ts and
 * tests/fast-count-check.test.ts): databases with every migration, a payer's wallet, Feed pay
 * calls stored and settled the way the engine does it. Synthetic values only.
 */

export type Db = Pick<Database, 'query' | 'transaction'>;

// createApp registers every feature migration; the tests below run them on their own databases.
{
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  await app.close();
}
export const ALL = listMigrations();
export const quiet = () => {};

export async function migrated(
  t: { after: (fn: () => Promise<unknown>) => void },
  options: { before120?: (db: PGlite) => Promise<void> } = {},
) {
  const db = await PGlite.create('memory://');
  t.after(() => db.close());
  if (options.before120) {
    await runMigrations(
      db,
      ALL.filter(
        (migration) =>
          migration.version !== paidCallCountMigration.version &&
          migration.version !== paidCallCountDropMigration.version,
      ),
      Date.now,
      true,
      quiet,
    );
    await seedWallet(db);
    await options.before120(db);
  }
  await runMigrations(db, ALL, Date.now, true, quiet);
  if (!options.before120) await seedWallet(db);
  return db;
}

export async function seedWallet(db: Db) {
  await db.query(
    `INSERT INTO operators (id, name, name_key, password_hash, salt)
     VALUES ('op-1', 'Payer', 'payer', 'x', 'x') ON CONFLICT DO NOTHING`,
  );
  await db.query(
    `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
       spender_address, spender_key_ref, derivation, state, created_at, updated_at)
     VALUES ('w-1', 'agent-1', 'op-1', 8453, $1, $2, $3, 'v1:k', '{}', 'deployed', 0, 0)
     ON CONFLICT DO NOTHING`,
    [`0x${'1'.repeat(40)}`, `0x${'2'.repeat(40)}`, `0x${'3'.repeat(40)}`],
  );
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
let sequence = 0;
/** A fresh, valid call id (fc_ and 20 base32 characters). */
export function callId(): string {
  let n = sequence++;
  let id = '';
  for (let i = 0; i < 20; i++) {
    id = BASE32[n % 32] + id;
    n = Math.floor(n / 32);
  }
  return `fc_${id}`;
}

/** Stores a Feed pay call as the engine does, in `state` with `payment_state`. */
export async function call(
  db: Pick<Database, 'query'>,
  options: {
    chainId?: number;
    state?: string;
    paymentState?: string | null;
    settledAt?: number | null;
  } = {},
): Promise<string> {
  const id = callId();
  await db.query(
    `INSERT INTO feed_pay_calls (call_id, origin, scope, idempotency_key, request_hash, caller_id,
       actor, owner_account_id, operator_id, agent_id, agent_name, wallet_id, chain_id, service_id,
       service_title, host, method, request_url, max_amount_raw, permission_id, payment_id,
       amount_raw, pay_to, x402_version, requirements, validity_s, state, payment_state,
       settled_at, created_at, updated_at)
     VALUES ($1, 'feed', 'feed:op-1', $2, $3, 'op-1', 'person', 'op-1', 'op-1', 'agent-1',
       'Agent', 'w-1', $4, 'svc-1', 'A service', 'service.example', 'POST',
       'https://service.example/run', 20000, 'perm-1', $5, 20000, $6, 2, '{}', 60, $7, $8, $9,
       1, 1)`,
    [
      id,
      randomBytes(32).toString('hex'),
      randomBytes(32).toString('hex'),
      options.chainId ?? 8453,
      `pay-${id}`,
      `0x${'4'.repeat(40)}`,
      options.state ?? 'calling',
      options.paymentState === undefined ? 'sent' : options.paymentState,
      options.settledAt ?? null,
    ],
  );
  return id;
}

/** The engine's settle: one compare-and-set of the call, in its own transaction. */
export async function settle(
  db: Db,
  id: string,
  options: { at?: number | null; noResult?: boolean } = {},
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query(
      `UPDATE feed_pay_calls SET payment_state = 'settled', tx_hash = $2, settled_block = 1,
         settled_at = $3, ${options.noResult ? "state = 'paid_no_result', failure_code = 'no_result'," : ''}
         updated_at = updated_at + 1
       WHERE call_id = $1 AND payment_state IS DISTINCT FROM 'settled' RETURNING call_id`,
      [id, `0x${randomBytes(32).toString('hex')}`, options.at === undefined ? 1_000 : options.at],
    );
    return rows.length === 1;
  });
}

export async function counts(db: Pick<Database, 'query'>) {
  const rows = (
    await db.query<{ chain_id: number; total: string | number }>(
      'SELECT chain_id, total FROM paid_call_count ORDER BY chain_id',
    )
  ).rows;
  return Object.fromEntries(rows.map((row) => [row.chain_id, Number(row.total)]));
}
export const base = async (db: Pick<Database, 'query'>) => (await counts(db))[8453] ?? 0;
export async function recent(db: Pick<Database, 'query'>, chainId = 8453) {
  const row = (
    await db.query<{ recent: unknown[] }>('SELECT recent FROM paid_call_count WHERE chain_id=$1', [
      chainId,
    ])
  ).rows[0];
  return (row?.recent ?? []).map(Number);
}
