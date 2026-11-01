/*
 * Short agent links (`/a/<id>`): the on-chain ERC-8004 agent URI. Each Base agent gets one short
 * id, assigned once and never reused. The link answers with the ERC-8004 registration file
 * (registration-v1) that registry explorers read; its A2A service points to the signed card.
 * Only agents whose card is public get a file; everything else is 404. Over the visitor's per-IP
 * limit it is 429, and a busy server (a failed card lookup) is 503, both with Retry-After, never 404.
 *
 * `/.well-known/agent-registration.json` is ERC-8004's Endpoint Domain Verification for this
 * domain: every agent's A2A service points here, so explorers (8004scan's "domain verified")
 * check that this file lists the agent. Its candidates are the agents whose `/a/<id>` file names
 * a registration: confirmed identities with a public card, whose holder has not moved them away
 * (moves.ts). The file is SCOPED (CCA-118): it lists only the newest DOMAIN_FILE_SCOPE of them on
 * each chain (highest ERC-8004 ids, which count up with every mint), the window in which an
 * explorer indexes a new agent and checks its domain. ERC-8004 does not need the check at all
 * when the agent URI is served from the endpoint's own domain, as every agent URI listed here is
 * (`<origin>/a/<id>`), so an older agent left out still proves its domain through its agent URI.
 * The file stays bounded however many agents register. A cron builds it and stores it
 * (domain-file.ts, with its size guard); the route only serves the stored file.
 *
 * The full list is the paginated companion DOMAIN_PAGES_PATH (?chain=&before=): the same
 * candidates and the same `registrations` entries, newest first, DOMAIN_PAGE_SIZE per page, read
 * through the Base ID index (migration 255) once the public cards are backfilled (503 before).
 */
