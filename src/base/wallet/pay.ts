/*
 * Base Pay in the browser (Operation Base Pay P1; server: server/base/pay). An owner pays another
 * Central City agent on Base in USDC from one of their own agents' wallets. A payment is a W2 owner
 * withdrawal to the recipient agent's wallet, so everything withdraw.ts checks before signing is
 * checked here too, and the recipient on top. Nothing is signed unless:
 *
 *   - the server's recipient is a Central City agent on this wallet's network, in its canonical
 *     registry, and is exactly the passport, Base ID or wallet typed here;
 *   - this browser reads Base itself and ownerOf(Base ID) is that same wallet (a name never decides);
 *   - the operation decodes to one USDC transfer of exactly the amount, to exactly that wallet.
 *
 * The note is display only: never signed, never on Base.
 */
import { getAddress, isAddress, type Hex } from 'viem';
import { api, ApiError } from '../../api';
import { BASE_MAINNET, BASE_NETWORKS } from '../../../shared/base/chains';
import {
  parseRecipient,
  PAY_INCOMING_PAGE_MAX,
  PAY_MIN_AMOUNT,
  PAY_NOTE_MAX,
  PAY_PATHS,
  PAY_RECIPIENT_TTL_MS,
  type PayByAgent,
  type PayByAgentList,
  type PayIncoming,
  type PayIncomingPage,
  type PayState,
  type PayRecipient,
  type PayRecipientAgent,
  type PayToAgent,
  type RecipientQuery,
} from '../../../shared/base/pay';
import { WITHDRAWAL_CHAIN_ID } from '../../../shared/base/withdraw';
import type { SponsorAllowlist } from '../../../shared/base/paymasters';
import { pageOutOfDate, STALE_PAGE } from '../stalePage';
import {
  checkOperation,
  WithdrawalCheckError,
  type LaneExpectation,
  type SigningRequest,
} from './withdraw';

export type { PayByAgent, PayIncoming, PayRecipientAgent };

/**
 * An incoming row as the browser reads it. `safe`: the server's word that Base settled it at its
 * safe head ('final', or 'included' in a block Base already made safe); an older server sends none.
 */
export type PayIncomingRow = PayIncoming & { safe?: boolean };

/** The recipient can't be paid (or checked) as it is; the message says why. Nothing was signed. */
export class RecipientError extends Error {}

export const NOT_A_RECIPIENT =
  'Type a Base ID, a passport link (centralcity.ai/a/…) or a passport number (CC-…).';
/** Shown with every recipient: what the check on Base does and doesn't say (shared/base/pay.ts). */
export const POINT_IN_TIME =
  'This confirms the recipient at that moment, not when the payment lands.';
export const ONLY_AGENTS =
  'This isn’t a Central City agent. Pay is only for Central City agents on Base; use Withdraw to send anywhere else.';
const CHANGED = 'This agent’s wallet on Base changed since it was checked. Nothing was signed.';

const REGISTRY =
  BASE_NETWORKS[WITHDRAWAL_CHAIN_ID as keyof typeof BASE_NETWORKS]?.contracts.identityRegistry;
const BASE_ID = /^(0|[1-9][0-9]{0,77})$/;
const SHORT = /^[0-9A-Za-z]{6}$/;
const BLOCK_HASH = /^0x[0-9a-fA-F]{64}$/;
/**
 * Control and format characters (bidirectional marks, zero-width ones) and line or paragraph
 * separators: anything that could disguise a note or break its one line. At least the server rule.
 */
const UNSAFE_NOTE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const strictAddress = (value: unknown): `0x${string}` | null =>
  typeof value === 'string' &&
  /^0x[0-9a-fA-F]{40}$/.test(value) &&
  isAddress(value, { strict: true })
    ? getAddress(value)
    : null;

/** Why the typed text isn't a recipient Pay can look up, or null when it is one. */
export function recipientProblem(text: string): string | null {
  return parseRecipient(text).length ? null : NOT_A_RECIPIENT;
}

/** Why an amount (USDC base units) can't be paid, or null: at least PAY_MIN_AMOUNT (0.01 USDC). */
export function amountProblem(raw: bigint): string | null {
  return raw < PAY_MIN_AMOUNT ? 'The smallest payment is 0.01 USDC.' : null;
}

/** Why a note can't be sent, or null. As the server: one line, at most PAY_NOTE_MAX characters. */
export function noteProblem(note: string): string | null {
  const text = note.trim();
  if ([...text].length > PAY_NOTE_MAX) return `A note is at most ${PAY_NOTE_MAX} characters.`;
  if (UNSAFE_NOTE.test(text)) return 'A note is one line of plain text.';
  return null;
}

