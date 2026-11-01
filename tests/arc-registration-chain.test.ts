import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { arcChainIdsMigrations } from '../server/base/arc-chain-ids-schema.js';
import { BASE_MIGRATION_SQL } from '../server/base/schema.js';
import { BASE_MAINNET } from '../shared/base/chains.js';
import { ARC_MAINNET, ARC_TESTNET } from '../shared/chains.js';
import {
  registerBaseRegistrationRoutes,
  registrationChainOn,
} from '../server/base/identity/routes.js';

const AGENT = '11111111-1111-4111-8111-111111111111';
const OWNER = '0x00000000000000000000000000000000000000aa';
const ARC_ON = { CITY_ARC: '1', CITY_ARC_CHAIN_ID: String(ARC_TESTNET) };

/** The route up to the runtime: a runtime that refuses shows every gate before it let the call by. */
async function route(env: Record<string, string>, onChain: number | null) {
  const app = Fastify();
  const asked: number[] = [];
  const queries: string[] = [];
  registerBaseRegistrationRoutes(app, {
    db: {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push(sql);
        if (sql.includes('agent_manifests')) return { rows: [{ operator_id: 'w1' }] };
        if (sql.includes('chain_id <> $2'))
          return { rows: onChain !== null && onChain !== params[1] ? [{ chain_id: onChain }] : [] };
        return { rows: [] };
      },
    } as never,
    env,
    currentOperator: async () => ({ id: 'w1' }),
    runtime: async (chainId) => {
      asked.push(chainId);
      throw new Error('not configured');
    },
  });
  await app.ready();
  const post = (body: object) =>
    app.inject({
      method: 'POST',
      url: `/api/base/agents/${AGENT}/register`,
      payload: { ownerAddress: OWNER, ...body },
    });
  return { app, post, asked, queries };
}

test('registrationChainOn: Base always, and only the one Arc network that is on', () => {
  assert.ok(registrationChainOn(BASE_MAINNET, {}));
  assert.ok(!registrationChainOn(ARC_TESTNET, {}));
  assert.ok(registrationChainOn(ARC_TESTNET, ARC_ON));
  assert.ok(!registrationChainOn(ARC_MAINNET, ARC_ON));
  assert.ok(registrationChainOn(ARC_MAINNET, { CITY_ARC: '1' }));
});

test('Arc off: a call that names Arc is refused, and Base gets one lookup of Arc rows only', async (t) => {
  const { app, post, asked, queries } = await route({}, null);
  t.after(() => app.close());
  const refused = await post({ chainId: ARC_TESTNET });
  assert.equal(refused.statusCode, 400);
  assert.deepEqual(asked, []);
  const base = await post({});
  assert.equal(base.statusCode, 503);
  assert.deepEqual(asked, [BASE_MAINNET]);
  assert.ok(!queries.some((sql) => sql.includes('chain_id <> $2')));
  assert.equal(queries.filter((sql) => sql.includes('chain_id = ANY($2::int[])')).length, 1);
});

