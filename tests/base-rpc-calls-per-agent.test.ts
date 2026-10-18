import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import type { Database } from '../server/database.js';
import {
  BASE_IDENTITY_HANDOVER_BACKOFF_SQL,
  BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL,
  BASE_IDENTITY_PROVISIONAL_SQL,
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  BASE_SHARED_ADDITIONS_SQL,
  BASE_WALLET_VAULT_SQL,
  baseShortIdsMigration,
} from '../server/base/schema.js';
import { chainRuntimes } from '../server/base/chain/runtime.js';
import {
  IDENTITY_FINALIZE_PATH,
  registerBaseRegistrationRoutes,
} from '../server/base/identity/routes.js';
import {
  IDENTITY_COLUMNS,
  identityViewOf,
  type IdentityRow,
} from '../server/base/identity/service.js';
import { BASE_MAINNET, baseNetwork, type BaseChainId } from '../shared/base/chains.js';
import {
  CDP_URL,
  FALLBACK_URL,
  fakeBaseNode,
  tally,
  type CallRecord,
} from './base-fake-rpc-node.js';

/*
 * What one agent's Base registration costs on the shared CDP endpoint, end to end: the real
 * register route and finalize cron, the real chain runtime (bundler, paymaster, read transport,
 * head cache) and the real identity service and port, against a simulated Base node behind
 * `fetch` that counts every JSON-RPC call by endpoint (fake-rpc-node.ts). The owner's panel polls
 * at the pollAfterMs the server answers; the cron runs every minute; the clock is mocked, blocks
 * come every 2 s, 'safe' trails by 1 minute and 'finalized' by 20 minutes. Synthetic keys and
 * addresses only; nothing leaves the process.
 */

const AGENT = '9f8e7d6c-5b4a-4321-8fed-cba987654321';
const OWNER = `0x${'a'.repeat(40)}`;
const SECRET = 's'.repeat(32);
const T0 = 1_760_000_000_000;
const ENV: Record<string, string> = {
  CITY_BASE_MAINNET: '1',
  CITY_BASE_CDP_RPC_URL: CDP_URL,
  CITY_BASE_READ_FALLBACK_RPC_URL: FALLBACK_URL,
  CITY_BASE_SPENDER_KEK: `v1:${randomBytes(32).toString('base64')}`,
  CITY_BASE_MAX_FEE_PER_GAS_WEI: '1000000000',
  CITY_BASE_IDENTITY_FEE_CAP_WEI: '1000000000000000',
};
const network = baseNetwork(BASE_MAINNET, ENV)!;

interface Scenario {
  /** Blocks from the send until an operation lands, by its order of first send (0 = register). */
  inclusionBlocks?: (sendIndex: number) => bigint;
  /** Whether the owner's panel is open (and polling) this many ms into the run. */
  ownerWatching?: (elapsedMs: number) => boolean;
  /** The CDP endpoint answers 429 for this method at this point of the run. */
  cdpBusy?: (elapsedMs: number, method: string) => boolean;
  limitMs?: number;
  /** Panels polling at once (several tabs or scripts of the same owner). */
  tabs?: number;
  /** The second endpoint is stuck on these old tagged heads. */
  fallbackStuckAt?: Partial<Record<'safe' | 'finalized', bigint>>;
}

interface Run {
  calls: CallRecord[];
  state: string;
  confirmedAfterMs: number | null;
  distinctSends: number;
  ownerPolls: number;
  cronRuns: number;
  /** Every stage the registration went through, in order. */
  stages: string[];
}

