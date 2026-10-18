import type { createRoomInvites } from '../links/invites.js';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { AssistantToolName } from '../assistant-access.js';
import type { AssistantScope } from '../../shared/assistant.js';
import type { ClientMetadataFetcher } from '../oauth/clients.js';
import { PAGE_HEADERS, errorPage } from '../oauth/pages.js';
import {
  MCP_PATH,
  OAuthFailure,
  PageFailure,
  PROTECTED_RESOURCE_PATH,
  registerOAuthRoutes,
  requestOrigin,
  statusOf,
  type OAuthDependencies,
  type OAuthServer,
} from '../oauth/server.js';
import {
  isOpenInviteTool,
  invokeOpenInvite,
  openInviteInputSchemas,
  openInviteTaskInputSchemas,
} from './open-invite.js';
import { describeValidation } from '../validation-errors.js';
import { feedEnabled } from '../feed/flag.js';
import { sendGuide, wantsGuide } from './guide.js';
import {
  clientAddressKey,
  limitRequestRate,
  PrincipalCache,
  presentedPrincipal,
} from '../rate-limit.js';
import { extendForWait } from '../wake/routes.js';
import { OFFER_BATCH_TOOLS, OFFER_LIMITS, TOOL_BODY_MAX_BYTES } from '../../shared/feed-offers.js';

/**
 * Scopes a client is told to request on its first 401 (RFC 6750 §3 `scope`), so a client that
 * would otherwise ask for every advertised scope starts with the everyday set: read the
 * workspace, create and list agents, join/read/post and host rooms, and read/send messages. Owners can
 * still widen or narrow on consent; write scopes stay unchecked until selected, except the core
 * agents:create and rooms:join, which start checked.
 */
export const DEFAULT_CHALLENGE_SCOPES = [
  'workspace:read',
  'agents:create',
  'rooms:join',
  // Directory reviewers create and host a room; the consent page pre-checks it (#170).
  'rooms:host',
  'messages:read',
  'messages:send',
] as const satisfies readonly AssistantScope[];

export interface RemoteMcpDependencies extends OAuthDependencies {
  /** The general per-principal request limit, shared with the REST API (limitRequestRate). */
  apiRequestsPerMinute: number;
  roomInvites: ReturnType<typeof createRoomInvites>;
  fail(code: number, message: string): never;
  /** Unauthenticated (unclaimed-mode) tool execution for the anonymous tool subset. */
  anonymousTool(address: string, tool: string, args: unknown, origin: string): Promise<unknown>;
  /** Anonymous `city_create_workspace` (AI-owned workspace, docs/AI_WORKSPACES.md). */
  createWorkspace(address: string, args: unknown, origin: string): Promise<unknown>;
  /** Resolves a presented `ccw_` workspace key, or null. */
  verifyWorkspaceKey(
    token: string,
  ): Promise<{ keyId: string; operatorId: string; keyHash: string; scopes: string[] } | null>;
}

/** `address` is request.ip (trusted proxy hops only), used for per-network limits. */
type Identity =
  | { anonymous?: false; roomOnly: true; token: string; origin: string; address: string }
  | { anonymous: true; address: string; origin: string }
  | {
      anonymous?: false;
      workspaceKey: true;
      keyId: string;
      keyHash: string;
      operatorId: string;
      origin: string;
      address: string;
    }
  | {
      anonymous?: false;
      grantId: string;
      operatorId: string;
      clientId: string;
      origin: string;
      address: string;
    };
/** Test-only injection points accepted through AppOptions.remoteMcp. */
export interface RemoteMcpTestOptions {
  fetchClientMetadata?: ClientMetadataFetcher;
}

const MAX_FORM_BYTES = 16 * 1024;
export const MCP_OPEN_PATH = '/mcp/open';

/**
 * Remote MCP front door: OAuth 2.1 authorization server plus a stateless Streamable HTTP
 * MCP endpoint at /mcp that exposes the same five tools as the local stdio bridge.
 * Every request is self-contained, so any instance can serve any request.
 */
