import type { CityScore } from '../../shared/base/rating-score';
import { json } from './countLogClient';

/*
 * The Agent Explorer's "On Base" data (docs/design/on-base-mockup.html, approved by the product
 * owner 10 Oct 2026): Central City agents with a Base ID, read from Base by the server's public
 * routes, and the Verify that re-reads one of them from Base in the viewer's own browser. The
 * screens use only this module; the server side and the Base reads are behind the routes and
 * `verifyOnBase`.
 */

/** The public read routes (owned by the server side; one place to change them). */
export const ON_BASE_ROUTES = {
  /** The list, newest first: `?q=` searches Base ID, wallet or agent name; `?before=` pages. */
  list: '/api/public/base/agents',
  /** One agent's passport by Base ID (never by short id: short ids can be all digits). */
  passport: (baseId: string) => `/api/public/base/agents/${encodeURIComponent(baseId)}`,
} as const;

/** One registered agent on Base, as the list shows it. */
export type OnBaseRow = {
  /** The ERC-8004 agent id on Base (decimal string). */
  baseId: string;
  /**
   * The agent's public name; '' when its card is gone (removed or revoked: a Base agent's card
   * stays public once registration starts). Shown as "No public card".
   */
  name: string;
  /** The agent's avatar colour in the product, when the server shares it. */
  colour?: string;
  /** The wallet that owns the Base ID (0x…, checksummed). */
  owner: string;
  /** The passport's short id: /a/<short>, the address written in the Base ID's tokenURI. */
  short: string;
  /**
   * The mint transaction: a hint for Verify, which proves everything from its receipt. Absent when
   * Central City has no record of it (some agents registered before it was kept).
   */
  mintTx?: string;
  status: 'final' | 'finalizing';
  /** Finalizing: since when (ms epoch; the id was seen in a block). */
  finalizingSince?: number;
  /**
   * The list only: the Central City score from Central City's own records (the latest final
   * rating of each Central City rater sent through Central City); null or absent without one.
   * The passport's score, read from Base, is the one Verify checks.
   */
  score?: CityScore | null;
};

export type OnBaseTotals = {
  /** Registered agents on Base now (final and finalizing). */
  onBase: number;
  /** Registered in the last 24 hours. */
  new24h: number;
  finalizingNow: number;
  /**
   * The Base block the list was read at, and when (ms epoch, the server's clock): its oldest read.
   * null only before the server has read Base or stored any evidence.
   */
  readAtBlock: number | null;
  readAt: number | null;
  /** When the server answered (its clock): readAt and servedAt give its lag behind Base. */
  servedAt: number;
};

export type OnBaseList = {
  rows: OnBaseRow[];
  totals: OnBaseTotals;
  /** The ERC-8004 Identity Registry contract the Base IDs live in. */
  registry: string;
  /** The cursor for the next (older) page, or null at the end. */
  nextBefore: string | null;
};

/** One feedback entry in Base's Reputation Registry (shared/base/on-base.ts OnBaseFeedback). */
export type ReputationEntry = {
  /** The address that gave it. */
  client: string;
  /** Its index for that client (the registry counts from 1). */
  index: number;
  /** One of Central City's listed agents (name '' without a public card); else null. */
  from: { name: string; baseId: string } | null;
  /** The value with its decimals, exact ("1", "-0.5"). */
  score: string;
  /** Its tags; only ever for feedback from a listed agent. */
  tags: string[];
};

/** The agent's feedback on Base as the server read it; both read fields null when not read. */
export type Reputation = {
  readAtBlock: number | null;
  readAt: number | null;
  /** Every entry on Base (revoked ones not counted). */
  count: number;
  /** The last entries of the registry's list, last first (at most 50). */
  entries: ReputationEntry[];
  /**
   * The Central City score of every entry (shared/base/rating-score.ts): the latest star rating of
   * each Central City rater wallet; null when none counts. Absent from an older server.
   */
  score?: CityScore | null;
  /** The rater wallets the score counts, for Verify to read from Base; [] without a score. */
  scoredBy?: string[];
};

export type Passport = OnBaseRow & {
  registry: string;
  /** The agent's own smart account that minted the Base ID (its key is held for that agent). */
  mintAccount: string;
  agentWallet: string;
  /** The same transaction as mintTx; absent with it. */
  registrationTx?: string;
  registeredAt: number;
  /**
   * The block of its last registration step and when Central City confirmed it final; null while
   * finalizing. block is null for agents registered before blocks were kept.
   */
  final: { block: number | null; at: number } | null;
  reputation: Reputation;
};

/** One of Verify's checks: passed, failed, or not yet (finality) / not read (score). */
export type VerifyTick = { state: 'pass' | 'fail' | 'pending'; evidence: string };

