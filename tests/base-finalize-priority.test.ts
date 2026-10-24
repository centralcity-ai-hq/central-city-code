import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import type { Database } from '../server/database.js';
import {
  BASE_IDENTITY_HANDOVER_BACKOFF_SQL,
  BASE_IDENTITY_PROVISIONAL_SQL,
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL,
  BASE_WALLET_VAULT_SQL,
  baseShortIdsMigration,
} from '../server/base/schema.js';
import {
  FINALIZE_BATCH,
  FINALIZE_FRESH_MS,
  FINALIZE_REGISTER_PER_RUN,
  IDENTITY_FINALIZE_PATH,
  registerBaseRegistrationRoutes,
} from '../server/base/identity/routes.js';
import { BASE_MAINNET } from '../shared/base/chains.js';

/*
 * The finalize cron's claim order. A large backlog of rows not yet registered on chain (yesterday's
 * queue) must never starve identities already minted: those (hand-over, finalizing) and those whose
 * registration is in flight are claimed first, and a run takes at most FINALIZE_REGISTER_PER_RUN
 * rows that would start a new registration. Only the claim is measured here (the chain runtime is
 * unavailable, so no row advances): which rows a run marks swept.
 */
const SECRET = 's'.repeat(32);
const NOW = 10_000_000;

async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(`CREATE TABLE operators (id text PRIMARY KEY, kind text NOT NULL);
    INSERT INTO operators VALUES ('p-1', 'owner');
    CREATE TABLE workspaces (operator_id text PRIMARY KEY, data jsonb NOT NULL);
    CREATE TABLE agent_manifests (agent_id text, operator_id text, revision integer, manifest jsonb);`);
  for (const sql of [
    BASE_MIGRATION_SQL,
    BASE_PAYMENTS_MIGRATION_SQL,
    baseShortIdsMigration.sql,
    BASE_IDENTITY_PROVISIONAL_SQL,
    BASE_IDENTITY_HANDOVER_BACKOFF_SQL,
    BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL,
    BASE_WALLET_VAULT_SQL,
  ])
    await pg.exec(sql);
  const db = {
    query: (sql: string, params?: unknown[]) => pg.query(sql, params),
    exec: (sql: string) => pg.exec(sql),
    transaction: (action: (tx: never) => Promise<unknown>) =>
      pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  } as unknown as Database;
  const app = Fastify();
  t.after(() => app.close());
  registerBaseRegistrationRoutes(app, {
    db,
    env: { CITY_BASE_MAINNET: '1', CITY_BASE_WALLET: '1' },
    currentOperator: async () => null,
    currentPerson: async () => null,
    // No chain this run: every claimed row fails to advance and stays as it was, only swept.
    runtime: async () => {
      throw new Error('no chain in this test');
    },
    cronSecret: SECRET,
    now: () => NOW,
    log: () => {},
  } as never);
  let n = 0;
  const insert = async (kind: 'unregistered' | 'in_flight' | 'minted', sweptAt: number | null) => {
    const agent = `00000000-0000-4000-8000-${(++n).toString().padStart(12, '0')}`;
    await pg.query(
      `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address,
         agent_card_uri, owner_of_identity, state, op_id, updated_at, swept_at, mint_op_id,
         provisional_agent_id)
       VALUES ($1, $2, 'p-1', '0xregistry', 'https://centralcity.ai/a/x', '0xowner', 'pending',
         $3, $4, $5, $6, $7)`,
      [
        agent,
        BASE_MAINNET,
        `identity:register:${BASE_MAINNET}:${agent}`,
        NOW - FINALIZE_FRESH_MS - 1,
        sweptAt,
        kind === 'unregistered' ? null : `identity:register:${BASE_MAINNET}:${agent}`,
        kind === 'minted' ? n : null,
      ],
    );
    return agent;
  };
  const cron = () =>
    app.inject({ url: IDENTITY_FINALIZE_PATH, headers: { authorization: `Bearer ${SECRET}` } });
  const swept = async () =>
    new Set(
      (
        await pg.query<{ agent_id: string }>(
          'SELECT agent_id FROM base_identities WHERE swept_at = $1',
          [NOW],
        )
      ).rows.map((row) => row.agent_id),
    );
  return { insert, cron, swept };
}

test('minted and in-flight rows are claimed before a backlog of unregistered rows, which is capped per run', async (t) => {
  const { insert, cron, swept } = await setup(t);
  // The backlog: never swept, so the old order (swept_at NULLS FIRST) took only these.
  const backlog: string[] = [];
  for (let i = 0; i < 40; i++) backlog.push(await insert('unregistered', null));
  // Already minted (waiting for the hand-over) and in flight: swept once before, long ago.
  const minted: string[] = [];
  for (let i = 0; i < 6; i++) minted.push(await insert('minted', 1));
  const inFlight: string[] = [];
  for (let i = 0; i < 3; i++) inFlight.push(await insert('in_flight', 1));

  assert.equal((await cron()).statusCode, 200);
  const taken = await swept();
  for (const agent of [...minted, ...inFlight]) assert.ok(taken.has(agent), 'started rows first');
  assert.equal(backlog.filter((agent) => taken.has(agent)).length, FINALIZE_REGISTER_PER_RUN);
  assert.equal(taken.size, minted.length + inFlight.length + FINALIZE_REGISTER_PER_RUN);
});

test('with more started rows than a batch, minted ones come first and new registrations still get their share', async (t) => {
  const { insert, cron, swept } = await setup(t);
  const inFlight: string[] = [];
  for (let i = 0; i < FINALIZE_BATCH; i++) inFlight.push(await insert('in_flight', 1));
  const minted: string[] = [];
  for (let i = 0; i < 5; i++) minted.push(await insert('minted', 2));
  const backlog: string[] = [];
  for (let i = 0; i < 20; i++) backlog.push(await insert('unregistered', null));

  await cron();
  const taken = await swept();
  for (const agent of minted) assert.ok(taken.has(agent), 'minted rows are never starved');
  assert.equal(inFlight.filter((agent) => taken.has(agent)).length, FINALIZE_BATCH - minted.length);
  assert.equal(backlog.filter((agent) => taken.has(agent)).length, FINALIZE_REGISTER_PER_RUN);
});

test('the workers advance minted rows first, then in-flight ones, then new registrations', async (t) => {
  const { insert, cron } = await setup(t);
  // Inserted first, so a storage-ordered RETURNING would list the new registrations first.
  const fresh: string[] = [];
  for (let i = 0; i < FINALIZE_REGISTER_PER_RUN; i++)
    fresh.push(await insert('unregistered', null));
  const inFlight: string[] = [];
  for (let i = 0; i < 4; i++) inFlight.push(await insert('in_flight', 1));
  const minted: string[] = [];
  for (let i = 0; i < 6; i++) minted.push(await insert('minted', 1));

  // Each claimed row is attempted once, in the workers' order; with no chain each logs an error.
  const order: string[] = [];
  t.mock.method(console, 'info', (line: string) => {
    const event = JSON.parse(line) as { event?: string; agentId?: string };
    if (event.event === 'identity.finalize_error' && event.agentId) order.push(event.agentId);
  });
  await cron();
  assert.equal(order.length, fresh.length + inFlight.length + minted.length);
  const tierOf = (agent: string) => (minted.includes(agent) ? 0 : inFlight.includes(agent) ? 1 : 2);
  const tiers = order.map(tierOf);
  assert.deepEqual(
    tiers,
    [...tiers].sort((a, b) => a - b),
    `started in tier order: ${tiers.join('')}`,
  );
});
