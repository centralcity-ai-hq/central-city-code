import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../server/database.js';
import type { RoomInvitationDependencies } from '../server/rooms/invitations.js';
import type { FeedRespondDependencies } from '../server/feed/respond.js';
import { createApp } from '../server/app.js';
import { BASE_NETWORKS } from '../shared/base/chains.js';
import { AGENT_URI_ORIGIN } from '../shared/base/on-base.js';
import { INVITE_PATHS, type ReceivedInvitation, type SentInvitation } from '../shared/directory.js';

process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-room-invitations-test-root-secret';

/*
 * The room invitations fixture (Operation Directory D2, server/rooms/invitations.ts): the whole
 * app, a host with a room, and accounts whose agents are seeded as Central City agents with a
 * passport, registered as the identity service leaves a final (or finalizing) one, with optional
 * directory settings (synthetic, low-entropy values only). PGlite by default; `database` runs it
 * on PostgreSQL (the race suite) and `pause` stops a transaction at a named point.
 * agent_directory is migration 100 (Operation Directory D1).
 */

const AGENT_DIRECTORY_SQL = `
CREATE TABLE IF NOT EXISTS agent_directory (
  agent_id text PRIMARY KEY,
  listed boolean NOT NULL DEFAULT false,
  invitations text NOT NULL DEFAULT 'ask' CHECK (invitations IN ('ask','never')),
  updated_at timestamptz NOT NULL DEFAULT now()
);`;
const REGISTRY = BASE_NETWORKS[8453].contracts.identityRegistry!;
const headers = {
  'content-type': 'application/json',
  'x-city-request': '1',
  host: 'centralcity.ai',
  origin: 'https://centralcity.ai',
};
const hex2 = (n: number) => n.toString(16).padStart(2, '0');
const tail = (n: number) => `${hex2(n >> 8)}${hex2(n & 255)}`;
let address = 20;

/** The fixture's short id (passport number without CC-) for a seeded Base ID. */
export const passportOf = (baseId: string) => `S${baseId.padStart(5, '0')}`;

export type Account = { cookie: string; agentId: string; operatorId: string; name: string };

