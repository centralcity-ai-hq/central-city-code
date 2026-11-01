import assert from 'node:assert/strict';
import test from 'node:test';
import type { Database, Transaction } from '../server/database.js';
import {
  PUBLIC_CARDS_BACKFILL_WORKSPACES,
  PUBLIC_CARDS_SKIP_WINDOW,
  backfillPublicCards,
} from '../server/agent-rows/public-cards.js';
import { setup } from './on-base-fixture.js';

/*
 * The agent_public_cards backfill's fast skip (server/agent-rows/public-cards.ts): a leading run
 * of empty workspaces is passed in one cursor update, every other workspace is still rebuilt in
 * its own transaction, and the cards come out as rebuilding every workspace one by one would.
 */

/** The fixture's database without its own workspace: these tests name every workspace. */
async function fresh(t: Parameters<typeof setup>[0]) {
  const db = await setup(t);
  await db.query(`DELETE FROM workspaces WHERE operator_id = 'ws'`);
  return db;
}

const pad = (k: number) => String(k).padStart(5, '0');
/** Empty workspace k; `w${pad(k)}x` sorts right after it, before workspace k + 1. */
const emptyId = (k: number) => `w${pad(k)}`;

/**
 * Empty workspaces from..to, cycling through every shape workspace_agents() reads as no agents:
 * agents [], missing, JSON null, an object, a string, and a document that is not an object.
 */
async function addEmpty(db: Database, from: number, to: number) {
  await db.query(
    `INSERT INTO operators SELECT 'w' || lpad(k::text, 5, '0') FROM generate_series($1::int, $2::int) k`,
    [from, to],
  );
  await db.query(
    `INSERT INTO workspaces
     SELECT 'w' || lpad(k::text, 5, '0'),
            CASE k % 6 WHEN 0 THEN '{"agents": []}' WHEN 1 THEN '{"name": "joiner"}'
                       WHEN 2 THEN '{"agents": null}' WHEN 3 THEN '{"agents": {"id": "x"}}'
                       WHEN 4 THEN '{"agents": "none"}' ELSE '[]' END::jsonb
       FROM generate_series($1::int, $2::int) k`,
    [from, to],
  );
}

/** A workspace with `agents` agents, each with a public manifest (or none: no card). */
async function addWorkspace(
  db: Database,
  ws: string,
  agents: number,
  options: { manifests?: boolean; rows?: boolean } = {},
) {
  await db.query('INSERT INTO operators VALUES ($1)', [ws]);
  const ids = Array.from({ length: agents }, (_, j) => `agent-${ws}-${j}`);
  if (options.manifests !== false)
    for (const [j, id] of ids.entries())
      await db.query(`INSERT INTO agent_manifests VALUES ($1, 1, 'h', $2, 1, $3)`, [
        id,
        JSON.stringify({
          metadata: { displayName: `Name ${ws} ${j}` },
          spec: { visibility: 'public' },
        }),
        ws,
      ]);
  const records = ids.map((id) => ({ id, revision: 1, revokedAt: null }));
  if (options.rows) {
    // Rows mode: the document's list is empty, the agents live in the agents table.
    await db.query(`INSERT INTO workspaces VALUES ($1, '{"agents": []}')`, [ws]);
    await db.query(`INSERT INTO workspace_storage VALUES ($1, 'rows', 1)`, [ws]);
    for (const [j, record] of records.entries())
      await db.query(
        'INSERT INTO agents (operator_id, agent_id, ordinal, agent) VALUES ($1, $2, $3, $4)',
        [ws, record.id, j + 1, JSON.stringify(record)],
      );
  } else {
    await db.query('INSERT INTO workspaces VALUES ($1, $2)', [
      ws,
      JSON.stringify({ agents: records }),
    ]);
  }
  return ids;
}

