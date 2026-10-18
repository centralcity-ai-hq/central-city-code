/*
 * Feed offers: the writer (migration 122, server/feed/offers/schema.ts; the contract is
 * shared/feed-offers.ts). An owner's agents offer built-in services (server/feed/offers/kinds.ts)
 * at a fixed, fee-included price; each offer is listed in the Feed as a feed_services row of the
 * source 'Central City', written in the same transaction as the offer.
 *
 * Writing is two steps, for one offer or a hundred:
 * - planOffers: a dry run. It checks every offer against the workspace as it is now and answers
 *   what publishing would do (create, update or nothing), every refusal with its reason, and a
 *   hash over the canonical plan. It writes nothing.
 * - publishOffers: the same plan again inside ONE transaction, under the workspace's row lock. It
 *   writes only when the plan is unchanged (expectedHash) and refuses otherwise, so what was
 *   reviewed is what is written. One idempotency key per publish: a replay answers the first
 *   answer and changes nothing. The Feed's Central City data version moves once per publish that
 *   changed anything, so the Feed's cached order, counts and cursors follow at once
 *   (server/feed/query.ts).
 * - changeOffers: changes offers that exist by id (text, price, discoverable, state, preset),
 *   planned and written in one transaction by the same rules (city_service_update and
 *   city_service_pause).
 * - listOffers: the workspace's own offers, a page at a time, with whether the Feed shows each.
 *   The MCP tools over all of them are server/feed/offers/tools.ts (scope services:sell).
 *
 * Every write checks: the agent is the workspace's own, neither revoked nor managed by Central City
 * (Elric); an offer that is listed needs its agent and workspace running and the agent's wallet
 * ready on Base (walletReady); the price stays within the fee router's fee-included bounds; the
 * text passes the Feed's risk rules exactly as the Bazaar's records do (a risky offer is stored,
 * never listed). The caps hold for every workspace alike (env settings, offerCaps): active offers
 * per agent, offers per workspace, offer writes per workspace per hour (a pause or removal that
 * changes nothing else is never refused by it), and one price change per offer per interval.
 * `pay_to` is the agent's wallet address when the offer is created, never changed after; the
 * agent and the kind of an offer never change either.
 *
 * An offer's preset (migration 231, preset-schema.ts) fixes some of its kind's input fields: it is
 * checked against the kind's fields (checkOfferPreset) and against the kind's own rules with the
 * rest of the kind's example input (kind.check), stored with the offer, hashed into the plan only
 * when set (so a plan without one hashes as before), and shown in its listing as fixed settings
 * instead of input fields (offerInputSummary). The purchase path merges it into every call's input
 * (mergeOfferPreset, server/feed/pay/engine.ts), before the input check and before payment.
 *
 * Pausing or resuming an agent or the workspace withdraws or lists again its active offers
 * (syncOfferListing, from the transaction that changed the pause state, server/app.ts); revoking an
 * agent removes its offers for good (removeAgentOffers, server/agent-lifecycle.ts); renaming it or
 * changing its visibility sets the public name on its listings again (syncOfferProviderName, from
 * updateStoredAgent). Public rows carry the agent's public name, wallet, price and text only: never
 * the owner or the workspace.
 */
import { createHash, randomBytes } from 'node:crypto';
import { getAddress } from 'viem';
import type { Database, Transaction } from '../../database.js';
import type { Workspace } from '../../model.js';
import { walletReady } from '../../base/pay/store.js';
import { PUBLIC_NAME } from '../../base/explorer/store.js';
import { elricAgentIds } from '../../elric/access.js';
import { WALLET_CHAIN_ID, WALLET_NETWORK } from '../../../shared/base/wallet-network.js';
import { FEED_LIMITS } from '../../../shared/feed.js';
import {
  FEE_ROUTER_MAX_TOTAL,
  FEE_ROUTER_MIN_INCLUDED,
  checkOfferPreset,
  isOfferKind,
  mergeOfferPreset,
  OFFER_ID,
  OFFER_IDEMPOTENCY_KEY,
  OFFER_KEY,
  OFFER_LIMITS,
  OFFER_PUBLIC_PATH,
  OFFER_STATES,
  offerInputSummary,
  offerOutputSummary,
  type OfferAction,
  type OfferChange,
  type OfferKindName,
  type OfferNotListed,
  type OwnOffer,
  type OwnOfferPage,
  type OfferPlan,
  type OfferPlanItem,
  type OfferPreset,
  type OfferPublishResult,
  type OfferRefusal,
  type OfferRefusalReason,
  type OfferState,
  OFFER_KIND_SPECS,
} from '../../../shared/feed-offers.js';
import { feedServiceId, listingPlain, listingRiskOf, listingTags } from '../bazaar.js';
import { HOSTED_SOURCE } from '../types.js';
import {
  checkOffer,
  OFFER_KIND_REGISTRY,
  offerKind,
  OfferKindInputError,
  type OfferKind,
} from './kinds.js';

type Queryable = Pick<Transaction, 'query'>;

// ---------------------------------------------------------------------------------------------
// Caps

export interface OfferCaps {
  /** Active offers per agent. */
  activePerAgent: number;
  /** Offers per workspace that are not removed (active or paused). */
  perWorkspace: number;
  /** Offers a workspace creates or changes per hour (a replay writes nothing and counts nothing). */
  writesPerWorkspacePerHour: number;
  /** One price change per offer per this many minutes (creating an offer sets its price). */
  priceChangeMinutes: number;
}

export const OFFER_CAPS_DEFAULT: Readonly<OfferCaps> = Object.freeze({
  activePerAgent: 5,
  perWorkspace: 2_000,
  writesPerWorkspacePerHour: 3_000,
  priceChangeMinutes: 60,
});

/** CITY_LIMIT_OFFERS_ACTIVE_PER_AGENT and so on: one setting per cap, the same for everyone. */
export const OFFER_CAP_ENV: Readonly<Record<keyof OfferCaps, string>> = Object.freeze(
  Object.fromEntries(
    Object.keys(OFFER_CAPS_DEFAULT).map((key) => [
      key,
      `CITY_LIMIT_OFFERS_${key.replace(/[A-Z]/g, (char) => `_${char}`).toUpperCase()}`,
    ]),
  ) as Record<keyof OfferCaps, string>,
);

/** The defaults, then the environment's settings (positive integers; anything else throws). */
export function offerCaps(env: Record<string, string | undefined> = process.env): OfferCaps {
  const caps = { ...OFFER_CAPS_DEFAULT };
  for (const key of Object.keys(caps) as Array<keyof OfferCaps>) {
    const raw = env[OFFER_CAP_ENV[key]];
    if (raw === undefined || raw === '') continue;
    const value = Number(raw);
    if (!/^\d{1,9}$/.test(raw) || !Number.isSafeInteger(value) || value < 1)
      throw new Error(`${OFFER_CAP_ENV[key]} must be a positive integer.`);
    caps[key] = value;
  }
  return caps;
}

