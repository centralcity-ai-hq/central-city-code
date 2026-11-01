/*
 * Base Pay P2b: the owner's consent that ONE of their agents may pay on its own, from its own
 * wallet, within its current spending limit (the product owner's decision of 11 October 2026; the
 * safety review asked for explicit consent on top of the limit).
 *
 * - Given and withdrawn only by the wallet's owner account (a person, the owner console), never by
 *   an agent, a grant, a workspace key or text in a room. Default: none.
 * - Bound to exactly one chain, token (USDC), wallet and spending limit (permission id AND hash).
 *   A new or replaced limit is never covered by a consent given for another one: the owner sees
 *   the new limit's terms and consents again.
 * - Bound to who it lets the agent pay, as the owner confirmed it (`recipients`, migration 118):
 *   'central-city-agents' (city_pay), or 'central-city-agents-and-feed-services' (also services
 *   listed in the Feed: city_service_call, docs/FEED_PAY.md, and only through a grant that holds
 *   the separate `services:pay` scope). Feed services are offered only while Feed pay is on
 *   (feedPayEnabled: live unless switched off). A consent keeps what the confirming request says
 *   its screen showed (`recipients`, Central City agents only when it says nothing), never what
 *   the flags say at submit time or later: one given for Central City agents only (every consent
 *   from before migration 118 among them) never pays a Feed service, and the owner confirms again
 *   to include them (the view's `reconfirmAddsFeedServices`).
 * - `assertAgentPayConsent` is the check agent payments run (P2c) before reserving and again before
 *   each new signature and broadcast; a withdrawn consent stops every new spend at its next check.
 *
 * - Signed by the wallet's owner key (CCA-113, migration 300): the PUT carries the owner key's
 *   signature over the chain, wallet, token, limit hash, recipients, a one-time nonce and when it
 *   was signed (shared/base/agent-pay-consent.ts). The server recovers the signer, requires the
 *   wallet's owner_address, refuses a nonce seen before or a signature older than 10 minutes, and
 *   stores the signature with the consent. A console session alone can no longer give a consent.
 *   Consents given before migration 300 (`before_signing`) keep working; a later row without a
 *   signature (an older instance during the deploy) never lets an agent pay.
 *
 * One service serves one chain (routes.ts builds one per chain). On Arc, Feed services means the ones
 * Arc agents sell: an outside x402 service is paid on Base only, and Feed pay refuses it for an Arc agent.
 *
 * Nothing here moves money or signs anything.
 */
import { randomUUID } from 'node:crypto';
import { formatUnits, getAddress, recoverTypedDataAddress, type Hex } from 'viem';
import { z } from 'zod';
import type { Database, Transaction } from '../../database.js';
import { usdcOf, type ChainId, type ChainUsdc } from '../../../shared/chains.js';
import { feedPayEnabled } from '../../../shared/feed-pay.js';
import {
  AGENT_PAY_CONSENT_SKEW_MS,
  AGENT_PAY_CONSENT_TTL_MS,
  agentPayConsentTypedData,
} from '../../../shared/base/agent-pay-consent.js';

export class AgentPayConsentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** no_consent only: a live consent for this limit exists, but not for this recipient. */
    readonly reason?: 'recipient_not_covered',
  ) {
    super(message);
  }
}

/** Who an agent with this consent may pay: Central City agents, and Feed services when confirmed. */
export type AgentPayRecipients = 'central-city-agents' | 'central-city-agents-and-feed-services';
export const AGENT_PAY_RECIPIENTS = [
  'central-city-agents',
  'central-city-agents-and-feed-services',
] as const satisfies readonly AgentPayRecipients[];

/** Who one payment goes to: another Central City agent (city_pay) or a Feed service. */
export type AgentPayRecipient = 'central-city-agent' | 'feed-service';

/** The consents that cover a payment to this recipient. */
const COVERED_BY: Record<AgentPayRecipient, readonly AgentPayRecipients[]> = {
  'central-city-agent': AGENT_PAY_RECIPIENTS,
  'feed-service': ['central-city-agents-and-feed-services'],
};

/** The narrower of two. */
const narrower = (a: AgentPayRecipients, b: AgentPayRecipients): AgentPayRecipients =>
  a === 'central-city-agents' || b === 'central-city-agents' ? 'central-city-agents' : a;

/** The limit a consent may cover: active (signed or on Base), USDC, with its hash. */
interface ActiveLimit {
  permission_id: string;
  permission_hash: string;
  period_kind: string | null;
  cap_raw: string | null;
  state: string;
}

interface ConsentRow {
  consent_id: string;
  permission_id: string;
  permission_hash: string;
  recipients: AgentPayRecipients;
  granted_at: string | number;
  /** Signed by the owner key (migration 300), or given before signatures existed. */
  bound: boolean;
}

