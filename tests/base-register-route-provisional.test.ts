import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import type { Database } from '../server/database.js';
import {
  BASE_IDENTITY_PROVISIONAL_SQL,
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  baseShortIdsMigration,
} from '../server/base/schema.js';
import {
  FINALIZE_FRESH_MS,
  IDENTITY_FINALIZE_PATH,
  registerBaseRegistrationRoutes,
  type ChainRuntime,
} from '../server/base/identity/routes.js';
import { handoverKey, registerKey, transferKey } from '../server/base/identity/service.js';
import { BASE_MAINNET, baseNetwork } from '../shared/base/chains.js';
import { FakeIdentityChain } from './base-identity-fake-chain.js';

const AGENT = '9f8e7d6c-5b4a-4321-8fed-cba987654321';
const OWNER = `0x${'2'.repeat(40)}`;
const SPENDER = `0x${'3'.repeat(40)}` as `0x${string}`;
const ENV = { CITY_BASE_MAINNET: '1' };
const REGISTRY = baseNetwork(BASE_MAINNET, ENV)!.contracts.identityRegistry!;
const SECRET = 's'.repeat(32);
const R0 = registerKey(AGENT, BASE_MAINNET);
const H0 = handoverKey(AGENT, BASE_MAINNET, 99029n);

async function setup(
  t: { after: (fn: () => Promise<unknown>) => void },
  cronSecret?: string,
  beforeMigration85?: (pg: PGlite) => Promise<unknown>,
) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(`CREATE TABLE operators (id text PRIMARY KEY);
    INSERT INTO operators VALUES ('ws-1'), ('ws-2');
    CREATE TABLE workspaces (operator_id text PRIMARY KEY, data jsonb NOT NULL);
    CREATE TABLE agent_manifests (agent_id text, operator_id text, revision integer, manifest jsonb);
    INSERT INTO workspaces VALUES ('ws-1', '{"agents":[{"id":"${AGENT}","revision":1}]}');
    INSERT INTO agent_manifests VALUES ('${AGENT}', 'ws-1', 1, '{"spec":{"visibility":"public"}}');`);
  await pg.exec(BASE_MIGRATION_SQL);
  await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
  await pg.exec(baseShortIdsMigration.sql);
  // Rows written by the legacy, final-only flow before migration 85.
  await beforeMigration85?.(pg);
  await pg.exec(BASE_IDENTITY_PROVISIONAL_SQL);
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  const chain = new FakeIdentityChain({ spender: SPENDER, registry: REGISTRY });
  const runtime: ChainRuntime = {
    walletPort: {
      implementationVersion: 'cbsw-1.1',
      deriveSmartAccount: async () => `0x${'1'.repeat(40)}`,
      createSpender: async () => ({ spender: SPENDER, keyRef: 'v1:k' }),
      commitSpender: async () => {},
    },
    identityPort: chain,
  };
  let runtimes = 0;
  const app = Fastify();
  t.after(() => app.close());
  registerBaseRegistrationRoutes(app, {
    db,
    env: ENV,
    currentOperator: async (request) => {
      const who = request.headers['x-test-operator'];
      return typeof who === 'string' ? { id: who } : null;
    },
    runtime: async () => {
      runtimes++;
      return runtime;
    },
    cronSecret,
  });
  return { app, db, chain, runtimes: () => runtimes };
}

const register = (app: Awaited<ReturnType<typeof setup>>['app'], operator?: string) =>
  app.inject({
    method: 'POST',
    url: `/api/base/agents/${AGENT}/register`,
    headers: operator ? { 'x-test-operator': operator } : {},
    payload: { ownerAddress: OWNER },
  });
const status = (app: Awaited<ReturnType<typeof setup>>['app'], operator: string) =>
  app.inject({
    url: `/api/base/agents/${AGENT}/registration`,
    headers: { 'x-test-operator': operator },
  });

const VIEW_KEYS = [
  'agentId',
  'agentUri',
  'canRetry',
  'chainId',
  'erc8004AgentId',
  'idSeenAt',
  'mintTxHash',
  'pollAfterMs',
  'provisionalAgentId',
  'stage',
  'startedAt',
  'state',
];