const HOUR = 3_600_000;
/** A publish's answer is kept this long for replays; a later replay is planned again (and refused). */
export const OFFER_BATCH_KEEP_MS = 24 * HOUR;

// ---------------------------------------------------------------------------------------------
// Errors

export type OfferErrorCode =
  | 'invalid_batch'
  | 'invalid_idempotency_key'
  | 'workspace_not_found'
  | 'plan_refused'
  | 'plan_changed'
  | 'idempotency_key_reused';

export class OfferError extends Error {
  constructor(
    readonly code: OfferErrorCode,
    message: string,
    readonly refusals: OfferRefusal[] = [],
  ) {
    super(message);
    this.name = 'OfferError';
  }
}

// ---------------------------------------------------------------------------------------------
// Reading a batch

/** One offer of a batch, read and normalized (the fields the plan and its hash are built on). */
interface ReadOffer {
  index: number;
  key: string;
  agentId: string;
  kind: OfferKindName;
  title: string;
  description: string;
  tags: string[];
  priceRaw: string;
  discoverable: boolean;
  state: OfferState;
  preset: OfferPreset | null;
}

const OFFER_FIELDS = new Set([
  'key',
  'agentId',
  'kind',
  'title',
  'description',
  'tags',
  'priceRaw',
  'discoverable',
  'state',
  'preset',
]);

const codePoints = (text: string) => Array.from(text).length;

const REFUSAL_TEXT: Record<OfferRefusalReason, string> = {
  invalid_key: 'key must be 1 to 64 letters, digits or . _ : -.',
  duplicate_key: 'This key is used by an earlier offer in the same batch.',
  invalid_kind: 'kind must be one of the built-in kinds.',
  kind_unavailable: 'This kind cannot be offered yet.',
  invalid_title: `title must be 1 to ${FEED_LIMITS.titleMax} characters of plain text.`,
  invalid_description: `description must be at most ${FEED_LIMITS.descriptionMax} characters.`,
  invalid_tags: `tags must be at most ${FEED_LIMITS.tagsMax} words of at most ${FEED_LIMITS.tagMax} characters.`,
  invalid_price: `priceRaw must be a whole number of USDC base units from ${FEE_ROUTER_MIN_INCLUDED} to ${FEE_ROUTER_MAX_TOTAL} (to 100000000 while fee router 2 is on).`,
  invalid_state: 'state must be active, paused or removed (a new offer cannot start removed).',
  invalid_field:
    'An offer takes only key, agentId, kind, title, description, tags, priceRaw, discoverable, state and preset.',
  agent_not_found: 'No agent with this id in this workspace.',
  agent_not_allowed: 'This agent is managed by Central City and cannot sell services.',
  agent_paused: 'The agent is paused: resume it first, or publish the offer paused.',
  workspace_paused: 'The workspace is paused: resume it first, or publish the offer paused.',
  wallet_not_ready: "The agent's wallet on Base is not ready to be paid.",
  agent_changed: 'An offer keeps its agent: use a new key for another agent.',
  kind_changed: 'An offer keeps its kind: use a new key for another kind.',
  price_change_too_soon: 'The price of this offer was changed recently: try again later.',
  agent_offer_cap: 'The agent has the most active offers allowed.',
  workspace_offer_cap: 'The workspace has the most offers allowed.',
  write_rate: 'The workspace changed the most offers allowed this hour: try again later.',
  offer_not_found: 'No offer with this id in this workspace (or it was removed).',
  duplicate_offer: 'This offer is changed by an earlier entry in the same batch.',
  invalid_preset: "preset must fix only the kind's input fields, with valid values.",
};

/** A refusal with its fixed text, or (invalid_preset) the sentence saying what is wrong. */
const refusal = (
  index: number | null,
  key: string | null,
  reason: OfferRefusalReason,
  message?: string,
): OfferRefusal => ({ index, key, reason, message: message ?? REFUSAL_TEXT[reason] });

/**
 * Why a preset the kind's fields accept would still refuse calls, or null: it is merged into the
 * kind's example input for the fields it does not fix (only the required ones, so an example
 * field cannot clash with a preset one) and that input must pass the kind's whole check.
 */
function presetProblem(kind: OfferKind, preset: OfferPreset): string | null {
  const probe: Record<string, unknown> = {};
  const example = OFFER_KIND_SPECS[kind.name].example;
  for (const field of OFFER_KIND_SPECS[kind.name].input)
    if (
      field.required &&
      example[field.name] !== undefined &&
      !Object.prototype.hasOwnProperty.call(preset, field.name)
    )
      probe[field.name] = example[field.name];
  const merged = mergeOfferPreset(preset, probe);
  if (!merged.ok) return merged.reason;
  try {
    checkOffer(kind, merged.value);
    return null;
  } catch (error) {
    if (error instanceof OfferKindInputError)
      return `With this preset the service refuses its example input: ${error.message}`;
    throw error;
  }
}

/** Canonical JSON: object keys sorted at every depth, so equal values hash equally. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value ?? null);
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * The batch's offers, each read and normalized, or its refusal. Throws invalid_batch for a batch
 * that is not a list of 1 to batchMax offers within batchBytesMax.
 */
