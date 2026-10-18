import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import type { Database } from '../server/database.js';
import { registerDirectoryRoutes, type DirectoryRouteDeps } from '../server/directory/routes.js';
import { AGENT_DIRECTORY_SQL } from '../server/directory/schema.js';
import {
  DIRECTORY_CANDIDATES_MAX,
  cursorOf,
  offsetOf,
  skillNames,
} from '../server/directory/store.js';
import { ON_BASE_LIVE } from '../server/base/explorer/routes.js';
import {
  DIRECTORY_LIMITS,
  DIRECTORY_PATHS,
  type DirectoryCard,
  type DirectoryPage,
} from '../shared/directory.js';
import {
  add,
  addRating,
  agentId,
  agentWallet,
  ownerWallet,
  setup,
  shortOf,
  spender,
} from './on-base-fixture.js';
import { fixture } from './oauth-helpers.js';

/*
 * Operation Directory D1 (server/directory): the owner's "Show in the directory" settings and the
 * public directory search. The search and the listing rule run on the On Base fixtures (an
 * in-memory database with the Base tables); the owner checks run on the whole app. Synthetic,
 * low-entropy data only.
 */

const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
const settingsPath = (id: string) => DIRECTORY_PATHS.settings.replace(':agentId', id);

async function directoryDb(t: { after: (fn: () => Promise<unknown>) => void }) {
  const db = await setup(t);
  await db.exec(AGENT_DIRECTORY_SQL);
  return db;
}

/** The owner's settings row for fixture `n`. */
async function setListed(
  db: Database,
  n: number,
  listed = true,
  invitations: 'ask' | 'never' = 'ask',
) {
  await db.query(
    'INSERT INTO agent_directory (agent_id, listed, invitations) VALUES ($1, $2, $3)',
    [agentId(n), listed, invitations],
  );
}

function routes(
  t: { after: (fn: () => Promise<unknown>) => void },
  db: Database,
  owns: DirectoryRouteDeps['owns'] = async () => 'ok',
) {
  const app = Fastify();
  t.after(() => app.close());
  registerDirectoryRoutes(app, { db, owns });
  return app;
}

async function search(app: ReturnType<typeof Fastify>, query = '') {
  const response = await app.inject({ url: `${DIRECTORY_PATHS.search}${query}` });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as DirectoryPage;
}
const ids = (page: DirectoryPage) => page.agents.map((card) => card.baseId);

test('only opted-in agents with a final Base ID and a public card are listed, newest first', async (t) => {
  const db = await directoryDb(t);
  await add(db, { n: 1, kind: 'final', id: 120, name: 'Harbor', description: '  Finds ships.  ' });
  await add(db, { n: 2, kind: 'final', id: 121, name: 'Not opted in' }); // no row
  await add(db, { n: 3, kind: 'final', id: 122, name: 'Switched off' });
  await add(db, { n: 4, kind: 'final', id: 123, name: 'Hidden', visibility: 'private' });
  await add(db, { n: 5, kind: 'final', id: 124, name: 'Gone', revoked: true });
  await add(db, { n: 6, kind: 'finalizing', id: 125, name: 'Finalizing' });
  await add(db, { n: 7, kind: 'final', id: 126, name: 'Quiet' });
  await add(db, { n: 8, kind: 'final', id: 127, name: 'Elsewhere', chainId: 84532 });
  for (const n of [1, 4, 5, 6, 8]) await setListed(db, n);
  await setListed(db, 3, false);
  await setListed(db, 7, true, 'never');

  const app = routes(t, db);
  const response = await app.inject({ url: DIRECTORY_PATHS.search });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], ON_BASE_LIVE);
  const page = response.json() as DirectoryPage;
  assert.deepEqual(ids(page), ['126', '120']);
  assert.equal(page.next, null);
  assert.deepEqual(page.agents[1], {
    baseId: '120',
    short: shortOf(1),
    name: 'Harbor',
    description: 'Finds ships.',
    skills: [],
    score: null,
    paidTimes: 0,
    invitable: true,
    activeAt: null,
  } satisfies DirectoryCard);
  assert.equal(page.agents[0].invitable, false, "invitations 'never': no Invite button");

  // Nothing personal or internal: no agent id, wallets, owner or workspace.
  const body = response.body.toLowerCase();
  for (const n of [1, 7]) {
    assert.ok(!body.includes(agentId(n)));
    for (const address of [agentWallet(n), ownerWallet(n), spender(n)])
      assert.ok(!body.includes(address.toLowerCase()));
  }
  assert.ok(!body.includes('"ws"'));
  for (const card of page.agents)
    assert.deepEqual(Object.keys(card).sort(), [
      'activeAt',
      'baseId',
      'description',
      'invitable',
      'name',
      'paidTimes',
      'score',
      'short',
      'skills',
    ]);
});

