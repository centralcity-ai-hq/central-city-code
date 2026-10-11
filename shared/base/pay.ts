/*
 * Operation Base Pay (P1): an owner pays another Central City Base agent in USDC, by its passport.
 * What the browser and the server share: how a recipient may be written, the limits and the JSON
 * shapes of the pay routes (server/base/pay). Browser-safe: no Node imports.
 *
 * Reading what someone typed or pasted never fetches anything: a passport link is matched as text,
 * only on centralcity.ai, and every other link, host or form is refused. Accepted, after trimming
 * the whitespace around it:
 *
 *   a Base ID                 digits, canonical (no leading zero): "12345"
 *   a passport link           https://centralcity.ai/a/<short>, also without "https://"; the scheme
 *                             and host in any case, the path exactly /a/<short>; nothing after it
 *   a short id                <short>: 6 characters, case-sensitive
 *   a passport number         CC-<short>, exactly as the passport prints it ("CC-" in capitals)
 *   an address                0x + 40 hex, all lower case or with a valid checksum (EIP-55)
 *
 * CC-<short> is ONLY a canonical alias of <short>: it is read as the very same short-id reading the
 * passport link gives (shortReading below), resolves through the same records to the same unique
 * Base ID and wallet, is checked on Base the same way, and the answer is byte for byte the answer
 * for <short>. It is never a separate identity, never a trust signal, and the answer never says
 * which form was typed. (A bare all-digit <short> also reads as a Base ID; the server answers only
 * when exactly one reading is a Central City agent. CC-<short> and the link have only the one.)
 *
 * Interim rule (fail closed): a wallet receives or sends a payment only when it is READY, i.e. ALL
 * of: it belongs to an owner account (base_wallets.owner_account_id set); its owner address is that
 * account's vault owner key; its recipe is exactly [vault owner key, SpendPermissionManager] at the
 * agent's account index and derives to its address; and that vault's backup is confirmed. Agents
 * registered on Base before wallets existed hold their Base ID in an identity wallet owned by the
 * address typed at registration, with no account: nothing could be withdrawn from it and nobody
 * could read what it receives. The lookup and the check right before a payment is prepared answer
 * 409 recipient_not_ready ("This agent can't receive payments yet."); a payer whose wallet is not
 * ready gets 409 payer_not_ready (no owner account at all: 404, as any wallet not one's own). The
 * rule only gates starting a payment: payments already sent are read and tracked to final.
 *
 * Verification is POINT IN TIME: a recipient answer confirms that, at one Base block, the Base ID was
 * held by that agent's wallet. It says nothing about the moment the payment lands, and nothing here
 * claims so. The browser shows the block and time (verification 'point_in_time') and the person
 * confirms. The server keeps what it showed (the lookup, named by the answer's random lookupId, for
 * the account that looked up, until expiresAt); the payment request carries only that lookupId
 * (PayToAgent), never the evidence itself. Unknown, another account's or expired: 409
 * recipient_expired (look it up again); a fresh check right before preparing that differs from the
 * lookup: 409 recipient_changed.
 *
 * A payment is at least PAY_MIN_AMOUNT (0.01 USDC; less is 400 amount_too_small). Its recipient's
 * owner reads it at once, by state, oldest change first (GET incoming ?after=<cursor>&limit=<n>):
 * every answer carries a cursor and hasMore, and paging never skips a change. The note is shown
 * only once the payment is final.
 */
import { getAddress, isAddress } from 'viem';

export const PAY_PATHS = {
  /** GET ?q=<what was typed>: who a payment would go to, checked on Base at one block. */
  recipient: '/api/base/pay/recipient',
  /** GET ?after=<cursor>&limit=<n>: payments to wallets the person owns, by state, oldest first. */
  incoming: '/api/base/pay/incoming',
  /** POST under an agent: /api/base/agents/:agentId/wallet/payments. */
  payments: '/api/base/agents/:agentId/wallet/payments',
  /** GET under an agent: the payments it made on its own, newest first (PayByAgent). */
  agentPayments: '/api/base/agents/:agentId/wallet/agent-payments',
} as const;

/** The most payments GET agentPayments answers (the newest). */
export const PAY_BY_AGENT_MAX = 20;

