/*
 * Selling services in the Feed as MCP tools (scope `services:sell`): an owner's AI lists built-in
 * services that the workspace's agents sell, at a fixed price per call in USDC on Base, fee
 * included (the buyer pays the listed price; the seller's wallet receives 90% and 10% goes to the
 * protocol). The writer is server/feed/offers/store.ts; the contract is shared/feed-offers.ts.
 *
 * - city_service_plan: a dry run of up to 100 offers. It answers what publishing would do and a
 *   hash; it writes nothing.
 * - city_service_publish: the same offers with that hash (expected_hash) and an idempotency key.
 *   Refused when anything changed since the plan; a retry with the same key changes nothing.
 * - city_service_update: changes offers that exist (text, price, discoverable, state, preset).
 * - city_service_pause: pauses (or resumes) offers.
 * - city_service_mine: the workspace's own offers and whether the Feed shows each one.
 *
 * Remote /mcp and the REST tool route (/api/assistant/tools/:tool) only, never on /mcp/open,
 * while the Feed is on (unless CITY_FEED is '0'). `services:sell` is never a default: it is not in
 * an AI workspace's first key and starts unticked on the approval page. The same rules, caps and
 * limits hold for every owner and every workspace; nothing here knows who runs an account.
 */
import { z } from 'zod';
import { rawToUsdc, usdcToRaw, FEED_LIMITS } from '../../../shared/feed.js';
import { FEED_PAY_LIMITS } from '../../../shared/feed-pay.js';
import {
  FEE_ROUTER_MAX_TOTAL,
  FEE_ROUTER_MIN_INCLUDED,
  OFFER_ID,
  OFFER_IDEMPOTENCY_KEY,
  OFFER_KEY,
  OFFER_KINDS,
  OFFER_KIND_SPECS,
  OFFER_LIMITS,
  OFFER_NOT_LISTED,
  OFFER_PRESET_MAX_BYTES,
  OFFER_REFUSALS,
  OFFER_STATES,
  offerPriceSplit,
  type OfferChange,
  type OfferInput,
  type OfferPlan,
  type OfferPublishResult,
  type OfferRefusal,
  type OfferRefusalReason,
  type OwnOfferPage,
} from '../../../shared/feed-offers.js';
import { OfferError, OWN_OFFERS_PAGE_MAX, type OfferErrorCode, type OfferStore } from './store.js';

export const FEED_OFFER_TOOLS = [
  'city_service_plan',
  'city_service_publish',
  'city_service_update',
  'city_service_pause',
  'city_service_mine',
] as const;
export type FeedOfferToolName = (typeof FEED_OFFER_TOOLS)[number];

/**
 * Never a default: `services:sell` is held only when it was asked for by name and ticked by the
 * owner. Separate from `services:pay`: a grant that buys services never lists them, and the other
 * way round.
 */
export const FEED_OFFER_TOOL_SCOPES: Record<FeedOfferToolName, 'services:sell'> = {
  city_service_plan: 'services:sell',
  city_service_publish: 'services:sell',
  city_service_update: 'services:sell',
  city_service_pause: 'services:sell',
  city_service_mine: 'services:sell',
};

/** The sentence every tool says about the price. */
export const OFFER_FEE_SENTENCE =
  'Prices are fee included: the buyer pays the listed price, the seller receives 90% and 10% goes to the protocol.';

const MIN_USDC = rawToUsdc(String(FEE_ROUTER_MIN_INCLUDED));
const MAX_USDC = rawToUsdc(String(FEE_ROUTER_MAX_TOTAL));
/** The highest price while fee router 2 is on (docs/protocol/FEE_ROUTER_2.md). */
const MAX_USDC_ROUTER2 = rawToUsdc(String(FEED_PAY_LIMITS.perCallMaxMaxRouter2Raw));
const PRICE_RANGE = `from ${MIN_USDC} to ${MAX_USDC} USDC, or up to ${MAX_USDC_ROUTER2} USDC while fee router 2 is on`;

// ---------------------------------------------------------------------------------------------
// Inputs

