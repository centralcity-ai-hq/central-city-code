/*
 * Base Pay P2d: the payments an agent made on its own (P2c, payments/agent-pay.ts: from its own
 * wallet, within the spending limit its owner signed), as that wallet's owner reads them.
 * Registered by the wallet routes, behind the same CITY_BASE_WALLET flag (404 while off), on the
 * wallet network only.
 *
 *   GET /api/base/agents/:agentId/wallet/agent-payments   200 { payments: PayByAgent[] }
 *
 * Read only: rows that exist in base_payments (source 'agent', kind 'transfer', USDC) paid from
 * this agent's wallet; nothing is read from Base, nothing is brought up to date, nothing is
 * written. Who may read: the account that owns the paying WALLET (base_wallets.owner_account_id),
 * as for Pay (pay/store.ts); anyone else, another agent's wallet or none gets 404. Never the agent's
 * current workspace or co-owners, and never a grant, workspace key or agent: the routes need the
 * person's console session. The owner's own payments and withdrawals are not listed here.
 *
 * The recipient is named from the confirmed registration records of its wallet (pay/store.ts
 * recipients); its name is display only. The transaction hash is the one recorded for the
 * payment's operation (settle_op_id, set only after its receipt was checked for this agent).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { formatUnits, getAddress } from 'viem';
import { z } from 'zod';
import type { Database } from '../../database.js';
import { BASE_NETWORKS } from '../../../shared/base/chains.js';
import {
  PAY_BY_AGENT_MAX,
  PAY_PATHS,
  type PayByAgent,
  type PayState,
} from '../../../shared/base/pay.js';
import { WALLET_CHAIN_ID } from '../../../shared/base/wallet-network.js';
import { TX_EXPLORER } from '../wallet/withdrawals.js';
import { createPayStore } from './store.js';

const NETWORK = BASE_NETWORKS[WALLET_CHAIN_ID];
const USDC = NETWORK.tokens.USDC;

interface Row {
  payment_id: string;
  state: string;
  op_status: string | null;
  recipient_address: string;
  amount: string;
  tx_hash: string | null;
  created_at: string | number;
  updated_at: string | number;
}

/** As the agent pay tools answer it (payments/agent-pay.ts): only 'paid' is final. */
function stateOf(row: Pick<Row, 'state' | 'op_status'>): PayState {
  if (row.state === 'paid') return 'final';
  if (row.state === 'failed' || row.state === 'refunded') return 'failed';
  return row.op_status === 'included' ? 'included' : 'pending';
}

export function createAgentPayHistory(deps: { db: Database }) {
  const { db } = deps;
  const registry = NETWORK.contracts.identityRegistry;
  // Without a canonical registry nothing names a recipient: the wallet alone is shown.
  const store = registry
    ? createPayStore({ chainId: WALLET_CHAIN_ID, registry, network: NETWORK })
    : null;

  async function recipientOf(wallet: string): Promise<PayByAgent['to']> {
    const found = store ? await store.recipients(db, { wallet }) : [];
    // Two records naming one wallet are not unambiguous: neither is shown.
    const record = found.length === 1 ? found[0] : null;
    return {
      agentId: record?.agentId ?? null,
      name: record?.name ?? '',
      baseId: record?.baseId ?? null,
      short: record?.short ?? null,
      wallet: getAddress(wallet),
    };
  }

  return {
    /** The agent's own payments, newest first; null when the wallet is not this account's. */
    async list(accountId: string, agentId: string): Promise<PayByAgent[] | null> {
      const { rows: wallets } = await db.query<{ wallet_id: string; operator_id: string }>(
        `SELECT wallet_id, operator_id FROM base_wallets
         WHERE agent_id = $1 AND chain_id = $2 AND owner_account_id = $3`,
        [agentId, WALLET_CHAIN_ID, accountId],
      );
      const wallet = wallets[0];
      if (!wallet) return null;
      const { rows } = await db.query<Row>(
        `SELECT p.payment_id, p.state, o.status AS op_status, p.recipient_address,
           p.amount::text AS amount, o.tx_hash, p.created_at, p.updated_at
         FROM base_payments p
         LEFT JOIN base_chain_ops o ON o.idempotency_key = p.settle_op_id
           AND o.chain_id = p.chain_id AND o.kind = 'transfer'
           AND lower(o.intent_hash) = lower(p.intent_hash)
         WHERE p.operator_id = $1 AND p.chain_id = $2 AND p.payer_wallet_id = $3
           AND p.source_kind = 'agent' AND p.source_ref = $4 AND p.kind = 'transfer'
           AND lower(p.token_address) = lower($5)
         ORDER BY p.created_at DESC, p.payment_id DESC
         LIMIT $6`,
        [
          wallet.operator_id,
          WALLET_CHAIN_ID,
          wallet.wallet_id,
          agentId,
          USDC.address,
          PAY_BY_AGENT_MAX,
        ],
      );
      const payments: PayByAgent[] = [];
      for (const row of rows) {
        const txHash = row.tx_hash && /^0x[0-9a-fA-F]{64}$/.test(row.tx_hash) ? row.tx_hash : null;
        payments.push({
          paymentId: row.payment_id,
          by: 'agent',
          state: stateOf(row),
          to: await recipientOf(row.recipient_address),
          token: 'USDC',
          amount: {
            raw: row.amount,
            decimals: USDC.decimals,
            display: formatUnits(BigInt(row.amount), USDC.decimals),
          },
          txHash,
          explorerUrl: txHash ? TX_EXPLORER + txHash : null,
          createdAt: Number(row.created_at),
          updatedAt: Number(row.updated_at),
        });
      }
      return payments;
    },
  };
}

export type AgentPayHistory = ReturnType<typeof createAgentPayHistory>;

const params = z.object({ agentId: z.string().uuid() });

export function registerAgentPayHistoryRoutes(
  app: FastifyInstance,
  deps: {
    enabled(): boolean;
    /** The signed-in person account, or the status to answer with (401 / 404). */
    person(
      request: FastifyRequest,
    ): Promise<{ ok: true; accountId: string } | { ok: false; code: number }>;
    history: AgentPayHistory;
  },
) {
  app.get(PAY_PATHS.agentPayments, async (request, reply) => {
    if (!deps.enabled()) return reply.code(404).send({ error: 'Not found.' });
    const person = await deps.person(request);
    if (!person.ok) return reply.code(person.code).send({ error: 'Not found.' });
    const parsed = params.safeParse(request.params);
    if (!parsed.success) return reply.code(404).send({ error: 'Not found.' });
    const payments = await deps.history.list(person.accountId, parsed.data.agentId);
    // Someone else's agent, or no wallet: 404, so its existence is not disclosed.
    if (!payments) return reply.code(404).send({ error: 'Not found.' });
    return { payments };
  });
}
