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
  createIdentityService,
  handoverKey,
  LOST_RETRY_MS,
  registerKey,
  transferKey,
  type IdentityEvent,
  type MintObservation,
  type IdentityView,
} from '../server/base/identity/service.js';
import { basePassport } from '../server/base/identity/passport.js';
import { registerShortLinks } from '../server/base/identity/short-links.js';
import { BASE_SEPOLIA, baseNetwork } from '../shared/base/chains.js';
import { shortAgentUri } from '../shared/base/short-id.js';
import { FakeIdentityChain, hashOf, type FakeMint } from './base-identity-fake-chain.js';

const WALLET = `0x${'1'.repeat(40)}`;
const SPENDER = `0x${'3'.repeat(40)}`;
const STRANGER = `0x${'9'.repeat(40)}`;
const REGISTRY = baseNetwork(BASE_SEPOLIA)!.contracts.identityRegistry!;
const CHAIN = BASE_SEPOLIA;
const R = (attempt = 0) => registerKey('a1', CHAIN, attempt);
const H = (id: bigint, attempt = 0) => handoverKey('a1', CHAIN, id, attempt);
const X = 99029n;

/** The query the registration file (short-links.ts) uses: confirmed rows only. */
const FILE_IDENTITIES = `SELECT chain_id, registry_address, erc8004_agent_id::text AS erc8004_agent_id
  FROM base_identities WHERE agent_id = $1 AND state = 'confirmed'
    AND erc8004_agent_id IS NOT NULL ORDER BY chain_id`;

interface RawRow {
  state: string;
  op_id: string | null;
  register_op_id: string | null;
  mint_op_id: string | null;
  provisional_agent_id: string | null;
  erc8004_agent_id: string | null;
  mint_tx_hash: string | null;
  mint_block: string | null;
  mint_seen_at: string | null;
  mint_lost_at: string | null;
  transfer_op_id: string | null;
  handover_id: string | null;
  handover_tx_hash: string | null;
  evidence_rev: string;
  updated_at: string;
  owner_of_identity: string;
  mint_block_hash: string | null;
  mint_finality: string | null;
  handover_finality: string | null;
  handover_block: string | null;
  destination_mismatch: string | null;
}

async function setup(
  t: { after: (fn: () => Promise<unknown>) => void },
  options: { beforeMigration85?: (db: Database) => Promise<unknown> } = {},
) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(
    "CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws');",
  );
  await pg.exec(BASE_MIGRATION_SQL);
  await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
  await pg.exec(baseShortIdsMigration.sql);
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  // Rows written before migration 85 (the legacy, final-only flow).
  await options.beforeMigration85?.(db);
  await pg.exec(BASE_IDENTITY_PROVISIONAL_SQL);
  await db.query(
    `INSERT INTO base_wallets VALUES ('w1','a1','ws',$1,$2,'0x${'2'.repeat(40)}',$3,'v1:k','{}',
      'derived',1,1)`,
    [CHAIN, WALLET, SPENDER],
  );
  const chain = new FakeIdentityChain({ spender: SPENDER, registry: REGISTRY });
  const logs: IdentityEvent[] = [];
  const clock = { at: 1_000_000 };
  const svc = createIdentityService({
    db,
    chain,
    now: () => clock.at,
    log: (event) => logs.push(event),
  });
  const row = async () =>
    (
      await db.query<RawRow>(
        `SELECT state, op_id, register_op_id, mint_op_id,
           provisional_agent_id::text AS provisional_agent_id,
           erc8004_agent_id::text AS erc8004_agent_id, mint_tx_hash, mint_block::text AS mint_block,
           mint_seen_at::text AS mint_seen_at, mint_lost_at::text AS mint_lost_at, transfer_op_id,
           handover_id::text AS handover_id, handover_tx_hash, evidence_rev::text AS evidence_rev,
           updated_at::text AS updated_at, owner_of_identity, mint_block_hash, mint_finality,
           handover_finality, handover_block::text AS handover_block, destination_mismatch
         FROM base_identities WHERE agent_id = 'a1'`,
      )
    ).rows[0];
  /** Nothing downstream ever comes from provisional state. */
  const downstream = async () => {
    const state = (await row())?.state;
    if (state === 'confirmed') return;
    assert.equal(await basePassport(db, 'a1'), null, 'no passport before confirmed');
    assert.equal((await db.query(FILE_IDENTITIES, ['a1'])).rows.length, 0, 'no registration file');
  };
  const advance = async (options: { retry?: boolean } = {}): Promise<IdentityView> => {
    await downstream();
    const view = await svc.advance('a1', CHAIN, options);
    await downstream();
    assert.equal('opId' in view, false);
    assert.equal('evidenceRev' in view, false);
    return view;
  };
  return { db, pg, chain, logs, clock, svc, row, advance };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

const mintOf = (patch: Partial<FakeMint> = {}): FakeMint => ({
  tx: '0xa1',
  block: 100,
  id: X,
  ...patch,
});

/** Register signed (advance 1), then included and handed over at once (advance 2). */
async function provisional(ctx: Ctx, mint: FakeMint = mintOf()) {
  const first = await ctx.advance();
  assert.equal(first.stage, 'registering');
  ctx.chain.include(R(0), mint);
  return ctx.advance();
}

test('fast path: the provisional id is shown and handed over in the same call', async (t) => {
  const ctx = await setup(t);
  const { chain } = ctx;
  const startedAt = ctx.clock.at;
  const first = await ctx.advance();
  assert.equal(first.state, 'submitted');
  assert.equal(first.stage, 'registering');
  assert.equal(first.pollAfterMs, 2000);
  assert.equal(first.startedAt, startedAt);
  assert.deepEqual(chain.signedKeys(), { [R(0)]: 1 });

  ctx.clock.at += 4_000;
  chain.include(R(0), mintOf());
  const second = await ctx.advance();
  assert.equal(second.state, 'submitted');
  assert.ok(['handing_over', 'finalizing'].includes(second.stage), second.stage);
  assert.equal(second.provisionalAgentId, '99029');
  assert.equal(second.erc8004AgentId, null);
  assert.equal(second.canRetry, false);
  assert.equal(second.mintTxHash, '0xa1');
  assert.equal(second.idSeenAt, ctx.clock.at);
  // The start of the attempt stays put while it progresses ("Taking longer than usual").
  assert.equal(second.startedAt, startedAt);
  assert.equal(chain.signs.get(H(X)), 1);
  assert.equal(chain.intents.get(H(X)), X);
  const r = await ctx.row();
  assert.equal(r.mint_op_id, R(0));
  assert.equal(r.mint_tx_hash, '0xa1');
  assert.equal(r.mint_block, '100');
  assert.equal(r.handover_id, '99029');
  assert.equal(r.transfer_op_id, H(X));
  assert.equal(r.op_id, H(X));
  assert.notEqual(r.mint_seen_at, null);
  const bound = ctx.logs.find((e) => e.event === 'identity.provisional_bound');
  assert.equal(bound?.latencyMs, 4_000);

  for (let i = 0; i < 3; i++) await ctx.advance();
  assert.deepEqual(chain.calls.register, [R(0), R(0)], 'register() is never called again');
});

