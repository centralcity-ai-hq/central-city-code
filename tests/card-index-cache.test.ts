import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { btree_gin } from '@electric-sql/pglite/contrib/btree_gin';
import { createApp } from '../server/app.js';
import type { Database } from '../server/database.js';
import {
  CARD_INDEX_TTL_MS,
  cardAgent,
  forgetCardIndex,
  publicAgentCard,
} from '../server/manifest/card-agent.js';
import { PASSWORD } from './oauth-helpers.js';

// Approved 15 Oct 2026: a card lookup unpacks its workspace at most once a minute per instance. A new
// agent or a new manifest revision still shows at once; a revoke within 60 s on other instances.

const ORIGIN = 'https://centralcity.ai';
const HOST = 'centralcity.ai';

async function fixture(t: test.TestContext) {
  process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-card-index-cache-root-secret';
  const db = (await PGlite.create('memory://', {
    extensions: { btree_gin },
  })) as unknown as Database;
  const app = await createApp({
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: ORIGIN,
      allowedOrigins: [ORIGIN],
    },
    startWorkers: false,
    database: db,
  });
  t.after(() => app.close());
  await app.ready();
  const headers = {
    'content-type': 'application/json',
    'x-city-request': '1',
    host: HOST,
    origin: ORIGIN,
  };
  const registered = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers,
    payload: JSON.stringify({ name: 'Index owner', password: PASSWORD }),
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
  const send = (method: 'POST' | 'PATCH' | 'DELETE', url: string, body?: object) =>
    app.inject({
      method,
      url,
      headers: { ...headers, cookie },
      ...(body ? { payload: JSON.stringify(body) } : {}),
    });
  const create = async (name: string) => {
    const res = await send('POST', '/api/agents', {
      name,
      capability: 'research',
      mode: 'hosted',
      visibility: 'public',
    });
    assert.equal(res.statusCode, 201, res.body);
    return (res.json() as { agent: { id: string } }).agent.id;
  };
  // Counts the workspace unpacks (the expensive read the index saves).
  let unpacks = 0;
  const counted = new Proxy(db, {
    get(target, key, receiver) {
      if (key === 'query')
        return (sql: string, params?: unknown[]) => {
          if (/jsonb_array_elements\(w\.data->'agents'\)/.test(sql)) unpacks += 1;
          return target.query(sql, params as never);
        };
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Database;
  return { app, db: counted, send, create, unpacks: () => unpacks };
}

test('card index: one workspace unpack serves every card of that workspace for 60 s', async (t) => {
  const { db, create, unpacks } = await fixture(t);
  const ids = [await create('Ada'), await create('Bo'), await create('Cy')];
  const now = Date.now() + 10_000;
  for (const id of ids) assert.ok(await cardAgent(db, id, now));
  for (const id of ids) assert.ok(await cardAgent(db, id, now + 30_000));
  assert.equal(unpacks(), 1, 'six cards, one unpack');
  assert.ok(await cardAgent(db, ids[0]!, now + CARD_INDEX_TTL_MS + 1));
  assert.equal(unpacks(), 2, 'read again after the TTL');
});

test('card index: a new agent and a rename show at once, without waiting for the TTL', async (t) => {
  const { db, send, create, unpacks } = await fixture(t);
  const first = await create('Early');
  const now = Date.now();
  assert.ok(await cardAgent(db, first, now));
  assert.equal(unpacks(), 1);

  // Created after the index was read: found at once (one more unpack), then served from it.
  const late = await create('Late');
  assert.equal((await cardAgent(db, late, now + 1))?.manifest.metadata.displayName, 'Late');
  assert.equal(unpacks(), 2);
  assert.ok(await cardAgent(db, late, now + 2));
  assert.equal(unpacks(), 2);

  // Renamed (a new manifest revision): the new name at once.
  const renamed = await send('PATCH', `/api/agents/${first}`, { name: 'Renamed' });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal((await cardAgent(db, first, now + 3))?.manifest.metadata.displayName, 'Renamed');
  assert.equal(unpacks(), 3);
  assert.equal((await cardAgent(db, first, now + 4))?.manifest.metadata.displayName, 'Renamed');
  assert.equal(unpacks(), 3, 'and served from the index again');
});

test('card index: unknown and old manifests never reread; a revoke shows at once on this instance', async (t) => {
  const { db, create, unpacks } = await fixture(t);
  const id = await create('Gone soon');
  const now = Date.now();
  assert.equal(await cardAgent(db, 'no-such-agent', now), null);
  assert.equal(unpacks(), 0, 'an unknown id never unpacks a workspace');
  assert.ok(await cardAgent(db, id, now));
  assert.equal(unpacks(), 1);

  // Revoked elsewhere (another instance): this index still has it until the TTL...
  const operator = (
    await db.query<{ operator_id: string }>(
      'SELECT operator_id FROM agent_manifests WHERE agent_id=$1 LIMIT 1',
      [id],
    )
  ).rows[0]!.operator_id;
  await db.query(
    `UPDATE workspaces SET data = jsonb_set(data, '{agents}', (
       SELECT jsonb_agg(CASE WHEN a->>'id'=$2 THEN a || jsonb_build_object('revokedAt', '2026-10-15T08:00:00.000Z') ELSE a END)
       FROM jsonb_array_elements(data->'agents') a)) WHERE operator_id=$1`,
    [operator, id],
  );
  assert.ok(await cardAgent(db, id, now + 1), 'within the TTL on an instance that did not revoke');
  assert.equal(await cardAgent(db, id, now + CARD_INDEX_TTL_MS + 1), null, 'gone after the TTL');
  // ...and the instance that revokes forgets its index at once.
  forgetCardIndex(operator);
  assert.equal(await cardAgent(db, id, now + CARD_INDEX_TTL_MS + 2), null);
});

test('card index: public to private is never served from the index, same millisecond or skewed clocks', async (t) => {
  const { db, send, create } = await fixture(t);
  const id = await create('Turns private');
  const now = Date.now();
  assert.equal(await publicAgentCard(db, id, ORIGIN, now).then(Boolean), true);
  const made = await send('PATCH', `/api/agents/${id}`, { visibility: 'private' });
  assert.equal(made.statusCode, 200, made.body);
  // The same millisecond the index was read in: the newer revision is still seen.
  assert.equal(await publicAgentCard(db, id, ORIGIN, now), null);
  assert.equal((await cardAgent(db, id, now))?.manifest.spec.visibility, 'private');

  // A writer whose clock is far behind (created_at long before the index was read).
  const back = await send('PATCH', `/api/agents/${id}`, { visibility: 'public' });
  assert.equal(back.statusCode, 200, back.body);
  assert.ok(await publicAgentCard(db, id, ORIGIN, now + 1));
  const hide = await send('PATCH', `/api/agents/${id}`, { visibility: 'private' });
  assert.equal(hide.statusCode, 200, hide.body);
  await db.query(
    'UPDATE agent_manifests SET created_at=0 WHERE agent_id=$1 AND revision=(SELECT max(revision) FROM agent_manifests WHERE agent_id=$1)',
    [id],
  );
  assert.equal(await publicAgentCard(db, id, ORIGIN, now + 2), null);
});
