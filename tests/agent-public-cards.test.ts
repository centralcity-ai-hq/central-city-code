import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Fastify from 'fastify';
import type { Database } from '../server/database.js';
import { BASE_MAINNET } from '../shared/base/chains.js';
import {
  PUBLIC_NAME,
  createOnBaseStore,
  publicManifestsOf,
} from '../server/base/explorer/store.js';
import {
  PUBLIC_CARDS_BACKFILL_PATH,
  backfillPublicCards,
  cursorPosition,
  registerPublicCardsCron,
} from '../server/agent-rows/public-cards.js';
import { add, agentId, setup } from './on-base-fixture.js';

/*
 * agent_public_cards (migration 280): every agent's current public name as one row, kept by the
 * database on every workspace and manifest write, answering exactly as the card route's rule read
 * from the workspace document (PUBLIC_NAME before the table, still used until it is backfilled).
 */

const IDS = Array.from({ length: 12 }, (_, i) => agentId(i + 1));

async function setReady(db: Database, ready: boolean) {
  await db.query('UPDATE agent_public_cards_backfill SET ready = $1 WHERE id = 1', [ready]);
}

/** Names by the table (ready) and by the workspace documents (not ready), for every id. */
async function names(db: Database) {
  const read = async () =>
    (
      await db.query<{ agent_id: string; name: string | null; manifest: unknown }>(
        `WITH l AS (SELECT unnest($1::text[]) AS agent_id),
         pm AS (${publicManifestsOf('SELECT agent_id FROM l')})
         SELECT l.agent_id, p.name, pm.manifest FROM l ${PUBLIC_NAME}
         LEFT JOIN pm ON pm.agent_id = l.agent_id ORDER BY l.agent_id`,
        [IDS],
      )
    ).rows;
  const table = await read();
  await setReady(db, false);
  const documents = await read();
  await setReady(db, true);
  return { table, documents };
}

async function assertSame(db: Database, expected: Record<number, string | null>) {
  const { table, documents } = await names(db);
  assert.deepEqual(table, documents, 'the table answers as the workspace documents');
  assert.deepEqual(
    Object.fromEntries(
      table.flatMap((row, i) =>
        row.name === null && !(i + 1 in expected) ? [] : [[i + 1, row.name]],
      ),
    ),
    Object.fromEntries(Object.entries(expected).map(([n, name]) => [Number(n), name])),
  );
}

/** A new manifest revision named `name` and the workspace pointing at it (a rename). */
async function rename(db: Database, n: number, name: string, visibility = 'public') {
  await db.transaction(async (tx) => {
    const { rows } = await tx.query<{ revision: number }>(
      'SELECT max(revision) AS revision FROM agent_manifests WHERE agent_id = $1',
      [agentId(n)],
    );
    const revision = Number(rows[0]!.revision) + 1;
    await tx.query(`INSERT INTO agent_manifests VALUES ($1, $2, 'h', $3, 1, 'ws')`, [
      agentId(n),
      revision,
      JSON.stringify({ metadata: { name: `agent-${n}`, displayName: name }, spec: { visibility } }),
    ]);
    await tx.query(
      `UPDATE workspaces SET data = jsonb_set(data, '{agents}', (
         SELECT jsonb_agg(CASE WHEN a->>'id' = $1 THEN jsonb_set(a, '{revision}', to_jsonb($2::int))
                               ELSE a END ORDER BY o)
         FROM jsonb_array_elements(data->'agents') WITH ORDINALITY e(a, o)))
       WHERE operator_id = 'ws'`,
      [agentId(n), revision],
    );
  });
}