function readBatch(
  input: unknown,
  registry: ReadonlyMap<OfferKindName, OfferKind>,
  /** The highest price now: FEE_ROUTER_MAX_TOTAL, or router 2's cap while it is live. */
  priceMaxRaw: number = FEE_ROUTER_MAX_TOTAL,
): { offers: ReadOffer[]; refusals: OfferRefusal[] } {
  if (!Array.isArray(input) || input.length < 1 || input.length > OFFER_LIMITS.batchMax)
    throw new OfferError(
      'invalid_batch',
      `A batch is a list of 1 to ${OFFER_LIMITS.batchMax} offers.`,
    );
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(input), 'utf8');
  } catch {
    throw new OfferError('invalid_batch', 'The batch is not JSON.');
  }
  if (bytes > OFFER_LIMITS.batchBytesMax)
    throw new OfferError('invalid_batch', 'The batch is larger than 1 MiB.');
  const offers: ReadOffer[] = [];
  const refusals: OfferRefusal[] = [];
  const keys = new Set<string>();
  input.forEach((entry: unknown, index) => {
    const record = (
      entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null
    ) as Record<string, unknown> | null;
    const key = typeof record?.key === 'string' && OFFER_KEY.test(record.key) ? record.key : null;
    const refuse = (reason: OfferRefusalReason) => void refusals.push(refusal(index, key, reason));
    if (!record || Object.keys(record).some((field) => !OFFER_FIELDS.has(field)))
      return refuse('invalid_field');
    if (key === null) return refuse('invalid_key');
    if (keys.has(key)) return refuse('duplicate_key');
    keys.add(key);
    if (!isOfferKind(record.kind)) return refuse('invalid_kind');
    if (!offerKind(record.kind, registry)) return refuse('kind_unavailable');
    if (typeof record.agentId !== 'string' || !record.agentId || record.agentId.length > 128)
      return refuse('agent_not_found');
    const title = typeof record.title === 'string' ? listingPlain(record.title) : '';
    if (!title || codePoints(title) > FEED_LIMITS.titleMax) return refuse('invalid_title');
    if (record.description !== undefined && typeof record.description !== 'string')
      return refuse('invalid_description');
    const description = listingPlain(record.description ?? '');
    if (codePoints(description) > FEED_LIMITS.descriptionMax) return refuse('invalid_description');
    const rawTags = record.tags ?? [];
    if (
      !Array.isArray(rawTags) ||
      rawTags.length > FEED_LIMITS.tagsMax ||
      rawTags.some(
        (tag) =>
          typeof tag !== 'string' ||
          !listingPlain(tag) ||
          codePoints(listingPlain(tag)) > FEED_LIMITS.tagMax,
      )
    )
      return refuse('invalid_tags');
    const price = record.priceRaw;
    const priceText =
      typeof price === 'string' && /^[0-9]{1,9}$/.test(price)
        ? String(Number(price))
        : typeof price === 'number' && Number.isSafeInteger(price)
          ? String(price)
          : null;
    if (
      priceText === null ||
      Number(priceText) < FEE_ROUTER_MIN_INCLUDED ||
      Number(priceText) > priceMaxRaw
    )
      return refuse('invalid_price');
    if (record.discoverable !== undefined && typeof record.discoverable !== 'boolean')
      return refuse('invalid_field');
    const state = record.state ?? 'active';
    if (!(OFFER_STATES as readonly unknown[]).includes(state)) return refuse('invalid_state');
    const preset = checkOfferPreset(record.kind, record.preset);
    if (!preset.ok) return void refusals.push(refusal(index, key, 'invalid_preset', preset.reason));
    const problem = preset.value && presetProblem(offerKind(record.kind, registry)!, preset.value);
    if (problem) return void refusals.push(refusal(index, key, 'invalid_preset', problem));
    offers.push({
      index,
      key,
      agentId: record.agentId,
      kind: record.kind,
      title,
      description,
      tags: listingTags(rawTags as string[]),
      priceRaw: priceText,
      discoverable: record.discoverable ?? true,
      state: state as OfferState,
      preset: preset.value,
    });
  });
  return { offers, refusals };
}

// ---------------------------------------------------------------------------------------------
// The listing

/** An offer's listing URL: where buyers outside Central City will reach it (its identity). */
export const offerListingUrl = (origin: string, offerId: string) =>
  new URL(`${OFFER_PUBLIC_PATH}${offerId}`, origin).href;

