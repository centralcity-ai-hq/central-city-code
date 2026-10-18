import { randomUUID } from 'node:crypto';
import type { Database, Transaction as Tx } from '../database.js';
import { event, type Workspace } from '../model.js';
import type { Claimed, TargetOutcome } from '../wake/webhooks.js';
import { lockMentionCursor } from '../wake/cursor-lock.js';
import type { ResponderKeyring } from './keys.js';
import { findModel, type Provider } from './models.js';
import { buildPrompt, type PromptMessage } from './prompt.js';
import { isOwnerMessage } from './owner-message.js';
import {
  callModel,
  fetchPostTransport,
  type ModelResult,
  type ProviderPostTransport,
  type ReplyErrorCode,
} from './providers.js';
import { openStoredKey, type StoredCredential } from './rotation.js';
import { setResponderTarget } from './targets.js';

/**
 * Hosted responder delivery (docs/RESPONDER.md).
 *
 * The wake outbox (kind 'responder') claims one coalesced row per agent and calls `handle`. The
 * handler answers the agent's due room mentions one by one:
 *
 *  1. due = a room mention after `enabled_at`, not from an auto-reply, with no terminal reply
 *     row (N8; not `read_at`, so a live AI of the same owner acking first suppresses nothing);
 *  2. a per-mention LEASE (`lease_id`, `locked_until`) is taken with a conditional UPDATE before
 *     anything is charged or sent (B4); every later write is guarded by the lease;
 *  3. prechecks, the deadline (B5), shared limits and N5 shares, then the atomic cap reservation;
 *  4. the provider call holds no database connection; the key is decrypted with the root key its
 *     row names and zeroized after;
 *  5. the reply is stored as 'generated' (lease-guarded) before posting, so a retry never calls the
 *     provider twice; the post re-checks "on" under the room lock (B7) and is idempotent by key;
 *  6. handled mentions are acknowledged narrowly (read_at and unread_count, B6).
 *
 * Nothing here logs provider or key material; failures are fixed reason codes.
 */
export const DELIVERY_LIMITS = {
  /** A mention older than this is not answered. */
  expiryMs: 10 * 60_000,
  /** Longest provider call. */
  providerTimeoutMs: 18_000,
  /** Kept free after a call for the post and settle (B5). */
  marginMs: 4_000,
  /** No call when less than this is left for it. */
  minCallMs: 6_000,
  /** A lease covers one mention's worst case: call + post + margin. */
  leaseMs: 45_000,
  /** Provider attempts per mention. */
  providerAttempts: 3,
  backoffMs: [5_000, 30_000, 120_000] as const,
  /** Consecutive rate-limited mentions before a 15-minute pause; failures before a pause. */
  rateLimitPauseAfter: 3,
  rateLimitPauseMs: 15 * 60_000,
  failurePauseAfter: 10,
  /** Mentions answered per delivery (inline drains are shorter than cron drains). */
  perDelivery: 5,
  /** Characters of a posted reply. */
  replyChars: 4_000,
  /** Shared-limiter budgets (docs/RESPONDER.md). */
  perRoomPer10Min: 30,
  perAgentRoomPerHour: 20,
  perPairPerHour: 15,
  perPairPerDay: 20,
  unclaimedTriggersPerDay: 5,
  /** Share of the daily reply cap one room may use. */
  roomShare: 0.5,
} as const;

export type ReplyStatus =
  'pending' | 'generated' | 'posted' | 'skipped' | 'failed' | 'expired' | 'cancelled';

export interface PostReplyArgs {
  ownerId: string;
  agentId: string;
  roomId: string;
  text: string;
  idempotencyKey: string;
  autoReply: { provider: Provider; model: string };
  /** Runs inside the post transaction under the room lock; a refusal code cancels the post (B7). */
  precondition: (tx: Pick<Tx, 'query'>) => Promise<string | null>;
}
export type PostReplyResult =
  { ok: true; seq: number } | { ok: false; code: string; retryAfterMs?: number };

export interface DeliveryDependencies {
  db: Pick<Database, 'query' | 'transaction'>;
  clock: () => number;
  limit(key: string, max: number, windowMs: number): Promise<void>;
  mutate<T>(
    operatorId: string,
    action: (workspace: Workspace, tx: Tx, time: number) => T | Promise<T>,
  ): Promise<T>;
  keys: ResponderKeyring;
  transport?: ProviderPostTransport;
  postReply: (args: PostReplyArgs) => Promise<PostReplyResult>;
}

