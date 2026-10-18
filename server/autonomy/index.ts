import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Database, Transaction as Tx } from '../database.js';
import type { CityLimits } from '../limits.js';
import type { Operator } from '../../shared/types.js';
import { listTemplatesToolInput } from '../../shared/assistant-tools.js';
import { clientAddressKey, clientAddressPrefixes } from '../rate-limit.js';
import { emptyWorkspace, event, iso, publicAgent, stopJob, type Workspace } from '../model.js';
import { descendants, issueRuntimeCredential } from '../agent-lifecycle.js';
import { signAgentCard } from '../manifest/agent-card.js';
import { cardAgent, compileCardFor } from '../manifest/card-agent.js';
import { builtinTemplates } from '../manifest/templates.js';
import type { PlatformSigner } from './signing.js';
import { revokeResponderCredentials } from '../responder/revoke.js';
import {
  AutonomyError,
  CLAIM_TOKEN,
  ENROLLMENT_CODE,
  UNCLAIMED_CAPACITY_ISSUE,
  createAutonomyService,
  type Actor,
  type AutonomyService,
} from './service.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const MANIFEST_MODE_KEYS = [
  'manifest',
  'template',
  'overrides',
  'dry_run',
  'idempotency_key',
  'parent_agent_id',
];
/** Empty partitions younger than this are never evicted (a create may be about to use them). */
const BUCKET_EVICTION_GRACE_MS = 10 * 60_000;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Version-4 UUIDs printed in widely copied documentation (Wikipedia, Swagger, PostgreSQL…). */
const EXAMPLE_UUIDS = new Set([
  '550e8400-e29b-41d4-a716-446655440000',
  'f47ac10b-58cc-4372-a567-0e02b2c3d479',
  '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  'd290f1ee-6c54-4b01-90e6-d701748f0851',
  'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed',
  '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
  '16fd2706-8baf-433b-82eb-8c7fada847da',
]);
/**
 * Words that mark a key as chosen rather than generated. Only words of seven or more letters
 * (plus two six-letter keyboard/password words) are listed, so a random key contains one by
 * chance with probability about 3e-8 at 22 characters.
 */
const KEY_WORDS = [
  'qwerty',
  'passwd',
  'password',
  'letmein',
  'example',
  'default',
  'testing',
  'idempotent',
  'request',
  'research',
  'extract',
  'verifier',
  'template',
  'manifest',
  'central',
  'anonymous',
  'unclaimed',
  'attempt',
  'session',
  'counter',
  'sequence',
  'january',
  'february',
  'september',
  'october',
  'november',
  'december',
  'tuesday',
  'wednesday',
  'thursday',
  'saturday',
  'chatgpt',
  'claudecode',
  'anthropic',
  'assistant',
  'workflow',
  'checker',
  'analyst',
];
const KEY_DATE = /(?:19|20)\d\d[-_]?(?:0[1-9]|1[0-2])[-_]?(?:0[1-9]|[12]\d|3[01])/;
/** 12+ digits (millisecond timestamps, counters) or a 10-digit Unix time in seconds (2014-2039). */
const KEY_NUMBER = /[0-9]{12}|(?<![0-9])(?:1[4-9]|2[01])[0-9]{8}(?![0-9])/;

/** Longest run whose character codes change by the same step of -1, 0 or +1 (aaaa, 1234, dcba). */
function longestRun(text: string): number {
  let longest = Math.min(text.length, 1);
  let run = 1;
  let step = Number.NaN;
  for (let index = 1; index < text.length; index++) {
    const next = text.charCodeAt(index) - text.charCodeAt(index - 1);
    run = Math.abs(next) <= 1 ? (next === step ? run + 1 : 2) : 1;
    step = next;
    longest = Math.max(longest, run);
  }
  return longest;
}
/** True when some substring of `length` characters occurs twice (overlapping allowed). */
function repeats(text: string, length: number): boolean {
  for (let index = 0; index + length < text.length; index++)
    if (text.indexOf(text.slice(index, index + length), index + 1) !== -1) return true;
  return false;
}
const seen = new Uint32Array(128);
let seenMark = 0;
/** Number of distinct characters in an ASCII string (allocation-free; keys are ASCII). */
function distinctCount(text: string): number {
  seenMark = (seenMark + 1) >>> 0;
  if (seenMark === 0) {
    seen.fill(0);
    seenMark = 1;
  }
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index) & 127;
    if (seen[code] !== seenMark) {
      seen[code] = seenMark;
      count++;
    }
  }
  return count;
}
/** Hex digits (lower case) that look random: at least 128 bits, no runs, repeats or low variety. */
function randomHex(hex: string): boolean {
  return hex.length >= 32 && distinctCount(hex) >= 6 && longestRun(hex) < 9 && !repeats(hex, 10);
}
/** A lower-case UUID that is version 4, not a published example, with random-looking digits. */
function randomUuid(uuid: string): boolean {
  return (
    UUID_V4.test(uuid) &&
    !EXAMPLE_UUIDS.has(uuid) &&
    randomHex(
      uuid.slice(0, 8) +
        uuid.slice(9, 13) +
        uuid.slice(14, 18) +
        uuid.slice(19, 23) +
        uuid.slice(24),
    )
  );
}

