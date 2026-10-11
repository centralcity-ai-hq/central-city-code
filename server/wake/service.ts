import { randomBytes, randomUUID } from 'node:crypto';
import type { Database, Transaction as Tx } from '../database.js';
import { iso, type Workspace } from '../model.js';
import {
  WAKE_LIMITS,
  ackMentionsToolInput,
  clearWakeWebhookToolInput,
  mentionsToolInput,
  setWakeWebhookToolInput,
  type Mention,
  type MentionAck,
  type MentionPage,
  type WakeEventKind,
  type WakeToolName,
  type WakeWebhookView,
} from './contract.js';
import { WakeHub, type WakeKey } from './hub.js';
import { onUnwrappedSignals, withWakeSignals, type WakeSignal } from './signals.js';
import {
  WebhookUrlError,
  createOutbox,
  httpsWebhookTransport,
  validateWebhookUrl,
  webhookSecret,
  type Outbox,
  type TargetOutcome,
  type Claimed,
  type WebhookKey,
  type WebhookTransport,
} from './webhooks.js';

/**
 * @mentions and wake-up (docs/WAKE.md): mention listing and acknowledgement, webhook
 * registration, and the connection-free long-poll used by inbox, room and mention reads.
 *
 * Rules kept here: the rate limiter is only called before a transaction; a waiting request
 * holds no database connection (it waits on the WakeHub, whose batched cursor poll borrows a
 * pool client per statement); every read rechecks the caller's authority inside its own
 * transaction (guard), so a revoked grant stops the next read.
 */
export class WakeError extends Error {
  constructor(
    public statusCode: number,
    public errorCode: string,
    message: string,
  ) {
    super(message);
  }
}
const fail = (status: number, code: string, message: string): never => {
  throw new WakeError(status, code, message);
};

/**
 * Rechecks the caller inside a transaction and returns the scopes it holds (grant or key); a
 * console owner or runtime passes no guard and holds every read scope.
 */
export type WakeGuard = (tx: Tx, time: number) => Promise<readonly string[] | void>;
export interface WakePrincipal {
  operatorId: string;
  /** Audit label for webhook registration (never a person's name). */
  actor: string;
}
export interface WakeOptions {
  /** Webhook sender; tests inject one. Defaults to the SSRF-safe https transport. */
  transport?: WebhookTransport;
  /** Batched cursor poll interval (default 500 ms). */
  pollMs?: number;
  /** In-process retry window of one after-commit drain (default 12 s). */
  drainBudgetMs?: number;
  /** SSE stream lifetime before it closes itself for a resume (default 25 s). */
  streamMs?: number;
  /** SSE heartbeat comment interval (default 10 s). */
  heartbeatMs?: number;
  /** Webhook delivery attempts before a wake-up is dropped (default 6). */
  webhookAttempts?: number;
  /** Shared-store (rate limiter) budgets per owner and per source address, per minute. */
  rateLimits?: {
    streamOpensPerMinute?: number;
    waitsPerMinute?: number;
    waitsPerMinutePerAgent?: number;
  };
  /** Tests only: shrink the burst-settle window of waiting tool reads (WAKE_LIMITS.waitSettleMs). */
  settleMs?: number;
}
/** Who pays for a waiting read or a stream open: the owner and, for HTTP, the source address. */
export interface WaitCharge {
  owner: string;
  source?: string;
  /** Waiting tool reads only: the agent being polled, when the caller names it (inbox, mentions). */
  agent?: string;
  /** Waiting room tool reads only: the connector grant or key — the agent is known only inside the read. */
  grant?: string;
  /** Waiting room tool reads only: the room, so one connector may poll several rooms. */
  room?: string;
}
export interface WakeDependencies extends WakeOptions {
  db: Database;
  clock: () => number;
  limit(key: string, max: number, windowMs: number, message?: string): Promise<void>;
  /** Webhook root keys, current first (webhooks.ts wakeKeys: CITY_WAKE_SECRET or an HKDF subkey). */
  keys: WebhookKey[];
  /** Local mode retries failed webhooks on a timer; hosted mode retries on later activity. */
  retryTimer?: boolean;
}