/** A consent that may let an agent pay: signed by the owner key, or from before migration 300. */
const BOUND = '(c.owner_signature IS NOT NULL OR c.before_signing IS TRUE)';
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const NONCE = /^0x[0-9a-fA-F]{64}$/;

const grantBody = z.strictObject({
  /** The limit the owner saw on screen; it must still be the wallet's current one. */
  permissionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  /**
   * Who the screen the owner confirmed on said the consent covers (that view's
   * `confirmRecipients`), stored as sent: a tab opened while Feed pay was off sends Central City
   * agents only and gets exactly that, even if Feed pay is on by the time it is sent. Never wider
   * than what is offered now (else scope_changed). Left out: Central City agents only; the flags
   * never add Feed services to a confirmation that didn't name them.
   */
  recipients: z.enum(AGENT_PAY_RECIPIENTS).optional(),
  /** The owner key's signature over agentPayConsentTypedData (CCA-113). */
  signature: z.string().regex(SIGNATURE),
  nonce: z.string().regex(NONCE),
  /** When it was signed (ms); accepted for AGENT_PAY_CONSENT_TTL_MS. */
  issuedAt: z.number().int().nonnegative(),
});

export interface AgentPayConsentDeps {
  db: Database;
  chainId: ChainId;
  now?: () => number;
  /**
   * The flags, read per request: while Feed pay is on (feedPayEnabled) a consent confirmed now may
   * also cover Feed services. They never widen a consent already given.
   */
  env?: Record<string, string | undefined>;
}