test('POST returns the provisional view; GET builds it from the database only', async (t) => {
  const { app, chain } = await setup(t);
  const first = (await register(app, 'ws-1')).json().identity;
  assert.deepEqual(Object.keys(first).sort(), VIEW_KEYS);
  assert.equal(first.stage, 'registering');
  assert.equal(first.provisionalAgentId, null);
  assert.equal(first.canRetry, false);
  assert.equal(first.pollAfterMs, 2000);
  assert.equal(first.mintTxHash, null);
  assert.equal(first.idSeenAt, null);
  assert.equal(typeof first.startedAt, 'number');

  chain.include(R0, { tx: '0xa1', block: 100, id: 99029n });
  const response = await register(app, 'ws-1');
  assert.doesNotMatch(response.body, /identity:|evidence|opId|op_id/);
  const second = response.json().identity;
  assert.deepEqual(Object.keys(second).sort(), VIEW_KEYS);
  assert.equal(second.state, 'submitted');
  assert.equal(second.stage, 'handing_over');
  assert.equal(second.provisionalAgentId, '99029');
  assert.equal(second.erc8004AgentId, null);
  assert.equal(second.mintTxHash, '0xa1');
  assert.equal(typeof second.idSeenAt, 'number');
  assert.equal(second.startedAt, first.startedAt);
  assert.equal(second.pollAfterMs, 3000);
  assert.equal(chain.signs.get(H0), 1);

  const calls = JSON.stringify(chain.calls);
  const read = await status(app, 'ws-1');
  assert.equal(read.statusCode, 200);
  assert.doesNotMatch(read.body, /identity:|evidence|opId|op_id/);
  // #71: GET also names the agent's wallet and its owner (public addresses only).
  const wallet = { address: `0x${'1'.repeat(40)}`, ownerAddress: OWNER, state: 'derived' };
  assert.deepEqual(read.json().identities, [{ ...second, txHash: '0xa1', wallet }]);
  assert.doesNotMatch(read.body, new RegExp(SPENDER.slice(2), 'i'), 'never the spender');
  assert.equal(JSON.stringify(chain.calls), calls, 'GET never calls the chain');

  assert.equal((await status(app, 'ws-2')).statusCode, 404);
  assert.equal((await register(app, 'ws-2')).statusCode, 404);
});

test('the finalize cron needs its secret and moves owner-started rows to confirmed', async (t) => {
  const { app, db, chain, runtimes } = await setup(t, SECRET);
  const cron = (authorization?: string) =>
    app.inject({
      url: IDENTITY_FINALIZE_PATH,
      headers: authorization ? { authorization } : {},
    });
  assert.equal((await cron()).statusCode, 404);
  assert.equal((await cron(`Bearer ${'x'.repeat(32)}`)).statusCode, 404);

  await register(app, 'ws-1');
  chain.include(R0, { tx: '0xa1', block: 100, id: 99029n });
  await register(app, 'ws-1');
  chain.include(H0, { tx: '0xb1', block: 101 });
  chain.finalize(H0);
  chain.finalize(R0);
  // Never started by its owner (op_id NULL): the cron leaves it alone.
  await db.query(
    `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address,
       agent_card_uri, owner_of_identity, state, updated_at)
     VALUES ('idle', 8453, 'ws-1', $1, 'https://centralcity.ai/a/idle00', $2, 'pending', 1)`,
    [REGISTRY, SPENDER],
  );
  // Started, but its wallet is gone: counted as an error, never thrown.
  await db.query(
    `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address,
       agent_card_uri, owner_of_identity, state, op_id, updated_at)
     VALUES ('orphan', 8453, 'ws-1', $1, 'https://centralcity.ai/a/orph00', $2, 'submitted',
       'identity:register:8453:orphan', 1)`,
    [REGISTRY, SPENDER],
  );
  // Its owner's last poll moved it longer ago than FINALIZE_FRESH_MS (a fresh one waits a run).
  await db.query(
    `UPDATE base_identities SET updated_at = updated_at - $1::bigint WHERE agent_id = $2`,
    [FINALIZE_FRESH_MS, AGENT],
  );
  const before = runtimes();
  const run = await cron(`Bearer ${SECRET}`);
  assert.equal(run.statusCode, 200);
  assert.deepEqual(run.json(), { advanced: 1, confirmed: 1, errors: 1 });
  assert.equal(runtimes() - before, 1, 'one runtime per chain');
  const rows = (
    await db.query<{ agent_id: string; state: string; swept_at: string | null }>(
      'SELECT agent_id, state, swept_at::text AS swept_at FROM base_identities ORDER BY agent_id',
    )
  ).rows;
  const by = Object.fromEntries(rows.map((row) => [row.agent_id, row]));
  assert.equal(by[AGENT].state, 'confirmed');
  assert.equal(by.idle.state, 'pending');
  assert.equal(by.idle.swept_at, null);
  assert.notEqual(by.orphan.swept_at, null);
  // A row just claimed is not claimed again by the next run.
  assert.deepEqual((await cron(`Bearer ${SECRET}`)).json(), {
    advanced: 0,
    confirmed: 0,
    errors: 0,
  });
});

