/*
 * The "On Base" view of the Agent Explorer: the JSON the server's public routes send
 * (server/base/explorer), in the shape the explorer's client module reads (src/verify/onBaseData.ts
 * on the UI side). Browser-safe: no Node imports.
 *
 * Every listed agent is a registration Central City sent itself and whose mint it has seen on
 * Base: an ERC-8004 identity minted to the agent's own registration (spender) smart account
 * through an ERC-4337 bundler, then handed over to the agent's own wallet
 * (server/base/identity/service.ts). On-chain values (ids, addresses, transactions, blocks) can be
 * re-read from Base; names, statuses and times are Central City's own records and metadata, never
 * proven on chain. Every count is a number of registered agents, never users or adoption.
 */
import type { CityScore } from './rating-score.js';

export const ON_BASE_PATHS = {
  /** The list, newest first: ?q= searches; ?before=<baseId> pages. */
  list: '/api/public/base/agents',
  /** Followed by `/<baseId>` (digits only; anything else is 404): one agent's passport. */
  passport: '/api/public/base/agents',
} as const;

/** Rows per page of the list (fixed, so every page is one edge-cache entry). */
export const ON_BASE_PAGE_SIZE = 50;
/** The longest search text accepted (a 66-character transaction hash fits). */
export const ON_BASE_QUERY_MAX = 80;
/** The on-chain agent URI origin (shared/base/short-id.ts SHORT_URI_ORIGIN, kept equal by a test). */
export const AGENT_URI_ORIGIN = 'https://centralcity.ai';

/**
 * The public JSON-RPC endpoint the visitor's browser verifies against (CORS-enabled for
 * centralcity.ai; listed in the Content-Security-Policy's connect-src).
 */
export const PUBLIC_BASE_RPC = 'https://mainnet.base.org';

/** One registered agent, as the list shows it. Numbers that can exceed 2^53 are strings. */
export interface OnBaseRow {
  /** The ERC-8004 agent id in the Identity Registry (decimal). On chain. */
  baseId: string;
  /**
   * The agent's display name from its public card: Central City metadata, not on chain. An empty
   * string when the card is not public (for example a revoked agent).
   */
  name: string;
  /**
   * ownerOf(baseId) on Base as the server read it at totals.readAtBlock (normally the agent's own
   * wallet after the hand-over), checksummed; the zero address when the registry reports no
   * owner. When Base does not answer: the server's last read for that id, else Central City's
   * record; readAt then shows how old the answer is. Never the person's own wallet.
   */
  owner: string;
  /** Central City's record: final (both steps final on Base and checked) or finalizing. */
  status: 'final' | 'finalizing';
  /** Finalizing only: when Central City first saw the mint on Base (ms epoch). */
  finalizingSince?: number;
  /**
   * The agent's 6-character short id (base_short_ids): its tokenURI on Base is
   * https://centralcity.ai/a/<short>. Never a Base ID, even when it is all digits.
   */
  short: string;
  /**
   * The transaction that minted the id, from Central City's records: a hint for Verify, which
   * proves the mint from its receipt (ERC-4337: tx.from is a bundler, not Central City). Absent
   * when the records do not know it for certain (some rows from before the mint was kept); never
   * another transaction in its place.
   */
  mintTx?: string;
}

export interface OnBaseTotals {
  /** Registered agents on Base now (final and finalizing), whose mint the server has seen. */
  onBase: number;
  /** Of those, first seen on Base in the last 24 hours. */
  new24h: number;
  finalizingNow: number;
  /**
   * The Base block the answer's owners were read at and when (ms epoch, the server's clock): the
   * oldest read in the answer, with its true time, also when a later read failed. null only when
   * the server has neither read Base nor stored any evidence yet.
   */
  readAtBlock: number | null;
  readAt: number | null;
  /** When the server built this answer (ms epoch); servedAt - readAt is the server's own lag. */
  servedAt: number;
}

/**
 * A row of the list: an OnBaseRow and its Central City score from Central City's own records. The
 * score is the average (shared/base/rating-score.ts averageOf) of the latest rating each Central
 * City rater wallet sent this agent through Central City (server/base/rate) whose operation is
 * FINAL on Base; null when none counts. The list reads no feedback from Base: the passport's score
 * (OnBaseReputation.score, read from Base) is the authority, and Verify checks that one.
 */