export function createAgentPayConsentService(deps: AgentPayConsentDeps) {
  const now = deps.now ?? Date.now;
  // Every ChainId is listed there with its USDC.
  const usdc = usdcOf(deps.chainId) as ChainUsdc;
  const token = usdc.address.toLowerCase();
  /** Who a consent confirmed now covers: Feed services too, while Feed pay is on. */
  const offered = (): AgentPayRecipients =>
    deps.env && feedPayEnabled(deps.env)
      ? 'central-city-agents-and-feed-services'
      : 'central-city-agents';

  /** The agent's wallet on this network, only for its owner account (else not disclosed). */
  async function walletOf(
    q: Pick<Transaction, 'query'>,
    accountId: string,
    agentId: string,
    lock = false,
  ) {
    const { rows } = await q.query<{
      wallet_id: string;
      operator_id: string;
      state: string;
      address: string;
      owner_address: string;
    }>(
      `SELECT wallet_id, operator_id, state, address, owner_address FROM base_wallets
       WHERE agent_id = $1 AND chain_id = $2 AND owner_account_id = $3${lock ? ' FOR UPDATE' : ''}`,
      [agentId, deps.chainId, accountId],
    );
    if (!rows[0]) throw new AgentPayConsentError(404, 'not_found', 'Not found.');
    return rows[0];
  }

  async function activeLimit(q: Pick<Transaction, 'query'>, walletId: string) {
    const { rows } = await q.query<ActiveLimit>(
      `SELECT permission_id, permission_hash, period_kind, cap_raw::text AS cap_raw, state
       FROM base_spend_permissions
       WHERE wallet_id = $1 AND chain_id = $2 AND token = $3 AND permission_hash IS NOT NULL
         AND state IN ('signed','onchain')`,
      [walletId, deps.chainId, token],
    );
    return rows[0] ?? null;
  }

  async function activeConsent(q: Pick<Transaction, 'query'>, walletId: string) {
    const { rows } = await q.query<ConsentRow>(
      `SELECT consent_id, permission_id, permission_hash, recipients, granted_at,
         ${BOUND} AS bound
       FROM base_agent_pay_consents c
       WHERE wallet_id = $1 AND chain_id = $2 AND token = $3 AND revoked_at IS NULL`,
      [walletId, deps.chainId, token],
    );
    return rows[0] ?? null;
  }

  async function audit(
    q: Pick<Transaction, 'query'>,
    accountId: string,
    agentId: string,
    operatorId: string,
    kind: string,
    detail: Record<string, unknown>,
  ) {
    await q.query(
      `INSERT INTO base_audit_events (at, actor, operator_id, agent_id, kind, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        now(),
        accountId,
        operatorId,
        agentId,
        kind,
        JSON.stringify({ chainId: deps.chainId, ...detail }),
      ],
    );
  }

  /** What the owner's screen shows: the current limit's terms and whether the consent covers it. */
  async function view(accountId: string, agentId: string) {
    const wallet = await walletOf(deps.db, accountId, agentId);
    const [limit, consent] = await Promise.all([
      activeLimit(deps.db, wallet.wallet_id),
      activeConsent(deps.db, wallet.wallet_id),
    ]);
    // Only a consent bound to the owner key (or from before signatures) covers the limit.
    const covers = !!(
      limit &&
      consent &&
      consent.bound &&
      consent.permission_id === limit.permission_id
    );
    const offer = offered();
    // What the live consent allows now: what the owner confirmed, and Feed services only while
    // Feed pay is on as well. Never wider than what is stored.
    const allowed = covers && consent ? narrower(consent.recipients, offer) : null;
    return {
      chainId: deps.chainId,
      token: 'USDC' as const,
      // What the consent allows, in the owner's words: with a consent for the current limit, what
      // it was confirmed for (never wider); without one, what confirming now would allow. Central
      // City agents (city_pay), and services listed in the Feed (city_service_call, which needs
      // the services:pay scope as well) only for a consent confirmed with them.
      scope: {
        recipients: allowed ?? offer,
        token: 'USDC' as const,
        withinLimit: limit
          ? {
              permissionHash: limit.permission_hash,
              period: limit.period_kind,
              capRaw: limit.cap_raw,
              capDisplay:
                limit.cap_raw === null ? null : formatUnits(BigInt(limit.cap_raw), usdc.decimals),
            }
          : null,
      },
      consent: consent
        ? {
            permissionHash: consent.permission_hash,
            /** Who the owner confirmed it for, as stored. */
            recipients: consent.recipients,
            grantedAt: Number(consent.granted_at),
            coversCurrentLimit: covers,
          }
        : null,
      mayPay: covers,
      /** What the owner key signs to confirm (shared/base/agent-pay-consent.ts). */
      signing: {
        wallet: getAddress(wallet.address),
        token: getAddress(usdc.address),
        owner: getAddress(wallet.owner_address),
      },
      /**
       * What confirming from this screen covers: the screen sends it back as `recipients` with the
       * limit's hash, and exactly that is stored (left out: Central City agents only).
       */
      confirmRecipients: offer,
      /**
       * The live consent covers Central City agents only while Feed pay is on: confirming again
       * (the same limit, `recipients: confirmRecipients`) adds services in the Feed. Until then the
       * agent pays no Feed service on its own.
       */
      reconfirmAddsFeedServices:
        allowed === 'central-city-agents' && offer === 'central-city-agents-and-feed-services',
    };
  }

  /**
   * The owner consents for the limit they saw (its hash) and for the recipients they saw; another
   * current limit, or recipients wider than offered now, is refused. The same limit with the same
   * recipients is a replay (nothing changes); other recipients make a new consent that replaces
   * the live one.
   */
  async function grant(accountId: string, agentId: string, body: unknown) {
    const parsed = grantBody.safeParse(body ?? {});
    if (!parsed.success)
      throw new AgentPayConsentError(
        400,
        'invalid_body',
        'Send the limit you consent to (permissionHash), signed with your wallet key.',
      );
    const seen = parsed.data.permissionHash.toLowerCase();
    const offer = offered();
    const recipients = parsed.data.recipients ?? 'central-city-agents';
    if (narrower(recipients, offer) !== recipients)
      throw new AgentPayConsentError(
        409,
        'scope_changed',
        'Paying services in the Feed is off now. Look at what the agent may pay again before you allow payments.',
      );
    const at0 = now();
    await deps.db
      .transaction(async (tx) => {
        const wallet = await walletOf(tx, accountId, agentId, true);
        if (wallet.state !== 'derived' && wallet.state !== 'deployed')
          throw new AgentPayConsentError(
            409,
            'wallet_not_usable',
            `The wallet is ${wallet.state}.`,
          );
        const limit = await activeLimit(tx, wallet.wallet_id);
        if (!limit)
          throw new AgentPayConsentError(409, 'no_spending_limit', 'Set a spending limit first.');
        if (limit.permission_hash !== seen)
          throw new AgentPayConsentError(
            409,
            'limit_changed',
            'The spending limit changed. Look at it again before you allow payments.',
          );
        // CCA-113: signed by this wallet's owner key, for exactly this limit and these recipients.
        const signed = parsed.data;
        if (
          signed.issuedAt < at0 - AGENT_PAY_CONSENT_TTL_MS ||
          signed.issuedAt > at0 + AGENT_PAY_CONSENT_SKEW_MS
        )
          throw new AgentPayConsentError(
            422,
            'consent_expired',
            'This confirmation is too old. Confirm again.',
          );
        let signer: string | null = null;
        try {
          signer = getAddress(
            await recoverTypedDataAddress({
              ...agentPayConsentTypedData({
                chainId: deps.chainId,
                wallet: wallet.address,
                token: usdc.address,
                permissionHash: seen,
                recipients,
                nonce: signed.nonce,
                issuedAt: signed.issuedAt,
              }),
              signature: signed.signature as Hex,
            }),
          );
        } catch {
          signer = null;
        }
        if (signer !== getAddress(wallet.owner_address))
          throw new AgentPayConsentError(
            422,
            'signature_mismatch',
            'Not signed by the owner key of this wallet.',
          );
        const current = await activeConsent(tx, wallet.wallet_id);
        // Already given (and bound) for exactly this limit and these recipients: a replay.
        if (
          current?.bound &&
          current.permission_id === limit.permission_id &&
          current.recipients === recipients
        )
          return;
        const at = at0;
        if (current)
          await tx.query(
            `UPDATE base_agent_pay_consents SET revoked_at = $2, revoked_by = $3
           WHERE consent_id = $1 AND revoked_at IS NULL`,
            [current.consent_id, at, accountId],
          );
        await tx.query(
          `INSERT INTO base_agent_pay_consents (consent_id, chain_id, wallet_id, agent_id, token,
           permission_id, permission_hash, granted_by, granted_at, recipients,
           owner_signature, consent_nonce, signed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            randomUUID(),
            deps.chainId,
            wallet.wallet_id,
            agentId,
            token,
            limit.permission_id,
            limit.permission_hash,
            accountId,
            at,
            recipients,
            signed.signature.toLowerCase(),
            signed.nonce.toLowerCase(),
            signed.issuedAt,
          ],
        );
        await audit(tx, accountId, agentId, wallet.operator_id, 'agent_pay_consent_granted', {
          walletId: wallet.wallet_id,
          permissionHash: limit.permission_hash,
          recipients,
        });
      })
      .catch((error: unknown) => {
        // The nonce of a signature already used for another consent (unique index, migration 300).
        const failed = error as { code?: unknown; constraint?: unknown } | null;
        if (failed?.code === '23505' && failed.constraint === 'base_agent_pay_consents_nonce')
          throw new AgentPayConsentError(
            409,
            'nonce_used',
            'This confirmation was already used. Confirm again.',
          );
        throw error;
      });
    return view(accountId, agentId);
  }

  /** The owner withdraws it: every new spend stops at its next check. Idempotent. */
  async function revoke(accountId: string, agentId: string) {
    await deps.db.transaction(async (tx) => {
      const wallet = await walletOf(tx, accountId, agentId, true);
      const { rows } = await tx.query<{ permission_hash: string }>(
        `UPDATE base_agent_pay_consents SET revoked_at = $3, revoked_by = $4
         WHERE wallet_id = $1 AND chain_id = $2 AND revoked_at IS NULL
         RETURNING permission_hash`,
        [wallet.wallet_id, deps.chainId, now(), accountId],
      );
      if (rows[0])
        await audit(tx, accountId, agentId, wallet.operator_id, 'agent_pay_consent_revoked', {
          walletId: wallet.wallet_id,
          permissionHash: rows[0].permission_hash,
        });
    });
    return view(accountId, agentId);
  }

  return { view, grant, revoke };
}

