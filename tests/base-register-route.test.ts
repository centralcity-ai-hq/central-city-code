import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import type { Database } from '../server/database.js';
import {
  BASE_MIGRATION_SQL,
  BASE_IDENTITY_PROVISIONAL_SQL,
  BASE_IDENTITY_HANDOVER_BACKOFF_SQL,
  BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  baseShortIdsMigration,
} from '../server/base/schema.js';
import {
  registerBaseRegistrationRoutes,
  type ChainRuntime,
} from '../server/base/identity/routes.js';

const AGENT = '9f8e7d6c-5b4a-4321-8fed-cba987654321';
const OWNER = `0x${'2'.repeat(40)}`;

async function setup(
  t: { after: (fn: () => Promise<unknown>) => void },
  runtimeOk = true,
  visibility = 'public',
  revokedAt: string | null = null,
) {
  const revoked = revokedAt ? `,"revokedAt":"${revokedAt}"` : '';
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(`CREATE TABLE operators (id text PRIMARY KEY);
    INSERT INTO operators VALUES ('ws-1'), ('ws-2');
    CREATE TABLE workspaces (operator_id text PRIMARY KEY, data jsonb NOT NULL);
    CREATE TABLE agent_manifests (agent_id text, operator_id text, revision integer, manifest jsonb);
    INSERT INTO workspaces VALUES ('ws-1', '{"agents":[{"id":"${AGENT}","revision":1${revoked}}]}');
    INSERT INTO agent_manifests VALUES ('${AGENT}', 'ws-1', 1, '{"spec":{"visibility":"${visibility}"}}');`);
  await pg.exec(BASE_MIGRATION_SQL);
  await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
  await pg.exec(baseShortIdsMigration.sql);
  await pg.exec(BASE_IDENTITY_PROVISIONAL_SQL);
  await pg.exec(BASE_IDENTITY_HANDOVER_BACKOFF_SQL);
  await pg.exec(BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL);
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  let n = 0;
  const runtime: ChainRuntime = {
    walletPort: {
      implementationVersion: 'cbsw-1.1',
      deriveSmartAccount: async () => `0x${'1'.repeat(40)}`,
      createSpender: async () => ({ spender: `0x${'3'.repeat(40)}`, keyRef: 'v1:k' }),
      commitSpender: async () => {},
    },
    identityPort: {
      register: async (input) => ({
        idempotencyKey: input.operationKey,
        status: 'final',
        txHash: '0xa',
      }),
      registeredId: async () => 77n,
      transfer: async (input) => ({
        idempotencyKey: input.operationKey,
        status: ++n > 1 ? 'final' : 'submitted',
        txHash: '0xb',
      }),
    },
  };
  const app = Fastify();
  t.after(() => app.close());
  registerBaseRegistrationRoutes(app, {
    db,
    env: { CITY_BASE_MAINNET: '1' },
    currentOperator: async (request) => {
      const who = request.headers['x-test-operator'];
      return typeof who === 'string' ? { id: who } : null;
    },
    runtime: async () => {
      if (!runtimeOk) throw new Error('RUNTIME_UNAVAILABLE');
      return runtime;
    },
  });
  return app;
}

const register = (app: Awaited<ReturnType<typeof setup>>, operator?: string, agent = AGENT) =>
  app.inject({
    method: 'POST',
    url: `/api/base/agents/${agent}/register`,
    headers: operator ? { 'x-test-operator': operator } : {},
    payload: { ownerAddress: OWNER },
  });

test('the owner registers an agent step by step on Base mainnet', async (t) => {
  const app = await setup(t);
  const first = await register(app, 'ws-1');
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().identity.state, 'submitted');
  assert.equal(first.json().identity.erc8004AgentId, '77');
  assert.deepEqual(first.json().wallet, {
    address: `0x${'1'.repeat(40)}`,
    ownerAddress: OWNER,
    state: 'derived',
  });
  const second = await register(app, 'ws-1');
  assert.equal(second.json().identity.state, 'confirmed');
  const status = await app.inject({
    url: `/api/base/agents/${AGENT}/registration`,
    headers: { 'x-test-operator': 'ws-1' },
  });
  assert.equal(status.json().identities[0].state, 'confirmed');
  assert.equal(status.json().identities[0].chainId, 8453);
  // After a reload the panel still knows the agent's wallet and the owner wallet that controls it.
  assert.deepEqual(status.json().identities[0].wallet, {
    address: `0x${'1'.repeat(40)}`,
    ownerAddress: OWNER,
    state: 'derived',
  });
  assert.doesNotMatch(status.body, /spender|keyRef|key_ref/i);
});

test('the server-bound owner wins over any address the browser remembers', async (t) => {
  const app = await setup(t);
  await register(app, 'ws-1');
  // A later POST naming another owner cannot rebind the wallet; the read reports the stored owner.
  const other = `0x${'4'.repeat(40)}`;
  const conflict = await app.inject({
    method: 'POST',
    url: `/api/base/agents/${AGENT}/register`,
    headers: { 'x-test-operator': 'ws-1' },
    payload: { ownerAddress: other },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().code, 'wallet_conflict');
  assert.equal(conflict.json().ownerAddress, OWNER);
  const status = await app.inject({
    url: `/api/base/agents/${AGENT}/registration`,
    headers: { 'x-test-operator': 'ws-1' },
  });
  assert.equal(status.json().identities[0].wallet.ownerAddress, OWNER);
});

test('an agent with nothing started lists no identities', async (t) => {
  const app = await setup(t);
  const status = await app.inject({
    url: `/api/base/agents/${AGENT}/registration`,
    headers: { 'x-test-operator': 'ws-1' },
  });
  assert.equal(status.statusCode, 200);
  assert.deepEqual(status.json(), { identities: [] });
});

test('strangers, anonymous callers and bad input are refused; no runtime means 503', async (t) => {
  const app = await setup(t);
  assert.equal((await register(app)).statusCode, 401);
  assert.equal((await register(app, 'ws-2')).statusCode, 404);
  assert.equal((await register(app, 'ws-1', 'not-a-uuid')).statusCode, 404);
  const bad = await app.inject({
    method: 'POST',
    url: `/api/base/agents/${AGENT}/register`,
    headers: { 'x-test-operator': 'ws-1' },
    payload: { ownerAddress: 'nope' },
  });
  assert.equal(bad.statusCode, 400);
  const off = await setup(t, false);
  assert.equal((await register(off, 'ws-1')).statusCode, 503);
});

test('a private profile is refused before anything starts', async (t) => {
  const app = await setup(t, true, 'private');
  const refused = await register(app, 'ws-1');
  assert.equal(refused.statusCode, 409);
  assert.deepEqual(refused.json(), {
    error: "Make the agent's profile public first.",
    code: 'profile_private',
  });
  const status = await app.inject({
    url: `/api/base/agents/${AGENT}/registration`,
    headers: { 'x-test-operator': 'ws-1' },
  });
  assert.deepEqual(status.json(), { identities: [] });
});

test('a revoked agent is refused even when its last profile was public', async (t) => {
  // Its card (/a/<id>) answers 404, so a Base ID pointing there would never resolve.
  const app = await setup(t, true, 'public', '2026-10-01T00:00:00.000Z');
  const refused = await register(app, 'ws-1');
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().code, 'profile_private');
  const status = await app.inject({
    url: `/api/base/agents/${AGENT}/registration`,
    headers: { 'x-test-operator': 'ws-1' },
  });
  assert.deepEqual(status.json(), { identities: [] });
});