for (const order of ['transfer first', 'register first'] as const) {
  test(`confirmed only when both operations are final (${order})`, async (t) => {
    const ctx = await setup(t);
    const { chain } = ctx;
    await provisional(ctx);
    chain.include(H(X), { tx: '0xb1', block: 101 });
    if (order === 'transfer first') {
      chain.finalize(H(X));
      const a = await ctx.advance();
      assert.equal(a.state, 'submitted');
      assert.equal(a.stage, 'finalizing');
      assert.equal(a.erc8004AgentId, null);
      // Same tx and block promoted to final; the owner is not read again (zero here).
      chain.finalize(R(0), { owner: `0x${'0'.repeat(40)}` });
      const done = await ctx.advance();
      assert.equal(done.erc8004AgentId, '99029');
      assert.equal(done.state, 'confirmed');
    } else {
      chain.finalize(R(0), { owner: `0x${'0'.repeat(40)}` });
      const b = await ctx.advance();
      assert.equal(b.erc8004AgentId, '99029');
      assert.equal(b.state, 'submitted');
      assert.equal(b.stage, 'finalizing');
      chain.finalize(H(X));
      assert.equal((await ctx.advance()).state, 'confirmed');
    }
    const r = await ctx.row();
    assert.equal(r.owner_of_identity, WALLET);
    assert.equal(r.erc8004_agent_id, '99029');
    const passport = await basePassport(ctx.db, 'a1');
    assert.equal(passport?.erc8004AgentId, '99029');
    assert.deepEqual(chain.signedKeys(), { [R(0)]: 1, [H(X)]: 1 });

    const app = Fastify();
    t.after(() => app.close());
    app.get('/a2a/:agentId/.well-known/agent-card.json', async () => ({ name: 'Alphonse' }));
    registerShortLinks(app, { db: ctx.db, originOf: () => 'https://centralcity.ai' });
    const short = (
      await ctx.db.query<{ short_id: string }>(
        "SELECT short_id FROM base_short_ids WHERE agent_id = 'a1'",
      )
    ).rows[0].short_id;
    const file = await app.inject({ url: `/a/${short}` });
    assert.equal(file.statusCode, 200);
    assert.match(file.body, /99029/);
  });
}

test('a registration row from before started_at was kept shows startedAt null', async (t) => {
  const ctx = await setup(t);
  await ctx.advance();
  await ctx.db.query("UPDATE base_identities SET started_at = NULL WHERE agent_id = 'a1'");
  ctx.clock.at += 1_000;
  const view = await ctx.advance();
  assert.equal(view.stage, 'registering');
  assert.equal(view.startedAt, null);
});

test('database guards: confirmed is canonical, the final id matches, write-once', async (t) => {
  const ctx = await setup(t);
  await provisional(ctx);
  const { db } = ctx;
  await assert.rejects(
    db.query("UPDATE base_identities SET state = 'confirmed'"),
    /base_identities_confirmed_canonical/,
  );
  await assert.rejects(
    db.query('UPDATE base_identities SET erc8004_agent_id = 5'),
    /base_identities_final_id_matches/,
  );
  await assert.rejects(
    db.query(
      "UPDATE base_identities SET erc8004_agent_id = 99029, handover_id = 7, state = 'confirmed'",
    ),
    /base_identities_confirmed_canonical/,
  );
  await assert.rejects(
    db.query('UPDATE base_identities SET transfer_op_id = NULL'),
    /base_identities_handover_pair/,
  );

  // A different final id never replaces a stored one. The stored id appears without a revision
  // bump (as a corrupted concurrent write would), so only the write-once guard can refuse.
  ctx.chain.evidenceQueue.push(async () => {
    await db.query('UPDATE base_identities SET erc8004_agent_id = 99029');
    return {
      kind: 'minted',
      opKey: R(0),
      status: 'final',
      txHash: '0xa2',
      blockNumber: '101',
      blockHash: hashOf(101, '0xa2'),
      id: '99030',
      registry: REGISTRY,
      tokenUri: await svcUri(ctx),
      owner: SPENDER,
    };
  });
  const before = await ctx.row();
  await ctx.svc.advance('a1', CHAIN);
  const after = await ctx.row();
  assert.equal(after.erc8004_agent_id, '99029');
  assert.equal(after.provisional_agent_id, '99029');
  assert.equal(after.mint_tx_hash, before.mint_tx_hash);
  assert.equal(after.evidence_rev, before.evidence_rev);
  assert.ok(
    ctx.logs.some((e) => e.event === 'identity.final_id_conflict' && e.code === 'critical'),
  );
});

async function svcUri(ctx: Ctx): Promise<string> {
  return (
    await ctx.db.query<{ agent_card_uri: string }>(
      "SELECT agent_card_uri FROM base_identities WHERE agent_id = 'a1'",
    )
  ).rows[0].agent_card_uri;
}

test('a mint orphaned before any hand-over is rechecked, never terminal, then continues', async (t) => {
  const ctx = await setup(t);
  const { chain } = ctx;
  await ctx.advance();
  chain.include(R(0), mintOf());
  chain.transferError = Object.assign(new Error('not held'), { code: 'IDENTITY_NOT_HELD' });
  const seen = await ctx.advance();
  assert.equal(seen.provisionalAgentId, '99029');
  assert.deepEqual(chain.signedKeys(), { [R(0)]: 1 });
  chain.transferError = null;

  chain.lose(R(0));
  const transfers = chain.calls.transfer.length;
  for (let i = 0; i < 3; i++) {
    ctx.clock.at += 5_000;
    const v = await ctx.advance();
    assert.equal(v.state, 'submitted');
    assert.equal(v.stage, 'rechecking');
    assert.equal(v.provisionalAgentId, null);
    assert.equal(v.pollAfterMs, 5000);
    assert.equal(v.canRetry, false);
  }
  const lost = await ctx.row();
  assert.notEqual(lost.mint_lost_at, null);
  assert.deepEqual(chain.calls.register, [R(0), R(0)]);
  assert.equal(chain.calls.transfer.length, transfers, 'no transfer while the mint is missing');
  assert.deepEqual(chain.signedKeys(), { [R(0)]: 1 });

  // The owner's retry before 30 minutes changes nothing.
  ctx.clock.at += 60_000;
  const early = await ctx.advance({ retry: true });
  assert.equal(early.stage, 'rechecking');
  const unchanged = await ctx.row();
  assert.equal(unchanged.op_id, lost.op_id);
  assert.equal(unchanged.evidence_rev, lost.evidence_rev);
  assert.equal(unchanged.register_op_id, R(0));

  chain.include(R(0), mintOf({ tx: '0xa2', block: 101 }));
  const back = await ctx.advance();
  assert.equal(back.provisionalAgentId, '99029');
  assert.equal(back.mintTxHash, '0xa2');
  const r = await ctx.row();
  assert.equal(r.mint_lost_at, null);
  assert.equal(r.transfer_op_id, H(X));
  assert.deepEqual(chain.signedKeys(), { [R(0)]: 1, [H(X)]: 1 });
});

test('an orphaned transfer keeps its key and ends confirmed', async (t) => {
  const ctx = await setup(t);
  const { chain } = ctx;
  await provisional(ctx);
  const states: string[] = [];
  const step = async () => {
    const v = await ctx.advance();
    states.push(v.state);
    return v;
  };
  chain.include(H(X), { tx: '0xb1', block: 101 });
  assert.equal((await step()).stage, 'finalizing');
  chain.lose(H(X));
  assert.equal((await step()).stage, 'handing_over');
  chain.include(H(X), { tx: '0xb2', block: 102 });
  assert.equal((await step()).stage, 'finalizing');
  chain.finalize(H(X));
  assert.equal((await step()).state, 'submitted');
  chain.finalize(R(0));
  assert.equal((await step()).state, 'confirmed');
  assert.ok(!states.includes('failed'));
  assert.deepEqual(chain.signedKeys(), { [R(0)]: 1, [H(X)]: 1 });
  assert.ok(chain.calls.transfer.every((key) => key === H(X)));
});