async function cards(db: Pick<Transaction, 'query'>) {
  return (
    await db.query<{
      agent_id: string;
      operator_id: string;
      revision: number;
      name: string | null;
    }>('SELECT agent_id, operator_id, revision, name FROM agent_public_cards ORDER BY agent_id')
  ).rows;
}

/** As the migration finds a database with manifests: nothing in the table, not ready. */
async function restart(db: Database) {
  await db.query('DELETE FROM agent_public_cards');
  await db.query('UPDATE agent_public_cards_backfill SET ready = false, after_operator = NULL');
}

/** Every workspace rebuilt one by one, in its own transaction (the path before the skip). */
async function rebuildOneByOne(db: Database) {
  const { rows } = await db.query<{ operator_id: string }>(
    'SELECT operator_id FROM workspaces ORDER BY operator_id',
  );
  for (const { operator_id } of rows)
    await db.transaction(async (tx) => {
      await tx.query('SELECT 1 FROM workspaces WHERE operator_id = $1 FOR SHARE', [operator_id]);
      await tx.query(
        `SELECT agent_public_cards_refresh(ARRAY(
           SELECT wa.agent->>'id' FROM workspaces w
           CROSS JOIN LATERAL workspace_agents(w.operator_id, w.data) wa
           WHERE w.operator_id = $1 AND wa.agent->>'id' IS NOT NULL
           UNION SELECT agent_id FROM agent_public_cards WHERE operator_id = $1))`,
        [operator_id],
      );
    });
}

/**
 * The database with the workspaces each backfill transaction rebuilt (FOR SHARE), and an
 * optional hook run on each transaction's statements (after the statement, inside it).
 */
function watched(
  db: Database,
  hooks: {
    beforeTransaction?: () => Promise<void>;
    afterStatement?: (tx: Transaction, sql: string) => Promise<void>;
  } = {},
) {
  const rebuilt: string[] = [];
  const watchedDb: Pick<Database, 'query' | 'transaction'> = {
    query: (sql, params) => db.query(sql, params),
    transaction: async (action) => {
      await hooks.beforeTransaction?.();
      return db.transaction((tx) =>
        action({
          exec: (sql) => tx.exec(sql),
          query: async <T>(sql: string, params?: unknown[]) => {
            if (/FOR SHARE/.test(sql)) rebuilt.push(String(params?.[0]));
            const result = await tx.query<T>(sql, params);
            await hooks.afterStatement?.(tx, sql);
            return result;
          },
        }),
      );
    },
  };
  return { db: watchedDb, rebuilt };
}

test('one run passes runs of empty workspaces in bulk and rebuilds the rest one by one', async (t) => {
  const db = await fresh(t);
  await addEmpty(db, 1, 12_000);
  // Interleaved: right at the start, adjacent, mid-window, a stretch of empties longer than the
  // window, at the end; a rows-mode workspace with an empty document; an empty workspace that
  // still holds a stale card of its own (both must be rebuilt, never skipped).
  const nonEmpty = [0, 1, 2, 2_500, 2_501, 11_999, 12_000].map((k) => `w${pad(k)}x`);
  for (const [i, ws] of nonEmpty.entries()) await addWorkspace(db, ws, 1 + (i % 3));
  await addWorkspace(db, 'w06000r', 2, { rows: true });
  // A record without an id: no card either way, but not empty, so rebuilt rather than skipped.
  await db.query(`INSERT INTO operators VALUES ('w08000n')`);
  await db.query(`INSERT INTO workspaces VALUES ('w08000n', '{"agents": [{"name": "no id"}]}')`);
  const byTriggers = await cards(db);
  assert.equal(byTriggers.length, 1 + 2 + 3 + 1 + 2 + 3 + 1 + 2);

  await restart(db);
  await db.query(`INSERT INTO agent_public_cards VALUES ('agent-gone', $1, 1, 'Stale')`, [
    emptyId(7_000),
  ]);
  await rebuildOneByOne(db);
  const oneByOne = await cards(db);
  assert.deepEqual(oneByOne, byTriggers, 'the stale card is gone, every other card is back');

  await restart(db);
  await db.query(`INSERT INTO agent_public_cards VALUES ('agent-gone', $1, 1, 'Stale')`, [
    emptyId(7_000),
  ]);
  const run = watched(db);
  const result = await backfillPublicCards(run.db);
  // 12,000 empties, of which workspace 7000 (stale card) is rebuilt instead of skipped.
  assert.deepEqual(result, { ready: true, workspaces: nonEmpty.length + 3, skipped: 11_999 });
  assert.deepEqual(run.rebuilt, [
    ...nonEmpty.slice(0, 5),
    'w06000r',
    emptyId(7_000),
    'w08000n',
    ...nonEmpty.slice(5),
  ]);
  assert.deepEqual(await cards(db), oneByOne);
  assert.deepEqual(
    (await db.query('SELECT after_operator, ready FROM agent_public_cards_backfill')).rows,
    [{ after_operator: nonEmpty.at(-1), ready: true }],
  );
});

