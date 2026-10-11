import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Operator } from '../../shared/types.js';
import {
  MESSAGE_LIMITS,
  contextIdSchema,
  messagePartsSchema,
  sendBodySchema,
  sendFields,
  type InboxPage,
} from './contract.js';
import type { Messaging } from './service.js';

export interface MessagingRouteDependencies {
  messaging: Messaging;
  owner(request: FastifyRequest): Promise<Operator>;
  /** Authenticates a signed runtime request; `query` signs the path including its query string. */
  runtime(
    request: FastifyRequest,
    options?: { query?: boolean },
  ): Promise<{ operatorId: string; agentId: string; credentialHash: string }>;
  /**
   * Long-poll (docs/WAKE.md): answers read() at once when it has messages, otherwise waits up to
   * waitSeconds without holding a database connection. Without it, wait is ignored.
   */
  waitInbox?(
    request: FastifyRequest,
    operatorId: string,
    waitSeconds: number | undefined,
    read: () => Promise<InboxPage>,
  ): Promise<InboxPage>;
}

const seqParam = z
  .string()
  .regex(/^\d{1,15}$/)
  .transform(Number);
const inboxQuery = z
  .object({
    since: seqParam.optional(),
    before: seqParam.optional(),
    limit: z
      .string()
      .regex(/^\d{1,3}$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(MESSAGE_LIMITS.pageSize))
      .optional(),
    /** Long-poll seconds (docs/WAKE.md). */
    wait: z
      .string()
      .regex(/^\d{1,2}$/)
      .transform(Number)
      .pipe(z.number().int().min(0).max(25))
      .optional(),
  })
  .strict()
  .refine((query) => query.since === undefined || query.before === undefined, {
    message: 'Use since or before, not both.',
  });
const ackBody = z.object({ seq: z.number().int().min(0) }).strict();
const agentParams = z.object({ id: z.string().uuid() }).strict();

/**
 * Messaging REST surfaces (docs/MESSAGING.md): owner console routes (cookie session, the owner
 * acts as one of its agents) and runtime routes for external agents (HMAC-signed requests;
 * the authenticated agent is always the sender or inbox).
 */
