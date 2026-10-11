import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Operator } from '../../shared/types.js';
import type { AssistantAccess, GrantIdentity } from '../assistant-access.js';
import type { Database } from '../database.js';
import type { AgentMessage, InboxPage } from '../messaging/contract.js';
import type { Guard, Messaging } from '../messaging/service.js';
import { ROOM_LIMITS, roomRefSchema, type RoomMessage } from '../rooms/contract.js';
import type { RoomPrincipal, Rooms } from '../rooms/service.js';
import type { Workspace } from '../model.js';
import { WAKE_LIMITS, WAKE_EVENTS, waitQuery, type MentionPage } from './contract.js';
import type { WakeKey } from './hub.js';
import { clientAddressKey } from '../rate-limit.js';
import { WakeError, idleKeys, type Wake, type WakeGuard, type WakePrincipal } from './service.js';
import { registerWakeCron } from './cron.js';
import { sweepLapsedTasks } from '../rooms/tasks-service.js';

/**
 * Wake-up REST and SSE (docs/WAKE.md):
 *
 * - `wait` long-poll on room reads (GET /api/rooms/:room/messages?wait=, served by a preHandler
 *   so the rooms module stays untouched) and on mentions;
 * - mentions and webhook management for the owner console and signed runtimes;
 * - GET /api/v2/stream?agent=<id>: Server-Sent Events of new inbox messages, room posts and
 *   mentions for one agent, with Last-Event-ID resume, heartbeats and a self-close before the
 *   function limit. A stream holds no database connection between reads.
 */