type Settings = {
  agent_id: string;
  owner_id: string;
  enabled: boolean;
  provider: Provider;
  model: string;
  instructions: string;
  daily_reply_cap: number;
  daily_spend_cap_microusd: string | number;
  status: 'active' | 'paused';
  pause_reason: string | null;
  paused_until: string | number | null;
  consecutive_failures: number;
  enabled_at: string | number | null;
  target_disabled_at: string | number | null | undefined;
  target_id: string | null;
};
type Due = {
  seq: string | number;
  room_id: string;
  message_id: string;
  source_seq: string | number;
  from_agent_id: string;
  trigger_owner_id: string;
  from_name: string;
  created_at: string | number;
};
type Reply = {
  agent_id: string;
  mention_seq: string | number;
  owner_id: string;
  room_id: string;
  source_seq: string | number;
  trigger_owner_id: string;
  status: ReplyStatus;
  attempts: number;
  lease_id: string;
  reserved_microusd: string | number;
  usage_day: string | null;
  reply_text: string | null;
  provider: Provider | null;
  model: string | null;
  mention_created_at: string | number;
};

const DAY = 86_400_000;
const dayOf = (time: number) => new Date(time).toISOString().slice(0, 10);
const TERMINAL_ACK: ReplyStatus[] = ['posted', 'skipped', 'failed', 'expired', 'cancelled'];