export async function fixture(
  t: { after(fn: () => Promise<unknown>): void },
  options: {
    database?: Database;
    pause?: RoomInvitationDependencies['pause'];
    /** Feed Respond's pause points (server/feed/respond.ts). */
    feedPause?: FeedRespondDependencies['pause'];
    /** The app's clock (createApp `now`); the real clock by default. */
    now?: () => number;
  } = {},
) {
  const app = await createApp({
    database: options.database ?? (await PGlite.create('memory://')),
    ...(options.pause ? { roomInvitations: { pause: options.pause } } : {}),
    ...(options.feedPause ? { feedRespond: { pause: options.feedPause } } : {}),
    ...(options.now ? { now: options.now } : {}),
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: 'https://centralcity.ai',
      allowedOrigins: ['https://centralcity.ai'],
    },
    startWorkers: false,
  });
  t.after(() => app.close());
  const db = app.city.db;
  await db.exec(AGENT_DIRECTORY_SQL);
  const send = (method: string, url: string, cookie: string, body?: unknown) =>
    app.inject({
      method: method as 'POST',
      url,
      headers: { ...headers, cookie },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      remoteAddress: '203.0.113.12',
    });
  const account = async (name: string): Promise<Account> => {
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers,
      payload: JSON.stringify({ name, password: 'Synthetic invitations password' }),
      remoteAddress: `203.0.113.${address++}`,
    });
    assert.equal(registered.statusCode, 201, registered.body);
    const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
    const agent = await send('POST', '/api/agents', cookie, {
      name: `${name} agent`,
      capability: 'research',
      mode: 'hosted',
    });
    assert.equal(agent.statusCode, 201, agent.body);
    const agentId = agent.json().agent.id as string;
    const owner = await db.query<{ operator_id: string }>(
      `SELECT operator_id FROM workspaces w CROSS JOIN LATERAL jsonb_array_elements(w.data->'agents') a
        WHERE a->>'id'=$1`,
      [agentId],
    );
    return { cookie, agentId, operatorId: owner.rows[0]!.operator_id, name: `${name} agent` };
  };
  let next = 100;
  /**
   * A Central City Base agent of `a`: its public card (displayName), wallet, short id and a FINAL
   * registration (state 'confirmed'), then its directory settings. Returns its Base ID.
   */
  const baseAgent = async (
    a: Account,
    o: {
      listed?: boolean;
      invitations?: 'ask' | 'never';
      visibility?: 'public' | 'private';
      state?: 'confirmed' | 'submitted';
      directory?: boolean;
    } = {},
  ) => {
    const n = next++;
    const short = `S${String(n).padStart(5, '0')}`;
    await db.query('DELETE FROM agent_manifests WHERE agent_id=$1', [a.agentId]);
    await db.query(
      `INSERT INTO agent_manifests(agent_id,revision,manifest_hash,manifest,created_at,operator_id)
        VALUES($1,1,'h',$2::jsonb,1,$3)`,
      [
        a.agentId,
        JSON.stringify({
          metadata: { name: `agent-${n}`, displayName: a.name },
          spec: { visibility: o.visibility ?? 'public' },
        }),
        a.operatorId,
      ],
    );
    await db.query(
      `UPDATE workspaces SET data = jsonb_set(data, '{agents}', (SELECT jsonb_agg(CASE WHEN x->>'id'=$2
          THEN x || '{"revision": 1}'::jsonb ELSE x END) FROM jsonb_array_elements(data->'agents') x))
        WHERE operator_id=$1`,
      [a.operatorId, a.agentId],
    );
    await db.query(
      `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
         spender_address, spender_key_ref, derivation, state, created_at, updated_at)
       VALUES ($1, $2, $3, 8453, $4, $5, $6, 'v1:key-0001', '{}', 'derived', 1, 1)`,
      [
        `w-${n}`,
        a.agentId,
        a.operatorId,
        `0x${'1'.repeat(36)}${tail(n)}`,
        `0x${'2'.repeat(36)}${tail(n)}`,
        `0x${'3'.repeat(36)}${tail(n)}`,
      ],
    );
    await db.query('INSERT INTO base_short_ids VALUES ($1, $2, 1)', [short, a.agentId]);
    const final = (o.state ?? 'confirmed') === 'confirmed';
    await db.query(
      `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address,
         erc8004_agent_id, agent_card_uri, owner_of_identity, state, op_id, tx_hash, updated_at,
         register_op_id, mint_op_id, provisional_agent_id, mint_tx_hash, mint_block, mint_block_hash,
         mint_finality, mint_seen_at, mint_lost_at, transfer_op_id, handover_id, handover_tx_hash,
         handover_block, handover_block_hash, handover_finality, started_at)
       VALUES ($1, 8453, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $10, $11, $9, $12, $13, $14, 1,
         NULL, $8, $11, $15, $16, $17, $14, 1)`,
      [
        a.agentId,
        a.operatorId,
        REGISTRY,
        final ? n : null,
        `${AGENT_URI_ORIGIN}/a/${short}`,
        `0x${'1'.repeat(36)}${tail(n)}`,
        final ? 'confirmed' : 'submitted',
        `identity:transfer:8453:${a.agentId}~${n}`,
        `0x${'4'.repeat(60)}${tail(n)}`,
        `identity:register:8453:${a.agentId}`,
        n,
        1000 + n,
        `0x${'6'.repeat(60)}${tail(n)}`,
        final ? 'final' : 'safe',
        `0x${'5'.repeat(60)}${tail(n)}`,
        1005 + n,
        `0x${'6'.repeat(60)}${tail(n + 1)}`,
      ],
    );
    if (o.directory !== false)
      await db.query(
        'INSERT INTO agent_directory (agent_id, listed, invitations) VALUES ($1, $2, $3)',
        [a.agentId, o.listed ?? true, o.invitations ?? 'ask'],
      );
    return String(n);
  };
  const host = await account('Invite host');
  const created = await send('POST', '/api/rooms', host.cookie, {
    name: 'Invite room',
    agent_id: host.agentId,
    idempotency_key: randomUUID(),
  });
  assert.equal(created.statusCode, 201, created.body);
  const roomId = created.json().room.id as string;
  const roomPath = (room = roomId) => INVITE_PATHS.room.replace(':room', room);
  /** By passport number (CC-<short>) unless extra says otherwise (passport/baseId). */
  const invite = (
    baseId: string,
    extra: Partial<{
      note: string;
      idempotencyKey: string;
      fromAgentId: string;
      passport: string | undefined;
      baseId: string | undefined;
    }> = {},
    who: Account = host,
    room = roomId,
  ) =>
    send('POST', roomPath(room), who.cookie, {
      passport: `CC-${passportOf(baseId)}`,
      fromAgentId: who.agentId,
      note: 'Join us for the market study.',
      idempotencyKey: randomUUID(),
      ...extra,
    });
  const sent = async (room = roomId) => {
    const res = await send('GET', roomPath(room), host.cookie);
    assert.equal(res.statusCode, 200, res.body);
    return res.json().invitations as SentInvitation[];
  };
  const received = async (a: Account) => {
    const res = await send('GET', INVITE_PATHS.received.replace(':agentId', a.agentId), a.cookie);
    assert.equal(res.statusCode, 200, res.body);
    return res.json().invitations as ReceivedInvitation[];
  };
  const decide = (a: Account, id: string, decision: string, agentId = a.agentId) =>
    send('POST', INVITE_PATHS.decide.replace(':agentId', agentId).replace(':id', id), a.cookie, {
      decision,
    });
  const messages = (a: Account, room = roomId) =>
    send('GET', `/api/rooms/${room}/messages`, a.cookie);
  const texts = async (a: Account) => {
    const res = await messages(a);
    assert.equal(res.statusCode, 200, res.body);
    return (res.json().messages as Array<{ parts: Array<{ text?: string }> }>).map(
      (m) => m.parts[0]?.text ?? '',
    );
  };
  return {
    app,
    db,
    send,
    account,
    baseAgent,
    host,
    roomId,
    roomPath,
    invite,
    sent,
    received,
    decide,
    messages,
    texts,
  };
}
