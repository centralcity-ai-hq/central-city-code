import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { Database } from '../server/database.js';
import { registerOnBaseRoutes } from '../server/base/explorer/routes.js';
import type { OnBaseList } from '../shared/base/on-base.js';
import { NOW, add, agentId, fanOut, mintTx, setup, shortOf } from './on-base-fixture.js';

/*
 * The Explorer's search while agent_public_cards (migration 280) is still being backfilled. The
 * former fallback read the manifests of every registration (an EXISTS per identity), then their
 * workspaces: at production size (about 1M Base agents) it ran past the search's statement
 * timeout for every search with a name reading, so a Base ID or a passport number answered busy
 * too. Here that fallback costs more than the timeout (it is answered with the timeout error), and
 * the search must still answer: the exact readings in full, the name from the cards the table
 * holds, marked incomplete.
 */

const statementTimeout = () =>
  Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });

/** The full scan the not-ready fallback ran: the manifests of every listed registration. */
const FULL_SCAN = /EXISTS \(SELECT 1 FROM agent_manifests mm/;

/** The database, where the full scan takes longer than the statement timeout. */
function expensiveFallback(db: Database) {
  const seen = { scans: 0 };
  const slow = (query: Database['query']) =>
    ((sql: string, params?: unknown[]) => {
      if (FULL_SCAN.test(sql)) {
        seen.scans += 1;
        return Promise.reject(statementTimeout());
      }
      return query(sql, params as never);
    }) as Database['query'];
  const wrapped: Database = {
    ...db,
    query: slow(db.query),
    transaction: (action) => db.transaction((tx) => action({ ...tx, query: slow(tx.query) })),
  };
  return { seen, db: wrapped };
}

function routes(t: { after: (fn: () => Promise<unknown>) => void }, db: Database) {
  const app = Fastify();
  t.after(() => app.close());
  registerOnBaseRoutes(app, { db, now: () => NOW, limit: async () => {} });
  return app;
}

/** Five agents; 1 and 2 from before the table (no card yet), as the backfill still has to walk. */
async function building(t: { after: (fn: () => Promise<unknown>) => void }) {
  const base = await setup(t);
  await add(base, { n: 1, kind: 'final', id: 121, name: 'Harbor North' });
  await add(base, { n: 2, kind: 'final', id: 122, name: 'Harbor South' });
  await add(base, { n: 3, kind: 'final', id: 123, name: 'Harbor East' });
  await add(base, { n: 4, kind: 'final', id: 124, name: 'Meridian' });
  await add(base, { n: 5, kind: 'final', id: 125, name: 'Hidden', visibility: 'private' });
  await base.query('DELETE FROM agent_public_cards WHERE agent_id = ANY($1::text[])', [
    [agentId(1), agentId(2)],
  ]);
  // A cursor part of the way through the operator ids.
  await base.query(
    `UPDATE agent_public_cards_backfill SET ready = false,
       after_operator = '40000000-0000-4000-8000-000000000000' WHERE id = 1`,
  );
  return base;
}

const search = async (app: ReturnType<typeof routes>, q: string) => {
  const res = await app.inject({ url: `/api/public/base/agents?q=${encodeURIComponent(q)}` });
  return { status: res.statusCode, body: res.json() as OnBaseList };
};
const namesOf = (body: OnBaseList) => body.rows.map((row) => `${row.baseId} ${row.name}`);

test('while the index is built, exact readings answer in full, without the full scan', async (t) => {
  const { seen, db } = expensiveFallback(await building(t));
  const app = routes(t, db);
  // A Base ID (with and without #) and a passport number find the agent, a card-less one with
  // its current public name read from its workspace. Each is also read as a name, so the page
  // still says names may be missing; the id hit itself is always there.
  for (const q of ['121', '#121', shortOf(1), `CC-${shortOf(1)}`]) {
    const { status, body } = await search(app, q);
    assert.equal(status, 200, q);
    assert.deepEqual(namesOf(body), ['121 Harbor North'], q);
  }
  // An address finds the agent wallet: no name reading, so complete.
  const wallet = (await search(app, '121')).body.rows[0]!.owner;
  const byWallet = await search(app, wallet);
  assert.equal(byWallet.status, 200);
  assert.deepEqual(namesOf(byWallet.body), ['121 Harbor North']);
  assert.equal(byWallet.body.incomplete, undefined);
  // A private card's agent is found by its id, without its name.
  assert.deepEqual(namesOf((await search(app, '125')).body), ['125 ']);
  assert.equal(seen.scans, 0);
});

test('while the index is built, a name search answers from the cards, marked incomplete', async (t) => {
  const { seen, db } = expensiveFallback(await building(t));
  const app = routes(t, db);
  const harbor = await search(app, 'Harbor');
  assert.equal(harbor.status, 200);
  // Only the agent the table holds: the two from before it are not claimed to be all.
  assert.deepEqual(namesOf(harbor.body), ['123 Harbor East']);
  assert.equal(harbor.body.incomplete, true);
  // A private name and a name nobody has are not found, and still not claimed complete.
  const hidden = await search(app, 'Hidden');
  assert.deepEqual(hidden.body.rows, []);
  assert.equal(hidden.body.incomplete, true);
  // A number is a Base ID and a name: the id in full, the name part marked.
  const id = await search(app, '122');
  assert.deepEqual(namesOf(id.body), ['122 Harbor South']);
  assert.equal(id.body.incomplete, true);
  assert.equal(seen.scans, 0);
});

test('once the index is ready, the search is complete and unmarked, as before', async (t) => {
  const base = await building(t);
  // As the backfill leaves it: every card, then ready.
  await base.query(
    `SELECT agent_public_cards_refresh(ARRAY(SELECT a->>'id' FROM workspaces,
       jsonb_array_elements(data->'agents') a))`,
  );
  await base.query('UPDATE agent_public_cards_backfill SET ready = true WHERE id = 1');
  // The plain database: this path answers as before this change (the same rows, no mark).
  const app = routes(t, base);
  const harbor = await search(app, 'Harbor');
  assert.equal(harbor.status, 200);
  assert.deepEqual(namesOf(harbor.body), [
    '123 Harbor East',
    '122 Harbor South',
    '121 Harbor North',
  ]);
  assert.equal(harbor.body.incomplete, undefined);
  assert.deepEqual(namesOf((await search(app, '121')).body), ['121 Harbor North']);
  assert.equal((await search(app, '121')).body.incomplete, undefined);
});

for (const ready of [false, true])
  test(`a transaction hash is answered at once as unavailable, with no search statement (${ready ? 'ready' : 'building'})`, async (t) => {
    const base = await setup(t);
    await add(base, { n: 1, kind: 'final', id: 121, name: 'Harbor North' });
    await fanOut(base, 5000);
    await base.query('UPDATE agent_public_cards_backfill SET ready = $1 WHERE id = 1', [ready]);
    const statements: string[] = [];
    const spied: Database = {
      ...base,
      query: ((sql: string, params?: unknown[]) => {
        statements.push(sql);
        return base.query(sql, params as never);
      }) as Database['query'],
      transaction: (action) =>
        base.transaction((tx) =>
          action({
            ...tx,
            query: ((sql: string, params?: unknown[]) => {
              statements.push(sql);
              return tx.query(sql, params as never);
            }) as Database['query'],
          }),
        ),
    };
    const app = routes(t, spied);
    // 5001 registrations share agent 1's mint: the full read it would take is not made.
    const res = await app.inject({ url: `/api/public/base/agents?q=${mintTx(1)}` });
    assert.equal(res.statusCode, 503);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(res.json(), {
      error:
        'Search by transaction hash is temporarily unavailable. Paid calls can be searched by transaction in Service calls.',
      code: 'tx_search_unavailable',
    });
    assert.equal(statements.filter((sql) => /agent_card_uri/.test(sql)).length, 0);
  });