test('an id changed by a reorg re-binds the hand-over; a stale hand-over never confirms', async (t) => {
  const ctx = await setup(t);
  const { chain } = ctx;
  await provisional(ctx, mintOf({ id: 100n }));
  assert.equal(chain.signs.get(H(100n)), 1);
  chain.lose(R(0));
  assert.equal((await ctx.advance()).stage, 'rechecking');
  chain.include(R(0), mintOf({ tx: '0xa2', block: 102, id: 101n }));
  const moved = await ctx.advance();
  assert.equal(moved.provisionalAgentId, '101');
  let r = await ctx.row();
  assert.equal(r.transfer_op_id, H(101n));
  assert.equal(r.handover_id, '101');
  assert.equal(chain.signs.get(H(101n)), 1);
  assert.deepEqual(chain.ops.get(H(100n))?.status, 'submitted', 'the old hand-over is untouched');

  // The old hand-over reports final and successful while the register op is final with 101.
  chain.include(H(100n), { tx: '0xb0', block: 103 });
  chain.finalize(H(100n));
  chain.finalize(R(0));
  const notYet = await ctx.advance();
  assert.equal(notYet.erc8004AgentId, '101');
  assert.equal(notYet.state, 'submitted');
  r = await ctx.row();
  assert.equal(r.transfer_op_id, H(101n));
  chain.include(H(101n), { tx: '0xb1', block: 104 });
  chain.finalize(H(101n));
  const done = await ctx.advance();
  assert.equal(done.state, 'confirmed');
  assert.equal(done.erc8004AgentId, '101');
  assert.deepEqual(chain.signedKeys(), { [R(0)]: 1, [H(100n)]: 1, [H(101n)]: 1 });
});

test('an id flipping back after reorgs derives the old key again, only reconciled', async (t) => {
  const ctx = await setup(t);
  const { chain } = ctx;
  await provisional(ctx, mintOf({ id: 100n }));
  chain.lose(R(0));
  await ctx.advance();
  chain.include(R(0), mintOf({ tx: '0xa2', block: 102, id: 101n }));
  await ctx.advance();
  chain.lose(R(0));
  await ctx.advance();
  chain.include(R(0), mintOf({ tx: '0xa3', block: 103, id: 100n }));
  const back = await ctx.advance();
  assert.equal(back.provisionalAgentId, '100');
  const r = await ctx.row();
  assert.equal(r.transfer_op_id, H(100n));
  assert.equal(r.op_id, H(100n));
  assert.deepEqual(chain.signedKeys(), { [R(0)]: 1, [H(100n)]: 1, [H(101n)]: 1 });
  assert.equal(chain.calls.transfer.filter((key) => key === H(100n)).length, 2);
});

test('an id flipping back to a fork where the old hand-over executed is accepted and confirms', async (t) => {
  const ctx = await setup(t);
  const { chain } = ctx;
  await provisional(ctx, mintOf({ id: 100n }));
  assert.equal(chain.signs.get(H(100n)), 1);
  chain.lose(R(0));
  await ctx.advance();
  chain.include(R(0), mintOf({ tx: '0xa2', block: 102, id: 101n }));
  await ctx.advance();
  let r = await ctx.row();
  assert.equal(r.handover_id, '101');
  assert.equal(r.transfer_op_id, H(101n));
  chain.lose(R(0));
  await ctx.advance();
  // The original fork wins: mint 100 and the hand-over H(100) already moved it to the wallet.
  chain.include(R(0), mintOf({ tx: '0xa1', block: 100, id: 100n, owner: WALLET }));
  chain.include(H(100n), { tx: '0xb0', block: 101 });
  const back = await ctx.advance();
  assert.equal(back.provisionalAgentId, '100');
  assert.equal(back.stage, 'finalizing');
  assert.ok(!ctx.logs.some((e) => e.code === 'owner_mismatch'));
  r = await ctx.row();
  assert.equal(r.mint_lost_at, null);
  assert.equal(r.handover_id, '100');
  assert.equal(r.transfer_op_id, H(100n), 'the old key is derived again, never a new one');
  chain.finalize(R(0));
  chain.finalize(H(100n));
  const done = await ctx.advance();
  assert.equal(done.state, 'confirmed');
  assert.equal(done.erc8004AgentId, '100');
  r = await ctx.row();
  assert.equal(r.erc8004_agent_id, '100');
  assert.equal(r.owner_of_identity.toLowerCase(), WALLET.toLowerCase());
  assert.deepEqual(chain.signedKeys(), { [R(0)]: 1, [H(100n)]: 1, [H(101n)]: 1 });
});

test('a mint already in the wallet after finality confirms without a stored binding', async (t) => {
  const ctx = await setup(t);
  const { chain } = ctx;
  await provisional(ctx, mintOf({ id: 100n }));
  chain.lose(R(0));
  await ctx.advance();
  chain.include(R(0), mintOf({ tx: '0xa2', block: 102, id: 101n }));
  await ctx.advance();
  chain.lose(R(0));
  await ctx.advance();
  // Seen for the first time again only once both are final on the original fork.
  chain.include(R(0), mintOf({ tx: '0xa1', block: 100, id: 100n, owner: WALLET }));
  chain.include(H(100n), { tx: '0xb0', block: 101 });
  chain.finalize(R(0));
  chain.finalize(H(100n));
  const first = await ctx.advance();
  assert.equal(first.erc8004AgentId, '100');
  const done = first.state === 'confirmed' ? first : await ctx.advance();
  assert.equal(done.state, 'confirmed');
  assert.equal(done.erc8004AgentId, '100');
  assert.ok(!ctx.logs.some((e) => e.code === 'owner_mismatch'));
  assert.deepEqual(chain.signedKeys(), { [R(0)]: 1, [H(100n)]: 1, [H(101n)]: 1 });
});

test('mint reorged after the hand-over was broadcast, then the old mint returns (same id)', async (t) => {
  const ctx = await setup(t);
  const { chain } = ctx;
  await provisional(ctx);
  chain.lose(R(0));
  const transfers = chain.calls.transfer.length;
  for (let i = 0; i < 2; i++) await ctx.advance();
  assert.equal(chain.calls.transfer.length, transfers);
  assert.deepEqual(chain.signedKeys(), { [R(0)]: 1, [H(X)]: 1 });
  // Re-included in another block; the hand-over may already have executed (owner is the wallet).
  chain.include(R(0), mintOf({ tx: '0xa9', block: 120, owner: WALLET }));
  const back = await ctx.advance();
  assert.equal(back.mintTxHash, '0xa9');
  const r = await ctx.row();
  assert.equal(r.handover_id, '99029');
  assert.equal(r.transfer_op_id, H(X));
  chain.include(H(X), { tx: '0xb1', block: 121 });
  chain.finalize(H(X));
  chain.finalize(R(0));
  assert.equal((await ctx.advance()).state, 'confirmed');
  assert.deepEqual(chain.signedKeys(), { [R(0)]: 1, [H(X)]: 1 });
});

test('a hand-over that executed before the re-included mint is replaced once, after finality', async (t) => {
  const ctx = await setup(t);
  const { chain } = ctx;
  await provisional(ctx, mintOf({ tx: '0xa0', block: 80 }));
  chain.lose(R(0));
  await ctx.advance();
  chain.fail(H(X), 90);
  chain.include(R(0), mintOf({ tx: '0xa1', block: 100 }));
  const waiting = await ctx.advance();
  assert.equal(waiting.state, 'submitted', 'not failed while the register op is not final');
  chain.finalize(R(0));
  const rebound = await ctx.advance();
  assert.equal(rebound.state, 'submitted');
  let r = await ctx.row();
  assert.equal(r.transfer_op_id, H(X, 1));
  assert.equal(r.op_id, H(X, 1));
  assert.equal(chain.signs.get(H(X, 1)), undefined, 'bound first, sent by the next call');
  await ctx.advance();
  assert.equal(chain.signs.get(H(X, 1)), 1);
  chain.include(H(X, 1), { tx: '0xb2', block: 130 });
  chain.finalize(H(X, 1));
  assert.equal((await ctx.advance()).state, 'confirmed');
  r = await ctx.row();
  assert.equal(r.erc8004_agent_id, '99029');
  assert.deepEqual(chain.signedKeys(), { [R(0)]: 1, [H(X)]: 1, [H(X, 1)]: 1 });
});

