import assert from 'node:assert/strict';
import test from 'node:test';
import type { Database } from '../server/database.js';
import { BASE_MAINNET } from '../shared/base/chains.js';
import {
  PUBLIC_NAME,
  createOnBaseStore,
  publicManifestsOf,
} from '../server/base/explorer/store.js';
import { AGENT_DIRECTORY_SQL } from '../server/directory/schema.js';
import { createDirectoryStore } from '../server/directory/store.js';
import { add, agentId, setup } from './on-base-fixture.js';

/*
 * Public names and cards for many agents at once (explorer/store.ts publicManifestsOf) while
 * agent_public_cards (migration 280) is not backfilled yet: each workspace document is read once
 * per statement, never once per row, and the answer is the per-row PUBLIC_NAME's. Once it is
 * backfilled no document is read at all (tests/agent-public-cards.test.ts).
 */

/**
 * workspace_agent and workspace_agents as the document mode answers them, counting each call
 * (one call reads one workspace document) in the session setting test.reads.
 */
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
    END $$;`);
  return {
    async reset() {
      await db.query(`SELECT set_config('test.reads', '0', false)`);
    },
    async reads() {
      const { rows } = await db.query<{ n: string }>(
        `SELECT COALESCE(NULLIF(current_setting('test.reads', true), ''), '0') AS n`,
      );
      return Number(rows[0]!.n);
    },
  };
}

const AGENTS = 20;

async function workspaceOf(t: { after: (fn: () => Promise<unknown>) => void }) {
  const db = await setup(t);
  for (let n = 1; n <= AGENTS; n += 1) await add(db, { n, kind: 'final', id: 100 + n });
  await db.query('UPDATE agent_public_cards_backfill SET ready = false');
  return db;
}

test('a list page of one workspace reads that workspace once, not once per row', async (t) => {
  const db = await workspaceOf(t);
  const counter = await countReads(db);
  const store = createOnBaseStore(db, { chainId: BASE_MAINNET });
  await counter.reset();
  const page = await store.list({});
  assert.equal(page.items.length, AGENTS);
  assert.equal(page.items[0]!.row.name, `Agent ${AGENTS}`);
  assert.equal(await counter.reads(), 1);
});

test('a name search reads no workspace for the agents the cards already hold', async (t) => {
  const db = await workspaceOf(t);
  const counter = await countReads(db);
  const store = createOnBaseStore(db, { chainId: BASE_MAINNET });
  await counter.reset();
  const all = await store.list({ q: 'Agent' });
  assert.equal(all.items.length, AGENTS);
  assert.equal(all.incomplete, true);
  assert.equal(await counter.reads(), 0);
  // An id hit without a card yet: its workspace once, for all such rows.
  await db.query('DELETE FROM agent_public_cards WHERE agent_id = $1', [agentId(17)]);
  await counter.reset();
  const one = await store.list({ q: '117' });
  assert.deepEqual(
    one.items.map((item) => item.row.name),
    ['Agent 17'],
  );
  assert.equal(await counter.reads(), 1);
});

test('the directory search reads each workspace once for all its listed agents', async (t) => {
  const db = await workspaceOf(t);
  await db.exec(AGENT_DIRECTORY_SQL);
  for (let n = 1; n <= AGENTS; n += 1)
    await db.query(
      `INSERT INTO agent_directory (agent_id, listed, invitations) VALUES ($1, true, 'ask')`,
      [agentId(n)],
    );
  const counter = await countReads(db);
  const directory = createDirectoryStore(db, { chainId: BASE_MAINNET });
  await counter.reset();
  const page = await directory.search({ q: 'Agent', sort: 'newest', minRating: 0, before: null });
  assert.equal(page.agents.length > 0, true);
  assert.equal(await counter.reads(), 1);
});

test("publicManifestsOf answers exactly as the per-row PUBLIC_NAME's rule", async (t) => {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 101, name: 'Harbor' });
  await add(db, { n: 2, kind: 'final', id: 102, name: 'Hidden', visibility: 'private' });
  await add(db, { n: 3, kind: 'final', id: 103, name: 'Gone', revoked: true });
  await add(db, { n: 4, kind: 'final', id: 104, name: 'Meridian', formerNames: ['Old name'] });
  await add(db, { n: 5, kind: 'final', id: 105, name: '   ' });
  // The same id twice in the array: the first one decides (here: revoked).
  await add(db, { n: 6, kind: 'final', id: 106, name: 'Twice' });
  await db.query(
    `UPDATE workspaces SET data = jsonb_set(data, '{agents}',
       jsonb_build_array(jsonb_build_object('id', $1::text, 'revision', 1,
         'revokedAt', '2026-10-01T00:00:00.000Z')) || (data->'agents'))
     WHERE operator_id = 'ws'`,
    [agentId(6)],
  );
  const ids = [1, 2, 3, 4, 5, 6, 7].map(agentId);
  const perRow = await db.query<{ agent_id: string; name: string | null }>(
    `SELECT l.agent_id, p.name FROM (SELECT unnest($1::text[]) AS agent_id) l ${PUBLIC_NAME}
     ORDER BY l.agent_id`,
    [ids],
  );
  const once = await db.query<{ agent_id: string; name: string | null }>(
    `WITH l AS (SELECT unnest($1::text[]) AS agent_id),
     p AS (${publicManifestsOf('SELECT agent_id FROM l')})
     SELECT l.agent_id, p.name FROM l LEFT JOIN p ON p.agent_id = l.agent_id
     ORDER BY l.agent_id`,
    [ids],
  );
  assert.deepEqual(once.rows, perRow.rows);
  assert.deepEqual(
    once.rows.map((row) => row.name),
    ['Harbor', null, null, 'Meridian', null, null, null],
  );
});