export interface OnBaseListRow extends OnBaseRow {
  score: CityScore | null;
}

export interface OnBaseList {
  rows: OnBaseListRow[];
  totals: OnBaseTotals;
  /** The canonical ERC-8004 Identity Registry (shared/base/chains.ts). */
  registry: string;
  /** Pass as ?before= for the next (older) page; null on the last page. */
  nextBefore: string | null;
}

export interface OnBasePassport extends OnBaseRow {
  registry: string;
  /** The agent's own wallet, from Central City's records (owner equals it after the hand-over). */
  agentWallet: string;
  /**
   * The agent's own registration smart account that received the mint (Transfer from 0x0) and
   * handed it over; its key is held for that agent. There is no single Central City signer.
   */
  mintAccount: string;
  /** When Central City first saw the mint on Base (ms epoch). */
  registeredAt: number;
  /** The same transaction as mintTx, and absent with it. */
  registrationTx?: string;
  /**
   * Final: the block of the last registration step (the hand-over, else the mint) and when
   * Central City confirmed it final (ms epoch). block is null for rows from before blocks were
   * kept. null while finalizing.
   */
  final: { block: number | null; at: number } | null;
  /** The agent's feedback in the ERC-8004 Reputation Registry, as the server read it. */
  reputation: OnBaseReputation;
}

/** The most feedback entries one passport lists (count still says how many there are). */
export const ON_BASE_REPUTATION_MAX = 50;

/**
 * One feedback entry, as ReputationRegistry.readAllFeedback returns it (revoked ones left out).
 * Anyone but the agent's owner and operators can give feedback, so only entries from Central City's
 * own listed agents carry a name and their tags; anyone else is an address and a score.
 */
export interface OnBaseFeedback {
  /** The address that gave it (the sender of giveFeedback). */
  client: string;
  /** Its index for that client (the registry counts from 1). */
  index: number;
  /** One of Central City's listed agents when the client is its own smart account; else null. */
  from: { name: string; baseId: string } | null;
  /** value / 10^valueDecimals, exact, as a decimal string ("1", "-0.5", "87.25"). */
  score: string;
  /** tag1 and tag2 when not empty: only for feedback from a listed agent, else always []. */
  tags: string[];
}

export interface OnBaseReputation {
  /**
   * The Base block the feedback was read at and when (ms epoch, the server's clock); both null
   * when the server could not read it (no chain reader, or Base did not answer): not read, which
   * is never the same as no feedback.
   */
  readAtBlock: number | null;
  readAt: number | null;
  /** Entries on Base (revoked ones not counted); 0 when not read. */
  count: number;
  /**
   * At most ON_BASE_REPUTATION_MAX entries: the registry lists them per client in the order the
   * clients first gave feedback, oldest first; these are the last ones of that list, last first.
   */
  entries: OnBaseFeedback[];
  /**
   * The Central City score (shared/base/rating-score.ts) of every entry read, not only the ones
   * listed: the latest star rating of each Central City rater wallet. null when none counts, or
   * when not read.
   */
  score: CityScore | null;
  /**
   * The rater wallets the score counts (checksummed, one per rater, sorted): the own wallets of
   * Central City agents with a final Base ID, as Central City's records name them. Verify reads
   * these wallets' ratings from Base and recomputes the score; [] without a score.
   */
  scoredBy: string[];
}

/** A feedback value with its decimals as an exact decimal string: (-15n, 1) -> "-1.5". */
export function feedbackScore(value: bigint, decimals: number): string {
  const negative = value < 0n;
  let digits = (negative ? -value : value).toString();
  if (decimals > 0) {
    digits = digits.padStart(decimals + 1, '0');
    const fraction = digits.slice(-decimals).replace(/0+$/, '');
    digits = fraction ? `${digits.slice(0, -decimals)}.${fraction}` : digits.slice(0, -decimals);
  }
  return negative && digits !== '0' ? `-${digits}` : digits;
}
