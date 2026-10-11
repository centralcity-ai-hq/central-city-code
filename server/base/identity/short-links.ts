/*
 * Short agent links (`/a/<id>`): the on-chain ERC-8004 agent URI. Each Base agent gets one short
 * id, assigned once and never reused. The link answers with the ERC-8004 registration file
 * (registration-v1) that registry explorers read; its A2A service points to the signed card.
 * Only agents whose card is public get a file; everything else is 404.
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

/**
 * The domain file's agents: confirmed ERC-8004 identities whose agent URI is this origin's
 * /a/<short id> and whose card is public, by the card route's rule (server/autonomy/index.ts N5:
 * the agent in its workspace, not revoked, at its current manifest revision, visibility
 * 'public'). A provisional id (migration 85) is never published. $1 is the origin.
 */
const DOMAIN_REGISTRATIONS = `SELECT i.chain_id, i.registry_address,
    i.erc8004_agent_id::text AS erc8004_agent_id
  FROM base_identities i
  JOIN base_short_ids s ON s.agent_id = i.agent_id
  WHERE i.state = 'confirmed' AND i.erc8004_agent_id IS NOT NULL
    AND i.agent_card_uri = $1 || '/a/' || s.short_id
    AND EXISTS (
      SELECT 1 FROM workspaces w
      CROSS JOIN LATERAL jsonb_array_elements(w.data->'agents') a
      JOIN agent_manifests m ON m.agent_id = a->>'id' AND m.revision = (a->>'revision')::int
      WHERE w.operator_id = (SELECT operator_id FROM agent_manifests
                              WHERE agent_id = i.agent_id LIMIT 1)
        AND a->>'id' = i.agent_id AND a->>'revokedAt' IS NULL
        AND m.manifest->'spec'->>'visibility' = 'public')
  ORDER BY i.erc8004_agent_id, i.chain_id`;

/**
 * The registration file and the domain file change when a registration is confirmed, and Verify
 * (and registry explorers) read them right after: browsers always revalidate, shared caches hold
 * them at most 10 s + 5 s stale (the Agent Explorer's bound), never minutes.
 */
export const REGISTRATION_LIVE = 'public, max-age=0, s-maxage=10, stale-while-revalidate=5';
/** Vercel's edge only (never forwarded to browsers): the same 15 s bound. */
export const REGISTRATION_LIVE_EDGE = 'public, max-age=10, stale-while-revalidate=5';

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
  },
): void {
  app.get('/.well-known/agent-registration.json', async (request, reply) => {
    const origin = deps.originOf?.(request) ?? `${request.protocol}://${request.host}`;
    const { rows } = await deps.db.query<{
      chain_id: number;
      registry_address: string;
      erc8004_agent_id: string;
    }>(DOMAIN_REGISTRATIONS, [origin]);
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
    // The card route decides visibility; asked without credentials, it answers only public cards.
    // The visitor's address is passed on so the card route's per-IP rate limit still applies.
    // The host is passed on too: in production the card route only answers allowed hosts, and
    // an internal request without it was refused (every /a/<id> answered 404).
    const card = await app.inject({
      method: 'GET',
      url: cardPath,
      remoteAddress: request.ip,
      headers: request.headers.host ? { host: request.headers.host } : {},
    });
    if (card.statusCode !== 200) return reply.code(404).send({ error: 'Not found.' });
    const parsed = card.json() as {
      name?: unknown;
      description?: unknown;
      iconUrl?: unknown;
      supportedInterfaces?: Array<{ protocolVersion?: unknown }>;
    };
    // Confirmed rows and the final id only: a provisional id (migration 85) is never published.
    const identities = await deps.db.query<{
      chain_id: number;
      registry_address: string;
      erc8004_agent_id: string;
    }>(
      `SELECT chain_id, registry_address, erc8004_agent_id::text AS erc8004_agent_id
       FROM base_identities WHERE agent_id = $1 AND state = 'confirmed'
         AND erc8004_agent_id IS NOT NULL ORDER BY chain_id`,
      [agentId],
    );
    const origin = deps.originOf?.(request) ?? `${request.protocol}://${request.host}`;
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
