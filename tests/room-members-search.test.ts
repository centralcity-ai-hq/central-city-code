import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { MEMBERS_QUERY_MAX } from '../server/rooms/contract.js';
import { fillMemberNameKeys } from '../server/wake/hooks.js';

/**
 * The members list name search (`?q=` on GET /api/rooms/:room/members): "starts with" on the
 * name or @slug, case-insensitive after NFKC folding (the @mention keys), LIKE wildcards taken
 * literally, paged with the existing cursor, the default response unchanged, and no writes. Each
 * case runs with the mention keys unknown (NULL, checked by name) and filled (indexed prefix).
 * Synthetic data only.
 */
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-member-search-root-not-a-real-secret';
const headers = { 'content-type': 'application/json', 'x-city-request': '1' };
const SCALE_AGENTS = 30;

type Listed = { id: string; name: string; kind: string };
type Page = { room_id: string; members: Listed[]; next_cursor?: string };

async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const db = app.city.db;
  const call = (method: 'GET' | 'POST', url: string, cookie: string, body?: unknown) =>
    app.inject({
      method,
      url,
      headers: { ...headers, cookie },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      remoteAddress: '203.0.113.71',
    });
  const registered = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers,
    payload: JSON.stringify({ name: 'Search host', password: 'Synthetic member search password' }),
    remoteAddress: '203.0.113.70',
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
  const agent = await call('POST', '/api/agents', cookie, {
    name: 'Host desk',
    capability: 'research',
    mode: 'hosted',
  });
  assert.equal(agent.statusCode, 201, agent.body);
  const created = await call('POST', '/api/rooms', cookie, {
    name: 'Search room',
    agent_id: agent.json().agent.id,
    member_cap: 100,
    idempotency_key: randomUUID(),
  });
  assert.equal(created.statusCode, 201, created.body);
  const roomId = created.json().room.id as string;

  // Other owners' agents (one owner each), joined in this order after the host.
  const base = Date.now() - 86_400_000;
  let joined = 0;
  const addAgent = async (name: string, extra: { revoked?: boolean; removed?: boolean } = {}) => {
    joined++;
    const owner = `search-owner-${joined}`;
    const id = randomUUID();
    await db.query(
      `INSERT INTO operators(id,name,name_key,password_hash,salt,kind)
         VALUES($1,'Room guest',$1,'!','!','unclaimed')`,
      [owner],
    );
    await db.query(
      `INSERT INTO workspaces(operator_id,data) VALUES($1, jsonb_build_object(
         'paused', false, 'connections', '[]'::jsonb, 'jobs', '[]'::jsonb, 'events', '[]'::jsonb,
         'agents', jsonb_build_array(jsonb_build_object(
           'id', $2::text, 'name', $3::text, 'description', '', 'capability', 'research',
           'mode', 'external', 'isDemo', false, 'lastSeenAt', null,
           'createdAt', '2026-01-01T00:00:00.000Z', 'revokedAt', $4::text,
           'lastSequence', -1, 'announcedOnline', false))))`,
      [owner, id, name, extra.revoked ? '2026-02-01T00:00:00.000Z' : null],
    );
    await db.query(
      `INSERT INTO room_members(room_id,agent_id,owner_id,role,owner_label,visible_from_seq,
         joined_at,joined_by,last_read_seq,removed_at)
         VALUES($1,$2,$3,'member',$4,0,$5,'test',0,$6)`,
      [roomId, id, owner, `Owner ${joined}`, base + joined * 1000, extra.removed ? base : null],
    );
    return id;
  };
  const addPerson = async (name: string) => {
    joined++;
    const owner = `search-owner-${joined}`;
    const id = randomUUID();
    await db.query(
      `INSERT INTO operators(id,name,name_key,password_hash,salt,kind)
         VALUES($1,'Room guest',$1,'!','!','unclaimed')`,
      [owner],
    );
    await db.query(
      `INSERT INTO room_members(room_id,agent_id,owner_id,role,owner_label,visible_from_seq,
         joined_at,joined_by,last_read_seq,kind,display_name)
         VALUES($1,$2,$3,'member',$4,0,$5,'test',0,'person',$6)`,
      [roomId, id, owner, `Account ${String(joined).padStart(8, '0')}`, base + joined * 1000, name],
    );
    return id;
  };
  for (let i = 1; i <= SCALE_AGENTS; i++) await addAgent(`Scale agent ${i}`);
  const ids = {
    ann: await addPerson('Ann Lee'),
    joanna: await addPerson('Joanna Banks'),
    full: await addAgent('Ｆｕｌｌ Desk'),
    percent: await addAgent('100% Bot'),
    thousand: await addAgent('1000 Bot'),
    underscore: await addAgent('Under_score'),
    revoked: await addAgent('Annex revoked'),
    removed: await addAgent('Annie removed'),
  };
  await db.query(
    "UPDATE workspaces SET data = jsonb_set(data, '{agents,0,revokedAt}', '\"2026-02-01T00:00:00.000Z\"') WHERE operator_id=(SELECT owner_id FROM room_members WHERE agent_id=$1)",
    [ids.revoked],
  );
  await db.query('UPDATE room_members SET removed_at=$2 WHERE agent_id=$1', [ids.removed, base]);
  const list = (query = '') => call('GET', `/api/rooms/${roomId}/members${query}`, cookie);
  const names = (page: Page) => page.members.map((member) => member.name);
  return { app, db, roomId, ids, list, names };
}

