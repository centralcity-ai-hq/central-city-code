/*
 * Operation Rating (R1): an owner rates another Central City Base agent, 1 to 5 stars, from one of
 * their own agents' wallets. What the browser and the server share: the routes, the one call a
 * rating is, how stars become an ERC-8004 feedback value, and the exact decoder both sides check
 * it with. Browser-safe: no Node imports.
 *
 * A rating is an owner operation like a withdrawal or a payment (withdraw.ts): the rater agent's
 * own wallet, a sponsored user operation, its raw userOpHash signed in the browser. Its one call is
 * exactly
 *
 *   execute(ReputationRegistry, 0,
 *     giveFeedback(agentId, stars × 20, 0, 'starred', '', '', '', 0x00…00))
 *
 * on the wallet network's pinned registry (chains.ts), where agentId is the rated agent's Base ID.
 * Nothing else rides along: one execute (never a batch), no value, no tag but 'starred', no
 * endpoint, link or hash, and both the outer and the inner call encoded exactly as viem encodes
 * them, so no trailing bytes or shifted offsets can hide anything. A rating is never combined with
 * a transfer, and decodeOwnerCall (withdraw.ts) keeps refusing it: a withdrawal check never passes
 * a rating, nor a rating check a withdrawal.
 *
 * Who may rate whom is the server's to decide (the lookup): both agents Central City agents on
 * Base, with a final Base ID and a passport naming it, never one's own or the same person's.
 */
import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  maxUint256,
  parseAbi,
  zeroHash,
  type Hex,
} from 'viem';
import { BASE_NETWORKS, type Address } from './chains.js';
import { WALLET_CHAIN_ID } from './wallet-network.js';
import { walletAbi, type OwnerCallEncoding, type WithdrawalState } from './withdraw.js';

export const RATE_PATHS = {
  /**
   * POST RateLookup {baseId, passport}: the agent a rating would go to, checked by the server for
   * this rater. Both must name the same Central City agent (otherwise the code lookup_mismatch).
   */
  lookup: '/api/base/agents/:agentId/wallet/ratings/lookup',
  /**
   * POST {to: {lookupId}, stars, idempotencyKey}: the rating to sign, answered as a withdrawal
   * is; its signature, status and cancel go through the withdrawal routes by withdrawalId.
   * GET: RatingsGiven, the ratings this agent's wallet made (newest first, at most
   * RATINGS_GIVEN_MAX).
   */
  ratings: '/api/base/agents/:agentId/wallet/ratings',
} as const;

/** GET RATE_PATHS.ratings answers at most this many ratings, newest first. */
export const RATINGS_GIVEN_MAX = 50;

/**
 * One rating an agent's wallet made, as GET RATE_PATHS.ratings lists it (RatingsGiven): its owner
 * only, read from the server's records alone (no Base read). A rating never signed that ran out
 * of time is not listed. To bring one on its way up to date, read it by withdrawalId on the
 * withdrawal route (that read follows it on Base).
 */