/**
 * The server's answer, checked: a Central City agent on this wallet's network and registry, that
 * is one of the readings of what was typed, with its evidence and an expiry still ahead.
 */
export function checkRecipient(
  answer: PayRecipient,
  readings: readonly RecipientQuery[],
  now: number,
): PayRecipientAgent {
  if (answer?.kind === 'address') throw new RecipientError(ONLY_AGENTS);
  if (answer?.kind !== 'central_city_agent' || answer.verification !== 'point_in_time')
    throw new RecipientError('The recipient couldn’t be read. Try again.');
  if (pageOutOfDate(answer.chainId)) throw new RecipientError(STALE_PAGE);
  if (answer.chainId !== WITHDRAWAL_CHAIN_ID || !REGISTRY || !same(answer.registry, REGISTRY))
    throw new RecipientError('This agent isn’t registered on this wallet’s network.');
  const wallet = strictAddress(answer.wallet);
  const { verified } = answer;
  if (
    !wallet ||
    !BASE_ID.test(answer.baseId) ||
    !SHORT.test(answer.short) ||
    !Number.isSafeInteger(verified?.block) ||
    verified.block <= 0 ||
    !BLOCK_HASH.test(verified.blockHash) ||
    !Number.isFinite(verified.at) ||
    answer.expiresAt !== verified.at + PAY_RECIPIENT_TTL_MS ||
    typeof answer.lookupId !== 'string' ||
    !answer.lookupId ||
    answer.lookupId.length > 256
  )
    throw new RecipientError('The recipient couldn’t be read. Try again.');
  const asked = readings.some((reading) =>
    reading.kind === 'baseId'
      ? reading.baseId === answer.baseId
      : reading.kind === 'short'
        ? reading.short === answer.short
        : same(reading.address, wallet),
  );
  if (!asked) throw new RecipientError('The answer isn’t the agent that was typed. Try again.');
  if (answer.expiresAt <= now)
    throw new RecipientError('That check on Base is too old. Look the recipient up again.');
  return { ...answer, wallet, name: typeof answer.name === 'string' ? answer.name : '' };
}

/** Who a payment would go to: looked up by the server on Base, then checked here. */
export async function lookupRecipient(text: string): Promise<PayRecipientAgent> {
  const readings = parseRecipient(text);
  if (!readings.length) throw new RecipientError(NOT_A_RECIPIENT);
  const answer = await api<PayRecipient>(
    `${PAY_PATHS.recipient}?q=${encodeURIComponent(text.trim())}`,
    undefined,
    'GET',
  );
  return checkRecipient(answer, readings, Date.now());
}

/* ---------- this browser's own read of Base ---------- */

/**
 * Base's public endpoint, the one this site may reach (CSP connect-src). The same as Verify's
 * (src/verify/onBaseVerify.ts BASE_RPC; a test keeps them equal), kept here so Verify's code stays
 * in its own chunk, loaded only when someone verifies.
 */
export const PAY_BASE_RPC = 'https://mainnet.base.org';
const OWNER_OF = '0x6352211e';
const READ_TIMEOUT_MS = 8_000;

/**
 * ownerOf(Base ID) in the recipient's registry, read from Base by this browser at one block: plain
 * JSON-RPC to Base's public endpoint, no keys. Base mainnet only (the one endpoint this site may
 * reach); on any other network, or when Base doesn't answer, it throws and nothing is signed.
 */
export async function ownerOnBase(
  recipient: Pick<PayRecipientAgent, 'baseId' | 'registry' | 'chainId'>,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ owner: `0x${string}` | null; block: number }> {
  if (recipient.chainId !== BASE_MAINNET)
    throw new RecipientError(
      'This browser can only check recipients on Base itself, so nothing is signed on this network.',
    );
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  const unreachable = () =>
    new RecipientError('Couldn’t check on Base. Nothing was signed. Try again in a moment.');
  async function rpc(method: string, params: unknown[]): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? READ_TIMEOUT_MS);
    try {
      const response = await send(PAY_BASE_RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: controller.signal,
      });
      const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
      if (body?.error) {
        // A revert is an answer: the Base ID has no owner (burned or never minted).
        if (/revert/i.test(String(body.error.message ?? ''))) return null;
        throw unreachable();
      }
      if (!response.ok || body?.result === undefined) throw unreachable();
      return body.result;
    } catch (error) {
      if (error instanceof RecipientError) throw error;
      throw unreachable();
    } finally {
      clearTimeout(timer);
    }
  }
  const head = await rpc('eth_blockNumber', []);
  if (typeof head !== 'string' || !/^0x[0-9a-f]+$/i.test(head)) throw unreachable();
  const block = Number(BigInt(head));
  const data = `${OWNER_OF}${BigInt(recipient.baseId).toString(16).padStart(64, '0')}`;
  const result = await rpc('eth_call', [{ to: recipient.registry, data }, head]);
  if (result === null) return { owner: null, block };
  if (typeof result !== 'string' || !/^0x0{24}[0-9a-f]{40}$/i.test(result)) throw unreachable();
  return { owner: getAddress(`0x${result.slice(-40)}`), block };
}