type MentionRow = {
  agent_id: string;
  seq: string | number;
  source_kind: 'message' | 'room';
  source_id: string;
  room_id: string | null;
  source_seq: string | number;
  context_id: string | null;
  from_agent_id: string;
  from_name: string;
  from_owner_label: string | null;
  excerpt: string;
  created_at: string | number;
  read_at: string | number | null;
};
type WebhookRow = {
  id: string;
  agent_id: string;
  url: string;
  events: WakeEventKind[];
  created_at: string | number;
  last_success_at: string | number | null;
  last_failure_at: string | number | null;
  last_status: string | null;
  disabled_at: string | number | null;
};

const READ_SCOPES = ['workspace:read', 'messages:read', 'rooms:join'] as const;
/** Mention sources a caller may see: workspace:read plus the scope that reads the source. */
export const kindsFor = (scopes: readonly string[]) =>
  !scopes.includes('workspace:read')
    ? []
    : [
        ...(scopes.includes('messages:read') ? ['message'] : []),
        ...(scopes.includes('rooms:join') ? ['room'] : []),
      ];
const at = (value: string | number | null) => (value === null ? null : iso(Number(value)));
/** The scheduled drain's absolute budget: well inside the api/index.js maxDuration (60 s). */
export const CRON_DRAIN_BUDGET_MS = 25_000;

/** Runs a promise past the response on Vercel Fluid (waitUntil), else just in the background. */
function background(work: Promise<unknown>): void {
  work.catch(() => {});
  const context = (
    globalThis as { [key: symbol]: { get?: () => { waitUntil?: (p: Promise<unknown>) => void } } }
  )[Symbol.for('@vercel/request-context')];
  context?.get?.()?.waitUntil?.(work.catch(() => {}));
}

export interface Wake {
  /** The database messaging and rooms must use so their writes signal after commit. */
  db: Database;
  hub: WakeHub;
  outbox: Outbox;
  options: Required<Pick<WakeOptions, 'streamMs' | 'heartbeatMs'>>;
  /**
   * Drains wake-ups of kind 'responder' with an in-process handler (the hosted responder),
   * from the same outbox with the kind filter in the claim subquery (review B2). Attached after
   * construction because the handler posts through rooms, which use `db`.
   */
  attachResponder(
    handle: (row: Claimed, deadline: number) => Promise<TargetOutcome>,
    options?: { budgetMs?: number },
  ): void;
  /**
   * Long-poll: returns `read()` at once when it has data (watch returns null), otherwise waits up
   * to `waitSeconds` without a database connection and reads again when a watched cursor moves.
   */
  longPoll<T>(
    waitSeconds: number | undefined,
    read: () => Promise<T>,
    watch: (result: T) => WakeKey[] | null,
    signal?: AbortSignal,
    charge?: WaitCharge,
    /**
     * Tool reads (MCP) pass true: when news wakes the wait, a burst gets a short settle window
     * (options.settleMs, default WAKE_LIMITS.waitSettleMs) to arrive as one page — one client
     * turn — instead of one turn per message. Browser (REST) reads answer at once.
     */
    settle?: boolean,
  ): Promise<T>;
  /** Charges the shared limiter (before any transaction) for a waiting read or a stream open. */
  charge(kind: 'wait' | 'stream', who: WaitCharge): Promise<void>;
  mentions(
    p: WakePrincipal,
    agentId: string,
    query: { since?: number; limit?: number },
    guard?: WakeGuard,
  ): Promise<MentionPage>;
  ackMentions(
    p: WakePrincipal,
    agentId: string,
    seq: number,
    guard?: WakeGuard,
  ): Promise<MentionAck>;
  mentionSummary(operatorId: string): Promise<{ agents: MentionAck[] }>;
  getWebhook(
    p: WakePrincipal,
    agentId: string,
    guard?: WakeGuard,
  ): Promise<{ webhook: WakeWebhookView | null }>;
  setWebhook(
    p: WakePrincipal,
    agentId: string,
    body: { url: string; events?: WakeEventKind[] },
    guard?: WakeGuard,
  ): Promise<{ webhook: WakeWebhookView; secret: string; key_id: string; verify: string }>;
  clearWebhook(
    p: WakePrincipal,
    agentId: string,
    guard?: WakeGuard,
  ): Promise<{ agent_id: string; cleared: boolean }>;
  executeTool(
    p: WakePrincipal,
    tool: WakeToolName,
    body: unknown,
    guard: WakeGuard,
  ): Promise<unknown>;
  /** Triggers a webhook drain now (after-commit and opportunistic). */
  kick(): void;
  /**
   * Drains both outboxes (https webhooks and, when attached, the responder) and waits for them:
   * the scheduled drain (Vercel Cron) that picks up retries, backoffs and expired leases that no
   * after-commit drain is left to run on serverless. Counts are rows handled, never content.
   */
  drainNow(budgetMs?: number): Promise<{ webhooks: number; responder: number | null }>;
  close(): void;
}