test('cards: description trimmed to 200, at most three skills, capabilities by their card names', async (t) => {
  const db = await directoryDb(t);
  await add(db, {
    n: 1,
    kind: 'final',
    id: 10,
    description: `${'x'.repeat(250)}`,
    skills: ['One', 'Two', 'Three', 'Four'],
  });
  await add(db, { n: 2, kind: 'final', id: 11, capabilities: ['research', 'custom-cap'] });
  for (const n of [1, 2]) await setListed(db, n);
  const page = await search(routes(t, db), '?sort=newest');
  assert.deepEqual(
    page.agents.map((card) => card.skills),
    [
      ['Research brief', 'custom-cap'],
      ['One', 'Two', 'Three'],
    ],
  );
  assert.equal(page.agents[1].description.length, 200);
  assert.deepEqual(skillNames(undefined), []);
  assert.deepEqual(skillNames({ skills: [], capabilities: ['extract'] }), ['Field extraction']);
});

test('search text matches name, description or skill names, case-insensitive and literal', async (t) => {
  const db = await directoryDb(t);
  await add(db, { n: 1, kind: 'final', id: 1, name: 'Harbor Scout', description: 'Finds ships' });
  await add(db, { n: 2, kind: 'final', id: 2, name: 'Ledger', skills: ['Invoice parsing'] });
  await add(db, { n: 3, kind: 'final', id: 3, name: 'Plain', capabilities: ['research'] });
  await add(db, { n: 4, kind: 'final', id: 4, name: '100% Real' });
  await add(db, { n: 5, kind: 'final', id: 5, name: 'Under_score' });
  await add(db, { n: 6, kind: 'final', id: 6, name: '1000 Realms' });
  await add(db, { n: 7, kind: 'final', id: 7, name: 'UnderXscore' });
  await add(db, { n: 8, kind: 'final', id: 8, name: 'Back\\slash' });
  // A former name never matches, only the current public one.
  await add(db, { n: 9, kind: 'final', id: 9, name: 'Renamed', formerNames: ['Harbor Old'] });
  for (let n = 1; n <= 9; n++) await setListed(db, n);
  const app = routes(t, db);
  const q = async (text: string) => ids(await search(app, `?q=${encodeURIComponent(text)}`));

  assert.deepEqual(await q('harbor'), ['1']);
  assert.deepEqual(await q('SHIPS'), ['1']);
  assert.deepEqual(await q('invoice'), ['2']);
  assert.deepEqual(await q('research brief'), ['3'], 'a capability by its card name');
  assert.deepEqual(await q('research'), ['3'], 'and by its id');
  assert.deepEqual(await q('0%'), ['4'], '% is literal, not a wildcard');
  assert.deepEqual(await q('r_s'), ['5'], '_ is literal');
  assert.deepEqual(await q('\\'), ['8'], 'the escape character is literal too');
  assert.deepEqual(await q('nothing like it'), []);
  // Whitespace is trimmed and collapsed (readDirectoryQuery).
  assert.deepEqual(await q('  harbor   scout '), ['1']);
  assert.deepEqual(await q('harbor\u0000scout'), ['1'], 'a NUL is a space, not a 500');
  // A Base ID or a passport number finds the agent itself (the finder says "or Base ID").
  assert.deepEqual(await q('7'), ['7']);
  assert.deepEqual(await q('#2'), ['2']);
  assert.deepEqual(await q(shortOf(3)), ['3']);
  assert.deepEqual(await q(`CC-${shortOf(3)}`), ['3']);
});

