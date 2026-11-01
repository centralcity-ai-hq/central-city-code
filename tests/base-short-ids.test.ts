import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import type { Database } from '../server/database.js';
import { BASE_MIGRATION_SQL, baseShortIdsMigration } from '../server/base/schema.js';
import {
  DESCRIPTION_MAX,
  REGISTRATION_V1,
  standardDescription,
} from '../shared/base/registration.js';
import {
  DOMAIN_PAGES_PATH,
  DOMAIN_PAGE_SIZE,
  REGISTRATION_LIVE,
  ensureShortId,
  registerShortLinks,
} from '../server/base/identity/short-links.js';
import { BASE_DOMAIN_FILES_SQL, buildDomainFile } from '../server/base/identity/domain-file.js';
import { AGENT_ROWS_SQL } from '../server/agent-rows/schema.js';
import { WORKSPACE_AGENT_PATH_SQL } from '../server/agent-rows/agent-lookup-schema.js';
import { AGENT_PUBLIC_CARDS_SQL } from '../server/agent-rows/public-cards-schema.js';
import { backfillPublicCards } from '../server/agent-rows/public-cards.js';
import {
  MAX_AGENT_URI_BYTES,
  isShortId,
  newShortId,
  shortAgentUri,
} from '../shared/base/short-id.js';
import { BASE_IDENTITY_MOVES_SQL } from '../server/base/identity/moves.js';
import { BASE_IDENTITIES_BASE_ID_SQL } from '../server/base/explorer/base-id-index-schema.js';

test('the on-chain agent URI is exactly one storage slot (≤ 31 bytes)', () => {
  for (let i = 0; i < 1000; i++) {
    const id = newShortId();
    assert.ok(isShortId(id), id);
    assert.ok(Buffer.byteLength(shortAgentUri(id)) <= MAX_AGENT_URI_BYTES);
  }
  assert.equal(shortAgentUri('abc123'), 'https://centralcity.ai/a/abc123');
  assert.equal(Buffer.byteLength('https://centralcity.ai/a/abc123'), 31);
  assert.throws(() => shortAgentUri('abc12'));
  assert.throws(() => shortAgentUri('abc123', 'https://www.centralcity.ai'));
});

async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(baseShortIdsMigration.sql);
  await pg.exec(
    "CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws');",
  );
  await pg.exec(BASE_MIGRATION_SQL);
  // Migration 85's provisional id column (its checks need operations these rows do not have) and
  // the Base ID index (255) the domain file's scoped read and its pages go through.
  await pg.exec(
    'ALTER TABLE base_identities ADD COLUMN IF NOT EXISTS provisional_agent_id numeric(78,0)',
  );
  await pg.exec(BASE_IDENTITIES_BASE_ID_SQL);
  await pg.exec(BASE_IDENTITY_MOVES_SQL);
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  return db;
}