test('without a configured secret the finalize cron does not exist', async (t) => {
  const { app } = await setup(t);
  const response = await app.inject({
    url: IDENTITY_FINALIZE_PATH,
    headers: { authorization: `Bearer ${SECRET}` },
  });
  assert.equal(response.statusCode, 404);
});

test('GET reports "registered" (mint and hand-over both safe) from the database only', async (t) => {
  const { app, chain } = await setup(t);
  await register(app, 'ws-1');
  chain.include(R0, { tx: '0xa1', block: 100, id: 99029n }, 'safe');
  await register(app, 'ws-1');
  chain.include(H0, { tx: '0xb1', block: 101 }, 'safe');
  const posted = (await register(app, 'ws-1')).json().identity;
  assert.equal(posted.stage, 'registered');
  assert.equal(posted.state, 'submitted');
  assert.equal(posted.pollAfterMs, 30000);
  assert.equal(posted.provisionalAgentId, '99029');
  assert.equal(posted.erc8004AgentId, null);
  const calls = JSON.stringify(chain.calls);
  const [read] = (await status(app, 'ws-1')).json().identities;
  assert.equal(read.stage, 'registered');
  assert.equal(read.pollAfterMs, 30000);
  assert.equal(read.provisionalAgentId, '99029');
  assert.equal(JSON.stringify(chain.calls), calls, 'GET never calls the chain');
});

/** A base_identities row as the final-only flow wrote it before migration 85. */
const legacyRow =
  (state: string, id: number, opId: string, txHash: string | null) => async (pg: PGlite) =>
    pg.query(
      `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address,
         erc8004_agent_id, agent_card_uri, owner_of_identity, state, op_id, tx_hash, updated_at)
       VALUES ($1, 8453, 'ws-1', $2, $3, 'https://centralcity.ai/a/abc123', $4, $5, $6, $7, 70)`,
      [AGENT, REGISTRY, id, OWNER, state, opId, txHash],
    );

const legacyCases: Array<[string, Parameters<typeof legacyRow>, Record<string, unknown>]> = [
  [
    'confirmed (Alphonse: 99029, op_id a transfer key)',
    ['confirmed', 99029, transferKey(AGENT, BASE_MAINNET), '0xb1'],
    { state: 'confirmed', stage: 'confirmed', erc8004AgentId: '99029', pollAfterMs: null },
  ],
  [
    'mid-hand-over (submitted, op_id a transfer key)',
    ['submitted', 7, transferKey(AGENT, BASE_MAINNET), '0xb1'],
    { state: 'submitted', stage: 'handing_over', erc8004AgentId: '7', pollAfterMs: 3000 },
  ],
  [
    'hand-over retried by its owner (pending, transfer attempt 1)',
    ['pending', 7, transferKey(AGENT, BASE_MAINNET, 1), null],
    { state: 'pending', stage: 'handing_over', erc8004AgentId: '7', pollAfterMs: 3000 },
  ],
];
for (const [name, row, expected] of legacyCases) {
  test(`M1: GET reports the right stage for a migrated legacy row: ${name}`, async (t) => {
    const { app, chain } = await setup(t, undefined, legacyRow(...row));
    const response = await status(app, 'ws-1');
    assert.equal(response.statusCode, 200);
    const [identity] = response.json().identities;
    assert.deepEqual(
      {
        state: identity.state,
        stage: identity.stage,
        erc8004AgentId: identity.erc8004AgentId,
        pollAfterMs: identity.pollAfterMs,
      },
      expected,
    );
    assert.equal(identity.provisionalAgentId, null);
    assert.equal(identity.canRetry, false);
    assert.equal(identity.mintTxHash, null);
    assert.equal(identity.wallet, null, 'no wallet row for this legacy fixture');
    assert.deepEqual(chain.calls.register, []);
  });
}
