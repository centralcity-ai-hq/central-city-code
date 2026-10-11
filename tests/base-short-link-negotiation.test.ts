import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import {
  REGISTRATION_LIVE,
  registerShortLinks,
  wantsHtml,
} from '../server/base/identity/short-links.js';
import { buildRegistrationFile, standardDescription } from '../shared/base/registration.js';
import { REGISTRY, add, agentId, setup, shortOf } from './on-base-fixture.js';

test('wantsHtml: text/html without any JSON type gets the page, everything else the file', () => {
  const browser =
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
  for (const accept of [browser, 'text/html', 'TEXT/HTML', 'text/html;q=0.9, */*;q=0.1'])
    assert.equal(wantsHtml(accept), true, accept);
  for (const accept of [
    undefined,
    '',
    '*/*',
    'application/json',
    'application/ld+json',
    'application/xhtml+xml',
    'text/html, application/json',
    'application/json, text/html;q=0.5',
    'text/html;q=0.4, application/activity+json;q=0.5',
  ])
    assert.equal(wantsHtml(accept), false, String(accept));
});

test('/a/<id> keeps the registration file byte-identical for resolvers and varies on Accept', async (t) => {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 4711 });
  const short = shortOf(1);
  const card = (app: ReturnType<typeof Fastify>) =>
    app.get('/a2a/:agentId/.well-known/agent-card.json', async () => ({
      name: 'Harbor',
      description: 'Research agent',
      supportedInterfaces: [{ protocolVersion: '1.0' }],
    }));
  const file = JSON.stringify(
    buildRegistrationFile({
      name: 'Harbor',
      // The file carries the standard line after the card's own description (#152).
      description: standardDescription({
        name: 'Harbor',
        passport: `centralcity.ai/a/${short}`,
        ownDescription: 'Research agent',
      }),
      image: 'https://centralcity.ai/brand/directory-icon-1024.png',
      cardUrl: `https://centralcity.ai/a2a/${agentId(1)}/.well-known/agent-card.json`,
      a2aVersion: '1.0',
      identities: [{ chainId: 8453, registry: REGISTRY, erc8004AgentId: '4711' }],
    }),
  );
  const resolvers = [{}, { accept: '*/*' }, { accept: 'application/json' }];

  // Without a page (today): every client, a browser included, gets the same bytes.
  const plain = Fastify();
  t.after(() => plain.close());
  card(plain);
  registerShortLinks(plain, { db, originOf: () => 'https://centralcity.ai' });
  for (const headers of [...resolvers, { accept: 'text/html' }]) {
    const response = await plain.inject({ url: `/a/${short}`, headers });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, file);
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(response.headers.vary, 'Accept');
    assert.equal(response.headers['cache-control'], REGISTRATION_LIVE);
  }
  const unknown = await plain.inject({ url: '/a/zzzzzz' });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.headers.vary, 'Accept');

  // With the passport page: browsers get it, resolvers still get the same bytes.
  const paged = Fastify();
  t.after(() => paged.close());
  card(paged);
  registerShortLinks(paged, {
    db,
    originOf: () => 'https://centralcity.ai',
    page: (_request, reply) => reply.type('text/html').send('<!doctype html><title>page</title>'),
  });
  const page = await paged.inject({
    url: `/a/${short}`,
    headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
  });
  assert.equal(page.statusCode, 200);
  assert.match(String(page.headers['content-type']), /^text\/html/);
  assert.equal(page.headers.vary, 'Accept');
  assert.equal(page.headers['cache-control'], 'no-cache');
  for (const headers of [...resolvers, { accept: 'text/html, application/json' }]) {
    const response = await paged.inject({ url: `/a/${short}`, headers });
    assert.equal(response.body, file);
    assert.equal(response.headers.vary, 'Accept');
  }
});

test('/a/<x> reads x only as a short id, even when it is all digits', async (t) => {
  const db = await setup(t);
  // Base ID 123456 belongs to agent 1 (short id S00001); agent 2's short id is "123456".
  await add(db, { n: 1, kind: 'final', id: 123456 });
  await add(db, { n: 2, kind: 'final', id: 777 });
  await db.query("UPDATE base_short_ids SET short_id = '123456' WHERE agent_id = $1", [agentId(2)]);
  const app = Fastify();
  t.after(() => app.close());
  app.get('/a2a/:agentId/.well-known/agent-card.json', async () => ({ name: 'Harbor' }));
  registerShortLinks(app, { db, originOf: () => 'https://centralcity.ai' });
  const file = (await app.inject({ url: '/a/123456' })).json() as {
    registrations: Array<{ agentId: number }>;
  };
  assert.deepEqual(
    file.registrations.map((entry) => entry.agentId),
    [777],
  );
  assert.equal((await app.inject({ url: '/a/12345' })).statusCode, 404);
});

test("Verify's two-way binding: a JSON fetch of the URI Base holds gets the file, not the page", async (t) => {
  const db = await setup(t);
  await add(db, { n: 1, kind: 'final', id: 99029 });
  const short = shortOf(1);
  const app = Fastify();
  t.after(() => app.close());
  app.get('/a2a/:agentId/.well-known/agent-card.json', async () => ({ name: 'Harbor' }));
  registerShortLinks(app, {
    db,
    originOf: () => 'https://centralcity.ai',
    page: (_request, reply) => reply.type('text/html').send('<!doctype html><title>page</title>'),
  });
  // Today's bytes, before the page existed.
  const before = Fastify();
  t.after(() => before.close());
  before.get('/a2a/:agentId/.well-known/agent-card.json', async () => ({ name: 'Harbor' }));
  registerShortLinks(before, { db, originOf: () => 'https://centralcity.ai' });
  const today = (await before.inject({ url: `/a/${short}` })).body;

  // A browser fetch() sends */* unless told otherwise; Verify asks for application/json.
  for (const accept of ['application/json', '*/*', 'application/json, text/plain, */*']) {
    const response = await app.inject({ url: `/a/${short}`, headers: { accept } });
    assert.equal(response.statusCode, 200, accept);
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8', accept);
    assert.equal(response.headers.vary, 'Accept', accept);
    assert.equal(response.body, today, accept);
    const file = response.json() as {
      registrations: Array<{ agentId: number | string; agentRegistry: string }>;
    };
    assert.deepEqual(file.registrations, [
      { agentId: 99029, agentRegistry: `eip155:8453:${REGISTRY}` },
    ]);
  }
  // Only a request that prefers a page gets one.
  const page = await app.inject({ url: `/a/${short}`, headers: { accept: 'text/html' } });
  assert.match(String(page.headers['content-type']), /^text\/html/);
  assert.equal(page.headers.vary, 'Accept');
});