export interface WakeRouteDependencies {
  wake: Wake;
  /** Elric's budgeted drain, run by the same scheduled cron (only when Elric is on). */
  drainElric?: (budgetMs: number) => Promise<number>;
  db: Database;
  messaging: Messaging;
  rooms: Rooms;
  access: AssistantAccess;
  owner(request: FastifyRequest): Promise<Operator>;
  runtime(
    request: FastifyRequest,
    options?: { query?: boolean },
  ): Promise<{ operatorId: string; agentId: string; credentialHash: string }>;
  originOf(request: FastifyRequest): string;
  limit(key: string, max: number, windowMs: number): Promise<void>;
  verifyWorkspaceKey(
    token: string,
  ): Promise<{ keyId: string; operatorId: string; keyHash: string } | null>;
  verifyAccessToken(
    token: string,
    origin: string,
  ): Promise<{ grantId: string; operatorId: string; clientId: string } | null>;
  /** Vercel Cron's bearer secret for the scheduled drain (default: CRON_SECRET; unset: 404). */
  cronSecret?: string;
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const uuid = z.string().uuid();
const seqParam = z
  .string()
  .regex(/^\d{1,15}$/)
  .transform(Number);
const limitParam = (max: number) =>
  z
    .string()
    .regex(/^\d{1,3}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(max));
const pageQuery = z
  .object({
    since: seqParam.optional(),
    limit: limitParam(WAKE_LIMITS.pageSize).optional(),
    wait: waitQuery.optional(),
  })
  .strict();
const agentParams = z.object({ id: uuid }).strict();
const ackBody = z.object({ seq: z.number().int().min(0) }).strict();
const webhookBody = z
  .object({
    url: z.string().max(2048),
    events: z.array(z.enum(WAKE_EVENTS)).min(1).max(WAKE_EVENTS.length).optional(),
  })
  .strict();

/** Aborts when the client's connection closes (a long-poll or stream nobody reads any more). */
function disconnectSignal(request: FastifyRequest): { signal: AbortSignal; done(): void } {
  const controller = new AbortController();
  const socket = request.raw.socket;
  const abort = () => controller.abort();
  socket?.once?.('close', abort);
  return { signal: controller.signal, done: () => socket?.off?.('close', abort) };
}
/**
 * Node's idle-socket timeout (Fastify connectionTimeout 15 s) must outlast a 25 s wait. Called
 * only after authentication and only for a real wait, so unauthenticated sockets keep 15 s.
 */
function keepSocket(request: FastifyRequest, ms: number): void {
  request.raw.socket?.setTimeout?.(ms);
}
/** Per-source key of the shared limiter (IPv4 address or IPv6 /64). */
const sourceOf = (request: FastifyRequest) => clientAddressKey(request.ip);
/**
 * For the remote MCP endpoint, after it authenticated the caller: a tools/call with wait > 0
 * gets a socket idle timeout that outlasts the wait.
 */
export function extendForWait(request: FastifyRequest): void {
  const body = request.body as
    { method?: unknown; params?: { arguments?: { wait?: unknown } } } | undefined;
  const wait = body?.method === 'tools/call' ? body.params?.arguments?.wait : undefined;
  if (typeof wait === 'number' && wait > 0 && wait <= WAKE_LIMITS.maxWaitSeconds)
    keepSocket(request, (wait + 15) * 1000);
}

/** The inbox long-poll used by server/messaging/routes.ts. */
export function inboxWaiter(wake: Wake) {
  return async (
    request: FastifyRequest,
    operatorId: string,
    wait: number | undefined,
    read: () => Promise<InboxPage>,
  ) => {
    if (wait) keepSocket(request, (wait + 10) * 1000);
    const { signal, done } = disconnectSignal(request);
    try {
      // REST waits answer per message and stay on the per-owner (and per-source) budget; the
      // per-agent bucket is for looping tool clients only (docs/WAKE.md).
      return await wake.longPoll(
        wait,
        read,
        (page) => idleKeys('inbox', page.agent_id, page, page.messages.length),
        signal,
        { owner: operatorId, source: sourceOf(request) },
      );
    } finally {
      done();
    }
  };
}

type RoomPage = {
  room: { id: string };
  messages: RoomMessage[];
  latest_seq: number;
  next_since: number;
  has_more: boolean;
};
const roomIdle = (page: RoomPage) => idleKeys('room', page.room.id, page, page.messages.length);
const mentionIdle = (page: MentionPage) =>
  idleKeys('mention', page.agent_id, page, page.mentions.length);

/** Stream resume cursor, carried as the SSE event id (base64url JSON). */
interface Cursor {
  v: 1;
  /** Inbox seq delivered. */
  i: number;
  /** Mention seq delivered. */
  m: number;
  /** Room id -> room seq delivered. */
  r: Record<string, number>;
}
const encodeCursor = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url');
export function decodeCursor(value: string | undefined): Cursor | null {
  if (!value || value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const parsed = z
      .object({
        v: z.literal(1),
        i: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        m: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        r: z
          .record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/), z.number().int().min(0))
          .refine((value) => Object.keys(value).length <= WAKE_LIMITS.roomsPerStream),
      })
      .strict()
      .safeParse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    return parsed.success ? (parsed.data as Cursor) : null;
  } catch {
    return null;
  }
}

/** Who a stream or wake REST call acts for, and what it may read. */
interface Caller {
  operatorId: string;
  actor: string;
  scopes: readonly string[];
  /** Grant/key recheck inside each read transaction (absent for console owners). */
  guard?: WakeGuard;
  /** A signed runtime: may only act as this agent; its credential is rechecked per read. */
  runtime?: { agentId: string; credentialHash: string };
  /** Stream accounting key. */
  key: string;
}