test('ratings: min_rating filters, best_rated sorts by average, raters, newest; unrated last', async (t) => {
  const db = await directoryDb(t);
  // Raters: Central City agents with a final Base ID (not in the directory themselves).
  for (const n of [50, 51, 52]) await add(db, { n, kind: 'final', id: 500 + n });
  for (const n of [1, 2, 3, 4, 5, 6]) {
    await add(db, { n, kind: 'final', id: 100 + n });
    await setListed(db, n);
  }
  let rating = 0;
  const rate = (rater: number, rated: number, stars: number) =>
    addRating(db, { id: `r${++rating}`, rater, rated, baseId: 100 + rated, stars });
  await rate(50, 1, 5);
  await rate(51, 1, 5); // 101: 5.0 from 2
  await rate(50, 2, 5); // 102: 5.0 from 1
  await rate(50, 3, 3); // 103: 3.0 from 1
  // 104: unrated
  await rate(50, 5, 4);
  await rate(51, 5, 4); // 105: 4.0 from 2
  await rate(52, 6, 4); // 106: 4.0 from 1
  const app = routes(t, db);

  const best = await search(app);
  assert.deepEqual(ids(best), ['101', '102', '105', '106', '103', '104']);
  assert.deepEqual(best.agents[0].score, { average: '5.0', raters: 2 });
  assert.equal(best.agents[5].score, null);
  assert.deepEqual(ids(await search(app, '?sort=best_rated')), ids(best));
  assert.deepEqual(ids(await search(app, '?sort=newest')), [
    '106',
    '105',
    '104',
    '103',
    '102',
    '101',
  ]);
  assert.deepEqual(
    ids(await search(app, '?sort=most_paid')),
    ['106', '105', '104', '103', '102', '101'],
    'most paid falls back to newest while payment counts are not built',
  );
  assert.deepEqual(ids(await search(app, '?min_rating=4')), ['101', '102', '105', '106']);
  assert.deepEqual(ids(await search(app, '?min_rating=5&sort=newest')), ['102', '101']);
  // Unreadable values fall back to their defaults.
  assert.deepEqual(ids(await search(app, '?min_rating=9&sort=loudest')), ids(best));
});

test('pages: pageSize per page, an opaque cursor, anything else is the first page', async (t) => {
  const db = await directoryDb(t);
  const total = DIRECTORY_LIMITS.pageSize + 6;
  for (let n = 1; n <= total; n++) {
    await add(db, { n, kind: 'final', id: n });
    await setListed(db, n);
  }
  const app = routes(t, db);
  const first = await search(app, '?sort=newest');
  assert.equal(first.agents.length, DIRECTORY_LIMITS.pageSize);
  assert.equal(first.agents[0].baseId, String(total));
  assert.ok(first.next);
  const second = await search(app, `?sort=newest&before=${first.next}`);
  assert.deepEqual(
    ids(second),
    Array.from({ length: 6 }, (_, i) => String(6 - i)),
  );
  assert.equal(second.next, null);
  // A real cursor past the end (the list shrank) is an empty last page, never page 1 again.
  for (const past of [cursorOf(total), cursorOf(10_000)]) {
    const page = await search(app, `?sort=newest&before=${past}`);
    assert.deepEqual(ids(page), [], `cursor ${past}`);
    assert.equal(page.next, null);
  }
  for (const bad of ['zzz', 'MA', '!!', ''])
    assert.deepEqual(
      ids(await search(app, `?sort=newest&before=${encodeURIComponent(bad)}`)),
      ids(first),
      `cursor ${bad}`,
    );
  assert.equal(offsetOf(cursorOf(24)), 24);
  assert.equal(offsetOf(null), 0);
  assert.equal(offsetOf('MDI0'), 0, 'not canonical (leading zero)');
  assert.equal(DIRECTORY_CANDIDATES_MAX, 1000);
});

