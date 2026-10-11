/*
 * Base Pay P2c: an agent pays another Central City agent in USDC, on its own, from its own wallet
 * on the wallet network, within the spending limit its owner signed on Base. The MCP tools are
 * city_pay and city_pay_status (agent-pay-tools.ts), behind CITY_BASE_WALLET=1 and
 * CITY_BASE_AGENT_PAY=1, scope `pay`.
 *
 * Who may make an agent pay (the binding). A grant or workspace key acts for one workspace and can
 * only name which of that workspace's agents pays whom. Whether an agent may pay on its own at all
 * is its owner's decision alone: the owner's consent for that agent and its current limit (P2b,
 * wallet/agent-pay-consent.ts) IS the delegation. Without it no grant or key can make the agent
 * pay, whatever its scopes. So every check below requires all of:
 *   - the caller's grant or key is current and holds `pay` (`revalidate`: assistant-access.ts
 *     loadAuthority + permit, the same re-check every other tool gets);
 *   - the paying agent is a live, unpaused agent of the calling workspace, and its wallet on the
 *     wallet network belongs to that workspace (base_wallets.operator_id);
 *   - the limit the payment chain spends under (chain/payment-chain.ts activePaymentLimit) has the
 *     owner's live consent for exactly that chain, token, wallet and limit (id and hash);
 *   - the recipient is still the same Central City agent with the same ready wallet.
 * They run before the payment is reserved, again after it is reserved and before it is signed (the
 * payment service's two authority checks), and once more in the payment chain's `authorize`, right
 * before the operation's first broadcast, against the limit signed into it, with a fresh ownerOf of
 * the recipient on Base. A refusal anywhere and nothing is sent; a withdrawn consent stops every
 * payment that has not been broadcast yet.
 *
 * Recipients are Central City agents only, named by text that is parsed and never fetched (Base
 * Pay P1's resolver, pay/service.ts): a Base ID, passport link, passport number or an agent's
 * wallet address; a confirmed registration with a ready vault wallet; never the paying wallet or
 * its spender (walletRecipientRefusal). Text from rooms is untrusted: nothing in a call can give
 * consent, change a limit, or change the recipient once resolved, and there is no note.
 *
 * Money moves only through the payment service (payments/service.ts) over the payment chain:
 * persisted before anything uncertain, an unknown outcome reconciled, never sent twice. The
 * idempotency key is the workspace's: the same key from any grant or key of the workspace is the
 * same payment, and the same key with another payment is refused (idempotency_conflict). Fees are
 * covered by a pinned sponsor or nothing is signed; USDC only; at least 0.01 USDC.
 *
 * Provenance: on Base the transfer is sent by the agent's spender account (one operation: spend
 * from the agent wallet under the limit, then transfer). Answers name the agent's own wallet as
 * `from.wallet` (via 'spending_limit') and the spender only as `onchainSender`.
 */
import { createHash } from 'node:crypto';
import { formatUnits, getAddress } from 'viem';
import { z } from 'zod';
import type { Database } from '../../database.js';
import { baseNetwork, type Address } from '../../../shared/base/chains.js';
import { PAY_MIN_AMOUNT } from '../../../shared/base/pay.js';
import { WALLET_CHAIN_ID, WALLET_NETWORK } from '../../../shared/base/wallet-network.js';
import {
  activePaymentLimit,
  PaymentChainError,
  type PaymentChainDeps,
  type PaymentChainPort,
  type PaymentLimitRef,
} from '../chain/payment-chain.js';
import { readPaymentReceipt } from '../chain/payment-receipt.js';
import { ReservationError } from '../chain/reservations.js';
import { SubmitError } from '../chain/submit.js';
import type { PayChainReader } from '../pay/chain.js';
import { createRecipientResolver, PayError, type RecipientEvidence } from '../pay/service.js';
import type { RecipientRecord } from '../pay/store.js';
import { AgentPayConsentError, assertAgentPayConsent } from '../wallet/agent-pay-consent.js';
import { createPaymentAuthority, walletRecipientRefusal } from './authority.js';
import {
  createPaymentService,
  intentFor,
  PaymentError,
  type PaymentAuthority,
  type PaymentChain,
  type PaymentStore,
  type TransferInput,
  type TransferIntent,
  type TransferRecord,
} from './service.js';
import { createPaymentIntentStore, type PaymentReceiptReader } from './store.js';