async function simulate(t: TestContext, scenario: Scenario = {}): Promise<Run> {
  let clock = T0;
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  const node = fakeBaseNode({
    entryPoint: network.contracts.entryPointV06,
    registry: network.contracts.identityRegistry!,
    chainId: BASE_MAINNET,
    now: () => clock,
    startAt: T0,
    inclusionBlocks: scenario.inclusionBlocks,
    fallbackStuckAt: scenario.fallbackStuckAt,
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = node.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  node.setCdpBusy((method) => scenario.cdpBusy?.(clock - T0, method) ?? false);

  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(`CREATE TABLE operators (id text PRIMARY KEY, kind text NOT NULL);
    INSERT INTO operators VALUES ('p-1', 'owner');
    CREATE TABLE workspaces (operator_id text PRIMARY KEY, data jsonb NOT NULL);
    CREATE TABLE agent_manifests (agent_id text, operator_id text, revision integer, manifest jsonb);
    INSERT INTO workspaces VALUES ('p-1', '{"agents":[{"id":"${AGENT}","revision":1}]}');
    INSERT INTO agent_manifests VALUES ('${AGENT}', 'p-1', 1, '{"spec":{"visibility":"public"}}');`);
  await pg.exec(BASE_MIGRATION_SQL);
  await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
  await pg.exec(baseShortIdsMigration.sql);
  await pg.exec(BASE_SHARED_ADDITIONS_SQL);
  await pg.exec(BASE_IDENTITY_PROVISIONAL_SQL);
  await pg.exec(BASE_IDENTITY_HANDOVER_BACKOFF_SQL);
  await pg.exec(BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL);
  await pg.exec(BASE_WALLET_VAULT_SQL);
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  const runtimes = chainRuntimes(db, ENV);
  const app = Fastify();
  t.after(() => app.close());
  registerBaseRegistrationRoutes(app, {
    db,
    env: ENV,
    currentOperator: async (request) =>
      request.headers['x-test-person'] === 'p-1' ? { id: 'p-1' } : null,
    runtime: (chainId: BaseChainId) => runtimes(chainId),
    cronSecret: SECRET,
    log: () => {},
  });

  const limit = scenario.limitMs ?? 60 * 60_000;
  const watching = scenario.ownerWatching ?? (() => true);
  let nextPoll = T0;
  let nextCron = T0 + 60_000;
  let ownerPolls = 0;
  let cronRuns = 0;
  let state = 'none';
  let confirmedAfterMs: number | null = null;
  const stages: string[] = [];
  const tabs = scenario.tabs ?? 1;
  /** The stage the registration is in now (DB only), to attribute calls to it. */
  const stage = async () => {
    const { rows } = await pg.query<IdentityRow>(
      `SELECT ${IDENTITY_COLUMNS} FROM base_identities WHERE agent_id = $1`,
      [AGENT],
    );
    return rows[0] ? identityViewOf(rows[0], clock).stage : 'new';
  };
  while (clock - T0 <= limit) {
    if (watching(clock - T0) && clock >= nextPoll) {
      node.setActor(`owner:${await stage()}`);
      ownerPolls += tabs;
      const answers = [];
      for (let tab = 0; tab < tabs; tab++)
        answers.push(
          await app.inject({
            method: 'POST',
            url: `/api/base/agents/${AGENT}/register`,
            headers: { 'x-test-person': 'p-1' },
            payload: { ownerAddress: OWNER },
          }),
        );
      const response = answers[0];
      assert.ok([200, 503].includes(response.statusCode), response.body);
      const identity = (response.json() as { identity?: { pollAfterMs?: number | null } }).identity;
      // The panel: pollAfterMs (at least 1 s), 5 s without one, 30 s after a busy answer.
      nextPoll =
        clock +
        (response.statusCode === 503 ? 30_000 : Math.max(1000, identity?.pollAfterMs ?? 5000));
    }
    if (clock >= nextCron) {
      node.setActor(`cron:${await stage()}`);
      cronRuns++;
      const response = await app.inject({
        method: 'GET',
        url: IDENTITY_FINALIZE_PATH,
        headers: { authorization: `Bearer ${SECRET}` },
      });
      assert.equal(response.statusCode, 200);
      nextCron += 60_000;
    }
    const { rows } = await pg.query<{ state: string }>(
      'SELECT state FROM base_identities WHERE agent_id = $1',
      [AGENT],
    );
    state = rows[0]?.state ?? 'none';
    const now = await stage();
    if (stages.at(-1) !== now) stages.push(now);
    if (state === 'confirmed' || state === 'failed') {
      confirmedAfterMs = state === 'confirmed' ? clock - T0 : null;
      break;
    }
    clock += 1000;
    t.mock.timers.setTime(clock);
  }
  return {
    calls: node.calls,
    state,
    confirmedAfterMs,
    distinctSends: node.distinctSends(),
    ownerPolls,
    cronRuns,
    stages,
  };
}

function tallyBy(calls: readonly CallRecord[], key: (c: CallRecord) => string) {
  const out: Record<string, number> = {};
  for (const call of calls) out[key(call)] = (out[key(call)] ?? 0) + 1;
  return out;
}

function report(name: string, run: Run) {
  const cdp = run.calls.filter((c) => c.endpoint === 'cdp');
  const summary = {
    scenario: name,
    state: run.state,
    confirmedAfterMin: run.confirmedAfterMs === null ? null : run.confirmedAfterMs / 60_000,
    ownerPolls: run.ownerPolls,
    cronRuns: run.cronRuns,
    cdpCalls: cdp.length,
    cdpByActorAndStage: tallyBy(cdp, (c) => c.actor),
    fallbackCalls: run.calls.length - cdp.length,
    byMethod: tally(run.calls),
    cdpByStageMethod: tallyBy(cdp, (c) => `${c.actor} ${c.method}`),
  };
  // CITY_RPC_REPORT=1 prints the full call map of every scenario.
  if (process.env.CITY_RPC_REPORT) console.info(JSON.stringify(summary, null, 1));
  return summary;
}

/** The stages a registration that is never refused, lost or reorged goes through. */
const SMOOTH = ['registering', 'handing_over', 'finalizing', 'registered', 'confirmed'];
/** Under the target of 100 CDP calls per agent (before: ~774 happy, ~2,093 slow, ~308 cron only). */
const CDP_BUDGET = 100;

test('happy path, owner watching: one agent costs a few dozen CDP calls', async (t) => {
  const run = await simulate(t);
  const summary = report('happy', run);
  assert.equal(run.state, 'confirmed');
  assert.deepEqual(run.stages, SMOOTH);
  assert.equal(run.distinctSends, 2, 'one register and one hand-over, never more');
  assert.ok(summary.cdpCalls < CDP_BUDGET / 2, `${summary.cdpCalls} CDP calls`);
  // Waiting for SAFE / FINAL reads hints only; the CDP endpoint sees the few checks at a crossing.
  const settling = run.calls.filter(
    (c) => c.endpoint === 'cdp' && /:(finalizing|registered)$/.test(c.actor),
  );
  assert.ok(settling.length <= 10, `${settling.length} CDP calls while settling`);
  // Finality is not delayed: confirmed within a minute of the hand-over block's finalization.
  assert.ok(run.confirmedAfterMs! <= 21 * 60_000, `confirmed after ${run.confirmedAfterMs} ms`);
});

test('slow inclusion (each operation lands after ~5 cron runs), owner watching', async (t) => {
  const run = await simulate(t, { inclusionBlocks: () => 150n });
  const summary = report('slow', run);
  assert.equal(run.state, 'confirmed');
  assert.deepEqual(run.stages, SMOOTH);
  assert.equal(run.distinctSends, 2);
  // Ten minutes in flight in all: every check still reads the bundler's receipt and the nonce
  // (a landing or a consumed nonce is never held back, submit.ts), at most once a minute later on.
  assert.ok(summary.cdpCalls < CDP_BUDGET * 1.2, `${summary.cdpCalls} CDP calls`);
  assert.ok(run.confirmedAfterMs! <= 31 * 60_000, `confirmed after ${run.confirmedAfterMs} ms`);
});

test('happy path, owner leaves after 20 s (cron only from then on)', async (t) => {
  const run = await simulate(t, { ownerWatching: (ms) => ms < 20_000 });
  const summary = report('owner-leaves', run);
  assert.equal(run.state, 'confirmed');
  assert.deepEqual(run.stages, SMOOTH);
  assert.equal(run.distinctSends, 2);
  assert.ok(summary.cdpCalls < CDP_BUDGET / 2, `${summary.cdpCalls} CDP calls`);
});

test('three tabs polling at once cost what one does: one advance per check interval', async (t) => {
  const one = report('one-tab', await simulate(t));
  t.mock.timers.reset();
  const run = await simulate(t, { tabs: 3 });
  const three = report('three-tabs', run);
  assert.equal(run.state, 'confirmed');
  assert.deepEqual(run.stages, SMOOTH);
  assert.equal(run.distinctSends, 2);
  assert.ok(three.cdpCalls <= one.cdpCalls + 3, `${three.cdpCalls} vs ${one.cdpCalls}`);
});

test('CDP busy (429 on every call) for three minutes: answers stay 200/503, then it finishes', async (t) => {
  const run = await simulate(t, {
    cdpBusy: (ms) => ms >= 3_000 && ms < 183_000,
    limitMs: 45 * 60_000,
  });
  report('busy', run);
  assert.equal(run.state, 'confirmed');
  assert.ok(!run.stages.includes('failed'));
  assert.equal(run.distinctSends, 2, 'a busy endpoint never makes a second operation');
});

test('a second endpoint stuck on old safe / finalized heads never holds finality back', async (t) => {
  // Its safe head 15 minutes and its finalized head 50 minutes old from the start (and older every
  // minute): too old to be taken, so the CDP endpoint answers those tags and the registration
  // confirms as it would with a healthy second endpoint.
  const run = await simulate(t, {
    fallbackStuckAt: { safe: 30_000_000n - 450n, finalized: 30_000_000n - 1500n },
    limitMs: 30 * 60_000,
  });
  const summary = report('stale-second', run);
  assert.equal(run.state, 'confirmed');
  assert.deepEqual(run.stages, SMOOTH);
  assert.equal(run.distinctSends, 2);
  assert.ok(run.confirmedAfterMs! <= 21 * 60_000, `confirmed after ${run.confirmedAfterMs} ms`);
  assert.ok(summary.cdpCalls < CDP_BUDGET * 2, `${summary.cdpCalls} CDP calls`);
});