/** The longest note, in characters (Unicode code points). Display only. */
export const PAY_NOTE_MAX = 140;
/** The longest text a recipient query may be. */
export const PAY_QUERY_MAX = 128;
/** How long a recipient checked on Base may be confirmed; after it, look it up again. */
export const PAY_RECIPIENT_TTL_MS = 5 * 60_000;
/** The smallest payment: 0.01 USDC in base units (6 decimals). */
export const PAY_MIN_AMOUNT = 10_000n;
/** The most payments one incoming page holds (and its default). */
export const PAY_INCOMING_PAGE_MAX = 50;
/** The passport link origin (shared/base/short-id.ts SHORT_URI_ORIGIN, kept equal by a test). */
export const PAY_PASSPORT_HOST = 'centralcity.ai';

export type RecipientQuery =
  | { kind: 'baseId'; baseId: string }
  | { kind: 'short'; short: string }
  /** Checksummed. */
  | { kind: 'address'; address: string };

const BASE_ID = /^(0|[1-9][0-9]{0,77})$/;
const SHORT = /^[0-9A-Za-z]{6}$/;
const PASSPORT_NUMBER = /^CC-([0-9A-Za-z]{6})$/;
/** scheme (optional), authority, then exactly /a/<short>. Checked further below. */
const PASSPORT_LINK = /^(?:([A-Za-z][A-Za-z0-9+.-]*):\/\/)?([^/\s]+)\/a\/([0-9A-Za-z]{6})$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The one short-id reading: the bare short id, CC-<short> and the passport link all produce it. */
const shortReading = (short: string): RecipientQuery => ({ kind: 'short', short });

/**
 * Every reading of the text as a recipient, or [] when it is none of the accepted forms. Pure: no
 * lookup and no network.
 */
export function parseRecipient(text: string): RecipientQuery[] {
  if (typeof text !== 'string' || text.length > PAY_QUERY_MAX) return [];
  const q = text.trim();
  if (ADDRESS.test(q))
    // A mixed-case address must carry a valid checksum; all lower case has none to check.
    return isAddress(q, { strict: true }) ? [{ kind: 'address', address: getAddress(q) }] : [];
  const number = PASSPORT_NUMBER.exec(q);
  if (number) return [shortReading(number[1])];
  const link = PASSPORT_LINK.exec(q);
  if (link)
    return (link[1] === undefined || link[1].toLowerCase() === 'https') &&
      link[2].toLowerCase() === PAY_PASSPORT_HOST
      ? [shortReading(link[3])]
      : [];
  const readings: RecipientQuery[] = [];
  if (BASE_ID.test(q)) readings.push({ kind: 'baseId', baseId: q });
  if (SHORT.test(q)) readings.push(shortReading(q));
  return readings;
}

/**
 * A recipient that is a Central City agent, checked on Base at one block. A point-in-time check:
 * it confirms the recipient at that block, not when the payment lands.
 */
export interface PayRecipientAgent {
  kind: 'central_city_agent';
  /** Its ERC-8004 id in the canonical registry of the wallet network (decimal). */
  baseId: string;
  /** Its short id (the passport number without "CC-"; case-sensitive). */
  short: string;
  /** Display only: its public card name, '' while the card is not public. Never proof of anything. */
  name: string;
  /** The agent's own wallet (checksummed): ownerOf(baseId) at `verified`, and where USDC goes. */
  wallet: string;
  registry: string;
  chainId: number;
  /**
   * The screen discloses it: "Checked on Base at block N, HH:MM. This confirms the recipient at
   * that moment, not when the payment lands."
   */
  verification: 'point_in_time';
  /**
   * Names what was shown, kept by the server for the account that looked up until expiresAt; a
   * payment to this recipient carries only this. The same lookup at the same block answers the
   * same id.
   */
  lookupId: string;
  /** The one block Base was read at, and when (ms epoch, the server's clock). */
  verified: { block: number; blockHash: string; at: number };
  /** verified.at + PAY_RECIPIENT_TTL_MS: after it a payment is refused (409 recipient_expired). */
  expiresAt: number;
}

