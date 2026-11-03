/*
 * Operation Directory D1 over HTTP (store.ts decides who is listed; shared/directory.ts is the
 * contract the browser and the AI tools use).
 *
 *   GET   /api/public/directory?q=&min_rating=&sort=&before=&chain=   DirectoryPage. Public (signed
 *         out too), rate limited per address like the explorer (a text search per IPv6 /56 too),
 *         cached as briefly as its list, bounded in the database like the explorer's search.
 *         A search that cannot finish in time answers 503 busy. chain=arc lists Arc while it is on
 *         (404 chain_not_live otherwise); the settings below stay Base's.
 *   GET   /api/agents/:agentId/directory                       DirectorySettings
 *   PATCH /api/agents/:agentId/directory                       {listed?, invitations?} ->
 *         DirectorySettings. listed=true needs a final Base ID and a public card (409
 *         not_base_agent); turning it off or changing invitations never does.
 *
 * The settings are the agent's owner's only: signed out 401; another account's agent, an unknown
 * or malformed id 404 agent_not_found, the same answer, so an id cannot be probed. The PATCH goes
 * through the console's request guard in server/app.ts (request header, JSON).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BASE_MAINNET, type BaseChainId } from '../../shared/base/chains.js';
import { arcNetwork, liveChainIds } from '../../shared/chains.js';
import {
  canonicalDirectorySearch,
  DIRECTORY_PATHS,
  directoryQueryRefusal,
  readDirectoryChain,
  readDirectoryQuery,
} from '../../shared/directory.js';
import { registeredChainName } from '../base/identity/short-links.js';
import { clientAddressKey, clientAddressPrefixes } from '../rate-limit.js';
import type { Database } from '../database.js';
import {
  ON_BASE_LIVE,
  ON_BASE_LIVE_EDGE,
  ON_BASE_RATE,
  ON_BASE_SEARCH_SITE_RATE,
  SEARCH_TIMEOUT_MS,
  busyOnTimeout,
} from '../base/explorer/routes.js';
import { createDirectoryStore, offsetOf } from './store.js';

export { DIRECTORY_PATHS };

export interface DirectoryRouteDeps {
  db: Database;
  /**
   * Whether the signed-in person's selected workspace owns this agent: 'signed_out' (401),
   * 'not_found' (another account's or unknown: 404) or 'ok'.
   */
  owns(request: FastifyRequest, agentId: string): Promise<'ok' | 'signed_out' | 'not_found'>;
  /** The network listed; Base mainnet (the explorer's) unless a test or local run says otherwise. */
  chainId?: BaseChainId;
  /** Where CITY_ARC and CITY_ARC_CHAIN_ID are read: whether chain=arc is on, and which Arc. */
  env?: Record<string, string | undefined>;
  /** The agent URI origin (tests); defaults to https://centralcity.ai. */
  uriOrigin?: string;
  /** The shared rate limiter (server/app.ts); absent in unit tests. */
  limit?: (key: string, max: number, windowMs: number) => Promise<void>;
}

const params = z.object({ agentId: z.string().uuid() }).strict();
/** Partial<DirectorySettings>, nothing else. */
const patchBody = z
  .object({ listed: z.boolean().optional(), invitations: z.enum(['ask', 'never']).optional() })
  .strict();