test('members search: default list unchanged; starts with, case and NFKC folding', async (t) => {
  const { list, names, ids, db, roomId } = await fixture(t);

  // Without q: everyone active (host agent, the host as a person, 30 scale agents, 2 people, 4
  // others), one page, no cursor.
  const all = await list();
  assert.equal(all.statusCode, 200, all.body);
  const everyone = all.json() as Page;
  assert.equal(everyone.room_id, roomId);
  assert.equal(everyone.members.length, 2 + SCALE_AGENTS + 2 + 4);
  assert.equal(everyone.next_cursor, undefined);
  assert.ok(!names(everyone).includes('Annex revoked'));
  assert.ok(!names(everyone).includes('Annie removed'));
  // An empty or blank q is the plain list.
  assert.deepEqual((await list('?q=')).json(), everyone);
  assert.deepEqual((await list('?q=%20%20')).json(), everyone);

  const search = async (q: string) => {
    const response = await list(`?q=${encodeURIComponent(q)}`);
    assert.equal(response.statusCode, 200, response.body);
    return names(response.json() as Page);
  };
  const expectations = async () => {
    // "Starts with" on the name, any case; revoked and removed members never match.
    assert.deepEqual(await search('ann'), ['Ann Lee']);
    assert.deepEqual(await search('ANN L'), ['Ann Lee']);
    assert.deepEqual(await search('joanna'), ['Joanna Banks']);
    // Not inside the name.
    assert.deepEqual(await search('lee'), []);
    assert.deepEqual(await search('banks'), []);
    // The @slug form, with or without the @.
    assert.deepEqual(await search('@ann-lee'), ['Ann Lee']);
    assert.deepEqual(await search('joanna-b'), ['Joanna Banks']);
    // NFKC: full-width letters match their plain form, both ways.
    assert.deepEqual(await search('full'), ['Ｆｕｌｌ Desk']);
    assert.deepEqual(await search('ｆｕｌｌ ｄｅｓｋ'), ['Ｆｕｌｌ Desk']);
    // LIKE wildcards are literal.
    assert.deepEqual(await search('100%'), ['100% Bot']);
    assert.deepEqual(await search('%'), []);
    assert.deepEqual(await search('under_'), ['Under_score']);
    assert.deepEqual(await search('u_der'), []);
    assert.deepEqual(await search('nobody here'), []);
  };
  // Keys unknown (no post in the room yet): every member is checked by name.
  await expectations();
  const keys = await db.query<{ name_key: string | null }>(
    'SELECT name_key FROM room_members WHERE room_id=$1',
    [roomId],
  );
  assert.ok(
    keys.rows.every((row) => row.name_key === null),
    'a search fills no keys',
  );
  // Keys filled (as a post fills them): the indexed prefix match gives the same answers.
  await fillMemberNameKeys(db, roomId);
  await expectations();

  // A renamed person is found by the new name (the trigger clears the key; checked by name).
  await db.query('UPDATE room_members SET display_name=$2 WHERE agent_id=$1', [
    ids.ann,
    'Ann Marsh',
  ]);
  assert.deepEqual(await search('ann m'), ['Ann Marsh']);
  assert.deepEqual(await search('ann l'), []);

  // Too long a query is refused like any bad parameter.
  const long = await list(`?q=${'a'.repeat(MEMBERS_QUERY_MAX + 1)}`);
  assert.equal(long.statusCode, 400, long.body);
});

test('members search: pages with the cursor, no duplicates, cursor only while more follow', async (t) => {
  const { list, db, roomId } = await fixture(t);
  const pageThrough = async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const response = await list(
        `?q=scale%20agent&limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      assert.equal(response.statusCode, 200, response.body);
      const page = response.json() as Page;
      assert.ok(page.members.length <= 7);
      for (const member of page.members) {
        assert.match(member.name, /^Scale agent \d+$/);
        seen.push(member.id);
      }
      cursor = page.next_cursor;
      pages++;
    } while (cursor && pages < 20);
    assert.equal(seen.length, SCALE_AGENTS);
    assert.equal(new Set(seen).size, SCALE_AGENTS);
    return pages;
  };
  // Keys unknown: other members are candidates too, so a page may hold fewer matches.
  assert.ok((await pageThrough()) >= Math.ceil(SCALE_AGENTS / 7));
  // Keys filled: only matches are read, so the pages are full.
  await fillMemberNameKeys(db, roomId);
  assert.equal(await pageThrough(), Math.ceil(SCALE_AGENTS / 7));

  // The plain list pages as before.
  const first = (await list('?limit=10')).json() as Page;
  assert.equal(first.members.length, 10);
  assert.ok(first.next_cursor);
});

test('members search: a search is a pure read (no INSERT, UPDATE or DELETE)', async (t) => {
  const { db, roomId, list } = await fixture(t);
  // Record every statement the members route runs in its transaction.
  const statements: string[] = [];
  const transaction = db.transaction.bind(db);
  db.transaction = (action) =>
    transaction((tx) =>
      action({
        query: (sql, params) => {
          statements.push(sql);
          return tx.query(sql, params);
        },
        exec: (sql) => {
          statements.push(sql);
          return tx.exec(sql);
        },
      } as typeof tx),
    );
  t.after(() => {
    db.transaction = transaction;
  });
  const before = (
    await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM room_members WHERE room_id=$1 AND name_key IS NULL',
      [roomId],
    )
  ).rows[0]!.n;
  assert.ok(before > 0);
  const response = await list('?q=scale');
  assert.equal(response.statusCode, 200, response.body);
  assert.ok((response.json() as Page).members.length > 0);
  assert.ok(statements.length > 0, 'the route runs in a recorded transaction');
  const writes = statements.filter((sql) => /^s*(INSERT|UPDATE|DELETE|MERGE)/i.test(sql));
  assert.deepEqual(writes, []);
  const after = (
    await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM room_members WHERE room_id=$1 AND name_key IS NULL',
      [roomId],
    )
  ).rows[0]!.n;
  assert.equal(after, before);
});
