import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Operator } from '../../shared/types.js';
import type { RoomPins } from './pins.js';
import type { RoomPrincipal } from './service.js';

export interface PinRouteDependencies {
  pins: RoomPins;
  /** The workspace the console request acts in (own or co-owned AI workspace). */
  owner(request: FastifyRequest): Promise<Operator>;
  originOf(request: FastifyRequest): string;
}

/**
 * Owner console REST for room pins (docs/ROOMS.md "Pins and the handoff brief"): the same
 * operations and rules as city_room_pins, city_room_pin and city_room_unpin. Writes need the
 * console session and the X-City-Request header (server/app.ts), like other room mutations.
 */
export function registerPinRoutes(app: FastifyInstance, d: PinRouteDependencies): void {
  const principal = async (request: FastifyRequest): Promise<RoomPrincipal> => ({
    operatorId: (await d.owner(request)).id,
    actor: 'the owner',
    origin: d.originOf(request),
    console: true,
  });
  const roomParams = z.object({ room: z.string().min(3).max(64) }).strict();
  const body = (request: FastifyRequest) =>
    z.record(z.string(), z.unknown()).parse(request.body ?? {});

  app.get('/api/rooms/:room/pins', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    return d.pins.list(p, { room_id: room });
  });
  app.post('/api/rooms/:room/pins', async (request, reply) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    const result = await d.pins.add(p, { ...body(request), room_id: room });
    return reply.code(result.created ? 201 : 200).send(result);
  });
  app.delete('/api/rooms/:room/pins/:pin', async (request) => {
    const p = await principal(request);
    const { room, pin } = z
      .object({ room: z.string().min(3).max(64), pin: z.string().uuid() })
      .strict()
      .parse(request.params);
    const extra = body(request);
    return d.pins.remove(p, {
      room_id: room,
      pin_id: pin,
      ...(typeof extra.agent_id === 'string' ? { agent_id: extra.agent_id } : {}),
    });
  });
}
