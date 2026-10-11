import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { ownerLabel } from '../server/connections/service.js';
import { MockAdapter } from '../server/elric/adapter.js';
import type { ElricConfig } from '../server/elric/config.js';
import type { ElricModelWiring } from '../server/elric/endpoints.js';
import type { RateLimiter } from '../server/rate-limit.js';
import { defaultPiiKeyring, storeDob } from '../server/google/pii.js';

/**
 * Shared Elric test fixture: the real app (PGlite in memory, migrations, rooms, wake hook) with
 * CITY_ELRIC=1, the MockAdapter per tier, and no automatic drain (each test runs invocations
 * itself). Synthetic names and passwords only.
 */
process.env.CITY_ELRIC = '1';
process.env.CITY_ROOM_TASKS = '1';
delete process.env.CITY_ELRIC_KILL;

type App = Awaited<ReturnType<typeof createApp>>;
const headers = { 'content-type': 'application/json', 'x-city-request': '1' };

export interface Account {
  name: string;
  cookie: string;
  operatorId: string;
}
export interface Room {
  id: string;
  slug: string;
  token: string;
  link: string;
}

export const permissiveLimiter: RateLimiter = {
  hit: async () => ({ allowed: true, retryAfterMs: 0 }),
  count: async () => 0,
};