const CHAIN_ID = WALLET_CHAIN_ID;
const USDC = WALLET_NETWORK.tokens.USDC;

export type AgentPayErrorCode =
  | 'agent_not_found'
  | 'agent_paused'
  | 'workspace_paused'
  | 'wallet_not_usable'
  | 'no_spending_limit'
  /** The owner has not allowed this agent to pay on its own for its current limit. */
  | 'no_consent'
  | 'invalid_recipient'
  | 'recipient_ambiguous'
  | 'recipient_not_found'
  | 'recipient_not_ready'
  | 'recipient_changed'
  | 'self_payment'
  | 'invalid_amount'
  | 'amount_too_small'
  /** Above the on-chain allowance for the period, or the owner's Berlin day/week/month cap. */
  | 'over_limit'
  | 'insufficient_balance'
  /** No pinned sponsor covers the network fee: nothing was signed. */
  | 'not_sponsored'
  | 'fee_cap_exceeded'
  | 'idempotency_conflict'
  | 'payment_not_found'
  /** Base, the chain runtime or the recipient reader is not configured or cannot be read. */
  | 'unavailable';

const STATUS: Record<AgentPayErrorCode, number> = {
  agent_not_found: 404,
  agent_paused: 409,
  workspace_paused: 409,
  wallet_not_usable: 409,
  no_spending_limit: 409,
  no_consent: 403,
  invalid_recipient: 400,
  recipient_ambiguous: 400,
  recipient_not_found: 404,
  recipient_not_ready: 409,
  recipient_changed: 409,
  self_payment: 409,
  invalid_amount: 400,
  amount_too_small: 400,
  over_limit: 409,
  insufficient_balance: 409,
  not_sponsored: 503,
  fee_cap_exceeded: 503,
  idempotency_conflict: 409,
  payment_not_found: 404,
  unavailable: 503,
};

/** `statusCode` and `errorCode` are what the tool transports (REST and MCP) answer with. */
export class AgentPayError extends Error {
  readonly statusCode: number;
  constructor(
    readonly errorCode: AgentPayErrorCode,
    message: string,
  ) {
    super(message);
    this.statusCode = STATUS[errorCode];
  }
}

const refuse = (code: AgentPayErrorCode, message: string) => new AgentPayError(code, message);
const agentNotFound = () =>
  refuse('agent_not_found', 'No agent of this workspace with a wallet on Base has that id.');
const recipientChanged = () =>
  refuse(
    'recipient_changed',
    'The recipient no longer points to the same agent wallet on Base. Nothing was sent.',
  );
const unavailable = () =>
  refuse('unavailable', 'Payments on Base are not available right now. Nothing was sent.');

export const cityPayInput = z
  .object({
    from_agent_id: z
      .string()
      .uuid()
      .describe(
        "The paying agent: an agent of this workspace whose owner allowed it to pay on its own for its wallet's current spending limit.",
      ),
    recipient: z
      .string()
      .min(1)
      .max(200)
      .describe(
        'The Central City agent to pay: its Base ID, passport link (centralcity.ai/a/<short>), passport number (CC-<short>) or its agent wallet address. Read as text only; a link is never opened.',
      ),
    amount: z
      .string()
      .min(1)
      .max(40)
      .describe(
        'USDC as a decimal string, at most 6 decimals, at least 0.01 (for example "2.50").',
      ),
    idempotency_key: z
      .string()
      .min(8)
      .max(128)
      .describe(
        'Stable caller-chosen key, one per payment in this workspace: a retry with the same key and unchanged arguments returns the same payment and never pays twice; the same key with other arguments is refused.',
      ),
  })
  .strict();