export interface RatingGiven {
  /** The rating's owner operation (the withdrawal routes read it by this id). */
  withdrawalId: string;
  /** The rated agent's Central City id. */
  ratedAgentId: string;
  /** Display only: its public card name now, '' while the card is not public. */
  name: string;
  /** The rated agent's Base ID (decimal), the one the rating names on Base. */
  baseId: string;
  /** Its passport number (6 base62 characters after centralcity.ai/a/); '' if none is known. */
  short: string;
  stars: Stars;
  /** As stored, like a withdrawal's: final only once Base finalized it. */
  state: WithdrawalState;
  /** Whether its block is at Base's safe head; only when the server knows it (absent otherwise). */
  safe?: boolean;
  txHash: string | null;
  blockNumber: number | null;
  explorerUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RatingsGiven {
  ratings: RatingGiven[];
}

/**
 * The lookup body: the two values the owner typed, both required, trimmed. `baseId` is the agent's
 * ERC-8004 id (decimal, above 0, no leading zeros); `passport` is its passport number, the 6
 * base62 characters after centralcity.ai/a/ (case-sensitive; never a link or a "CC-" form).
 */
export interface RateLookup {
  baseId: string;
  passport: string;
}

/**
 * The lookup answer: the agent a rating would go to, as the server checked it on Base at one
 * block. `agent.agentId` is its Central City id; `agent.baseId` is the ERC-8004 id the rating names.
 */
export interface RateTarget {
  /** Names what was shown, kept by the server until expiresAt; a rating carries only this. */
  lookupId: string;
  agent: {
    agentId: string;
    /** Display only: its public card name, '' while the card is not public. */
    name: string;
    /** Its ERC-8004 id in the wallet network's registry (decimal). */
    baseId: string;
    /** Its short id: the passport number, 6 base62 chars after centralcity.ai/a/ (case-sensitive). */
    short: string;
  };
  checkedAtBlock: number;
  /** After it the rating is refused: look the agent up again. */
  expiresAt: number;
}

/** POST .../wallet/ratings `to`: the lookup the owner confirmed, by its id, nothing else. */
export interface RateToAgent {
  lookupId: string;
}

/**
 * What the server says a prepared rating is (the create answer's `summary`), shaped like a
 * withdrawal's summary. The browser signs nothing unless every field agrees with the decoded call
 * (src/base/wallet/rate.ts checkRateOperation). Note `agentId` here is giveFeedback's agentId, the
 * rated agent's BASE ID (the lookup's agent.baseId), never its Central City id.
 */
export interface RateSummary {
  kind: 'rate';
  /** The ReputationRegistry the wallet calls (RATE_REGISTRY). */
  registry: string;
  /** The rated agent's Base ID (giveFeedback's agentId); a decimal string or a safe integer. */
  agentId: string | number;
  /** The feedback value, stars × 20; a decimal string or a safe integer. */
  value: string | number;
  tag1: string;
  /** The stars, when the server says them too. */
  stars?: number;
  /** The rater agent's wallet: the operation's sender. */
  from: string;
  /** 'Base' on Base mainnet, 'Base Sepolia' on the test network, as for a withdrawal. */
  network: string;
  testnet: boolean;
  /** Always true: a rating is only ever sponsored. */
  sponsored: boolean;
  fee: {
    paidBy: 'sponsor' | 'wallet';
    token: 'ETH';
    max: { raw: string; decimals: number; display: string };
  };
  /** Whether the operation also deploys the rater's wallet (initCode not empty). */
  deploysWallet: boolean;
}

/** The one tag a rating carries: it says the value is stars, 20 per star. */
export const RATE_TAG = 'starred';

export const RATE_STARS = [1, 2, 3, 4, 5] as const;
export type Stars = (typeof RATE_STARS)[number];

/** One star in the feedback value: 5 stars is 100 (decimals 0). */
const STAR_VALUE = 20n;

export const isStars = (value: unknown): value is Stars => RATE_STARS.includes(value as Stars);

/** The feedback value for a number of stars: stars × 20. Anything but 1 to 5 whole stars throws. */
export function starsValue(stars: Stars): bigint {
  if (!isStars(stars)) throw new Error('A rating is 1 to 5 whole stars.');
  return BigInt(stars) * STAR_VALUE;
}

/** The stars a feedback value stands for, or null when it isn't exactly 20, 40, 60, 80 or 100. */
export function starsOf(value: bigint): Stars | null {
  if (typeof value !== 'bigint' || value % STAR_VALUE !== 0n) return null;
  const stars = Number(value / STAR_VALUE);
  return isStars(stars) ? stars : null;
}

/**
 * ERC-8004 ReputationRegistry.giveFeedback, selector 0x3c036a7e (as the registry's implementation
 * on Base has it). Only ever called by a rating; reads are the server's (server/base/explorer/head.ts).
 */
export const giveFeedbackAbi = parseAbi([
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
]);

/** The wallet network's pinned ReputationRegistry (the proxy): the only target a rating has. */
export const RATE_REGISTRY: Address = getAddress(
  BASE_NETWORKS[WALLET_CHAIN_ID].contracts.reputationRegistry,
);

/** The one call of a rating: giveFeedback on the pinned registry, no value. */
export function rateCall(agentId: bigint, stars: Stars): OwnerCallEncoding {
  if (typeof agentId !== 'bigint' || agentId <= 0n || agentId > maxUint256)
    throw new Error('A rating names a Base ID above 0.');
  return {
    target: RATE_REGISTRY,
    value: 0n,
    data: encodeFunctionData({
      abi: giveFeedbackAbi,
      functionName: 'giveFeedback',
      args: [agentId, starsValue(stars), 0, RATE_TAG, '', '', '', zeroHash],
    }),
  };
}

/** A rating's callData: the wallet's one execute of rateCall. */
export function encodeRateCall(agentId: bigint, stars: Stars): Hex {
  const call = rateCall(agentId, stars);
  return encodeFunctionData({
    abi: walletAbi,
    functionName: 'execute',
    args: [call.target, call.value, call.data],
  });
}

export interface RateCall {
  /** The rated agent's Base ID. */
  agentId: bigint;
  stars: Stars;
}

/**
 * Layer one: the callData is, byte for byte, what encodeRateCall makes for the Base ID and stars it
 * names. On its own this already refuses every other call, field, encoding and trailing byte. It
 * does not look at the wallet.
 */
function exactRateCall(callData: Hex): RateCall | null {
  try {
    const outer = decodeFunctionData({ abi: walletAbi, data: callData });
    if (outer.functionName !== 'execute') return null;
    const inner = decodeFunctionData({ abi: giveFeedbackAbi, data: outer.args[2] });
    if (inner.functionName !== 'giveFeedback') return null;
    const [agentId, amount] = inner.args;
    const stars = starsOf(amount);
    if (stars === null) return null;
    return encodeRateCall(agentId, stars) === callData.toLowerCase() ? { agentId, stars } : null;
  } catch {
    return null;
  }
}

/**
 * Layer two, independent of layer one: field by field. One execute of the pinned registry (never
 * the wallet's own address), no value, both calls re-encoding to the same bytes (no trailing data,
 * no shifted or aliased offsets, no dirty padding), and every giveFeedback field what a rating
 * sets. (The `execute` name check is belt and braces: a batch's arguments fail the address check.)
 */
function checkedRateCall(callData: Hex, wallet: Address): RateCall | null {
  try {
    const outer = decodeFunctionData({ abi: walletAbi, data: callData });
    if (outer.functionName !== 'execute') return null;
    if (
      encodeFunctionData({ abi: walletAbi, functionName: 'execute', args: outer.args }) !==
      callData.toLowerCase()
    )
      return null;
    const [target, value, data] = outer.args;
    // The registry, never the wallet itself (calling itself is a cancel's no-op), and no value.
    if (
      getAddress(target) !== RATE_REGISTRY ||
      getAddress(wallet) === RATE_REGISTRY ||
      value !== 0n
    )
      return null;
    const inner = decodeFunctionData({ abi: giveFeedbackAbi, data });
    if (inner.functionName !== 'giveFeedback') return null;
    // The same for the inner call: its bytes are opaque to the outer check.
    if (
      encodeFunctionData({
        abi: giveFeedbackAbi,
        functionName: 'giveFeedback',
        args: inner.args,
      }) !== data.toLowerCase()
    )
      return null;
    const [agentId, amount, decimals, tag1, tag2, endpoint, feedbackURI, feedbackHash] = inner.args;
    const stars = starsOf(amount);
    if (
      agentId <= 0n ||
      stars === null ||
      decimals !== 0 ||
      tag1 !== RATE_TAG ||
      tag2 !== '' ||
      endpoint !== '' ||
      feedbackURI !== '' ||
      feedbackHash.toLowerCase() !== zeroHash
    )
      return null;
    return { agentId, stars };
  } catch {
    return null;
  }
}

/**
 * The two layers decodeRateCall is made of, exported only so the tests can prove each one refuses
 * every bad case on its own. Nothing that decides may call them: use decodeRateCall.
 */
export const rateCallLayers = { exactRateCall, checkedRateCall } as const;

/**
 * What a rating's callData rates, or null when it is anything but exactly one rating from `wallet`
 * (the rater's wallet): one execute of the pinned registry's giveFeedback, no value, the value 20
 * to 100 in steps of 20 with decimals 0, tag1 'starred', every other field empty or zero, and both
 * calls encoded canonically. Two independent layers must both accept it and agree: the exact bytes
 * (exactRateCall) and the fields (checkedRateCall). Either one alone refuses every bad case the
 * tests know; both are kept so a slip in one is never enough. Any doubt is null.
 */
export function decodeRateCall(callData: Hex, wallet: Address): RateCall | null {
  const exact = exactRateCall(callData);
  const checked = checkedRateCall(callData, wallet);
  if (!exact || !checked || exact.agentId !== checked.agentId || exact.stars !== checked.stars)
    return null;
  return exact;
}
