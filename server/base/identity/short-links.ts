/*
 * Short agent links (`/a/<id>`): the on-chain ERC-8004 agent URI. Each Base agent gets one short
 * id, assigned once and never reused. The link answers with the ERC-8004 registration file
 * (registration-v1) that registry explorers read; its A2A service points to the signed card.
 * Only agents whose card is public get a file; everything else is 404. Over the visitor's per-IP
 * limit it is 429, and a busy server (a failed card lookup) is 503, both with Retry-After, never 404.
 *
 * `/.well-known/agent-registration.json` is ERC-8004's Endpoint Domain Verification for this
 * domain: every agent's A2A service points here, so explorers (8004scan's "domain verified")
 * check that this file lists the agent. It lists exactly the agents whose `/a/<id>` file names a
 * registration: confirmed identities with a public card.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from '../../database.js';
import { isShortId, newShortId } from '../../../shared/base/short-id.js';
import {
  buildDomainRegistrations,
  buildRegistrationFile,
  standardDescription,
} from '../../../shared/base/registration.js';
import { publicAgentCard } from '../../manifest/card-agent.js';

/**
 * The domain file's agents: confirmed ERC-8004 identities whose agent URI is this origin's
 * /a/<short id> and whose card is public, by the card route's rule (server/autonomy/index.ts N5:
 * the agent in its workspace, not revoked, at its current manifest revision, visibility
 * 'public'). A provisional id (migration 85) is never published. The workspace is the one of the
 * agent's manifests, as on the card route.
 *
 * Two linear reads joined here, never one query that expands a whole workspace per identity: that
 * form (an EXISTS per identity) could no longer finish with workspaces of 10,000+ agents (15 Oct
 * 2026), and a single joined query let the planner fall back to a nested loop over the expanded
 * list (as slow). DOMAIN_IDENTITIES: the identities this origin names, each with its workspace
 * ($1 the origin). PUBLIC_IN_WORKSPACES: the agents with a public card in those workspaces, each
 * workspace's list expanded once ($1 the workspaces).
 */
const DOMAIN_IDENTITIES = `SELECT i.agent_id, i.chain_id, i.registry_address,
    i.erc8004_agent_id::text AS erc8004_agent_id,
    (SELECT operator_id FROM agent_manifests WHERE agent_id = i.agent_id LIMIT 1) AS workspace
  FROM base_identities i
  JOIN base_short_ids s ON s.agent_id = i.agent_id
  WHERE i.state = 'confirmed' AND i.erc8004_agent_id IS NOT NULL
    AND i.agent_card_uri = $1 || '/a/' || s.short_id
  ORDER BY i.erc8004_agent_id, i.chain_id`;
const PUBLIC_IN_WORKSPACES = `SELECT w.operator_id, a->>'id' AS agent_id
  FROM workspaces w
  CROSS JOIN LATERAL jsonb_array_elements(w.data->'agents') a
  JOIN agent_manifests m ON m.agent_id = a->>'id' AND m.revision = (a->>'revision')::int
  WHERE w.operator_id = ANY($1::text[]) AND a->>'revokedAt' IS NULL
    AND m.manifest->'spec'->>'visibility' = 'public'`;

/**
 * The domain file's registrations for an origin (see DOMAIN_IDENTITIES). Both reads run in one
 * read-only REPEATABLE READ transaction: one snapshot, as the single statement before it saw, so a
 * move, revocation, visibility or revision change between them can never mix two states.
 */
export const DOMAIN_SNAPSHOT = 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY';

export async function domainRegistrations(
  db: Pick<Database, 'transaction'>,
  origin: string,
): Promise<Array<{ chain_id: number; registry_address: string; erc8004_agent_id: string }>> {
  return db.transaction(async (tx) => {
    await tx.query(DOMAIN_SNAPSHOT);
    const { rows } = await tx.query<{
      agent_id: string;
      chain_id: number;
      registry_address: string;
      erc8004_agent_id: string;
      workspace: string | null;
    }>(DOMAIN_IDENTITIES, [origin]);
    const workspaces = [...new Set(rows.flatMap((row) => (row.workspace ? [row.workspace] : [])))];
    if (workspaces.length === 0) return [];
    const live = await tx.query<{ operator_id: string; agent_id: string }>(PUBLIC_IN_WORKSPACES, [
      workspaces,
    ]);
    const publicCards = new Set(live.rows.map((row) => `${row.operator_id}\u0000${row.agent_id}`));
    return rows
      .filter((row) => row.workspace && publicCards.has(`${row.workspace}\u0000${row.agent_id}`))
      .map(({ chain_id, registry_address, erc8004_agent_id }) => ({
        chain_id,
        registry_address,
        erc8004_agent_id,
      }));
  });
}

/**
 * The registration file and the domain file change when a registration is confirmed, and Verify
 * (and registry explorers) read them right after: browsers always revalidate, shared caches hold
 * them at most 10 s + 5 s stale (the Agent Explorer's bound), never minutes.
 */