test('an agent keeps one short id; the link serves its ERC-8004 registration file', async (t) => {
  const db = await setup(t);
  const id = await ensureShortId(db, 'agent-1');
  assert.equal(await ensureShortId(db, 'agent-1'), id);
  const privateId = await ensureShortId(db, 'agent-2');
  assert.notEqual(privateId, id);
  await db.query(
    `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address,
       erc8004_agent_id, agent_card_uri, owner_of_identity, state, updated_at)
     VALUES ('agent-1', 8453, 'ws', '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', 4711,
       'https://centralcity.ai/a/x', '0x1', 'confirmed', 1),
            ('agent-1', 84532, 'ws', '0x8004A818BFB912233c491871b3d84c89A494BD9e', NULL,
       'https://centralcity.ai/a/x', '0x1', 'pending', 1)`,
  );
  const app = Fastify();
  t.after(() => app.close());
  // The public card: agent-1's; agent-2 has none that is public.
  const card = async (agentId: string) =>
    agentId === 'agent-1'
      ? {
          name: 'Harbor',
          description: 'Research agent',
          supportedInterfaces: [{ protocolVersion: '1.0' }],
        }
      : null;
  registerShortLinks(app, { db, originOf: () => 'https://centralcity.ai', card });
  const ok = await app.inject({ url: `/a/${id}`, headers: { host: 'centralcity.ai' } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['access-control-allow-origin'], '*');
  assert.deepEqual(ok.json(), {
    type: REGISTRATION_V1,
    name: 'Harbor',
    description: `Research agent. Harbor is an AI agent on Central City, where people and AI agents work together in shared rooms. Registered on Base through Central City. Passport: centralcity.ai/a/${id}`,
    image: 'https://centralcity.ai/brand/directory-icon-1024.png',
    services: [
      {
        name: 'A2A',
        endpoint: 'https://centralcity.ai/a2a/agent-1/.well-known/agent-card.json',
        version: '1.0',
      },
      // The passport page, the human view of the same registration.
      { name: 'web', endpoint: `https://centralcity.ai/a/${id}` },
    ],
    x402Support: false,
    active: true,
    registrations: [
      { agentId: 4711, agentRegistry: 'eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' },
    ],
    supportedTrust: ['reputation'],
  });
  assert.equal((await app.inject({ url: `/a/${privateId}` })).statusCode, 404);
  assert.equal((await app.inject({ url: '/a/zzzzzz' })).statusCode, 404);
  assert.equal((await app.inject({ url: '/a/bad!' })).statusCode, 404);
});

test('the domain file lists exactly the confirmed agents with a public card at this origin', async (t) => {
  const db = await setup(t);
  // The card route's sources: the workspace's agent list and the manifests (minimal columns).
  await db.exec(`
    CREATE TABLE workspaces (operator_id text PRIMARY KEY, data jsonb NOT NULL);
    CREATE TABLE agent_manifests (agent_id text, operator_id text, revision int, manifest jsonb);
  `);
  const agents = [
    { id: 'public', visibility: 'public' },
    { id: 'private', visibility: 'private' },
    { id: 'revoked', visibility: 'public', revokedAt: '2026-10-01T00:00:00Z' },
    { id: 'pending', visibility: 'public' },
    { id: 'elsewhere', visibility: 'public' },
    { id: 'old-public', visibility: 'private', earlier: 'public' },
  ];
  await db.query('INSERT INTO workspaces VALUES ($1, $2)', [
    'ws',
    JSON.stringify({
      agents: agents.map((agent) => ({
        id: agent.id,
        revision: 2,
        ...(agent.revokedAt ? { revokedAt: agent.revokedAt } : {}),
      })),
    }),
  ]);
  for (const agent of agents) {
    await db.query('INSERT INTO agent_manifests VALUES ($1, $2, 2, $3)', [
      agent.id,
      'ws',
      JSON.stringify({ spec: { visibility: agent.visibility } }),
    ]);
    // An earlier revision's visibility never counts.
    if (agent.earlier)
      await db.query('INSERT INTO agent_manifests VALUES ($1, $2, 1, $3)', [
        agent.id,
        'ws',
        JSON.stringify({ spec: { visibility: agent.earlier } }),
      ]);
  }
  const registry = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
  let n = 100;
  for (const agent of agents) {
    const short = await ensureShortId(db, agent.id);
    n += 1;
    const origin = agent.id === 'elsewhere' ? 'https://example.com' : 'https://centralcity.ai';
    await db.query(
      `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address,
         erc8004_agent_id, agent_card_uri, owner_of_identity, state, updated_at)
       VALUES ($1, 8453, 'ws', $2, $3, $4, '0x1', $5, 1)`,
      [
        agent.id,
        registry,
        agent.id === 'pending' ? null : n,
        `${origin}/a/${short}`,
        agent.id === 'pending' ? 'pending' : 'confirmed',
      ],
    );
  }
  // The public cards (280) arrive after these agents, as on a database that had them: the file is
  // built by the workspace documents' rule first, then from the backfilled cards, the same.
  for (const sql of [
    AGENT_ROWS_SQL,
    WORKSPACE_AGENT_PATH_SQL,
    AGENT_PUBLIC_CARDS_SQL,
    BASE_DOMAIN_FILES_SQL,
  ])
    await db.exec(sql);
  for (const ready of [false, true]) {
    if (ready) assert.equal((await backfillPublicCards(db)).ready, true);
    await buildDomainFile(db, 'https://centralcity.ai', { logLine: () => {} });
    await buildDomainFile(db, 'https://preview.example', { logLine: () => {} });
    const app = Fastify();
    t.after(() => app.close());
    registerShortLinks(app, { db, originOf: () => 'https://centralcity.ai' });
    const res = await app.inject({ url: '/.well-known/agent-registration.json' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.equal(res.headers['cache-control'], REGISTRATION_LIVE);
    assert.match(String(res.headers['content-type']), /^application\/json/);
    assert.deepEqual(res.json(), {
      registrations: [{ agentId: 101, agentRegistry: `eip155:8453:${registry}` }],
    });

    // Another origin (a preview) lists none of centralcity.ai's agents.
    const other = Fastify();
    t.after(() => other.close());
    registerShortLinks(other, { db, originOf: () => 'https://preview.example' });
    assert.deepEqual((await other.inject({ url: '/.well-known/agent-registration.json' })).json(), {
      registrations: [],
    });
  }
});

test('the domain file is scoped to the newest; the paginated companion lists every one (CCA-118)', async (t) => {
  const db = await setup(t);
  await db.exec(`
    CREATE TABLE workspaces (operator_id text PRIMARY KEY, data jsonb NOT NULL);
    CREATE TABLE agent_manifests (agent_id text, operator_id text, revision int, manifest jsonb);
  `);
  for (const sql of [
    AGENT_ROWS_SQL,
    WORKSPACE_AGENT_PATH_SQL,
    AGENT_PUBLIC_CARDS_SQL,
    BASE_DOMAIN_FILES_SQL,
  ])
    await db.exec(sql);
  const registry = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
  const other = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
  // Mainnet ids 1..2345 on one registry, plus id 1346 on a second one (two entries with one id,
  // exactly at the first page's end), Sepolia ids 1..3; one agent without a public card and one
  // whose holder moved it away are never listed.
  await db.exec(`
    INSERT INTO base_short_ids (short_id, agent_id, created_at)
      SELECT 'm' || lpad(n::text, 5, '0'), 'm' || n, 1 FROM generate_series(1, 2349) n;
    INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address,
        erc8004_agent_id, agent_card_uri, owner_of_identity, state, updated_at)
      SELECT 'm' || n, CASE WHEN n <= 2346 THEN 8453 ELSE 84532 END, 'ws',
        CASE WHEN n = 2346 THEN '${other}' ELSE '${registry}' END,
        CASE WHEN n <= 2345 THEN n WHEN n = 2346 THEN 1346 ELSE n - 2346 END,
        'https://centralcity.ai/a/m' || lpad(n::text, 5, '0'), '0x1', 'confirmed', 1
      FROM generate_series(1, 2349) n;
    INSERT INTO agent_public_cards (agent_id, operator_id, revision, name)
      SELECT 'm' || n, 'ws', 1, 'Agent' FROM generate_series(1, 2349) n;
    INSERT INTO base_short_ids VALUES ('hidden', 'hidden', 1), ('movedA', 'moved', 1);
    INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address,
        erc8004_agent_id, agent_card_uri, owner_of_identity, state, updated_at)
      VALUES ('hidden', 8453, 'ws', '${registry}', 9001, 'https://centralcity.ai/a/hidden', '0x1',
          'confirmed', 1),
        ('moved', 8453, 'ws', '${registry}', 9002, 'https://centralcity.ai/a/movedA', '0x1',
          'confirmed', 1);
    INSERT INTO agent_public_cards VALUES ('moved', 'ws', 1, 'Moved');
    INSERT INTO base_identity_moves (agent_id, chain_id, reason, moved_at)
      VALUES ('moved', 8453, 'uri', 1);
  `);
  const app = Fastify();
  t.after(() => app.close());
  registerShortLinks(app, { db, originOf: () => 'https://centralcity.ai' });
  const get = (query: string) => app.inject({ url: `${DOMAIN_PAGES_PATH}${query}` });

  // Before the public cards are backfilled a page would need every row: busy, never a partial list.
  await db.query('UPDATE agent_public_cards_backfill SET ready = false WHERE id = 1');
  const busy = await get('');
  assert.equal(busy.statusCode, 503);
  assert.equal(busy.headers['cache-control'], 'no-store');
  await db.query('UPDATE agent_public_cards_backfill SET ready = true WHERE id = 1');

  // The standard file, scoped: the newest of each chain (the cards' indexed read), id order.
  await buildDomainFile(db, 'https://centralcity.ai', { logLine: () => {}, scope: 3 });
  const file = await app.inject({ url: '/.well-known/agent-registration.json' });
  assert.deepEqual(file.json(), {
    registrations: [
      { agentId: 1, agentRegistry: `eip155:84532:${registry}` },
      { agentId: 2, agentRegistry: `eip155:84532:${registry}` },
      { agentId: 3, agentRegistry: `eip155:84532:${registry}` },
      { agentId: 2343, agentRegistry: `eip155:8453:${registry}` },
      { agentId: 2344, agentRegistry: `eip155:8453:${registry}` },
      { agentId: 2345, agentRegistry: `eip155:8453:${registry}` },
    ],
  });

  // The companion: newest first, DOMAIN_PAGE_SIZE at most, pages end between two ids.
  const seen: string[] = [];
  let next: string | null = null;
  const sizes: number[] = [];
  do {
    const res = await get(next === null ? '' : `?before=${next}`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], REGISTRATION_LIVE);
    assert.equal(res.headers['access-control-allow-origin'], '*');
    const page = res.json() as {
      registrations: Array<{ agentId: number; agentRegistry: string }>;
      chainId: number;
      nextBefore: string | null;
    };
    assert.equal(page.chainId, 8453);
    assert.ok(page.registrations.length <= DOMAIN_PAGE_SIZE);
    sizes.push(page.registrations.length);
    seen.push(...page.registrations.map((r) => `${r.agentId}@${r.agentRegistry.slice(-4)}`));
    next = page.nextBefore;
  } while (next !== null);
  assert.deepEqual(sizes, [999, 1000, 347]);
  assert.equal(new Set(seen).size, seen.length);
  assert.equal(seen.length, 2346);
  assert.deepEqual(seen.slice(998, 1001), ['1347@a432', '1346@BD9e', '1346@a432']);
  assert.equal(seen.at(-1), '1@a432');
  const sepolia = (await get('?chain=84532')).json() as { registrations: unknown[] };
  assert.equal(sepolia.registrations.length, 3);

  // Only the documented keys, each in its canonical form: never a separate edge-cache entry.
  for (const query of ['?x=1', '?chain=1', '?chain=08453', '?before=abc', '?before=01']) {
    const res = await get(query);
    assert.equal(res.statusCode, 400, query);
    assert.equal(res.headers['cache-control'], 'no-store', query);
  }
});

test('an Arc agent is registered on Arc in the standard line, a Base agent still on Base', () => {
  const standard = { name: 'Winry', passport: 'centralcity.ai/a/fjPsW7' };
  assert.match(
    standardDescription({ ...standard, chainName: 'Arc' }),
    /Registered on Arc through Central City\./,
  );
  assert.equal(
    standardDescription({ ...standard, chainName: 'Base' }),
    standardDescription(standard),
  );
  assert.match(standardDescription(standard), /Registered on Base through Central City\./);
});

test("every registration file says its own agent's name and passport in the standard line", () => {
  const line = (name: string, short: string) =>
    `${name} is an AI agent on Central City, where people and AI agents work together in shared rooms. Registered on Base through Central City. Passport: centralcity.ai/a/${short}`;
  // Its own name, never another agent's; a description that only repeats the name adds nothing.
  assert.equal(
    standardDescription({ name: 'Winry', passport: 'centralcity.ai/a/fjPsW7' }),
    line('Winry', 'fjPsW7'),
  );
  assert.equal(
    standardDescription({
      name: 'Pinako',
      passport: 'centralcity.ai/a/R6IsTd',
      ownDescription: ' pinako ',
    }),
    line('Pinako', 'R6IsTd'),
  );
  // An owner's own words come first, ending in a full stop.
  assert.equal(
    standardDescription({
      name: 'Harbor',
      passport: 'centralcity.ai/a/Hb7Qx2',
      ownDescription: 'Finds and checks sources',
    }),
    `Finds and checks sources. ${line('Harbor', 'Hb7Qx2')}`,
  );
  // A long one is shortened at a word so the whole text fits, and the standard line stays whole.
  const long = standardDescription({
    name: 'Harbor',
    passport: 'centralcity.ai/a/Hb7Qx2',
    ownDescription: 'word '.repeat(200),
  });
  assert.ok(long.length <= DESCRIPTION_MAX, String(long.length));
  assert.ok(long.endsWith(line('Harbor', 'Hb7Qx2')));
  assert.match(long, /^(word )+word… Harbor is an AI agent/);
  // Line breaks and runs of spaces in a name or description never reach the file.
  assert.equal(
    standardDescription({ name: 'Two\n  words', passport: 'centralcity.ai/a/Tw0Wds' }),
    line('Two words', 'Tw0Wds'),
  );
});
