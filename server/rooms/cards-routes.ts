import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Operator } from '../../shared/types.js';
import type { RoomCards } from './cards.js';
import type { RoomDigestService } from './digest.js';
import type { RoomPrincipal } from './service.js';

export interface CardRouteDependencies {
  cards: RoomCards;
  /** The owner's daily rooms digest (cards and task states only). */
  digest: RoomDigestService;
  /** The workspace the console request acts in (own or co-owned AI workspace). */
  owner(request: FastifyRequest): Promise<Operator>;
  originOf(request: FastifyRequest): string;
}

/**
 * Owner console REST for room cards (docs/ROOMS.md "Decisions and approvals"): list and read cards,
 * record a decision as a person, and answer an approval. The answer exists ONLY here: the
 * principal is marked `console: true`, which the service requires, so it is always a person in the
 * signed-in console. Writes need the console session and the X-City-Request header
 * (server/app.ts), like other room mutations. Card references in paths drop the '#' (d-3, a-2, t-4).
 */
export function registerCardRoutes(app: FastifyInstance, d: CardRouteDependencies): void {
  const principal = async (request: FastifyRequest): Promise<RoomPrincipal> => ({
    operatorId: (await d.owner(request)).id,
    actor: 'the owner',
    origin: d.originOf(request),
    console: true,
  });
  const roomParams = z.object({ room: z.string().min(3).max(64) }).strict();
  const cardParams = z
    .object({ room: z.string().min(3).max(64), card: z.string().min(3).max(40) })
    .strict();
  const body = (request: FastifyRequest) =>
    z.record(z.string(), z.unknown()).parse(request.body ?? {});
  const query = (request: FastifyRequest) =>
    z
      .object({
        kind: z.enum(['decision', 'approval', 'result']).optional(),
        status: z.enum(['open', 'all']).optional(),
      })
      .strict()
      .parse(request.query ?? {});

  // The owner's digest over its rooms (docs/ROOMS.md "Owner digest"); registered before
  // /api/rooms/:room routes would match "digest" as a room.
  app.get('/api/rooms/digest', async (request) => {
    const owner = await d.owner(request);
    const { hours } = z
      .object({ hours: z.coerce.number().int().min(1).max(168).optional() })
      .strict()
      .parse(request.query ?? {});
    return d.digest.digest(owner.id, hours);
  });
  app.get('/api/rooms/:room/cards', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    return d.cards.list(p, { room_id: room, ...query(request) });
  });
  app.get('/api/rooms/:room/cards/:card', async (request) => {
    const p = await principal(request);
    const { room, card } = cardParams.parse(request.params);
    return d.cards.get(p, { room_id: room, card });
  });
  app.post('/api/rooms/:room/decisions', async (request, reply) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    const result = await d.cards.recordDecision(p, { ...body(request), room_id: room });
    return reply.code(result.replayed ? 200 : 201).send(result);
  });
  app.post('/api/rooms/:room/cards/:card/answer', async (request) => {
    const p = await principal(request);
    const { room, card } = cardParams.parse(request.params);
    return d.cards.answer(p, { ...body(request), room_id: room, card });
  });
}