/** Base, read here, still has `recipient.wallet` as the owner of its Base ID; the block it read. */
export async function confirmOnBase(
  recipient: PayRecipientAgent,
  options?: { fetch?: typeof fetch; timeoutMs?: number },
): Promise<number> {
  const read = await ownerOnBase(recipient, options);
  if (!read.owner || !same(read.owner, recipient.wallet)) throw new RecipientError(CHANGED);
  return read.block;
}

/* ---------- the payment ---------- */

/** The create answer: the withdrawal to sign, and the payment it carries. */
export interface PaySigningRequest extends SigningRequest {
  payment: { paymentId: string; recipient: PayRecipient; note: string | null };
}

export const paymentsPath = (agentId: string) =>
  PAY_PATHS.payments.replace(':agentId', encodeURIComponent(agentId));

/**
 * The payment's `to`: the lookup the screen showed and the owner confirmed, by its id only. The
 * server keeps what it answered under it and checks Base again before preparing; the browser then
 * checks the payment names that same Base ID and wallet (checkPayment).
 */
export const payTo = (recipient: PayRecipientAgent): PayToAgent => ({
  lookupId: recipient.lookupId,
});

export function createPayment(
  agentId: string,
  body: { idempotencyKey: string; to: PayToAgent; amount: string; note: string | null },
) {
  return api<PaySigningRequest>(paymentsPath(agentId), body);
}

/**
 * Checks a prepared payment before the owner is asked to sign, and returns the hash to sign: the
 * payment is to the recipient shown (Base ID and wallet), and the operation is one USDC transfer
 * of exactly `amount` (base units) to that wallet, from this wallet (withdraw.ts checkOperation).
 */
export function checkPayment(input: {
  request: PaySigningRequest;
  recipient: PayRecipientAgent;
  amount: string;
  wallet: string;
  /** The wallet's owner key and the paying agent: the wallet must be the one they make. */
  owner: string;
  agentId: string;
  sponsors?: SponsorAllowlist;
  /**
   * With lanes on (the request's `lanes: true`): which other operations on their way set the
   * wallet up (laneFor). The lane itself is always derived here from the request's own id.
   */
  lane?: Pick<LaneExpectation, 'deploying'>;
}): Hex {
  const { request, recipient } = input;
  const paid = request.payment?.recipient;
  if (
    paid?.kind !== 'central_city_agent' ||
    paid.baseId !== recipient.baseId ||
    !same(paid.wallet, recipient.wallet)
  )
    throw new WithdrawalCheckError('The payment isn’t to the agent shown.');
  return checkOperation({
    userOperation: request.userOperation,
    userOpHash: request.userOpHash,
    entryPoint: request.entryPoint,
    chainId: request.chainId,
    wallet: input.wallet,
    owner: input.owner,
    agentId: input.agentId,
    sponsors: input.sponsors,
    expected: { kind: 'withdraw', token: 'USDC', amount: input.amount, to: recipient.wallet },
    lanes: request.lanes === true,
    lane:
      request.lanes === true
        ? { withdrawalId: request.withdrawalId, deploying: input.lane?.deploying }
        : undefined,
  });
}

/**
 * The payments the agent made on its own (Base Pay P2), newest first, as recorded; null while the
 * read isn't there (404: wallets off, not this person's wallet). Rows of another shape are dropped.
 */