export const cityPayStatusInput = z
  .object({
    payment_id: z.string().uuid().describe('The payment_id city_pay answered with.'),
  })
  .strict();

export type AgentPayState = 'pending' | 'included' | 'final' | 'failed';

/** What both tools answer: never the spender as the agent's wallet. */
export interface AgentPayment {
  payment_id: string;
  state: AgentPayState;
  amount: { raw: string; display: string; token: 'USDC' };
  from: { agentId: string; wallet: string; via: 'spending_limit' };
  /** The account that sends the operation on Base: the agent's spender, never its wallet. */
  onchainSender: string;
  to: { agentId: string; name?: string; baseId: string; wallet: string; checkedAtBlock: number };
  txHash: string | null;
}

export interface AgentPayCaller {
  /** The workspace the grant or key acts for. */
  workspaceId: string;
  /** Who acts, for the audit trail (e.g. "workspace key <id>"). */
  actor: string;
  /**
   * The caller's grant or key checked again exactly as every assistant tool checks it
   * (assistant-access.ts loadAuthority + permit, in a transaction of its own): rotated, revoked,
   * expired or without the pay scope, it throws, and the payment stops there.
   */
  revalidate(): Promise<void>;
}

export type AgentPayAuthorize = NonNullable<PaymentChainDeps['authorize']>;

export interface AgentPayDeps {
  db: Database;
  /** The deployment's settings (Base's own gate, chains.ts). */
  env: Record<string, string | undefined>;
  /**
   * The wallet network's agent payment chain (chain/runtime.ts agentPayments: a pinned sponsor or
   * nothing, USDC only, the wallet fee budget), built around this payment's authorize check.
   * Throws when it is not configured: the payment is then unavailable and nothing is stored.
   */
  chain(authorize: AgentPayAuthorize): Promise<PaymentChainPort>;
  /** The wallet network's ownerOf reader (pay/chain.ts); absent when no endpoint is configured. */
  recipients?: PayChainReader;
  /** Canonical receipts of payment operations; chain/payment-receipt.ts by default. */
  readPaymentReceipt?: PaymentReceiptReader;
  now?: () => number;
}

const DECIMAL = /^(0|[1-9][0-9]{0,29})(?:\.([0-9]{1,6}))?$/;

/** USDC base units from the decimal text; at least PAY_MIN_AMOUNT. */
function amountOf(text: string): bigint {
  const match = DECIMAL.exec(text);
  if (!match)
    throw refuse(
      'invalid_amount',
      'amount is USDC as a decimal string with at most 6 decimals, for example "2.50".',
    );
  const raw = BigInt(match[1]) * 10n ** 6n + BigInt((match[2] ?? '').padEnd(6, '0'));
  if (raw < PAY_MIN_AMOUNT) throw refuse('amount_too_small', 'A payment is at least 0.01 USDC.');
  return raw;
}

/** The workspace's key for one payment, namespaced so no other kind of payment can collide. */
const paymentKey = (key: string) => `agent-pay:${createHash('sha256').update(key).digest('hex')}`;

const stateOf = (record: TransferRecord): AgentPayState =>
  record.state === 'paid'
    ? 'final'
    : record.state === 'failed'
      ? 'failed'
      : record.receipt?.status === 'included'
        ? 'included'
        : 'pending';