/**
 * Anonymous idempotency keys must be unguessable: everyone behind one address shares a partition,
 * and a neighbour who predicts a key (and the arguments) could send the request first and receive
 * its claim token. Accepted: a random UUID v4 (alone or with an affix such as `req_`), at least 32
 * random hex digits, or random base64url of at least 22 characters (16 random bytes). Refused:
 * other UUID versions and published example UUIDs; hex below 32 digits in any letter case;
 * decimal keys below 39 digits; letters of one case without digits (words); dictionary words;
 * dates; Unix timestamps and numbers of 12+ digits; runs of 7+ repeated or sequential characters
 * (8+ letters when digits and separators are skipped); a repeated 8-character substring; fewer
 * than 10 distinct characters. Each rule is sized so that a genuine random UUID v4 or 22-character
 * base64url key is refused far less often than 1 in 1,000,000 (about 1e-7 in total; tests fuzz
 * both). A literal "three character classes" rule is not used: about 1% of random 22-character
 * base64url keys contain neither a digit nor "-"/"_".
 */
export function highEntropyKey(key: unknown): boolean {
  if (typeof key !== 'string' || key.length > 128 || !/^[A-Za-z0-9_-]+$/.test(key)) return false;
  const lower = key.toLowerCase();
  if (UUID_SHAPE.test(key)) return randomUuid(lower);
  // Random UUIDs and long random hex runs carry the key whatever surrounds them.
  for (const uuid of lower.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ??
    [])
    if (randomUuid(uuid)) return true;
  // Hex and decimal keys are judged by their digits alone, in any letter case.
  const plain = lower.replace(/[-_]/g, '');
  if (/^[0-9]+$/.test(plain))
    return (
      plain.length >= 39 &&
      distinctCount(plain) >= 6 &&
      longestRun(plain) < 12 &&
      !repeats(plain, 12)
    );
  if (/^[0-9a-f]+$/.test(plain)) return randomHex(plain);
  for (const hex of lower.match(/[0-9a-f]{32,}/g) ?? []) if (randomHex(hex)) return true;
  if (key.length < 22) return false;
  const lowerCase = /[a-z]/.test(key);
  const upperCase = /[A-Z]/.test(key);
  const digits = /[0-9]/.test(key);
  // Letters of a single case with no digits (separators aside) read as words, not random text.
  if (!digits && lowerCase !== upperCase) return false;
  const alphabet =
    (lowerCase ? 26 : 0) + (upperCase ? 26 : 0) + (digits ? 10 : 0) + (/[-_]/.test(key) ? 2 : 0);
  if (key.length * Math.log2(alphabet) < 112) return false;
  return !(
    distinctCount(key) < 10 ||
    longestRun(key) >= 7 ||
    longestRun(lower.replace(/[^a-z]/g, '')) >= 8 ||
    KEY_NUMBER.test(key) ||
    KEY_DATE.test(key) ||
    repeats(key, 8) ||
    KEY_WORDS.some((word) => plain.includes(word))
  );
}