export async function readAgentPayments(agentId: string): Promise<PayByAgent[] | null> {
  let body: PayByAgentList;
  try {
    body = await api<PayByAgentList>(
      PAY_PATHS.agentPayments.replace(':agentId', encodeURIComponent(agentId)),
      undefined,
      'GET',
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
  if (!Array.isArray(body?.payments)) return null;
  return body.payments.filter(
    (payment) =>
      payment?.by === 'agent' &&
      typeof payment.paymentId === 'string' &&
      ['pending', 'included', 'final', 'failed'].includes(payment.state) &&
      typeof payment.amount?.display === 'string' &&
      typeof payment.to?.wallet === 'string',
  );
}

/** Payments to wallets the signed-in person owns, changed since `since` (ms); 'final' is paid. */
/** One page of payments to wallets the person owns, oldest change first, after `cursor`. */
export const readIncomingPage = (cursor: string | null, limit = PAY_INCOMING_PAGE_MAX) =>
  api<PayIncomingPage>(
    `${PAY_PATHS.incoming}?${new URLSearchParams({
      ...(cursor ? { after: cursor } : {}),
      limit: String(limit),
    })}`,
    undefined,
    'GET',
  );

/**
 * Pages per refresh. The rest waits for the next refresh: the incoming bucket is 30 reads a
 * minute per person (server/base/pay/routes.ts PAY_RATES), shared by every open wallet screen.
 */
export const INCOMING_PAGES_PER_REFRESH = 4;

/**
 * Payments to wallets the person owns, kept up to date. The server pages oldest change first and
 * never skips one, so the feed keeps its cursor and every payment's latest state across
 * refreshes: each refresh continues where the last stopped (at most INCOMING_PAGES_PER_REFRESH
 * pages), nothing read is ever dropped, and `more` says a backlog is still waiting. One feed per
 * screen that shows it; a new one (another agent, another sign-in) starts from the beginning.
 */
export function createIncomingFeed(read: typeof readIncomingPage = readIncomingPage) {
  const latest = new Map<string, PayIncomingRow>();
  let cursor: string | null = null;
  return {
    async refresh(): Promise<{ payments: PayIncomingRow[]; more: boolean }> {
      let more = false;
      for (let page = 0; page < INCOMING_PAGES_PER_REFRESH; page += 1) {
        const answer: PayIncomingPage = await read(cursor);
        if (!Array.isArray(answer?.payments)) break;
        for (const payment of answer.payments) latest.set(payment.paymentId, payment);
        // Only a cursor that moves on is kept; the same one again means nothing more for now.
        const moved = typeof answer.cursor === 'string' && answer.cursor !== cursor;
        if (moved) cursor = answer.cursor;
        more = answer.hasMore === true && moved;
        if (!more) break;
      }
      return { payments: [...latest.values()], more };
    },
  };
}

export const RECEIVED_HEADLINE = 'Received · awaiting finality';
export const RECEIVED_NOTE = 'Final in about 15 minutes.';
export const RECEIVED_FINAL = 'Received ✓';

/** How an incoming payment's row reads, from the server's latest `state` and `safe`. */
export interface ReceivedStatus {
  /**
   * 'received': included in a block Base settled at its safe head, not final yet. The money
   * arrived, but nothing says paid or final before Base does.
   */
  phase: 'on_its_way' | 'received' | 'final' | 'failed';
  /** The state in words on the row; null keeps the row as it was before `safe`. */
  headline: string | null;
  /** A quiet line under it. */
  note: string | null;
  /** The row's "on its way, not paid until final" (as before `safe`). */
  onItsWay: boolean;
  /** 'in': counted (+, green), only once final; 'plain': arrived, not final; 'off': not money yet. */
  amount: 'in' | 'plain' | 'off';
}

/**
 * Always from the row as the server answers it now, never from an earlier read: a row no longer
 * safe, or in another state, reads as that, and nothing here ever turns into a failure on its own.
 * 'received' needs exactly 'included' and `safe` true; without `safe` (an older server) nothing
 * differs from before it, apart from final's "Received ✓".
 */
export function receivedStatus(payment: { state: PayState; safe?: unknown }): ReceivedStatus {
  switch (payment.state) {
    case 'final':
      return {
        phase: 'final',
        headline: RECEIVED_FINAL,
        note: null,
        onItsWay: false,
        amount: 'in',
      };
    case 'failed':
      return { phase: 'failed', headline: null, note: null, onItsWay: false, amount: 'off' };
    case 'included':
      if (payment.safe === true)
        return {
          phase: 'received',
          headline: RECEIVED_HEADLINE,
          note: RECEIVED_NOTE,
          onItsWay: false,
          amount: 'plain',
        };
      return { phase: 'on_its_way', headline: null, note: null, onItsWay: true, amount: 'off' };
    case 'pending':
      return { phase: 'on_its_way', headline: null, note: null, onItsWay: true, amount: 'off' };
    default:
      // A state this browser doesn't know yet: as before, never paid, never "on its way".
      return { phase: 'on_its_way', headline: null, note: null, onItsWay: false, amount: 'off' };
  }
}
