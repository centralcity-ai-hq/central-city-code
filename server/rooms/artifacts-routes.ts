import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Operator } from '../../shared/types.js';
import { PG_INT_MAX, noNul, type RoomArtifacts } from './artifacts.js';
import type { RoomPrincipal } from './service.js';

export interface FileRouteDependencies {
  files: RoomArtifacts;
  /** The workspace the console request acts in (own or co-owned AI workspace). */
  owner(request: FastifyRequest): Promise<Operator>;
  originOf(request: FastifyRequest): string;
  /** CRON_SECRET for the hourly purge (absent: the cron route answers 404). */
  cronSecret?: string | undefined;
}

/** Path of the files purge cron (vercel.json crons, hourly). */
export const ROOM_FILES_PURGE_PATH = '/api/cron/room-files-purge';

function bearerMatches(header: string | undefined, secret: string | undefined): boolean {
  if (!secret || !header?.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Owner console REST for room files (docs/ROOMS.md "Room files"): the same operations as the MCP
 * tools, plus delete, which exists ONLY here (a person's decision; the principal is marked
 * console: true, which the service requires). The browser uploads straight to the presigned URL
 * the start answer carries, then finalizes. Writes need the console session and the X-City-Request
 * header (server/app.ts), like other room mutations.
 */
export function registerFileRoutes(app: FastifyInstance, d: FileRouteDependencies): void {
  const principal = async (request: FastifyRequest): Promise<RoomPrincipal> => ({
    operatorId: (await d.owner(request)).id,
    actor: 'the owner',
    origin: d.originOf(request),
    console: true,
  });
  const room = z.string().min(3).max(64);
  const file = z.string().min(1).max(200).refine(noNul, 'Not a valid file reference.');
  const body = (request: FastifyRequest) =>
    z.record(z.string(), z.unknown()).parse(request.body ?? {});

  app.get('/api/rooms/:room/files', async (request) => {
    const p = await principal(request);
    const params = z.object({ room }).strict().parse(request.params);
    return d.files.list(p, { room_id: params.room });
  });
  app.get('/api/rooms/:room/files/:file/versions', async (request) => {
    const p = await principal(request);
    const params = z.object({ room, file }).strict().parse(request.params);
    return d.files.versions(p, { room_id: params.room, file: params.file });
  });
  app.post('/api/rooms/:room/files/uploads', async (request, reply) => {
    const p = await principal(request);
    const params = z.object({ room }).strict().parse(request.params);
    return reply
      .code(201)
      .send(await d.files.upload(p, { ...body(request), room_id: params.room }));
  });
  app.post('/api/rooms/:room/files/:file/versions/:version/finalize', async (request) => {
    const p = await principal(request);
    const params = z
      .object({ room, file, version: z.coerce.number().int().min(1).max(PG_INT_MAX) })
      .strict()
      .parse(request.params);
    const extra = body(request);
    return d.files.finalize(p, {
      room_id: params.room,
      file: params.file,
      version: params.version,
      ...(typeof extra.agent_id === 'string' ? { agent_id: extra.agent_id } : {}),
    });
  });
  app.get('/api/rooms/:room/files/:file/download', async (request) => {
    const p = await principal(request);
    const params = z.object({ room, file }).strict().parse(request.params);
    const query = z
      .object({ version: z.coerce.number().int().min(1).max(PG_INT_MAX).optional() })
      .strict()
      .parse(request.query ?? {});
    return d.files.download(p, {
      room_id: params.room,
      file: params.file,
      ...(query.version !== undefined ? { version: query.version } : {}),
    });
  });
  // Hourly: superseded versions past 30 days and uploads left pending over an hour lose their bytes.
  app.get(ROOM_FILES_PURGE_PATH, async (request, reply) => {
    if (!bearerMatches(request.headers.authorization, d.cronSecret))
      return reply.code(404).send({ error: 'Not found.' });
    return reply.header('Cache-Control', 'no-store').send(await d.files.purge());
  });
  app.delete('/api/rooms/:room/files/:file', async (request) => {
    const p = await principal(request);
    const params = z.object({ room, file }).strict().parse(request.params);
    return d.files.remove(p, { room_id: params.room, file: params.file });
  });
}