/** Any other address, only when the server allows paying one (off by default). Nothing checked. */
export interface PayRecipientAddress {
  kind: 'address';
  address: string;
  verification: 'none';
  warning: 'not_central_city_agent';
}

export type PayRecipient = PayRecipientAgent | PayRecipientAddress;

/**
 * POST .../wallet/payments `to` for an agent: the recipient answer's lookupId, nothing else. What
 * it showed is the server's own record; nothing the browser echoes back counts as evidence.
 */
export interface PayToAgent {
  lookupId: string;
}

/** POST .../wallet/payments `to`: an agent as confirmed, or (setting on) any other address. */
export type PayTo = PayToAgent | { address: string };

export interface PayAmount {
  raw: string;
  decimals: number;
  display: string;
}

/**
 * Where a sent payment is, as its recipient's owner sees it. Only 'final' is paid; 'pending' and
 * 'included' are on their way (never funds to count on); 'failed' did not go through (reverted, or
 * replaced by the payer's cancel).
 */
export type PayState = 'pending' | 'included' | 'final' | 'failed';

/** A payment to a wallet the signed-in person owns, once the payer signed it. */
export interface PayIncoming {
  paymentId: string;
  /** The withdrawal the payment went out as (its operation and transaction). */
  withdrawalId: string;
  state: PayState;
  from: {
    /** The paying agent's public card name, '' while not public. Display only. */
    name: string;
    /** Its passport when it is a Central City agent on the wallet network, else null. */
    baseId: string | null;
    short: string | null;
    wallet: string;
  };
  /** The recipient agent; its name is its public card name ('' while not public). */
  to: { agentId: string; name: string; baseId: string; short: string; wallet: string };
  token: 'USDC';
  amount: PayAmount;
  /** Display only, as the payer wrote it; null until the payment is final. */
  note: string | null;
  /**
   * final: "<payer> paid <agent> 2.5 USDC"; pending / included: "<payer> is sending <agent> 2.5
   * USDC"; failed: "<payer>'s 2.5 USDC payment to <agent> didn't go through".
   */
  text: string;
  txHash: string | null;
  explorerUrl: string | null;
  /** When the payer signed it (ms epoch). */
  sentAt: number;
  /** The last change of state (ms epoch); ?since= compares with it. */
  updatedAt: number;
  /** When it became final; null until then. */
  finalAt: number | null;
  /**
   * Settled at Base's safe head: final, or in a block Base proved settled there and not reverted
   * (the same proof as `safe` on the payer's withdrawal read). It can no longer be undone in
   * practice; it is still not "paid" until final. False whenever Base has not proven it. Becoming
   * safe is a change of its own: the payment comes again after the cursor.
   */
  safe: boolean;
}

/**
 * A payment an agent made on its own, from its own wallet within its spending limit (Base Pay P2),
 * as its wallet's owner account reads it. Only rows that exist: nothing is read from Base. The
 * state is as last recorded; only 'final' is paid. The recipient is named from Central City's
 * confirmed registration records of its wallet (name display only, '' while not public); a
 * wallet they no longer name has null agentId, baseId and short.
 */
export interface PayByAgent {
  paymentId: string;
  /** Who paid: the agent itself (the owner's own payments are withdrawals, not listed here). */
  by: 'agent';
  state: PayState;
  to: {
    agentId: string | null;
    name: string;
    baseId: string | null;
    short: string | null;
    wallet: string;
  };
  token: 'USDC';
  amount: PayAmount;
  /** Recorded once its operation's receipt was; null until then. */
  txHash: string | null;
  explorerUrl: string | null;
  /** When the payment was recorded, and its last recorded change (ms epoch). */
  createdAt: number;
  updatedAt: number;
}

/** GET agentPayments: the agent's own payments, newest first, at most PAY_BY_AGENT_MAX. */
export interface PayByAgentList {
  payments: PayByAgent[];
}

/** GET incoming: a page, oldest change first. Pass `cursor` as ?after= for the next one. */
export interface PayIncomingPage {
  payments: PayIncoming[];
  /** Where this page ended (null before anything was ever returned). */
  cursor: string | null;
  /** More changes wait after this page: ask again right away. */
  hasMore: boolean;
}