test('a write that gives a skipped workspace its first agent still gets its card', async (t) => {
  const db = await fresh(t);
  await addEmpty(db, 1, 300);
  await addWorkspace(db, 'w00150x', 1);
  await restart(db);
  const addAgent = async (q: Pick<Transaction, 'query'>, ws: string, id: string, name: string) => {
    await q.query(`INSERT INTO agent_manifests VALUES ($1, 1, 'h', $2, 1, $3)`, [
      id,
      JSON.stringify({ metadata: { displayName: name }, spec: { visibility: 'public' } }),
      ws,
    ]);
    await q.query(
      `UPDATE workspaces SET data = jsonb_set(data, '{agents}', $2::jsonb) WHERE operator_id = $1`,
      [ws, JSON.stringify([{ id, revision: 1, revokedAt: null }])],
    );
  };
  let scans = 0;
  let steps = 0;
  const run = watched(db, {
    // Right after the first step's read ahead found workspaces 1-149 empty: a write gives
    // workspace 100 an agent before the step commits (here inside it; PGlite has one connection).
    afterStatement: async (tx, sql) => {
      if (/row_number\(\) OVER/.test(sql) && (scans += 1) === 1)
        await addAgent(tx, emptyId(100), 'agent-late-100', 'Late Hundred');
    },
    // Between steps (its own transaction): one agent before the cursor, one after it.
    beforeTransaction: async () => {
      if ((steps += 1) !== 2) return;
      await db.transaction(async (tx) => {
        await addAgent(tx, emptyId(20), 'agent-late-20', 'Late Twenty');
        await addAgent(tx, emptyId(200), 'agent-late-200', 'Late Two Hundred');
      });
    },
  });
  const result = await backfillPublicCards(run.db);
  assert.equal(result.ready, true);
  // Workspaces 20 and 100 were passed as empty (their writes kept their cards); 200 had its
  // agent before the step that reached it read ahead, so it was rebuilt.
  assert.deepEqual(run.rebuilt, ['w00150x', emptyId(200)]);
  assert.deepEqual(
    (await cards(db)).map((card) => [card.agent_id, card.operator_id, card.name]),
    [
      ['agent-late-100', emptyId(100), 'Late Hundred'],
      ['agent-late-20', emptyId(20), 'Late Twenty'],
      ['agent-late-200', emptyId(200), 'Late Two Hundred'],
      ['agent-w00150x-0', 'w00150x', 'Name w00150x 0'],
    ],
  );
});