/** HMAC id of an unclaimed address scope ('source' | 'site' | 'network' | 'region'). */
export function unclaimedScopeId(secret: string, scope: string, value: string): string {
  return createHmac('sha256', secret)
    .update(`unclaimed-${scope}\n${value}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Anonymous creation reserves capacity in its own short transaction before the create runs (so
 * counter rows are never held during a create) and records what is still reserved in a hold row
 * of unclaimed_stats, keyed `hold:<created ms>:<uuid>:<site>:<network>:<region>` (no migration).
 * The create sets the hold to its unused remainder under the partition lock; the release returns
 * that remainder and deletes the hold. So at every commit point each counter equals the agents in
 * its partitions plus the holds covering it, which lets `unclaimed:admin reconcile` correct drift
 * without mistaking an in-flight reservation for it. A hold older than this is abandoned (its
 * process died between reserving and releasing) and reconcile may reclaim it.
 */
export const UNCLAIMED_HOLD_TTL_MS = 15 * 60_000;
export interface UnclaimedHold {
  key: string;
  createdAt: number;
  /** Counter keys the hold reserves against. */
  scopes: string[];
}
export function parseUnclaimedHold(key: string): UnclaimedHold | null {
  const match = /^hold:(\d{1,15}):[0-9a-f-]{36}:([0-9a-f]{32}):([0-9a-f]{32}):([0-9a-f]{32})$/.exec(
    key,
  );
  if (!match) return null;
  return {
    key,
    createdAt: Number(match[1]),
    scopes: ['global', `site:${match[2]}`, `network:${match[3]}`, `region:${match[4]}`],
  };
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
function templateKind(ref: unknown): 'Agent' | 'Team' | undefined {
  const match = typeof ref === 'string' ? /^template:([^@]+)@(.+)$/.exec(ref) : null;
  return match ? builtinTemplates.get(match[1]!, match[2]!)?.kind : undefined;
}
const capacityError = () =>
  new AutonomyError(409, UNCLAIMED_CAPACITY_ISSUE.message, [UNCLAIMED_CAPACITY_ISSUE]);

export interface AutonomyDependencies {
  db: Database;
  caps: CityLimits;
  signer: PlatformSigner;
  clock(): number;
  /** Server secret for source-bucket identifiers (CITY_RATE_LIMIT_KEY); ephemeral if unset. */
  sourceSecret?: string;
  /** Structured operational log line sink (defaults to console.warn). */
  log?: (line: string) => void;
  limit(key: string, max: number, window: number): Promise<void>;
  fail(code: number, message: string): never;
  owner(request: FastifyRequest): Promise<Operator>;
  optionalOperator(request: FastifyRequest): Promise<Operator | null>;
  originOf(request: FastifyRequest): string;
  mutate<T>(
    operatorId: string,
    action: (workspace: Workspace, tx: Tx, time: number) => T | Promise<T>,
  ): Promise<T>;
  /** AI-owned workspace capacity (server/workspaces), reported next to unclaimed capacity. */
  aiCapacity?: () => Promise<unknown>;
  /** Locks several workspace rows in a fixed (sorted) order within one transaction. */
  mutateMany<T>(
    operatorIds: string[],
    action: (workspaces: Map<string, Workspace>, tx: Tx, time: number) => T | Promise<T>,
  ): Promise<T>;
}
export interface Autonomy {
  service: AutonomyService;
  /** Unauthenticated tool call from `address` (unclaimed mode). */
  anonymousTool(address: string, tool: string, args: unknown, origin: string): Promise<unknown>;
}

/**
 * Phase 2 autonomous creation: unclaimed partitions for anonymous AI clients, claim, runtime
 * enrollment, signed Agent Cards and the platform JWKS.
 *
 * Unclaimed partition design: every anonymous source (IPv4 address or IPv6 /64) gets one
 * system-owned operator row with `kind = 'unclaimed'` and its own workspace row, identified by an
 * HMAC of the address prefix under a server secret. Such rows can never sign in (the name key
 * contains a character account names cannot, the password hash matches nothing and login filters
 * on kind = 'owner'), are excluded from account counts and offline backups, and reuse the
 * per-workspace lock and isolation unchanged. Anonymous callers never read a partition: they only
 * receive what their own call created. Capacity is tracked in atomically updated counters
 * (unclaimed_stats). F3 expires unclaimed agents after 72 hours on admission; empty partitions
 * are evicted when the partition bound is reached.
 */
export async function registerAutonomy(
  app: FastifyInstance,
  d: AutonomyDependencies,
): Promise<Autonomy> {
  const service = createAutonomyService(d.caps);
  const secret = d.sourceSecret || randomBytes(32).toString('hex');
  const scopeId = (scope: string, value: string) => unclaimedScopeId(secret, scope, value);
  const log = d.log ?? ((line: string) => console.warn(line));

  /**
   * Deletes up to `limit` empty unclaimed partitions idle since `cutoff` (never ones holding
   * agents). Candidates are locked (skipping busy ones) and re-checked under the lock.
   */
  async function evictEmptyBuckets(tx: Tx, time: number, limit: number): Promise<number> {
    const cutoff = time - BUCKET_EVICTION_GRACE_MS;
    const candidates = (
      await tx.query<{ operator_id: string }>(
        `SELECT w.operator_id FROM workspaces w
          JOIN operators o ON o.id=w.operator_id AND o.kind='unclaimed'
          LEFT JOIN unclaimed_buckets b ON b.operator_id=w.operator_id
          WHERE jsonb_array_length(w.data->'agents')=0
          AND COALESCE(b.last_used_at,b.created_at,0)<=$1
          ORDER BY COALESCE(b.last_used_at,b.created_at,0), w.operator_id LIMIT $2
          FOR UPDATE OF w SKIP LOCKED`,
        [cutoff, limit],
      )
    ).rows;
    let evicted = 0;
    for (const { operator_id: id } of candidates) {
      const current = (
        await tx.query<{ n: number | string; used: number | string | null }>(
          `SELECT jsonb_array_length(w.data->'agents') AS n, COALESCE(b.last_used_at,b.created_at,0) AS used
            FROM workspaces w LEFT JOIN unclaimed_buckets b ON b.operator_id=w.operator_id
            WHERE w.operator_id=$1`,
          [id],
        )
      ).rows[0];
      if (!current || Number(current.n) > 0 || Number(current.used) > cutoff) continue;
      for (const sql of [
        'DELETE FROM anonymous_receipts WHERE bucket_id=$1',
        'DELETE FROM claim_tokens WHERE bucket_id=$1',
        'DELETE FROM runtime_enrollments WHERE operator_id=$1',
        'DELETE FROM agent_presence WHERE operator_id=$1',
        'DELETE FROM unclaimed_buckets WHERE operator_id=$1',
        'DELETE FROM workspaces WHERE operator_id=$1',
      ])
        await tx.query(sql, [id]);
      await tx.query("DELETE FROM operators WHERE id=$1 AND kind='unclaimed'", [id]);
      evicted++;
    }
    if (evicted)
      await tx.query(
        "UPDATE unclaimed_stats SET buckets=GREATEST(buckets-$1,0) WHERE scope_key='global'",
        [evicted],
      );
    return evicted;
  }

  const reserveBucketSlot = async (tx: Tx) =>
    (
      await tx.query(
        `INSERT INTO unclaimed_stats(scope_key,agents,buckets) VALUES('global',0,1)
          ON CONFLICT (scope_key) DO UPDATE SET buckets=unclaimed_stats.buckets+1
          WHERE unclaimed_stats.buckets+1<=$1 RETURNING buckets`,
        [d.caps.unclaimedBucketsGlobal],
      )
    ).rows.length > 0;

  type ScopeIds = { source: string; site: string; network: string; region: string };
  async function ensureBucket(ids: ScopeIds) {
    const nameKey = `unclaimed:${ids.source}`;
    return d.db.transaction(async (tx) => {
      const time = d.clock();
      const touch = (id: string) =>
        tx.query(
          `INSERT INTO unclaimed_buckets(operator_id,site_key,network_key,region_key,created_at,last_used_at)
            VALUES($1,$2,$3,$4,$5,$5) ON CONFLICT (operator_id) DO UPDATE SET
            last_used_at=EXCLUDED.last_used_at,
            region_key=COALESCE(unclaimed_buckets.region_key,EXCLUDED.region_key)`,
          [id, ids.site, ids.network, ids.region, time],
        );
      const find = async () =>
        (
          await tx.query<{ id: string }>(
            "SELECT id FROM operators WHERE name_key=$1 AND kind='unclaimed'",
            [nameKey],
          )
        ).rows[0]?.id;
      const existing = await find();
      if (existing) {
        // Marks the partition used under its row lock, so eviction (which requires idleness by
        // last_used_at and re-checks under the same lock) cannot remove it before this create.
        const locked = await tx.query(
          'SELECT operator_id FROM workspaces WHERE operator_id=$1 FOR UPDATE',
          [existing],
        );
        if (locked.rows.length) {
          await touch(existing);
          return existing;
        }
      }
      // The partition bound is reserved before anything is written; at the bound only empty,
      // idle partitions are evicted to make room.
      if (!(await reserveBucketSlot(tx))) {
        await evictEmptyBuckets(tx, time, 50);
        if (!(await reserveBucketSlot(tx))) throw capacityError();
      }
      const id = randomUUID();
      const inserted = await tx.query(
        "INSERT INTO operators(id,name,name_key,password_hash,salt,kind) VALUES($1,'Unclaimed agents',$2,'!','!','unclaimed') ON CONFLICT (name_key) DO NOTHING RETURNING id",
        [id, nameKey],
      );
      if (!inserted.rows.length) {
        // A concurrent request created it first; release the reserved slot.
        await tx.query(
          "UPDATE unclaimed_stats SET buckets=GREATEST(buckets-1,0) WHERE scope_key='global'",
        );
        return (await find()) ?? d.fail(409, 'Unclaimed partition is unavailable.');
      }
      await tx.query('INSERT INTO workspaces(operator_id,data) VALUES($1,$2::jsonb)', [
        id,
        JSON.stringify(emptyWorkspace()),
      ]);
      await touch(id);
      return id;
    });
  }

  const scopedCaps = (ids: ScopeIds) =>
    [
      ['global', d.caps.unclaimedAgentsGlobal],
      [`site:${ids.site}`, d.caps.unclaimedAgentsPerSite],
      [`network:${ids.network}`, d.caps.unclaimedAgentsPerNetwork],
      [`region:${ids.region}`, d.caps.unclaimedAgentsPerRegion],
    ] as const;

  /**
   * Reserves capacity for `creates` agents in its own short transaction (one conditional upsert
   * per counter; any refusal rolls all of them back), so counter rows are never held for the
   * duration of a create, and records the reservation in a hold row (UNCLAIMED_HOLD_TTL_MS).
   * Returns the hold key; the caller always releases it.
   */
  async function reserveAgents(creates: number, ids: ScopeIds): Promise<string | null> {
    if (!creates) return null;
    const hold = `hold:${d.clock()}:${randomUUID()}:${ids.site}:${ids.network}:${ids.region}`;
    await d.db.transaction(async (tx) => {
      for (const [key, cap] of scopedCaps(ids)) {
        if (creates > cap) throw capacityError();
        const row = await tx.query(
          `INSERT INTO unclaimed_stats(scope_key,agents,buckets) VALUES($1,$2,0)
            ON CONFLICT (scope_key) DO UPDATE SET agents=unclaimed_stats.agents+EXCLUDED.agents
            WHERE unclaimed_stats.agents+EXCLUDED.agents<=$3 RETURNING agents`,
          [key, creates, cap],
        );
        if (!row.rows.length) throw capacityError();
      }
      await tx.query('INSERT INTO unclaimed_stats(scope_key,agents,buckets) VALUES($1,$2,0)', [
        hold,
        creates,
      ]);
    });
    return hold;
  }
  /**
   * Compensating release: returns what the hold still reserves (everything after a failed create,
   * the unused part after a successful one) and deletes the hold, atomically. A hold reconcile
   * already reclaimed is gone, so nothing is returned twice.
   */
  async function releaseHold(hold: string | null, ids: ScopeIds): Promise<void> {
    if (!hold) return;
    await d.db.transaction(async (tx) => {
      const count = Number(
        (
          await tx.query<{ agents: number | string }>(
            'DELETE FROM unclaimed_stats WHERE scope_key=$1 RETURNING agents',
            [hold],
          )
        ).rows[0]?.agents ?? 0,
      );
      if (count > 0)
        for (const [key] of scopedCaps(ids))
          await tx.query(
            'UPDATE unclaimed_stats SET agents=GREATEST(agents-$2,0) WHERE scope_key=$1',
            [key, count],
          );
    });
  }

  /** Global usage against the caps, with pressure 'high' at 80% and 'critical' at 95%. */
  async function readCapacity() {
    const row = (
      await d.db.query<{ agents: number | string; buckets: number | string }>(
        "SELECT agents,buckets FROM unclaimed_stats WHERE scope_key='global'",
      )
    ).rows[0];
    const agents = Number(row?.agents ?? 0);
    const partitions = Number(row?.buckets ?? 0);
    const ratio = Math.max(
      agents / d.caps.unclaimedAgentsGlobal,
      partitions / d.caps.unclaimedBucketsGlobal,
    );
    return {
      agents_used: agents,
      agents_cap: d.caps.unclaimedAgentsGlobal,
      partitions_used: partitions,
      partitions_cap: d.caps.unclaimedBucketsGlobal,
      pressure: (ratio >= 0.95 ? 'critical' : ratio >= 0.8 ? 'high' : 'ok') as
        'ok' | 'high' | 'critical',
    };
  }
  let lastPressureCheck = -Infinity;
  /** Emits one structured `capacity.pressure` line per instance per minute while high. */
  async function signalPressure(): Promise<void> {
    const now = d.clock();
    if (now - lastPressureCheck < 60_000) return;
    lastPressureCheck = now;
    const capacity = await readCapacity();
    if (capacity.pressure !== 'ok')
      log(JSON.stringify({ event: 'capacity.pressure', at: iso(now), ...capacity }));
  }

  async function anonymousTool(address: string, tool: string, args: unknown, origin: string) {
    const prefixes = clientAddressPrefixes(address);
    await d.limit(`anon:${prefixes.source}`, 60, 60_000);
    const ids: ScopeIds = {
      source: scopeId('source', prefixes.source),
      site: scopeId('site', prefixes.site),
      network: scopeId('network', prefixes.network),
      region: scopeId('region', prefixes.region),
    };
    const actor: Actor = {
      mode: 'unclaimed',
      operatorId: '',
      // N3: anonymous creators are never identified in responses, not even by a hash.
      createdBy: { kind: 'anonymous-client' },
      rootSponsor: 'unclaimed',
      label: 'an anonymous AI client',
      canConnect: true,
      origin,
    };
    if (tool === 'city_list_templates') {
      listTemplatesToolInput.parse(args);
      return service.listTemplates();
    }
    if (tool === 'city_plan_team') return service.planTool(d.db, null, actor, args);
    if (tool === 'city_create_agent') {
      if (!isRecord(args) || !MANIFEST_MODE_KEYS.some((key) => Object.hasOwn(args, key)))
        d.fail(
          400,
          'Anonymous creation needs a manifest or template with idempotency_key; the legacy fields require an owner grant.',
        );
      if (args.dry_run === true) return service.createDryRun(d.db, null, actor, args);
    } else if (tool !== 'city_apply_team') d.fail(401, 'Authentication is required.');
    if (!isRecord(args) || !highEntropyKey(args.idempotency_key))
      d.fail(
        400,
        'Anonymous idempotency_key must be unguessable: a fresh random UUID v4, or at least 16 random bytes as base64url (22+ characters). Words, dates, sequences, repeats, example UUIDs and hex under 32 digits are refused.',
      );
    const kind = tool === 'city_apply_team' ? 'apply' : 'create';
    // Fail fast (no storage writes) before spending the creation budget or creating a bucket.
    const planned = await service.preflight(d.db, actor, kind, args);
    const hour = 60 * 60_000;
    await d.limit(`anon-create:${prefixes.source}`, d.caps.unclaimedCreatesPerSourcePerHour, hour);
    await d.limit(`anon-create-site:${prefixes.site}`, d.caps.unclaimedCreatesPerSitePerHour, hour);
    await d.limit(
      `anon-create-network:${prefixes.network}`,
      d.caps.unclaimedCreatesPerNetworkPerHour,
      hour,
    );
    await d.limit(
      `anon-create-region:${prefixes.region}`,
      d.caps.unclaimedCreatesPerRegionPerHour,
      hour,
    );
    // Capacity pressure never authorizes automatic agent deletion.
    // Capacity is reserved before any partition exists, so a refusal leaves nothing behind.
    const reserved = planned.plan.summary.create;
    const hold = await reserveAgents(reserved, ids);
    const run = (bucketId: string) =>
      d.mutate<unknown>(bucketId, (workspace, tx, time) => {
        const bucketActor: Actor = {
          ...actor,
          operatorId: bucketId,
          beforeCreate: async (lockTx, creates) => {
            if (!hold || creates > reserved) throw capacityError();
            // Consumes the reservation in the create's own transaction: the hold keeps only the
            // unused remainder. A hold reclaimed as abandoned is gone and the create fails closed.
            const held = await lockTx.query(
              'UPDATE unclaimed_stats SET agents=$2 WHERE scope_key=$1 RETURNING scope_key',
              [hold, reserved - creates],
            );
            if (!held.rows.length) throw capacityError();
          },
          receipts: {
            get: async (toolName, key) =>
              (
                await tx.query<{ request_hash: string; resource_id: string }>(
                  'SELECT request_hash,resource_id FROM anonymous_receipts WHERE bucket_id=$1 AND tool=$2 AND request_key=$3',
                  [bucketId, toolName, key],
                )
              ).rows[0],
            put: async (toolName, key, requestHash, resourceId) => {
              await tx.query(
                'INSERT INTO anonymous_receipts(bucket_id,tool,request_key,request_hash,resource_id,created_at) VALUES($1,$2,$3,$4,$5,$6)',
                [bucketId, toolName, key, requestHash, resourceId, time],
              );
              // Bounded per bucket: the oldest receipts beyond 1000 are dropped.
              await tx.query(
                `DELETE FROM anonymous_receipts WHERE bucket_id=$1 AND (tool,request_key) NOT IN (
                  SELECT tool,request_key FROM anonymous_receipts WHERE bucket_id=$1
                  ORDER BY created_at DESC,request_key LIMIT 1000)`,
                [bucketId],
              );
            },
          },
        };
        return kind === 'apply'
          ? service.applyTeamTool(tx, workspace, time, bucketActor, args)
          : service.createAgentTool(tx, workspace, time, bucketActor, args);
      });
    let result: unknown;
    try {
      try {
        result = await run(await ensureBucket(ids));
      } catch (error) {
        // The partition vanished between ensureBucket and the lock (eviction race): retry once.
        if ((error as { statusCode?: number }).statusCode !== 401) throw error;
        result = await run(await ensureBucket(ids));
      }
    } catch (error) {
      await releaseHold(hold, ids);
      throw error;
    }
    await releaseHold(hold, ids);
    await signalPressure();
    return result;
  }

  // ---------------------------------------------------------------------------------------------
  // Anonymous REST creation (same semantics as the anonymous MCP tools).
  app.post('/api/public/agents', { bodyLimit: 48 * 1024 }, async (request, reply) => {
    const body = request.body;
    if (!isRecord(body)) d.fail(400, 'Send a JSON object.');
    const origin = d.originOf(request);
    const team =
      (isRecord(body.manifest) && body.manifest.kind === 'Team') ||
      templateKind(body.template) === 'Team';
    if (team && body.dry_run === true) {
      const { dry_run: _dry, idempotency_key: _key, expected_team_hash: _hash, ...rest } = body;
      return reply.code(200).send(await anonymousTool(request.ip, 'city_plan_team', rest, origin));
    }
    const result = await anonymousTool(
      request.ip,
      team ? 'city_apply_team' : 'city_create_agent',
      body,
      origin,
    );
    return reply.code(body.dry_run === true ? 200 : 201).send(result);
  });

  // ---------------------------------------------------------------------------------------------
  // Claim: a signed-in owner moves unclaimed agents (plus their lineage descendants, the
  // connections among them and their jobs) into the owner's workspace, preserving ids.
  app.post('/api/agents/claim', async (request) => {
    const operator = await d.owner(request);
    await d.limit(`claim:${operator.id}`, 20, 15 * 60_000);
    await d.limit(`claim-ip:${clientAddressKey(request.ip)}`, 30, 15 * 60_000);
    const { claim_token: token } = z
      .object({ claim_token: z.string().max(128) })
      .strict()
      .parse(request.body);
    const invalid = (): never => d.fail(404, 'Claim token is invalid or was already used.');
    if (!CLAIM_TOKEN.test(token)) invalid();
    const tokenHash = sha(token);
    const row = (
      await d.db.query<{ bucket_id: string }>(
        'SELECT bucket_id FROM claim_tokens WHERE token_hash=$1 AND claimed_at IS NULL',
        [tokenHash],
      )
    ).rows[0];
    if (!row) invalid();
    const bucketId = row!.bucket_id;
    return d.mutateMany([bucketId, operator.id], async (workspaces, tx, time) => {
      const locked = (
        await tx.query<{
          agent_ids: string[];
          claimed_at: string | number | null;
          bucket_id: string;
        }>(
          'SELECT agent_ids,claimed_at,bucket_id FROM claim_tokens WHERE token_hash=$1 FOR UPDATE',
          [tokenHash],
        )
      ).rows[0];
      if (!locked || locked.claimed_at !== null || locked.bucket_id !== bucketId) invalid();
      const bucket = workspaces.get(bucketId)!;
      const target = workspaces.get(operator.id)!;
      const seed = new Set(locked!.agent_ids);
      const moving = bucket.agents.filter((agent) => seed.has(agent.id));
      for (const agent of [...moving])
        for (const child of descendants(bucket, agent.id))
          if (!moving.includes(child)) moving.push(child);
      if (!moving.length) invalid();
      const ids = new Set(moving.map((agent) => agent.id));
      if (target.agents.length + moving.length > d.caps.agentsPerWorkspace)
        d.fail(409, `Claiming would exceed your limit of ${d.caps.agentsPerWorkspace} agents.`);
      const connections = bucket.connections.filter(
        (item) => ids.has(item.fromAgentId) && ids.has(item.toAgentId),
      );
      if (target.connections.length + connections.length > d.caps.connectionsPerWorkspace)
        d.fail(409, 'Claiming would exceed your connection limit.');
      const touching = bucket.jobs.filter(
        (job) => ids.has(job.requesterId) || ids.has(job.providerId),
      );
      const keys = new Set(target.jobs.map((job) => job.idempotencyKey));
      const jobs = touching.filter(
        (job) =>
          ids.has(job.requesterId) && ids.has(job.providerId) && !keys.has(job.idempotencyKey),
      );
      if (target.jobs.length + jobs.length > d.caps.jobsPerWorkspace)
        d.fail(409, 'Claiming would exceed your job history limit.');
      for (const job of touching)
        if (!jobs.includes(job))
          stopJob(bucket, job, time, 'Work stopped because an agent was claimed by an owner.');
      bucket.agents = bucket.agents.filter((agent) => !ids.has(agent.id));
      bucket.connections = bucket.connections.filter(
        (item) => !ids.has(item.fromAgentId) && !ids.has(item.toAgentId),
      );
      bucket.jobs = bucket.jobs.filter(
        (job) => !ids.has(job.requesterId) && !ids.has(job.providerId),
      );
      for (const agent of moving) {
        agent.rootSponsor = operator.id;
        agent.claimedAt = iso(time);
        target.agents.push(agent);
      }
      target.connections.push(...connections);
      target.jobs.push(...jobs);
      // A stored responder key never follows an agent to a new owner.
      await revokeResponderCredentials(
        tx,
        { ownerId: bucketId, agentIds: [...ids] },
        time,
        'agent claimed',
      );
      for (const agentId of ids) {
        for (const table of ['credentials', 'agent_presence', 'agent_manifests'])
          await tx.query(
            `UPDATE ${table} SET operator_id=$1 WHERE agent_id=$2 AND operator_id=$3`,
            [operator.id, agentId, bucketId],
          );
        // N2: the anonymous creator's pending enrollment codes die with the claim.
        await tx.query('DELETE FROM runtime_enrollments WHERE agent_id=$1', [agentId]);
      }
      // N2: runtime credentials the anonymous creator obtained stop working; the claimer gets
      // fresh ones through the owner rotation path.
      const credentialed = new Set(
        (
          await tx.query<{ agent_id: string }>(
            'SELECT agent_id FROM credentials WHERE operator_id=$1 AND agent_id = ANY($2::text[])',
            [operator.id, [...ids]],
          )
        ).rows.map((item) => item.agent_id),
      );
      const credentialsRotated = [];
      for (const agent of moving)
        if (credentialed.has(agent.id) && !agent.revokedAt)
          credentialsRotated.push({
            agent_id: agent.id,
            name: agent.name,
            token: await issueRuntimeCredential(target, tx, operator.id, agent, time, 'rotated'),
          });
      await tx.query(
        'DELETE FROM unclaimed_agent_expiry WHERE operator_id=$1 AND agent_id=ANY($2::text[])',
        [bucketId, [...ids]],
      );
      // Capacity counters: claimed agents no longer count as unclaimed.
      const scopes = (
        await tx.query<{ site_key: string; network_key: string; region_key: string | null }>(
          'SELECT site_key,network_key,region_key FROM unclaimed_buckets WHERE operator_id=$1',
          [bucketId],
        )
      ).rows[0];
      for (const key of [
        'global',
        ...(scopes ? [`site:${scopes.site_key}`, `network:${scopes.network_key}`] : []),
        ...(scopes?.region_key ? [`region:${scopes.region_key}`] : []),
      ])
        await tx.query(
          'UPDATE unclaimed_stats SET agents=GREATEST(agents-$2,0) WHERE scope_key=$1',
          [key, moving.length],
        );
      await tx.query('UPDATE claim_tokens SET claimed_at=$2,claimed_by=$3 WHERE token_hash=$1', [
        tokenHash,
        time,
        operator.id,
      ]);
      event(
        target,
        time,
        'agent.claimed',
        `Claimed ${moving.length} unclaimed agent${moving.length === 1 ? '' : 's'} (${moving
          .map((agent) => agent.name)
          .join(', ')
          .slice(
            0,
            400,
          )}) with ${connections.length} team connection${connections.length === 1 ? '' : 's'}.`,
        moving[0]!.id,
      );
      return {
        agents: moving.map((agent) => publicAgent(agent, target.jobs, time)),
        connections: connections.length,
        jobs: jobs.length,
        // N8: jobs that involved an agent outside the claimed set are stopped and not moved.
        jobs_dropped: touching.length - jobs.length,
        // One-time runtime credentials replacing any the anonymous creator held.
        credentials_rotated: credentialsRotated,
      };
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Runtime enrollment: exchange a single-use code for the agent's runtime credential.
  app.post('/api/runtime/enroll', async (request) => {
    await d.limit(`enroll:${clientAddressKey(request.ip)}`, 20, 15 * 60_000);
    const values = z
      .object({ agent_id: z.string().uuid(), enrollment_code: z.string().max(128) })
      .strict()
      .parse(request.body);
    const invalid = (): never =>
      d.fail(401, 'Enrollment code is invalid, expired, already used or for another agent.');
    if (!ENROLLMENT_CODE.test(values.enrollment_code)) invalid();
    const codeHash = sha(values.enrollment_code);
    const row = (
      await d.db.query<{ operator_id: string }>(
        'SELECT operator_id FROM runtime_enrollments WHERE code_hash=$1 AND agent_id=$2',
        [codeHash, values.agent_id],
      )
    ).rows[0];
    if (!row) invalid();
    return d.mutate(row!.operator_id, async (workspace, tx, time) => {
      // Consumed atomically under the workspace lock; a second use finds used_at set.
      const used = await tx.query(
        'UPDATE runtime_enrollments SET used_at=$2 WHERE code_hash=$1 AND agent_id=$3 AND operator_id=$4 AND used_at IS NULL AND expires_at>$2 RETURNING code_hash',
        [codeHash, time, values.agent_id, row!.operator_id],
      );
      if (!used.rows.length) invalid();
      const agent = workspace.agents.find((item) => item.id === values.agent_id);
      if (!agent || agent.revokedAt || agent.mode !== 'external') invalid();
      await tx.query('DELETE FROM runtime_enrollments WHERE agent_id=$1 AND used_at IS NULL', [
        values.agent_id,
      ]);
      const token = await issueRuntimeCredential(
        workspace,
        tx,
        row!.operator_id,
        agent!,
        time,
        'enrolled',
      );
      return {
        agent: publicAgent(agent!, workspace.jobs, time),
        token,
        heartbeatSeconds: 30,
        ttlSeconds: 90,
      };
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Honest metrics: owned and unclaimed agents are counted separately, never summed.
  // N7: cached per instance for 60 seconds; the query aggregates every workspace.
  // Concurrent misses share one in-flight computation instead of each scanning every workspace.
  let metricsCache: { at: number; value: unknown } | null = null;
  let metricsInflight: Promise<unknown> | null = null;
  app.get('/api/metrics/agents', async (request) => {
    await d.owner(request);
    const now = d.clock();
    if (metricsCache && now - metricsCache.at < 60_000) return metricsCache.value;
    metricsInflight ??= computeMetrics(now).finally(() => {
      metricsInflight = null;
    });
    return metricsInflight;
  });
  async function computeMetrics(now: number): Promise<unknown> {
    const rows = (
      await d.db.query<{
        kind: string;
        agents: string;
        active: string;
        claimed: string;
        partitions: string;
      }>(
        `SELECT o.kind,
          count(a.value)::text AS agents,
          count(a.value) FILTER (WHERE a.value->>'revokedAt' IS NULL)::text AS active,
          count(a.value) FILTER (WHERE a.value ? 'claimedAt')::text AS claimed,
          count(DISTINCT w.operator_id)::text AS partitions
        FROM workspaces w JOIN operators o ON o.id=w.operator_id
        LEFT JOIN LATERAL jsonb_array_elements(w.data->'agents') a ON true
        GROUP BY o.kind`,
      )
    ).rows;
    const of = (kind: string) => rows.find((row) => row.kind === kind);
    const owned = of('owner');
    const unclaimed = of('unclaimed');
    const ai = of('ai');
    const value = {
      generatedAt: iso(now),
      unclaimed_capacity: await readCapacity(),
      ...(d.aiCapacity ? { ai_workspace_capacity: await d.aiCapacity() } : {}),
      ai_owned: {
        workspaces: Number(ai?.partitions ?? 0),
        agents: Number(ai?.agents ?? 0),
      },
      owned: {
        agents: Number(owned?.agents ?? 0),
        active: Number(owned?.active ?? 0),
        claimedFromUnclaimed: Number(owned?.claimed ?? 0),
        workspaces: Number(owned?.partitions ?? 0),
      },
      unclaimed: {
        agents: Number(unclaimed?.agents ?? 0),
        sources: Number(unclaimed?.partitions ?? 0),
      },
      note: 'Owned, AI-owned and unclaimed agents are separate populations; do not add them together.',
    };
    metricsCache = { at: now, value };
    return value;
  }

  // ---------------------------------------------------------------------------------------------
  // Agent Cards (A2A 1.0) and the platform JWKS.
  function sendCard(
    reply: FastifyReply,
    card: unknown,
    signed: boolean,
    publicCard: boolean,
  ): FastifyReply {
    reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('x-central-city-card-signed', signed ? 'true' : 'false');
    if (publicCard)
      reply
        .header('access-control-allow-origin', '*')
        .header('cache-control', 'public, max-age=60');
    else reply.header('cache-control', 'private, no-store').header('vary', 'cookie');
    return reply.send(card);
  }
  app.get('/a2a/:agentId/.well-known/agent-card.json', async (request, reply) => {
    await d.limit(`ip:${clientAddressKey(request.ip)}`, d.caps.apiRequestsPerMinute, 60_000);
    const notFound = () => reply.code(404).send({ error: 'Agent Card not found.' });
    const parsed = z.object({ agentId: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success) return notFound();
    const agentId = parsed.data.agentId;
    const found = await cardAgent(d.db, agentId);
    if (!found) return notFound();
    // N5: only public-visibility cards are public. Private and org cards are owner-only; an
    // unclaimed agent has no owner yet, so its private card is not served until it is claimed.
    const publicCard = found.manifest.spec.visibility === 'public';
    if (!publicCard) {
      const viewer = found.kind === 'owner' ? await d.optionalOperator(request) : null;
      // Owner-only cards answer 404 (not 403) so their existence is not disclosed.
      if (viewer?.id !== found.operatorId) return notFound();
    }
    const origin = d.originOf(request);
    const card = await compileCardFor(d.db, agentId, found.manifest, origin);
    const key = d.signer.key;
    return sendCard(
      reply,
      key ? signAgentCard(card, key, { jku: `${origin}/.well-known/jwks.json` }) : card,
      Boolean(key),
      publicCard,
    );
  });
  app.get('/.well-known/jwks.json', async (request, reply) => {
    await d.limit(`ip:${clientAddressKey(request.ip)}`, d.caps.apiRequestsPerMinute, 60_000);
    return reply
      .header('access-control-allow-origin', '*')
      .header('cache-control', 'public, max-age=300')
      .header('content-type', 'application/jwk-set+json')
      .send(d.signer.jwks());
  });

  return { service, anonymousTool };
}