/** A refusal in the tools' own words; anything else (credential, validation) passes unchanged. */
function failure(error: unknown): unknown {
  if (error instanceof AgentPayError) return error;
  if (error instanceof AgentPayConsentError) return refuse('no_consent', error.message);
  if (error instanceof PayError) {
    if (error.code === 'invalid_query')
      return refuse(
        'invalid_recipient',
        'Use a Base ID, a passport link (centralcity.ai/a/...), a passport number or an agent wallet address.',
      );
    if (error.code === 'ambiguous_query') return refuse('recipient_ambiguous', error.message);
    if (error.code === 'not_found') return refuse('recipient_not_found', error.message);
    if (error.code === 'not_central_city_agent')
      return refuse(
        'recipient_not_found',
        'This is not a Central City agent. Agents only pay Central City agents.',
      );
    if (error.code === 'recipient_not_ready') return refuse('recipient_not_ready', error.message);
    if (error.code === 'recipient_changed') return recipientChanged();
    if (error.code === 'chain_unavailable') return unavailable();
    return error;
  }
  if (error instanceof PaymentChainError) {
    if (error.code === 'OVER_ALLOWANCE' || error.code === 'OVER_CALENDAR_LIMIT')
      return refuse('over_limit', `Over the spending limit: ${error.message}`);
    if (error.code === 'NO_PERMISSION') return refuse('no_spending_limit', error.message);
    if (error.code === 'WALLET_NOT_FOUND') return agentNotFound();
    if (error.code === 'WALLET_NOT_USABLE') return refuse('wallet_not_usable', error.message);
    if (error.code === 'INTENT_MISMATCH')
      return refuse('idempotency_conflict', 'This idempotency_key belongs to another payment.');
    if (
      error.code === 'FEE_BUDGET_REQUIRED' ||
      error.code === 'SPONSOR_REQUIRED' ||
      error.code === 'WRONG_NETWORK'
    )
      return unavailable();
    return error;
  }
  if (error instanceof SubmitError) {
    if (error.code === 'NOT_SPONSORED')
      return refuse(
        'not_sponsored',
        'No pinned sponsor covers the network fee right now, so nothing was signed or sent.',
      );
    if (error.code === 'COST_CAP_EXCEEDED')
      return refuse(
        'fee_cap_exceeded',
        'The network fee could exceed its budget, so nothing was signed or sent.',
      );
    if (error.code === 'IDEMPOTENCY_CONFLICT')
      return refuse('idempotency_conflict', 'This idempotency_key belongs to another payment.');
    return error;
  }
  if (error instanceof ReservationError) {
    if (error.code === 'INSUFFICIENT_BALANCE')
      return refuse('insufficient_balance', "The agent's wallet does not hold enough USDC.");
    if (error.code === 'RESERVATION_CONFLICT')
      return refuse('idempotency_conflict', 'This idempotency_key belongs to another payment.');
    return error;
  }
  if (error instanceof PaymentError) {
    if (error.code === 'IDEMPOTENCY_CONFLICT')
      return refuse('idempotency_conflict', 'This idempotency_key was used for another payment.');
    if (error.code === 'SELF_TRANSFER' || error.code === 'SPENDER_RECIPIENT')
      return refuse('self_payment', 'An agent cannot pay its own wallet or spender.');
    if (error.code === 'NO_PERMISSION') return refuse('no_spending_limit', 'No spending limit.');
    if (error.code === 'SOURCE_UNAVAILABLE' || error.code === 'NOT_AUTHORIZED')
      return agentNotFound();
    if (error.code === 'NETWORK_DISABLED' || error.code === 'TOKEN_NOT_ALLOWED')
      return unavailable();
    return error;
  }
  return error;
}

interface Payer {
  agentId: string;
  walletId: string;
  /** The agent's own wallet (checksummed): where the money comes from. */
  address: string;
  /** Its spender account (checksummed): what sends the operation on Base. */
  spender: string;
}

interface StoredRow {
  payment_id: string;
  actor_id: string;
  source_ref: string;
  idempotency_key: string;
  recipient_address: string;
  token_address: string;
  amount: string;
  wallet: string;
  spender: string;
  created: Record<string, unknown>;
  authorized: Record<string, unknown> | null;
}