export async function registerRemoteMcp(
  app: FastifyInstance,
  d: RemoteMcpDependencies,
): Promise<OAuthServer> {
  let oauth!: OAuthServer;
  const principals = new PrincipalCache(d.clock);
  // The MCP SDK and the tool registry are loaded on the first /mcp request, not at start-up:
  // they are a large part of the bundle and most cold starts serve the web app.
  type McpHandler = ReturnType<typeof import('@modelcontextprotocol/server').createMcpHandler>;
  let mcpHandler: Promise<McpHandler> | undefined;
  const loadMcp = (): Promise<McpHandler> =>
    (mcpHandler ??= createMcp().catch((error: unknown) => {
      mcpHandler = undefined;
      throw error;
    }));
  async function createMcp(): Promise<McpHandler> {
    const [{ createMcpHandler }, { createRemoteServer }, { withUniformValidation }] =
      await Promise.all([
        import('@modelcontextprotocol/server'),
        import('./tools.js'),
        import('./validation.js'),
      ]);
    return createMcpHandler(
      ({ authInfo, requestInfo }) => {
        const identity = authInfo?.extra as Identity | undefined;
        // serveMcp aborts the request's signal when the client disconnects (ends a wait= early).
        const signal = requestInfo?.signal;
        const server = createRemoteServer(
          (tool: string, args: unknown) => {
            if (!identity) return d.fail(401, 'Authentication is required.');
            if (identity.anonymous && isOpenInviteTool(tool))
              return invokeOpenInvite(d.roomInvites, tool, args, identity.address, identity.origin);
            if (identity.anonymous)
              return tool === 'city_create_workspace'
                ? d.createWorkspace(identity.address, args, identity.origin)
                : d.anonymousTool(identity.address, tool, args, identity.origin);
            if ('roomOnly' in identity)
              return d.roomInvites.invoke(identity.token, tool, args, identity.origin);
            if ('workspaceKey' in identity)
              return d.access.executeTool(
                {
                  grantId: identity.keyId,
                  operatorId: identity.operatorId,
                  keyHash: identity.keyHash,
                  address: identity.address,
                },
                tool,
                args,
                { origin: identity.origin, signal },
              );
            return d.access.executeTool(
              {
                grantId: identity.grantId,
                operatorId: identity.operatorId,
                clientId: identity.clientId,
                address: identity.address,
              },
              tool,
              args,
              { origin: identity.origin, signal },
            );
          },
          (error) => {
            // Same field-level format as REST 400s: paths and constraints, never received values.
            if (error instanceof z.ZodError) return { status: 400, ...describeValidation(error) };
            const status = statusOf(error);
            const issues = (error as { issues?: unknown }).issues;
            return {
              status,
              message:
                status === 500 ? 'The operation could not be completed.' : (error as Error).message,
              ...(status !== 500 && Array.isArray(issues) ? { issues } : {}),
            };
          },
          {
            anonymous: identity?.anonymous === true,
            roomOnly: !!identity && 'roomOnly' in identity,
            workspaceKey: !!identity && 'workspaceKey' in identity,
            grantedScopes: authInfo?.scopes,
            openInvites: d.roomInvites.enabled(),
            origin: identity?.origin,
            workspaceId:
              identity && !identity.anonymous && !('roomOnly' in identity)
                ? identity.operatorId
                : undefined,
          },
        );
        // Every schema failure answers with our invalid_arguments body (see validation.ts).
        return withUniformValidation(server);
      },
      {
        legacy: 'stateless',
        // Fastify parses the body first (parsedBody below) under the route's own limit.
        maxRequestBodySize: OFFER_LIMITS.batchBytesMax,
        keepAliveMs: 0,
        onerror: () => {},
      },
    );
  }
  app.addHook('onClose', async () => {
    const loaded = mcpHandler && (await mcpHandler.catch(() => undefined));
    await loaded?.close();
  });

  await app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: MAX_FORM_BYTES },
      (_request, body, done) => {
        const values: Record<string, string | string[]> = {};
        for (const [key, value] of new URLSearchParams(body as string)) {
          const current = values[key];
          values[key] =
            current === undefined
              ? value
              : [...(Array.isArray(current) ? current : [current]), value];
        }
        done(null, values);
      },
    );
    scope.addHook('onRequest', async (request) => {
      // As the REST API: per principal for a valid credential, per address otherwise
      // (limitRequestRate). /mcp authenticates with OAuth or a workspace key; /mcp/open and the
      // rest of this scope only honour a guest room credential, so other bearers stay per address.
      const path = request.url.split('?')[0];
      const authenticated = path === '/mcp' || path === '/mcp/';
      await limitRequestRate(
        d.limit,
        request.ip,
        presentedPrincipal(request.headers.authorization, undefined, {
          guest: (token) => d.roomInvites.verify(token),
          ...(authenticated
            ? {
                workspaceKey: (token: string) => d.verifyWorkspaceKey(token),
                accessToken: (token: string) =>
                  oauth.verifyAccessToken(token, requestOrigin(request, d.hosted)),
              }
            : {}),
        }),
        d.apiRequestsPerMinute,
        principals,
      );
    });
    scope.setErrorHandler((error, request, reply) => {
      const status = statusOf(error);
      // Per-credential and per-address 429s carry their window, as the root handler sends it.
      const retryAfterMs = (error as { retryAfterMs?: unknown }).retryAfterMs;
      if (status === 429 && typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs))
        reply.header('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      const message =
        status >= 500
          ? 'The operation could not be completed.'
          : error instanceof z.ZodError
            ? describeValidation(error).message
            : (error as Error).message || 'Request rejected.';
      if (request.url.startsWith('/oauth/authorize'))
        return reply
          .code(error instanceof PageFailure ? error.status : status)
          .headers(PAGE_HEADERS)
          .send(errorPage(message));
      if (error instanceof OAuthFailure)
        return reply.code(error.status).send({ error: error.code, error_description: message });
      if (request.url.startsWith('/oauth/'))
        return reply.code(status).send({
          error:
            status === 429
              ? 'temporarily_unavailable'
              : status >= 500
                ? 'server_error'
                : 'invalid_request',
          error_description: message,
        });
      // Stable machine-readable codes (e.g. onboarding_required) accompany the message.
      const code = (error as { errorCode?: unknown }).errorCode;
      return reply
        .code(status)
        .send({ error: message, ...(status < 500 && typeof code === 'string' ? { code } : {}) });
    });

    oauth = await registerOAuthRoutes(scope, d);

    async function serveMcp(request: FastifyRequest, reply: FastifyReply, open = false) {
      const base = requestOrigin(request, d.hosted);
      // A plain GET (browser, or a fetch following a link) gets a public connection guide.
      // MCP stream GETs (Accept: text/event-stream), POST and DELETE continue below unchanged,
      // so the OAuth 401 + WWW-Authenticate challenge that clients discover OAuth from stays.
      if (wantsGuide(request))
        return sendGuide(request, reply, base, open, feedEnabled(process.env));
      // Browsers attach Origin; only same-origin browser calls may reach the MCP endpoint.
      if (request.headers.origin !== undefined && request.headers.origin !== base)
        return reply.code(403).send({ error: 'Cross-origin MCP requests are not allowed.' });
      const metadataUrl = `${base}${PROTECTED_RESOURCE_PATH}`;
      const authorization = request.headers.authorization;
      const presented =
        typeof authorization === 'string' && /^Bearer \S+$/i.test(authorization)
          ? authorization.slice(7)
          : undefined;
      // /mcp/open never authenticates: any token is ignored and only the anonymous tools exist.
      // One exception, for clients that only know how to send a bearer header: a room
      // credential (crc_...) is passed to the credential-bound room tools as their
      // room_credential argument (same validation; an explicit argument wins; never logged).
      // An AI workspace key (ccw_...) is accepted on /mcp as well as OAuth access tokens.
      const roomOnly = presented?.startsWith('crc_') === true && !open;
      const invited = roomOnly ? await d.roomInvites.verify(presented!) : null;
      const workspaceKey = presented?.startsWith('ccw_') === true && !open;
      const key = workspaceKey ? await d.verifyWorkspaceKey(presented!) : null;
      if (workspaceKey && !key) {
        reply.header(
          'www-authenticate',
          `Bearer resource_metadata="${metadataUrl}", error="invalid_token", error_description="The workspace key is invalid or revoked."`,
        );
        return reply.code(401).send({
          error: 'invalid_token',
          error_description: 'The workspace key is invalid or revoked.',
        });
      }
      const verified =
        presented && !open && !workspaceKey && !roomOnly
          ? await oauth.verifyAccessToken(presented, base)
          : null;
      // /mcp requires OAuth for every request; anonymous use exists only on /mcp/open.
      const anonymous = open;
      if (!verified && !key && !invited && !anonymous) {
        reply.header(
          'www-authenticate',
          presented
            ? `Bearer resource_metadata="${metadataUrl}", scope="${DEFAULT_CHALLENGE_SCOPES.join(' ')}", error="invalid_token", error_description="The access token is invalid, expired or revoked."`
            : `Bearer resource_metadata="${metadataUrl}", scope="${DEFAULT_CHALLENGE_SCOPES.join(' ')}"`,
        );
        return reply.code(401).send({
          error: presented ? 'invalid_token' : 'unauthorized',
          error_description: 'Authorize with OAuth to use this MCP endpoint.',
        });
      }
      // A guest room credential (on /mcp, or as a bearer on /mcp/open) is limited per credential,
      // not per address: guests of unrelated people share cloud egress addresses.
      const guest =
        invited ??
        (open && presented?.startsWith('crc_') ? await d.roomInvites.verify(presented) : null);
      if (key) await d.limit(`workspace-key:${key.keyId}`, 120, 60_000);
      else if (verified) await d.limit(`assistant:${verified.grantId}`, 120, 60_000);
      else if (guest) await d.limit(`guest-mcp:${guest.agent_id}`, 120, 60_000);
      else await d.limit(`anon-mcp:${clientAddressKey(request.ip)}`, 120, 60_000);
      if (key || verified) extendForWait(request); // authenticated wait= tool calls (docs/WAKE.md)
      if (
        request.method === 'POST' &&
        !request.headers['content-type']?.startsWith('application/json')
      )
        return reply.code(415).send({ error: 'Use application/json.' });
      // JSON-RPC batches are refused so one request cannot run many tool calls against a
      // single per-grant rate-limit charge (batching is also absent from current MCP).
      if (Array.isArray(request.body))
        return reply.code(400).send({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'JSON-RPC batch requests are not supported.' },
        });
      if (open && presented?.startsWith('crc_') && request.method === 'POST')
        bearerRoomCredential(request.body, presented);
      const authInfo: AuthInfo = invited
        ? {
            token: 'room-invite',
            clientId: 'room-invite',
            scopes: [],
            extra: {
              roomOnly: true,
              token: presented!,
              origin: base,
              address: request.ip,
            } satisfies Identity,
          }
        : key
          ? {
              // The key itself never travels further than this check.
              token: 'workspace-key',
              clientId: `workspace-key:${key.keyId}`,
              scopes: key.scopes,
              extra: {
                workspaceKey: true,
                keyId: key.keyId,
                keyHash: key.keyHash,
                operatorId: key.operatorId,
                origin: base,
                address: request.ip,
              } satisfies Identity,
            }
          : verified
            ? {
                token: verified.token,
                clientId: verified.clientId,
                scopes: verified.scopes,
                expiresAt: Math.floor(verified.expiresAt / 1000),
                resource: new URL(verified.resource),
                resourceMetadataUrl: metadataUrl,
                extra: {
                  grantId: verified.grantId,
                  operatorId: verified.operatorId,
                  clientId: verified.clientId,
                  origin: base,
                  address: request.ip,
                } satisfies Identity,
              }
            : {
                token: 'anonymous',
                clientId: 'anonymous',
                scopes: [],
                extra: { anonymous: true, address: request.ip, origin: base } satisfies Identity,
              };
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers))
        if (value !== undefined)
          for (const item of [value].flat()) headers.append(key, String(item));
      // A client that disconnects before the answer aborts the call: a long-poll (wait=) stops
      // waiting instead of holding the function to its deadline.
      const disconnect = new AbortController();
      reply.raw.once('close', () => {
        if (!reply.raw.writableFinished) disconnect.abort();
      });
      const webRequest = new Request(`${base}${request.url}`, {
        method: request.method,
        headers,
        signal: disconnect.signal,
        ...(request.method === 'POST' ? { body: request.rawBody ?? '' } : {}),
      });
      const mcp = await loadMcp();
      const response = await mcp.fetch(webRequest, {
        authInfo,
        ...(request.method === 'POST' ? { parsedBody: request.body } : {}),
      });
      reply.code(response.status);
      response.headers.forEach((value, key) => {
        if (!['content-length', 'transfer-encoding', 'connection'].includes(key))
          reply.header(key, value);
      });
      if (!response.body) return reply.send();
      return reply.send(Readable.fromWeb(response.body as unknown as NodeReadableStream));
    }
    // /mcp takes up to 1 MiB, but only for one tools/call of an offer batch tool
    // (OFFER_BATCH_TOOLS); any other body over 64 KiB is refused with 413 once parsed.
    scope.route({
      method: ['GET', 'POST', 'DELETE'],
      url: MCP_PATH,
      bodyLimit: OFFER_LIMITS.batchBytesMax,
      preHandler: async (request) => {
        if (!withinToolBodyLimit(request)) throw bodyTooLarge();
      },
      handler: (request, reply) => serveMcp(request, reply),
    });
    // Open endpoint: a standard, stateless Streamable HTTP MCP server with no authorization at
    // all. It exposes exactly the anonymous tools (unclaimed mode, all anti-flood limits), so any
    // MCP client can connect with one URL and no account. /mcp stays OAuth-protected.
    scope.route({
      method: ['GET', 'POST', 'DELETE'],
      url: MCP_OPEN_PATH,
      handler: (request, reply) => serveMcp(request, reply, true),
    });
  });
  // The wake-up stream (server/wake/routes.ts) accepts the same OAuth access tokens.
  return oauth;
}

