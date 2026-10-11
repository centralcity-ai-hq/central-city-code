/*
 * Operation Base Pay P1 (server): an owner pays another Central City Base agent in USDC, by its
 * passport, from one of their own agents' wallets on the wallet network (shared/base/wallet-
 * network.ts). A payment IS an owner withdrawal (wallet/withdrawals.ts): the same two-phase owner
 * signing in the browser, holds, one unfinished owner operation per wallet, and its signing, status
 * and cancel go through the withdrawal routes by its withdrawal id. What Pay adds:
 *
 *   lookup   what the person typed (shared/base/pay.ts parseRecipient; nothing is ever fetched) to
 *            ONE Central City agent from our confirmed registration records (pay/store.ts), then
 *            checked on Base at one block (number + hash): ownerOf(Base ID) in the canonical
 *            registry of the wallet network is that agent's wallet. A POINT-IN-TIME check
 *            (verification 'point_in_time'): it confirms the recipient at that block, never when the
 *            payment lands. The answer carries the evidence and an expiry; never without that fresh
 *            read (else 503).
 *            The server keeps what it showed (base_pay_lookups): the answer's lookupId names it,
 *            only for the account that looked up, until it expires (5 minutes).
 *   create   for an agent the request carries only that lookupId; the stored lookup is what the
 *            person confirmed. Unknown, another account's or expired: 409 recipient_expired (look
 *            it up again). The recipient is resolved again from the records and checked once more
 *            on Base right before the operation is prepared; anything that differs from the lookup
 *            (agent, wallet, owner on Base, a dropped block) is 409 recipient_changed, and a check
 *            that ends after the lookup expired is 409 recipient_expired. The payment is stored with
 *            its withdrawal, the lookup it used and the fresh check, in one transaction. USDC only,
 *            at least PAY_MIN_AMOUNT, an exact amount, fees covered or nothing (the owner-funded
 *            fallback is never used for a payment, nor for its cancel). Never the paying wallet.
 *   incoming the account that owns the recipient WALLET (base_wallets.owner_account_id; never the
 *            agent's current workspace or co-owners) sees the payment at once when it is sent, as
 *            pending, included, final or failed; "paid" and the note only when final. Paged oldest
 *            change first by a cursor that never skips a change (pay/store.ts incoming). `safe`:
 *            settled at Base's safe head and not reverted, the same proof as the payer's
 *            withdrawal read, recorded once as a change of its own.
 *
 * Any other address is a payment only while CITY_BASE_PAY_ANY_ADDRESS is exactly '1' (default off:
 * 422 not_central_city_agent, use Withdraw). Names and notes are display only, never a binding.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { formatUnits, getAddress, isAddress, type Hex } from 'viem';
import type { Database, Transaction } from '../../database.js';
import { BASE_NETWORKS } from '../../../shared/base/chains.js';
import {
  PAY_INCOMING_PAGE_MAX,
  PAY_MIN_AMOUNT,
  PAY_NOTE_MAX,
  PAY_RECIPIENT_TTL_MS,
  parseRecipient,
  type PayAmount,
  type PayIncoming,
  type PayRecipient,
  type PayState,
  type PayRecipientAgent,
  type RecipientQuery,
} from '../../../shared/base/pay.js';
import { WALLET_CHAIN_ID } from '../../../shared/base/wallet-network.js';
import {
  TX_EXPLORER,
  type FinalWithdrawal,
  type PaymentHooks,
  type WithdrawalService,
  type WithdrawalSigningRequest,
} from '../wallet/withdrawals.js';
import type { PayChainReader } from './chain.js';
import {
  createPayStore,
  type IssuedLookup,
  type RecipientRecord,
  type StoredPayment,
} from './store.js';

const NETWORK = BASE_NETWORKS[WALLET_CHAIN_ID];
const USDC_DECIMALS = NETWORK.tokens.USDC.decimals;

/** Any address other than a Central City agent's: only when this is exactly '1' (default off). */
export const PAY_ANY_ADDRESS_SETTING = 'CITY_BASE_PAY_ANY_ADDRESS';

