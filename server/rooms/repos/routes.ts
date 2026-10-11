import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Operator } from '../../../shared/types.js';
import { clientAddressKey } from '../../rate-limit.js';
import type { RoomPrincipal } from '../service.js';
import { roomReposEnabled } from './config.js';
import type { RoomRepos } from './service.js';

export interface RepoRouteDependencies {
  repos: RoomRepos;
  /**
   * The workspace a console request acts in (own or co-owned AI workspace). It requires the
   * signed-in person's session cookie; bearer credentials never reach these routes.
   */
  owner(request: FastifyRequest): Promise<Operator>;
  originOf(request: FastifyRequest): string;
  fail(code: number, message: string): never;
}

/**
 * Owner console REST for the room's repository (docs/ROOM_REPOS.md "Binding (console only)"). Behind CITY_ROOM_REPOS=1.
 *
 * Connecting a repository exposes it (also when private) to every room member, so it is a human
 * decision taken here, in the host's signed-in session, in two steps:
 * 1. `POST /api/rooms/:room/repo/preview {repo}` checks the repository and returns the notice to
 *    show (including whether it is private) and the name to type;
 * 2. `POST /api/rooms/:room/repo {repo, acknowledge_member_read: true, confirm_repo}` connects it
 *    after the host ticked the notice and typed the name.
 * `POST /api/rooms/:room/repo/disconnect` disconnects it; `GET /api/rooms/:room/repo` shows it.
 *
 * The console's CSRF guard (X-City-Request, same-origin) applies to every POST. The principal is
 * marked `console: true`, which the service requires for preview, bind and unbind; MCP, grants
 * and workspace keys can never set it. Registered in server/app.ts.
 */
export function registerRoomRepoRoutes(app: FastifyInstance, d: RepoRouteDependencies): void {
  const principal = async (request: FastifyRequest): Promise<RoomPrincipal> => {
    if (!roomReposEnabled(process.env)) d.fail(404, 'Not found.');
    return {
      operatorId: (await d.owner(request)).id,
      actor: 'the host (console)',
      origin: d.originOf(request),
      console: true,
      address: clientAddressKey(request.ip),
    };
  };
  const params = z.object({ room: z.string().min(3).max(64) }).strict();
  const body = (request: FastifyRequest) =>
    z.record(z.string(), z.unknown()).parse(request.body ?? {});

  app.get('/api/rooms/:room/repo', async (request) => {
    // Off on this server: a plain answer the room can read, not a 404 the browser logs as an error.
    if (!roomReposEnabled(process.env)) {
      await d.owner(request);
      return { available: false };
    }
    const p = await principal(request);
    const { room } = params.parse(request.params);
    return d.repos.repo(p, { room_id: room });
  });
  app.post('/api/rooms/:room/repo/preview', async (request) => {
    const p = await principal(request);
    const { room } = params.parse(request.params);
    return d.repos.preview(p, { ...body(request), room_id: room });
  });
  app.post('/api/rooms/:room/repo', async (request, reply) => {
    const p = await principal(request);
    const { room } = params.parse(request.params);
    return reply.code(201).send(await d.repos.bind(p, { ...body(request), room_id: room }));
  });
  app.post('/api/rooms/:room/repo/disconnect', async (request) => {
    const p = await principal(request);
    const { room } = params.parse(request.params);
    return d.repos.unbind(p, { ...body(request), room_id: room });
  });
}