export function registerWakeRoutes(app: FastifyInstance, d: WakeRouteDependencies): void {
  const fail = (status: number, code: string, message: string): never => {
    throw new WakeError(status, code, message);
  };
  app.addHook('onClose', async () => d.wake.close());
  // The scheduled drain of retries and expired leases (Vercel Cron, CRON_SECRET).
  registerWakeCron(app, {
    wake: d.wake,
    cronSecret: d.cronSecret ?? process.env.CRON_SECRET,
    // Room-task claims past expiry and grace are cleared on the same schedule (docs/ROOM_TASKS.md).
    sweepTasks: (limit) => sweepLapsedTasks(d.db, limit),
    ...(d.drainElric ? { drainElric: d.drainElric } : {}),
  });

  const ownerPrincipal = async (request: FastifyRequest): Promise<WakePrincipal> => ({
    operatorId: (await d.owner(request)).id,
    actor: 'the owner',
  });
  const runtimeGuard =
    (identity: { operatorId: string; agentId: string; credentialHash: string }): WakeGuard =>
    async (tx) => {
      const current = await tx.query(
        'SELECT agent_id FROM credentials WHERE agent_id=$1 AND operator_id=$2 AND token_hash=$3',
        [identity.agentId, identity.operatorId, identity.credentialHash],
      );
      if (!current.rows.length) fail(401, 'unauthorized', 'Invalid runtime credential.');
    };

  // Room read long-poll: GET /api/rooms/:room/messages?wait=N. Answered here, before the rooms
  // route handler, with the same service call and authorization (rooms.read).
  app.addHook('preHandler', async (request, reply) => {
    if (request.method !== 'GET' || request.routeOptions.url !== '/api/rooms/:room/messages')
      return;
    const raw = request.query as Record<string, unknown> | undefined;
    if (!raw || raw.wait === undefined) return;
    const query = z
      .object({
        since: seqParam.optional(),
        limit: limitParam(ROOM_LIMITS.pageSize).optional(),
        wait: waitQuery,
      })
      .strict()
      .parse(raw);
    const { room } = z.object({ room: roomRefSchema }).strict().parse(request.params);
    const principal: RoomPrincipal = {
      operatorId: (await d.owner(request)).id,
      actor: 'the owner',
      origin: d.originOf(request),
      // A person watching the room: no read cursor and no member activity (docs/MEMBER_STATUS.md).
      console: true,
    };
    const { wait, ...rest } = query;
    if (wait) keepSocket(request, (wait + 10) * 1000);
    const { signal, done } = disconnectSignal(request);
    try {
      const page = await d.wake.longPoll(
        wait,
        () => d.rooms.read(principal, { room_id: room, ...rest }) as Promise<RoomPage>,
        roomIdle,
        signal,
        { owner: principal.operatorId, source: sourceOf(request) },
      );
      return reply.send(page);
    } finally {
      done();
    }
  });

  async function mentionsPage(
    request: FastifyRequest,
    p: WakePrincipal,
    agentId: string,
    guard?: WakeGuard,
  ) {
    const { wait, ...query } = pageQuery.parse(request.query);
    if (wait) keepSocket(request, (wait + 10) * 1000);
    const { signal, done } = disconnectSignal(request);
    try {
      return await d.wake.longPoll(
        wait,
        () => d.wake.mentions(p, agentId, query, guard),
        mentionIdle,
        signal,
        { owner: p.operatorId, source: sourceOf(request) },
      );
    } finally {
      done();
    }
  }

  // Owner console (cookie session; X-City-Workspace selects a co-owned AI workspace).
  app.get('/api/mentions/summary', async (request) =>
    d.wake.mentionSummary((await d.owner(request)).id),
  );
  app.get('/api/agents/:id/mentions', async (request) => {
    const p = await ownerPrincipal(request);
    const { id } = agentParams.parse(request.params);
    return mentionsPage(request, p, id);
  });
  app.post('/api/agents/:id/mentions/ack', async (request) => {
    const p = await ownerPrincipal(request);
    const { id } = agentParams.parse(request.params);
    const { seq } = ackBody.parse(request.body);
    return d.wake.ackMentions(p, id, seq);
  });
  app.get('/api/agents/:id/wake-webhook', async (request) => {
    const p = await ownerPrincipal(request);
    const { id } = agentParams.parse(request.params);
    return d.wake.getWebhook(p, id);
  });
  app.put('/api/agents/:id/wake-webhook', async (request) => {
    const p = await ownerPrincipal(request);
    const { id } = agentParams.parse(request.params);
    return d.wake.setWebhook(p, id, webhookBody.parse(request.body));
  });
  app.delete('/api/agents/:id/wake-webhook', async (request) => {
    const p = await ownerPrincipal(request);
    const { id } = agentParams.parse(request.params);
    return d.wake.clearWebhook(p, id);
  });

  // Signed runtimes (HMAC; query-signed reads): their own agent only.
  app.get('/api/runtime/mentions', async (request) => {
    const identity = await d.runtime(request, { query: true });
    return mentionsPage(
      request,
      { operatorId: identity.operatorId, actor: `runtime ${identity.agentId}` },
      identity.agentId,
      runtimeGuard(identity),
    );
  });
  app.post('/api/runtime/mentions/ack', async (request) => {
    const identity = await d.runtime(request);
    const { seq } = ackBody.parse(request.body);
    return d.wake.ackMentions(
      { operatorId: identity.operatorId, actor: `runtime ${identity.agentId}` },
      identity.agentId,
      seq,
      runtimeGuard(identity),
    );
  });

  /** Resolves a stream caller: signed runtime; bearer grant, OAuth token or workspace key; or owner. */
  async function caller(request: FastifyRequest, workspace?: string): Promise<Caller> {
    // A signed runtime also sends its token as Bearer, so the signature decides first and a
    // failed signature never falls back to a grant lookup.
    if (typeof request.headers['x-cc-signature'] === 'string') {
      const identity = await d.runtime(request, { query: true });
      return {
        operatorId: identity.operatorId,
        actor: `runtime ${identity.agentId}`,
        scopes: ['workspace:read', 'messages:read', 'rooms:join'],
        guard: runtimeGuard(identity),
        runtime: { agentId: identity.agentId, credentialHash: identity.credentialHash },
        key: `runtime:${identity.agentId}`,
      };
    }
    const authorization = request.headers.authorization;
    if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
      const token = authorization.slice(7);
      if (token.length > 200) fail(401, 'unauthorized', 'Invalid credential.');
      let identity: GrantIdentity | null = null;
      if (token.startsWith('ccw_')) {
        const key = await d.verifyWorkspaceKey(token);
        if (key) {
          await d.limit(`workspace-key:${key.keyId}`, 120, 60_000);
          identity = { grantId: key.keyId, operatorId: key.operatorId, keyHash: key.keyHash };
        }
      } else if (token.startsWith('cca_')) {
        const access = await d.verifyAccessToken(token, d.originOf(request));
        if (access) {
          await d.limit(`assistant:${access.grantId}`, 120, 60_000);
          identity = {
            grantId: access.grantId,
            operatorId: access.operatorId,
            clientId: access.clientId,
          };
        }
      } else if (/^[A-Za-z0-9_-]{43}$/.test(token)) {
        const grant = (
          await d.db.query<{ id: string; operator_id: string }>(
            'SELECT id,operator_id FROM assistant_grants WHERE token_hash=$1',
            [sha(token)],
          )
        ).rows[0];
        if (grant) {
          await d.limit(`assistant:${grant.id}`, 120, 60_000);
          identity = { grantId: grant.id, operatorId: grant.operator_id, tokenHash: sha(token) };
        }
      }
      if (!identity) return fail(401, 'unauthorized', 'Invalid or expired credential.');
      const authority = d.access.authority(identity);
      // Current scopes now (also rejects a revoked grant or key before the stream opens).
      const scopes = await d.wake.db.transaction((tx) => authority(tx, Date.now()));
      return {
        operatorId: identity.operatorId,
        actor:
          identity.keyHash !== undefined
            ? `workspace key ${identity.grantId}`
            : `assistant grant ${identity.grantId}`,
        scopes,
        guard: (tx, time) => authority(tx, time),
        key: `grant:${identity.grantId}`,
      };
    }
    // Console owner; EventSource cannot send headers, so a co-owned workspace comes as ?workspace=.
    if (workspace) request.headers['x-city-workspace'] = workspace;
    const operator = await d.owner(request);
    return {
      operatorId: operator.id,
      actor: 'the owner',
      scopes: ['workspace:read', 'messages:read', 'rooms:join'],
      key: `owner:${operator.id}`,
    };
  }

  const open = { total: 0, agents: new Map<string, number>(), owners: new Map<string, number>() };
  const bump = (map: Map<string, number>, key: string, by: number) => {
    const next = (map.get(key) ?? 0) + by;
    if (next > 0) map.set(key, next);
    else map.delete(key);
  };

  app.get('/api/v2/stream', async (request, reply) => {
    const query = z
      .object({
        agent: uuid,
        workspace: uuid.optional(),
        last_event_id: z.string().max(4096).optional(),
      })
      .strict()
      .parse(request.query);
    const who = await caller(request, query.workspace);
    const agentId = query.agent;
    if (who.runtime && who.runtime.agentId !== agentId)
      fail(403, 'forbidden', 'A runtime may only stream its own agent.');
    const workspace = (
      await d.db.query<{ data: Workspace }>('SELECT data FROM workspaces WHERE operator_id=$1', [
        who.operatorId,
      ])
    ).rows[0]?.data;
    const agent = workspace?.agents.find((item) => item.id === agentId);
    if (!agent || agent.revokedAt)
      fail(404, 'agent_not_found', 'Agent not found in this workspace.');
    // Same rule as the tools: workspace:read plus the scope that reads each event's source.
    const readable = who.scopes.includes('workspace:read');
    const inbox = readable && who.scopes.includes('messages:read');
    const rooms = readable && who.scopes.includes('rooms:join');
    if (!inbox && !rooms)
      fail(
        403,
        'insufficient_scope',
        'Streaming needs workspace:read plus messages:read or rooms:join.',
      );
    // Shared-store budget (every instance, charged before any transaction), then this instance's caps.
    await d.wake.charge('stream', { owner: who.operatorId, source: sourceOf(request) });
    if (
      open.total >= WAKE_LIMITS.streamsPerInstance ||
      (open.agents.get(agentId) ?? 0) >= WAKE_LIMITS.streamsPerAgent ||
      (open.owners.get(who.operatorId) ?? 0) >= WAKE_LIMITS.streamsPerOwner
    )
      fail(429, 'stream_limit', 'Too many open streams; close one or use wait= long-polls.');

    const requireScope =
      (scope: string): Guard =>
      async (tx, time) => {
        const scopes = who.guard ? await who.guard(tx, time) : undefined;
        if (scopes && (!scopes.includes('workspace:read') || !scopes.includes(scope)))
          fail(403, 'insufficient_scope', `This stream no longer holds ${scope}.`);
      };
    const messagesGuard = requireScope('messages:read');
    const roomsGuard = requireScope('rooms:join');
    const principal = { operatorId: who.operatorId, actor: who.actor };
    const roomPrincipal: RoomPrincipal = { ...principal, origin: d.originOf(request) };

    // Resume from Last-Event-ID, else start after what the agent acknowledged (rooms: now).
    const lastId =
      (typeof request.headers['last-event-id'] === 'string'
        ? request.headers['last-event-id']
        : undefined) ?? query.last_event_id;
    const resumed = decodeCursor(lastId);
    let cursor: Cursor;
    if (resumed) cursor = resumed;
    else {
      const start = (
        await d.db.query<{ i: string | number | null; m: string | number | null }>(
          `SELECT (SELECT acked_seq FROM inbox_cursors WHERE agent_id=$1) AS i,
                  (SELECT acked_mention_seq FROM wake_cursors WHERE agent_id=$1) AS m`,
          [agentId],
        )
      ).rows[0];
      cursor = { v: 1, i: Number(start?.i ?? 0), m: Number(start?.m ?? 0), r: {} };
    }

    open.total++;
    bump(open.agents, agentId, 1);
    bump(open.owners, who.operatorId, 1);
    const streamMs = d.wake.options.streamMs;
    keepSocket(request, streamMs + 15_000);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    const controller = new AbortController();
    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      controller.abort();
      open.total--;
      bump(open.agents, agentId, -1);
      bump(open.owners, who.operatorId, -1);
      if (!res.writableEnded) res.end();
    };
    res.on('close', finish);
    const write = async (chunk: string): Promise<void> => {
      if (ended || res.writableEnded) return;
      if (res.write(chunk)) return;
      // Backpressure: wait for the buffer to drain; a consumer stuck for 5 s is dropped and
      // resumes from its last event id.
      const drained = await new Promise<boolean>((resolve) => {
        const done = (value: boolean) => {
          clearTimeout(timer);
          res.off('drain', onDrain);
          res.off('close', onClose);
          resolve(value);
        };
        const onDrain = () => done(true);
        const onClose = () => done(false);
        const timer = setTimeout(() => done(false), 5000);
        res.on('drain', onDrain);
        res.on('close', onClose);
      });
      if (!drained) finish();
    };
    const send = (event: string, data: unknown) =>
      write(`id: ${encodeCursor(cursor)}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    async function cycle(): Promise<{ more: boolean; keys: WakeKey[] }> {
      let more = false;
      const keys: WakeKey[] = [];
      if (inbox) {
        const page = await d.messaging.readInbox(
          who.runtime ? { operatorId: who.operatorId, runtime: who.runtime } : principal,
          agentId,
          { since: cursor.i, limit: 50, start: 'acked' },
          messagesGuard,
        );
        for (const message of page.messages as AgentMessage[]) {
          cursor.i = message.seq;
          await send('message', message);
        }
        more ||= page.has_more;
        keys.push({ kind: 'inbox', id: agentId, after: cursor.i });
      }
      const mentions = await d.wake.mentions(
        principal,
        agentId,
        { since: cursor.m, limit: 50 },
        who.guard,
      );
      for (const mention of mentions.mentions) {
        cursor.m = mention.seq;
        await send('mention', mention);
      }
      more ||= mentions.has_more;
      keys.push({ kind: 'mention', id: agentId, after: Math.max(cursor.m, mentions.latest_seq) });
      if (rooms) {
        const list = (
          await d.db.query<{ id: string; latest: string | number }>(
            `SELECT r.id, r.next_seq-1 AS latest FROM room_members m JOIN rooms r ON r.id=m.room_id
              WHERE m.agent_id=$1 AND m.owner_id=$2 AND m.removed_at IS NULL
              ORDER BY m.joined_at, r.id LIMIT $3`,
            [agentId, who.operatorId, WAKE_LIMITS.roomsPerStream],
          )
        ).rows;
        const current = new Set(list.map((row) => row.id));
        for (const id of Object.keys(cursor.r)) if (!current.has(id)) delete cursor.r[id];
        for (const row of list) {
          const latest = Number(row.latest);
          // A room seen for the first time starts now (no history flood); resumed rooms catch up.
          cursor.r[row.id] ??= latest;
          if (latest > cursor.r[row.id]!) {
            let page: RoomPage;
            try {
              page = (await d.rooms.read(
                roomPrincipal,
                { room_id: row.id, since: cursor.r[row.id], limit: 50 },
                roomsGuard,
              )) as RoomPage;
            } catch (error) {
              if ((error as { statusCode?: number }).statusCode === 404) {
                delete cursor.r[row.id];
                continue;
              }
              throw error;
            }
            for (const message of page.messages) {
              cursor.r[row.id] = message.seq;
              // The agent's own posts do not wake it.
              if (message.sender_agent_id !== agentId) await send('room_post', message);
            }
            if (!page.messages.length)
              cursor.r[row.id] = Math.max(cursor.r[row.id]!, page.next_since);
            more ||= page.has_more;
          }
          keys.push({ kind: 'room', id: row.id, after: cursor.r[row.id]! });
        }
      }
      return { more, keys };
    }

    const deadline = Date.now() + streamMs;
    await write('retry: 1000\n\n');
    await send('ready', {
      agent_id: agentId,
      events: [...(inbox ? ['message'] : []), 'mention', ...(rooms ? ['room_post'] : [])],
      resumed: resumed !== null,
      closes_in_ms: streamMs,
    });
    try {
      while (!ended && Date.now() < deadline) {
        d.wake.kick();
        const { more, keys } = await cycle();
        if (more) continue;
        const remaining = deadline - Date.now();
        if (remaining <= 0 || ended) break;
        const changed = await d.wake.hub.wait(
          keys,
          Math.min(remaining, d.wake.options.heartbeatMs),
          controller.signal,
        );
        if (!changed) await write(': heartbeat\n\n');
      }
      await send('close', { reason: 'deadline', resume: true });
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode ?? 500;
      await send('error', {
        status,
        code:
          (error as { errorCode?: string }).errorCode ??
          (status === 500 ? 'internal_error' : 'rejected'),
        message: status === 500 ? 'The stream failed.' : (error as Error).message,
      });
    } finally {
      finish();
    }
    return reply;
  });
}