export function payAnyAddressEnabled(env: Record<string, string | undefined>): boolean {
  return env[PAY_ANY_ADDRESS_SETTING] === '1';
}

/**
 * Payments still on their way, brought up to date per incoming read (at most; the least recently
 * checked first, so every one gets its turn).
 */
export const INCOMING_REFRESH_MAX = 25;

/**
 * Included payments proven settled at Base's safe head per incoming read (at most; of those just
 * brought up to date and not yet recorded safe, the oldest first, each once). Each proof is the
 * payer's own (owner-ops.ts settledAtSafe: a fixed handful of reads of Base, given up after its time
 * limit); they run side by side. Reads only: nothing is signed or sent. A payment proven once is
 * recorded (base_wallet_withdrawals.safe_at) and never proven again; the rest answer safe: false
 * until a later read.
 */
export const INCOMING_SAFE_MAX = 10;

export type PayErrorCode =
  | 'invalid_query'
  | 'ambiguous_query'
  | 'invalid_body'
  | 'invalid_address'
  | 'invalid_amount'
  /** Below PAY_MIN_AMOUNT (0.01 USDC). */
  | 'amount_too_small'
  | 'invalid_note'
  | 'not_found'
  | 'not_central_city_agent'
  | 'self_payment'
  | 'recipient_changed'
  | 'recipient_expired'
  /**
   * Interim, fail closed (pay/store.ts walletReady): a Central City agent whose wallet is not its
   * owner account's vault wallet with the backup confirmed (no owner account, as the identity
   * wallet of an agent registered on Base before wallets existed; an owner address that is not the
   * vault key; a recipe that is not [vault key, SpendPermissionManager] at the agent's index; an
   * unconfirmed backup). It receives nothing until its wallet is ready. Answered by the lookup and
   * by the check right before a payment is prepared; never for reads or tracking.
   */
  | 'recipient_not_ready'
  /** The same rule for the paying wallet, checked when a payment is started (never on a replay). */
  | 'payer_not_ready'
  | 'idempotency_conflict'
  | 'chain_unavailable';

const STATUS: Record<PayErrorCode, number> = {
  invalid_query: 400,
  ambiguous_query: 400,
  invalid_body: 400,
  invalid_address: 400,
  invalid_amount: 400,
  amount_too_small: 400,
  invalid_note: 400,
  not_found: 404,
  not_central_city_agent: 422,
  self_payment: 409,
  recipient_changed: 409,
  recipient_expired: 409,
  recipient_not_ready: 409,
  payer_not_ready: 409,
  idempotency_conflict: 409,
  chain_unavailable: 503,
};

export class PayError extends Error {
  readonly status: number;
  constructor(
    readonly code: PayErrorCode,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.status = STATUS[code];
  }
}

const notCentralCity = () =>
  new PayError(
    'not_central_city_agent',
    'This is not a Central City agent. Use Withdraw for other addresses.',
  );
const changed = () =>
  new PayError(
    'recipient_changed',
    'This passport no longer points to the same agent wallet on Base. Look the recipient up again.',
  );
const expired = () =>
  new PayError(
    'recipient_expired',
    'This recipient lookup has expired or is not yours. Look the recipient up again and confirm.',
  );
const notReady = () =>
  new PayError('recipient_not_ready', "This agent can't receive payments yet.");
const payerNotReady = () =>
  new PayError(
    'payer_not_ready',
    "This agent's wallet can't send payments yet: its owner key and backup must be set up first.",
  );
const unavailable = () =>
  new PayError(
    'chain_unavailable',
    'Base cannot be read right now, so the recipient is not verified.',
  );

export interface PayDeps {
  db: Database;
  withdrawals: WithdrawalService;
  /** The wallet network's Base reader; absent when no endpoint is configured (verifying is 503). */
  chain?: PayChainReader;
  /** Read per request: whether any address may be paid (CITY_BASE_PAY_ANY_ADDRESS, default off). */
  anyAddress: () => boolean;
  now?: () => number;
}

/** What a check on Base found, at which block, when. */
export interface RecipientEvidence {
  matches: boolean;
  block: bigint;
  blockHash: Hex;
  at: number;
}