test('two runs at once never rebuild or pass the same workspace twice', async (t) => {
  const db = await fresh(t);
  for (const ws of ['wa', 'wb', 'wc', 'wd']) await addWorkspace(db, ws, 1);
  await addEmpty(db, 1, 50);
  await restart(db);
  const other = watched(db);
  let otherResult: Awaited<ReturnType<typeof backfillPublicCards>> | undefined;
  // This run has read the backfill state; before its first transaction another run takes a step.
  const run = watched(db, {
    beforeTransaction: async () => {
      if (otherResult) return;
      otherResult = await backfillPublicCards(other.db, { maxWorkspaces: 1 });
    },
  });
  const result = await backfillPublicCards(run.db);
  // No workspace was rebuilt by both runs (before the skip, both rebuilt the other run's one).
  const both = [...other.rebuilt, ...run.rebuilt];
  assert.equal(new Set(both).size, both.length, `rebuilt twice: ${both.join(' ')}`);
  // The other run passed the empties w00001-w00050 and rebuilt wa (one step), then hit its cap.
  assert.deepEqual(otherResult, { ready: false, workspaces: 1, skipped: 50 });
  assert.deepEqual(other.rebuilt, ['wa']);
  assert.deepEqual(result, { ready: true, workspaces: 3, skipped: 0 });
  assert.deepEqual(run.rebuilt, ['wb', 'wc', 'wd']);
  assert.equal((await cards(db)).length, 4);
});

test('a run rebuilds at most its cap of workspaces with agents; empties do not count', async (t) => {
  assert.equal(PUBLIC_CARDS_BACKFILL_WORKSPACES, 400);
  assert.equal(PUBLIC_CARDS_SKIP_WINDOW, 5_000);
  const db = await fresh(t);
  await addEmpty(db, 1, 900);
  // 450 workspaces with an agent each (no manifest: nothing public), one after every second empty.
  await db.query(
    `INSERT INTO operators SELECT 'w' || lpad((2 * k)::text, 5, '0') || 'x' FROM generate_series(1, 450) k`,
  );
  await db.query(
    `INSERT INTO workspaces SELECT 'w' || lpad((2 * k)::text, 5, '0') || 'x',
       jsonb_build_object('agents', jsonb_build_array(jsonb_build_object('id', 'agent-' || k)))
       FROM generate_series(1, 450) k`,
  );
  await restart(db);
  const first = watched(db);
  assert.deepEqual(await backfillPublicCards(first.db), {
    ready: false,
    workspaces: 400,
    skipped: 800,
  });
  assert.equal(new Set(first.rebuilt).size, 400);
  const second = watched(db);
  assert.deepEqual(await backfillPublicCards(second.db), {
    ready: true,
    workspaces: 50,
    skipped: 100,
  });
  assert.equal(new Set([...first.rebuilt, ...second.rebuilt]).size, 450);
});

test('the time budget still ends a run, skips included', async (t) => {
  const db = await fresh(t);
  await addEmpty(db, 1, 20);
  for (const ws of ['w00005x', 'w00010x', 'w00015x']) await addWorkspace(db, ws, 1);
  await restart(db);
  // Every clock read is 20 s later: the first step starts at 20 s, the next check is past 30 s.
  let calls = 0;
  const now = () => calls++ * 20_000;
  assert.deepEqual(await backfillPublicCards(db, { now }), {
    ready: false,
    workspaces: 1,
    skipped: 5,
  });
  calls = 0;
  assert.deepEqual(await backfillPublicCards(db, { now, skipWindow: 3 }), {
    ready: false,
    workspaces: 0,
    skipped: 3,
  });
  assert.deepEqual(await backfillPublicCards(db), { ready: true, workspaces: 2, skipped: 12 });
});