import { gunzipSync } from 'node:zlib';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Database } from '../../database.js';
import { isShortId, newShortId } from '../../../shared/base/short-id.js';
import { BASE_MAINNET, BASE_NETWORKS } from '../../../shared/base/chains.js';
import { chainFamily, chainView } from '../../../shared/chains.js';
import {
  buildDomainRegistrations,
  buildRegistrationFile,
  standardDescription,
} from '../../../shared/base/registration.js';
import { publicAgentCard } from '../../manifest/card-agent.js';
import { NOT_MOVED } from './moves.js';

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
    AND i.agent_card_uri = $1 || '/a/' || s.short_id AND ${NOT_MOVED}
  ORDER BY i.erc8004_agent_id, i.chain_id`;
const PUBLIC_IN_WORKSPACES = `SELECT w.operator_id, a->>'id' AS agent_id
  FROM workspaces w
  CROSS JOIN LATERAL jsonb_array_elements(w.data->'agents') a
  JOIN agent_manifests m ON m.agent_id = a->>'id' AND m.revision = (a->>'revision')::int
  WHERE w.operator_id = ANY($1::text[]) AND a->>'revokedAt' IS NULL
    AND m.manifest->'spec'->>'visibility' = 'public'`;

/**
 * Once agent_public_cards (migration 280) holds every agent, the domain file's rule is one join:
 * the identities this origin names whose agent has a public card now ($1 the origin).
 */
const DOMAIN_PUBLIC_IDENTITIES = `SELECT i.chain_id, i.registry_address,
    i.erc8004_agent_id::text AS erc8004_agent_id
  FROM base_identities i
  JOIN base_short_ids s ON s.agent_id = i.agent_id
  JOIN agent_public_cards c ON c.agent_id = i.agent_id
  WHERE i.state = 'confirmed' AND i.erc8004_agent_id IS NOT NULL
    AND i.agent_card_uri = $1 || '/a/' || s.short_id AND ${NOT_MOVED}
  ORDER BY i.erc8004_agent_id, i.chain_id`;

/**
 * DOMAIN_PUBLIC_IDENTITIES of one chain, newest first: read through the Base ID index (migration
 * 255: chain_id, this same COALESCE expression DESC, agent_id DESC), so a page or the scoped file
 * reads only its own rows, never every registration. For a confirmed row the expression is its
 * final id. $1 the origin, $2 the chain, $3 the row limit, $4 (AFTER only) the exclusive upper id.
 */
const NEWEST_ID = 'COALESCE(i.erc8004_agent_id, i.provisional_agent_id)';
const domainNewest = (after: boolean) => `SELECT i.chain_id, i.registry_address,
    i.erc8004_agent_id::text AS erc8004_agent_id
  FROM base_identities i
  JOIN base_short_ids s ON s.agent_id = i.agent_id
  JOIN agent_public_cards c ON c.agent_id = i.agent_id
  WHERE i.chain_id = $2 AND i.state = 'confirmed' AND i.erc8004_agent_id IS NOT NULL
    AND i.agent_card_uri = $1 || '/a/' || s.short_id AND ${NOT_MOVED}
    ${after ? `AND ${NEWEST_ID} < $4::numeric` : ''}
  ORDER BY ${NEWEST_ID} DESC, i.agent_id DESC
  LIMIT $3`;
const DOMAIN_NEWEST = domainNewest(false);
const DOMAIN_NEWEST_AFTER = domainNewest(true);

/** The chains a domain file or page lists (the Base allowlist, shared/base/chains.ts). */
export const DOMAIN_CHAINS: readonly number[] = Object.keys(BASE_NETWORKS).map(Number);

type DomainRow = { chain_id: number; registry_address: string; erc8004_agent_id: string };

/** Newest first: the higher ERC-8004 id first, then the chain (exact for uint256 ids). */
const newestFirst = (a: DomainRow, b: DomainRow) => {
  const x = BigInt(a.erc8004_agent_id);
  const y = BigInt(b.erc8004_agent_id);
  return x === y ? a.chain_id - b.chain_id : x > y ? -1 : 1;
};

/** The newest `scope` rows of each chain, then in the file's order (id, then chain, ascending). */
export function scopeDomainRows(rows: readonly DomainRow[], scope: number): DomainRow[] {
  const kept = new Map<number, number>();
  return [...rows]
    .sort(newestFirst)
    .filter((row) => {
      const n = kept.get(row.chain_id) ?? 0;
      kept.set(row.chain_id, n + 1);
      return n < scope;
    })
    .reverse();
}

/**
 * The domain file's registrations for an origin (see DOMAIN_IDENTITIES). All reads run in one
 * read-only REPEATABLE READ transaction: one snapshot, as the single statement before it saw, so a
 * move, revocation, visibility or revision change between them can never mix two states. Read
 * by the domain file's build (domain-file.ts), never by a request.
 */
export const DOMAIN_SNAPSHOT = 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY';

export async function domainRegistrations(
  db: Pick<Database, 'transaction'>,
  origin: string,
  options: {
    statementTimeoutMs?: number;
    /** Only the newest this many of each chain (scopeDomainRows); every one without it. */
    scope?: number;
  } = {},
): Promise<DomainRow[]> {
  const scope = options.scope;
  return db.transaction(async (tx) => {
    await tx.query(DOMAIN_SNAPSHOT);
    if (options.statementTimeoutMs !== undefined)
      await tx.query(`SET LOCAL statement_timeout = ${Math.floor(options.statementTimeoutMs)}`);
    const ready = await tx.query<{ ready: boolean }>(
      'SELECT ready FROM agent_public_cards_backfill WHERE id = 1',
    );
    if (ready.rows[0]?.ready === true && scope !== undefined) {
      // One indexed read of at most `scope` rows per chain, never every registration.
      const rows: DomainRow[] = [];
      for (const chain of DOMAIN_CHAINS)
        rows.push(...(await tx.query<DomainRow>(DOMAIN_NEWEST, [origin, chain, scope])).rows);
      return scopeDomainRows(rows, scope);
    }
    if (ready.rows[0]?.ready === true)
      return (await tx.query<DomainRow>(DOMAIN_PUBLIC_IDENTITIES, [origin])).rows;
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
    const listed = rows
      .filter((row) => row.workspace && publicCards.has(`${row.workspace}\u0000${row.agent_id}`))
      .map(({ chain_id, registry_address, erc8004_agent_id }) => ({
        chain_id,
        registry_address,
        erc8004_agent_id,
      }));
    // Until the public cards are backfilled the rule needs every row; the file is still scoped.
    return scope === undefined ? listed : scopeDomainRows(listed, scope);
  });
}

/**
 * The domain file's scope (see the header): the newest this many registrations of each chain. A
 * listed entry is at most about 100 bytes, so the scoped file of every chain stays under
 * DOMAIN_FILE_ALERT_BYTES uncompressed (tests/base-domain-file-limit.test.ts checks the bound).
 */
export const DOMAIN_FILE_SCOPE = 5_000;
/** The companion's page size (DOMAIN_PAGES_PATH): fixed, so a page is one bounded read. */
export const DOMAIN_PAGE_SIZE = 1_000;
export const DOMAIN_PAGES_PATH = '/api/public/base/domain-registrations';
/** The page read's own statement timeout: a request never waits longer on the database. */
export const DOMAIN_PAGE_TIMEOUT_MS = 2_000;

/** The companion's chain when ?chain= is absent: Base mainnet. */
const DOMAIN_CHAINS_DEFAULT = BASE_MAINNET;
// Only these keys, each in its one canonical form: any other query string would be a separate
// edge-cache entry (as on the Explorer's list, server/base/explorer/routes.ts).
const domainPageQuery = z
  .object({
    chain: z
      .string()
      .regex(/^[1-9][0-9]{0,9}$/)
      .optional(),
    before: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,77})$/)
      .optional(),
  })
  .strict();

/**
 * One page of the companion: the origin's listed registrations of one chain, newest first, below
 * `before` (exclusive) when given. Pages end between two ids, so an id that two registries share
 * is never split across pages. null while the public cards are not backfilled: the old rule needs
 * every row, which a request never reads.
 */
export async function domainPage(
  db: Pick<Database, 'transaction'>,
  origin: string,
  chainId: number,
  before: string | undefined,
): Promise<{ rows: DomainRow[]; nextBefore: string | null } | null> {
  return db.transaction(async (tx) => {
    await tx.query(DOMAIN_SNAPSHOT);
    await tx.query(`SET LOCAL statement_timeout = ${DOMAIN_PAGE_TIMEOUT_MS}`);
    const ready = await tx.query<{ ready: boolean }>(
      'SELECT ready FROM agent_public_cards_backfill WHERE id = 1',
    );
    if (ready.rows[0]?.ready !== true) return null;
    const rows = (
      await tx.query<DomainRow>(
        before === undefined ? DOMAIN_NEWEST : DOMAIN_NEWEST_AFTER,
        before === undefined
          ? [origin, chainId, DOMAIN_PAGE_SIZE + 1]
          : [origin, chainId, DOMAIN_PAGE_SIZE + 1, before],
      )
    ).rows;
    if (rows.length <= DOMAIN_PAGE_SIZE) return { rows, nextBefore: null };
    let page = rows.slice(0, DOMAIN_PAGE_SIZE);
    const last = page[page.length - 1]!.erc8004_agent_id;
    if (rows[DOMAIN_PAGE_SIZE]!.erc8004_agent_id === last) {
      const whole = page.filter((row) => row.erc8004_agent_id !== last);
      if (whole.length) page = whole;
    }
    return { rows: page, nextBefore: page[page.length - 1]!.erc8004_agent_id };
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
/** How long one server instance reuses its read of the stored domain file (small next to the 15 s). */
export const DOMAIN_FILE_REUSE_MS = 2_000;
/**
 * The function host's limit on one response body (Vercel: 4.5 MB). The domain file is scoped
 * (DOMAIN_FILE_SCOPE) so that even uncompressed it stays far below it; it is still served
 * gzip-compressed to clients that take gzip. The build's size guard (domain-file.ts): an ALERT
 * line once the uncompressed body passes DOMAIN_FILE_ALERT_BYTES, and a body over
 * DOMAIN_FILE_MAX_BYTES is never stored (the last stored file stays, with an ALERT line).
 */
export const DOMAIN_FILE_BODY_LIMIT = 4_500_000;
export const DOMAIN_FILE_ALERT_BYTES = 2_500_000;
export const DOMAIN_FILE_MAX_BYTES = 3_600_000;

/** Whether the client takes a gzip body (Accept-Encoding names gzip or *, with q above 0). */
export function acceptsGzip(header: string | string[] | undefined): boolean {
  const value = Array.isArray(header) ? header.join(',') : (header ?? '');
  return value.split(',').some((part) => {
    const [coding, ...params] = part.trim().toLowerCase().split(';');
    if (coding?.trim() !== 'gzip' && coding?.trim() !== '*') return false;
    const q = params.map((param) => param.trim()).find((param) => param.startsWith('q='));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

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

/** What a refusal calls the agent's chain: Base unless it has an identity row on an Arc network. */
export async function registeredChainName(
  db: Pick<Database, 'query'>,
  agentId: string,
): Promise<string> {
  const { rows } = await db.query<{ chain_id: number }>(
    'SELECT chain_id FROM base_identities WHERE agent_id = $1',
    [agentId],
  );
  const arc = rows.map((row) => chainView(Number(row.chain_id))).find((v) => v?.slug === 'arc');
  return arc?.name ?? 'Base';
}

/** The refusal to make a registered agent private, in its own chain's name. */
export const staysPublicMessage = (chainName: string) =>
  `${chainName === 'Base' ? 'A Base' : `An ${chainName}`} agent's profile stays public.`;

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
  // One read of the stored domain file per origin at a time, reused for DOMAIN_FILE_REUSE_MS: a
  // query string misses the edge cache. The file itself is built by the cron (domain-file.ts).
  const domainReads = new Map<string, { until: number; file: Promise<Buffer | null> }>();
  const storedFile = async (origin: string) => {
    const { rows } = await deps.db.query<{ body: Uint8Array }>(
      'SELECT body FROM base_domain_files WHERE origin = $1',
      [origin],
    );
    return rows[0] ? Buffer.from(rows[0].body) : null;
  };
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
      read = { until: now + DOMAIN_FILE_REUSE_MS, file: storedFile(origin) };
      domainReads.set(origin, read);
      const settled = read;
      // A failed read is never reused.
      settled.file.catch(() => {
        if (domainReads.get(origin) === settled) domainReads.delete(origin);
      });
    }
    let gzipped: Buffer | null;
    try {
      gzipped = await read.file;
    } catch {
      return notReady(reply, 'busy');
    }
    // Not built yet for this origin (the cron's first run): busy, never an empty file, which
    // registry explorers would read as no agent being verified here.
    if (!gzipped) return notReady(reply, 'busy');
    reply
      .header('Content-Type', 'application/json; charset=utf-8')
      .header('Access-Control-Allow-Origin', '*')
      .header('Cache-Control', REGISTRATION_LIVE)
      .header('Vercel-CDN-Cache-Control', REGISTRATION_LIVE_EDGE)
      .header('Vary', 'Accept-Encoding');
    if (acceptsGzip(request.headers['accept-encoding']))
      return reply.header('Content-Encoding', 'gzip').send(gzipped);
    return reply.send(gunzipSync(gzipped).toString('utf8'));
  });
  // The paginated companion (see the header): the full list, one bounded page per request.
  app.get(DOMAIN_PAGES_PATH, async (request, reply) => {
    const origin = deps.originOf?.(request) ?? `${request.protocol}://${request.host}`;
    try {
      await deps.limit?.(request);
    } catch (error) {
      const limited = error as { statusCode?: unknown; retryAfterMs?: unknown };
      if (limited.statusCode !== 429) return notReady(reply, 'busy');
      const ms = limited.retryAfterMs;
      return notReady(reply, 'limited', typeof ms === 'number' ? ms / 1000 : undefined);
    }
    const parsed = domainPageQuery.safeParse(request.query ?? {});
    const chainId = parsed.success ? Number(parsed.data.chain ?? DOMAIN_CHAINS_DEFAULT) : NaN;
    if (!parsed.success || !DOMAIN_CHAINS.includes(chainId))
      return reply
        .code(400)
        .header('Cache-Control', 'no-store')
        .send({
          error: `Use ?chain=<${DOMAIN_CHAINS.join('|')}> and ?before=<ERC-8004 agent id>.`,
          code: 'bad_request',
        });
    let page: Awaited<ReturnType<typeof domainPage>>;
    try {
      page = await domainPage(deps.db, origin, chainId, parsed.data.before);
    } catch {
      return notReady(reply, 'busy');
    }
    if (!page) return notReady(reply, 'busy');
    return reply
      .header('Content-Type', 'application/json; charset=utf-8')
      .header('Access-Control-Allow-Origin', '*')
      .header('Cache-Control', REGISTRATION_LIVE)
      .header('Vercel-CDN-Cache-Control', REGISTRATION_LIVE_EDGE)
      .send({
        ...buildDomainRegistrations(
          page.rows.map((row) => ({
            chainId: row.chain_id,
            registry: row.registry_address,
            erc8004AgentId: row.erc8004_agent_id,
          })),
        ),
        chainId,
        nextBefore: page.nextBefore,
      });
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
    // Confirmed rows and the final id only: a provisional id (migration 85) is never published,
    // nor an id whose holder moved it away (moves.ts) until it is re-verified.
    const identities = await deps.db.query<{
      chain_id: number;
      registry_address: string;
      erc8004_agent_id: string;
      updated_at: string | number;
    }>(
      `SELECT i.chain_id, i.registry_address, i.erc8004_agent_id::text AS erc8004_agent_id,
         i.updated_at
       FROM base_identities i WHERE i.agent_id = $1 AND i.state = 'confirmed'
         AND i.erc8004_agent_id IS NOT NULL AND ${NOT_MOVED} ORDER BY i.chain_id`,
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
            ...(identities.rows.some((row) => chainFamily(row.chain_id) === 'arc')
              ? { chainName: 'Arc' as const }
              : {}),
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
