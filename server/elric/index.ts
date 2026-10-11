import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Operator } from '../../shared/types.js';
import { elricEnabled } from './config.js';
import { ELRIC_OWNER_ONLY_NOTICE } from './hook.js';
import { registerElricChat } from './chat.js';
import { alreadyRejected, listPendingActions } from './activity.js';
import { PendingActionError, rejectPendingAction } from './pending.js';
import { registerElricOps } from './ops.js';
import { elricPublicModel } from '../../shared/elric-copy.js';
import { route } from './router.js';
import { createCatchUp } from './catch-up.js';
import { roomRefSchema } from '../rooms/contract.js';
import { ELRIC_RESULTS, listElricTurns } from './turns.js';
import {
  createElric,
  elricLimitNotice,
  type ElricDependencies,
  type ElricService,
} from './service.js';

/**
 * Wiring for Elric (docs/ELRIC.md). `registerElric` is called by createApp only when
 * CITY_ELRIC=1. It adds:
 *
 * - owner console routes under /api/elric (session cookie only, like the responder routes: no
 *   OAuth grant, workspace key, runtime or third-party `agents:control` grant reaches them, so
 *   nothing but the owner can add, pause, resume, revoke or re-scope Elric, or approve an action);
 * - the sender-only notice on POST /api/rooms/:room/messages (`elric_notice`), never a room post;
 * - an opportunistic drain after each successful POST (plus a timer backstop locally).
 */
declare module 'fastify' {
  interface FastifyInstance {
    elric?: ElricService;
  }
}

export interface ElricWiring extends ElricDependencies {
  owner(request: FastifyRequest): Promise<Operator>;
  /** Run a drain every few seconds (local server; hosted relies on the after-response kick). */
  retryTimer?: boolean;
  /** false: no drain after responses (tests drive `elric.drain()` / `elric.run()` themselves). */
  autoDrain?: boolean;
  /** Request rate limit (app.ts `limit`): throws a 429 when `key` is over `max` in `windowMs`. */
  limit?(key: string, max: number, windowMs: number): Promise<void>;
}

/** Catch-ups per caller per minute (each may cost a model call; the cache serves repeats). */
export const CATCH_UP_RATE = { max: 6, windowMs: 60_000 } as const;

const catchUpParams = z.object({ room: roomRefSchema }).strict();
const catchUpSeq = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const catchUpBody = z
  .object({ after_seq: catchUpSeq.optional(), to_seq: catchUpSeq.optional() })
  .strict();