/** Keys to wait on when a page came back empty (null when it has items). */
export function idleKeys(
  kind: WakeKey['kind'],
  id: string,
  page: { latest_seq: number; next_since: number },
  items: number,
): WakeKey[] | null {
  return items ? null : [{ kind, id, after: Math.max(page.next_since, page.latest_seq) }];
}

export const VERIFY_HINT =
  'Each POST carries webhook-id, webhook-timestamp and webhook-signature (Standard Webhooks): signature = "v1," + base64(HMAC-SHA256(base64-decoded secret after "whsec_", `${webhook-id}.${webhook-timestamp}.${raw body}`)). During a key rotation the header carries several space-separated signatures (webhook-key-id lists their key ids, current first): accept if any matches. Reject timestamps more than 5 minutes old and repeated webhook-id values. The body has ids and seqs only; read with your tools.';

export function createWake(d: WakeDependencies): Wake {
  const hub = new WakeHub(d.db, d.pollMs ?? 500, () => kick());
  const outbox = createOutbox({
    db: d.db,
    clock: d.clock,
    keys: d.keys,
    maxAttempts: d.webhookAttempts,
    transport: d.transport ?? httpsWebhookTransport,
  });
  const budget = d.drainBudgetMs ?? 12_000;
  let lastKick = 0;
  function kick(force = false): void {
    // At most one opportunistic drain per second per instance; after-commit signals force one.
    const now = Date.now();
    if (!force && now - lastKick < 1000) return;
    lastKick = now;
    background(outbox.drain(budget));
    if (responderOutbox) background(responderOutbox.drain(responderBudget));
  }
  let responderOutbox: Outbox | undefined;
  // B5: a responder drain gives its handler a deadline; calls start only while one fits.
  let responderBudget = 20_000;
  function deliver(signals: WakeSignal[]): void {
    let drain = false;
    for (const signal of signals)
      if (signal.kind === 'outbox') drain = true;
      else hub.notify(signal.kind, signal.id, signal.seq);
    if (drain) kick(true);
  }
  const db = withWakeSignals(d.db, deliver);
  const unsubscribe = onUnwrappedSignals(deliver);
  const retry = d.retryTimer ? setInterval(() => kick(), 2000) : undefined;
  retry?.unref?.();

  async function workspaceOf(tx: Tx, operatorId: string): Promise<Workspace> {
    const row = (
      await tx.query<{ data: Workspace }>('SELECT data FROM workspaces WHERE operator_id=$1', [
        operatorId,
      ])
    ).rows[0];
    if (!row) fail(401, 'unauthorized', 'Sign in to continue.');
    return row!.data;
  }
  async function ownAgent(tx: Tx, operatorId: string, agentId: string, live = false) {
    const workspace = await workspaceOf(tx, operatorId);
    const agent = workspace.agents.find((item) => item.id === agentId);
    if (!agent) fail(404, 'agent_not_found', 'Agent not found in this workspace.');
    if (live && agent!.revokedAt) fail(403, 'agent_revoked', `${agent!.name} is revoked.`);
    return agent!;
  }
  function needKinds(scopes: readonly string[]): string[] {
    const kinds = kindsFor(scopes);
    if (!kinds.length)
      fail(
        403,
        'insufficient_scope',
        'Mentions need workspace:read plus messages:read or rooms:join.',
      );
    return kinds;
  }
  async function scopesOf(tx: Tx, time: number, guard?: WakeGuard): Promise<readonly string[]> {
    const scopes = guard ? await guard(tx, time) : undefined;
    return scopes ?? READ_SCOPES;
  }
  function project(row: MentionRow, acked: number): Mention {
    const seq = Number(row.seq);
    return {
      seq,
      agent_id: row.agent_id,
      source: row.source_kind,
      message_id: row.source_id,
      source_seq: Number(row.source_seq),
      room_id: row.room_id,
      context_id: row.context_id,
      from_agent_id: row.from_agent_id,
      from_agent_name: row.from_name,
      from_owner_label: row.from_owner_label,
      origin: row.source_kind === 'room' || row.from_owner_label !== null ? 'external' : 'internal',
      excerpt: row.excerpt,
      created_at: iso(Number(row.created_at)),
      read: row.read_at !== null || seq <= acked,
    };
  }
  async function cursorOf(tx: Tx, agentId: string, lock = false) {
    const row = (
      await tx.query<{ next_mention_seq: string | number; acked_mention_seq: string | number }>(
        `SELECT next_mention_seq,acked_mention_seq FROM wake_cursors WHERE agent_id=$1${lock ? ' FOR UPDATE' : ''}`,
        [agentId],
      )
    ).rows[0];
    const latest = row ? Number(row.next_mention_seq) - 1 : 0;
    const acked = row ? Number(row.acked_mention_seq) : 0;
    return { latest, acked };
  }
  /** Room mentions stay visible only while the agent is still an active member of that room. */
  const VISIBLE = `m.source_kind = ANY($2::text[]) AND (m.room_id IS NULL OR EXISTS (
    SELECT 1 FROM room_members rm WHERE rm.room_id=m.room_id AND rm.agent_id=m.agent_id AND rm.removed_at IS NULL
      AND rm.visible_from_seq < m.source_seq))`;

  async function mentions(
    p: WakePrincipal,
    agentId: string,
    query: { since?: number; limit?: number },
    guard?: WakeGuard,
  ): Promise<MentionPage> {
    const limit = Math.min(query.limit ?? WAKE_LIMITS.defaultPageSize, WAKE_LIMITS.pageSize);
    return db.transaction(async (tx) => {
      const time = d.clock();
      const kinds = needKinds(await scopesOf(tx, time, guard));
      await ownAgent(tx, p.operatorId, agentId);
      const cursor = await cursorOf(tx, agentId);
      const since = query.since ?? cursor.acked;
      const rows = (
        await tx.query<MentionRow>(
          `SELECT m.* FROM mentions m WHERE m.agent_id=$1 AND ${VISIBLE} AND m.seq>$3 ORDER BY m.seq LIMIT $4`,
          [agentId, kinds, since, limit + 1],
        )
      ).rows;
      const unread = Number(
        (
          await tx.query<{ n: string | number }>(
            `SELECT count(*) AS n FROM mentions m WHERE m.agent_id=$1 AND ${VISIBLE} AND m.seq>$3 AND m.read_at IS NULL`,
            [agentId, kinds, cursor.acked],
          )
        ).rows[0]?.n ?? 0,
      );
      const page = rows.slice(0, limit).map((row) => project(row, cursor.acked));
      return {
        agent_id: agentId,
        mentions: page,
        latest_seq: cursor.latest,
        acked_seq: cursor.acked,
        unread,
        next_since: page.at(-1)?.seq ?? since,
        has_more: rows.length > limit,
      };
    });
  }

  /**
   * Acknowledges mentions the caller can see. The shared cursor never moves past an unread
   * mention of a source the caller may not read (so another client still gets it); visible
   * mentions up to seq are marked read individually.
   */
  async function ackMentions(
    p: WakePrincipal,
    agentId: string,
    seq: number,
    guard?: WakeGuard,
  ): Promise<MentionAck> {
    return db.transaction(async (tx) => {
      const time = d.clock();
      const kinds = needKinds(await scopesOf(tx, time, guard));
      await ownAgent(tx, p.operatorId, agentId);
      const cursor = await cursorOf(tx, agentId, true);
      if (seq > cursor.latest)
        fail(
          400,
          'ack_beyond_latest',
          `seq ${seq} is beyond the latest mention (${cursor.latest}).`,
        );
      const hidden = (
        await tx.query<{ seq: string | number | null }>(
          'SELECT min(seq) AS seq FROM mentions WHERE agent_id=$1 AND seq>$2 AND seq<=$3 AND read_at IS NULL AND NOT (source_kind = ANY($4::text[]))',
          [agentId, cursor.acked, seq, kinds],
        )
      ).rows[0]?.seq;
      const through = hidden === null || hidden === undefined ? seq : Number(hidden) - 1;
      const marked = await tx.query(
        'UPDATE mentions SET read_at=$3 WHERE agent_id=$1 AND seq<=$2 AND read_at IS NULL AND source_kind = ANY($4::text[]) RETURNING seq',
        [agentId, seq, time, kinds],
      );
      // The backlog counts unread mentions (migration 26).
      if (marked.rows.length)
        await tx.query(
          'UPDATE wake_cursors SET unread_count=GREATEST(0, unread_count-$2) WHERE agent_id=$1',
          [agentId, marked.rows.length],
        );
      if (through > cursor.acked)
        await tx.query(
          'UPDATE wake_cursors SET acked_mention_seq=$2, updated_at=$3 WHERE agent_id=$1',
          [agentId, through, time],
        );
      const acked = Math.max(through, cursor.acked);
      const unread = Number(
        (
          await tx.query<{ n: string | number }>(
            `SELECT count(*) AS n FROM mentions m WHERE m.agent_id=$1 AND ${VISIBLE} AND m.seq>$3 AND m.read_at IS NULL`,
            [agentId, kinds, acked],
          )
        ).rows[0]?.n ?? 0,
      );
      return { agent_id: agentId, acked_seq: acked, latest_seq: cursor.latest, unread };
    });
  }

  async function mentionSummary(operatorId: string) {
    return db.transaction(async (tx) => {
      const workspace = await workspaceOf(tx, operatorId);
      const rows = (
        await tx.query<{
          agent_id: string;
          next_mention_seq: string | number;
          acked_mention_seq: string | number;
        }>(
          'SELECT agent_id,next_mention_seq,acked_mention_seq FROM wake_cursors WHERE agent_id = ANY($1::text[])',
          [workspace.agents.map((agent) => agent.id)],
        )
      ).rows;
      return {
        agents: rows.map((row) => {
          const latest = Number(row.next_mention_seq) - 1,
            acked = Number(row.acked_mention_seq);
          return {
            agent_id: row.agent_id,
            latest_seq: latest,
            acked_seq: acked,
            unread: latest - acked,
          };
        }),
      };
    });
  }

  function view(row: WebhookRow): WakeWebhookView {
    return {
      agent_id: row.agent_id,
      url: row.url,
      events: row.events,
      created_at: iso(Number(row.created_at)),
      last_success_at: at(row.last_success_at),
      last_failure_at: at(row.last_failure_at),
      last_status: row.last_status,
      disabled: row.disabled_at !== null,
    };
  }
  async function getWebhook(p: WakePrincipal, agentId: string, guard?: WakeGuard) {
    return db.transaction(async (tx) => {
      await scopesOf(tx, d.clock(), guard);
      await ownAgent(tx, p.operatorId, agentId);
      const row = (
        await tx.query<WebhookRow>(
          "SELECT * FROM wake_webhooks WHERE agent_id=$1 AND owner_id=$2 AND kind='https'",
          [agentId, p.operatorId],
        )
      ).rows[0];
      return { webhook: row ? view(row) : null };
    });
  }
  async function setWebhook(
    p: WakePrincipal,
    agentId: string,
    body: { url: string; events?: WakeEventKind[] },
    guard?: WakeGuard,
  ) {
    let url: URL;
    try {
      url = validateWebhookUrl(body.url);
    } catch (error) {
      return fail(400, 'invalid_webhook_url', (error as WebhookUrlError).message);
    }
    const events = [...new Set(body.events ?? ['message', 'mention'])].sort() as WakeEventKind[];
    // Charged before the transaction (the hosted limiter needs its own pool client).
    await d.limit(`wake-webhook:${p.operatorId}`, WAKE_LIMITS.webhookSetsPerHour, 3_600_000);
    return db.transaction(async (tx) => {
      const time = d.clock();
      await scopesOf(tx, time, guard);
      await ownAgent(tx, p.operatorId, agentId, true);
      // Replaces the agent's HTTPS webhook only; a hosted responder target is separate.
      await tx.query("DELETE FROM wake_webhooks WHERE agent_id=$1 AND kind='https'", [agentId]);
      const count = Number(
        (
          await tx.query<{ n: string | number }>(
            "SELECT count(*) AS n FROM wake_webhooks WHERE owner_id=$1 AND kind='https'",
            [p.operatorId],
          )
        ).rows[0]?.n ?? 0,
      );
      if (count >= WAKE_LIMITS.webhooksPerOwner)
        fail(
          429,
          'webhook_limit',
          `A workspace may register ${WAKE_LIMITS.webhooksPerOwner} webhooks.`,
        );
      const id = randomUUID(),
        salt = randomBytes(16).toString('base64url');
      const row = (
        await tx.query<WebhookRow>(
          `INSERT INTO wake_webhooks(id,agent_id,owner_id,url,events,salt,created_at,created_by)
           VALUES($1,$2,$3,$4,$5::text[],$6,$7,$8) RETURNING *`,
          [id, agentId, p.operatorId, url.toString(), events, salt, time, p.actor],
        )
      ).rows[0]!;
      return {
        webhook: view(row),
        secret: webhookSecret(d.keys[0]!.key, id, salt),
        key_id: d.keys[0]!.kid,
        verify: VERIFY_HINT,
      };
    });
  }
  async function clearWebhook(p: WakePrincipal, agentId: string, guard?: WakeGuard) {
    return db.transaction(async (tx) => {
      await scopesOf(tx, d.clock(), guard);
      await ownAgent(tx, p.operatorId, agentId);
      const removed = await tx.query(
        "DELETE FROM wake_webhooks WHERE agent_id=$1 AND owner_id=$2 AND kind='https' RETURNING id",
        [agentId, p.operatorId],
      );
      return { agent_id: agentId, cleared: removed.rows.length > 0 };
    });
  }

  async function longPoll<T>(
    waitSeconds: number | undefined,
    read: () => Promise<T>,
    watch: (result: T) => WakeKey[] | null,
    signal?: AbortSignal,
    who?: WaitCharge,
    settle?: boolean,
  ): Promise<T> {
    // The first read runs the permission check; charging after it means a caller without
    // access (the read 404s) never touches the agent's or grant's wait budget. Charge only
    // when nothing was found: a wait that is charged after a successful read can 429 after
    // the read already advanced the caller's cursor, and those messages would be lost.
    let result = await read();
    if (!waitSeconds) return result;
    const empty = watch(result) !== null;
    if (who && empty) await charge('wait', who);
    const deadline = Date.now() + waitSeconds * 1000;
    const settleMs = settle ? (d.settleMs ?? WAKE_LIMITS.waitSettleMs) : 0;
    kick();
    for (;;) {
      const keys = watch(result);
      const remaining = deadline - Date.now();
      if (!keys || remaining <= 0 || signal?.aborted) return result;
      if (!(await hub.wait(keys, remaining, signal))) return result;
      // News woke the wait: a burst often follows within seconds. Give it a moment to settle and
      // collect it into this one answer, bounded by the caller's deadline; a disconnect ends it.
      const quiet = Math.min(settleMs, deadline - Date.now());
      if (quiet > 0 && !signal?.aborted)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            signal?.removeEventListener('abort', done);
            resolve();
          }, quiet);
          function done() {
            clearTimeout(timer);
            resolve();
          }
          signal?.addEventListener('abort', done, { once: true });
        });
      result = await read();
    }
  }

  const budgets = {
    stream: d.rateLimits?.streamOpensPerMinute ?? WAKE_LIMITS.streamOpensPerMinute,
    wait: d.rateLimits?.waitsPerMinute ?? WAKE_LIMITS.waitsPerMinute,
    waitPerAgent: d.rateLimits?.waitsPerMinutePerAgent ?? WAKE_LIMITS.waitsPerMinutePerAgent,
  };
  /** Shared across instances (the hosted limiter is PostgreSQL); never inside a transaction. */
  async function charge(kind: 'wait' | 'stream', who: WaitCharge): Promise<void> {
    await d.limit(`wake-${kind}-owner:${who.owner}`, budgets[kind], 60_000);
    if (who.source) await d.limit(`wake-${kind}-ip:${who.source}`, budgets[kind], 60_000);
    // The per-agent (or per-connector-grant) bucket bounds one looping tool client
    // independently of the owner's whole fleet; REST waits answer per message and stay on the
    // owner budget alone, and reads without wait are never charged. A room bucket is per room,
    // so one connector may poll its rooms in parallel. The 429 names the remedy: stop polling.
    const stop =
      'Waiting reads are limited for this client. Stop polling this wait; check again when your user asks or after a long gap.';
    if (kind === 'wait' && who.agent)
      await d.limit(`wake-wait-agent:${who.agent}`, budgets.waitPerAgent, 60_000, stop);
    if (kind === 'wait' && who.grant)
      await d.limit(
        `wake-wait-grant:${who.grant}:${who.room ?? ''}`,
        budgets.waitPerAgent,
        60_000,
        stop,
      );
  }

  async function executeTool(
    p: WakePrincipal,
    tool: WakeToolName,
    body: unknown,
    guard: WakeGuard,
  ): Promise<unknown> {
    if (tool === 'city_mentions') {
      const { agent_id, wait, ...query } = mentionsToolInput.parse(body);
      return longPoll(
        wait,
        () => mentions(p, agent_id, query, guard),
        (page) => idleKeys('mention', page.agent_id, page, page.mentions.length),
        undefined,
        { owner: p.operatorId, agent: agent_id },
        true,
      );
    }
    if (tool === 'city_ack_mentions') {
      const { agent_id, seq } = ackMentionsToolInput.parse(body);
      return ackMentions(p, agent_id, seq, guard);
    }
    if (tool === 'city_set_wake_webhook') {
      const { agent_id, ...values } = setWakeWebhookToolInput.parse(body);
      return setWebhook(p, agent_id, values, guard);
    }
    const { agent_id } = clearWakeWebhookToolInput.parse(body);
    return clearWebhook(p, agent_id, guard);
  }

  return {
    db,
    hub,
    outbox,
    options: { streamMs: d.streamMs ?? 25_000, heartbeatMs: d.heartbeatMs ?? 10_000 },
    longPoll,
    charge,
    mentions,
    ackMentions,
    mentionSummary,
    getWebhook,
    setWebhook,
    clearWebhook,
    executeTool,
    kick: () => kick(),
    async drainNow(budgetMs = CRON_DRAIN_BUDGET_MS) {
      lastKick = Date.now();
      // One absolute deadline for both kinds, inside the function's 30 s maxDuration.
      const [webhooks, responder] = await Promise.all([
        outbox.drain(budgetMs),
        responderOutbox ? responderOutbox.drain(budgetMs) : Promise.resolve(null),
      ]);
      return { webhooks, responder };
    },
    attachResponder(handle, options = {}) {
      responderOutbox?.close();
      responderBudget = options.budgetMs ?? responderBudget;
      responderOutbox = createOutbox({
        db: d.db,
        clock: d.clock,
        keys: d.keys,
        transport: d.transport ?? httpsWebhookTransport,
        kind: 'responder',
        // A lease on the wake-up row covers one delivery; per-mention leases do the rest (B4).
        lockMs: 60_000,
        claimLimit: 5,
        handler: handle,
        // A pass starts only while a provider call plus the post still fit (deliver.ts B5).
        minPassMs: 10_000,
      });
    },
    close() {
      clearInterval(retry);
      unsubscribe();
      hub.close();
      outbox.close();
      responderOutbox?.close();
    },
  };
}