/** The configured public origin as an https origin, or throws (never a Host header). */
function httpsOrigin(origin: string): URL {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username)
    throw new Error('Offers are listed under an https origin without a path.');
  return url;
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** 'off_' + 16 base32 characters of 80 random bits. */
export function newOfferId(): string {
  const bytes = randomBytes(10);
  let id = '';
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      id += BASE32[(value >>> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  return `off_${id}`;
}

/** The Central City data version moves by one (the Feed's caches and cursors follow). */
export async function moveHostedVersion(tx: Queryable): Promise<void> {
  await tx.query(
    `INSERT INTO feed_sources (name, data_version) VALUES ($1, 1)
     ON CONFLICT (name) DO UPDATE SET data_version = feed_sources.data_version + 1`,
    [HOSTED_SOURCE],
  );
}

// ---------------------------------------------------------------------------------------------
// Pause, resume and revoke (called from the transaction that changed them)

/**
 * Lists exactly the workspace's active offers whose agent is neither paused nor revoked, while the
 * workspace runs, and withdraws the rest of them; moves the data version when a row changed.
 * Called in the transaction that changed the workspace's or an agent's pause state (server/app.ts,
 * next to syncResultSuspension). Paused and removed offers stay withdrawn.
 */
export async function syncOfferListing(
  tx: Queryable,
  operatorId: string,
  workspace: Workspace,
  time: number,
): Promise<number> {
  const held = workspace.agents
    .filter((agent) => agent.pausedAt || agent.revokedAt)
    .map((agent) => agent.id);
  const { rows } = await tx.query<{ id: string }>(
    `UPDATE feed_services s SET withdrawn_at = CASE WHEN t.listable THEN NULL ELSE $4::bigint END
     FROM (
       SELECT 'cc:' || o.offer_id AS record_id,
              NOT ($2::boolean OR o.agent_id = ANY($3::text[])) AS listable
       FROM city_offers o WHERE o.operator_id = $1 AND o.state = 'active'
     ) t
     WHERE s.record_id = t.record_id AND s.source = $5 AND (s.withdrawn_at IS NULL) <> t.listable
     RETURNING s.id`,
    [operatorId, workspace.paused === true, held, time, HOSTED_SOURCE],
  );
  if (rows.length) await moveHostedVersion(tx);
  return rows.length;
}

/**
 * Removes every offer of these agents for good (state 'removed', the listing withdrawn) in the
 * transaction that revokes them (revokeStoredAgent, server/agent-lifecycle.ts). Their keys can be
 * used again. Answers how many offers it removed.
 */
export async function removeAgentOffers(
  tx: Queryable,
  operatorId: string,
  agentIds: readonly string[],
  time: number,
): Promise<number> {
  if (!agentIds.length) return 0;
  const { rows: removed } = await tx.query<{ offer_id: string }>(
    `UPDATE city_offers SET state = 'removed', updated_at = $3
     WHERE operator_id = $1 AND agent_id = ANY($2::text[]) AND state <> 'removed'
     RETURNING offer_id`,
    [operatorId, [...agentIds], time],
  );
  if (!removed.length) return 0;
  const { rows: withdrawn } = await tx.query<{ id: string }>(
    `UPDATE feed_services SET withdrawn_at = $2
     WHERE source = $3 AND record_id = ANY($1::text[]) AND withdrawn_at IS NULL
     RETURNING id`,
    [removed.map((row) => `cc:${row.offer_id}`), time, HOSTED_SOURCE],
  );
  if (withdrawn.length) await moveHostedVersion(tx);
  return removed.length;
}

/**
 * Sets the public name on every listing of this agent's offers to `publicName` (null while the
 * agent is private), with the search text built from it, in the transaction that renamed the agent
 * or changed its visibility (updateStoredAgent, server/agent-lifecycle.ts). The caller passes the
 * name the new revision makes public (PUBLIC_NAME's rule), since the workspace row is written only
 * at that transaction's end. Answers how many listings changed; moves the data version if any.
 */
export async function syncOfferProviderName(
  tx: Queryable,
  operatorId: string,
  agentId: string,
  publicName: string | null,
): Promise<number> {
  const providerName = publicName
    ? Array.from(publicName).slice(0, FEED_LIMITS.titleMax).join('')
    : null;
  const { rows } = await tx.query<{
    id: string;
    title: string;
    description: string;
    capabilities: string[] | null;
    host: string;
    provider_name: string | null;
  }>(
    `SELECT s.id, s.title, s.description, s.capabilities, s.host, s.provider_name
     FROM city_offers o JOIN feed_services s ON s.source = $3 AND s.record_id = 'cc:' || o.offer_id
     WHERE o.operator_id = $1 AND o.agent_id = $2`,
    [operatorId, agentId, HOSTED_SOURCE],
  );
  const stale = rows.filter((row) => row.provider_name !== providerName);
  for (const row of stale)
    await tx.query(
      'UPDATE feed_services SET provider_name = $2, search_text = $3 WHERE id = $1 AND source = $4',
      [
        row.id,
        providerName,
        // As upsertListings builds it.
        [
          row.title,
          row.description,
          (row.capabilities ?? []).join(' '),
          row.host,
          providerName ?? '',
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase(),
        HOSTED_SOURCE,
      ],
    );
  if (stale.length) await moveHostedVersion(tx);
  return stale.length;
}

// ---------------------------------------------------------------------------------------------
// The store

interface StoredOffer {
  offer_id: string;
  idem_key: string;
  agent_id: string;
  wallet_id: string;
  pay_to: string;
  kind: OfferKindName;
  title: string;
  description: string;
  tags: string[];
  price_raw: string;
  discoverable: boolean;
  version: number;
  state: OfferState;
  price_changed_at: number | string;
  preset: OfferPreset | null;
}

interface WalletRow {
  wallet_id: string;
  agent_id: string;
  address: string;
  state: string;
  owner_account_id: string | null;
  owner_address: string;
  derivation: unknown;
  vault_owner: string | null;
  backup_confirmed_at: string | number | null;
}

/** One planned offer with what publishing it needs beyond the public plan item. */
interface Planned {
  item: OfferPlanItem;
  walletId: string;
  risky: string | null;
  providerName: string | null;
  /** Listed if the workspace and agent run (the row's withdrawn_at). */
  running: boolean;
  /**
   * Only takes a stored offer off the Feed: its state becomes 'paused' or 'removed' and nothing
   * else changes. Recorded as a write, never refused by the hourly write cap.
   */
  withdrawal: boolean;
}

/** An offer a change answers without planning it (changeOffers: one already removed). */
interface SettledOffer {
  index: number;
  offer: OfferPublishResult['offers'][number];
}

/** Planned answers (in order) with the settled ones put back at their request index. */
function inRequestOrder<T>(planned: T[], settled: Array<{ index: number; offer: T }>): T[] {
  if (!settled.length) return planned;
  const at = new Map(settled.map((entry) => [entry.index, entry.offer]));
  const out: T[] = [];
  let next = 0;
  for (let index = 0; index < planned.length + settled.length; index++)
    out.push(at.has(index) ? at.get(index)! : planned[next++]!);
  return out;
}

interface PlanContext {
  plan: OfferPlan;
  planned: Planned[];
}

export interface OfferStoreOptions {
  /** The configured public origin (CITY_PUBLIC_ORIGIN) the listings are hosted under. */
  origin: string;
  caps?: OfferCaps;
  now?: () => number;
  /** The kinds that can be offered (OFFER_KIND_REGISTRY by default). */
  registry?: ReadonlyMap<OfferKindName, OfferKind>;
  /**
   * The highest offer price now, read per batch (FEE_ROUTER_MAX_TOTAL by default; router 2's cap
   * while it is live, docs/protocol/FEE_ROUTER_2.md section 5).
   */
  priceMaxRaw?: () => number;
}

export function createOfferStore(db: Database, options: OfferStoreOptions) {
  const origin = httpsOrigin(options.origin);
  const caps = options.caps ?? offerCaps();
  const clock = options.now ?? Date.now;
  const registry = options.registry ?? OFFER_KIND_REGISTRY;

  /** The plan over the workspace as `q` reads it (inside publish: under the workspace lock). */
  async function planIn(
    q: Queryable,
    operatorId: string,
    input: unknown,
    now: number,
    lock: boolean,
  ): Promise<PlanContext> {
    const { offers, refusals } = readBatch(
      input,
      registry,
      options.priceMaxRaw ? options.priceMaxRaw() : FEE_ROUTER_MAX_TOTAL,
    );
    const { rows: workspaces } = await q.query<{ paused: boolean | null }>(
      `SELECT (data->>'paused')::boolean AS paused FROM workspaces WHERE operator_id = $1${
        lock ? ' FOR UPDATE' : ''
      }`,
      [operatorId],
    );
    if (!workspaces.length) throw new OfferError('workspace_not_found', 'No such workspace.');
    const workspacePaused = workspaces[0].paused === true;

    const agentIds = [...new Set(offers.map((offer) => offer.agentId))];
    const keys = offers.map((offer) => offer.key);
    const { rows: agents } = await q.query<{
      id: string;
      paused_at: string | null;
      revoked_at: string | null;
    }>(
      `SELECT a->>'id' AS id, a->>'pausedAt' AS paused_at, a->>'revokedAt' AS revoked_at
       FROM workspaces ws CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(ws.data->'agents') = 'array' THEN ws.data->'agents'
         ELSE '[]'::jsonb END) a
       WHERE ws.operator_id = $1 AND a->>'id' = ANY($2::text[])`,
      [operatorId, agentIds],
    );
    const agentOf = new Map(agents.map((agent) => [agent.id, agent]));
    const managed = await elricAgentIds(q, agentIds);
    const { rows: wallets } = await q.query<WalletRow>(
      `SELECT w.wallet_id, w.agent_id, w.address, w.state, w.owner_account_id, w.owner_address,
         w.derivation, v.owner_address AS vault_owner, v.backup_confirmed_at
       FROM base_wallets w LEFT JOIN base_owner_vaults v ON v.operator_id = w.owner_account_id
       WHERE w.operator_id = $1 AND w.chain_id = $2 AND w.agent_id = ANY($3::text[])`,
      [operatorId, WALLET_CHAIN_ID, agentIds],
    );
    const walletOf = new Map<string, { walletId: string; address: string } | null>();
    for (const row of wallets) {
      const ready =
        (row.state === 'derived' || row.state === 'deployed') &&
        walletReady(WALLET_NETWORK, {
          agentId: row.agent_id,
          address: row.address,
          ownerAccountId: row.owner_account_id,
          ownerAddress: row.owner_address,
          derivation: row.derivation,
          vaultOwner: row.vault_owner,
          backupConfirmedAt: row.backup_confirmed_at,
        });
      walletOf.set(
        row.agent_id,
        ready ? { walletId: row.wallet_id, address: getAddress(row.address) } : null,
      );
    }
    const { rows: names } = await q.query<{ agent_id: string; name: string | null }>(
      `SELECT l.agent_id, p.name FROM (SELECT unnest($1::text[]) AS agent_id) l ${PUBLIC_NAME}`,
      [agentIds],
    );
    const nameOf = new Map(names.map((row) => [row.agent_id, row.name]));
    const { rows: stored } = await q.query<StoredOffer>(
      `SELECT offer_id, idem_key, agent_id, wallet_id, pay_to, kind, title, description, tags,
         price_raw::text AS price_raw, discoverable, version, state, price_changed_at, preset
       FROM city_offers WHERE operator_id = $1 AND state <> 'removed' AND idem_key = ANY($2::text[])`,
      [operatorId, keys],
    );
    const existingOf = new Map(stored.map((row) => [row.idem_key, row]));
    const { rows: counts } = await q.query<{ agent_id: string; active: number }>(
      `SELECT agent_id, count(*)::int AS active FROM city_offers
       WHERE operator_id = $1 AND state = 'active' AND agent_id = ANY($2::text[])
         AND NOT (idem_key = ANY($3::text[]))
       GROUP BY agent_id`,
      [operatorId, agentIds, keys],
    );
    const activeOutside = new Map(counts.map((row) => [row.agent_id, row.active]));
    const { rows: totals } = await q.query<{ kept: number; writes: number }>(
      `SELECT
         (SELECT count(*) FROM city_offers WHERE operator_id = $1 AND state <> 'removed'
            AND NOT (idem_key = ANY($2::text[])))::int AS kept,
         (SELECT COALESCE(sum(writes), 0) FROM city_offer_batches
            WHERE operator_id = $1 AND created_at > $3)::int AS writes`,
      [operatorId, keys, now - HOUR],
    );
    const keptOutside = Number(totals[0].kept);
    const writesThisHour = Number(totals[0].writes);

    const listingUrl = new URL(OFFER_PUBLIC_PATH, origin);
    const planned: Planned[] = [];
    const refuse = (offer: ReadOffer, reason: OfferRefusalReason) =>
      void refusals.push(refusal(offer.index, offer.key, reason));

    for (const offer of offers) {
      const existing = existingOf.get(offer.key) ?? null;
      const agent = agentOf.get(offer.agentId);
      const removing = offer.state === 'removed';
      if (!existing && removing) {
        refuse(offer, 'invalid_state');
        continue;
      }
      if (existing && existing.agent_id !== offer.agentId) {
        refuse(offer, 'agent_changed');
        continue;
      }
      if (existing && existing.kind !== offer.kind) {
        refuse(offer, 'kind_changed');
        continue;
      }
      if (!removing) {
        if (!agent || agent.revoked_at) {
          refuse(offer, 'agent_not_found');
          continue;
        }
        if (managed.has(offer.agentId)) {
          refuse(offer, 'agent_not_allowed');
          continue;
        }
      }
      const agentPaused = Boolean(agent?.paused_at);
      if (offer.state === 'active' && agentPaused) {
        refuse(offer, 'agent_paused');
        continue;
      }
      if (offer.state === 'active' && workspacePaused) {
        refuse(offer, 'workspace_paused');
        continue;
      }
      // A new offer takes the wallet's address; an offer listed again needs that same wallet ready.
      const wallet = walletOf.get(offer.agentId) ?? null;
      if (
        (!existing || offer.state === 'active') &&
        (!wallet || (existing !== null && wallet.address !== getAddress(existing.pay_to)))
      ) {
        refuse(offer, 'wallet_not_ready');
        continue;
      }
      const priceChanged = existing !== null && existing.price_raw !== offer.priceRaw;
      if (
        priceChanged &&
        Number(existing.price_changed_at) > now - caps.priceChangeMinutes * 60_000
      ) {
        refuse(offer, 'price_change_too_soon');
        continue;
      }
      const sameFields =
        existing !== null &&
        existing.title === offer.title &&
        existing.description === offer.description &&
        canonicalJson(existing.tags) === canonicalJson(offer.tags) &&
        !priceChanged &&
        existing.discoverable === offer.discoverable &&
        canonicalJson(existing.preset ?? null) === canonicalJson(offer.preset);
      const action: OfferAction = !existing
        ? 'create'
        : sameFields && existing.state === offer.state
          ? 'unchanged'
          : 'update';
      const withdrawal =
        sameFields &&
        existing.state !== offer.state &&
        (offer.state === 'paused' || offer.state === 'removed');
      const risky = listingRiskOf({
        title: offer.title,
        description: offer.description,
        tags: offer.tags,
        url: listingUrl,
      });
      const running = offer.state === 'active' && !agentPaused && !workspacePaused;
      const name = nameOf.get(offer.agentId) ?? null;
      planned.push({
        item: {
          key: offer.key,
          offerId: existing?.offer_id ?? null,
          action,
          agentId: offer.agentId,
          payTo: existing ? getAddress(existing.pay_to) : wallet!.address,
          kind: offer.kind,
          title: offer.title,
          description: offer.description,
          tags: offer.tags,
          priceRaw: offer.priceRaw,
          discoverable: offer.discoverable,
          state: offer.state,
          preset: offer.preset,
          version: !existing
            ? 1
            : action === 'update'
              ? Number(existing.version) + 1
              : Number(existing.version),
          listed: running && risky === null,
        },
        walletId: existing?.wallet_id ?? wallet!.walletId,
        risky,
        providerName: name ? Array.from(name).slice(0, FEED_LIMITS.titleMax).join('') : null,
        running,
        withdrawal,
      });
    }

    // Caps over what publishing would leave, in batch order: what is already so fits first.
    const wasActive = (entry: Planned) => existingOf.get(entry.item.key)?.state === 'active';
    const capped = new Set<Planned>();
    for (const agentId of agentIds) {
      const mine = planned.filter((entry) => entry.item.agentId === agentId);
      let slots =
        caps.activePerAgent -
        (activeOutside.get(agentId) ?? 0) -
        mine.filter((entry) => entry.item.state === 'active' && wasActive(entry)).length;
      for (const entry of mine) {
        if (entry.item.state !== 'active' || wasActive(entry)) continue;
        if (slots > 0) slots--;
        else capped.add(entry);
      }
    }
    for (const entry of capped) {
      const offer = offers.find((item) => item.key === entry.item.key)!;
      refuse(offer, 'agent_offer_cap');
    }
    let slots =
      caps.perWorkspace -
      keptOutside -
      planned.filter((entry) => entry.item.offerId !== null && entry.item.state !== 'removed')
        .length;
    for (const entry of planned) {
      if (entry.item.offerId !== null || capped.has(entry)) continue;
      if (slots > 0) slots--;
      else {
        capped.add(entry);
        refuse(
          offers.find((item) => item.key === entry.item.key)!,
          'workspace_offer_cap',
        );
      }
    }
    const kept = planned.filter((entry) => !capped.has(entry));
    // A pause or removal that changes nothing else is never refused by the cap: taking an offer
    // off the Feed must work at once (a bad price, a stop rule). It is still recorded as a write.
    const writes = kept.filter(
      (entry) => entry.item.action !== 'unchanged' && !entry.withdrawal,
    ).length;
    if (writes && writesThisHour + writes > caps.writesPerWorkspacePerHour)
      refusals.push(refusal(null, null, 'write_rate'));

    refusals.sort((a, b) => (a.index ?? -1) - (b.index ?? -1));
    const ok = refusals.length === 0;
    const items = kept.map((entry) => entry.item);
    const hash = ok
      ? sha256(
          canonicalJson({
            plan: 'feed-offers/1',
            items: items.map((item) => [
              item.key,
              item.offerId,
              item.action,
              item.agentId,
              item.payTo,
              item.kind,
              item.title,
              item.description,
              item.tags,
              item.priceRaw,
              item.discoverable,
              item.state,
              item.version,
              item.listed,
              // Only when set: a plan without presets hashes as it did before they existed.
              ...(item.preset ? [item.preset] : []),
            ]),
          }),
        )
      : null;
    return { plan: { ok, hash, items, refusals, writes }, planned: kept };
  }

  /** The dry run: what publishing this batch would do now, and the hash to publish it with. */
  async function planOffers(operatorId: string, offers: unknown): Promise<OfferPlan> {
    return (await planIn(db, operatorId, offers, clock(), false)).plan;
  }

  /**
   * Publishes a planned batch in one transaction (see the header). Throws OfferError:
   * plan_refused (with the refusals), plan_changed (the plan's hash is not expectedHash: plan
   * again), idempotency_key_reused (the key was used for another request), invalid_batch,
   * invalid_idempotency_key, workspace_not_found. Nothing is written when it throws.
   */
  async function publishOffers(
    operatorId: string,
    offers: unknown,
    idempotencyKey: string,
    expectedHash: string,
  ): Promise<OfferPublishResult> {
    if (typeof idempotencyKey !== 'string' || !OFFER_IDEMPOTENCY_KEY.test(idempotencyKey))
      throw new OfferError(
        'invalid_idempotency_key',
        'The idempotency key must be 8 to 128 letters, digits or . _ : -.',
      );
    if (typeof expectedHash !== 'string' || !/^[0-9a-f]{64}$/.test(expectedHash))
      throw new OfferError('plan_changed', 'Plan the batch first and publish it with its hash.');
    let requestHash: string;
    try {
      requestHash = sha256(canonicalJson({ offers, expectedHash }));
    } catch {
      throw new OfferError('invalid_batch', 'The batch is not JSON.');
    }
    return writeBatch(
      operatorId,
      idempotencyKey,
      requestHash,
      async () => ({ offers }),
      expectedHash,
    );
  }

  /**
   * Changes offers that exist (city_service_update and city_service_pause), up to batchMax per
   * call: each change names an offer by id and the fields to replace; the rest stay as they are.
   * The change is planned and written in ONE transaction under the workspace lock, by the same
   * rules as a publish (the caps, the price interval, the risk rules, a ready wallet to list
   * again), so there is no plan hash to pass: what is written is the current offer with these
   * fields. One idempotency key per call, as publishOffers. Throws OfferError as publishOffers;
   * an unknown offer id is refused as plan_refused with offer_not_found. A removed offer (removed
   * by its owner, or when its agent was revoked) is already out of the Feed for good: pausing or
   * removing it again is a no-op success (unchanged, not listed); any other change to it is
   * refused with offer_not_found.
   */
  async function changeOffers(
    operatorId: string,
    changes: readonly OfferChange[],
    idempotencyKey: string,
  ): Promise<OfferPublishResult> {
    if (typeof idempotencyKey !== 'string' || !OFFER_IDEMPOTENCY_KEY.test(idempotencyKey))
      throw new OfferError(
        'invalid_idempotency_key',
        'The idempotency key must be 8 to 128 letters, digits or . _ : -.',
      );
    if (!Array.isArray(changes) || changes.length < 1 || changes.length > OFFER_LIMITS.batchMax)
      throw new OfferError(
        'invalid_batch',
        `A batch is a list of 1 to ${OFFER_LIMITS.batchMax} offers.`,
      );
    let requestHash: string;
    try {
      requestHash = sha256(canonicalJson({ change: changes }));
    } catch {
      throw new OfferError('invalid_batch', 'The batch is not JSON.');
    }
    return writeBatch(
      operatorId,
      idempotencyKey,
      requestHash,
      async (tx) => {
        const ids = changes.map((change) => change.offerId);
        const { rows } = await tx.query<StoredOffer>(
          `SELECT offer_id, idem_key, agent_id, wallet_id, pay_to, kind, title, description, tags,
             price_raw::text AS price_raw, discoverable, version, state, price_changed_at, preset
           FROM city_offers WHERE operator_id = $1 AND offer_id = ANY($2::text[])`,
          [operatorId, ids.filter((id) => typeof id === 'string' && OFFER_ID.test(id))],
        );
        const byId = new Map(rows.map((row) => [row.offer_id, row]));
        const refusals: OfferRefusal[] = [];
        const seen = new Set<string>();
        const offers: unknown[] = [];
        const positions: number[] = [];
        const settled: SettledOffer[] = [];
        changes.forEach((change, index) => {
          const row = byId.get(change.offerId);
          const withdrawOnly =
            (change.state === 'paused' || change.state === 'removed') &&
            Object.keys(change).every((field) => field === 'offerId' || field === 'state');
          if (!row || (row.state === 'removed' && !withdrawOnly)) {
            refusals.push(refusal(index, null, 'offer_not_found'));
            return;
          }
          if (seen.has(row.offer_id))
            refusals.push(refusal(index, row.idem_key, 'duplicate_offer'));
          seen.add(row.offer_id);
          if (row.state === 'removed') {
            // Already withdrawn for good: nothing to write. Its key may name a newer offer, so
            // it never enters the plan.
            settled.push({
              index,
              offer: {
                key: row.idem_key,
                offerId: row.offer_id,
                action: 'unchanged',
                version: Number(row.version),
                listed: false,
              },
            });
            return;
          }
          positions.push(index);
          // The stored offer with the given fields: the batch a publish of this key would carry.
          offers.push({
            key: row.idem_key,
            agentId: row.agent_id,
            kind: row.kind,
            title: change.title ?? row.title,
            description: change.description ?? row.description,
            tags: change.tags ?? row.tags,
            priceRaw: change.priceRaw ?? row.price_raw,
            discoverable: change.discoverable ?? row.discoverable,
            state: change.state ?? row.state,
            preset: change.preset === undefined ? row.preset : change.preset,
          });
        });
        if (refusals.length)
          throw new OfferError('plan_refused', 'Some offers cannot be changed.', refusals);
        return { offers, positions, settled };
      },
      null,
    );
  }

  /**
   * One batch written in one transaction (publishOffers and changeOffers): the workspace's row
   * lock, the idempotency key's earlier answer (a replay changes nothing), then the plan of the
   * batch `build` answers under that lock, refused unless it is ok and (when expectedHash is
   * given) its hash is expectedHash; then the offers, their Feed rows and one version move.
   * `build` may answer offers that need no plan (`settled`, at their request index) and the
   * request index of each planned offer (`positions`, default its own); refusal indexes and the
   * answer's order are the request's.
   */
  async function writeBatch(
    operatorId: string,
    idempotencyKey: string,
    requestHash: string,
    build: (
      tx: Queryable,
    ) => Promise<{ offers: unknown; positions?: number[]; settled?: SettledOffer[] }>,
    expectedHash: string | null,
  ): Promise<OfferPublishResult> {
    return db.transaction(async (tx) => {
      const now = clock();
      // The workspace's row lock first: every pause, resume and revoke takes it too.
      const { rows: locked } = await tx.query(
        'SELECT 1 FROM workspaces WHERE operator_id = $1 FOR UPDATE',
        [operatorId],
      );
      if (!locked.length) throw new OfferError('workspace_not_found', 'No such workspace.');
      const { rows: before } = await tx.query<{
        request_hash: string;
        result: OfferPublishResult;
      }>(
        `SELECT request_hash, result FROM city_offer_batches
         WHERE operator_id = $1 AND idem_key = $2`,
        [operatorId, idempotencyKey],
      );
      if (before[0]) {
        if (before[0].request_hash !== requestHash)
          throw new OfferError(
            'idempotency_key_reused',
            'This idempotency key was used for another batch.',
          );
        return { ...before[0].result, replay: true };
      }
      const { offers, positions, settled = [] } = await build(tx);
      // Only settled offers (each already withdrawn): an empty plan, nothing to write.
      const { plan, planned } =
        !Array.isArray(offers) || offers.length || !settled.length
          ? await planIn(tx, operatorId, offers, now, true)
          : {
              plan: { ok: true, hash: sha256(canonicalJson({ settled })) } as OfferPlan,
              planned: [] as Planned[],
            };
      if (!plan.ok)
        throw new OfferError(
          'plan_refused',
          'Some offers cannot be published.',
          positions
            ? plan.refusals.map((entry) =>
                entry.index === null ? entry : { ...entry, index: positions[entry.index]! },
              )
            : plan.refusals,
        );
      if (expectedHash !== null && plan.hash !== expectedHash)
        throw new OfferError(
          'plan_changed',
          'The offers or the workspace changed since this plan: plan again.',
        );

      const written = planned.filter((entry) => entry.item.action !== 'unchanged');
      const ids = new Map(
        planned.map((entry) => [entry.item.key, entry.item.offerId ?? newOfferId()]),
      );
      if (written.length) {
        const { rows: saved } = await tx.query<{ offer_id: string }>(
          `INSERT INTO city_offers AS o (offer_id, operator_id, agent_id, wallet_id, pay_to, kind,
             title, description, tags, price_raw, discoverable, version, state, idem_key, risky,
             price_changed_at, created_at, updated_at, preset)
           SELECT r.offer_id, $2, r.agent_id, r.wallet_id, r.pay_to, r.kind, r.title,
             r.description, COALESCE(r.tags, '{}'), r.price_raw, r.discoverable, r.version,
             r.state, r.idem_key, r.risky, $3, $3, $3, r.preset
           FROM jsonb_to_recordset($1::jsonb) AS r(offer_id text, agent_id text, wallet_id text,
             pay_to text, kind text, title text, description text, tags text[], price_raw numeric,
             discoverable boolean, version integer, state text, idem_key text, risky text,
             preset jsonb)
           ON CONFLICT (offer_id) DO UPDATE SET title = EXCLUDED.title,
             description = EXCLUDED.description, tags = EXCLUDED.tags,
             price_raw = EXCLUDED.price_raw, discoverable = EXCLUDED.discoverable,
             version = EXCLUDED.version, state = EXCLUDED.state, risky = EXCLUDED.risky,
             preset = EXCLUDED.preset,
             price_changed_at = CASE WHEN o.price_raw <> EXCLUDED.price_raw THEN $3
               ELSE o.price_changed_at END,
             updated_at = $3
           WHERE o.operator_id = $2 AND o.agent_id = EXCLUDED.agent_id
             AND o.version = EXCLUDED.version - 1 AND o.state <> 'removed'
           RETURNING o.offer_id`,
          [
            JSON.stringify(
              written.map(({ item, walletId, risky }) => ({
                offer_id: ids.get(item.key),
                agent_id: item.agentId,
                wallet_id: walletId,
                pay_to: item.payTo,
                kind: item.kind,
                title: item.title,
                description: item.description,
                tags: item.tags,
                price_raw: item.priceRaw,
                discoverable: item.discoverable,
                version: item.version,
                state: item.state,
                idem_key: item.key,
                risky,
                preset: item.preset,
              })),
            ),
            operatorId,
            now,
          ],
        );
        // Under the workspace lock nothing else writes these offers; a miss is a bug, never a
        // half-written batch.
        if (saved.length !== written.length)
          throw new Error('An offer changed while its batch was written.');
        await upsertListings(tx, written, ids, now);
        await moveHostedVersion(tx);
      }
      const result: OfferPublishResult = {
        replay: false,
        hash: plan.hash!,
        offers: inRequestOrder(
          planned.map(({ item }) => ({
            key: item.key,
            offerId: ids.get(item.key)!,
            action: item.action,
            version: item.version,
            listed: item.listed,
          })),
          settled,
        ),
        writes: written.length,
      };
      await tx.query(
        `INSERT INTO city_offer_batches (operator_id, idem_key, request_hash, result, writes,
           created_at) VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
        [operatorId, idempotencyKey, requestHash, JSON.stringify(result), written.length, now],
      );
      await tx.query('DELETE FROM city_offer_batches WHERE operator_id = $1 AND created_at < $2', [
        operatorId,
        now - OFFER_BATCH_KEEP_MS,
      ]);
      return result;
    });
  }

  /**
   * The Feed's rows of written offers (source 'Central City', record_id 'cc:' + offer id), in the
   * offers' transaction. A row is withdrawn while its offer is not active or its agent or
   * workspace is paused (it keeps its first withdrawal time), and its `risky` is the offer's.
   * `hidden` is never written: it is the operator's. A row of the same URL from another source
   * becomes this offer's (the URL is Central City's own; the sweep never takes it back).
   * A new row starts with no paid call (0, "New"); a row of this source keeps its use counts,
   * which only refreshHostedUses writes (server/feed/offers/uses.ts).
   */
  async function upsertListings(
    tx: Queryable,
    written: Planned[],
    ids: Map<string, string>,
    now: number,
  ): Promise<void> {
    const rows = written.map(({ item, risky, providerName, running }) => {
      const offerId = ids.get(item.key)!;
      const url = offerListingUrl(origin.href, offerId);
      return {
        id: feedServiceId(url),
        record_id: `cc:${offerId}`,
        host: origin.hostname,
        url,
        title: item.title,
        description: item.description,
        capabilities: item.tags,
        provider_name: providerName,
        price_raw: item.priceRaw,
        pay_to: item.payTo,
        input: offerInputSummary(item.kind, item.preset),
        output: offerOutputSummary(item.kind),
        withdrawn: !running,
        risky,
        search_text: [
          item.title,
          item.description,
          item.tags.join(' '),
          origin.hostname,
          providerName ?? '',
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase(),
        seller_key: item.payTo.toLowerCase(),
      };
    });
    await tx.query(
      `INSERT INTO feed_services AS s (id, source, record_id, host, url, title, description,
         capabilities, provider_name, method, x402_version, scheme, price_raw, pay_to, input,
         output, paid_calls_30d, payers_30d, last_called_at, source_updated_at, fetched_at,
         first_seen_at, last_seen_at, last_seen_sweep, missed_sweeps, withdrawn_at, risky,
         search_text, seller_key)
       SELECT r.id, $2, r.record_id, r.host, r.url, r.title, r.description,
         COALESCE(r.capabilities, '{}'), r.provider_name, 'POST', 2, 'exact', r.price_raw,
         r.pay_to, r.input, r.output, 0, 0, NULL, $3, $3, $3, $3, 0, 0,
         CASE WHEN r.withdrawn THEN $3::bigint END, r.risky, r.search_text, r.seller_key
       FROM jsonb_to_recordset($1::jsonb) AS r(id text, record_id text, host text, url text,
         title text, description text, capabilities text[], provider_name text,
         price_raw numeric, pay_to text, input jsonb, output jsonb, withdrawn boolean,
         risky text, search_text text, seller_key text)
       ON CONFLICT (id) DO UPDATE SET
         paid_calls_30d = CASE WHEN s.source = EXCLUDED.source THEN s.paid_calls_30d
           ELSE EXCLUDED.paid_calls_30d END,
         payers_30d = CASE WHEN s.source = EXCLUDED.source THEN s.payers_30d
           ELSE EXCLUDED.payers_30d END,
         last_called_at = CASE WHEN s.source = EXCLUDED.source THEN s.last_called_at END,
         source = EXCLUDED.source, record_id = EXCLUDED.record_id, host = EXCLUDED.host,
         url = EXCLUDED.url, title = EXCLUDED.title, description = EXCLUDED.description,
         capabilities = EXCLUDED.capabilities, provider_name = EXCLUDED.provider_name,
         method = EXCLUDED.method, x402_version = EXCLUDED.x402_version,
         scheme = EXCLUDED.scheme, price_raw = EXCLUDED.price_raw, pay_to = EXCLUDED.pay_to,
         input = EXCLUDED.input, output = EXCLUDED.output,
         source_updated_at = EXCLUDED.source_updated_at, fetched_at = EXCLUDED.fetched_at,
         last_seen_at = EXCLUDED.last_seen_at, missed_sweeps = 0,
         withdrawn_at = CASE WHEN EXCLUDED.withdrawn_at IS NULL THEN NULL
           ELSE COALESCE(s.withdrawn_at, EXCLUDED.withdrawn_at) END,
         risky = EXCLUDED.risky, search_text = EXCLUDED.search_text,
         seller_key = EXCLUDED.seller_key`,
      [JSON.stringify(rows), HOSTED_SOURCE, now],
    );
  }

  /**
   * The workspace's own offers (city_service_mine), oldest id first, a page at a time: every field
   * its owner wrote, its Feed service id, and whether the Feed shows it now (and why not). Removed
   * offers only when asked for by state. Reads only; no lock.
   */
  async function listOffers(
    operatorId: string,
    filter: {
      agentId?: string;
      state?: OfferState;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<OwnOfferPage> {
    const limit = Math.min(Math.max(1, Math.floor(filter.limit ?? 50)), OWN_OFFERS_PAGE_MAX);
    if (filter.cursor !== undefined && !OFFER_ID.test(filter.cursor))
      throw new OfferError('invalid_batch', 'The cursor is not one this list wrote.');
    const { rows } = await db.query<
      StoredOffer & {
        risky: string | null;
        created_at: string | number;
        updated_at: string | number;
      }
    >(
      `SELECT offer_id, idem_key, agent_id, wallet_id, pay_to, kind, title, description, tags,
         price_raw::text AS price_raw, discoverable, version, state, price_changed_at, risky,
         created_at, updated_at, preset
       FROM city_offers
       WHERE operator_id = $1
         AND ($2::text IS NULL OR agent_id = $2)
         AND (CASE WHEN $3::text IS NULL THEN state <> 'removed' ELSE state = $3 END)
         AND ($4::text IS NULL OR offer_id > $4)
       ORDER BY offer_id LIMIT $5`,
      [operatorId, filter.agentId ?? null, filter.state ?? null, filter.cursor ?? null, limit + 1],
    );
    const page = rows.slice(0, limit);
    const { rows: listings } = page.length
      ? await db.query<{
          id: string;
          withdrawn: boolean;
          hidden: boolean;
          risky: string | null;
        }>(
          `SELECT id, withdrawn_at IS NOT NULL AS withdrawn, hidden, risky FROM feed_services
           WHERE id = ANY($1::text[]) AND source = $2`,
          [page.map((row) => serviceIdOf(row.offer_id)), HOSTED_SOURCE],
        )
      : { rows: [] };
    const listingOf = new Map(listings.map((row) => [row.id, row]));
    return {
      offers: page.map((row): OwnOffer => {
        const serviceId = serviceIdOf(row.offer_id);
        const listing = listingOf.get(serviceId);
        const notListed: OfferNotListed | null =
          row.state === 'removed'
            ? 'removed'
            : row.state === 'paused'
              ? 'paused'
              : !listing || listing.withdrawn
                ? 'held'
                : listing.hidden
                  ? 'hidden'
                  : listing.risky !== null || row.risky !== null
                    ? 'risk_rule'
                    : null;
        return {
          offerId: row.offer_id,
          key: row.idem_key,
          agentId: row.agent_id,
          payTo: getAddress(row.pay_to),
          kind: row.kind,
          title: row.title,
          description: row.description,
          tags: row.tags,
          priceRaw: row.price_raw,
          discoverable: row.discoverable,
          state: row.state,
          preset: row.preset ?? null,
          version: Number(row.version),
          serviceId,
          listed: notListed === null,
          notListed,
          createdAt: Number(row.created_at),
          updatedAt: Number(row.updated_at),
        };
      }),
      next: rows.length > limit ? page[page.length - 1]!.offer_id : null,
    };
  }

  /** An offer's Feed service id (svc_...): the id of its listing URL. */
  function serviceIdOf(offerId: string): string {
    return feedServiceId(offerListingUrl(origin.href, offerId));
  }

  return { planOffers, publishOffers, changeOffers, listOffers, serviceIdOf };
}

/** The most offers one page of listOffers answers. */
export const OWN_OFFERS_PAGE_MAX = 100;

export type OfferStore = ReturnType<typeof createOfferStore>;