test('the same failure on attempt 1 fails; the owner retries attempt 2 of the family', async (t) => {
  const ctx = await setup(t);
  const { chain } = ctx;
  await provisional(ctx, mintOf({ tx: '0xa0', block: 80 }));
  chain.lose(R(0));
  await ctx.advance();
  chain.fail(H(X), 90);
  chain.include(R(0), mintOf({ tx: '0xa1', block: 100 }));
  await ctx.advance();
  chain.finalize(R(0));
  await ctx.advance(); // binds attempt 1
  await ctx.advance(); // sends attempt 1
  chain.fail(H(X, 1), 95);
  const failed = await ctx.advance();
  assert.equal(failed.state, 'failed');
  assert.equal(failed.canRetry, true);
  assert.equal(failed.pollAfterMs, null);
  const again = await ctx.advance({ retry: true });
  assert.equal(again.state, 'submitted');
  const r = await ctx.row();
  assert.equal(r.transfer_op_id, H(X, 2));
  assert.equal(r.op_id, H(X, 2));
  assert.equal(chain.signs.get(H(X, 2)), 1);
});

const mismatches: Array<[string, Partial<FakeMint>, string]> = [
  ['owner is neither the spender nor the agent wallet', { owner: STRANGER }, 'owner_mismatch'],
  ['tokenURI is not this agent', { uri: 'https://centralcity.ai/a/zzzzzz' }, 'uri_mismatch'],
  ['registry is another contract', { registry: `0x${'8'.repeat(40)}` }, 'registry_mismatch'],
  [
    'operation is outside the register family',
    { opKey: registerKey('someone-else', CHAIN) },
    'foreign_operation',
  ],
];
for (const [name, patch, code] of mismatches) {
  test(`evidence mismatch binds nothing and is never terminal: ${name}`, async (t) => {
    const ctx = await setup(t);
    const { chain } = ctx;
    const first = await provisional(ctx, mintOf(patch));
    assert.equal(first.provisionalAgentId, null);
    assert.equal(first.state, 'submitted');
    assert.equal(first.stage, 'registering');
    assert.equal(chain.calls.transfer.length, 0);
    assert.ok(ctx.logs.some((e) => e.event === 'identity.evidence_mismatch' && e.code === code));

    // Valid evidence binds; a mismatch after that marks the mint missing, never terminal.
    chain.include(R(0), mintOf());
    assert.equal((await ctx.advance()).provisionalAgentId, '99029');
    chain.include(R(0), mintOf({ ...patch, tx: '0xa7', block: 107 }));
    const lost = await ctx.advance();
    assert.equal(lost.stage, 'rechecking');
    assert.equal(lost.state, 'submitted');
    assert.notEqual((await ctx.row()).mint_lost_at, null);
    chain.include(R(0), mintOf());
    const back = await ctx.advance();
    assert.equal(back.provisionalAgentId, '99029');
    assert.equal((await ctx.row()).mint_lost_at, null);
    assert.deepEqual(chain.calls.register, [R(0), R(0)]);
    assert.deepEqual(chain.signedKeys(), { [R(0)]: 1, [H(X)]: 1 });
  });
}

test('concurrent pollers: one binds, one hand-over is sent', async (t) => {
  const ctx = await setup(t);
  const { chain } = ctx;
  await ctx.advance();
  chain.include(R(0), mintOf());
  chain.evidenceQueue.push(() => ({ kind: 'pending' }));
  const fenced = await ctx.advance();
  assert.equal(fenced.stage, 'registering');
  const rev = Number((await ctx.row()).evidence_rev);
  const uri = await svcUri(ctx);
  const minted = (): MintObservation => ({
    kind: 'minted',
    opKey: R(0),
    status: 'included',
    txHash: '0xa1',
    blockNumber: '100',
    blockHash: hashOf(100, '0xa1'),
    id: X.toString(10),
    registry: REGISTRY,
    tokenUri: uri,
    owner: SPENDER,
  });
  const a = chain.holdNextEvidence(minted);
  const b = chain.holdNextEvidence(minted);
  const first = ctx.svc.advance('a1', CHAIN);
  const second = ctx.svc.advance('a1', CHAIN);
  await Promise.all([a.reached, b.reached]);
  a.release();
  b.release();
  const views = await Promise.all([first, second]);
  assert.equal(Number((await ctx.row()).evidence_rev), rev + 2);
  assert.equal(chain.calls.transfer.length, 1);
  assert.equal(chain.signs.get(H(X)), 1);
  for (const view of views)
    assert.ok(
      view.provisionalAgentId === '99029' || view.stage === 'registering',
      JSON.stringify(view),
    );
  assert.ok(views.some((view) => view.provisionalAgentId === '99029'));
});

test('stale evidence loses to newer evidence and sends nothing', async (t) => {
  const ctx = await setup(t);
  const { chain } = ctx;
  await ctx.advance();
  chain.include(R(0), mintOf());
  chain.evidenceQueue.push(() => ({ kind: 'pending' }));
  await ctx.advance();
  const uri = await svcUri(ctx);
  const held = chain.holdNextEvidence(() => ({
    kind: 'minted',
    opKey: R(0),
    status: 'included',
    txHash: '0x11',
    blockNumber: '100',
    blockHash: hashOf(100, '0x11'),
    id: '100',
    registry: REGISTRY,
    tokenUri: uri,
    owner: SPENDER,
  }));
  const pollerA = ctx.svc.advance('a1', CHAIN);
  await held.reached;
  chain.include(R(0), mintOf({ tx: '0x22', block: 101, id: 200n }));
  const b = await ctx.svc.advance('a1', CHAIN);
  assert.equal(b.provisionalAgentId, '200');
  held.release();
  await pollerA;
  const r = await ctx.row();
  assert.equal(r.provisional_agent_id, '200');
  assert.equal(r.mint_tx_hash, '0x22');
  assert.deepEqual(chain.calls.transfer, [H(200n)]);
  assert.equal(chain.signs.get(H(100n)), undefined);
});

test('a late final for a hand-over bound to a stale id does not confirm', async (t) => {
  const ctx = await setup(t);
  const { chain } = ctx;
  await provisional(ctx, mintOf({ id: 100n }));
  const release = chain.holdNextTransfer();
  const pollerA = ctx.svc.advance('a1', CHAIN); // evidence unchanged; held in transfer(H(100))
  while (chain.calls.transfer.length < 2) await new Promise((r) => setImmediate(r));
  chain.include(R(0), mintOf({ tx: '0xa2', block: 102, id: 101n }));
  assert.equal((await ctx.svc.advance('a1', CHAIN)).provisionalAgentId, '101');
  chain.finalize(R(0));
  assert.equal((await ctx.svc.advance('a1', CHAIN)).erc8004AgentId, '101');
  chain.include(H(100n), { tx: '0xb0', block: 103 });
  chain.finalize(H(100n));
  release();
  const late = await pollerA;
  assert.notEqual(late.state, 'confirmed');
  const r = await ctx.row();
  assert.equal(r.state, 'submitted');
  assert.equal(r.transfer_op_id, H(101n));
  assert.equal(r.handover_tx_hash, null);
});