test('Arc off: an agent with an Arc row or wallet is refused before any wallet is made', async (t) => {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(`CREATE TABLE IF NOT EXISTS operators (id text PRIMARY KEY);`);
  await pg.exec(BASE_MIGRATION_SQL);
  for (const m of arcChainIdsMigrations)
    if (/arc_chain_ids_base_(identities|wallets)$/.test(m.name))
      await pg.exec(m.sql.replace(/SET LOCAL[^;]*;/, ''));
  await pg.query(`INSERT INTO operators (id) VALUES ('w1')`);
  const app = Fastify();
  t.after(() => app.close());
  const asked: number[] = [];
  registerBaseRegistrationRoutes(app, {
    db: {
      query: async (sql: string, params: unknown[] = []) =>
        sql.includes('agent_manifests') ? { rows: [{ operator_id: 'w1' }] } : pg.query(sql, params),
    } as never,
    env: {},
    currentOperator: async () => ({ id: 'w1' }),
    runtime: async (chainId) => {
      asked.push(chainId);
      throw new Error('not configured');
    },
  });
  await app.ready();
  const post = () =>
    app.inject({
      method: 'POST',
      url: `/api/base/agents/${AGENT}/register`,
      payload: { ownerAddress: OWNER },
    });

  // Nothing on Arc, a Base Sepolia row: as before.
  await pg.query(
    `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address, agent_card_uri,
       owner_of_identity, state, updated_at)
     VALUES ($1, 84532, 'w1', $2, 'u', $2, 'pending', 1)`,
    [AGENT, OWNER],
  );
  assert.equal((await post()).statusCode, 503);
  assert.deepEqual(asked, [BASE_MAINNET]);
  asked.length = 0;

  // A failed registration on Arc does not hold the agent.
  await pg.query(
    `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address, agent_card_uri,
       owner_of_identity, state, updated_at)
     VALUES ($1, $3, 'w1', $2, 'u', $2, 'failed', 1)`,
    [AGENT, OWNER, ARC_MAINNET],
  );
  assert.equal((await post()).statusCode, 503);
  asked.length = 0;

  await pg.query(`UPDATE base_identities SET state = 'pending' WHERE chain_id = $1`, [ARC_MAINNET]);
  const refused = await post();
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().code, 'other_chain');
  assert.equal(refused.json().details.chainId, ARC_MAINNET);
  assert.deepEqual(asked, [], 'never reached the runtime or a wallet');
  const wallets = await pg.query(`SELECT 1 FROM base_wallets WHERE chain_id = $1`, [BASE_MAINNET]);
  assert.equal(wallets.rows.length, 0);

  // A wallet alone counts too.
  await pg.query(`DELETE FROM base_identities WHERE chain_id = $1`, [ARC_MAINNET]);
  await pg.query(
    `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
       spender_address, spender_key_ref, derivation, state, created_at, updated_at)
     VALUES ('wa', $1, 'w1', $3, $2, $2, $2, 'v1:k', '{}', 'derived', 1, 1)`,
    [AGENT, OWNER, ARC_MAINNET],
  );
  assert.equal((await post()).json().code, 'other_chain');
  assert.deepEqual(asked, []);

  // The cost: both reads use the keys' agent_id prefix (planner told not to prefer a scan of a
  // table this small), one statement.
  await pg.exec('SET enable_seqscan = off');
  const plan = await pg.query<{ 'QUERY PLAN': string }>(
    `EXPLAIN SELECT chain_id FROM base_identities
       WHERE agent_id = '${AGENT}' AND chain_id = ANY(ARRAY[5042, 5042002]) AND state <> 'failed'
     UNION ALL
     SELECT chain_id FROM base_wallets WHERE agent_id = '${AGENT}' AND chain_id = ANY(ARRAY[5042, 5042002])
     LIMIT 1`,
  );
  const text = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
  assert.match(text, /Index.* on base_identities_pkey|Index.*base_identities_pkey/);
  assert.match(text, /base_wallets_agent_id_chain_id_key/);
  assert.doesNotMatch(text, /Seq Scan/);
});

test('a chain we do not list stays refused, Arc on or off', async (t) => {
  const { app, post, asked } = await route(ARC_ON, null);
  t.after(() => app.close());
  assert.equal((await post({ chainId: 1 })).statusCode, 400);
  assert.deepEqual(asked, []);
});

test('Arc on: a new agent chooses either chain, and each goes to its own runtime', async (t) => {
  const { app, post, asked } = await route(ARC_ON, null);
  t.after(() => app.close());
  assert.equal((await post({ chainId: ARC_TESTNET })).statusCode, 503);
  assert.equal((await post({})).statusCode, 503);
  assert.deepEqual(asked, [ARC_TESTNET, BASE_MAINNET]);
});

test('Arc on: an agent on one chain is refused on the other, and told which', async (t) => {
  const onBase = await route(ARC_ON, BASE_MAINNET);
  t.after(() => onBase.app.close());
  const toArc = await onBase.post({ chainId: ARC_TESTNET });
  assert.equal(toArc.statusCode, 409);
  assert.equal(toArc.json().code, 'other_chain');
  assert.equal(toArc.json().details.chainId, BASE_MAINNET);
  assert.deepEqual(onBase.asked, []);

  const onArc = await route(ARC_ON, ARC_TESTNET);
  t.after(() => onArc.app.close());
  const toBase = await onArc.post({});
  assert.equal(toBase.statusCode, 409);
  assert.equal(toBase.json().details.chainId, ARC_TESTNET);
  assert.equal(toBase.json().details.name, 'Arc Testnet');
  assert.deepEqual(onArc.asked, []);
  // Its own chain goes on as before.
  assert.equal((await onArc.post({ chainId: ARC_TESTNET })).statusCode, 503);
  assert.deepEqual(onArc.asked, [ARC_TESTNET]);
});

test('a registration that cannot run names the chain it was asked on', async (t) => {
  const { app, post } = await route(ARC_ON, null);
  t.after(() => app.close());
  const arc = await post({ chainId: ARC_TESTNET });
  assert.equal(arc.statusCode, 503);
  assert.equal(arc.json().error, 'Arc Testnet registration is not available yet.');
  const base = await post({});
  assert.equal(base.statusCode, 503);
  assert.equal(base.json().error, 'Base registration is not available yet.');
});
