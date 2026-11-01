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

/**
 * The chains the Agent Explorer lists, by the slug in their public paths and page URLs
 * (/api/public/<slug>/..., /explorer/<slug>). Base is the default; Arc only where it is switched on.
 */
export type ExplorerChainSlug = 'base' | 'arc';

/** The explorer's public paths for one chain (ON_BASE_PATHS is Base's). */
export function onChainPaths(slug: ExplorerChainSlug) {
  return {
    /** The list, newest first: ?q= searches; ?before=<id> pages. */
    list: `/api/public/${slug}/agents`,
    /** Followed by `/<id>` (digits only; anything else is 404): one agent's passport. */
    passport: `/api/public/${slug}/agents`,
    /** The highest ids with a final Central City rating (up to ON_BASE_RATED_MAX), newest first. */
    rated: `/api/public/${slug}/rated`,
  } as const;
}

export const ON_BASE_PATHS = onChainPaths('base');

/** How many rated Base IDs GET ON_BASE_PATHS.rated answers at most. */
export const ON_BASE_RATED_MAX = 10;

/** Rows per page of the list (fixed, so every page is one edge-cache entry). */
export const ON_BASE_PAGE_SIZE = 50;
/** The longest search text accepted (a 66-character transaction hash fits). */
export const ON_BASE_QUERY_MAX = 80;

/**
 * A name search needs a run of this many letters or digits: the public name index (trigrams)
 * cannot serve a shorter pattern, nor one of only punctuation or single letters ('%%', 'a b').
 */
export const ON_BASE_NAME_MIN = 3;

/**
 * Why a search text is read as less than it may look like:
 *   name-min     no run of ON_BASE_NAME_MIN letters or digits, so it is not read as a name;
 *   hex-partial  0x and hex, but neither a wallet (40 hex) nor a transaction (64 hex).
 * A text with no other reading is refused (400, code ON_BASE_UNSUPPORTED_CODE, `reading`, the
 * message below), never answered as an empty list. With one (a 2-digit Base ID), the list
 * answers that reading and says `notice: 'name-min'`.
 */
export type OnBaseSearchNotice = 'name-min' | 'hex-partial';
export const ON_BASE_UNSUPPORTED_CODE = 'unsupported_reading';
export const ON_BASE_SEARCH_NOTICES: Record<OnBaseSearchNotice, string> = {
  'name-min': `Type at least ${ON_BASE_NAME_MIN} characters to search names`,
  'hex-partial':
    'Type a whole wallet address (0x and 40 hex characters) or transaction hash (0x and 64)',
};

/**
 * Whether the list searches by transaction hash. Not yet: none of the transaction columns is
 * indexed (each such search read every registration), and their indexes (migration 291) are built
 * before the change that turns this on. Until then a transaction hash (0x and 64 hex, which has
 * no other reading) is answered at once with 503, code ON_BASE_TX_SEARCH_UNAVAILABLE_CODE and
 * the message below; never an empty list. Transactions are searched in Service calls meanwhile.
 */
export const ON_BASE_TX_SEARCH_AVAILABLE = false;
export const ON_BASE_TX_SEARCH_UNAVAILABLE_CODE = 'tx_search_unavailable';
export const ON_BASE_TX_SEARCH_UNAVAILABLE_MESSAGE =
  'Search by transaction hash is temporarily unavailable. Paid calls can be searched by transaction in Service calls.';

/** Whether this text is a transaction hash the list cannot search now (ON_BASE_TX_SEARCH_AVAILABLE). */
export function onBaseTxSearchUnavailable(raw: string): boolean {
  return !ON_BASE_TX_SEARCH_AVAILABLE && onBaseSearchReadings(raw).txHash !== null;
}

/** What a search text can mean (server/base/explorer/store.ts parseQuery builds its SQL on it). */
export interface OnBaseSearchReadings {
  /** The text as searched: control characters as spaces, trimmed. */
  text: string;
  baseId: string | null;
  /** A short id, alone or as a passport number (CC-<short id>); short ids are case-sensitive. */
  shortId: string | null;
  /** An agent wallet, lower case. */
  address: string | null;
  /** A transaction of the registration (its mint or its hand-over), lower case. */
  txHash: string | null;
  /** Whether the text is also read as a public name. */
  name: boolean;
  notice: OnBaseSearchNotice | null;
}

const NAME_RUN = new RegExp(`[\\p{L}\\p{N}]{${ON_BASE_NAME_MIN}}`, 'u');

export function onBaseSearchReadings(raw: string): OnBaseSearchReadings {
  // Control characters become spaces: Postgres refuses a NUL in the name pattern (a 500).
  const text = raw.replace(/\p{Cc}/gu, ' ').trim();
  const hex = /^0x[0-9a-f]*$/i.test(text);
  const name = !hex && NAME_RUN.test(text);
  return {
    text,
    baseId: /^#?(0|[1-9][0-9]{0,77})$/.exec(text)?.[1] ?? null,
    shortId: /^(?:[Cc][Cc]-)?([0-9A-Za-z]{6})$/.exec(text)?.[1] ?? null,
    address: /^0x[0-9a-fA-F]{40}$/.test(text) ? text.toLowerCase() : null,
    txHash: /^0x[0-9a-fA-F]{64}$/.test(text) ? text.toLowerCase() : null,
    name,
    notice: hex
      ? /^0x([0-9a-f]{40}|[0-9a-f]{64})$/i.test(text)
        ? null
        : 'hex-partial'
      : !name && text.length > 0
        ? 'name-min'
        : null,
  };
}

/** The reason the list refuses this search text (no reading it can answer), else null. */
export function onBaseUnsupportedReading(raw: string): OnBaseSearchNotice | null {
  const r = onBaseSearchReadings(raw);
  return r.notice && !r.baseId && !r.shortId && !r.address && !r.txHash && !r.name
    ? r.notice
    : null;
}
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
   * Rated agents: distinct Base IDs with at least one rating sent through Central City whose
   * operation is FINAL on Base (server/base/explorer/store.ts RATED_AGENTS_SQL), from Central
   * City's own records, every rater counted. Shared by every instance and counted about every
   * 30 s; null only when it could not be counted yet.
   */
  ratedAgents: number | null;
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
  /**
   * Only on a search with a name reading while the public name index is still being built: names
   * may be missing from the rows (a Base ID, passport number, address or transaction is always
   * found). Absent when the answer is complete.
   */
  incomplete?: true;
  /**
   * Only on a search whose text was answered by its exact readings alone because it is too short
   * to be a name ('12': the Base ID 12, not names containing 12). See OnBaseSearchNotice.
   */
  notice?: 'name-min';
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
  /**
   * Entries on Base (revoked ones not counted); 0 when not read. Above the server's read bound
   * (server/base/explorer/head.ts) it is the registry's count, revoked ones included.
   */
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
  /**
   * true when the feedback was read from Base but Central City's own records (who the raters are,
   * their names) could not be read in time: score is then null and entries carry no names. Not
   * read, which is never the same as no score. Absent otherwise.
   */
  scoreUnread?: true;
  /**
   * true when not every feedback entry on Base was read (server/base/explorer/head.ts: past its
   * read bound, an answer too large to read whole, or a client list that could not be read, when
   * only the rater wallets in Central City's records are read). The score still reads every rater
   * wallet on its own. Absent otherwise.
   */
  bounded?: true;
  /**
   * How many Central City rater wallets have feedback for the agent whose latest rating could not
   * be read (head.ts RATER_ENTRIES_MAX), so the score leaves them out. Absent when none.
   */
  ratersSkipped?: number;
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
