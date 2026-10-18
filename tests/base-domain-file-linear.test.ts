import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import {
  DOMAIN_SNAPSHOT,
  ensureShortId,
  registerShortLinks,
} from '../server/base/identity/short-links.js';
import type { Database } from '../server/database.js';
import { BASE_MIGRATION_SQL, baseShortIdsMigration } from '../server/base/schema.js';

async function setup(t: { after: (fn: () => Promise<unknown>) => void }): Promise<Database> {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(baseShortIdsMigration.sql);
  await pg.exec(
    "CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws-a'), ('ws-b'), ('ws-c');",
  );
  await pg.exec(BASE_MIGRATION_SQL);
  return {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
}

// The domain file's query was an EXISTS that expanded a whole workspace once per identity; with
// workspaces of 10,000+ agents it could no longer finish (15 Oct 2026). The linear form must list
// exactly the same registrations. The old query is kept here as the reference.
const BEFORE = `SELECT i.chain_id, i.registry_address,
    i.erc8004_agent_id::text AS erc8004_agent_id
  FROM base_identities i
  JOIN base_short_ids s ON s.agent_id = i.agent_id
  WHERE i.state = 'confirmed' AND i.erc8004_agent_id IS NOT NULL
    AND i.agent_card_uri = $1 || '/a/' || s.short_id
    AND EXISTS (
      SELECT 1 FROM workspaces w
      CROSS JOIN LATERAL jsonb_array_elements(w.data->'agents') a
      JOIN agent_manifests m ON m.agent_id = a->>'id' AND m.revision = (a->>'revision')::int
      WHERE w.operator_id = (SELECT operator_id FROM agent_manifests
                              WHERE agent_id = i.agent_id LIMIT 1)
        AND a->>'id' = i.agent_id AND a->>'revokedAt' IS NULL
        AND m.manifest->'spec'->>'visibility' = 'public')
  ORDER BY i.erc8004_agent_id, i.chain_id`;

const ORIGIN = 'https://centralcity.ai';
const REGISTRY = {
  8453: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  84532: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
} as const;

test('the linear domain file lists exactly what the per-identity query listed', async (t) => {
  const db = await setup(t);
  await db.exec(`
    CREATE TABLE workspaces (operator_id text PRIMARY KEY, data jsonb NOT NULL);
    CREATE TABLE agent_manifests (agent_id text, operator_id text, revision int, manifest jsonb);
  `);
  type Agent = {
    id: string;
    workspace: string;
    manifestOperator?: string;
    visibility: 'public' | 'private';
    earlier?: 'public' | 'private';
    revoked?: boolean;
    listedTwice?: boolean;
    unlisted?: boolean;
    splitManifests?: boolean;
    identities: Array<{ chain: 8453 | 84532; state: 'confirmed' | 'pending'; origin?: string }>;
  };
  const agents: Agent[] = [];
  // Three workspaces; every combination the rule distinguishes, several times over.
  let n = 0;
  for (const workspace of ['ws-a', 'ws-b', 'ws-c'])
    for (const visibility of ['public', 'private'] as const)
      for (const revoked of [false, true])
        for (const shape of [
          'split',
          'plain',
          'twice',
          'moved',
          'unlisted',
          'earlier',
          'two-chains',
          'pending',
          'elsewhere',
        ])
          agents.push({
            id: `agent-${(n += 1)}`,
            workspace,
            visibility,
            revoked,
            ...(shape === 'twice' ? { listedTwice: true } : {}),
            // Its manifests name another workspace: the card route reads that one, where it isn't.
            ...(shape === 'moved'
              ? { manifestOperator: workspace === 'ws-a' ? 'ws-b' : 'ws-a' }
              : {}),
            ...(shape === 'unlisted' ? { unlisted: true } : {}),
            ...(shape === 'split' ? { splitManifests: true } : {}),
            ...(shape === 'earlier'
              ? { earlier: visibility === 'public' ? 'private' : 'public' }
              : {}),
            identities:
              shape === 'two-chains'
                ? [
                    { chain: 8453, state: 'confirmed' },
                    { chain: 84532, state: 'confirmed' },
                  ]
                : shape === 'pending'
                  ? [{ chain: 8453, state: 'pending' }]
                  : shape === 'elsewhere'
                    ? [{ chain: 8453, state: 'confirmed', origin: 'https://example.com' }]
                    : [{ chain: 8453, state: 'confirmed' }],
          });
  for (const workspace of ['ws-a', 'ws-b', 'ws-c']) {
    const list = agents
      .filter((agent) => agent.workspace === workspace && !agent.unlisted)
      .flatMap((agent) => {
        const entry = {
          id: agent.id,
          revision: 2,
          ...(agent.revoked ? { revokedAt: '2026-10-01T00:00:00Z' } : {}),
        };
        return agent.listedTwice ? [entry, entry] : [entry];
      });
    await db.query('INSERT INTO workspaces VALUES ($1, $2)', [
      workspace,
      JSON.stringify({ agents: list }),
    ]);
  }
  let id = 1000;
  for (const agent of agents) {
    const operator = agent.manifestOperator ?? agent.workspace;
    await db.query('INSERT INTO agent_manifests VALUES ($1, $2, 2, $3)', [
      agent.id,
      operator,
      JSON.stringify({ spec: { visibility: agent.visibility } }),
    ]);
    // Its first revision named another workspace (a moved agent): the old rule takes the first row.
    if (agent.splitManifests)
      await db.query('INSERT INTO agent_manifests VALUES ($1, $2, 1, $3)', [
        agent.id,
        agent.workspace === 'ws-c' ? 'ws-a' : 'ws-c',
        JSON.stringify({ spec: { visibility: 'public' } }),
      ]);
    if (agent.earlier)
      await db.query('INSERT INTO agent_manifests VALUES ($1, $2, 1, $3)', [
        agent.id,
        operator,
        JSON.stringify({ spec: { visibility: agent.earlier } }),
      ]);
    const short = await ensureShortId(db, agent.id);
    for (const identity of agent.identities) {
      id += 1;
      await db.query(
        `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address,
           erc8004_agent_id, agent_card_uri, owner_of_identity, state, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, '0x1', $7, 1)`,
        [
          agent.id,
          identity.chain,
          agent.workspace,
          REGISTRY[identity.chain],
          identity.state === 'pending' ? null : id,
          `${identity.origin ?? ORIGIN}/a/${short}`,
          identity.state,
        ],
      );
    }
  }

  const before = (await db.query(BEFORE, [ORIGIN])).rows;
  const app = Fastify();
  t.after(() => app.close());
  registerShortLinks(app, { db, originOf: () => ORIGIN });
  const file = (await app.inject({ url: '/.well-known/agent-registration.json' })).json() as {
    registrations: Array<{ agentId: number; agentRegistry: string }>;
  };
  const expected = before.map((row) => ({
    agentId: Number(row.erc8004_agent_id),
    agentRegistry: `eip155:${row.chain_id}:${row.registry_address}`,
  }));
  // Some of each kind is listed, so the comparison is not trivially empty.
  assert.ok(expected.length >= 9, `listed ${expected.length}`);
  assert.ok(expected.some((entry) => entry.agentRegistry.startsWith('eip155:84532:')));
  assert.deepEqual(file.registrations, expected);

  // The work: two statements for the whole file, and each workspace's agent list expanded at most
  // once (the old form expanded one per identity).
  const statements: Array<{ sql: string; params?: unknown[] }> = [];
  const counted: Database = {
    ...db,
    query: (sql, params) => {
      statements.push({ sql, params });
      return db.query(sql, params);
    },
    transaction: (action) =>
      db.transaction((tx) =>
        action({
          exec: (sql) => tx.exec(sql),
          query: (sql, params) => {
            statements.push({ sql, params });
            return tx.query(sql, params);
          },
        }),
      ),
  };
  const app2 = Fastify();
  t.after(() => app2.close());
  registerShortLinks(app2, { db: counted, originOf: () => ORIGIN });
  const again = await app2.inject({ url: '/.well-known/agent-registration.json' });
  assert.deepEqual(again.json(), file);
  // One read-only snapshot, then the two reads.
  assert.equal(statements.length, 3, statements.map((s) => s.sql.slice(0, 40)).join(' | '));
  assert.equal(statements[0]!.sql, DOMAIN_SNAPSHOT);
  const expanding = statements.filter((s) => s.sql.includes('jsonb_array_elements'));
  assert.equal(expanding.length, 1);
  const plan = (
    await db.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (ANALYZE, COSTS OFF) ${expanding[0]!.sql}`,
      expanding[0]!.params,
    )
  ).rows
    .map((row) => row['QUERY PLAN'])
    .join('\n');
  const loops = [...plan.matchAll(/Function Scan on jsonb_array_elements[^\n]*loops=(\d+)/g)].map(
    (match) => Number(match[1]),
  );
  assert.equal(loops.length, 1, plan);
  assert.ok(loops[0]! <= 3, `expanded ${loops[0]} times for 3 workspaces:\n${plan}`);
});
