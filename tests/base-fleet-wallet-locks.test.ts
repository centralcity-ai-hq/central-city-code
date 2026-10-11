import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Transaction } from '../server/database.js';
import { BASE_MIGRATION_SQL } from '../server/base/schema.js';
import { lockFleetWallets } from '../server/base/fleet/wallet-locks.js';

test('fleet wallet union requires treasury and every recipient in the same workspace and chain', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(
      "CREATE TABLE operators(id text PRIMARY KEY); INSERT INTO operators VALUES ('test-workspace')",
    );
    await pg.exec(BASE_MIGRATION_SQL);
    for (const n of [1, 2])
      await pg.query(
        `INSERT INTO base_wallets(wallet_id,agent_id,operator_id,chain_id,address,owner_address,spender_address,spender_key_ref,derivation,state,created_at,updated_at)
      VALUES ($1,$2,'test-workspace',31337,$3,$3,$3,'v1:test','{}','derived',0,0)`,
        [`test-wallet-${n}`, `test-agent-${n}`, `0x${String(n).repeat(40)}`],
      );
    const lock = (workspace: string, chain: number, treasury: string, agents: string[]) =>
      pg.transaction((tx) =>
        lockFleetWallets(tx as unknown as Transaction, workspace, chain, treasury, agents),
      );
    await lock('test-workspace', 31337, 'test-wallet-1', ['test-agent-2']);
    await lock('test-workspace', 31337, 'test-wallet-1', ['test-agent-1', 'test-agent-2']);
    await assert.rejects(lock('other', 31337, 'test-wallet-1', ['test-agent-2']), /treasury/);
    await assert.rejects(
      lock('test-workspace', 84532, 'test-wallet-1', ['test-agent-2']),
      /treasury/,
    );
    await assert.rejects(lock('test-workspace', 31337, 'missing', ['test-agent-2']), /treasury/);
    await assert.rejects(lock('test-workspace', 31337, 'test-wallet-1', ['missing']), /recipient/);
  } finally {
    await pg.close();
  }
});