export const REGISTRATION_LIVE = 'public, max-age=0, s-maxage=10, stale-while-revalidate=5';
/** Vercel's edge only (never forwarded to browsers): the same 15 s bound. */
export const REGISTRATION_LIVE_EDGE = 'public, max-age=10, stale-while-revalidate=5';
/** How long one server instance reuses its read of the domain file (small next to the 15 s). */
export const DOMAIN_FILE_REUSE_MS = 2_000;

/** What the registration file takes from the agent's public card. */
export interface CardFields {
  name?: unknown;
  description?: unknown;
  iconUrl?: unknown;
  supportedInterfaces?: Array<{ protocolVersion?: unknown }>;
}

/** How long a client waits before asking again when the server was busy. */
export const CARD_BUSY_RETRY_AFTER_S = 10;

/**
 * The registration file when the server, not the agent, is the reason there is none: over the
 * visitor's per-IP limit (429, with its Retry-After; 60 s when it has none) or busy (503, Retry-After
 * 10 s). Never 404, which registry explorers read as an agent that is gone, and never cached.
 */
function notReady(reply: FastifyReply, why: 'limited' | 'busy', retryAfterS?: number) {
  reply.header('Cache-Control', 'no-store');
  if (why === 'limited')
    return reply
      .code(429)
      .header(
        'Retry-After',
        String(
          retryAfterS !== undefined && Number.isFinite(retryAfterS) && retryAfterS > 0
            ? Math.ceil(retryAfterS)
            : 60,
        ),
      )
      .send({ error: 'Too many requests. Try again later.' });
  return reply
    .code(503)
    .header('Retry-After', String(CARD_BUSY_RETRY_AFTER_S))
    .send({ error: 'Busy. Try again in a moment.' });
}

/** The agent's short id, assigned on first call; retries on the (very unlikely) collision. */
export async function ensureShortId(
  db: Pick<Database, 'query'>,
  agentId: string,
  now = Date.now(),
): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const existing = await db.query<{ short_id: string }>(
      'SELECT short_id FROM base_short_ids WHERE agent_id = $1',
      [agentId],
    );
    if (existing.rows[0]) return existing.rows[0].short_id;
    const inserted = await db.query<{ short_id: string }>(
      `INSERT INTO base_short_ids (short_id, agent_id, created_at) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING RETURNING short_id`,
      [newShortId(), agentId, now],
    );
    if (inserted.rows[0]) return inserted.rows[0].short_id;
  }
  throw new Error('Could not assign a short id.');
}

/**
 * Whether the agent's Base registration has started: it has a short id (the agent URI written, or
 * about to be written, on chain) or an identity row in any state. Its card must then stay public,
 * or `/a/<id>` would answer 404 to registry explorers.
 */