const pendingParams = z.object({ id: z.string().uuid() }).strict();
const approveBody = z.object({ args_hash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const settingsBody = z.object({ host_may_invoke: z.boolean() }).strict();
const addBody = z.object({ name: z.string().min(1).max(60).optional() }).strict();
const turnsQuery = z
  .object({
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    room_id: z.string().max(200).optional(),
    result: z.enum(ELRIC_RESULTS).optional(),
  })
  .strict();

/** Runs a promise past the response on Vercel Fluid (waitUntil), else just in the background. */
function background(work: Promise<unknown>): void {
  work.catch(() => {});
  const context = (
    globalThis as { [key: symbol]: { get?: () => { waitUntil?: (p: Promise<unknown>) => void } } }
  )[Symbol.for('@vercel/request-context')];
  context?.get?.()?.waitUntil?.(work.catch(() => {}));
}

export function registerElric(app: FastifyInstance, d: ElricWiring): ElricService {
  const elric = createElric(d);
  app.decorate('elric', elric);
  // The dashboard chat: a private room per Elric, the "@ room" picker and check.
  registerElricChat(app, {
    db: d.db,
    clock: d.clock,
    owner: async (request) => (await d.owner(request)).id,
  });
  // Operator controls: kill switch and usage (CITY_OPS_SECRET), ceiling alerts.
  registerElricOps(app, {
    db: d.db,
    clock: d.clock,
    config: elric.config,
    ...(d.env ? { env: d.env } : {}),
  });
  const owner = async (request: FastifyRequest) => (await d.owner(request)).id;
  const pendingError = (error: unknown): never => {
    if (error instanceof PendingActionError)
      throw Object.assign(new Error('The action cannot be approved.'), {
        statusCode: error.statusCode,
        errorCode: error.errorCode,
      });
    throw error;
  };

  // "While you were away" (catch-up.ts): private to the caller, never posted to the room.
  const catchUp = createCatchUp({
    db: d.db,
    clock: d.clock,
    config: elric.config,
    adapterFor: d.adapterFor,
    tasksEnabled: d.tasksEnabled,
    ...(d.env ? { env: d.env } : {}),
    ...(d.sleep ? { sleep: d.sleep } : {}),
    ...(d.log ? { log: d.log } : {}),
  });
  app.post('/api/rooms/:room/catch-up', async (request) => {
    const ownerId = await owner(request);
    await d.limit?.(`elric-catch-up:${ownerId}`, CATCH_UP_RATE.max, CATCH_UP_RATE.windowMs);
    const { room } = catchUpParams.parse(request.params);
    return catchUp.catchUp(ownerId, room, catchUpBody.parse(request.body ?? {}));
  });

  app.get('/api/elric', async (request) => elric.status(await owner(request)));
  app.post('/api/elric', async (request, reply) => {
    const ownerId = await owner(request);
    const result = await elric.addElric(ownerId, addBody.parse(request.body ?? {}));
    return reply.code(result.created ? 201 : 200).send(result);
  });
  app.post('/api/elric/pause', async (request) => elric.pause(await owner(request)));
  app.post('/api/elric/resume', async (request) => elric.resume(await owner(request)));
  app.post('/api/elric/revoke', async (request) => elric.revoke(await owner(request)));
  app.put('/api/elric/settings', async (request) => {
    const ownerId = await owner(request);
    return elric.setHostMayInvoke(ownerId, settingsBody.parse(request.body).host_may_invoke);
  });
  app.get('/api/elric/turns', async (request) => {
    const ownerId = await owner(request);
    const query = turnsQuery.parse(request.query);
    // The owner's activity view: listElricTurns with the result filter and visible room names.
    // The model is shown as the public model only (shared/elric-copy.ts), never the real one.
    const page = await listElricTurns(d.db, ownerId, {
      ...(query.cursor ? { cursor: query.cursor } : {}),
      ...(query.limit ? { limit: query.limit } : {}),
      ...(query.room_id ? { roomId: query.room_id } : {}),
      ...(query.result ? { result: query.result } : {}),
    });
    return {
      ...page,
      turns: page.turns.map((turn) => ({
        ...turn,
        model: turn.model === null ? null : elricPublicModel(turn.model),
      })),
    };
  });
  // The owner's open pending actions (not expired): a safe summary, never the stored arguments.
  app.get('/api/elric/pending', async (request) =>
    listPendingActions(d.db, await owner(request), d.clock()),
  );
  // Reject: owner session only; a repeated reject answers like the first.
  app.post('/api/elric/pending/:id/reject', async (request) => {
    const operatorId = await owner(request);
    const { id } = pendingParams.parse(request.params);
    try {
      await rejectPendingAction(d.db, { kind: 'owner_session', operatorId }, id, d.clock());
    } catch (error) {
      if (!(error instanceof PendingActionError)) throw error;
      if (!(await alreadyRejected(d.db, operatorId, id)))
        throw Object.assign(new Error('The action cannot be rejected.'), {
          statusCode: error.statusCode,
          errorCode: error.errorCode,
        });
    }
    return { id, status: 'rejected' as const };
  });
  app.post('/api/elric/pending/:id/approve', async (request) => {
    const operatorId = await owner(request);
    const { id } = pendingParams.parse(request.params);
    const { args_hash } = approveBody.parse(request.body);
    return elric
      .approve({ kind: 'owner_session', operatorId }, id, args_hash)
      .then((done) => ({ id: done.action.id, status: done.action.status }))
      .catch(pendingError);
  });

  // The sender-only notice: added to the poster's own response, never posted to the room.
  app.addHook('onSend', async (request, reply, payload) => {
    if (
      request.method !== 'POST' ||
      request.routeOptions.url !== '/api/rooms/:room/messages' ||
      reply.statusCode !== 201 ||
      typeof payload !== 'string' ||
      !elricEnabled(d.env ?? process.env)
    )
      return payload;
    try {
      const body = JSON.parse(payload) as {
        message?: { room_id?: unknown; seq?: unknown; sender_agent_id?: unknown; text?: unknown };
        replayed?: unknown;
      };
      const message = body.message;
      if (!message || body.replayed === true) return payload;
      const found = await d.db.query(
        `SELECT 1 FROM elric_notices WHERE room_id=$1 AND source_seq=$2 AND sender_member_id=$3`,
        [message.room_id, message.seq, message.sender_agent_id],
      );
      if (found.rows.length)
        return JSON.stringify({
          ...body,
          elric_notice: { code: 'elric_owner_only', text: ELRIC_OWNER_ONLY_NOTICE },
        });
      // The owner invoked Elric but that kind of request is used up today: say so at once, to
      // the owner only (the invocation will be refused before any model call).
      const queued = (
        await d.db.query<{ owner_id: string }>(
          `SELECT owner_id FROM elric_invocations WHERE room_id=$1 AND source_seq=$2
              AND invoker_member_id=$3 AND status='queued' LIMIT 1`,
          [message.room_id, message.seq, message.sender_agent_id],
        )
      ).rows[0];
      if (!queued || typeof message.text !== 'string') return payload;
      const chosen = route(message.text);
      if (chosen.tier === 0) return payload;
      const usage = await elric.usage(queued.owner_id);
      if (usage.used[chosen.kind] < usage.allowance[chosen.kind]) return payload;
      return JSON.stringify({
        ...body,
        elric_notice: {
          code: 'elric_limit',
          kind: chosen.kind,
          text: elricLimitNotice('owner_allowance', chosen.kind),
          resets_at: usage.resets_at,
        },
      });
    } catch {
      return payload;
    }
  });
  // After a successful write, run what the room-post hook queued (the transaction committed).
  if (d.autoDrain !== false)
    app.addHook('onResponse', async (request, reply) => {
      if (request.method === 'POST' && reply.statusCode < 400) background(elric.drain());
    });
  if (d.retryTimer && d.autoDrain !== false) {
    const timer = setInterval(() => background(elric.drain()), 2_000);
    timer.unref?.();
    app.addHook('onClose', async () => clearInterval(timer));
  }
  return elric;
}

export { createElric, ElricError, type ElricService } from './service.js';
export { elricOnRoomPosted } from './hook.js';
export { registerElricMigration } from './schema.js';
export { MockAdapter, OpenAICompatibleAdapter, type ModelAdapter } from './adapter.js';