export type AgentPayConsentService = ReturnType<typeof createAgentPayConsentService>;

/**
 * The check an agent payment runs before reserving and again before each new signature and
 * broadcast: the owner's live consent for exactly this chain, token, wallet and limit (id and
 * hash), that limit still active, and the consent confirmed for this recipient (a Feed service
 * needs 'central-city-agents-and-feed-services'). Anything else refuses (no_consent; a consent for
 * Central City agents only says that the owner can confirm again to include Feed services).
 */
export async function assertAgentPayConsent(
  q: Pick<Transaction, 'query'>,
  input: {
    chainId: number;
    walletId: string;
    token: string;
    permissionId: string;
    permissionHash: string;
    /** Who this payment goes to. */
    recipient: AgentPayRecipient;
  },
): Promise<void> {
  const { rows } = await q.query<{ recipients: AgentPayRecipients }>(
    `SELECT c.recipients FROM base_agent_pay_consents c
       JOIN base_spend_permissions p ON p.permission_id = c.permission_id
     WHERE c.chain_id = $1 AND c.wallet_id = $2 AND c.token = $3 AND c.permission_id = $4
       AND c.permission_hash = $5 AND c.revoked_at IS NULL AND ${BOUND}
       AND p.wallet_id = c.wallet_id AND p.permission_hash = c.permission_hash
       AND p.state IN ('signed','onchain')`,
    [
      input.chainId,
      input.walletId,
      getAddress(input.token).toLowerCase(),
      input.permissionId,
      input.permissionHash.toLowerCase(),
    ],
  );
  if (!rows[0])
    throw new AgentPayConsentError(
      403,
      'no_consent',
      "This agent may not pay on its own: its owner hasn't allowed it for its current spending limit.",
    );
  if (!COVERED_BY[input.recipient].includes(rows[0].recipients))
    throw new AgentPayConsentError(
      403,
      'no_consent',
      'This agent may not pay services in the Feed on its own: its owner allowed it to pay Central City agents only. The owner can confirm again to include services in the Feed.',
      'recipient_not_covered',
    );
}