export async function baseRegistrationStarted(
  db: Pick<Database, 'query'>,
  agentId: string,
): Promise<boolean> {
  const { rows } = await db.query<{ started: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM base_short_ids WHERE agent_id = $1)
         OR EXISTS (SELECT 1 FROM base_identities WHERE agent_id = $1) AS started`,
    [agentId],
  );
  return rows[0]?.started === true;
}

/**
 * Which browsers get the passport page at /a/<short> instead of the registration file: an Accept
 * header that names text/html and no JSON type at all (application/json, application/ld+json, any
 * +json). Browsers navigating send text/html and never JSON; resolvers send JSON, any type, or
 * nothing, and keep the file. The same rule as vercel.json's rewrite (ACCEPTS_PAGE), which can only
 * match text, so q values are deliberately not weighed: a client naming JSON anywhere always gets
 * the file.
 */
export const ACCEPTS_PAGE = '^(?=.*text/html)(?!.*json).*$';
const acceptsPage = new RegExp(ACCEPTS_PAGE);

export function wantsHtml(accept: string | undefined): boolean {
  return accept !== undefined && acceptsPage.test(accept.toLowerCase());
}

export function registerShortLinks(
  app: FastifyInstance,
  deps: {
    db: Database;
    originOf?: (request: FastifyRequest) => string;
    /**
     * The passport page for a browser (wantsHtml). Without it every client gets the registration
     * file, exactly as before. Responses of this route always carry Vary: Accept, so no cache
     * ever hands the page to a resolver or the file to a browser.
     */
    page?: (request: FastifyRequest, reply: FastifyReply) => unknown;
    /** The visitor's per-IP request limit; throws a 429 error (with retryAfterMs) when reached. */
    limit?: (request: FastifyRequest) => Promise<void>;
    /** The agent's public card, or null (default: the card route's own lookup, unsigned). */
    card?: (agentId: string, origin: string) => Promise<CardFields | null>;
  },
): void {
  // One read of the domain file per origin at a time, reused for DOMAIN_FILE_REUSE_MS: a query
  // string misses the edge cache, so every such request would otherwise run the whole read.
  const domainReads = new Map<
    string,
    { until: number; rows: ReturnType<typeof domainRegistrations> }
  >();
  app.get('/.well-known/agent-registration.json', async (request, reply) => {
    const origin = deps.originOf?.(request) ?? `${request.protocol}://${request.host}`;
    // The visitor's per-IP limit, as on /a/<id>.
    try {
      await deps.limit?.(request);
    } catch (error) {
      const limited = error as { statusCode?: unknown; retryAfterMs?: unknown };
      if (limited.statusCode !== 429) return notReady(reply, 'busy');
      const ms = limited.retryAfterMs;
      return notReady(reply, 'limited', typeof ms === 'number' ? ms / 1000 : undefined);
    }
    const now = Date.now();
    let read = domainReads.get(origin);
    if (!read || read.until <= now) {
      // Origins come from the Host header off Vercel: never let them grow the map without bound.
      if (domainReads.size >= 16) domainReads.clear();
      read = { until: now + DOMAIN_FILE_REUSE_MS, rows: domainRegistrations(deps.db, origin) };
      domainReads.set(origin, read);
      const settled = read;
      // A failed read is never reused.
      settled.rows.catch(() => {
        if (domainReads.get(origin) === settled) domainReads.delete(origin);
      });
    }
    const rows = await read.rows;
    return reply
      .header('Content-Type', 'application/json; charset=utf-8')
      .header('Access-Control-Allow-Origin', '*')
      .header('Cache-Control', REGISTRATION_LIVE)
      .header('Vercel-CDN-Cache-Control', REGISTRATION_LIVE_EDGE)
      .send(
        buildDomainRegistrations(
          rows.map((row) => ({
            chainId: row.chain_id,
            registry: row.registry_address,
            erc8004AgentId: row.erc8004_agent_id,
          })),
        ),
      );
  });
  app.get('/a/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    reply.header('Vary', 'Accept');
    if (!isShortId(id)) return reply.code(404).send({ error: 'Not found.' });
    if (deps.page && wantsHtml(request.headers.accept)) {
      reply.header('Cache-Control', 'no-cache');
      return deps.page(request, reply);
    }
    const { rows } = await deps.db.query<{ agent_id: string }>(
      'SELECT agent_id FROM base_short_ids WHERE short_id = $1',
      [id],
    );
    const agentId = rows[0]?.agent_id;
    if (!agentId) return reply.code(404).send({ error: 'Not found.' });
    const cardPath = `/a2a/${encodeURIComponent(agentId)}/.well-known/agent-card.json`;
    const origin = deps.originOf?.(request) ?? `${request.protocol}://${request.host}`;
    // The visitor's per-IP limit, as on the card route itself.
    try {
      await deps.limit?.(request);
    } catch (error) {
      const limited = error as { statusCode?: unknown; retryAfterMs?: unknown };
      if (limited.statusCode !== 429) return notReady(reply, 'busy');
      const ms = limited.retryAfterMs;
      return notReady(reply, 'limited', typeof ms === 'number' ? ms / 1000 : undefined);
    }
    // The public card, read directly (the card route's own lookup and compile): only public cards
    // get a file. A failure is the server being busy, never a missing agent.
    let parsed: CardFields | null;
    try {
      parsed = await (deps.card ?? ((agent, at) => publicAgentCard(deps.db, agent, at)))(
        agentId,
        origin,
      );
    } catch {
      return notReady(reply, 'busy');
    }
    if (!parsed) return reply.code(404).send({ error: 'Not found.' });
    // Confirmed rows and the final id only: a provisional id (migration 85) is never published.
    const identities = await deps.db.query<{
      chain_id: number;
      registry_address: string;
      erc8004_agent_id: string;
      updated_at: string | number;
    }>(
      `SELECT chain_id, registry_address, erc8004_agent_id::text AS erc8004_agent_id, updated_at
       FROM base_identities WHERE agent_id = $1 AND state = 'confirmed'
         AND erc8004_agent_id IS NOT NULL ORDER BY chain_id`,
      [agentId],
    );
    const version = parsed.supportedInterfaces?.[0]?.protocolVersion;
    const name =
      typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name : 'Central City agent';
    return reply
      .header('Content-Type', 'application/json; charset=utf-8')
      .header('Access-Control-Allow-Origin', '*')
      .header('Cache-Control', REGISTRATION_LIVE)
      .header('Vercel-CDN-Cache-Control', REGISTRATION_LIVE_EDGE)
      .send(
        buildRegistrationFile({
          name,
          // Every Central City Base agent: its own name and passport in one standard line,
          // after the owner's own description when that says more than the name.
          description: standardDescription({
            name,
            passport: `${new URL(origin).host}/a/${id}`,
            ...(typeof parsed.description === 'string'
              ? { ownDescription: parsed.description }
              : {}),
          }),
          image:
            typeof parsed.iconUrl === 'string'
              ? parsed.iconUrl
              : `${origin}/brand/directory-icon-1024.png`,
          cardUrl: `${origin}${cardPath}`,
          // Its passport page: the human view of this same registration.
          webUrl: `${origin}/a/${id}`,
          updatedAtMs: Math.max(0, ...identities.rows.map((row) => Number(row.updated_at) || 0)),
          ...(typeof version === 'string' ? { a2aVersion: version } : {}),
          identities: identities.rows.map((row) => ({
            chainId: row.chain_id,
            registry: row.registry_address,
            erc8004AgentId: row.erc8004_agent_id,
          })),
        }),
      );
  });
}
