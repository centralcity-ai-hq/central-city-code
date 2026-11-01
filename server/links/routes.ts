import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Operator } from '../../shared/types.js';
import { z } from 'zod';
import { clientAddressKey } from '../rate-limit.js';
import { disconnectSignal, keepSocket } from '../wake/socket.js';
import { JOIN_LINK_LIMITS, negotiate, type createJoinLinks } from './service.js';
import { normalizeShortCode } from './short-code.js';
import { MAX_PASTE_LENGTH } from './paste.js';
import { TOOL_BODY_MAX_BYTES } from '../../shared/feed-offers.js';
// A leaf module: read on every guest tool call (an import cycle left it undefined in the bundle).
import {
  MESSAGE_BODY_MAX_BYTES,
  MESSAGE_SEND_TOOLS,
  requestBodyBytes,
} from '../messaging/body-limits.js';

export interface JoinLinkRouteDependencies {
  links: ReturnType<typeof createJoinLinks>;
  owner(request: FastifyRequest): Promise<Operator>;
  originOf(request: FastifyRequest): string;
  limit(key: string, max: number, windowMs: number): Promise<void>;
}

/**
 * `POST /api/links` (console session) and the public, content-negotiated `GET /j/<code>`
 * (docs/JOIN_LINKS.md). Vercel rewrites /j/<code> to the function and appends `?path=<code>`,
 * which server/vercel-handler.ts strips (REWRITE_PREFIXES); only `format` is read from the query.
 */
export function registerJoinLinkRoutes(app: FastifyInstance, d: JoinLinkRouteDependencies): void {
  app.post('/api/public/invites/bootstrap', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    await d.links.invites.deferredApiLimit(request.body, request.ip, d.originOf(request));
    return d.links.invites.bootstrap(request.body, request.ip, d.originOf(request));
  });
  app.post('/api/public/invites/redeem', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    await d.links.invites.deferredApiLimit(request.body, request.ip, d.originOf(request));
    return d.links.invites.redeem(request.body, request.ip, d.originOf(request));
  });
  // Redeem a host-issued rejoin code (the path segment after /j/) with the member's recovery
  // code: a fresh credential for the same guest member; the old credentials stop working
  // (docs/INVITE_FLOW.md).
  app.post('/api/public/invites/rejoin', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { code, recovery_code } = z
      .object({
        code: z.string().max(MAX_PASTE_LENGTH),
        recovery_code: z.string().max(64).optional(),
      })
      .strict()
      .parse(request.body);
    return d.links.invites.rejoin(code, request.ip, d.originOf(request), recovery_code);
  });
  // Renew a live guest credential for the same member (Authorization: Bearer crc_...), for
  // 24 hours like every guest credential (GUEST_CREDENTIAL_TTL_MS).
  app.post('/api/public/invites/renew', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const token =
      /^Bearer (crc_[A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
    // Optional idempotency_key: a retry with the same old credential and key returns the same
    // new credential (within the 10-minute grace period).
    const { idempotency_key } = z
      .object({ idempotency_key: z.string().min(8).max(128).optional() })
      .strict()
      .parse(request.body ?? {});
    return d.links.invites.renew(token, idempotency_key);
  });
  // Host only: a single-use rejoin link for one invited guest member (uniform 404 otherwise).
  app.post('/api/rooms/:room/members/:agent/rejoin-link', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const operator = await d.owner(request);
    const { room, agent } = request.params as { room: string; agent: string };
    return d.links.invites.createRejoinLink(
      { operatorId: operator.id, origin: d.originOf(request) },
      room,
      agent,
    );
  });
  app.post(
    '/api/public/invites/tools/:tool',
    { bodyLimit: MESSAGE_BODY_MAX_BYTES },
    async (request, reply) => {
      // Only a message tool may use the larger body; every other tool keeps 64 KiB.
      const tool = (request.params as { tool: string }).tool;
      if (!MESSAGE_SEND_TOOLS.includes(tool) && requestBodyBytes(request) > TOOL_BODY_MAX_BYTES)
        return reply.code(413).send({ error: 'Request body is too large' });
      reply.header('Cache-Control', 'no-store');
      const token =
        /^Bearer (crc_[A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
      // A guest's waiting read (wait 1-25 s): the socket outlasts the wait, and a closed
      // connection ends it (the same as a member's long-poll, docs/WAKE.md).
      const wait = (request.body as { wait?: unknown } | null)?.wait;
      const waiting = tool === 'city_room_read' && typeof wait === 'number' && wait > 0 && wait <= 25;
      // Only for a credential that verifies: unauthenticated sockets keep 15 s.
      if (waiting && (await d.links.invites.verify(token))) keepSocket(request, (wait + 15) * 1000);
      const closed = waiting ? disconnectSignal(request) : null;
      try {
        return await d.links.invites.invoke(token, tool, request.body, d.originOf(request), closed?.signal);
      } finally {
        closed?.done();
      }
    },
  );
  app.post('/api/links', async (request, reply) => {
    const operator = await d.owner(request);
    return reply
      .code(201)
      .send(
        await d.links.create(
          { operatorId: operator.id, actor: 'the owner', origin: d.originOf(request) },
          request.body,
        ),
      );
  });
  app.post('/api/links/:id/revoke', async (request) => {
    const operator = await d.owner(request);
    const { id } = request.params as { id: string };
    return d.links.revoke(
      { operatorId: operator.id, actor: 'the owner', origin: d.originOf(request) },
      id,
    );
  });
  app.get('/j/:code', async (request, reply) => {
    // Every read counts, valid or not, so codes cannot be probed quickly.
    await d.limit(
      `join-link-read:${clientAddressKey(request.ip)}`,
      JOIN_LINK_LIMITS.readsPerAddressPerMinute,
      60_000,
    );
    const { code } = request.params as { code: string };
    // A short code also spends the per-address short-code budget before any lookup, so /j is
    // no cheaper to probe than the join paths (40-bit codes).
    if (!/^[A-Za-z0-9_-]{43}$/.test(code) && normalizeShortCode(code))
      await d.links.invites.chargeShortCode(request.ip);
    const query = (request.query ?? {}) as Record<string, unknown>;
    const format = negotiate(query.format, request.headers.accept);
    const document = await d.links.resolve(d.originOf(request), code);
    reply
      .code(document.status)
      .header('Vary', 'Accept')
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Robots-Tag', 'noindex, nofollow');
    if (format === 'json')
      return reply.header('content-type', 'application/json; charset=utf-8').send(document.body);
    if (format === 'markdown')
      return reply.header('content-type', 'text/markdown; charset=utf-8').send(document.markdown);
    return reply
      .header('content-type', 'text/html; charset=utf-8')
      .header(
        'content-security-policy',
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      )
      .send(document.html);
  });
}
