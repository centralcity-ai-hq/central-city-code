import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../server/database.js';
import { BASE_MIGRATION_SQL } from '../server/base/schema.js';
import { BASE_SEPOLIA } from '../shared/base/chains.js';
import { createFleetAdapter } from '../server/base/fleet/adapter.js';
import { runFleetSlice, type FleetItem } from '../server/base/fleet/worker.js';
import { createWalletService } from '../server/base/wallet/service.js';

const OWNER = '0x1111111111111111111111111111111111111111';

async function setup(t: { after(fn: () => unknown): void }) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(
    "CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws-1'), ('ws-2');",
  );
  await pg.exec(BASE_MIGRATION_SQL);
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  let spenders = 0;
  const wallets = createWalletService({
    db,
    chain: {
      implementationVersion: 'test',
      deriveSmartAccount: async (_c, _o, index) =>
        `0x${(index % 2n ** 160n).toString(16).padStart(40, '0')}`,
      createSpender: async () => ({
        spender: `0x${(++spenders).toString(16).padStart(40, '0')}`,
        keyRef: `v1:00000000-0000-4000-8000-${spenders.toString().padStart(12, '0')}`,
      }),
      commitSpender: async () => {},
    },
  });
  return { pg, wallets };
}

const item = (overrides: Partial<FleetItem> = {}): FleetItem => ({
  jobId: 'job-1',
  workspaceId: 'ws-1',
  chainId: BASE_SEPOLIA,
  agentId: 'agent-1',
  ordinal: 0,
  intentHash: 'intent-1',
  registrationMode: 'lazy',
  stage: 'wallet',
  operationKey: 'job-1:0:wallet',
  attempted: false,
  ...overrides,
});

test('wallet stage: absent until created, final after, idempotent on retry', async (t) => {
  const { pg, wallets } = await setup(t);
  const adapter = createFleetAdapter({ wallets, ownerOf: async () => OWNER });
  assert.equal(await adapter.reconcile(item()), 'absent');
  assert.equal(await adapter.submit(item()), 'final');
  assert.equal(await adapter.reconcile(item()), 'final');
  assert.equal(await adapter.submit(item()), 'final');
  const { rows } = await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM base_wallets');
  assert.equal(rows[0].n, 1);
});

test("another workspace's wallet for the agent is never adopted", async (t) => {
  const { wallets } = await setup(t);
  const adapter = createFleetAdapter({ wallets, ownerOf: async () => OWNER });
  await adapter.submit(item());
  await assert.rejects(adapter.reconcile(item({ workspaceId: 'ws-2' })), /elsewhere/);
  await assert.rejects(adapter.submit(item({ workspaceId: 'ws-2' })));
});

test('registration without an identity service is never final', async (t) => {
  const { wallets } = await setup(t);
  const adapter = createFleetAdapter({ wallets, ownerOf: async () => OWNER });
  const registration = item({ registrationMode: 'immediate', stage: 'registration' });
  await assert.rejects(adapter.reconcile(registration), /not available/);
  await assert.rejects(adapter.submit(registration), /not available/);
});

test('worker + adapter: a slice creates each wallet once', async (t) => {
  const { pg, wallets } = await setup(t);
  const adapter = createFleetAdapter({ wallets, ownerOf: async () => OWNER });
  const queue = [0, 1, 2].map((n) => item({ agentId: `agent-${n}`, ordinal: n }));
  const settled: string[] = [];
  const store = {
    async claim() {
      const next = queue.shift();
      return next ? { item: next, fence: `f-${next.ordinal}` } : null;
    },
    async begin() {
      return true;
    },
    async settle(_c: unknown, outcome: string) {
      settled.push(outcome);
    },
    async refuse() {
      settled.push('refused');
      return true;
    },
  };
  const result = await runFleetSlice('job-1', {
    store,
    authority: { authorize: async () => {} },
    adapter,
  });
  assert.deepEqual(result, { claimed: 3, final: 3, deferred: 0, refused: 0, failed: 0 });
  assert.deepEqual(settled, ['final', 'final', 'final']);
  const { rows } = await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM base_wallets');
  assert.equal(rows[0].n, 3);
});
