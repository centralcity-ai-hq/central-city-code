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
  REGISTRATION_LIVE,
  ensureShortId,
  registerShortLinks,
} from '../server/base/identity/short-links.js';
import {
  MAX_AGENT_URI_BYTES,
  isShortId,
  newShortId,
  shortAgentUri,
} from '../shared/base/short-id.js';

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
  // Stand-in for the card route: agent-1 is public, agent-2's card is not served.
  app.get('/a2a/:agentId/.well-known/agent-card.json', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    // Like production, the card route answers only the public host.
    if (request.headers.host !== 'centralcity.ai')
      return reply.code(403).send({ error: 'Host is not allowed.' });
    if (agentId !== 'agent-1') return reply.code(404).send({ error: 'Agent Card not found.' });
    return {
      name: 'Harbor',
      description: 'Research agent',
      supportedInterfaces: [{ protocolVersion: '1.0' }],
    };
  });
  registerShortLinks(app, { db, originOf: () => 'https://centralcity.ai' });
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
