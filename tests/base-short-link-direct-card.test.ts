import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { btree_gin } from '@electric-sql/pglite/contrib/btree_gin';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../server/app.js';
import type { Database } from '../server/database.js';
import { publicAgentCard } from '../server/manifest/card-agent.js';
import { buildRegistrationFile, standardDescription } from '../shared/base/registration.js';
import { PASSWORD } from './oauth-helpers.js';

// /a/<id> reads the agent's public card directly instead of requesting the card route with an
// internal app.inject. The file must stay byte-for-byte what the card route path produced.

const ORIGIN = 'https://centralcity.ai';
const HOST = 'centralcity.ai';
const REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

/** The previous /a/<id>: the card route asked over app.inject, then the same file built from it. */
async function viaCardRoute(app: FastifyInstance, db: Database, id: string) {
  const agentId = (
    await db.query<{ agent_id: string }>(
      'SELECT agent_id FROM base_short_ids WHERE short_id = $1',
      [id],
    )
  ).rows[0]!.agent_id;
  const cardPath = `/a2a/${encodeURIComponent(agentId)}/.well-known/agent-card.json`;
  const card = await app.inject({ method: 'GET', url: cardPath, headers: { host: HOST } });
  if (card.statusCode !== 200) return { status: 404, body: '' };
  const parsed = card.json() as {
    name?: unknown;
    description?: unknown;
    iconUrl?: unknown;
    supportedInterfaces?: Array<{ protocolVersion?: unknown }>;
  };
  const identities = await db.query<{
    chain_id: number;
    registry_address: string;
    erc8004_agent_id: string;
    updated_at: string | number;
  }>(
    `SELECT chain_id, registry_address, erc8004_agent_id::text AS erc8004_agent_id, updated_at
     FROM base_identities WHERE agent_id = $1 AND state = 'confirmed'
       AND erc8004_agent_id IS NOT NULL ORDER BY chain_id`,
    [agentId],
  );
  const version = parsed.supportedInterfaces?.[0]?.protocolVersion;
  const name =
    typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name : 'Central City agent';
  return {
    status: 200,
    body: JSON.stringify(
      buildRegistrationFile({
        name,
        description: standardDescription({
          name,
          passport: `${HOST}/a/${id}`,
          ...(typeof parsed.description === 'string' ? { ownDescription: parsed.description } : {}),
        }),
        image:
          typeof parsed.iconUrl === 'string'
            ? parsed.iconUrl
            : `${ORIGIN}/brand/directory-icon-1024.png`,
        cardUrl: `${ORIGIN}${cardPath}`,
        webUrl: `${ORIGIN}/a/${id}`,
        updatedAtMs: Math.max(0, ...identities.rows.map((row) => Number(row.updated_at) || 0)),
        ...(typeof version === 'string' ? { a2aVersion: version } : {}),
        identities: identities.rows.map((row) => ({
          chainId: row.chain_id,
          registry: row.registry_address,
          erc8004AgentId: row.erc8004_agent_id,
        })),
      }),
    ),
    card: card.json() as Record<string, unknown>,
  };
}

test('/a/<id> read directly is byte-for-byte the file the card route path made', async (t) => {
  process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-short-link-direct-card-root-secret';
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
    payload: JSON.stringify({ name: 'Card owner', password: PASSWORD }),
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
  const create = async (body: Record<string, unknown>) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: { ...headers, cookie },
      payload: JSON.stringify(body),
    });
    assert.equal(res.statusCode, 201, res.body);
    return (res.json() as { agent: { id: string } }).agent.id;
  };
  const agents = {
    open: await create({
      name: 'Alphonse',
      description: 'Turns text into a short brief.',
      capability: 'research',
      mode: 'hosted',
      visibility: 'public',
    }),
    bare: await create({
      name: 'Bea',
      capability: 'research',
      mode: 'hosted',
      visibility: 'public',
    }),
    hidden: await create({
      name: 'Cyril',
      description: 'Private helper.',
      capability: 'research',
      mode: 'hosted',
      visibility: 'private',
    }),
  };
  const operator = (
    await db.query<{ operator_id: string }>(
      'SELECT operator_id FROM agent_manifests WHERE agent_id = $1 LIMIT 1',
      [agents.open],
    )
  ).rows[0]!.operator_id;
  const shorts = { open: 'Aopen1', bare: 'Abare1', hidden: 'Ahid01' };
  let n = 0;
  for (const key of ['open', 'bare', 'hidden'] as const) {
    n += 1;
    await db.query('INSERT INTO base_short_ids VALUES ($1, $2, 1)', [shorts[key], agents[key]]);
    await db.query(
      `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address,
         erc8004_agent_id, agent_card_uri, owner_of_identity, state, updated_at,
         provisional_agent_id, transfer_op_id, handover_id)
       VALUES ($1, 8453, $2, $3, $4, $5, '0x1', 'confirmed', $6, $4, $7, $4)`,
      [
        agents[key],
        operator,
        REGISTRY,
        4700 + n,
        `${ORIGIN}/a/${shorts[key]}`,
        1_000 + n,
        `identity:transfer:8453:${agents[key]}`,
      ],
    );
  }

  for (const key of ['open', 'bare'] as const) {
    const before = await viaCardRoute(app, db, shorts[key]);
    assert.equal(before.status, 200, key);
    const now = await app.inject({
      url: `/a/${shorts[key]}`,
      headers: { host: HOST, accept: 'application/json' },
    });
    assert.equal(now.statusCode, 200, `${key}: ${now.body}`);
    assert.equal(now.body, before.body, key);
    // The card it reads is the card route's own, without the signature.
    const { signatures: _signatures, ...unsigned } = before.card!;
    assert.deepEqual(await publicAgentCard(db, agents[key], ORIGIN), unsigned, key);
  }

  // A private card: 404 both ways, and no card to read.
  assert.equal((await viaCardRoute(app, db, shorts.hidden)).status, 404);
  const hidden = await app.inject({
    url: `/a/${shorts.hidden}`,
    headers: { host: HOST, accept: 'application/json' },
  });
  assert.equal(hidden.statusCode, 404);
  assert.equal(await publicAgentCard(db, agents.hidden, ORIGIN), null);
});