type PayTarget =
  | {
      kind: 'central_city_agent';
      record: RecipientRecord;
      /** The lookup the person confirmed (server side); its wallet is where the USDC goes. */
      lookup: IssuedLookup;
      address: string;
    }
  | { kind: 'address'; address: string };

interface PayBody {
  idempotencyKey: string;
  to: { kind: 'lookup'; lookupId: string } | { kind: 'address'; address: string };
  amount: string;
  note: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RAW_AMOUNT = /^[1-9][0-9]{0,77}$/;
const UINT256 = 2n ** 256n;
const LOOKUP_ID = /^pl_[0-9A-Za-z_-]{32}$/;
/** Clocks of two server instances may differ this much: expired lookups are kept that long more. */
export const CLOCK_SLACK_MS = 60_000;
/**
 * What a note may not hold: control and format characters (bidirectional marks and overrides,
 * zero-width characters, the byte-order mark) and line or paragraph separators, any of which could
 * disguise a note on screen.
 */
const UNSAFE_NOTE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** A strict address: all lower case, or a valid checksum; answered checksummed. */
function addressOf(value: unknown): string | null {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  return isAddress(value, { strict: true }) ? getAddress(value) : null;
}

function parsePay(input: unknown): PayBody {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new PayError('invalid_body', 'Send idempotencyKey, to, amount and an optional note.');
  const body = input as Record<string, unknown>;
  // The token, network and paying wallet are the server's: no other field is taken.
  if (Object.keys(body).some((key) => !['idempotencyKey', 'to', 'amount', 'note'].includes(key)))
    throw new PayError('invalid_body', 'Only idempotencyKey, to, amount and note are taken.');
  if (typeof body.idempotencyKey !== 'string' || !UUID.test(body.idempotencyKey))
    throw new PayError('invalid_body', 'idempotencyKey must be a UUID.');
  if (
    typeof body.amount !== 'string' ||
    !RAW_AMOUNT.test(body.amount) ||
    BigInt(body.amount) >= UINT256
  )
    throw new PayError('invalid_amount', 'amount is a positive whole number of USDC base units.');
  if (BigInt(body.amount) < PAY_MIN_AMOUNT)
    throw new PayError('amount_too_small', 'A payment is at least 0.01 USDC.', {
      min: amountJson(PAY_MIN_AMOUNT.toString(10)),
    });
  const to = body.to as Record<string, unknown> | null;
  if (typeof to !== 'object' || to === null || Array.isArray(to))
    throw new PayError('invalid_body', 'to is {lookupId} from the recipient answer, or {address}.');
  const keys = Object.keys(to).sort().join(',');
  let target: PayBody['to'];
  if (keys === 'lookupId') {
    // An agent: only the lookup the server issued names it; nothing else is taken from here.
    if (typeof to.lookupId !== 'string' || !LOOKUP_ID.test(to.lookupId))
      throw new PayError('invalid_body', 'lookupId is the one from the recipient answer.');
    target = { kind: 'lookup', lookupId: to.lookupId };
  } else if (keys === 'address') {
    const address = addressOf(to.address);
    if (address === null)
      throw new PayError('invalid_address', 'That is not a valid address (check its letters).');
    target = { kind: 'address', address };
  } else
    throw new PayError('invalid_body', 'to is {lookupId} from the recipient answer, or {address}.');
  let note: string | null = null;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string') throw new PayError('invalid_note', 'note is text.');
    const text = body.note.trim();
    if ([...text].length > PAY_NOTE_MAX)
      throw new PayError('invalid_note', `A note is at most ${PAY_NOTE_MAX} characters.`);
    if (UNSAFE_NOTE.test(text))
      throw new PayError('invalid_note', 'A note is one line of plain text.');
    note = text || null;
  }
  return {
    idempotencyKey: body.idempotencyKey.toLowerCase(),
    to: target,
    amount: body.amount,
    note,
  };
}

/** The payment as asked for, bound to the paying agent (the idempotency body). */
function requestHash(agentId: string, body: PayBody): string {
  const to =
    body.to.kind === 'lookup'
      ? ['lookup', body.to.lookupId]
      : ['address', body.to.address.toLowerCase()];
  const canonical = JSON.stringify(['pay-request-v1', agentId, 'USDC', body.amount, to, body.note]);
  return `0x${createHash('sha256').update(canonical).digest('hex')}`;
}

