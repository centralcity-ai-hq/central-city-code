import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { PublicClient } from 'viem';
import type { Database } from '../server/database.js';
import { BASE_MIGRATION_SQL, BASE_PAYMENTS_MIGRATION_SQL } from '../server/base/schema.js';
import { BASE_SEPOLIA, NATIVE_ETH, baseNetwork } from '../shared/base/chains.js';
import { createPaymentChain, type RecoveryCursor } from '../server/base/chain/payment-chain.js';
import { createReservationLedger } from '../server/base/chain/reservations.js';
import type { ChainOperationStore, StoredOperation } from '../server/base/chain/submit.js';

const ADDR = '0x1111111111111111111111111111111111111111';

test('recovery pages past unresolved oldest rows and isolates per-row errors', async (t) => {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(
    "CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws-1');",
  );
  await pg.exec(BASE_MIGRATION_SQL);
  await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  await pg.query(
    `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
       spender_address, spender_key_ref, derivation, state, created_at, updated_at)
     VALUES ('w-1','a-1','ws-1',84532,$1,$1,$1,'v1:k','{}','derived',0,0)`,
    [ADDR],
  );
  // Five held payment reservations, oldest first; the two oldest cannot be resolved.
  for (let n = 0; n < 5; n++)
    await pg.query(
      `INSERT INTO base_wallet_reservations (reservation_id, wallet_id, chain_id, token, amount,
         holder_kind, holder_ref, intent_hash, state, created_at, updated_at)
       VALUES ($1,'w-1',84532,$2,1000,'payment',$3,$4,'held',$5,$5)`,
      [`r-${n}`, NATIVE_ETH, `payment:${n}`, `0x${String(n).repeat(64)}`, 1000 + n],
    );

  const rows = new Map<string, StoredOperation>();
  const broken = new Set(['payment:0', 'payment:1']);
  const operations: ChainOperationStore = {
    async get(key) {
      if (broken.has(key)) throw new Error('store unavailable for this row');
      return rows.get(key) ?? null;
    },
    async insert(row) {
      if (!rows.has(row.idempotencyKey)) rows.set(row.idempotencyKey, { ...row });
      return { ...rows.get(row.idempotencyKey)! };
    },
    async update(key, patch) {
      rows.set(key, { ...rows.get(key)!, ...patch });
      return { ...rows.get(key)! };
    },
    async transition(key, from, patch) {
      const row = rows.get(key);
      if (!row || !from.includes(row.status)) return null;
      return this.update(key, patch);
    },
  };
  const payments = createPaymentChain({
    network: baseNetwork(BASE_SEPOLIA)!,
    client: {} as PublicClient,
    db,
    operations,
    bundler: {} as never,
    keystore: {} as never,
    signerOf: async () => ADDR,
    ledger: createReservationLedger({
      chainId: BASE_SEPOLIA,
      balanceOf: async () => ({ balance: 0n, blockNumber: 0n }),
    }),
  });

  const now = 10_000_000;
  const state = async () =>
    (
      await pg.query<{ holder_ref: string; state: string }>(
        'SELECT holder_ref, state FROM base_wallet_reservations ORDER BY created_at',
      )
    ).rows.map((r) => r.state);

  // Page 1: only the two broken rows; both errors are contained, and a cursor points onward.
  const first = await payments.recover({ now, limit: 2 });
  assert.equal(first.checked, 2);
  assert.equal(first.errors, 2);
  assert.ok(first.next);
  // Pages 2 and 3 reach the newer rows despite the unresolved oldest ones.
  let after: RecoveryCursor | null = first.next;
  let released = 0;
  while (after) {
    const page = await payments.recover({ now, limit: 2, after });
    released += page.released;
    after = page.next;
  }
  assert.equal(released, 3);
  assert.deepEqual(await state(), ['held', 'held', 'released', 'released', 'released']);
  // A fresh run starts from the oldest again; once fixed, they recover too.
  broken.clear();
  const again = await payments.recover({ now, limit: 2 });
  assert.equal(again.released, 2);
  assert.deepEqual(await state(), ['released', 'released', 'released', 'released', 'released']);
});