test('settings: defaults, owner only, listed=true only for a final Base ID with a public card', async (t) => {
  const db = await directoryDb(t);
  await add(db, { n: 1, kind: 'final', id: 10, name: 'Ready' });
  await add(db, { n: 2, kind: 'finalizing', id: 11 });
  await add(db, { n: 3, kind: 'final', id: 12, visibility: 'private' });
  await add(db, { n: 4, kind: 'pending' });
  const owners = new Map<string, 'ok' | 'signed_out' | 'not_found'>([[agentId(9), 'not_found']]);
  const app = routes(t, db, async (_request, id) => owners.get(id) ?? 'ok');
  const patch = (n: number | string, body: unknown) =>
    app.inject({
      method: 'PATCH',
      url: settingsPath(typeof n === 'number' ? agentId(n) : n),
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });

  const initial = await app.inject({ url: settingsPath(agentId(1)) });
  assert.equal(initial.statusCode, 200);
  assert.deepEqual(initial.json(), { listed: false, invitations: 'ask' });
  assert.equal((await search(app)).agents.length, 0, 'not listed by default');

  for (const n of [2, 3, 4]) {
    const refused = await patch(n, { listed: true });
    assert.equal(refused.statusCode, 409, `fixture ${n}`);
    assert.equal(refused.json().code, 'not_base_agent');
  }
  // Turning it off or changing invitations needs no Base ID.
  assert.deepEqual((await patch(4, { invitations: 'never' })).json(), {
    listed: false,
    invitations: 'never',
  });
  assert.deepEqual((await patch(4, { listed: false })).json(), {
    listed: false,
    invitations: 'never',
  });

  const listed = await patch(1, { listed: true });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.deepEqual(listed.json(), { listed: true, invitations: 'ask' });
  assert.deepEqual(ids(await search(app)), ['10']);
  assert.deepEqual((await patch(1, { invitations: 'never' })).json(), {
    listed: true,
    invitations: 'never',
  });
  assert.equal((await search(app)).agents[0].invitable, false);
  assert.deepEqual((await patch(1, { listed: false })).json(), {
    listed: false,
    invitations: 'never',
  });
  assert.deepEqual(ids(await search(app)), []);

  for (const body of [{ listed: 'yes' }, { invitations: 'always' }, { listed: true, extra: 1 }]) {
    const bad = await patch(1, body);
    assert.equal(bad.statusCode, 400, JSON.stringify(body));
    assert.equal(bad.json().code, 'invalid_request');
  }
  // Another account's or an unknown agent, or a malformed id: one 404.
  for (const id of [agentId(9), 'not-an-id']) {
    for (const response of [
      await app.inject({ url: settingsPath(id) }),
      await patch(id, { listed: false }),
    ]) {
      assert.equal(response.statusCode, 404);
      assert.equal(response.json().code, 'agent_not_found');
    }
  }
  owners.set(agentId(1), 'signed_out');
  assert.equal((await app.inject({ url: settingsPath(agentId(1)) })).statusCode, 401);
});

test('the app: routes are on, the owner reads and writes, another account gets 404', async (t) => {
  const { app, cookie } = await fixture(t);
  const created = await app.inject({
    method: 'POST',
    url: '/api/agents',
    headers: { ...jsonHeaders, cookie },
    payload: JSON.stringify({ name: 'Scout', capability: 'research', mode: 'hosted' }),
  });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().agent.id as string;
  const call = (method: 'GET' | 'PATCH', url: string, who: string | null, body?: unknown) =>
    app.inject({
      method,
      url,
      headers: { ...jsonHeaders, ...(who ? { cookie: who } : {}) },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });

  const own = await call('GET', settingsPath(id), cookie);
  assert.equal(own.statusCode, 200, own.body);
  assert.deepEqual(own.json(), { listed: false, invitations: 'ask' });

  // No Base ID yet: listing is refused, invitations can be set.
  const refused = await call('PATCH', settingsPath(id), cookie, { listed: true });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().code, 'not_base_agent');
  const never = await call('PATCH', settingsPath(id), cookie, { invitations: 'never' });
  assert.equal(never.statusCode, 200, never.body);
  assert.deepEqual((await call('GET', settingsPath(id), cookie)).json(), {
    listed: false,
    invitations: 'never',
  });

  const registered = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({ name: 'Other', password: 'Synthetic directory password other' }),
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const other = `cc_session=${registered.cookies.find((entry) => entry.name === 'cc_session')!.value}`;
  for (const response of [
    await call('GET', settingsPath(id), other),
    await call('PATCH', settingsPath(id), other, { invitations: 'ask' }),
    await call('GET', settingsPath(randomUUID()), cookie),
  ]) {
    assert.equal(response.statusCode, 404, response.body);
    assert.equal(response.json().code, 'agent_not_found');
  }
  assert.equal((await call('GET', settingsPath(id), null)).statusCode, 401);
  // The owner's settings are unchanged by the other account's attempt.
  assert.equal((await call('GET', settingsPath(id), cookie)).json().invitations, 'never');

  const page = await app.inject({ url: `${DIRECTORY_PATHS.search}?q=scout` });
  assert.equal(page.statusCode, 200, page.body);
  assert.deepEqual(page.json(), { agents: [], next: null });
});
