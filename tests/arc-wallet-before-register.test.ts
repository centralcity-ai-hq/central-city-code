import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { arcChainIdsMigrations } from '../server/base/arc-chain-ids-schema.js';
import { chainHolding } from '../server/base/identity/chain-hold.js';
import { BASE_MIGRATION_SQL } from '../server/base/schema.js';
import { agentChainOf, agentChainsOf } from '../server/base/wallet/routes.js';
import { BASE_MAINNET } from '../shared/base/chains.js';
import { ARC_TESTNET } from '../shared/chains.js';

/**
 * Picking Arc after a wallet was made on Base: the path a person takes on the screens. The wallet
 * was made first, on Base by default, and held the agent there for good.
 */
const AGENT = '11111111-1111-4111-8111-111111111111';
const ADDRESS = '0x00000000000000000000000000000000000000aa';
const ENV = { CITY_ARC: '1', CITY_ARC_CHAIN_ID: String(ARC_TESTNET) };

async function setup() {
  const pg = await PGlite.create('memory://');
  await pg.exec('CREATE TABLE operators (id text PRIMARY KEY)');
  await pg.exec(BASE_MIGRATION_SQL);
  for (const migration of arcChainIdsMigrations)
    if (/arc_chain_ids_base_(identities|wallets)$/.test(migration.name))
      await pg.exec(migration.sql.replace(/SET LOCAL[^;]*;/, ''));
  await pg.query(`INSERT INTO operators (id) VALUES ('w1')`);
  const db = { query: (sql: string, params?: unknown[]) => pg.query(sql, params) } as never;
  const wallet = (id: string, chainId: number, state = 'derived') =>
    pg.query(
      `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
         spender_address, spender_key_ref, derivation, state, created_at, updated_at)
       VALUES ($1, $2, 'w1', $3, $4, $4, $4, 'v1:k', '{}', $5, 1, 1)`,
      [id, AGENT, chainId, `0x${id.padStart(40, '0')}`, state],
    );
  const identity = (chainId: number, state: string) =>
    pg.query(
      `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address, agent_card_uri,
         owner_of_identity, state, updated_at)
       VALUES ($1, $2, 'w1', $3, 'u', $3, $4, 1)`,
      [AGENT, chainId, ADDRESS, state],
    );
  return { pg, db, wallet, identity };
}

test('an unused wallet on Base no longer holds the agent; anything used still does', async (t) => {
  const { pg, db, wallet, identity } = await setup();
  t.after(() => pg.close());
  const empty = async () => false;

  await wallet('a1', BASE_MAINNET);
  assert.equal(await chainHolding(db, empty, AGENT, ARC_TESTNET), null, 'derived and empty');

  // Funds on it, or not knowing: it holds. Never strand what's there.
  assert.equal(await chainHolding(db, async () => true, AGENT, ARC_TESTNET), BASE_MAINNET);
  const down = async () => {
    throw new Error('down');
  };
  assert.equal(await chainHolding(db, down, AGENT, ARC_TESTNET), BASE_MAINNET);
  assert.equal(await chainHolding(db, undefined, AGENT, ARC_TESTNET), BASE_MAINNET);

  // Deployed: it has been used.
  await pg.query(`UPDATE base_wallets SET state = 'deployed' WHERE wallet_id = 'a1'`);
  assert.equal(await chainHolding(db, empty, AGENT, ARC_TESTNET), BASE_MAINNET);
  await pg.query(`UPDATE base_wallets SET state = 'derived' WHERE wallet_id = 'a1'`);

  // A live identity holds it whatever the wallet is; a failed one doesn't.
  await identity(BASE_MAINNET, 'failed');
  assert.equal(await chainHolding(db, empty, AGENT, ARC_TESTNET), null);
  await pg.query(`UPDATE base_identities SET state = 'pending'`);
  assert.equal(await chainHolding(db, empty, AGENT, ARC_TESTNET), BASE_MAINNET);
});

test("the agent's chain is Arc once it registers there, past its unused Base wallet", async (t) => {
  const { pg, db, wallet, identity } = await setup();
  t.after(() => pg.close());
  const chain = () => agentChainOf(db, ENV, AGENT);
  const chains = async () => (await agentChainsOf(db, ENV, [AGENT])).get(AGENT) ?? BASE_MAINNET;

  await wallet('a1', BASE_MAINNET);
  assert.equal(await chain(), BASE_MAINNET, 'a Base wallet alone');
  await wallet('a2', ARC_TESTNET);
  assert.equal(await chain(), BASE_MAINNET, 'both, nothing live: as before');
  await identity(ARC_TESTNET, 'pending');
  assert.equal(await chain(), ARC_TESTNET);
  assert.equal(await chains(), ARC_TESTNET);
});