test('evidence comes from the attempt that landed; register is never called again', async (t) => {
  const ctx = await setup(t);
  const { chain } = ctx;
  await ctx.advance();
  ctx.clock.at += 10 * 60_000;
  await ctx.advance({ retry: true });
  ctx.clock.at += 10 * 60_000;
  chain.reportAs.set(R(2), R(0));
  chain.include(R(0), mintOf());
  chain.evidenceQueue.push(() => ({ kind: 'pending' }));
  await ctx.advance({ retry: true });
  assert.deepEqual(chain.calls.register, [R(0), R(1), R(2)]);
  let r = await ctx.row();
  assert.equal(r.mint_op_id, R(0));
  assert.equal(r.register_op_id, R(2));
  assert.equal(r.op_id, R(2), 'op_id stays on the attempt the row asked for');
  // M3: evidence is asked by the newest attempt (the port looks back over every sibling).
  assert.deepEqual(chain.calls.evidence, [R(2)]);
  const bound = await ctx.advance();
  assert.equal(bound.provisionalAgentId, '99029');
  r = await ctx.row();
  assert.equal(r.op_id, H(X));
  chain.lose(R(0));
  for (let i = 0; i < 3; i++) await ctx.advance();
  assert.deepEqual(chain.calls.register, [R(0), R(1), R(2)]);
  assert.deepEqual(chain.signedKeys(), { [R(0)]: 1, [R(1)]: 1, [H(X)]: 1 });
});

test('a registration that finally fails after a provisional id: retry, re-mint, re-bind', async (t) => {
  const ctx = await setup(t);
  const { chain } = ctx;
  await provisional(ctx);
  chain.fail(R(0));
  const failed = await ctx.advance();
  assert.equal(failed.state, 'failed');
  assert.equal(failed.canRetry, true);
  assert.equal(failed.provisionalAgentId, null);
  let r = await ctx.row();
  assert.equal(r.mint_op_id, null);
  assert.equal(r.provisional_agent_id, null);
  assert.equal(r.mint_tx_hash, null);
  assert.equal(r.erc8004_agent_id, null);
  assert.equal(r.transfer_op_id, H(X));
  assert.equal(r.handover_id, '99029');
  const retried = await ctx.advance({ retry: true });
  assert.equal(retried.state, 'submitted');
  assert.deepEqual(chain.calls.register, [R(0), R(0), R(1)]);
  r = await ctx.row();
  assert.equal(r.register_op_id, R(1));
  chain.include(R(1), mintOf({ tx: '0xc1', block: 200, id: 777n }));
  const again = await ctx.advance();
  assert.equal(again.provisionalAgentId, '777');
  r = await ctx.row();
  assert.equal(r.transfer_op_id, H(777n));
  chain.include(H(777n), { tx: '0xd1', block: 201 });
  chain.finalize(H(777n));
  chain.finalize(R(1));
  const done = await ctx.advance();
  assert.equal(done.state, 'confirmed');
  assert.equal(done.erc8004AgentId, '777');
  assert.deepEqual(chain.signedKeys(), { [R(0)]: 1, [H(X)]: 1, [R(1)]: 1, [H(777n)]: 1 });
});

test('gated retry after a seen mint went missing for 30 minutes (R3)', async (t) => {
  const ctx = await setup(t);
  const { chain } = ctx;
  await provisional(ctx);
  chain.lose(R(0));
  await ctx.advance();
  const lostAt = Number((await ctx.row()).mint_lost_at);
  ctx.clock.at = lostAt + LOST_RETRY_MS - 60_000;
  const early = await ctx.advance({ retry: true });
  assert.equal(early.canRetry, false);
  assert.equal((await ctx.row()).op_id, H(X));
  assert.deepEqual(chain.calls.register, [R(0), R(0)]);
  ctx.clock.at = lostAt + LOST_RETRY_MS;
  assert.equal((await ctx.advance()).canRetry, true);
  const retried = await ctx.advance({ retry: true });
  assert.equal(retried.canRetry, false);
  assert.equal(retried.stage, 'registering');
  let r = await ctx.row();
  assert.equal(r.op_id, R(1));
  assert.equal(r.register_op_id, R(1));
  assert.equal(r.mint_op_id, null);
  assert.equal(r.provisional_agent_id, null);
  assert.equal(r.mint_seen_at, null);
  assert.equal(r.mint_lost_at, null);
  assert.equal(r.transfer_op_id, H(X), 'the binding is kept');
  assert.equal(r.handover_id, '99029');

  // The pinned nonce's first attempt lands after all: its receipt is bound, nothing new is sent.
  chain.reportAs.set(R(1), R(0));
  chain.include(R(0), mintOf({ tx: '0xa5', block: 150 }));
  const back = await ctx.advance();
  assert.equal(back.provisionalAgentId, '99029');
  r = await ctx.row();
  assert.equal(r.mint_op_id, R(0));
  assert.equal(r.transfer_op_id, H(X));
  assert.equal(r.op_id, H(X));
  assert.deepEqual(chain.signedKeys(), { [R(0)]: 1, [H(X)]: 1, [R(1)]: 1 });
});

test('a refused transfer (not held yet) keeps the same key and no error', async (t) => {
  const ctx = await setup(t);
  const { chain } = ctx;
  await ctx.advance();
  chain.include(R(0), mintOf());
  chain.transferError = Object.assign(new Error('not held'), { code: 'IDENTITY_NOT_HELD' });
  const first = await ctx.advance();
  assert.equal(first.state, 'submitted');
  assert.equal(first.provisionalAgentId, '99029');
  assert.ok(
    ctx.logs.some((e) => e.event === 'identity.handover_refused' && e.code === 'IDENTITY_NOT_HELD'),
  );
  await ctx.advance();
  chain.transferError = null;
  await ctx.advance();
  assert.deepEqual(chain.calls.transfer, [H(X), H(X), H(X)]);
  assert.deepEqual(chain.signedKeys(), { [R(0)]: 1, [H(X)]: 1 });
});

test('polling with unchanged evidence writes nothing', async (t) => {
  const ctx = await setup(t);
  const { chain } = ctx;
  await provisional(ctx);
  chain.include(H(X), { tx: '0xb1', block: 101 });
  await ctx.advance();
  const before = await ctx.row();
  for (let i = 0; i < 5; i++) {
    ctx.clock.at += 5_000;
    const v = await ctx.advance();
    assert.equal(v.stage, 'finalizing');
    assert.equal(v.pollAfterMs, 30000);
  }
  const after = await ctx.row();
  assert.equal(after.updated_at, before.updated_at);
  assert.equal(after.evidence_rev, before.evidence_rev);
});

test('an unavailable evidence read concludes nothing', async (t) => {
  const ctx = await setup(t);
  const { chain } = ctx;
  await provisional(ctx);
  const before = await ctx.row();
  chain.evidenceError = new Error('rpc down');
  const v = await ctx.advance();
  assert.equal(v.provisionalAgentId, '99029');
  const after = await ctx.row();
  assert.equal(after.evidence_rev, before.evidence_rev);
  assert.ok(ctx.logs.some((e) => e.event === 'identity.evidence_unavailable'));
});

/* ---------------------------------------------------------------------------------------------
 * D1: 'safe' is a distinct, owner-facing signal ("registered"), never a substitute for final.
 * ------------------------------------------------------------------------------------------- */