test('the table follows every write that changes a public name, as the documents answer', async (t) => {
  const db = await setup(t);
  for (let n = 1; n <= 6; n += 1) await add(db, { n, kind: 'final', id: 100 + n });
  await add(db, { n: 7, kind: 'final', id: 107, name: 'Hidden', visibility: 'private' });
  await add(db, { n: 8, kind: 'final', id: 108, name: 'Gone', revoked: true });
  await add(db, { n: 9, kind: 'final', id: 109, name: '  ' });
  await assertSame(db, {
    1: 'Agent 1',
    2: 'Agent 2',
    3: 'Agent 3',
    4: 'Agent 4',
    5: 'Agent 5',
    6: 'Agent 6',
  });

  // Renamed, made private, made public again.
  await rename(db, 1, 'Harbor');
  await rename(db, 2, 'Agent 2', 'private');
  await rename(db, 7, 'Shown');
  await assertSame(db, {
    1: 'Harbor',
    3: 'Agent 3',
    4: 'Agent 4',
    5: 'Agent 5',
    6: 'Agent 6',
    7: 'Shown',
  });

  // Revoked, and removed from the array.
  await db.query(
    `UPDATE workspaces SET data = jsonb_set(data, '{agents}', (
       SELECT jsonb_agg(CASE WHEN a->>'id' = $1 THEN jsonb_set(a, '{revokedAt}', '"2026-10-02T00:00:00.000Z"')
                             ELSE a END ORDER BY o)
       FROM jsonb_array_elements(data->'agents') WITH ORDINALITY e(a, o)
       WHERE a->>'id' <> $2))
     WHERE operator_id = 'ws'`,
    [agentId(3), agentId(4)],
  );
  await assertSame(db, { 1: 'Harbor', 5: 'Agent 5', 6: 'Agent 6', 7: 'Shown' });

  // The same id again in front: the first one decides (revoked).
  await db.query(
    `UPDATE workspaces SET data = jsonb_set(data, '{agents}',
       jsonb_build_array(jsonb_build_object('id', $1::text, 'revision', 1,
         'revokedAt', '2026-10-01T00:00:00.000Z')) || (data->'agents'))
     WHERE operator_id = 'ws'`,
    [agentId(5)],
  );
  await assertSame(db, { 1: 'Harbor', 6: 'Agent 6', 7: 'Shown' });

  // A write that changes nothing the rule reads leaves every row.
  await db.query(
    `UPDATE workspaces SET data = jsonb_set(data, '{agents}', (
       SELECT jsonb_agg(a || '{"announcedOnline": true}'::jsonb ORDER BY o)
       FROM jsonb_array_elements(data->'agents') WITH ORDINALITY e(a, o)))
     WHERE operator_id = 'ws'`,
  );
  await assertSame(db, { 1: 'Harbor', 6: 'Agent 6', 7: 'Shown' });

  // A manifest written after the workspace that already points at it (caught at commit).
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE workspaces SET data = jsonb_set(data, '{agents}', (data->'agents') ||
         jsonb_build_array(jsonb_build_object('id', $1::text, 'revision', 1, 'revokedAt', null)))
       WHERE operator_id = 'ws'`,
      [agentId(10)],
    );
    await tx.query(`INSERT INTO agent_manifests VALUES ($1, 1, 'h', $2, 1, 'ws')`, [
      agentId(10),
      JSON.stringify({
        metadata: { name: 'agent-10', displayName: 'Late' },
        spec: { visibility: 'public' },
      }),
    ]);
  });
  await assertSame(db, { 1: 'Harbor', 6: 'Agent 6', 7: 'Shown', 10: 'Late' });

  // Claimed into another workspace: manifests move, then both workspaces are written.
  await db.query(`INSERT INTO operators VALUES ('ws2')`);
  await db.query(`INSERT INTO workspaces VALUES ('ws2', '{"agents": []}')`);
  await db.transaction(async (tx) => {
    await tx.query(`UPDATE agent_manifests SET operator_id = 'ws2' WHERE agent_id = $1`, [
      agentId(6),
    ]);
    const { rows } = await tx.query<{ a: unknown }>(
      `SELECT a FROM workspaces, jsonb_array_elements(data->'agents') a
       WHERE operator_id = 'ws' AND a->>'id' = $1`,
      [agentId(6)],
    );
    await tx.query(
      `UPDATE workspaces SET data = jsonb_set(data, '{agents}', COALESCE((
         SELECT jsonb_agg(a ORDER BY o) FROM jsonb_array_elements(data->'agents') WITH ORDINALITY e(a, o)
         WHERE a->>'id' <> $1), '[]'::jsonb)) WHERE operator_id = 'ws'`,
      [agentId(6)],
    );
    await tx.query(
      `UPDATE workspaces SET data = jsonb_set(data, '{agents}', (data->'agents') || jsonb_build_array($1::jsonb))
       WHERE operator_id = 'ws2'`,
      [JSON.stringify(rows[0]!.a)],
    );
  });
  await assertSame(db, { 1: 'Harbor', 6: 'Agent 6', 7: 'Shown', 10: 'Late' });
  assert.equal(
    (
      await db.query<{ operator_id: string }>(
        'SELECT operator_id FROM agent_public_cards WHERE agent_id = $1',
        [agentId(6)],
      )
    ).rows[0]!.operator_id,
    'ws2',
  );

  // The workspace deleted: its agents have no card.
  await db.query(`DELETE FROM workspaces WHERE operator_id = 'ws2'`);
  await assertSame(db, { 1: 'Harbor', 7: 'Shown', 10: 'Late' });

  // Its manifests deleted: no card either.
  await db.query('DELETE FROM agent_manifests WHERE agent_id = $1', [agentId(10)]);
  await assertSame(db, { 1: 'Harbor', 7: 'Shown' });
});

test('in rows mode the agents table keeps the cards', async (t) => {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 101, name: 'Rowan' });
  await add(db, { n: 2, kind: 'final', id: 102, name: 'Sable' });
  // The workspace's agents move to rows (as the switch does), then change there only.
  await db.query(
    `INSERT INTO agents (operator_id, agent_id, ordinal, agent)
     SELECT 'ws', a->>'id', o, a FROM workspaces, jsonb_array_elements(data->'agents') WITH ORDINALITY e(a, o)
     WHERE operator_id = 'ws'`,
  );
  await db.query(`INSERT INTO workspace_storage VALUES ('ws', 'rows', 1)`);
  await db.query(
    `UPDATE workspaces SET data = jsonb_set(data, '{agents}', '[]') WHERE operator_id = 'ws'`,
  );
  await assertSame(db, { 1: 'Rowan', 2: 'Sable' });
  await db.query(
    `UPDATE agents SET agent = jsonb_set(agent, '{revokedAt}', '"2026-10-02T00:00:00.000Z"') WHERE agent_id = $1`,
    [agentId(1)],
  );
  await db.query('DELETE FROM agents WHERE agent_id = $1', [agentId(2)]);
  await assertSame(db, {});
});

test('agents from before the table are backfilled; until then the documents answer', async (t) => {
  const db = await setup(t);
  for (let n = 1; n <= 9; n += 1)
    await add(db, { n, kind: 'final', id: 100 + n, name: `Pier ${n}` });
  await db.query(`INSERT INTO operators VALUES ('ws2'), ('ws3')`);
  await db.query(
    `INSERT INTO workspaces VALUES ('ws2', '{"agents": []}'), ('ws3', '{"agents": []}')`,
  );
  // As the migration finds a database with manifests: nothing in the table, not ready.
  await db.query('DELETE FROM agent_public_cards');
  await db.query('UPDATE agent_public_cards_backfill SET ready = false, after_operator = NULL');
  const store = createOnBaseStore(db, { chainId: BASE_MAINNET });
  // Until then: a name finds only what the table holds and says so; an id finds its agent with
  // its name from the documents; the list reads the documents.
  const before = await store.list({ q: 'Pier' });
  assert.equal(before.items.length, 0);
  assert.equal(before.incomplete, true);
  assert.deepEqual(
    (await store.list({ q: '103' })).items.map((item) => item.row.name),
    ['Pier 3'],
  );
  assert.equal((await store.list({})).items[0]!.row.name, 'Pier 9');

  // Runs walk ws, then pass the empty ws2 and ws3 and find none left: ready.
  assert.deepEqual(await backfillPublicCards(db, { maxWorkspaces: 1 }), {
    ready: false,
    workspaces: 1,
    skipped: 0,
  });
  assert.equal(
    Number(
      (await db.query<{ n: string }>('SELECT count(*) AS n FROM agent_public_cards')).rows[0]!.n,
    ),
    9,
  );
  assert.deepEqual(await backfillPublicCards(db, { maxWorkspaces: 2 }), {
    ready: true,
    workspaces: 0,
    skipped: 2,
  });
  assert.deepEqual(await backfillPublicCards(db), { ready: true, workspaces: 0, skipped: 0 });
  const after = await store.list({ q: 'Pier' });
  assert.deepEqual(
    after.items.map((item) => item.row.name),
    Array.from({ length: 9 }, (_, i) => `Pier ${9 - i}`),
  );
  assert.equal(after.incomplete, undefined);
});

/** Counts reads of a workspace document (workspace_agent / workspace_agents calls). */
async function countReads(db: Database) {
  await db.exec(`
    CREATE OR REPLACE FUNCTION workspace_agent(ws text, doc jsonb, aid text) RETURNS jsonb
    LANGUAGE plpgsql STABLE AS $$
    BEGIN
      PERFORM set_config('test.reads',
        (COALESCE(NULLIF(current_setting('test.reads', true), ''), '0')::int + 1)::text, false);
      RETURN jsonb_path_query_first(doc->'agents', '$[*] ? (@.id == $id)',
        jsonb_build_object('id', aid));
    END $$;
    CREATE OR REPLACE FUNCTION workspace_agents(ws text, doc jsonb)
    RETURNS TABLE(ordinal bigint, agent jsonb) LANGUAGE plpgsql STABLE AS $$
    BEGIN
      PERFORM set_config('test.reads',
        (COALESCE(NULLIF(current_setting('test.reads', true), ''), '0')::int + 1)::text, false);
      RETURN QUERY SELECT e.ordinal, e.agent
        FROM jsonb_array_elements(doc->'agents') WITH ORDINALITY AS e(agent, ordinal);
    END $$;
    SELECT set_config('test.reads', '0', false);`);
  return async () =>
    Number(
      (
        await db.query<{ n: string }>(
          `SELECT COALESCE(NULLIF(current_setting('test.reads', true), ''), '0') AS n`,
        )
      ).rows[0]!.n,
    );
}

test('public reads find names without reading any workspace document', async (t) => {
  const db = await setup(t);
  for (let n = 1; n <= 20; n += 1) await add(db, { n, kind: 'final', id: 100 + n });
  await rename(db, 7, 'Meridian');
  const reads = await countReads(db);
  const store = createOnBaseStore(db, { chainId: BASE_MAINNET });
  assert.equal((await store.list({})).items.length, 20);
  assert.equal((await store.list({ q: 'Agent' })).items.length, 19);
  assert.deepEqual(
    (await store.list({ q: 'ridia' })).items.map((item) => item.row.name),
    ['Meridian'],
  );
  // A former name no longer finds the agent; a base id still does, with its current name.
  assert.equal((await store.list({ q: 'Agent 7' })).items.length, 0);
  assert.deepEqual(
    (await store.list({ q: '107' })).items.map((item) => item.row.name),
    ['Meridian'],
  );
  assert.equal((await store.passport('107'))?.passport.name, 'Meridian');
  assert.equal(await reads(), 0);
});

test('the backfill runs from its cron, every minute, only with the cron secret', async (t) => {
  const db = await setup(t);
  const app = Fastify();
  t.after(() => app.close());
  const secret = 's'.repeat(32);
  registerPublicCardsCron(app, { db, cronSecret: secret });
  assert.equal((await app.inject({ url: PUBLIC_CARDS_BACKFILL_PATH })).statusCode, 404);
  const res = await app.inject({
    url: PUBLIC_CARDS_BACKFILL_PATH,
    headers: { authorization: `Bearer ${secret}` },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ready: true, workspaces: 0, skipped: 0 });
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
    crons: Array<{ path: string; schedule: string }>;
  };
  assert.deepEqual(
    config.crons.filter((cron) => cron.path === PUBLIC_CARDS_BACKFILL_PATH),
    [{ path: PUBLIC_CARDS_BACKFILL_PATH, schedule: '* * * * *' }],
  );
});

type AgentRecord = { id: string; revision?: number | null; revokedAt?: string | null } & Record<
  string,
  unknown
>;

async function agentsOf(db: Database) {
  return (
    await db.query<{ agents: AgentRecord[] }>(
      `SELECT data->'agents' AS agents FROM workspaces WHERE operator_id = 'ws'`,
    )
  ).rows[0]!.agents;
}

async function writeAgents(db: Database, agents: AgentRecord[]) {
  await db.query(
    `UPDATE workspaces SET data = jsonb_set(data, '{agents}', $1::jsonb) WHERE operator_id = 'ws'`,
    [JSON.stringify(agents)],
  );
}

const live = (n: number, revision = 1): AgentRecord => ({
  id: agentId(n),
  revision,
  revokedAt: null,
});
const revoked = (n: number, revision = 1): AgentRecord => ({
  id: agentId(n),
  revision,
  revokedAt: '2026-10-01T00:00:00.000Z',
});

test('records of one agent reordered: the first one decides, in both directions', async (t) => {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 101, name: 'Lantern' });
  await add(db, { n: 2, kind: 'final', id: 102, formerNames: ['Old Quay'], name: 'New Quay' });
  await add(db, { n: 3, kind: 'final', id: 103, name: 'Third' });

  // The same revision in both records.
  await writeAgents(db, [live(1), revoked(1), live(3)]);
  await assertSame(db, { 1: 'Lantern', 3: 'Third' });
  await writeAgents(db, [revoked(1), live(1), live(3)]);
  await assertSame(db, { 3: 'Third' });
  await writeAgents(db, [live(1), revoked(1), live(3)]);
  await assertSame(db, { 1: 'Lantern', 3: 'Third' });

  // Different revisions in the two records.
  await writeAgents(db, [live(1), live(2, 2), revoked(2, 1), live(3)]);
  await assertSame(db, { 1: 'Lantern', 2: 'New Quay', 3: 'Third' });
  await writeAgents(db, [live(1), revoked(2, 1), live(2, 2), live(3)]);
  await assertSame(db, { 1: 'Lantern', 3: 'Third' });
  await writeAgents(db, [live(1), live(2, 2), revoked(2, 1), live(3)]);
  await assertSame(db, { 1: 'Lantern', 2: 'New Quay', 3: 'Third' });

  // Both live, at different revisions: the first one's name.
  await writeAgents(db, [live(1), live(2, 1), live(2, 2), live(3)]);
  await assertSame(db, { 1: 'Lantern', 2: 'Old Quay', 3: 'Third' });
  await writeAgents(db, [live(1), live(2, 2), live(2, 1), live(3)]);
  await assertSame(db, { 1: 'Lantern', 2: 'New Quay', 3: 'Third' });
});

test('a duplicate record removed or inserted in the middle refreshes its agent', async (t) => {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 101, name: 'Lantern' });
  await add(db, { n: 2, kind: 'final', id: 102, name: 'Beacon' });

  // The first record removed: the next one with the id decides (revoked).
  await writeAgents(db, [live(1), live(2), revoked(1), live(1)]);
  await assertSame(db, { 1: 'Lantern', 2: 'Beacon' });
  await writeAgents(db, [live(2), revoked(1), live(1)]);
  await assertSame(db, { 2: 'Beacon' });
  // And that one removed: the live one decides again.
  await writeAgents(db, [live(2), live(1), revoked(1), live(1)]);
  await assertSame(db, { 1: 'Lantern', 2: 'Beacon' });
  await writeAgents(db, [live(2), revoked(1), live(1), revoked(1)]);
  await assertSame(db, { 2: 'Beacon' });
  await writeAgents(db, [live(2), live(1), revoked(1)]);
  await assertSame(db, { 1: 'Lantern', 2: 'Beacon' });

  // A revoked record inserted in the middle, ahead of the live one.
  await writeAgents(db, [live(2), live(1), revoked(1)]);
  await writeAgents(db, [live(2), revoked(1), live(1), revoked(1)]);
  await assertSame(db, { 2: 'Beacon' });
  // A live record inserted in the middle, ahead of the revoked one.
  await writeAgents(db, [live(2), live(1), revoked(1), live(1), revoked(1)]);
  await assertSame(db, { 1: 'Lantern', 2: 'Beacon' });
});

test('after random reorders of duplicate records the table answers as the documents', async (t) => {
  const db = await setup(t);
  for (let n = 1; n <= 6; n += 1)
    await add(db, { n, kind: 'final', id: 100 + n, formerNames: [`Was ${n}`], name: `Is ${n}` });
  // A small deterministic generator (mulberry32), so a failure reproduces.
  let seed = 0x5eed2026;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)]!;
  const record = (): AgentRecord => {
    const n = 1 + Math.floor(random() * 6);
    const revision = pick([1, 2, 2]);
    const base = pick([live(n, revision), live(n, revision), revoked(n, revision)]);
    // Live records written either way (revokedAt null or absent), some with other fields.
    if (base.revokedAt === null && random() < 0.3) delete base.revokedAt;
    if (random() < 0.3) base.announcedOnline = random() < 0.5;
    return base;
  };
  let agents: AgentRecord[] = Array.from({ length: 12 }, record);
  await writeAgents(db, agents);
  for (let step = 0; step < 60; step += 1) {
    const roll = random();
    if (roll < 0.6) {
      // Reorder: shuffle all records, or swap two of them.
      if (random() < 0.5) {
        for (let i = agents.length - 1; i > 0; i -= 1) {
          const j = Math.floor(random() * (i + 1));
          [agents[i], agents[j]] = [agents[j]!, agents[i]!];
        }
      } else if (agents.length > 1) {
        const i = Math.floor(random() * agents.length);
        const j = Math.floor(random() * agents.length);
        [agents[i], agents[j]] = [agents[j]!, agents[i]!];
      }
    } else if (roll < 0.8 && agents.length > 2) {
      agents.splice(Math.floor(random() * agents.length), 1);
    } else {
      agents.splice(Math.floor(random() * (agents.length + 1)), 0, record());
    }
    agents = agents.map((a) => ({ ...a }));
    await writeAgents(db, agents);
    const { table, documents } = await names(db);
    assert.deepEqual(table, documents, `step ${step}: ${JSON.stringify(await agentsOf(db))}`);
  }
});

test("the run log's cursor position is the cursor's ordering prefix, never an id", () => {
  assert.equal(cursorPosition(null), 0);
  assert.equal(cursorPosition('40000000-0000-4000-8000-000000000000'), 0.25);
  assert.equal(cursorPosition('ff123456-0000-4000-8000-000000000000'), 255 / 256);
  assert.equal(cursorPosition('ws'), null);
});
