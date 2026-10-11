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
  registerBaseRegistrationRoutes,
  type ChainRuntime,
} from '../server/base/identity/routes.js';
import { registerKey, transferKey } from '../server/base/identity/service.js';

// The owner's path through the route, the way the Base tab drives it: a registration that stays
// stuck is retried by the owner after 10 minutes, and exactly one attempt mints.
const AGENT = '9f8e7d6c-5b4a-4321-8fed-cba987654321';
const OWNER = `0x${'2'.repeat(40)}`;

test('stuck registration: owner retry after 10 minutes registers exactly once', async (t) => {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(`CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws-1');
    CREATE TABLE workspaces (operator_id text PRIMARY KEY, data jsonb NOT NULL);
    CREATE TABLE agent_manifests (agent_id text, operator_id text, revision integer, manifest jsonb);
    INSERT INTO workspaces VALUES ('ws-1', '{"agents":[{"id":"${AGENT}","revision":1}]}');
    INSERT INTO agent_manifests VALUES ('${AGENT}', 'ws-1', 1, '{"spec":{"visibility":"public"}}');`);
  for (const sql of [
    BASE_MIGRATION_SQL,
    BASE_PAYMENTS_MIGRATION_SQL,
    baseShortIdsMigration.sql,
    BASE_IDENTITY_PROVISIONAL_SQL,
  ])
    await pg.exec(sql);
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  const calls: string[] = [];
  const runtime: ChainRuntime = {
    walletPort: {
      implementationVersion: 'cbsw-1.1',
      deriveSmartAccount: async () => `0x${'1'.repeat(40)}`,
      createSpender: async () => ({ spender: `0x${'3'.repeat(40)}`, keyRef: 'v1:k' }),
      commitSpender: async () => {},
    },
    identityPort: {
      // The first attempt stays unknown forever (refused by the bundler); the retry lands.
      register: async (input) => {
        calls.push(input.operationKey);
        const first = input.operationKey === registerKey(AGENT, 8453);
        return {
          idempotencyKey: input.operationKey,
          status: first ? 'unknown' : 'final',
          txHash: first ? null : '0xa',
        };
      },
      registeredId: async () => 4711n,
      transfer: async (input) => {
        calls.push(input.operationKey);
        return { idempotencyKey: input.operationKey, status: 'final', txHash: '0xb' };
      },
    },
  };
  const app = Fastify();
  t.after(() => app.close());
  registerBaseRegistrationRoutes(app, {
    db,
    env: { CITY_BASE_MAINNET: '1' },
    currentOperator: async () => ({ id: 'ws-1' }),
    runtime: async () => runtime,
  });
  const post = (body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/base/agents/${AGENT}/register`,
      payload: { ownerAddress: OWNER, ...body },
    });

  // The panel polls: the first attempt stays submitted.
  for (let i = 0; i < 3; i++) assert.equal((await post({})).json().identity.state, 'submitted');
  // Too early for a retry: still the first attempt.
  assert.equal((await post({ retry: true })).json().identity.state, 'submitted');
  assert.ok(calls.every((key) => key === registerKey(AGENT, 8453)));

  // Ten minutes later the owner presses "Try again".
  await db.query(`UPDATE base_identities SET updated_at = updated_at - 11 * 60 * 1000`);
  const retried = (await post({ retry: true })).json().identity;
  assert.equal(retried.state, 'confirmed');
  assert.equal(retried.erc8004AgentId, '4711');
  assert.deepEqual(calls.slice(-2), [registerKey(AGENT, 8453, 1), transferKey(AGENT, 8453)]);

  // Afterwards nothing is sent again, whatever the panel does.
  const before = calls.length;
  assert.equal((await post({ retry: true })).json().identity.state, 'confirmed');
  assert.equal(calls.length, before);
});