export function createAgentPayService(deps: AgentPayDeps) {
  const db = deps.db;
  const now = deps.now ?? Date.now;
  const resolver = createRecipientResolver({ db, chain: deps.recipients, now });
  const token = USDC.address;

  const network = () => {
    if (!baseNetwork(CHAIN_ID, deps.env)) throw unavailable();
  };

  /** A live, unpaused agent of the workspace with its wallet on the wallet network there. */
  async function payerOf(workspaceId: string, agentId: string): Promise<Payer> {
    const { rows: spaces } = await db.query<{
      agents: Array<{ id: string; revokedAt?: string | null; pausedAt?: string | null }> | null;
      paused: boolean | null;
    }>(
      "SELECT data->'agents' AS agents, (data->>'paused')::boolean AS paused FROM workspaces WHERE operator_id = $1",
      [workspaceId],
    );
    const agent = spaces[0]?.agents?.find((item) => item.id === agentId && !item.revokedAt);
    if (!agent) throw agentNotFound();
    if (agent.pausedAt) throw refuse('agent_paused', 'This agent is paused.');
    if (spaces[0].paused) throw refuse('workspace_paused', 'This workspace is paused.');
    const { rows } = await db.query<{
      wallet_id: string;
      address: string;
      spender_address: string;
      state: string;
    }>(
      `SELECT wallet_id, address, spender_address, state FROM base_wallets
       WHERE agent_id = $1 AND chain_id = $2 AND operator_id = $3`,
      [agentId, CHAIN_ID, workspaceId],
    );
    const wallet = rows[0];
    // An agent whose wallet is another workspace's pays nothing from here.
    if (!wallet) throw agentNotFound();
    if (wallet.state !== 'derived' && wallet.state !== 'deployed')
      throw refuse('wallet_not_usable', `The agent's wallet is ${wallet.state}.`);
    return {
      agentId,
      walletId: wallet.wallet_id,
      address: getAddress(wallet.address),
      spender: getAddress(wallet.spender_address),
    };
  }

  /** The same agent and the same wallet, still. */
  async function stillPayer(workspaceId: string, payer: Payer) {
    const again = await payerOf(workspaceId, payer.agentId);
    if (again.walletId !== payer.walletId || again.spender !== payer.spender) throw agentNotFound();
  }

  /** The limit the payment chain spends under from this wallet (activePaymentLimit). */
  async function limitOf(payer: Payer): Promise<PaymentLimitRef> {
    const limit = await activePaymentLimit(db, {
      chainId: CHAIN_ID,
      walletId: payer.walletId,
      token,
      spender: payer.spender as Address,
    });
    if (!limit)
      throw refuse(
        'no_spending_limit',
        "This agent's owner has not set a spending limit for it on Base.",
      );
    return limit;
  }

  /** The owner's live consent for exactly this limit (P2b): the delegation itself. */
  async function consented(limit: PaymentLimitRef) {
    if (!limit.permissionHash)
      throw refuse('no_consent', "This agent's owner has not allowed it to pay on its own.");
    await assertAgentPayConsent(db, {
      chainId: CHAIN_ID,
      walletId: limit.walletId,
      token,
      permissionId: limit.permissionId,
      permissionHash: limit.permissionHash,
    });
  }

  /**
   * The recipient is still the agent resolved, with the same ready wallet, in our records; with
   * `onBase`, ownerOf(Base ID) is read again at one block and must still be that wallet (and not
   * on a block Base dropped since the first read).
   */
  async function recipientStill(
    recipient: RecipientRecord,
    seen: RecipientEvidence,
    onBase: boolean,
  ): Promise<RecipientEvidence | null> {
    const again = await resolver.store.recipients(db, { baseId: recipient.baseId });
    if (
      again.length !== 1 ||
      again[0].agentId !== recipient.agentId ||
      again[0].walletId !== recipient.walletId ||
      again[0].wallet.toLowerCase() !== recipient.wallet.toLowerCase()
    )
      throw recipientChanged();
    if (!again[0].ready)
      throw refuse('recipient_not_ready', "This agent can't receive payments yet.");
    if (!onBase) return null;
    const read = await resolver.verify(again[0]);
    if (!read.matches) throw recipientChanged();
    if (read.block === seen.block && read.blockHash.toLowerCase() !== seen.blockHash.toLowerCase())
      throw recipientChanged();
    return read;
  }

  const paymentStore = () =>
    createPaymentIntentStore({
      db,
      readPaymentReceipt: deps.readPaymentReceipt ?? readPaymentReceipt,
      env: deps.env,
      now,
    });

  async function paymentIdOf(intent: TransferIntent): Promise<string> {
    const { rows } = await db.query<{ payment_id: string }>(
      `SELECT payment_id FROM base_payments
       WHERE operator_id = $1 AND chain_id = $2 AND idempotency_key = $3`,
      [intent.workspaceId, intent.chainId, intent.idempotencyKey],
    );
    if (!rows[0]) throw new PaymentError('PAYMENT_NOT_FOUND');
    return rows[0].payment_id;
  }

  /** One audit event of a kind per payment (append-only; a retry adds nothing). */
  async function audit(
    caller: AgentPayCaller,
    agentId: string,
    kind: 'agent_payment_created' | 'agent_payment_authorized',
    paymentId: string,
    detail: Record<string, unknown>,
  ) {
    await db.query(
      `INSERT INTO base_audit_events (at, actor, operator_id, agent_id, kind, detail)
       SELECT $1::bigint, $2::text, $3::text, $4::text, $5::text, $6::jsonb
       WHERE NOT EXISTS (SELECT 1 FROM base_audit_events
         WHERE kind = $5::text AND operator_id = $3::text AND detail->>'paymentId' = $7::text)`,
      [
        now(),
        caller.actor,
        caller.workspaceId,
        agentId,
        kind,
        JSON.stringify({ paymentId, ...detail }),
        paymentId,
      ],
    );
  }

  const amountJson = (raw: string) => ({
    raw,
    display: formatUnits(BigInt(raw), USDC.decimals),
    token: 'USDC' as const,
  });

  /** The workspace's own agent payment, with what was recorded when it was created. */
  async function stored(workspaceId: string, paymentId: string): Promise<StoredRow | null> {
    const { rows } = await db.query<StoredRow>(
      `SELECT p.payment_id, p.actor_id, p.source_ref, p.idempotency_key, p.recipient_address,
         p.token_address, p.amount::text AS amount, w.address AS wallet,
         w.spender_address AS spender, c.detail AS created, a.detail AS authorized
       FROM base_payments p
       JOIN base_wallets w ON w.wallet_id = p.payer_wallet_id
       JOIN LATERAL (SELECT detail FROM base_audit_events
         WHERE kind = 'agent_payment_created' AND operator_id = p.operator_id
           AND detail->>'paymentId' = p.payment_id ORDER BY event_id LIMIT 1) c ON true
       LEFT JOIN LATERAL (SELECT detail FROM base_audit_events
         WHERE kind = 'agent_payment_authorized' AND operator_id = p.operator_id
           AND detail->>'paymentId' = p.payment_id ORDER BY event_id LIMIT 1) a ON true
       WHERE p.payment_id = $1 AND p.operator_id = $2 AND p.chain_id = $3
         AND p.source_kind = 'agent' AND p.kind = 'transfer'`,
      [paymentId, workspaceId, CHAIN_ID],
    );
    return rows[0] ?? null;
  }

  /** The recipient's public card name while the records still name that agent; display only. */
  async function nameOf(baseId: string, agentId: string): Promise<string | undefined> {
    const found = await resolver.store.recipients(db, { baseId });
    return found.length === 1 && found[0].agentId === agentId && found[0].name
      ? found[0].name
      : undefined;
  }

  return {
    /** city_pay: the agent pays a Central City agent from its own wallet (see the header). */
    async pay(caller: AgentPayCaller, args: unknown): Promise<AgentPayment> {
      const input = cityPayInput.parse(args);
      const amount = amountOf(input.amount);
      network();
      let payer: Payer;
      let limit: PaymentLimitRef;
      let recipient: RecipientRecord;
      let checked: RecipientEvidence;
      try {
        payer = await payerOf(caller.workspaceId, input.from_agent_id);
        limit = await limitOf(payer);
        await consented(limit);
        // Text only: parsed, named in our records, checked on Base at one block.
        const found = await resolver.resolveRecipient(input.recipient);
        if (found.kind !== 'central_city_agent') throw refuse('recipient_not_found', 'Not found.');
        recipient = found.record;
        checked = found.evidence;
      } catch (error) {
        throw failure(error);
      }
      if (
        recipient.agentId === payer.agentId ||
        walletRecipientRefusal(
          { address: payer.address, spenderAddress: payer.spender },
          recipient.wallet,
        )
      )
        throw refuse('self_payment', 'An agent cannot pay its own wallet.');

      const actor = { workspaceId: caller.workspaceId, actorId: payer.agentId };
      const transfer: TransferInput = {
        chainId: CHAIN_ID,
        source: { agentId: payer.agentId },
        to: recipient.wallet.toLowerCase() as Address,
        token,
        amount,
        idempotencyKey: paymentKey(input.idempotency_key),
      };
      const expected = intentFor(actor, transfer, deps.env);

      // Everything the chain or the authority refused, reported once the outcome is recorded.
      let refusal: unknown = null;
      let submitFailure: unknown = null;
      const authorize: AgentPayAuthorize = async (intent, signed) => {
        try {
          if (
            intent.operationKey !== expected.operationKey ||
            intent.intentHash !== expected.intentHash
          )
            throw refuse('idempotency_conflict', 'This operation is not this payment.');
          await caller.revalidate();
          await stillPayer(caller.workspaceId, payer);
          if (signed.walletId !== payer.walletId) throw agentNotFound();
          // The limit signed into the operation must still be the wallet's current one, and the
          // owner's consent must cover exactly it.
          const current = await limitOf(payer);
          if (current.permissionId !== signed.permissionId)
            throw refuse(
              'no_consent',
              "The spending limit this payment was prepared under is no longer the agent's current one, so its owner's consent no longer covers it. Nothing was sent.",
            );
          await consented(signed);
          const read = await recipientStill(recipient, checked, true);
          if (read) checked = read;
          await audit(
            caller,
            payer.agentId,
            'agent_payment_authorized',
            await paymentIdOf(expected),
            {
              checkedBlock: checked.block.toString(10),
              checkedBlockHash: checked.blockHash,
              permissionId: signed.permissionId,
              permissionHash: signed.permissionHash,
            },
          );
        } catch (error) {
          refusal = failure(error);
          throw error;
        }
      };
      let chain: PaymentChainPort;
      try {
        chain = await deps.chain(authorize);
      } catch {
        throw unavailable();
      }

      const store = paymentStore();
      // Recorded with the payment, before anything is signed: who it goes to, as checked.
      const recording: PaymentStore = {
        ...store,
        async reserve(intent) {
          const record = await store.reserve(intent);
          await audit(caller, payer.agentId, 'agent_payment_created', await paymentIdOf(intent), {
            chainId: CHAIN_ID,
            token: 'USDC',
            amount: intent.amount,
            from: payer.address,
            via: 'spending_limit',
            onchainSender: payer.spender,
            to: recipient.wallet,
            recipientAgentId: recipient.agentId,
            baseId: recipient.baseId,
            short: recipient.short,
            checkedBlock: checked.block.toString(10),
            checkedBlockHash: checked.blockHash,
            permissionId: limit.permissionId,
            permissionHash: limit.permissionHash,
          });
          return record;
        },
      };
      const base = createPaymentAuthority({
        db,
        principal: { kind: 'agent', operatorId: caller.workspaceId, agentId: payer.agentId },
        revalidate: () => caller.revalidate(),
        env: deps.env,
      });
      // Before reserving and again before signing: the grant or key, the wallet and its limit
      // (authority.ts), then the agent, the owner's consent and the recipient in our records.
      const authority: PaymentAuthority = {
        async assertCanTransfer(intent) {
          await base.assertCanTransfer(intent);
          await stillPayer(caller.workspaceId, payer);
          await consented(await limitOf(payer));
          if (intent.to !== recipient.wallet.toLowerCase()) throw recipientChanged();
          await recipientStill(recipient, checked, false);
        },
      };
      const port: PaymentChain = {
        status: (intent) => chain.status(intent),
        async submit(intent) {
          try {
            return await chain.submit(intent);
          } catch (error) {
            submitFailure = failure(error);
            // Refused before its operation existed: recorded as never sent, not left waiting.
            await chain.fence(intent).catch(() => false);
            throw error;
          }
        },
      };
      let record: TransferRecord;
      try {
        record = await createPaymentService({
          store: recording,
          authority,
          chain: port,
          env: deps.env,
        }).transfer(actor, transfer);
      } catch (error) {
        throw failure(error);
      }
      // A payment refused on this call is reported as the refusal; nothing was sent.
      if (record.state === 'failed' && (refusal ?? submitFailure)) throw refusal ?? submitFailure;
      return {
        payment_id: await paymentIdOf(record.intent),
        state: stateOf(record),
        amount: amountJson(record.intent.amount),
        from: { agentId: payer.agentId, wallet: payer.address, via: 'spending_limit' },
        onchainSender: payer.spender,
        to: {
          agentId: recipient.agentId,
          ...(recipient.name ? { name: recipient.name } : {}),
          baseId: recipient.baseId,
          wallet: getAddress(recipient.wallet),
          checkedAtBlock: Number(checked.block),
        },
        txHash: record.receipt?.txHash ?? null,
      };
    },

    /**
     * city_pay_status: one of this workspace's agent payments, brought up to date from Base
     * (reconciling never signs and never builds a new operation); anything else is not found.
     */
    async status(caller: AgentPayCaller, args: unknown): Promise<AgentPayment> {
      const input = cityPayStatusInput.parse(args);
      network();
      const row = await stored(caller.workspaceId, input.payment_id);
      if (!row) throw refuse('payment_not_found', 'No payment of this workspace has that id.');
      let intent: TransferIntent;
      try {
        intent = intentFor(
          { workspaceId: caller.workspaceId, actorId: row.actor_id },
          {
            chainId: CHAIN_ID,
            source: { agentId: row.source_ref },
            to: row.recipient_address as Address,
            token: row.token_address as Address,
            amount: BigInt(row.amount),
            idempotencyKey: row.idempotency_key,
          },
          deps.env,
        );
      } catch (error) {
        throw failure(error);
      }
      const store = paymentStore();
      let record: TransferRecord;
      try {
        const chain = await deps.chain(async () => {
          throw new Error('A status read never sends anything.');
        });
        record = await store.observe(intent, await chain.status(intent));
      } catch {
        // Base or the chain runtime cannot be read now: the payment as last recorded.
        record = await store.observe(intent, null);
      }
      const created = row.created;
      const checkedAt = (row.authorized?.checkedBlock ?? created.checkedBlock) as string;
      const name = await nameOf(String(created.baseId), String(created.recipientAgentId));
      return {
        payment_id: row.payment_id,
        state: stateOf(record),
        amount: amountJson(row.amount),
        from: { agentId: row.source_ref, wallet: getAddress(row.wallet), via: 'spending_limit' },
        onchainSender: getAddress(row.spender),
        to: {
          agentId: String(created.recipientAgentId),
          ...(name ? { name } : {}),
          baseId: String(created.baseId),
          wallet: getAddress(row.recipient_address),
          checkedAtBlock: Number(checkedAt),
        },
        txHash: record.receipt?.txHash ?? null,
      };
    },
  };
}

export type AgentPayService = ReturnType<typeof createAgentPayService>;