export function registerDirectoryRoutes(app: FastifyInstance, deps: DirectoryRouteDeps): void {
  const baseChainId = deps.chainId ?? BASE_MAINNET;
  const store = createDirectoryStore(deps.db, { chainId: baseChainId, uriOrigin: deps.uriOrigin });
  // The one Arc network this deployment has on, or null. The registry follows from its chain id.
  const env = deps.env ?? {};
  const arc =
    liveChainIds(env)
      .map((id) => arcNetwork(id, env))
      .find((network) => network !== null) ?? null;

  const notFound = (reply: FastifyReply) =>
    reply.code(404).send({ error: 'Agent not found.', code: 'agent_not_found' });

  /** The owner's agent id, or the reply already sent. */
  async function ownedAgent(request: FastifyRequest, reply: FastifyReply) {
    const parsed = params.safeParse(request.params);
    const owned = parsed.success ? await deps.owns(request, parsed.data.agentId) : 'not_found';
    if (owned === 'signed_out') {
      reply.code(401).send({ error: 'Sign in to continue.' });
      return null;
    }
    if (owned !== 'ok' || !parsed.success) {
      notFound(reply);
      return null;
    }
    return parsed.data.agentId;
  }

  // Each search in one READ ONLY transaction with the explorer's SEARCH_TIMEOUT_MS; identical
  // searches in flight share one read (nothing is kept after it: an owner's switch shows at once).
  type Page = Awaited<ReturnType<typeof store.search>>;
  const inflight = new Map<string, Promise<Page>>();
  function search(query: ReturnType<typeof readDirectoryQuery>, chainId: number): Promise<Page> {
    const key = JSON.stringify([chainId, query]);
    const shared = inflight.get(key);
    if (shared) return shared;
    const page = deps.db
      .transaction(async (tx) => {
        await tx.query('SET TRANSACTION READ ONLY');
        await tx.query(`SET LOCAL statement_timeout = ${SEARCH_TIMEOUT_MS}`);
        return createDirectoryStore(tx, { chainId, uriOrigin: deps.uriOrigin }).search(query);
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, page);
    return page;
  }

  app.get(DIRECTORY_PATHS.search, async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    // The edge cache keys by the whole URL: a key or value the search does not take (a before it
    // did not write among them) is refused before the limiter and the database, so a made-up one
    // cannot skip the cache.
    const refusal =
      directoryQueryRefusal(query) ??
      (query.before && offsetOf(query.before as string) === 0
        ? 'before must be the next of an earlier page.'
        : null);
    if (refusal)
      return reply
        .code(400)
        .header('Cache-Control', 'no-store')
        .send({ error: refusal, code: 'invalid_request' });
    const chain = readDirectoryChain(query);
    if (chain === 'arc' && !arc)
      return reply
        .code(404)
        .header('Cache-Control', 'no-store')
        .send({ error: 'Arc is not on here.', code: 'chain_not_live' });
    // Any other spelling of the same search (another key order, spaces around q, an empty value, a
    // stray '&' or '?') is sent on to its one canonical URL.
    const canonical = canonicalDirectorySearch(query);
    const mark = request.url.indexOf('?');
    if ((mark < 0 ? '' : request.url.slice(mark)) !== canonical)
      return reply
        .code(307)
        .header('Cache-Control', 'no-store')
        .header('Location', `${mark < 0 ? request.url : request.url.slice(0, mark)}${canonical}`)
        .send();
    await deps.limit?.(
      `ip:directory:${clientAddressKey(request.ip)}`,
      ON_BASE_RATE.max,
      ON_BASE_RATE.windowMs,
    );
    const parsed = readDirectoryQuery(query);
    const { source, site } = clientAddressPrefixes(request.ip);
    if (parsed.q && source.endsWith('::/64'))
      await deps.limit?.(
        `ip:directory-search:${site}`,
        ON_BASE_SEARCH_SITE_RATE.max,
        ON_BASE_SEARCH_SITE_RATE.windowMs,
      );
    // A search that cannot finish in time is busy (503); any other failure stays a 500.
    const chainId = chain === 'arc' && arc ? arc.chainId : baseChainId;
    const page = await search(parsed, chainId).catch(busyOnTimeout);
    if (!page)
      return reply
        .code(503)
        .header('Cache-Control', 'no-store')
        .header('Retry-After', '10')
        .send({ error: 'Search is busy right now. Try again shortly.', code: 'busy' });
    // As short-lived as the explorer's list: listing, scores and cards change within seconds.
    return reply
      .header('Cache-Control', ON_BASE_LIVE)
      .header('Vercel-CDN-Cache-Control', ON_BASE_LIVE_EDGE)
      .send(page);
  });

  app.get(DIRECTORY_PATHS.settings, async (request, reply) => {
    const agentId = await ownedAgent(request, reply);
    if (agentId === null) return reply;
    return reply.header('Cache-Control', 'no-store').send(await store.settings(agentId));
  });

  app.patch(DIRECTORY_PATHS.settings, async (request, reply) => {
    const agentId = await ownedAgent(request, reply);
    if (agentId === null) return reply;
    const body = patchBody.safeParse(request.body ?? {});
    if (!body.success)
      return reply.code(400).send({
        error: "Send {listed: true|false} and/or {invitations: 'ask'|'never'}.",
        code: 'invalid_request',
      });
    // Listed where it is final: on Base, or on the Arc network this deployment has on.
    const arcStore = arc
      ? createDirectoryStore(deps.db, { chainId: arc.chainId, uriOrigin: deps.uriOrigin })
      : null;
    if (
      body.data.listed === true &&
      !(await store.eligible(agentId)) &&
      !(arcStore && (await arcStore.eligible(agentId)))
    ) {
      const chainName = await registeredChainName(deps.db, agentId);
      return reply.code(409).send({
        error:
          chainName === 'Base'
            ? 'Only a Central City Base agent with a final Base ID and a public card can be listed.'
            : `The directory lists agents on Base for now, and this agent is on ${chainName}.`,
        code: 'not_base_agent',
      });
    }
    return reply.header('Cache-Control', 'no-store').send(await store.save(agentId, body.data));
  });
}