test('D1: mint and hand-over both safe is "registered"; the state stays submitted until final', async (t) => {
  const ctx = await setup(t);
  const { chain } = ctx;
  await provisional(ctx);
  chain.include(H(X), { tx: '0xb1', block: 101 });
  assert.equal((await ctx.advance()).stage, 'finalizing');
  chain.depth(H(X), 'safe');
  const handoverOnly = await ctx.advance();
  assert.equal(handoverOnly.stage, 'finalizing', 'the mint is only included');
  chain.depth(R(0), 'safe');
  const registered = await ctx.advance();
  assert.equal(registered.stage, 'registered');
  assert.equal(registered.state, 'submitted');
  assert.equal(registered.pollAfterMs, 30000);
  assert.equal(registered.provisionalAgentId, '99029');
  assert.equal(registered.erc8004AgentId, null);
  assert.equal(registered.canRetry, false);
  let r = await ctx.row();
  assert.equal(r.mint_finality, 'safe');
  assert.equal(r.handover_finality, 'safe');
  assert.equal(r.erc8004_agent_id, null, 'safe never stores the final id');
  assert.equal(chain.calls.identityAt.length, 0);

  // Unchanged evidence: nothing is written.
  const before = await ctx.row();
  for (let i = 0; i < 3; i++) assert.equal((await ctx.advance()).stage, 'registered');
  r = await ctx.row();
  assert.equal(r.evidence_rev, before.evidence_rev);
  assert.equal(r.updated_at, before.updated_at);

  // The mint is final (canonical id stored), the hand-over still only safe: registered, not confirmed.
  chain.finalize(R(0));
  const mintFinal = await ctx.advance();
  assert.equal(mintFinal.stage, 'registered');
  assert.equal(mintFinal.state, 'submitted');
  assert.equal(mintFinal.erc8004AgentId, '99029');
  assert.equal(await basePassport(ctx.db, 'a1'), null);
  chain.finalize(H(X));
  const done = await ctx.advance();
  assert.equal(done.state, 'confirmed');
  assert.equal(done.stage, 'confirmed');
  assert.equal(done.pollAfterMs, null);
  assert.deepEqual(chain.signedKeys(), { [R(0)]: 1, [H(X)]: 1 });
});

test('D1: when finality drops back the stage falls back, never forward to confirmed', async (t) => {
  const ctx = await setup(t);
  const { chain } = ctx;
  const stages: string[] = [];
  const step = async () => {
    const v = await ctx.advance();
    stages.push(v.stage);
    assert.notEqual(v.state, 'confirmed');
    assert.equal(v.erc8004AgentId, null);
    return v;
  };
  await provisional(ctx);
  chain.include(H(X), { tx: '0xb1', block: 101 }, 'safe');
  chain.depth(R(0), 'safe');
  assert.equal((await step()).stage, 'registered');
  // The mint's depth drops back (same receipt, same hash): finalizing.
  chain.depth(R(0), 'included');
  assert.equal((await step()).stage, 'finalizing');
  chain.depth(R(0), 'safe');
  assert.equal((await step()).stage, 'registered');
  // The mint is reorged out: rechecking, the provisional id is no longer shown.
  chain.lose(R(0));
  const lost = await step();
  assert.equal(lost.stage, 'rechecking');
  assert.equal(lost.provisionalAgentId, null);
  chain.include(R(0), mintOf(), 'safe');
  assert.equal((await step()).stage, 'registered');
  // The hand-over is reorged out: back to handing over (its key is kept and reconciled).
  chain.lose(H(X));
  assert.equal((await step()).stage, 'handing_over');
  assert.equal((await ctx.row()).handover_finality, null);
  chain.include(H(X), { tx: '0xb2', block: 103 }, 'safe');
  assert.equal((await step()).stage, 'registered');
  assert.deepEqual(chain.signedKeys(), { [R(0)]: 1, [H(X)]: 1 });
});

/* ---------------------------------------------------------------------------------------------
 * D2: receipts are bound by block hash (same-height reorgs).
 * ------------------------------------------------------------------------------------------- */

test('D2: the same tx at the same height in another block is a new receipt (owner read again)', async (t) => {
  const ctx = await setup(t);
  const { chain } = ctx;
  await provisional(ctx);
  assert.equal((await ctx.row()).mint_block_hash, hashOf(100, '0xa1'));
  const ZERO = `0x${'0'.repeat(40)}`;
  // Final at the same number with another hash: never promoted as "the same receipt".
  chain.finalize(R(0), { blockHash: '0xsameheightother', owner: ZERO });
  const refused = await ctx.advance();
  assert.equal(refused.erc8004AgentId, null);
  assert.equal(refused.stage, 'rechecking');
  assert.ok(
    ctx.logs.some((e) => e.event === 'identity.evidence_mismatch' && e.code === 'owner_mismatch'),
  );
  let r = await ctx.row();
  assert.equal(r.erc8004_agent_id, null);
  assert.equal(r.mint_block_hash, hashOf(100, '0xa1'));
  // The new block's receipt with a verified owner binds, by its own hash.
  chain.finalize(R(0), { blockHash: '0xsameheightother', owner: SPENDER });
  const bound = await ctx.advance();
  assert.equal(bound.erc8004AgentId, '99029');
  r = await ctx.row();
  assert.equal(r.mint_block_hash, '0xsameheightother');
  assert.equal(r.mint_block, '100');
  assert.equal(r.mint_finality, 'final');
});

test('D2: an included mint promoted to safe in the same block needs no new owner read', async (t) => {
  const ctx = await setup(t);
  const { chain } = ctx;
  await provisional(ctx);
  const rev = (await ctx.row()).evidence_rev;
  // Same tx and hash; the owner already moved to the wallet (the hand-over executed).
  chain.include(R(0), mintOf({ owner: WALLET }), 'safe');
  const v = await ctx.advance();
  assert.equal(v.provisionalAgentId, '99029');
  const r = await ctx.row();
  assert.equal(r.mint_finality, 'safe');
  assert.equal(Number(r.evidence_rev), Number(rev) + 1);
  assert.equal(r.mint_lost_at, null);
});

/* ---------------------------------------------------------------------------------------------
 * M4 (+D2): a reverted hand-over never counts; "executed before the re-included mint" uses the
 * reverted marker, and at the same height the block hashes.
 * ------------------------------------------------------------------------------------------- */

test('M4: a reverted hand-over inclusion is never recorded as handed over', async (t) => {
  const ctx = await setup(t);
  const { chain } = ctx;
  await provisional(ctx, mintOf({ block: 100 }));
  chain.depth(R(0), 'safe');
  chain.include(H(X), { tx: '0xb1', block: 101, reverted: true }, 'safe');
  const v = await ctx.advance();
  assert.equal(v.stage, 'handing_over', 'never finalizing or registered on a revert');
  let r = await ctx.row();
  assert.equal(r.handover_tx_hash, null);
  assert.equal(r.handover_finality, null);
  // Its failure is final AFTER the mint: a real failure, the owner decides.
  chain.fail(H(X), 101);
  chain.finalize(R(0));
  const failed = await ctx.advance();
  assert.equal(failed.state, 'failed');
  r = await ctx.row();
  assert.equal(r.handover_tx_hash, null);
  assert.deepEqual(chain.signedKeys(), { [R(0)]: 1, [H(X)]: 1 });
});

const sameHeight: Array<
  [string, { blockHash?: string | null; reverted?: boolean }, 'rebound' | 'failed' | 'held']