const amountJson = (raw: string): PayAmount => ({
  raw,
  decimals: USDC_DECIMALS,
  display: formatUnits(BigInt(raw), USDC_DECIMALS),
});

const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** What a sent payment's withdrawal state means to its recipient; null: never sent (not shown). */
export function payStateOf(withdrawal: string): PayState | null {
  if (withdrawal === 'submitted' || withdrawal === 'cancel_pending') return 'pending';
  if (withdrawal === 'included') return 'included';
  if (withdrawal === 'final') return 'final';
  if (withdrawal === 'failed' || withdrawal === 'cancelled') return 'failed';
  return null;
}

/** The notice line: "paid" only once final, never for a payment still on its way. */
function noticeText(state: PayState, payer: string, payee: string, amount: string): string {
  if (state === 'final') return `${payer} paid ${payee} ${amount} USDC`;
  if (state === 'failed') return `${payer}'s ${amount} USDC payment to ${payee} didn't go through`;
  return `${payer} is sending ${payee} ${amount} USDC`;
}

/** A recipient as `resolveRecipient` found it: an agent checked on Base, or (setting on) an address. */
export type ResolvedRecipient =
  | { kind: 'central_city_agent'; record: RecipientRecord; evidence: RecipientEvidence }
  | { kind: 'address'; address: string };

/**
 * Who a recipient is, for no account in particular: the one resolution every payment shares (the
 * owner's lookup and payment here, an agent's own payment in payments/agent-pay.ts). What was typed
 * is only parsed (parseRecipient; nothing is ever fetched), named in our confirmed registration
 * records (pay/store.ts) and checked on Base at one block. It issues no lookup and binds nothing to
 * anyone; callers keep what they need of the evidence.
 */
