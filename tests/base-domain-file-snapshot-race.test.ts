import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { postgresDatabase, type Database } from '../server/database.js';
import { BASE_MIGRATION_SQL, baseShortIdsMigration } from '../server/base/schema.js';
import { domainRegistrations } from '../server/base/identity/short-links.js';

// The domain file reads its identities and the public agents in two statements. Whatever another
// connection commits between them (a revocation, a card made private), both reads must see one
// snapshot: exactly what one statement at the first read would have listed, never a mix.
// Never uses production DATABASE_URL. Creates and deletes only its own isolated test database.
const url = process.env.CITY_TEST_POSTGRES_URL;
const ORIGIN = 'https://centralcity.ai';
const REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

test(
  'real PG: the domain file reads one snapshot, whatever is committed between its two reads',
  { skip: !url, timeout: 30000 },
  async (t) => {
    const name = `city_domain_snapshot_${randomBytes(6).toString('hex')}`;
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    const pools: pg.Pool[] = [];
    let created = false;
    t.after(async () => {
      try {
        await Promise.all(pools.map((pool) => pool.end()));
        if (created) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    });
    await admin.query(`CREATE DATABASE ${name}`);
    created = true;
    const isolated = new URL(url!);
    isolated.pathname = `/${name}`;
    for (let i = 0; i < 2; i++) {
      const pool = new pg.Pool({
        connectionString: isolated.toString(),
        max: 1,
        connectionTimeoutMillis: 5000,
        statement_timeout: 10000,
        lock_timeout: 5000,
      });
      // The forced DROP DATABASE in cleanup ends idle connections.
      pool.on('error', () => {});
      pools.push(pool);
    }
    const reader = postgresDatabase(pools[0]!);
    const writer = postgresDatabase(pools[1]!);
    await writer.exec(baseShortIdsMigration.sql);
    await writer.exec(
      "CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws');",
    );
    await writer.exec(BASE_MIGRATION_SQL);
    await writer.exec(`
      CREATE TABLE workspaces (operator_id text PRIMARY KEY, data jsonb NOT NULL);
      CREATE TABLE agent_manifests (agent_id text, operator_id text, revision int, manifest jsonb,
        PRIMARY KEY (agent_id, revision));
    `);
    const agents = ['revoked-later', 'private-later', 'stays'];
    await writer.query('INSERT INTO workspaces VALUES ($1, $2)', [
      'ws',
      JSON.stringify({ agents: agents.map((id) => ({ id, revision: 1 })) }),
    ]);
    let n = 4700;
    for (const [index, id] of agents.entries()) {
      await writer.query('INSERT INTO agent_manifests VALUES ($1, $2, 1, $3)', [
        id,
        'ws',
        JSON.stringify({ spec: { visibility: 'public' } }),
      ]);
      const short = `Snap0${index}`;
      await writer.query('INSERT INTO base_short_ids VALUES ($1, $2, 1)', [short, id]);
      n += 1;
      await writer.query(
        `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address,
           erc8004_agent_id, agent_card_uri, owner_of_identity, state, updated_at)
         VALUES ($1, 8453, 'ws', $2, $3, $4, '0x1', 'confirmed', 1)`,
        [id, REGISTRY, n, `${ORIGIN}/a/${short}`],
      );
    }
    const listed = (rows: Array<{ erc8004_agent_id: string }>) =>
      rows.map((row) => Number(row.erc8004_agent_id));
    assert.deepEqual(listed(await domainRegistrations(reader, ORIGIN)), [4701, 4702, 4703]);

    // Between the identities read and the public agents read, the other connection revokes one
    // agent and makes another's card private (a new revision), and commits.
    let changed = false;
    const paused: Database = {
      ...reader,
      transaction: (action) =>
        reader.transaction((tx) =>
          action({
            exec: (sql) => tx.exec(sql),
            query: async <T>(sql: string, params?: unknown[]) => {
              const result = await tx.query<T>(sql, params);
              if (!changed && sql.includes('FROM base_identities')) {
                changed = true;
                await writer.query(
                  `UPDATE workspaces SET data = jsonb_set(data, '{agents}', (
                     SELECT jsonb_agg(CASE
                       WHEN a->>'id' = 'revoked-later' THEN a || '{"revokedAt":"2026-10-15T01:45:00Z"}'
                       WHEN a->>'id' = 'private-later' THEN a || '{"revision":2}'
                       ELSE a END)
                     FROM jsonb_array_elements(data->'agents') a))
                   WHERE operator_id = 'ws'`,
                );
                await writer.query(
                  `INSERT INTO agent_manifests VALUES ('private-later', 'ws', 2, $1)`,
                  [JSON.stringify({ spec: { visibility: 'private' } })],
                );
              }
              return result;
            },
          }),
        ),
    };
    // One snapshot: what one statement at the first read listed, all three.
    assert.deepEqual(listed(await domainRegistrations(paused, ORIGIN)), [4701, 4702, 4703]);
    assert.equal(changed, true, 'the change was committed between the two reads');
    // Afterwards the revoked and the private agent are gone.
    assert.deepEqual(listed(await domainRegistrations(reader, ORIGIN)), [4703]);
  },
);
