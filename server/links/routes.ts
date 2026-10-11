import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Operator } from '../../shared/types.js';
import { z } from 'zod';
import { clientAddressKey } from '../rate-limit.js';
import { JOIN_LINK_LIMITS, negotiate, type createJoinLinks } from './service.js';
import { normalizeShortCode } from './short-code.js';
import { MAX_PASTE_LENGTH } from './paste.js';

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
  // Redeem a host-issued rejoin code (the path segment after /j/): a fresh credential for the
  // same guest member; the old credentials stop working (docs/INVITE_FLOW.md).
  app.post('/api/public/invites/rejoin', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { code } = z
      .object({ code: z.string().max(MAX_PASTE_LENGTH) })
      .strict()
      .parse(request.body);
    return d.links.invites.rejoin(code, request.ip, d.originOf(request));
  });
  // Renew a live guest credential for the same member (Authorization: Bearer crc_...), for
  // 24 hours like every guest credential (GUEST_CREDENTIAL_TTL_MS).
  app.post('/api/public/invites/renew', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const token =
      /^Bearer (crc_[A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
    return d.links.invites.renew(token);
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
  app.post('/api/public/invites/tools/:tool', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const token =
      /^Bearer (crc_[A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
    return d.links.invites.invoke(
      token,
      (request.params as { tool: string }).tool,
      request.body,
      d.originOf(request),
    );
  });
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