const priceUsdc = z
  .string()
  .trim()
  .max(20)
  .describe(
    `The price per call in USDC, fee included, ${PRICE_RANGE} (for example "0.05"). The seller receives 90% of it.`,
  );

const textField = (max: number) => z.string().max(max * 4);
const tagsField = z
  .array(textField(FEED_LIMITS.tagMax))
  .max(FEED_LIMITS.tagsMax)
  .describe(`At most ${FEED_LIMITS.tagsMax} words of at most ${FEED_LIMITS.tagMax} characters.`);

const presetValue = z.union([z.string(), z.number(), z.boolean()]);
/**
 * An offer's preset as the tools take and answer it: some of the kind's input fields with fixed
 * values. The store checks it against the kind (checkOfferPreset and the kind's own rules).
 */
const presetField = z
  .record(z.string().max(64), presetValue)
  .nullable()
  .describe(
    `Input fields every call of this offer runs with, e.g. {"from": "km", "to": "mi"} for unit-convert or {"token": "0x..."} for base-erc20-balance: only the kind's own input fields, with valid values, at most ${OFFER_PRESET_MAX_BYTES} bytes as JSON. Buyers send the other fields only; a buyer value for a fixed field is refused unless it is the same. The listing shows them as fixed settings. null or {} for none (the default).`,
  );

const offerItem = z
  .object({
    key: z
      .string()
      .regex(OFFER_KEY)
      .describe(
        'Your own name for this offer, 1 to 64 letters, digits or . _ : -. Publishing the same key again updates the same offer.',
      ),
    agent_id: z
      .string()
      .min(1)
      .max(128)
      .describe(
        "The selling agent: one of this workspace's agents with a ready wallet on Base. It is paid to that wallet.",
      ),
    kind: z
      .enum(OFFER_KINDS)
      .describe(
        `The built-in service it sells: ${OFFER_KINDS.map((kind) => `${kind} (${OFFER_KIND_SPECS[kind].summary})`).join('; ')}`,
      ),
    title: textField(FEED_LIMITS.titleMax).describe(
      `What buyers see first, 1 to ${FEED_LIMITS.titleMax} characters of plain text.`,
    ),
    description: textField(FEED_LIMITS.descriptionMax)
      .optional()
      .describe(`At most ${FEED_LIMITS.descriptionMax} characters of plain text.`),
    tags: tagsField.optional(),
    price_usdc: priceUsdc,
    discoverable: z
      .boolean()
      .optional()
      .describe('Also listed for x402 discovery outside Central City (default true).'),
    state: z
      .enum(OFFER_STATES)
      .optional()
      .describe(
        'active (default: listed in the Feed), paused (kept, not listed) or removed (an existing offer only; final).',
      ),
    preset: presetField.optional(),
  })
  .strict();

const offerBatch = z
  .array(offerItem)
  .min(1)
  .max(OFFER_LIMITS.batchMax)
  .describe(`1 to ${OFFER_LIMITS.batchMax} offers (at most 1 MiB as JSON).`);

const idempotencyKey = z
  .string()
  .regex(OFFER_IDEMPOTENCY_KEY)
  .describe(
    'One per call, 8 to 128 letters, digits or . _ : -. A retry with the same key answers the first answer and changes nothing; the same key with other arguments is refused.',
  );

const offerIdField = z.string().regex(OFFER_ID).describe('An offer id (off_ and 16 characters).');

export const servicePlanToolInput = z.object({ offers: offerBatch }).strict();

export const servicePublishToolInput = z
  .object({
    offers: offerBatch,
    idempotency_key: idempotencyKey,
    expected_hash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .describe('The hash city_service_plan answered for exactly these offers.'),
  })
  .strict();