export async function elricFixture(
  t: { after: (fn: () => Promise<unknown>) => void },
  options: {
    config?: Partial<ElricConfig>;
    rateLimiter?: RateLimiter;
    /** The self-hosted model wiring instead of the mocks (tests/elric-wake.test.ts). */
    models?: ElricModelWiring;
    /** The wall clock of the run budget (default Date.now). */
    wallClock?: () => number;
    /** Receives the operator log lines of failed turns. */
    log?: (line: string) => void;
    /** Receives the retry backoff waits (default: not waited for). */
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  let now = Date.UTC(2026, 8, 30, 12, 0, 0);
  type Point = 'reserved' | 'before_tool' | 'before_post';
  let probe: ((point: Point) => Promise<void>) | undefined;
  const small = new MockAdapter('mock-small');
  const large = new MockAdapter('mock-large');
  const app: App = await createApp({
    dataDir: ':memory:',
    startWorkers: false,
    now: () => now,
    ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    elric: {
      enabled: true,
      adapterFor: options.models
        ? options.models.adapterFor
        : (tier) => (tier === 1 ? small : large),
      ...(options.models ? { models: options.models } : {}),
      ...(options.wallClock ? { wallClock: options.wallClock } : {}),
      autoDrain: false,
      // The model retry's backoff is not waited for in tests.
      sleep: options.sleep ?? (async () => {}),
      log: options.log ?? (() => {}),
      ...(options.config ? { config: options.config } : {}),
      probe: async (point) => probe?.(point),
    },
  });
  t.after(() => app.close());
  const db = app.city.db;
  const elric = app.elric!;
  const call = async (cookie: string, method: string, url: string, body?: unknown) =>
    app.inject({
      method: method as 'GET',
      url,
      headers: { ...headers, cookie },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  let addressCounter = 10;
  const account = async (name: string): Promise<Account> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers,
      payload: JSON.stringify({ name, password: `Synthetic elric password ${name}` }),
      remoteAddress: `198.51.100.${addressCounter++}`,
    });
    assert.equal(res.statusCode, 201, res.body);
    const cookie = `cc_session=${res.cookies.find((item) => item.name === 'cc_session')!.value}`;
    const operatorId = (
      await db.query<{ id: string }>('SELECT id FROM operators WHERE name=$1', [name])
    ).rows[0]!.id;
    return { name, cookie, operatorId };
  };
  /** What the future Google sign-in will write after verifying an ID token. */
  const verify = async (who: Account, verified = true) => {
    await db.query(
      `INSERT INTO elric_verified_identities(operator_id,provider,subject,email,email_verified,verified_at,created_at)
       VALUES($1,'google',$2,$3,$4,$5,$5)`,
      [who.operatorId, `sub-${who.name}`, `${who.name.toLowerCase()}@example.com`, verified, now],
    );
    // An adult date of birth (the 18+ age confirmation, server/google/pii.ts).
    await storeDob(db, defaultPiiKeyring(), who.operatorId, '1990-01-01', 'owner', now);
  };
  const agent = async (who: Account, name: string) => {
    const res = await call(who.cookie, 'POST', '/api/agents', {
      name,
      capability: 'research',
      mode: 'hosted',
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json().agent.id as string;
  };
  const addElric = async (who: Account, name?: string) => {
    const res = await call(who.cookie, 'POST', '/api/elric', name ? { name } : {});
    assert.ok(res.statusCode === 201 || res.statusCode === 200, res.body);
    return res.json().agent_id as string;
  };
  const room = async (
    host: Account,
    hostAgentId: string,
    name: string,
    history: 'full' | 'from_join' = 'full',
  ): Promise<Room> => {
    const created = await call(host.cookie, 'POST', '/api/rooms', {
      agent_id: hostAgentId,
      name,
      history,
      idempotency_key: randomUUID(),
    });
    assert.equal(created.statusCode, 201, created.body);
    const link = created.json().link.link as string;
    return {
      id: created.json().room.id,
      slug: created.json().room.slug,
      token: link.split('#')[1]!,
      link,
    };
  };
  /**
   * Joins `agentId` to the room through the API. `legacy` seeds a member's Elric directly instead:
   * a room from before only the host could add Elric (kept as is by the server). Only tests that
   * need such a room pass it, so a broken host-only guard still fails every other test.
   */
  const joinAgent = async (
    who: Account,
    r: Room,
    agentId: string,
    options: { legacy?: boolean } = {},
  ) => {
    if (options.legacy) {
      await legacyElricMember(who, r, agentId);
      return;
    }
    const res = await call(who.cookie, 'POST', `/api/rooms/${r.slug}/join`, {
      token: r.token,
      agent_id: agentId,
      idempotency_key: randomUUID(),
    });
    assert.equal(res.statusCode, 200, res.body);
  };
  /** A member's Elric already in a room before the host-only rule (left as is by the server). */
  const legacyElricMember = async (who: Account, r: Room, agentId: string) => {
    await db.query(
      `INSERT INTO room_members(room_id,agent_id,owner_id,role,owner_label,visible_from_seq,joined_at,
         joined_by,last_read_seq,kind)
       SELECT $1,$2,$3,'member',$4,
              CASE WHEN history='full' THEN 0 ELSE next_seq-1 END,$5,'the owner',
              CASE WHEN history='full' THEN 0 ELSE next_seq-1 END,'agent'
         FROM rooms WHERE id=$1`,
      [
        r.id,
        agentId,
        who.operatorId,
        ownerLabel({ id: who.operatorId, name: who.name, kind: 'owner' }),
        now,
      ],
    );
  };
  /** The signed-in person joins as themselves; returns their person member id. */
  const joinPerson = async (who: Account, r: Room, name = who.name) => {
    const res = await call(who.cookie, 'POST', '/api/rooms/join', {
      link: r.link,
      name,
      idempotency_key: randomUUID(),
    });
    assert.equal(res.statusCode, 200, res.body);
    const members = await call(who.cookie, 'GET', `/api/rooms/${r.id}/members`);
    const me = (members.json().members as Array<{ id: string; kind: string; own: boolean }>).find(
      (m) => m.own && m.kind === 'person',
    );
    assert.ok(me, members.body);
    return me.id;
  };
  /** Posts as `senderId` (a person member or an agent of `who`). */
  const say = async (who: Account, r: Room, text: string, senderId: string) => {
    now += 1000;
    const res = await call(who.cookie, 'POST', `/api/rooms/${r.id}/messages`, {
      text,
      agent_id: senderId,
      idempotency_key: randomUUID(),
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json() as {
      message: { seq: number; room_id: string };
      elric_notice?: { code: string; text: string };
    };
  };
  const invocations = async (agentId: string) =>
    (
      await db.query<{ source_seq: string; status: string; room_id: string }>(
        'SELECT source_seq,status,room_id FROM elric_invocations WHERE agent_id=$1 ORDER BY source_seq',
        [agentId],
      )
    ).rows;
  const turns = async (ownerId: string) =>
    (
      await db.query<{
        outcome: string;
        reason: string | null;
        tier: number | null;
        model: string | null;
        tool_calls: Array<{ name: string; name_hash: string; args_hash: string; status: string }>;
        posted_seq: string | null;
        invoker_kind: string;
        room_id: string;
        agent_id: string;
        cost_units: string;
        reserved_units: string;
        context_from_seq: string | null;
        context_to_seq: string | null;
        source_seq: string;
      }>('SELECT * FROM elric_turns WHERE owner_id=$1 ORDER BY created_at, source_seq, id', [
        ownerId,
      ])
    ).rows;
  const usage = async (ownerId: string) =>
    (
      await db.query<{
        short: number;
        summary: number;
        tool: number;
        reserved_units: string;
        spent_units: string;
      }>('SELECT * FROM elric_usage WHERE owner_id=$1', [ownerId])
    ).rows[0];
  const globalUsage = async () =>
    (
      await db.query<{ reserved_units: string; spent_units: string; invocations: number }>(
        'SELECT * FROM elric_global_usage',
      )
    ).rows[0];
  const messages = async (roomId: string) =>
    (
      await db.query<{ seq: string; sender_agent_id: string; parts: Array<{ text?: string }> }>(
        'SELECT seq,sender_agent_id,parts FROM room_messages WHERE room_id=$1 ORDER BY seq',
        [roomId],
      )
    ).rows;
  const textOf = (row: { parts: Array<{ text?: string }> }) =>
    row.parts.map((part) => part.text ?? '').join('');
  const adapterCalls = () => small.calls + large.calls;
  const received = () => [...small.requests, ...large.requests];

  /**
   * The standard scene: a host with an AI and a room; owner A (verified) with Elric and a person
   * member in that room.
   */
  const scene = async (roomName = 'Elric room') => {
    const host = await account(`Host ${roomName}`);
    const hostAgent = await agent(host, 'Host desk');
    const r = await room(host, hostAgent, roomName);
    const owner = await account(`Owner ${roomName}`);
    await verify(owner);
    const elricId = await addElric(owner);
    const person = await joinPerson(owner, r, 'Ann');
    // The owner is a member, not the host: a room from before the host-only rule.
    await joinAgent(owner, r, elricId, { legacy: true });
    return { host, hostAgent, room: r, owner, elricId, person };
  };

  return {
    app,
    db,
    elric,
    small,
    large,
    call,
    account,
    verify,
    agent,
    addElric,
    room,
    joinAgent,
    legacyElricMember,
    joinPerson,
    say,
    invocations,
    turns,
    usage,
    globalUsage,
    messages,
    textOf,
    adapterCalls,
    received,
    scene,
    setProbe: (fn: ((point: Point) => Promise<void>) | undefined) => {
      probe = fn;
    },
    tick: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}