/** What Verify found, read from Base in this browser (never from Central City). */
export type VerifyResult =
  | {
      kind: 'checked';
      owner: VerifyTick;
      uri: VerifyTick;
      registeredBy: VerifyTick;
      final: VerifyTick;
      /**
       * The passport's Central City score recomputed from Base's own feedback; only on a passport
       * that shows a score (the list has none to check).
       */
      score?: VerifyTick;
      /** The Base block it read at, and the public endpoint it asked. */
      block: number;
      rpc: string;
    }
  | { kind: 'unreachable' };

export const BASESCAN = 'https://basescan.org';
export const basescanAddress = (address: string) => `${BASESCAN}/address/${address}`;
export const basescanTx = (hash: string) => `${BASESCAN}/tx/${hash}`;
/** One Base ID's own page on Basescan (the registry's token). */
export const basescanToken = (registry: string, baseId: string) =>
  `${BASESCAN}/nft/${registry}/${baseId}`;
/** The passport's address: /a/<short id>, the same address the Base ID's tokenURI holds. */
export const passportPath = (short: string) => `/a/${short}`;
/** The Identity Registry's page on Basescan ("See the registry on Basescan"). */
export const basescanRegistry = (registry: string) => `${BASESCAN}/token/${registry}`;

/** "0xD522…2F03": a wallet shortened for rows; the full one is in the title and the copy. */
export const shortWallet = (address: string) =>
  address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;

/** The name a row shows: the public name, or "No public card" when the card is gone. */
export const shownName = (name: string) => name.trim() || 'No public card';
/** The avatar's letter: the name's first, none without a public card. */
export const initial = (name: string) => name.trim().charAt(0).toUpperCase();

/** Minutes a row has been finalizing (whole minutes, never negative). */
export const finalizingMinutes = (since: number | undefined, now: number) =>
  since === undefined ? null : Math.max(0, Math.floor((now - since) / 60_000));

/**
 * The facts a Verify checks: a result belongs to exactly these, and a refresh that changes any of
 * them (a new owner, the mint, final) makes an earlier result stale.
 */
export const verifyKey = (
  row: Pick<OnBaseRow, 'baseId' | 'owner' | 'short' | 'mintTx' | 'status'>,
) => [row.baseId, row.owner, row.short, row.mintTx ?? '', row.status].join('|');

/** Every tick of a result: the four checks, and the score's when there is one. */
export function ticks(result: Extract<VerifyResult, { kind: 'checked' }>) {
  return [result.owner, result.uri, result.registeredBy, result.final].concat(
    result.score ? [result.score] : [],
  );
}

/** Ticks that passed, out of ticks(result) (a pending finality isn't a pass). */
export function passed(result: Extract<VerifyResult, { kind: 'checked' }>) {
  return ticks(result).filter((tick) => tick.state === 'pass').length;
}

/**
 * What Verify needs to recompute a passport's score: its score, the rater wallets it names, the
 * rated agent's own wallet (never a rater of itself) and the block it was read at.
 */
export type ScoreClaim = {
  score: CityScore;
  scoredBy: string[];
  agentWallet: string;
  readAtBlock: number | null;
};

/**
 * The passport's score claim for Verify; null only without a score. A score that names no rater
 * wallets is still a claim: nothing on Base can back it, so Verify fails it.
 */
export function scoreClaim(
  passport: Pick<Passport, 'reputation' | 'agentWallet'>,
): ScoreClaim | null {
  const { score, scoredBy, readAtBlock } = passport.reputation;
  return score
    ? { score, scoredBy: scoredBy ?? [], agentWallet: passport.agentWallet, readAtBlock }
    : null;
}

export async function loadOnBase(query: { q?: string; before?: string | null } = {}) {
  const params = new URLSearchParams();
  if (query.q?.trim()) params.set('q', query.q.trim());
  if (query.before) params.set('before', query.before);
  const search = params.toString();
  return json<OnBaseList>(`${ON_BASE_ROUTES.list}${search ? `?${search}` : ''}`);
}

/** One passport by Base ID (decimal); null when no registered agent has it. */
export async function loadPassport(baseId: string): Promise<Passport | null> {
  const path = ON_BASE_ROUTES.passport(baseId);
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${path} ${response.status}`);
  return (await response.json()) as Passport;
}

/**
 * Verify one Base ID in this browser against Base. The reads (ownerOf, tokenURI, the mint's
 * sender, the finalized block and, on a passport with a score, the raters' feedback) live in
 * ./onBaseVerify, loaded on first use; any failure to reach Base is 'unreachable', and nothing is
 * then shown as passed.
 */
export async function verifyOnBase(
  row: Pick<OnBaseRow, 'baseId' | 'owner' | 'short' | 'mintTx' | 'status'>,
  score: ScoreClaim | null = null,
): Promise<VerifyResult> {
  try {
    const module = await import('./onBaseVerify');
    return await module.verify(row, { score });
  } catch {
    return { kind: 'unreachable' };
  }
}