export function createRecipientResolver(deps: {
  db: Pick<Transaction, 'query'>;
  /** The wallet network's Base reader; absent when no endpoint is configured (verifying is 503). */
  chain?: PayChainReader;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const registry = NETWORK.contracts.identityRegistry;
  if (!registry) throw new Error('The wallet network has no identity registry.');
  // A reader for another network or registry would verify against the wrong records.
  if (
    deps.chain &&
    (deps.chain.chainId !== WALLET_CHAIN_ID ||
      deps.chain.registry.toLowerCase() !== registry.toLowerCase())
  )
    throw new Error('The Base reader is not the wallet network canonical registry.');
  const store = createPayStore({ chainId: WALLET_CHAIN_ID, registry, network: NETWORK });
  const db = deps.db;

  /**
   * The one check every recipient goes through (the lookup in any form, a payment to an address,
   * and the re-check right before a payment is prepared): its wallet must be ready (walletReady,
   * else 409 recipient_not_ready), then ownerOf(Base ID) at one block, read fresh; never cached,
   * never guessed.
   */
  async function verify(record: RecipientRecord): Promise<RecipientEvidence> {
    if (!record.ready) throw notReady();
    if (!deps.chain) throw unavailable();
    let read;
    try {
      read = await deps.chain.ownerOf(record.baseId);
    } catch {
      throw unavailable();
    }
    return {
      matches: read.owner !== null && read.owner.toLowerCase() === record.wallet.toLowerCase(),
      block: read.block,
      blockHash: read.blockHash,
      at: now(),
    };
  }

  /** The one agent a wallet address belongs to, or null (none, or not unambiguous). */
  async function agentByWallet(address: string): Promise<RecipientRecord | null> {
    const found = await store.recipients(db, { wallet: address });
    return found.length === 1 ? found[0] : null;
  }

  /** The one agent the readings of a Base ID / short id name; refuses anything else. */
  async function agentByReadings(readings: RecipientQuery[]): Promise<RecipientRecord> {
    const found = new Map<string, RecipientRecord>();
    let unclear = false;
    for (const reading of readings) {
      const rows = await store.recipients(
        db,
        reading.kind === 'baseId'
          ? { baseId: reading.baseId }
          : reading.kind === 'short'
            ? { short: reading.short }
            : { wallet: reading.address },
      );
      // Two registered agents for one Base ID or short id: our records are not unambiguous.
      if (rows.length > 1) unclear = true;
      else if (rows[0]) found.set(rows[0].agentId, rows[0]);
    }
    if (found.size > 1)
      throw new PayError(
        'ambiguous_query',
        'This could be a Base ID or a passport number. Paste the passport link instead.',
      );
    const record = [...found.values()][0];
    if (unclear || !record)
      throw new PayError('not_found', 'No Central City agent on Base with that passport.');
    return record;
  }

  /**
   * Who `text` names: a Central City agent whose Base ID its own wallet holds on Base at the block
   * read, or else, for an address only and only while `anyAddress()` (the owner's Pay with
   * CITY_BASE_PAY_ANY_ADDRESS on), that address unchecked; anything else refuses.
   */
  async function resolveRecipient(
    text: string,
    anyAddress: () => boolean = () => false,
  ): Promise<ResolvedRecipient> {
    const readings = parseRecipient(text);
    if (readings.length === 0)
      throw new PayError(
        'invalid_query',
        'Use a Base ID, a passport link (centralcity.ai/a/...), a passport number or an address.',
      );
    if (readings[0].kind === 'address') {
      const address = readings[0].address;
      const record = await agentByWallet(address);
      if (record) {
        const evidence = await verify(record);
        if (evidence.matches) return { kind: 'central_city_agent', record, evidence };
      }
      if (!anyAddress()) throw notCentralCity();
      return { kind: 'address', address };
    }
    const record = await agentByReadings(readings);
    const evidence = await verify(record);
    if (!evidence.matches)
      throw new PayError(
        'not_found',
        "This Base ID is not held by its Central City agent's wallet on Base right now.",
      );
    return { kind: 'central_city_agent', record, evidence };
  }

  return { registry, store, verify, agentByWallet, agentByReadings, resolveRecipient };
}

export type RecipientResolver = ReturnType<typeof createRecipientResolver>;

export function createPayService(deps: PayDeps) {
  const now = deps.now ?? Date.now;
  const db = deps.db;
  const recipients = createRecipientResolver({ db, chain: deps.chain, now });
  const { registry, store, verify, agentByWallet } = recipients;

  const recipientJson = (
    record: Pick<RecipientRecord, 'baseId' | 'short' | 'name' | 'wallet'>,
    lookup: { lookupId: string; expiresAt: number },
    evidence: { block: bigint | string; blockHash: string; at: number },
  ): PayRecipientAgent => ({
    kind: 'central_city_agent',
    baseId: record.baseId,
    short: record.short,
    name: record.name,
    wallet: getAddress(record.wallet),
    registry: registry!,
    chainId: WALLET_CHAIN_ID,
    verification: 'point_in_time',
    lookupId: lookup.lookupId,
    verified: {
      block: Number(evidence.block),
      blockHash: evidence.blockHash,
      at: evidence.at,
    },
    expiresAt: lookup.expiresAt,
  });

  /** Issues (or answers again) the lookup for what was just checked on Base, for this account. */
  async function issued(accountId: string, record: RecipientRecord, evidence: RecipientEvidence) {
    const lookup = await store.issueLookup(db, {
      lookupId: `pl_${randomBytes(24).toString('base64url')}`,
      accountId,
      record,
      block: evidence.block,
      blockHash: evidence.blockHash,
      issuedAt: evidence.at,
      expiresAt: evidence.at + PAY_RECIPIENT_TTL_MS,
      purgeBefore: evidence.at - CLOCK_SLACK_MS,
    });
    return recipientJson(record, lookup, {
      block: lookup.block,
      blockHash: lookup.blockHash,
      at: lookup.issuedAt,
    });
  }

  /** The recipient a payment body names (Base is read right before prepare). */
  async function targetOf(accountId: string, to: PayBody['to']): Promise<PayTarget> {
    if (to.kind === 'lookup') {
      // Only a lookup this account was issued, not expired: what the person saw and confirmed.
      const lookup = await store.lookupFor(db, to.lookupId, accountId);
      if (!lookup || now() > lookup.expiresAt) throw expired();
      const found = await store.recipients(db, { baseId: lookup.baseId });
      if (
        found.length !== 1 ||
        found[0].agentId !== lookup.agentId ||
        found[0].wallet.toLowerCase() !== lookup.wallet.toLowerCase()
      )
        throw changed();
      return { kind: 'central_city_agent', record: found[0], lookup, address: lookup.wallet };
    }
    // The screen showed this address as no Central City agent (classified as the lookup does);
    // if it is one now, that is not what was confirmed.
    const record = await agentByWallet(to.address);
    if (record && (await verify(record)).matches) throw changed();
    if (!deps.anyAddress()) throw notCentralCity();
    return { kind: 'address', address: to.address };
  }

  function paymentJson(stored: StoredPayment) {
    const agent = stored.recipient_kind === 'central_city_agent';
    const recipient: PayRecipient = agent
      ? recipientJson(
          {
            baseId: stored.recipient_base_id!,
            short: stored.recipient_short_id!,
            name: stored.name ?? '',
            wallet: stored.recipient_address,
          },
          { lookupId: stored.lookup_id!, expiresAt: Number(stored.issued_expires_at) },
          // The server's own check right before the operation was prepared (point in time).
          {
            block: stored.verified_block!,
            blockHash: stored.verified_block_hash!,
            at: Number(stored.verified_at),
          },
        )
      : {
          kind: 'address',
          address: getAddress(stored.recipient_address),
          verification: 'none',
          warning: 'not_central_city_agent',
        };
    return {
      paymentId: stored.payment_id,
      recipient,
      // The lookup the person confirmed, as the server issued it.
      lookupId: agent ? stored.lookup_id : null,
      issued: agent
        ? {
            block: Number(stored.issued_block),
            blockHash: stored.issued_block_hash!,
            expiresAt: Number(stored.issued_expires_at),
          }
        : null,
      note: stored.note,
    };
  }

  async function answer(signing: WithdrawalSigningRequest) {
    const stored = await store.byWithdrawal(db, signing.withdrawalId);
    // A key first used for a withdrawal never replays as a payment (its request hash differs).
    if (!stored) throw new Error('The withdrawal has no payment record.');
    return { ...signing, payment: paymentJson(stored) };
  }

  return {
    /** Who a payment would go to, checked on Base at one block; the lookup is this account's. */
    async lookup(accountId: string, q: string): Promise<PayRecipient> {
      const found = await recipients.resolveRecipient(q, deps.anyAddress);
      if (found.kind === 'address')
        return {
          kind: 'address',
          address: found.address,
          verification: 'none',
          warning: 'not_central_city_agent',
        };
      return issued(accountId, found.record, found.evidence);
    },

    /** A payment from the agent's wallet, as a withdrawal for its owner to sign (W2 shape). */
    async create(accountId: string, agentId: string, input: unknown) {
      const sender = await store.sender(db, accountId, agentId);
      // Not the paying wallet's owner (a co-owner, a stranger) or no such wallet: not disclosed.
      if (!sender) throw new PayError('not_found', 'Not found.');
      const body = parsePay(input);
      const request = requestHash(agentId, body);
      const withdrawal = (to: string) => ({
        idempotencyKey: body.idempotencyKey,
        token: 'USDC',
        amount: body.amount,
        to,
      });

      const existing = await store.byKey(db, accountId, body.idempotencyKey);
      if (existing) {
        if (existing.request_hash !== request)
          throw new PayError(
            'idempotency_conflict',
            'This idempotencyKey was used for another payment.',
          );
        // The same payment again: its withdrawal as it is now; nothing is checked or prepared again.
        const replay: PaymentHooks = {
          request,
          beforePrepare: async () => {
            throw new Error('A replayed payment is never prepared again.');
          },
          stored: async () => {
            throw new Error('A replayed payment is never stored again.');
          },
        };
        return answer(
          await deps.withdrawals.create(
            accountId,
            agentId,
            withdrawal(getAddress(existing.recipient_address)),
            replay,
          ),
        );
      }

      // A new payment only from a ready wallet (a replay above is a read: never refused for it).
      if (!sender.ready) throw payerNotReady();
      // The wallet the request names, then the one it resolves to: never the payer's.
      if (
        body.to.kind === 'address' &&
        body.to.address.toLowerCase() === sender.address.toLowerCase()
      )
        throw new PayError('self_payment', 'An agent cannot pay its own wallet.');
      const target = await targetOf(accountId, body.to);
      if (target.address.toLowerCase() === sender.address.toLowerCase())
        throw new PayError('self_payment', 'An agent cannot pay its own wallet.');

      let evidence: RecipientEvidence | null = null;
      const hooks: PaymentHooks = {
        request,
        // Right before the operation is prepared: the lookup has not expired, the same agent and
        // wallet are in our records, the wallet is ready, and ownerOf(Base ID) on Base at one block
        // is still the lookup's wallet, and that check ended before the lookup expired. Anything
        // else is refused.
        beforePrepare: async () => {
          if (target.kind === 'address') {
            if (!deps.anyAddress()) throw notCentralCity();
            return;
          }
          const lookup = target.lookup;
          if (now() > lookup.expiresAt) throw expired();
          const again = await store.recipients(db, { baseId: lookup.baseId });
          if (
            again.length !== 1 ||
            again[0].agentId !== lookup.agentId ||
            again[0].walletId !== target.record.walletId ||
            again[0].wallet.toLowerCase() !== lookup.wallet.toLowerCase()
          )
            throw changed();
          const read = await verify(again[0]);
          if (!read.matches) throw changed();
          // The same height with another hash: what was looked up was on a block Base dropped.
          if (
            read.block === lookup.block &&
            read.blockHash.toLowerCase() !== lookup.blockHash.toLowerCase()
          )
            throw changed();
          // A check that ended after the lookup expired confirms nothing that was shown.
          if (read.at > lookup.expiresAt) throw expired();
          evidence = read;
        },
        stored: async (tx: Transaction, withdrawalId: string) => {
          const at = now();
          const paymentId = randomUUID();
          const checked = evidence;
          if (target.kind === 'central_city_agent' && !checked)
            throw new Error('A payment to an agent is stored only after its check on Base.');
          await store.insert(tx, {
            paymentId,
            withdrawalId,
            accountId,
            senderWalletId: sender.walletId,
            senderAgentId: agentId,
            idempotencyKey: body.idempotencyKey,
            requestHash: request,
            amount: body.amount,
            note: body.note,
            at,
            recipient:
              target.kind === 'central_city_agent'
                ? {
                    kind: target.kind,
                    address: target.address,
                    agentId: target.record.agentId,
                    walletId: target.record.walletId,
                    baseId: target.record.baseId,
                    short: target.record.short,
                    registry: registry!,
                    lookup: {
                      lookupId: target.lookup.lookupId,
                      block: target.lookup.block.toString(10),
                      blockHash: target.lookup.blockHash,
                      expiresAt: target.lookup.expiresAt,
                    },
                    verified: {
                      block: checked!.block.toString(10),
                      blockHash: checked!.blockHash,
                      at: checked!.at,
                    },
                  }
                : { kind: 'address', address: target.address },
          });
          await tx.query(
            `INSERT INTO base_audit_events (at, actor, operator_id, agent_id, kind, detail)
             VALUES ($1, $2, $3, $4, 'payment_created', $5)`,
            [
              at,
              accountId,
              sender.operatorId,
              agentId,
              JSON.stringify({
                paymentId,
                withdrawalId,
                token: 'USDC',
                amount: body.amount,
                to: target.address,
                recipientKind: target.kind,
                ...(target.kind === 'central_city_agent'
                  ? {
                      baseId: target.record.baseId,
                      lookupId: target.lookup.lookupId,
                      verifiedBlock: checked!.block.toString(10),
                      verifiedBlockHash: checked!.blockHash,
                    }
                  : {}),
              }),
            ],
          );
        },
      };
      return answer(
        await deps.withdrawals.create(accountId, agentId, withdrawal(target.address), hooks),
      );
    },

    /**
     * Payments to wallets this account owns (base_wallets.owner_account_id; never the agent's
     * workspace or co-owners), once sent, in every state, oldest change first after `after`;
     * those still on their way are brought up to date first. "paid" and the note only when final.
     * `safe`: final, or in a block Base proved settled at its safe head and not reverted. Proven
     * while bringing those on their way up to date (INCOMING_SAFE_MAX per read) and recorded once
     * (base_wallet_withdrawals.safe_at, migration 96), which moves the payment in the change
     * cursor: a feed that only reads on after its cursor gets it again with safe: true.
     */
    async incoming(
      accountId: string,
      page: { after: { xid: string; paymentId: string } | null; limit: number },
    ): Promise<{ payments: PayIncoming[]; cursor: string | null; hasMore: boolean }> {
      const pending = await store.pendingIncoming(db, {
        accountId,
        limit: INCOMING_REFRESH_MAX,
        at: now(),
      });
      // Exactly as the payer's own next read would; a chain that does not answer changes nothing.
      for (const withdrawalId of pending) await deps.withdrawals.refresh(withdrawalId);
      // Of those, the ones in a block not yet recorded settled at Base's safe head: proven as the
      // payer's own read proves it (withdrawals.ts markSafe, settledIncluded), at most
      // INCOMING_SAFE_MAX, and recorded once on the withdrawal (safe_at), which moves the payment in
      // the change cursor. Nothing Base can't prove counts; a failed read records nothing.
      await deps.withdrawals.markSafe(pending, INCOMING_SAFE_MAX).catch(() => []);
      const limit = Math.min(Math.max(page.limit, 1), PAY_INCOMING_PAGE_MAX);
      const rows = await store.incoming(db, { accountId, after: page.after, limit: limit + 1 });
      const shown = rows.slice(0, limit);
      const payments: PayIncoming[] = [];
      for (const row of shown) {
        const state = payStateOf(row.state);
        if (!state) continue;
        const fromWallet = getAddress(row.from_wallet);
        const amount = amountJson(row.amount_raw);
        const fromName = row.from_name ?? '';
        const toName = row.to_name ?? '';
        const payer =
          fromName || (row.from_short ? 'CC-' + row.from_short : shortAddress(fromWallet));
        const payee = toName || 'CC-' + row.to_short;
        const txHash = row.tx_hash;
        payments.push({
          paymentId: row.payment_id,
          withdrawalId: row.withdrawal_id,
          state,
          from: {
            name: fromName,
            baseId: row.from_base_id,
            short: row.from_short,
            wallet: fromWallet,
          },
          to: {
            agentId: row.recipient_agent_id,
            name: toName,
            baseId: row.to_base_id,
            short: row.to_short,
            // What the money did: the withdrawal's own destination and amount.
            wallet: getAddress(row.destination),
          },
          token: 'USDC',
          amount,
          // The payer's words only once the payment is final.
          note: state === 'final' ? row.note : null,
          text: noticeText(state, payer, payee, amount.display),
          txHash,
          explorerUrl: txHash ? TX_EXPLORER + txHash : null,
          sentAt: Number(row.sent_at),
          updatedAt: Number(row.updated_at),
          finalAt: state === 'final' && row.final_at !== null ? Number(row.final_at) : null,
          // Recorded only for the receipt it was proven for; leaving it cleared it (migration 96).
          safe: state === 'final' || (state === 'included' && row.safe_at !== null),
        });
      }
      const last = shown[shown.length - 1];
      return {
        payments,
        cursor: last
          ? `${last.change_xid}.${last.payment_id}`
          : page.after
            ? `${page.after.xid}.${page.after.paymentId}`
            : null,
        hasMore: rows.length > limit,
      };
    },

    /** Whether a withdrawal is a payment: its cancel is sponsored or nothing (wallet/routes.ts). */
    isPayment(withdrawalId: string): Promise<boolean> {
      return store.isPayment(db, withdrawalId);
    },

    /** The withdrawal service's `finalized` hook: the payment's notice, in that transaction. */
    async finalized(tx: Transaction, final: FinalWithdrawal): Promise<void> {
      await store.markFinal(tx, final.withdrawalId, final.at, final.txHash);
    },
  };
}

export type PayService = ReturnType<typeof createPayService>;