> = [
  [
    'reverted in the same block before the mint: replaced once',
    { blockHash: hashOf(100, '0xa1') },
    'rebound',
  ],
  ['same height, another block: nothing concluded', { blockHash: '0xotherblock100' }, 'held'],
  // The port could not prove the block (read error, or not canonical): no evidence, hold.
  ['same height, hand-over block hash unknown: held, never replaced', { blockHash: null }, 'held'],
  [
    'same block but not reverted (never executed): failed',
    { blockHash: hashOf(100, '0xa1'), reverted: false },
    'failed',
  ],
];
for (const [name, failure, outcome] of sameHeight) {
  test(`M4: a hand-over failed at the mint's height, ${name}`, async (t) => {
    const ctx = await setup(t);
    const { chain } = ctx;
    await provisional(ctx, mintOf({ tx: '0xa0', block: 80 }));
    chain.lose(R(0));
    await ctx.advance();
    chain.include(R(0), mintOf({ tx: '0xa1', block: 100 }));
    chain.fail(H(X), 100, failure);
    const waiting = await ctx.advance();
    assert.equal(waiting.state, 'submitted', 'not decided while the register op is not final');
    chain.finalize(R(0));
    const v = await ctx.advance();
    const r = await ctx.row();
    if (outcome === 'rebound') {
      assert.equal(v.state, 'submitted');
      assert.equal(r.transfer_op_id, H(X, 1));
      await ctx.advance();
      assert.equal(chain.signs.get(H(X, 1)), 1);
    } else if (outcome === 'held') {
      assert.equal(v.state, 'submitted');
      assert.equal(r.transfer_op_id, H(X));
      assert.ok(ctx.logs.some((e) => e.event === 'identity.handover_block_conflict'));
      await ctx.advance();
      assert.equal(chain.signs.get(H(X, 1)), undefined, 'never a new hand-over on numbers alone');
    } else {
      assert.equal(v.state, 'failed');
      assert.equal(r.transfer_op_id, H(X));
      assert.equal(chain.signs.get(H(X, 1)), undefined);
    }
  });
}

/* ---------------------------------------------------------------------------------------------
 * D3: the owner's retry only selects the next attempt key; time never authorizes a fresh nonce.
 * ------------------------------------------------------------------------------------------- */

test('D3: the 30-minute retry goes through register() with the next attempt key only', async (t) => {
  const ctx = await setup(t);
  const { chain } = ctx;
  await provisional(ctx);
  chain.lose(R(0));
  await ctx.advance();
  const lostAt = Number((await ctx.row()).mint_lost_at);
  const registers = chain.registerInputs.length;
  ctx.clock.at = lostAt + LOST_RETRY_MS - 1;
  await ctx.advance({ retry: true });
  assert.equal(chain.registerInputs.length, registers, 'the gate holds before 30 minutes');
  ctx.clock.at = lostAt + LOST_RETRY_MS;
  const transfers = chain.calls.transfer.length;
  await ctx.advance({ retry: true });
  const sent = chain.registerInputs.slice(registers);
  // Exactly the declared fields: no 'force', no nonce or replacement hint. The port's
  // replacing() pins the nonce of any non-terminal signed sibling (R(0) here).
  assert.deepEqual(sent, [
    {
      operationKey: R(1),
      chainId: CHAIN,
      uri: await svcUri(ctx),
      spenderKeyRef: 'v1:k',
      spender: SPENDER,
    },
  ]);
  for (const input of chain.registerInputs)
    assert.deepEqual(Object.keys(input).sort(), [
      'chainId',
      'operationKey',
      'spender',
      'spenderKeyRef',
      'uri',
    ]);
  assert.equal(chain.calls.transfer.length, transfers, 'a retry sends no hand-over');
  // A second press right away is not a retry (the gate is closed again).
  const again = await ctx.advance({ retry: true });
  assert.equal(again.canRetry, false);
  assert.deepEqual(chain.calls.register.slice(-2), [R(1), R(1)]);
  assert.equal((await ctx.row()).register_op_id, R(1));
});

/* ---------------------------------------------------------------------------------------------
 * A mint fenced at 'included' and never verified is never a dead end.
 * ------------------------------------------------------------------------------------------- */

const neverVerified: Array<[string, (ctx: Ctx) => Promise<MintObservation>]> = [
  ['the receipt is reorged out before the first read', async () => ({ kind: 'pending' })],
  [
    "the port's receipt lacks a block hash (bad_receipt)",
    async (ctx) => ({
      kind: 'minted',
      opKey: R(0),
      status: 'included',
      txHash: '0xa1',
      blockNumber: '100',
      blockHash: '',
      id: X.toString(10),
      registry: REGISTRY,
      tokenUri: await svcUri(ctx),
      owner: SPENDER,
    }),
  ],
  [
    "the port's id is not a decimal string (bad_id)",
    async (ctx) => ({
      kind: 'minted',
      opKey: R(0),
      status: 'included',
      txHash: '0xa1',
      blockNumber: '100',
      blockHash: `0x${'ab'.repeat(32)}`,
      id: '0x182d5',
      registry: REGISTRY,
      tokenUri: await svcUri(ctx),
      owner: SPENDER,
    }),
  ],
];
for (const [name, first] of neverVerified) {
  test(`a fenced mint never verified opens the 30-minute retry: ${name}`, async (t) => {
    const ctx = await setup(t);
    const { chain } = ctx;
    await ctx.advance();
    chain.include(R(0), mintOf());
    const observation = await first(ctx);
    chain.evidenceQueue.push(() => observation);
    const fenced = await ctx.advance();
    assert.equal(fenced.stage, 'registering', 'never verified: still registering');
    assert.equal(fenced.provisionalAgentId, null);
    assert.equal(fenced.canRetry, false);
    let r = await ctx.row();
    assert.equal(r.mint_op_id, R(0));
    // The fence stored the tx, so the stuck-before-mint gate (R2) can never apply here.
    const { rows } = await ctx.db.query<{ tx_hash: string | null }>(
      "SELECT tx_hash FROM base_identities WHERE agent_id = 'a1'",
    );
    assert.equal(rows[0].tx_hash, '0xa1');
    assert.equal(r.mint_seen_at, null);
    const lostAt = Number(r.mint_lost_at);
    assert.equal(lostAt, ctx.clock.at, 'the ambiguity clock starts at the fence');
    chain.lose(R(0));
    assert.deepEqual(chain.calls.register, [R(0), R(0)]);

    // Before 30 minutes: no retry, and register() is not called again.
    ctx.clock.at = lostAt + LOST_RETRY_MS - 1;
    const early = await ctx.advance({ retry: true });
    assert.equal(early.canRetry, false);
    assert.equal(early.state, 'submitted');
    assert.deepEqual(chain.calls.register, [R(0), R(0)]);
    assert.equal(Number((await ctx.row()).mint_lost_at), lostAt, 'the clock is not reset');

    // After 30 minutes the owner may retry: one register() call, with the next attempt key only.
    ctx.clock.at = lostAt + LOST_RETRY_MS;
    assert.equal((await ctx.advance()).canRetry, true);
    const registers = chain.registerInputs.length;
    const retried = await ctx.advance({ retry: true });
    assert.equal(retried.canRetry, false);
    assert.equal(retried.stage, 'registering');
    assert.deepEqual(chain.registerInputs.slice(registers), [
      {
        operationKey: R(1),
        chainId: CHAIN,
        uri: await svcUri(ctx),
        spenderKeyRef: 'v1:k',
        spender: SPENDER,
      },
    ]);
    r = await ctx.row();
    assert.equal(r.register_op_id, R(1));
    assert.equal(r.op_id, R(1));
    assert.equal(r.mint_op_id, null);
    assert.equal(r.mint_lost_at, null);
    assert.equal(chain.calls.transfer.length, 0, 'nothing was ever handed over');
    assert.deepEqual(chain.signedKeys(), { [R(0)]: 1, [R(1)]: 1 });
  });
}

/* ---------------------------------------------------------------------------------------------
 * M3: evidence is read by the newest attempt after a register retry.
 * ------------------------------------------------------------------------------------------- */

