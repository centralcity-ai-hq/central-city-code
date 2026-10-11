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
 * - `assertAgentPayConsent` is the check agent payments run (P2c) before reserving and again before
 *   each new signature and broadcast; a withdrawn consent stops every new spend at its next check.
 *
 * Nothing here moves money or signs anything.
 */
import { randomUUID } from 'node:crypto';
import { formatUnits, getAddress } from 'viem';
import { z } from 'zod';
import type { Database, Transaction } from '../../database.js';
import { BASE_NETWORKS, type BaseChainId } from '../../../shared/base/chains.js';

export class AgentPayConsentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

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
  granted_at: string | number;
}

const grantBody = z.strictObject({
  /** The limit the owner saw on screen; it must still be the wallet's current one. */
  permissionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

export interface AgentPayConsentDeps {
  db: Database;
  chainId: BaseChainId;
  now?: () => number;
}

export function createAgentPayConsentService(deps: AgentPayConsentDeps) {
  const now = deps.now ?? Date.now;
  const usdc = BASE_NETWORKS[deps.chainId].tokens.USDC;
  const token = usdc.address.toLowerCase();

  /** The agent's wallet on this network, only for its owner account (else not disclosed). */
  async function walletOf(
    q: Pick<Transaction, 'query'>,
    accountId: string,
    agentId: string,
    lock = false,
  ) {
    const { rows } = await q.query<{ wallet_id: string; operator_id: string; state: string }>(
      `SELECT wallet_id, operator_id, state FROM base_wallets
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
      `SELECT consent_id, permission_id, permission_hash, granted_at FROM base_agent_pay_consents
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
    const covers = !!(limit && consent && consent.permission_id === limit.permission_id);
    return {
      chainId: deps.chainId,
      token: 'USDC' as const,
      // What the consent allows, in the owner's words; recipients are never wider than this.
      scope: {
        recipients: 'central-city-agents' as const,
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
            grantedAt: Number(consent.granted_at),
            coversCurrentLimit: covers,
          }
        : null,
      mayPay: covers,
    };
  }

  /** The owner consents for the limit they saw (its hash); any other current limit is refused. */
  async function grant(accountId: string, agentId: string, body: unknown) {
    const parsed = grantBody.safeParse(body ?? {});
    if (!parsed.success)
      throw new AgentPayConsentError(
        400,
        'invalid_body',
        'Send the limit you consent to (permissionHash).',
      );
    const seen = parsed.data.permissionHash.toLowerCase();
    await deps.db.transaction(async (tx) => {
      const wallet = await walletOf(tx, accountId, agentId, true);
      if (wallet.state !== 'derived' && wallet.state !== 'deployed')
        throw new AgentPayConsentError(409, 'wallet_not_usable', `The wallet is ${wallet.state}.`);
      const limit = await activeLimit(tx, wallet.wallet_id);
      if (!limit)
        throw new AgentPayConsentError(409, 'no_spending_limit', 'Set a spending limit first.');
      if (limit.permission_hash !== seen)
        throw new AgentPayConsentError(
          409,
          'limit_changed',
          'The spending limit changed. Look at it again before you allow payments.',
        );
      const current = await activeConsent(tx, wallet.wallet_id);
      if (current?.permission_id === limit.permission_id) return; // already covers it
      const at = now();
      if (current)
        await tx.query(
          `UPDATE base_agent_pay_consents SET revoked_at = $2, revoked_by = $3
           WHERE consent_id = $1 AND revoked_at IS NULL`,
          [current.consent_id, at, accountId],
        );
      await tx.query(
        `INSERT INTO base_agent_pay_consents (consent_id, chain_id, wallet_id, agent_id, token,
           permission_id, permission_hash, granted_by, granted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
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
        ],
      );
      await audit(tx, accountId, agentId, wallet.operator_id, 'agent_pay_consent_granted', {
        walletId: wallet.wallet_id,
        permissionHash: limit.permission_hash,
      });
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
 * hash), and that limit still active. Anything else refuses (no_consent).
 */
export async function assertAgentPayConsent(
  q: Pick<Transaction, 'query'>,
  input: {
    chainId: number;
    walletId: string;
    token: string;
    permissionId: string;
    permissionHash: string;
  },
): Promise<void> {
  const { rows } = await q.query<{ ok: number }>(
    `SELECT 1 AS ok FROM base_agent_pay_consents c
       JOIN base_spend_permissions p ON p.permission_id = c.permission_id
     WHERE c.chain_id = $1 AND c.wallet_id = $2 AND c.token = $3 AND c.permission_id = $4
       AND c.permission_hash = $5 AND c.revoked_at IS NULL
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
}