test('a workspace moved to rows mode keeps its cards whether the read ahead saw it or not', async (t) => {
  const db = await fresh(t);
  await addEmpty(db, 1, 100);
  await addWorkspace(db, 'w00090x', 1);
  await restart(db);
  /** The switch to rows mode (as the agent rows switch does) with one new agent in the rows. */
  const toRows = async (q: Pick<Transaction, 'query'>, ws: string, id: string) => {
    await q.query(`INSERT INTO agent_manifests VALUES ($1, 1, 'h', $2, 1, $3)`, [
      id,
      JSON.stringify({ metadata: { displayName: `Rows ${ws}` }, spec: { visibility: 'public' } }),
      ws,
    ]);
    await q.query(`INSERT INTO workspace_storage VALUES ($1, 'rows', 2)`, [ws]);
    await q.query(
      `INSERT INTO agents (operator_id, agent_id, ordinal, agent) VALUES ($1, $2, 1, $3)`,
      [ws, id, JSON.stringify({ id, revision: 1, revokedAt: null })],
    );
  };
  // Before any read ahead: workspace 40 is in rows mode (with an agent) and workspace 60 in rows
  // mode with no agent yet; neither is skipped. After the first read ahead passed 1-89 as empty,
  // workspace 10 moves to rows mode, inside that step.
  await toRows(db, emptyId(40), 'agent-rows-40');
  await db.query(`INSERT INTO workspace_storage VALUES ($1, 'rows', 2)`, [emptyId(60)]);
  let scans = 0;
  const run = watched(db, {
    afterStatement: async (tx, sql) => {
      if (/row_number\(\) OVER/.test(sql) && (scans += 1) === 1)
        await toRows(tx, emptyId(10), 'agent-rows-10');
    },
  });
  assert.equal((await backfillPublicCards(run.db)).ready, true);
  assert.deepEqual(run.rebuilt, [emptyId(40), emptyId(60), 'w00090x']);
  assert.deepEqual(
    (await cards(db)).map((card) => [card.agent_id, card.operator_id]),
    [
      ['agent-rows-10', emptyId(10)],
      ['agent-rows-40', emptyId(40)],
      ['agent-w00090x-0', 'w00090x'],
    ],
  );
});

test('a step whose cursor moved under it rolls back: nothing is passed or rebuilt twice', async (t) => {
  const db = await fresh(t);
  await addEmpty(db, 1, 30);
  for (const ws of ['w00010x', 'w00020x']) await addWorkspace(db, ws, 1);
  await restart(db);
  // A competing run moves the cursor to workspace 15 (it rebuilt w00010x) after this step read
  // the cursor and looked ahead, before this step's compare-and-set.
  let scans = 0;
  const run = watched(db, {
    afterStatement: async (tx, sql) => {
      if (/row_number\(\) OVER/.test(sql) && (scans += 1) === 1)
        await tx.query('UPDATE agent_public_cards_backfill SET after_operator = $1', [emptyId(15)]);
    },
  });
  // In PGlite the competitor's update is inside this step's transaction, so the rollback
  // undoes it too; what counts is that the step's compare-and-set lost and nothing was kept.
  assert.deepEqual(await backfillPublicCards(run.db), { ready: false, workspaces: 0, skipped: 0 });
  assert.deepEqual(run.rebuilt, ['w00010x']);
  assert.deepEqual(await cards(db), []);
  assert.deepEqual(
    (await db.query('SELECT after_operator, ready FROM agent_public_cards_backfill')).rows,
    [{ after_operator: null, ready: false }],
  );
  // The next run starts again from the cursor: every workspace exactly once.
  const next = watched(db);
  assert.deepEqual(await backfillPublicCards(next.db), { ready: true, workspaces: 2, skipped: 30 });
  assert.deepEqual(next.rebuilt, ['w00010x', 'w00020x']);
});

test('a run passes at most its skip cap of empty workspaces', async (t) => {
  const db = await fresh(t);
  await addEmpty(db, 1, 40);
  await restart(db);
  assert.deepEqual(await backfillPublicCards(db, { skipWindow: 8, maxSkipped: 20 }), {
    ready: false,
    workspaces: 0,
    skipped: 20,
  });
  assert.deepEqual(await backfillPublicCards(db, { skipWindow: 8 }), {
    ready: true,
    workspaces: 0,
    skipped: 20,
  });
});