test('M3: after a register retry the evidence is read by the newest attempt and finds its mint', async (t) => {
  const ctx = await setup(t);
  const { chain } = ctx;
  await provisional(ctx);
  chain.lose(R(0));
  await ctx.advance();
  ctx.clock.at += LOST_RETRY_MS;
  // The first attempt lands again on the pinned nonce and is what register(R(1)) reports.
  chain.reportAs.set(R(1), R(0));
  chain.include(R(0), mintOf({ tx: '0xa5', block: 150 }));
  const retried = await ctx.advance({ retry: true });
  assert.equal(retried.provisionalAgentId, '99029');
  let r = await ctx.row();
  assert.equal(r.mint_op_id, R(0), 'mint_op_id is the key that landed');
  assert.equal(r.register_op_id, R(1));
  const evidenceFrom = chain.calls.evidence.length;
  // That mint is reorged out and the replacement attempt R(1) lands instead (another id).
  chain.lose(R(0));
  chain.reportAs.delete(R(1));
  assert.equal((await ctx.advance()).stage, 'rechecking');
  chain.include(R(1), mintOf({ tx: '0xc1', block: 160, id: 555n }));
  const moved = await ctx.advance();
  assert.equal(moved.provisionalAgentId, '555');
  r = await ctx.row();
  assert.equal(r.mint_op_id, R(1));
  assert.ok(chain.calls.evidence.slice(evidenceFrom).every((key) => key === R(1)));
  assert.equal(r.transfer_op_id, H(555n));
  assert.deepEqual(chain.calls.register, [R(0), R(0), R(1)], 'register() is never called again');
});

/* ---------------------------------------------------------------------------------------------
 * D4: before 'confirmed', the destination is checked at the finalized block (fast path).
 * ------------------------------------------------------------------------------------------- */

/** Both operations final; the next advance decides 'confirmed'. */
async function bothFinal(ctx: Ctx) {
  await provisional(ctx);
  ctx.chain.include(H(X), { tx: '0xb1', block: 101 });
  ctx.chain.finalize(H(X));
  ctx.chain.finalize(R(0));
}

test("D4: the pre-send spender check is the port's; it never confirms anything", async (t) => {
  const ctx = await setup(t);
  const { chain } = ctx;
  await ctx.advance();
  chain.include(R(0), mintOf());
  chain.finalize(R(0));
  chain.transferError = Object.assign(new Error('not held'), { code: 'IDENTITY_NOT_HELD' });
  for (let i = 0; i < 2; i++) {
    const v = await ctx.advance();
    assert.equal(v.state, 'submitted');
    assert.equal(v.erc8004AgentId, '99029');
    assert.equal(v.stage, 'handing_over');
  }
  assert.equal(chain.calls.identityAt.length, 0, 'no destination read before a final hand-over');
  assert.ok(chain.calls.transfer.every((key) => key === H(X)));
  chain.transferError = null;
  await ctx.advance();
  assert.equal(chain.signs.get(H(X)), 1);
});

const destinations: Array<[string, Record<string, string>, string]> = [
  ['the owner is another wallet', { owner: STRANGER }, 'owner_mismatch'],
  ['tokenURI is another agent', { tokenUri: 'https://centralcity.ai/a/zzzzzz' }, 'uri_mismatch'],
  [
    'the wallet holds it only at latest, not at the finalized block',
    { owner: SPENDER },
    'owner_mismatch',
  ],
  ['the finalized read is behind the hand-over', { blockNumber: '100' }, 'evidence_behind'],
];
for (const [name, view, code] of destinations) {
  test(`D4: destination check before confirmed: ${name}`, async (t) => {
    const ctx = await setup(t);
    const { chain } = ctx;
    await bothFinal(ctx);
    chain.finalizedView.set(X, view);
    for (let i = 0; i < 2; i++) {
      const v = await ctx.advance();
      assert.equal(v.state, 'submitted', 'a mismatch is never terminal');
      assert.equal(v.stage, 'rechecking');
      assert.equal(v.pollAfterMs, 5000);
      assert.equal(v.erc8004AgentId, '99029');
    }
    assert.ok(ctx.logs.some((e) => e.event === 'identity.destination_mismatch' && e.code === code));
    assert.equal((await ctx.row()).destination_mismatch, code);
    assert.deepEqual(chain.calls.identityAt.at(-1), { id: X, blockTag: 'finalized' });
    // The finalized block catches up with the truth: confirmed, nothing sent again.
    chain.finalizedView.delete(X);
    const done = await ctx.advance();
    assert.equal(done.state, 'confirmed');
    const r = await ctx.row();
    assert.equal(r.destination_mismatch, null);
    assert.equal(r.owner_of_identity, WALLET);
    assert.deepEqual(chain.signedKeys(), { [R(0)]: 1, [H(X)]: 1 });
  });
}

test('D4: no destination evidence, no confirmation (read unavailable, or port without it)', async (t) => {
  const ctx = await setup(t);
  const { chain } = ctx;
  await bothFinal(ctx);
  chain.identityAtError = new Error('rpc down');
  const down = await ctx.advance();
  assert.equal(down.state, 'submitted');
  assert.equal(down.stage, 'registered', 'nothing concluded: no recheck either');
  assert.equal((await ctx.row()).destination_mismatch, null);
  chain.identityAtError = null;
  chain.withIdentityAt = false;
  const missing = await ctx.advance();
  assert.equal(missing.state, 'submitted');
  assert.ok(
    ctx.logs.some(
      (e) => e.event === 'identity.destination_unavailable' && e.code === 'not_supported',
    ),
  );
  chain.withIdentityAt = true;
  assert.equal((await ctx.advance()).state, 'confirmed');
});

/* ---------------------------------------------------------------------------------------------
 * M1 / M2: rows written before migration 85 (the legacy, final-only flow).
 * ------------------------------------------------------------------------------------------- */

const LEGACY_SHORT = 'abc123';
const legacyRow = (state: string, opId: string, txHash: string | null) => async (db: Database) => {
  await db.query("INSERT INTO base_short_ids VALUES ($1, 'a1', 1)", [LEGACY_SHORT]);
  await db.query(
    `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address,
         erc8004_agent_id, agent_card_uri, owner_of_identity, state, op_id, tx_hash, updated_at)
       VALUES ('a1', $1, 'ws', $2, $3, $4, $5, $6, $7, $8, 50)`,
    [CHAIN, REGISTRY, X.toString(), shortAgentUri(LEGACY_SHORT), SPENDER, state, opId, txHash],
  );
};

for (const [name, opId] of [
  ['op_id is the legacy transfer key', transferKey('a1', CHAIN)],
  ['op_id is still the register key (crash after the hand-over was stored)', R(0)],
] as const) {
  test(`M2: a legacy in-flight hand-over is only reconciled, never re-signed (${name})`, async (t) => {
    const legacy = transferKey('a1', CHAIN);
    const ctx = await setup(t, { beforeMigration85: legacyRow('submitted', opId, '0xb0') });
    const { chain } = ctx;
    // Stored in the port before the deploy (signed then, on its own nonce lane).
    chain.ops.set(legacy, { idempotencyKey: legacy, status: 'submitted', txHash: null });
    chain.intents.set(legacy, X);
    chain.destinations.set(legacy, WALLET);
    chain.uri = shortAgentUri(LEGACY_SHORT);
    const first = await ctx.advance();
    assert.equal(first.stage, 'handing_over');
    assert.equal(first.erc8004AgentId, '99029');
    const r = await ctx.row();
    assert.equal(r.transfer_op_id, legacy);
    assert.equal(r.op_id, legacy);
    chain.include(legacy, { tx: '0xb1', block: 50 });
    assert.equal((await ctx.advance()).stage, 'finalizing');
    chain.finalize(legacy);
    assert.equal((await ctx.advance()).state, 'confirmed');
    assert.ok(
      chain.calls.transfer.every((key) => key === legacy),
      chain.calls.transfer.join(),
    );
    assert.deepEqual(chain.signedKeys(), {}, 'nothing signed: no second hand-over');
    assert.equal(chain.calls.register.length, 0);
    assert.equal(chain.calls.evidence.length, 0);
    assert.equal((await basePassport(ctx.db, 'a1'))?.erc8004AgentId, '99029');
  });
}
