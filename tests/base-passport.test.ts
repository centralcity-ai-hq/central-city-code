import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../server/database.js';
import {
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  baseShortIdsMigration,
} from '../server/base/schema.js';
import { basePassport } from '../server/base/identity/passport.js';
import { PASSPORT_EXTENSION, passportExtension } from '../shared/base/passport.js';

async function setup(t: { after: (fn: () => Promise<unknown>) => void }): Promise<Database> {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(
    "CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws');",
  );
  await pg.exec(BASE_MIGRATION_SQL);
  await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
  await pg.exec(baseShortIdsMigration.sql);
  return {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
}

const WALLET = `0x${'1'.repeat(40)}`;
const wallet = (db: Database, agent: string, chain: number) =>
  db.query(
    `INSERT INTO base_wallets VALUES ($1,$2,'ws',$3,$4,'0x${'2'.repeat(40)}','0x${'3'.repeat(40)}',
      'v1:k','{}','derived',1,1)`,
    [`w-${agent}-${chain}`, agent, chain, WALLET],
  );
const identity = (db: Database, agent: string, chain: number, state: string, id: number | null) =>
  db.query(
    `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address,
       erc8004_agent_id, agent_card_uri, owner_of_identity, state, updated_at)
     VALUES ($1,$2,'ws','0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',$3,'u','0x1',$4,1760000000000)`,
    [agent, chain, id, state],
  );

test('only Base agents get a passport; mainnet wins', async (t) => {
  const db = await setup(t);
  await db.query(`INSERT INTO base_short_ids VALUES ('abc123','a1',1),('def456','a2',1)`);
  assert.equal(await basePassport(db, 'a1'), null); // no wallet, no identity

  await wallet(db, 'a1', 84532);
  await identity(db, 'a1', 84532, 'pending', null);
  assert.equal(await basePassport(db, 'a1'), null); // not confirmed yet

  await db.query(
    `UPDATE base_identities SET state='confirmed', erc8004_agent_id=7 WHERE agent_id='a1'`,
  );
  assert.equal((await basePassport(db, 'a1'))?.chainId, 84532);

  await wallet(db, 'a1', 8453);
  await identity(db, 'a1', 8453, 'confirmed', 4711);
  const passport = await basePassport(db, 'a1');
  assert.deepEqual(passportExtension(passport!), {
    uri: PASSPORT_EXTENSION,
    description: 'Central City passport: this agent is a registered Base agent.',
    required: false,
    params: {
      issuer: 'centralcity.ai',
      passportNumber: 'CC-abc123',
      issuedAt: '2025-10-09T08:53:20.000Z',
      chain: 'eip155:8453',
      agentRegistry: 'eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
      agentId: '4711',
      wallet: WALLET,
    },
  });

  // An identity without a wallet on that chain is not a Base agent.
  await identity(db, 'a2', 8453, 'confirmed', 9);
  assert.equal(await basePassport(db, 'a2'), null);
});