export const serviceUpdateToolInput = z
  .object({
    changes: z
      .array(
        z
          .object({
            offer_id: offerIdField,
            title: textField(FEED_LIMITS.titleMax).optional(),
            description: textField(FEED_LIMITS.descriptionMax).optional(),
            tags: tagsField.optional(),
            price_usdc: priceUsdc.optional(),
            discoverable: z.boolean().optional(),
            state: z
              .enum(OFFER_STATES)
              .optional()
              .describe('active, paused, or removed (final: the offer is withdrawn for good).'),
            preset: presetField.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(OFFER_LIMITS.batchMax)
      .describe(
        `1 to ${OFFER_LIMITS.batchMax} changes; each names an offer and only the fields to change.`,
      ),
    idempotency_key: idempotencyKey,
  })
  .strict();

export const servicePauseToolInput = z
  .object({
    offer_ids: z
      .array(offerIdField)
      .min(1)
      .max(OFFER_LIMITS.batchMax)
      .describe(`1 to ${OFFER_LIMITS.batchMax} offer ids.`),
    resume: z
      .boolean()
      .optional()
      .describe('true lists the offers again instead of pausing them (default false).'),
    idempotency_key: idempotencyKey,
  })
  .strict();

export const serviceMineToolInput = z
  .object({
    agent_id: z.string().min(1).max(128).optional().describe("Only this agent's offers."),
    state: z
      .enum(OFFER_STATES)
      .optional()
      .describe('Only offers in this state (default: active and paused, never removed).'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(OWN_OFFERS_PAGE_MAX)
      .optional()
      .describe(`Offers per page (default 50, maximum ${OWN_OFFERS_PAGE_MAX}).`),
    cursor: offerIdField
      .optional()
      .describe('next_cursor of the previous page; omit for the first page.'),
  })
  .strict();

export const feedOfferToolInputSchemas: Record<FeedOfferToolName, z.ZodType> = {
  city_service_plan: servicePlanToolInput,
  city_service_publish: servicePublishToolInput,
  city_service_update: serviceUpdateToolInput,
  city_service_pause: servicePauseToolInput,
  city_service_mine: serviceMineToolInput,
};

// ---------------------------------------------------------------------------------------------
// Outputs

const refusalOutput = z
  .object({
    index: z.number().int().nullable(),
    key: z.string().nullable(),
    reason: z.enum(OFFER_REFUSALS),
    message: z.string(),
  })
  .strict();

const priceOutput = {
  price_usdc: z.string(),
  seller_receives_usdc: z.string(),
  protocol_fee_usdc: z.string(),
};

export const servicePlanToolOutput = z
  .object({
    ok: z.boolean(),
    hash: z.string().nullable(),
    offers: z.array(
      z
        .object({
          key: z.string(),
          offer_id: z.string().nullable(),
          action: z.enum(['create', 'update', 'unchanged']),
          agent_id: z.string(),
          pay_to: z.string(),
          kind: z.enum(OFFER_KINDS),
          title: z.string(),
          description: z.string(),
          tags: z.array(z.string()),
          ...priceOutput,
          discoverable: z.boolean(),
          state: z.enum(OFFER_STATES),
          preset: z.record(z.string(), presetValue).nullable(),
          version: z.number().int(),
          listed: z.boolean(),
        })
        .strict(),
    ),
    refusals: z.array(refusalOutput),
    writes: z.number().int(),
    fee: z.literal(OFFER_FEE_SENTENCE),
  })
  .strict();

const writeOutput = z
  .object({
    replay: z.boolean(),
    hash: z.string(),
    offers: z.array(
      z
        .object({
          key: z.string(),
          offer_id: z.string(),
          service_id: z.string(),
          action: z.enum(['create', 'update', 'unchanged']),
          version: z.number().int(),
          listed: z.boolean(),
        })
        .strict(),
    ),
    writes: z.number().int(),
    fee: z.literal(OFFER_FEE_SENTENCE),
  })
  .strict();

export const serviceMineToolOutput = z
  .object({
    offers: z.array(
      z
        .object({
          offer_id: z.string(),
          key: z.string(),
          service_id: z.string(),
          agent_id: z.string(),
          pay_to: z.string(),
          kind: z.enum(OFFER_KINDS),
          title: z.string(),
          description: z.string(),
          tags: z.array(z.string()),
          ...priceOutput,
          discoverable: z.boolean(),
          state: z.enum(OFFER_STATES),
          preset: z.record(z.string(), presetValue).nullable(),
          version: z.number().int(),
          listed: z.boolean(),
          not_listed: z.enum(OFFER_NOT_LISTED).nullable(),
          created_at: z.string(),
          updated_at: z.string(),
        })
        .strict(),
    ),
    next_cursor: z.string().optional(),
    fee: z.literal(OFFER_FEE_SENTENCE),
  })
  .strict();

export const feedOfferToolOutputSchemas: Record<FeedOfferToolName, z.ZodType> = {
  city_service_plan: servicePlanToolOutput,
  city_service_publish: writeOutput,
  city_service_update: writeOutput,
  city_service_pause: writeOutput,
  city_service_mine: serviceMineToolOutput,
};

// ---------------------------------------------------------------------------------------------
// Descriptions and annotations

const SCOPE_SENTENCE =
  'Needs the services:sell scope, which is never a default: the owner allows it by name.';
const LISTING_SENTENCE =
  'Each active offer is listed in the Central City Feed (source Central City), where any agent finds it with city_service_search and buys it with city_service_call.';

export const feedOfferToolDescriptions: Record<
  FeedOfferToolName,
  { title: string; description: string }
> = {
  city_service_plan: {
    title: 'Plan services to sell',
    description: `Check up to ${OFFER_LIMITS.batchMax} services your agents would sell in the Feed, without writing anything. Each offer names one of your agents (paid to its own wallet on Base), a built-in kind (${OFFER_KINDS.join(', ')}), a title, a description, tags, a price per call ${PRICE_RANGE}, and optionally a preset (input fields every call runs with, which buyers cannot change). ${OFFER_FEE_SENTENCE} Answers, per offer, what publishing would do (create, update or unchanged), what the seller receives and the fee, whether it would be listed, every refusal with its reason, and a hash. Publish the same offers with that hash using city_service_publish. ${SCOPE_SENTENCE}`,
  },
  city_service_publish: {
    title: 'Publish services to sell',
    description: `Publish up to ${OFFER_LIMITS.batchMax} offers planned with city_service_plan, in one step: pass the same offers, the plan's hash as expected_hash and an idempotency_key. If anything changed since the plan, nothing is written and you plan again. The same key with the same offers answers the first answer and changes nothing. ${LISTING_SENTENCE} ${OFFER_FEE_SENTENCE} An offer keeps its agent, kind and wallet; publishing an existing key again changes its text, price (at most once an hour) or state. Caps on offers per agent, per workspace and per hour are the same for every owner. ${SCOPE_SENTENCE}`,
  },
  city_service_update: {
    title: 'Change services you sell',
    description: `Change up to ${OFFER_LIMITS.batchMax} of your offers by offer_id: title, description, tags, price_usdc (at most once an hour per offer), discoverable, state (active, paused, or removed, which is final) or preset (null removes it). Fields you leave out stay as they are. Checked and written in one step by the same rules as a publish. Every call takes an idempotency_key: a retry with the same key changes nothing. ${OFFER_FEE_SENTENCE} ${SCOPE_SENTENCE}`,
  },
  city_service_pause: {
    title: 'Pause services you sell',
    description: `Pause up to ${OFFER_LIMITS.batchMax} of your offers by offer_id: they stay yours and leave the Feed until resumed. With resume: true they are listed again (the agent's wallet must still be ready). Pausing an offer that is already removed (also when its agent was revoked) changes nothing and succeeds. Every call takes an idempotency_key: a retry with the same key changes nothing. ${SCOPE_SENTENCE}`,
  },
  city_service_mine: {
    title: 'List services you sell',
    description: `List your workspace's offers, a page at a time: each with its offer_id, key, agent, kind, text, price (what the seller receives and the fee), state, preset, its Feed service_id, and whether the Feed shows it now; if not, not_listed says why (paused, removed, held while the agent or workspace is paused, risk_rule, or hidden). Filter by agent_id or state. Reads only. ${SCOPE_SENTENCE}`,
  },
};

export const feedOfferToolAnnotations: Record<
  FeedOfferToolName,
  {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  }
> = {
  city_service_plan: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  // Lists in the public Feed (seen by every owner), and can change or remove offers in place.
  city_service_publish: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  city_service_update: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  // Reversible: resume lists them again.
  city_service_pause: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  city_service_mine: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

// ---------------------------------------------------------------------------------------------
// Errors

const ERROR_STATUS: Record<OfferErrorCode, number> = {
  invalid_batch: 400,
  invalid_idempotency_key: 400,
  workspace_not_found: 404,
  plan_refused: 400,
  plan_changed: 409,
  idempotency_key_reused: 409,
};

/** The store's messages name its own fields; the tools' fields are named here. */
const TOOL_REFUSAL_TEXT: Partial<Record<OfferRefusalReason, string>> = {
  invalid_price: `price_usdc must be ${PRICE_RANGE} (fee included), with at most 6 decimals.`,
  invalid_field: 'An offer has a field of the wrong type.',
  agent_not_found: 'No agent with this agent_id in this workspace.',
};

const toolRefusal = (refusal: OfferRefusal): OfferRefusal => ({
  ...refusal,
  message: TOOL_REFUSAL_TEXT[refusal.reason] ?? refusal.message,
});

/**
 * A refusal over the tool transports: `statusCode` and `errorCode` as the other module tools, and
 * per-offer refusals as `issues` (code, path, message, index, key), which REST and MCP both pass.
 */
export class FeedOfferToolError extends Error {
  readonly statusCode: number;
  readonly issues: Array<{
    code: OfferRefusalReason;
    path: string;
    message: string;
    index: number | null;
    key: string | null;
  }>;
  constructor(
    readonly errorCode: OfferErrorCode,
    message: string,
    refusals: OfferRefusal[],
    field: string,
  ) {
    super(message);
    this.statusCode = ERROR_STATUS[errorCode];
    this.issues = refusals.map((refusal) => {
      const shown = toolRefusal(refusal);
      return {
        code: shown.reason,
        path: shown.index === null ? field : `${field}.${shown.index}`,
        message: shown.message,
        index: shown.index,
        key: shown.key,
      };
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Mapping

type OfferItem = z.infer<typeof offerItem>;

/** USDC text as base units; a price that is not USDC text becomes one the store refuses. */
const priceRawOf = (text: string) => usdcToRaw(text) ?? 'not-a-price';

const toOfferInput = (item: OfferItem): OfferInput => ({
  key: item.key,
  agentId: item.agent_id,
  kind: item.kind,
  title: item.title,
  ...(item.description !== undefined ? { description: item.description } : {}),
  ...(item.tags !== undefined ? { tags: item.tags } : {}),
  priceRaw: priceRawOf(item.price_usdc),
  ...(item.discoverable !== undefined ? { discoverable: item.discoverable } : {}),
  ...(item.state !== undefined ? { state: item.state } : {}),
  ...(item.preset !== undefined ? { preset: item.preset } : {}),
});

const priceView = (priceRaw: string) => {
  const split = offerPriceSplit(priceRaw);
  return {
    price_usdc: rawToUsdc(priceRaw),
    seller_receives_usdc: rawToUsdc(split.sellerRaw),
    protocol_fee_usdc: rawToUsdc(split.feeRaw),
  };
};

const iso = (ms: number) => new Date(ms).toISOString();

export function planOutput(plan: OfferPlan): z.infer<typeof servicePlanToolOutput> {
  return {
    ok: plan.ok,
    hash: plan.hash,
    offers: plan.items.map((item) => ({
      key: item.key,
      offer_id: item.offerId,
      action: item.action,
      agent_id: item.agentId,
      pay_to: item.payTo,
      kind: item.kind,
      title: item.title,
      description: item.description,
      tags: item.tags,
      ...priceView(item.priceRaw),
      discoverable: item.discoverable,
      state: item.state,
      preset: item.preset,
      version: item.version,
      listed: item.listed,
    })),
    refusals: plan.refusals.map(toolRefusal),
    writes: plan.writes,
    fee: OFFER_FEE_SENTENCE,
  };
}

export function writeResultOutput(
  result: OfferPublishResult,
  serviceIdOf: (offerId: string) => string,
): z.infer<typeof writeOutput> {
  return {
    replay: result.replay,
    hash: result.hash,
    offers: result.offers.map((offer) => ({
      key: offer.key,
      offer_id: offer.offerId,
      service_id: serviceIdOf(offer.offerId),
      action: offer.action,
      version: offer.version,
      listed: offer.listed,
    })),
    writes: result.writes,
    fee: OFFER_FEE_SENTENCE,
  };
}

export function mineOutput(page: OwnOfferPage): z.infer<typeof serviceMineToolOutput> {
  return {
    offers: page.offers.map((offer) => ({
      offer_id: offer.offerId,
      key: offer.key,
      service_id: offer.serviceId,
      agent_id: offer.agentId,
      pay_to: offer.payTo,
      kind: offer.kind,
      title: offer.title,
      description: offer.description,
      tags: offer.tags,
      ...priceView(offer.priceRaw),
      discoverable: offer.discoverable,
      state: offer.state,
      preset: offer.preset,
      version: offer.version,
      listed: offer.listed,
      not_listed: offer.notListed,
      created_at: iso(offer.createdAt),
      updated_at: iso(offer.updatedAt),
    })),
    ...(page.next ? { next_cursor: page.next } : {}),
    fee: OFFER_FEE_SENTENCE,
  };
}

// ---------------------------------------------------------------------------------------------
// Running

export interface FeedOfferToolCaller {
  /** The workspace the grant or key acts for. */
  workspaceId: string;
}

/**
 * Runs one tool call; the credential and its scope were checked by assistant-access.ts. Arguments
 * are parsed here as well, so the REST transport gets the same answers as MCP.
 */
export async function runFeedOfferTool(
  store: OfferStore,
  name: FeedOfferToolName,
  args: unknown,
  caller: FeedOfferToolCaller,
): Promise<unknown> {
  const field =
    name === 'city_service_update'
      ? 'changes'
      : name === 'city_service_pause'
        ? 'offer_ids'
        : 'offers';
  try {
    switch (name) {
      case 'city_service_plan': {
        const input = servicePlanToolInput.parse(args ?? {});
        return planOutput(
          await store.planOffers(caller.workspaceId, input.offers.map(toOfferInput)),
        );
      }
      case 'city_service_publish': {
        const input = servicePublishToolInput.parse(args ?? {});
        const result = await store.publishOffers(
          caller.workspaceId,
          input.offers.map(toOfferInput),
          input.idempotency_key,
          input.expected_hash,
        );
        return writeResultOutput(result, store.serviceIdOf);
      }
      case 'city_service_update': {
        const input = serviceUpdateToolInput.parse(args ?? {});
        const changes: OfferChange[] = input.changes.map((change) => ({
          offerId: change.offer_id,
          ...(change.title !== undefined ? { title: change.title } : {}),
          ...(change.description !== undefined ? { description: change.description } : {}),
          ...(change.tags !== undefined ? { tags: change.tags } : {}),
          ...(change.price_usdc !== undefined ? { priceRaw: priceRawOf(change.price_usdc) } : {}),
          ...(change.discoverable !== undefined ? { discoverable: change.discoverable } : {}),
          ...(change.state !== undefined ? { state: change.state } : {}),
          ...(change.preset !== undefined ? { preset: change.preset } : {}),
        }));
        const result = await store.changeOffers(caller.workspaceId, changes, input.idempotency_key);
        return writeResultOutput(result, store.serviceIdOf);
      }
      case 'city_service_pause': {
        const input = servicePauseToolInput.parse(args ?? {});
        const state = input.resume === true ? 'active' : 'paused';
        const result = await store.changeOffers(
          caller.workspaceId,
          input.offer_ids.map((offerId) => ({ offerId, state })),
          input.idempotency_key,
        );
        return writeResultOutput(result, store.serviceIdOf);
      }
      case 'city_service_mine': {
        const input = serviceMineToolInput.parse(args ?? {});
        return mineOutput(
          await store.listOffers(caller.workspaceId, {
            ...(input.agent_id !== undefined ? { agentId: input.agent_id } : {}),
            ...(input.state !== undefined ? { state: input.state } : {}),
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
            ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
          }),
        );
      }
    }
  } catch (error) {
    if (error instanceof OfferError)
      throw new FeedOfferToolError(error.code, error.message, error.refusals, field);
    throw error;
  }
}