export function createResponderDelivery(d: DeliveryDependencies) {
  const transport = d.transport ?? fetchPostTransport;

  async function settings(q: Pick<Tx, 'query'>, agentId: string): Promise<Settings | undefined> {
    return (
      await q.query<Settings>(
        `SELECT s.*, w.id AS target_id, w.disabled_at AS target_disabled_at
           FROM responder_settings s
           LEFT JOIN wake_webhooks w ON w.agent_id=s.agent_id AND w.kind='responder'
          WHERE s.agent_id=$1`,
        [agentId],
      )
    ).rows[0];
  }
  const isOn = (s: Settings | undefined, time: number) =>
    !!s &&
    s.enabled &&
    s.status === 'active' &&
    !!s.target_id &&
    (s.target_disabled_at === null || s.target_disabled_at === undefined) &&
    (s.paused_until === null || Number(s.paused_until) <= time);

  /** Marks one mention read and keeps unread_count and the cursor in step (review B6). */
  async function ack(q: Pick<Tx, 'query'>, agentId: string, seq: number, time: number) {
    await lockMentionCursor(q, agentId);
    const marked = await q.query(
      'UPDATE mentions SET read_at=$3 WHERE agent_id=$1 AND seq=$2 AND read_at IS NULL RETURNING seq',
      [agentId, seq, time],
    );
    if (!marked.rows.length) return;
    await q.query(
      `UPDATE wake_cursors c SET unread_count=GREATEST(0, c.unread_count-1), updated_at=$2,
         acked_mention_seq=GREATEST(c.acked_mention_seq, COALESCE(
           (SELECT min(m.seq)-1 FROM mentions m WHERE m.agent_id=$1 AND m.read_at IS NULL),
           c.next_mention_seq-1))
       WHERE c.agent_id=$1`,
      [agentId, time],
    );
  }

  /** Terminal state for a leased (or new) reply; releases any reservation; acks the mention. */
  async function finish(
    reply: Pick<Reply, 'agent_id' | 'mention_seq' | 'lease_id'> & Partial<Reply>,
    status: ReplyStatus,
    reason: string | null,
    options: { refund?: boolean; spend?: boolean } = {},
  ) {
    const time = d.clock();
    await d.db.transaction(async (tx) => {
      const row = (
        await tx.query<{ reserved_microusd: string | number; usage_day: string | null }>(
          `UPDATE responder_replies SET status=$3, reason=$4, reply_text=NULL, finished_at=$5,
             lease_id=NULL, locked_until=NULL, reserved_microusd=0
           WHERE agent_id=$1 AND mention_seq=$2 AND lease_id=$6
           RETURNING (SELECT reserved_microusd FROM responder_replies r
                       WHERE r.agent_id=$1 AND r.mention_seq=$2) AS reserved_microusd, usage_day`,
          [reply.agent_id, reply.mention_seq, status, reason, time, reply.lease_id],
        )
      ).rows[0];
      if (!row) return; // lease lost: another drain owns it now
      const reserved = Number(reply.reserved_microusd ?? row.reserved_microusd ?? 0);
      if (row.usage_day && reserved > 0)
        await tx.query(
          `UPDATE responder_usage SET
             reserved_microusd=GREATEST(0, reserved_microusd-$3),
             spent_microusd=spent_microusd+CASE WHEN $4 THEN $3 ELSE 0 END,
             replies=CASE WHEN $5 THEN GREATEST(0, replies-1) ELSE replies END
           WHERE agent_id=$1 AND day=$2`,
          [reply.agent_id, row.usage_day, reserved, !!options.spend, !!options.refund],
        );
      if (TERMINAL_ACK.includes(status))
        await ack(tx, reply.agent_id, Number(reply.mention_seq), time);
    });
  }

  async function pause(
    s: Settings,
    reason: string,
    until: number | null,
    code: string,
  ): Promise<void> {
    await d.mutate(s.owner_id, async (workspace, tx, time) => {
      await tx.query(
        `UPDATE responder_settings SET status='paused', pause_reason=$2, paused_until=$3,
           updated_at=$4, updated_by='hosted responder' WHERE agent_id=$1`,
        [s.agent_id, reason, until, time],
      );
      if (reason === 'invalid_key')
        await tx.query(
          "UPDATE responder_credentials SET status='invalid' WHERE agent_id=$1 AND status='active'",
          [s.agent_id],
        );
      // Rate-limit pauses resume by themselves; the target stays on and retries after `until`.
      if (until === null)
        await setResponderTarget(tx, {
          agentId: s.agent_id,
          ownerId: s.owner_id,
          on: false,
          time,
          actor: 'hosted responder',
        });
      const name = workspace.agents.find((agent) => agent.id === s.agent_id)?.name ?? 'An agent';
      event(
        workspace,
        time,
        'responder.paused',
        `Auto-reply for ${name} paused (${code}).`,
        s.agent_id,
      );
    });
  }

  /** Cancels every open reply of an agent that is off (releasing reservations). */
  async function cancelOpen(agentId: string, reason: string) {
    const open = (
      await d.db.query<Reply>(
        "SELECT * FROM responder_replies WHERE agent_id=$1 AND status IN ('pending','generated')",
        [agentId],
      )
    ).rows;
    for (const row of open) {
      const lease = await takeLease(row, true);
      if (lease) await finish(lease, 'cancelled', reason, { refund: row.status === 'pending' });
    }
  }

  /** The per-mention lease (review B4). `force` ignores next_attempt_at (cancellation). */
  async function takeLease(row: Pick<Reply, 'agent_id' | 'mention_seq'>, force = false) {
    const time = d.clock();
    return (
      await d.db.query<Reply>(
        `UPDATE responder_replies SET lease_id=$3, locked_until=$4, attempts=attempts+1
          WHERE agent_id=$1 AND mention_seq=$2 AND status IN ('pending','generated')
            AND (locked_until IS NULL OR locked_until < $5) AND ($6 OR next_attempt_at <= $5)
          RETURNING *`,
        [row.agent_id, row.mention_seq, randomUUID(), time + DELIVERY_LIMITS.leaseMs, time, force],
      )
    ).rows[0];
  }

  async function release(reply: Reply, at: number, extra: { reason?: string } = {}) {
    await d.db.query(
      `UPDATE responder_replies SET lease_id=NULL, locked_until=NULL, next_attempt_at=$4, reason=$5
        WHERE agent_id=$1 AND mention_seq=$2 AND lease_id=$3`,
      [reply.agent_id, reply.mention_seq, reply.lease_id, at, extra.reason ?? null],
    );
  }

  /** Room, membership, agent and key checks; null when the reply may proceed. */
  async function precheck(q: Pick<Tx, 'query'>, s: Settings, reply: Reply): Promise<string | null> {
    const room = (
      await q.query<{ closed_at: unknown; responders_allowed: boolean }>(
        'SELECT closed_at,responders_allowed FROM rooms WHERE id=$1',
        [reply.room_id],
      )
    ).rows[0];
    if (!room) return 'room_closed';
    if (room.closed_at !== null) return 'room_closed';
    if (!room.responders_allowed) return 'room_disallowed';
    const member = (
      await q.query<{ n: number | string }>(
        `SELECT count(*) AS n FROM room_members WHERE room_id=$1 AND agent_id=$2
           AND kind='agent' AND removed_at IS NULL AND visible_from_seq < $3`,
        [reply.room_id, reply.agent_id, reply.source_seq],
      )
    ).rows[0];
    if (!Number(member?.n)) return 'not_member';
    const workspace = (
      await q.query<{ data: Workspace }>('SELECT data FROM workspaces WHERE operator_id=$1', [
        s.owner_id,
      ])
    ).rows[0]?.data;
    const agent = workspace?.agents.find((item) => item.id === reply.agent_id);
    if (!workspace || !agent || agent.revokedAt) return 'agent_revoked';
    if (agent.pausedAt || workspace.paused) return 'agent_paused';
    return null;
  }

  /** Shared-limiter budgets and N5 shares; a code to skip, a time to retry, or null. */
  async function budgets(
    s: Settings,
    reply: Reply,
    time: number,
  ): Promise<{ skip: string } | { retryAt: number } | null> {
    const L = DELIVERY_LIMITS;
    const expiry = Number(reply.mention_created_at) + L.expiryMs;
    const trigger = (
      await d.db.query<{ kind: string; unclaimed_ai: boolean }>(
        `SELECT o.kind, (o.kind='ai' AND EXISTS (SELECT 1 FROM ai_workspaces a
            WHERE a.operator_id=o.id AND a.claimed_at IS NULL)) AS unclaimed_ai
           FROM operators o WHERE o.id=$1`,
        [reply.trigger_owner_id],
      )
    ).rows[0];
    const source = (
      await d.db.query<{ sender_kind: string; sender_owner_id: string; auto_reply: unknown }>(
        'SELECT sender_kind,sender_owner_id,auto_reply FROM room_messages WHERE room_id=$1 AND seq=$2',
        [reply.room_id, reply.source_seq],
      )
    ).rows[0];
    const ownerPerson = source !== undefined && isOwnerMessage(source, s.owner_id);
    const buckets: [string, number, number][] = [
      [`responder-room:${reply.room_id}`, L.perRoomPer10Min, 10 * 60_000],
      [`responder-agent-room:${reply.agent_id}:${reply.room_id}`, L.perAgentRoomPerHour, 3_600_000],
    ];
    if (!ownerPerson) {
      buckets.push(
        [`responder-pair:${reply.agent_id}:${reply.trigger_owner_id}`, L.perPairPerHour, 3_600_000],
        [`responder-pair-day:${reply.agent_id}:${reply.trigger_owner_id}`, L.perPairPerDay, DAY],
      );
    }
    if (!trigger || trigger.kind === 'unclaimed' || trigger.unclaimed_ai)
      buckets.push([`responder-unclaimed-day:${reply.agent_id}`, L.unclaimedTriggersPerDay, DAY]);
    for (const [key, max, window] of buckets)
      try {
        await d.limit(key, max, window);
      } catch (error) {
        const after = (error as { retryAfterMs?: number }).retryAfterMs;
        if (typeof after === 'number' && time + after < expiry) return { retryAt: time + after };
        return { skip: 'rate_limited_room' };
      }
    // One room may use at most a share of the daily cap (N5).
    const share = Math.max(1, Math.floor(s.daily_reply_cap * L.roomShare));
    const inRoom = Number(
      (
        await d.db.query<{ n: number | string }>(
          `SELECT count(*) AS n FROM responder_replies WHERE agent_id=$1 AND room_id=$2
             AND status='posted' AND usage_day=$3`,
          [reply.agent_id, reply.room_id, dayOf(time)],
        )
      ).rows[0]?.n ?? 0,
    );
    if (inRoom >= share) return { skip: 'room_share' };
    return null;
  }

  /** Atomic cap reservation (§6.1); returns the reserved amount or a skip code. */
  async function reserve(
    s: Settings,
    reply: Reply,
    estimate: number,
    time: number,
  ): Promise<number | string> {
    const day = dayOf(time);
    return d.db.transaction(async (tx) => {
      await tx.query(
        'INSERT INTO responder_usage(agent_id,day,owner_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [s.agent_id, day, s.owner_id],
      );
      const ok = (
        await tx.query(
          `UPDATE responder_usage u SET replies=u.replies+1, reserved_microusd=u.reserved_microusd+$3
             FROM responder_settings s
            WHERE u.agent_id=$1 AND u.day=$2 AND s.agent_id=$1
              AND u.replies < s.daily_reply_cap
              AND u.spent_microusd + u.reserved_microusd + $3 <= s.daily_spend_cap_microusd
            RETURNING u.replies`,
          [s.agent_id, day, estimate],
        )
      ).rows.length;
      if (!ok) {
        const usage = (
          await tx.query<{ replies: number }>(
            'SELECT replies FROM responder_usage WHERE agent_id=$1 AND day=$2',
            [s.agent_id, day],
          )
        ).rows[0];
        return (usage?.replies ?? 0) >= s.daily_reply_cap ? 'daily_cap' : 'spend_cap';
      }
      const held = await tx.query(
        `UPDATE responder_replies SET reserved_microusd=$4, usage_day=$5
          WHERE agent_id=$1 AND mention_seq=$2 AND lease_id=$3 RETURNING 1`,
        [reply.agent_id, reply.mention_seq, reply.lease_id, estimate, day],
      );
      if (!held.rows.length) throw new Error('lease lost'); // rolls the reservation back
      return estimate;
    });
  }

  async function promptFor(s: Settings, reply: Reply, triggerName: string) {
    const room = (
      await d.db.query<{ name: string; topic: string }>(
        'SELECT name,topic FROM rooms WHERE id=$1',
        [reply.room_id],
      )
    ).rows[0]!;
    const visible = Number(
      (
        await d.db.query<{ v: number | string }>(
          'SELECT visible_from_seq AS v FROM room_members WHERE room_id=$1 AND agent_id=$2',
          [reply.room_id, reply.agent_id],
        )
      ).rows[0]?.v ?? Number(reply.source_seq),
    );
    const rows = (
      await d.db.query<{
        seq: string | number;
        sender_name: string;
        sender_owner_label: string;
        sender_owner_id: string;
        sender_kind: string;
        parts: unknown[];
        auto_reply: unknown;
      }>(
        `SELECT seq,sender_name,sender_owner_label,sender_owner_id,sender_kind,parts,auto_reply FROM room_messages
          WHERE room_id=$1 AND seq > $2 AND seq <= $3 ORDER BY seq DESC LIMIT 30`,
        [reply.room_id, visible, reply.source_seq],
      )
    ).rows.reverse();
    const agentName = (
      await d.db.query<{ data: Workspace }>('SELECT data FROM workspaces WHERE operator_id=$1', [
        s.owner_id,
      ])
    ).rows[0]!.data.agents.find((agent) => agent.id === reply.agent_id)!.name;
    const messages: PromptMessage[] = rows.map((row) => ({
      seq: Number(row.seq),
      sender: row.sender_name,
      owner: row.sender_owner_label,
      autoReply: row.auto_reply !== null && row.auto_reply !== undefined,
      ownerInstruction: isOwnerMessage(row, s.owner_id),
      parts: Array.isArray(row.parts) ? row.parts : [],
    }));
    return buildPrompt({
      agentName,
      roomName: room.name,
      topic: room.topic,
      instructions: s.instructions,
      messages,
      triggerSeq: Number(reply.source_seq),
      triggerSender: triggerName,
    });
  }

  function costOf(
    model: NonNullable<ReturnType<typeof findModel>>,
    result: Extract<ModelResult, { ok: true }>,
  ) {
    return Math.ceil(
      ((result.inputTokens + result.cacheTokens) * model.inputMicroUsdPerMTok +
        result.outputTokens * model.outputMicroUsdPerMTok) /
        1_000_000,
    );
  }

  /** Error code → what happens to this reply and to the responder (§4.5). */
  function policy(code: ReplyErrorCode): { pause?: string; fail?: string; retry?: boolean } {
    switch (code) {
      case 'invalid_key':
        return { pause: 'invalid_key' };
      case 'forbidden':
        return { pause: 'forbidden' };
      case 'model_unavailable':
        return { pause: 'model_unavailable' };
      case 'quota':
        return { pause: 'quota' };
      case 'too_large':
      case 'bad_request':
        return { fail: code };
      default:
        return { retry: true }; // rate_limited, server_error, timeout, unreachable
    }
  }

  async function answer(
    s: Settings,
    due: Due,
    deadline: number,
  ): Promise<'next' | 'paused' | 'stop'> {
    const time = d.clock();
    const createdAt = Number(due.created_at);
    await d.db.query(
      `INSERT INTO responder_replies(agent_id,mention_seq,owner_id,room_id,message_id,source_seq,
         trigger_agent_id,trigger_owner_id,status,next_attempt_at,mention_created_at,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,$9) ON CONFLICT DO NOTHING`,
      [
        s.agent_id,
        due.seq,
        s.owner_id,
        due.room_id,
        due.message_id,
        due.source_seq,
        due.from_agent_id,
        due.trigger_owner_id,
        time,
        createdAt,
      ],
    );
    const reply = await takeLease({ agent_id: s.agent_id, mention_seq: due.seq });
    if (!reply) return 'next'; // another drain holds it, or it is not due yet
    const L = DELIVERY_LIMITS;
    if (time - createdAt > L.expiryMs) {
      await finish(reply, 'expired', 'expired', { refund: reply.status === 'pending' });
      return 'next';
    }

    let text = reply.reply_text;
    let provider = reply.provider;
    let modelId = reply.model;
    if (reply.status === 'pending') {
      const refused = await precheck(d.db, s, reply);
      if (refused) {
        await finish(reply, 'skipped', refused);
        return 'next';
      }
      // B5: never start a call that cannot finish before the deadline.
      const remaining = deadline - d.clock();
      const timeout = Math.min(L.providerTimeoutMs, remaining - L.marginMs);
      if (timeout < L.minCallMs) {
        await release(reply, d.clock());
        return 'stop';
      }
      const budget = await budgets(s, reply, time);
      if (budget && 'skip' in budget) {
        await finish(reply, 'skipped', budget.skip);
        return 'next';
      }
      if (budget && 'retryAt' in budget) {
        await release(reply, budget.retryAt, { reason: 'rate_limited_room' });
        return 'next';
      }
      const model = findModel(s.provider, s.model);
      if (!model) {
        await finish(reply, 'skipped', 'model_not_allowed');
        return 'next';
      }
      const prompt = await promptFor(s, reply, due.from_name);
      const estimate = Math.ceil(
        (Math.ceil(prompt.chars / 3) * model.inputMicroUsdPerMTok +
          model.maxOutputTokens * model.outputMicroUsdPerMTok) /
          1_000_000,
      );
      const reserved = await reserve(s, reply, estimate, time).catch(() => 'lease_lost' as const);
      if (typeof reserved === 'string') {
        if (reserved !== 'lease_lost') await finish(reply, 'skipped', reserved);
        return 'next';
      }
      const held = { ...reply, reserved_microusd: reserved };
      const credential = (
        await d.db.query<StoredCredential & { status: string }>(
          `SELECT id,agent_id,owner_id,provider,kek_id,wrapped_dek,ciphertext,status FROM responder_credentials
            WHERE agent_id=$1 AND owner_id=$2 AND status='active'`,
          [s.agent_id, s.owner_id],
        )
      ).rows[0];
      if (!credential || credential.provider !== s.provider) {
        await finish(held, 'skipped', 'no_key', { refund: true });
        return 'next';
      }
      let key: Buffer;
      try {
        key = openStoredKey(d.keys, credential);
      } catch {
        await finish(held, 'failed', 'invalid_key', { refund: true });
        await pause(s, 'invalid_key', null, 'invalid_key');
        return 'paused';
      }
      let result: ModelResult;
      try {
        result = await callModel(
          transport,
          {
            provider: s.provider,
            model: model.id,
            maxOutputTokens: model.maxOutputTokens,
            effort: model.effort,
            system: prompt.system,
            user: prompt.user,
          },
          key,
          timeout,
        );
      } finally {
        key.fill(0);
      }
      if (!result.ok) {
        const rule = policy(result.code);
        // N4: once a request may have reached the provider, the reservation counts as spent.
        const spend = result.billedMaybe;
        if (rule.pause) {
          await finish(held, 'failed', result.code, { refund: !spend, spend });
          await pause(s, rule.pause, null, result.code);
          return 'paused';
        }
        if (rule.fail) {
          await finish(held, 'failed', result.code, { refund: !spend, spend });
          return 'next';
        }
        const failures = await d.db.query<{ consecutive_failures: number }>(
          `UPDATE responder_settings SET consecutive_failures=consecutive_failures+1 WHERE agent_id=$1
           RETURNING consecutive_failures`,
          [s.agent_id],
        );
        const count = failures.rows[0]?.consecutive_failures ?? 1;
        const retryAt =
          d.clock() +
          Math.max(
            result.retryAfterMs ?? 0,
            L.backoffMs[Math.min(reply.attempts - 1, L.backoffMs.length - 1)]!,
          );
        const last = reply.attempts >= L.providerAttempts || retryAt >= createdAt + L.expiryMs;
        // A retry gives its reservation back (a new attempt reserves again), except N4 spend.
        await finish(held, last ? 'failed' : 'pending', last ? 'provider_error' : result.code, {
          refund: !spend,
          spend,
        });
        if (!last)
          await d.db.query(
            `UPDATE responder_replies SET next_attempt_at=$3, finished_at=NULL WHERE agent_id=$1 AND mention_seq=$2
               AND status='pending'`,
            [s.agent_id, due.seq, retryAt],
          );
        if (result.code === 'rate_limited' && count >= L.rateLimitPauseAfter) {
          await pause(s, 'rate_limited', d.clock() + L.rateLimitPauseMs, 'rate_limited');
          return 'paused';
        }
        if (count >= L.failurePauseAfter) {
          await pause(s, 'repeated_failures', null, 'repeated_failures');
          return 'paused';
        }
        return 'next';
      }
      if (!result.text || result.refused) {
        await finish(held, 'skipped', result.refused ? 'refused' : 'empty', { spend: true });
        return 'next';
      }
      const cost = costOf(model, result);
      text = result.truncated
        ? `${result.text.slice(0, L.replyChars - 2)} …`
        : result.text.slice(0, L.replyChars);
      provider = s.provider;
      modelId = model.id;
      // Stored before posting: a retry after a crash posts this text and never calls again.
      const stored = await d.db.transaction(async (tx) => {
        const row = await tx.query(
          `UPDATE responder_replies SET status='generated', reply_text=$4, provider=$5, model=$6,
             input_tokens=$7, output_tokens=$8, cost_microusd=$9, reserved_microusd=0
           WHERE agent_id=$1 AND mention_seq=$2 AND lease_id=$3 RETURNING usage_day`,
          [
            s.agent_id,
            due.seq,
            reply.lease_id,
            text,
            provider,
            modelId,
            result.inputTokens + result.cacheTokens,
            result.outputTokens,
            cost,
          ],
        );
        const day = (row.rows[0] as { usage_day?: string } | undefined)?.usage_day;
        if (!day) return false;
        await tx.query(
          `UPDATE responder_usage SET reserved_microusd=GREATEST(0, reserved_microusd-$3),
             spent_microusd=spent_microusd+$4, input_tokens=input_tokens+$5, output_tokens=output_tokens+$6
           WHERE agent_id=$1 AND day=$2`,
          [
            s.agent_id,
            day,
            reserved,
            cost,
            result.inputTokens + result.cacheTokens,
            result.outputTokens,
          ],
        );
        await tx.query('UPDATE responder_settings SET consecutive_failures=0 WHERE agent_id=$1', [
          s.agent_id,
        ]);
        return true;
      });
      if (!stored) return 'next';
    }

    // Post (or re-post after a crash): idempotent by the mention, re-checked under the room lock.
    const posted = await d.postReply({
      ownerId: s.owner_id,
      agentId: s.agent_id,
      roomId: reply.room_id,
      text: text ?? '',
      idempotencyKey: `responder:${s.agent_id}:${due.seq}`,
      autoReply: { provider: provider ?? s.provider, model: modelId ?? s.model },
      precondition: async (tx) => {
        const current = await settings(tx, s.agent_id);
        if (!isOn(current, d.clock())) return 'responder_off';
        return precheck(tx, current!, reply);
      },
    });
    if (posted.ok) {
      const time2 = d.clock();
      await d.db.transaction(async (tx) => {
        const done = await tx.query(
          `UPDATE responder_replies SET status='posted', reply_seq=$4, reply_text=NULL, finished_at=$5,
             lease_id=NULL, locked_until=NULL WHERE agent_id=$1 AND mention_seq=$2 AND lease_id=$3 RETURNING 1`,
          [s.agent_id, due.seq, reply.lease_id, posted.seq, time2],
        );
        if (done.rows.length) await ack(tx, s.agent_id, Number(due.seq), time2);
      });
      return 'next';
    }
    if (posted.code === 'rate_limited' && typeof posted.retryAfterMs === 'number') {
      const at = d.clock() + posted.retryAfterMs;
      if (at < createdAt + L.expiryMs) {
        await release(reply, at, { reason: 'post_rate_limited' });
        return 'next';
      }
    }
    // Refused under the room lock (off, closed, removed, storage full, credential in text): terminal.
    await finish(reply, posted.code === 'responder_off' ? 'cancelled' : 'failed', posted.code);
    return 'next';
  }

  /**
   * Marks read the room mentions the responder will never answer (from before it was enabled, or
   * from an auto-reply post) and keeps unread_count and the cursor in step, as ack() does. Hosted
   * agents only (nothing else reads their mentions). The scan starts at the mention cursor, so it
   * is bounded by the unread mentions.
   */
  async function skipUnanswerable(agentId: string, enabledAt: number, time: number) {
    await d.db.transaction(async (tx) => {
      await lockMentionCursor(tx, agentId);
      const marked = await tx.query(
        `UPDATE mentions m SET read_at=$3
          WHERE m.agent_id=$1 AND m.read_at IS NULL AND m.source_kind='room'
            AND m.seq > COALESCE((SELECT c.acked_mention_seq FROM wake_cursors c WHERE c.agent_id=$1), 0)
            AND (m.created_at < $2 OR EXISTS (SELECT 1 FROM room_messages rm
                  WHERE rm.room_id=m.room_id AND rm.seq=m.source_seq AND rm.auto_reply IS NOT NULL))
            AND NOT EXISTS (SELECT 1 FROM responder_replies r WHERE r.agent_id=m.agent_id
                  AND r.mention_seq=m.seq AND r.status IN ('pending','generated'))
          RETURNING m.seq`,
        [agentId, enabledAt, time],
      );
      if (!marked.rows.length) return;
      await tx.query(
        `UPDATE wake_cursors c SET unread_count=GREATEST(0, c.unread_count-$3), updated_at=$2,
           acked_mention_seq=GREATEST(c.acked_mention_seq, COALESCE(
             (SELECT min(m.seq)-1 FROM mentions m WHERE m.agent_id=$1 AND m.read_at IS NULL),
             c.next_mention_seq-1))
         WHERE c.agent_id=$1`,
        [agentId, time, marked.rows.length],
      );
    });
  }

  /**
   * Whether the agent is hosted (run by the platform): then nothing but Auto-reply reads its
   * mentions. Any other agent may have a reader the server cannot rule out (a runtime, connected
   * or not, a chat-app connector over /mcp, or a wake-up webhook), so the mentions Auto-reply
   * never answers are never marked read for it; the backlog cap skips them instead
   * (wake/hooks.ts insertMention). An agent not found counts as not hosted.
   */
  async function hosted(ownerId: string, agentId: string): Promise<boolean> {
    const agent = (
      await d.db.query<{ mode: string | null }>(
        `SELECT a->>'mode' AS mode
           FROM workspaces w, jsonb_array_elements(w.data->'agents') a
          WHERE w.operator_id=$1 AND a->>'id'=$2 LIMIT 1`,
        [ownerId, agentId],
      )
    ).rows[0];
    return agent?.mode === 'hosted';
  }

  /** The outbox handler for kind 'responder'. */
  async function handle(row: Claimed, deadline: number): Promise<TargetOutcome> {
    const time = d.clock();
    const s = await settings(d.db, row.agent_id);
    if (
      s &&
      s.status === 'paused' &&
      s.pause_reason === 'rate_limited' &&
      s.paused_until !== null
    ) {
      if (Number(s.paused_until) > time) return { outcome: 'retry', at: Number(s.paused_until) };
      await d.db.query(
        `UPDATE responder_settings SET status='active', pause_reason=NULL, paused_until=NULL,
           consecutive_failures=0 WHERE agent_id=$1 AND status='paused' AND pause_reason='rate_limited'`,
        [row.agent_id],
      );
      return handle(row, deadline);
    }
    if (!isOn(s, time)) {
      await cancelOpen(row.agent_id, 'responder_off');
      return { outcome: 'paused' };
    }
    // Only a hosted agent, which has no reader besides Auto-reply: any other may read the
    // mentions Auto-reply never answers (a runtime, a connector or a webhook), so they stay
    // unread for it (R2-11). The backlog cap does not count them for an agent with Auto-reply
    // on, so they never stop Auto-reply either way (R1-30, wake/hooks.ts insertMention).
    if (await hosted(s!.owner_id, row.agent_id))
      await skipUnanswerable(row.agent_id, Number(s!.enabled_at ?? time), time);
    const due = (
      await d.db.query<Due>(
        `SELECT m.seq, m.room_id, m.source_id AS message_id, m.source_seq, m.from_agent_id, m.from_name,
                m.created_at, rm.sender_owner_id AS trigger_owner_id
           FROM mentions m
           JOIN room_messages rm ON rm.room_id=m.room_id AND rm.seq=m.source_seq
           LEFT JOIN responder_replies r ON r.agent_id=m.agent_id AND r.mention_seq=m.seq
          WHERE m.agent_id=$1 AND m.source_kind='room' AND m.created_at >= $2
            AND rm.auto_reply IS NULL
            AND (r.status IS NULL OR (r.status IN ('pending','generated')
                 AND r.next_attempt_at <= $3 AND (r.locked_until IS NULL OR r.locked_until < $3)))
          ORDER BY m.seq LIMIT $4`,
        [row.agent_id, Number(s!.enabled_at ?? time), time, DELIVERY_LIMITS.perDelivery + 1],
      )
    ).rows;
    let stopped = false;
    for (const mention of due.slice(0, DELIVERY_LIMITS.perDelivery)) {
      const step = await answer(s!, mention, deadline);
      if (step === 'paused') return { outcome: 'paused' };
      if (step === 'stop') {
        stopped = true;
        break;
      }
    }
    // Work left: more due mentions, or open replies scheduled later (retry at the earliest, B3).
    if (stopped || due.length > DELIVERY_LIMITS.perDelivery)
      return { outcome: 'retry', at: d.clock() + (stopped ? 1_000 : 0) };
    const next = (
      await d.db.query<{ at: string | number | null }>(
        `SELECT min(GREATEST(next_attempt_at, COALESCE(locked_until, 0))) AS at FROM responder_replies
          WHERE agent_id=$1 AND status IN ('pending','generated')`,
        [row.agent_id],
      )
    ).rows[0]?.at;
    return next === null || next === undefined
      ? { outcome: 'done' }
      : { outcome: 'retry', at: Number(next) };
  }

  return { handle };
}