/**
 * Whether a parsed /mcp body may be this large: at most TOOL_BODY_MAX_BYTES, or a single
 * JSON-RPC tools/call of an offer batch tool (the route's own limit bounds that one).
 */
function withinToolBodyLimit(request: FastifyRequest): boolean {
  const raw = request.rawBody;
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') <= TOOL_BODY_MAX_BYTES) return true;
  const body = request.body as { method?: unknown; params?: { name?: unknown } } | null;
  return (
    !!body &&
    !Array.isArray(body) &&
    body.method === 'tools/call' &&
    typeof body.params?.name === 'string' &&
    OFFER_BATCH_TOOLS.includes(body.params.name)
  );
}

/** The same 413 Fastify answers for a body over a route's limit. */
function bodyTooLarge(): Error {
  return Object.assign(new Error('Request body is too large'), {
    statusCode: 413,
    code: 'FST_ERR_CTP_BODY_TOO_LARGE',
  });
}

/** Open room tools that take a room_credential argument (city_join_invite does not). */
const CREDENTIAL_TOOLS = new Set(
  Object.entries({ ...openInviteInputSchemas, ...openInviteTaskInputSchemas })
    .filter(([, schema]) => 'room_credential' in (schema as z.ZodObject<z.ZodRawShape>).shape)
    .map(([name]) => name),
);

/**
 * `Authorization: Bearer crc_...` on /mcp/open: fills in room_credential for a credential-bound
 * room tool call that does not carry one. The body is otherwise untouched, so validation and
 * errors are exactly those of the argument; batches were refused above.
 */
function bearerRoomCredential(body: unknown, credential: string): void {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;
  const message = body as { method?: unknown; params?: unknown };
  if (message.method !== 'tools/call' || !message.params || typeof message.params !== 'object')
    return;
  const params = message.params as { name?: unknown; arguments?: unknown };
  if (typeof params.name !== 'string' || !CREDENTIAL_TOOLS.has(params.name)) return;
  if (params.arguments === undefined) params.arguments = {};
  if (!params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments))
    return;
  const args = params.arguments as Record<string, unknown>;
  if (args.room_credential === undefined) args.room_credential = credential;
}