export function registerMessagingRoutes(app: FastifyInstance, d: MessagingRouteDependencies): void {
  const owned = (operator: Operator) => ({ operatorId: operator.id, console: true });
  const waiting = (
    request: FastifyRequest,
    operatorId: string,
    wait: number | undefined,
    read: () => Promise<InboxPage>,
  ) => (d.waitInbox && wait ? d.waitInbox(request, operatorId, wait, read) : read());

  app.get('/api/messages/summary', async (request) => {
    const operator = await d.owner(request);
    return d.messaging.summary(operator.id);
  });
  app.get('/api/messages/conversations', async (request) => {
    const operator = await d.owner(request);
    const { limit } = z
      .object({
        limit: z
          .string()
          .regex(/^\d{1,3}$/)
          .transform(Number)
          .optional(),
      })
      .strict()
      .parse(request.query);
    return d.messaging.conversations(operator.id, limit);
  });
  app.get('/api/messages/conversations/:contextId', async (request) => {
    const operator = await d.owner(request);
    const { contextId } = z.object({ contextId: contextIdSchema }).parse(request.params);
    const query = z
      .object({
        before: z.string().max(80).optional(),
        limit: z
          .string()
          .regex(/^\d{1,3}$/)
          .transform(Number)
          .pipe(z.number().int().min(1).max(MESSAGE_LIMITS.pageSize))
          .optional(),
      })
      .strict()
      .parse(request.query);
    return d.messaging.conversation(operator.id, contextId, query);
  });
  app.get('/api/agents/:id/inbox', async (request) => {
    const operator = await d.owner(request);
    const { id } = agentParams.parse(request.params);
    const { wait, ...query } = inboxQuery.parse(request.query);
    return waiting(request, operator.id, wait, () =>
      d.messaging.readInbox(owned(operator), id, { ...query, start: 'latest' }),
    );
  });
  app.post('/api/agents/:id/messages', async (request, reply) => {
    const operator = await d.owner(request);
    const { id } = agentParams.parse(request.params);
    const body = sendBodySchema.parse(request.body);
    return reply.code(201).send(await d.messaging.send(owned(operator), id, body));
  });
  app.post('/api/agents/:id/inbox/ack', async (request) => {
    const operator = await d.owner(request);
    const { id } = agentParams.parse(request.params);
    const { seq } = ackBody.parse(request.body);
    return d.messaging.ack(owned(operator), id, seq);
  });

  // Private messages between room members (room-direct.ts). The console opens the pair's one
  // thread, then writes as its person or one of its AIs in that room.
  const roomParam = z.object({ room: sendFields.room_id.unwrap() }).strict();
  const memberId = z.string().uuid();
  app.post('/api/rooms/:room/direct', async (request) => {
    const operator = await d.owner(request);
    const { room } = roomParam.parse(request.params);
    const { to, from } = z
      .object({ to: memberId, from: memberId.optional() })
      .strict()
      .parse(request.body ?? {});
    return d.messaging.openDirect(owned(operator), room, from, to);
  });
  app.post('/api/messages/direct/:contextId/read', async (request) => {
    const operator = await d.owner(request);
    const { contextId } = z.object({ contextId: contextIdSchema }).strict().parse(request.params);
    return d.messaging.readDirect(owned(operator), contextId);
  });
  // "Delete conversation": hides the thread from this person's Messages only (migration 70).
  app.post('/api/messages/conversations/:contextId/hide', async (request) => {
    const operator = await d.owner(request);
    const { contextId } = z.object({ contextId: contextIdSchema }).strict().parse(request.params);
    z.object({})
      .strict()
      .parse(request.body ?? {});
    return d.messaging.hideConversation(owned(operator), contextId);
  });
  // Who New message can start a private message with: members of the caller's rooms.
  app.get('/api/messages/recipients', async (request) => {
    const operator = await d.owner(request);
    z.object({})
      .strict()
      .parse(request.query ?? {});
    return d.messaging.recipients(operator.id);
  });
  app.post('/api/rooms/:room/direct/messages', async (request, reply) => {
    const operator = await d.owner(request);
    const { room } = roomParam.parse(request.params);
    const { from, to, ...body } = z
      .object({
        from: memberId,
        to: memberId,
        text: sendFields.text,
        parts: messagePartsSchema.optional(),
        reply_to: z.string().uuid().optional(),
        idempotency_key: sendFields.idempotency_key,
      })
      .strict()
      .refine((value) => (value.text === undefined) !== (value.parts === undefined), {
        message: 'Pass exactly one of text or parts.',
      })
      .parse(request.body ?? {});
    return reply
      .code(201)
      .send(
        await d.messaging.send(owned(operator), from, { ...body, to_agent_id: to, room_id: room }),
      );
  });

  app.post('/api/runtime/messages', async (request, reply) => {
    const identity = await d.runtime(request);
    const body = sendBodySchema.parse(request.body);
    const principal = { operatorId: identity.operatorId, runtime: identity };
    return reply.code(201).send(await d.messaging.send(principal, identity.agentId, body));
  });
  app.get('/api/runtime/inbox', async (request) => {
    const identity = await d.runtime(request, { query: true });
    const { wait, ...query } = inboxQuery.parse(request.query);
    const principal = { operatorId: identity.operatorId, runtime: identity };
    return waiting(request, identity.operatorId, wait, () =>
      d.messaging.readInbox(principal, identity.agentId, { ...query, start: 'acked' }),
    );
  });
  app.post('/api/runtime/inbox/ack', async (request) => {
    const identity = await d.runtime(request);
    const { seq } = ackBody.parse(request.body);
    const principal = { operatorId: identity.operatorId, runtime: identity };
    return d.messaging.ack(principal, identity.agentId, seq);
  });
}
