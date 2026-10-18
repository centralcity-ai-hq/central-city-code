/*
 * Ratings in the browser (Operation Rating R1; server: the ratings routes under
 * /api/base/agents/:agentId/wallet/ratings, behind CITY_BASE_RATE). An owner rates another Central
 * City Base agent, 1 to 5 stars, from one of their own agents' wallets. The server prepares the
 * rating as an owner operation, exactly as it prepares a withdrawal; this module checks it, and it
 * is signed and sent the way Pay does it: withdraw.ts signAndSend to signaturePath(agentId,
 * withdrawalId), the anchor kept first (saveAnchor, in its own 'rating' store), its status read by withdrawalId. There is no
 * signature route of its own. (A cancel isn't signed for a rating yet: withdraw.ts checkOperation
 * binds a cancel only to a withdrawal, so the browser refuses it.) Nothing is signed unless:
 *
 *   - the agent to rate is exactly what the owner typed: BOTH its Base ID and its passport number
 *     (the 6-character short code after centralcity.ai/a/), one Central City agent with both; not
 *     the rater itself; and this browser reads Base and finds that Base ID's tokenURI is exactly
 *     that passport (confirmRateTargetOnBase): a Central City agent, never on trust;
 *   - the operation is for the wallet network and the pinned EntryPoint, well formed, from exactly
 *     the wallet the owner key makes for this agent, its fee covered by a pinned sponsor that
 *     charges the wallet nothing, recomputes to its hash, and deploys (if at all) only that wallet;
 *   - its nonce is never the replayable key 8453, and when the server says `lanes: true` it is
 *     exactly laneNonce(withdrawalId), the rating's own lane derived here (withdraw.ts
 *     checkNonceLane, the same check as Pay and Withdraw), and its sponsorship is valid now and
 *     ends no later than the server's fixed signing deadline (checkRatingWindow, right before
 *     signing and again right before sending);
 *   - its callData is exactly one rating (shared/base/rate.ts decodeRateCall): the pinned
 *     registry's giveFeedback for the Base ID looked up and confirmed, with the stars chosen;
 *   - the server's summary says exactly that.
 *
 * The owner key is only ever a local inside signAndSend: unlocked, used once, dropped.
 */
import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  isAddress,
  maxUint256,
  parseAbi,
  type Hex,
} from 'viem';
import { api, ApiError } from '../../api';
import { BASE_MAINNET, BASE_NETWORKS } from '../../../shared/base/chains';
import { PAY_PASSPORT_HOST } from '../../../shared/base/pay';
import { sponsoredWithoutCharge, type SponsorAllowlist } from '../../../shared/base/paymasters';
import {
  decodeRateCall,
  isStars,
  RATE_PATHS,
  RATE_REGISTRY,
  RATE_TAG,
  starsValue,
  type RateLookup,
  type RateSummary,
  type RateTarget,
  type RateToAgent,
  type RatingGiven,
  type RatingsGiven,
  type Stars,
} from '../../../shared/base/rate';
import {
  ownerOperationHash,
  userOperationFromRpc,
  WITHDRAWAL_CHAIN_ID,
  WITHDRAWAL_ENTRY_POINT,
} from '../../../shared/base/withdraw';
import { isOwnWallet } from './derive';
import { PAY_BASE_RPC } from './pay';
import {
  checkNonceLane,
  checkSigningWindow,
  deploysOwnWallet,
  signatureRefused,
  waitForWalletSetup,
  WithdrawalCheckError,
  type LaneExpectation,
  type SigningRequest,
} from './withdraw';

export type { RateLookup, RateSummary, RateTarget, RateToAgent, RatingGiven, Stars };

/** The agent to rate can't be looked up (or checked) as typed; the message says why. */
export class RateTargetError extends Error {}

/**
 * A rating refused before anything is signed; the message says what didn't match. A
 * WithdrawalCheckError, so the screens show it as "Not signed: …" like any other owner operation.
 */
export class RatingCheckError extends WithdrawalCheckError {}

/**
 * The rating's fee sponsorship is no longer valid (with lanes on, it must hold until the server's
 * fixed signing deadline): nothing was sent, and this prepared rating can never be signed. The
 * screen drops it and the next Rate prepares a new one; it never sends this one again.
 */
export class RatingWindowError extends RatingCheckError {}
export const RATING_WINDOW_CLOSED =
  'The network fee sponsorship for this rating ran out before it was signed. Nothing was sent. Rate again.';

/**
 * Rechecked right before signing and again right before the signature leaves (withdraw.ts
 * checkSigningWindow, as Pay and Withdraw do): the server's original deadline never slides.
 */
export function checkRatingWindow(
  request: Pick<RateSigningRequest, 'lanes' | 'chainId' | 'expiresAt' | 'userOperation'>,
  now = Date.now(),
  sponsors?: SponsorAllowlist,
) {
  try {
    checkSigningWindow(request, now, sponsors);
  } catch (error) {
    if (error instanceof WithdrawalCheckError) throw new RatingWindowError(RATING_WINDOW_CLOSED);
    throw error;
  }
}

export const RATING_EXPIRED =
  'This rating waited too long to be signed. Nothing was sent. Rate again.';

/**
 * Why a prepared rating is dropped after its signing failed, or null when it is kept:
 *   'window'  its sponsorship ran out (checkRatingWindow here, or 409 sponsorship_expired);
 *   'expired' its own time to be signed is up (410 expired);
 *   'refused' any other refusal the server makes before it takes a signature (withdraw.ts
 *             SIGNATURE_REFUSALS, the same list Pay and Withdraw use).
 * In each case nothing was sent and the same rating is never sent again: the screen discards it,
 * clears its anchor and its key, and the next Rate prepares a new one. Anything else (a 5xx, a
 * lost answer, a local check before signing) keeps it: the signature may have been taken.
 */
export function ratingDropped(error: unknown): 'window' | 'expired' | 'refused' | null {
  if (ratingWindowClosed(error)) return 'window';
  if (!signatureRefused(error)) return null;
  return (error as ApiError).code === 'expired' ? 'expired' : 'refused';
}

/**
 * True when the rating can never be signed because its sponsorship ran out: refused here
 * (checkRatingWindow) or by the server before it stored anything (409 sponsorship_expired).
 * Definitive: the screen discards it and starts over with a new key, never re-sending it.
 */
export function ratingWindowClosed(error: unknown): boolean {
  return (
    error instanceof RatingWindowError ||
    (error instanceof ApiError && error.status === 409 && error.code === 'sponsorship_expired')
  );
}

export const TYPE_BOTH = 'Type the agent’s Base ID and its passport number. Both are needed.';
export const NOT_A_BASE_ID =
  'A Base ID is a whole number above 0, digits only (for example 99515).';
export const NOT_A_PASSPORT =
  'A passport number is the 6 letters and digits after centralcity.ai/a/ (for example Ab3dE9).';
export const NOT_SAME_AGENT =
  'This Base ID and passport number don’t belong to the same Central City agent.';
export const NOT_ITSELF = 'An agent can’t rate itself.';
export const NOT_ON_BASE =
  'Base doesn’t show this passport at that Base ID, so it can’t be rated. Nothing was signed.';

/** A Base ID a rating can name: decimal, canonical, above 0. */
const BASE_ID = /^[1-9][0-9]{0,77}$/;
/**
 * A passport number: the short id after centralcity.ai/a/, 6 base62 characters, case-sensitive
 * (shared/base/short-id.ts, which is server-only).
 */
const SHORT = /^[0-9A-Za-z]{6}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;

/** A typed Base ID: digits only, no leading zero, above 0, and within uint256 (an ERC-8004 id). */
const isTypedBaseId = (value: string) => BASE_ID.test(value) && BigInt(value) <= maxUint256;

/**
 * The two values the owner typed, trimmed and checked, ready for the lookup; or a RateTargetError
 * saying which one is wrong. Nothing is read another way: no links, no "CC-" form, no free text.
 */
export function rateLookup(typed: { baseId: string; passport: string }): RateLookup {
  const baseId = typeof typed?.baseId === 'string' ? typed.baseId.trim() : '';
  const passport = typeof typed?.passport === 'string' ? typed.passport.trim() : '';
  if (!baseId || !passport) throw new RateTargetError(TYPE_BOTH);
  if (!isTypedBaseId(baseId)) throw new RateTargetError(NOT_A_BASE_ID);
  if (!SHORT.test(passport)) throw new RateTargetError(NOT_A_PASSPORT);
  return { baseId, passport };
}

/** A passport's address, as an agent's tokenURI on Base holds it (shared/base/short-id.ts). */
export const passportUri = (short: string) => `https://${PAY_PASSPORT_HOST}/a/${short}`;

/**
 * The server's lookup answer, checked: one agent whose Base ID AND passport number are both exactly
 * what was typed (passport numbers are case-sensitive), not `rater` (the agent rating), with its
 * block and an expiry still ahead. Returns a clean copy (only these fields). Base is read
 * separately (confirmRateTargetOnBase).
 */
export function checkRateTarget(
  answer: RateTarget,
  typed: RateLookup,
  now: number,
  rater: string,
): RateTarget {
  const agent = answer?.agent;
  if (
    !agent ||
    typeof answer.lookupId !== 'string' ||
    !answer.lookupId ||
    answer.lookupId.length > 256 ||
    typeof agent.agentId !== 'string' ||
    !agent.agentId ||
    typeof agent.baseId !== 'string' ||
    !BASE_ID.test(agent.baseId) ||
    typeof agent.short !== 'string' ||
    !SHORT.test(agent.short) ||
    !Number.isSafeInteger(answer.checkedAtBlock) ||
    answer.checkedAtBlock <= 0 ||
    !Number.isFinite(answer.expiresAt)
  )
    throw new RateTargetError('The agent couldn’t be read. Try again.');
  if (agent.baseId !== typed?.baseId || agent.short !== typed?.passport)
    throw new RateTargetError(NOT_SAME_AGENT);
  // The server refuses one's own agents too; this is the one case the browser can see itself.
  if (typeof rater !== 'string' || !rater || agent.agentId === rater)
    throw new RateTargetError(NOT_ITSELF);
  if (answer.expiresAt <= now)
    throw new RateTargetError('That check is too old. Look the agent up again.');
  return {
    lookupId: answer.lookupId,
    agent: {
      agentId: agent.agentId,
      name: typeof agent.name === 'string' ? agent.name : '',
      baseId: agent.baseId,
      short: agent.short,
    },
    checkedAtBlock: answer.checkedAtBlock,
    expiresAt: answer.expiresAt,
  };
}

/* ---------- this browser's own read of Base ---------- */

const IDENTITY_REGISTRY = BASE_NETWORKS[WITHDRAWAL_CHAIN_ID]?.contracts.identityRegistry;
const tokenUriAbi = parseAbi(['function tokenURI(uint256 tokenId) view returns (string)']);
const READ_TIMEOUT_MS = 8_000;

/** Options for the Base read: tests pass their own fetch. */
export interface BaseReadOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * tokenURI(Base ID) in the wallet network's identity registry, read from Base by this browser at
 * one block: plain JSON-RPC to Base's public endpoint (pay.ts PAY_BASE_RPC), no keys. null when the
 * call reverts (no such Base ID). Base mainnet only; on any other network, or when Base doesn't
 * answer, it throws and nothing is signed. As Pay's ownerOnBase.
 */
export async function tokenUriOnBase(
  baseId: string,
  options: BaseReadOptions = {},
): Promise<{ uri: string | null; block: number }> {
  if (WITHDRAWAL_CHAIN_ID !== BASE_MAINNET || !IDENTITY_REGISTRY)
    throw new RateTargetError(
      'This browser can only check agents on Base itself, so nothing is signed on this network.',
    );
  if (typeof baseId !== 'string' || !BASE_ID.test(baseId))
    throw new RateTargetError('The agent to rate has no Base ID.');
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  const unreachable = () =>
    new RateTargetError('Couldn’t check on Base. Nothing was signed. Try again in a moment.');
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
        // A revert is an answer: the Base ID doesn't exist (burned or never minted).
        if (/revert/i.test(String(body.error.message ?? ''))) return null;
        throw unreachable();
      }
      if (!response.ok || body?.result === undefined) throw unreachable();
      return body.result;
    } catch (error) {
      if (error instanceof RateTargetError) throw error;
      throw unreachable();
    } finally {
      clearTimeout(timer);
    }
  }
  const head = await rpc('eth_blockNumber', []);
  if (typeof head !== 'string' || !/^0x[0-9a-f]+$/i.test(head)) throw unreachable();
  const block = Number(BigInt(head));
  const data = encodeFunctionData({
    abi: tokenUriAbi,
    functionName: 'tokenURI',
    args: [BigInt(baseId)],
  });
  const result = await rpc('eth_call', [{ to: IDENTITY_REGISTRY, data }, head]);
  if (result === null) return { uri: null, block };
  if (typeof result !== 'string' || !/^0x([0-9a-f]{64})+$/i.test(result)) throw unreachable();
  try {
    return {
      uri: decodeFunctionResult({
        abi: tokenUriAbi,
        functionName: 'tokenURI',
        data: result as Hex,
      }),
      block,
    };
  } catch {
    throw unreachable();
  }
}

/**
 * Base, read here, has exactly this agent's passport (https://centralcity.ai/a/<short>) as the
 * tokenURI of its Base ID: the Base ID is the Central City agent the owner typed or was shown, not
 * whatever the server named. The block it read. Called by the lookup, and again by the screen
 * right before signing, as Pay's confirmOnBase.
 */
export async function confirmRateTargetOnBase(
  target: RateTarget,
  options?: BaseReadOptions,
): Promise<number> {
  const short = target?.agent?.short;
  if (typeof short !== 'string' || !SHORT.test(short))
    throw new RateTargetError('The agent couldn’t be read. Try again.');
  const read = await tokenUriOnBase(target.agent.baseId, options);
  if (read.uri !== passportUri(short)) throw new RateTargetError(NOT_ON_BASE);
  return read.block;
}

export const rateLookupPath = (agentId: string) =>
  RATE_PATHS.lookup.replace(':agentId', encodeURIComponent(agentId));
export const ratingsPath = (agentId: string) =>
  RATE_PATHS.ratings.replace(':agentId', encodeURIComponent(agentId));

/**
 * The agent `agentId` (the rater) would rate, named by BOTH its Base ID and its passport number:
 * checked as typed before anything is asked (rateLookup), looked up by the server, which refuses
 * anything but another Central City agent with that final Base ID and that passport, checked here
 * against both values, then confirmed on Base by this browser (its Base ID's tokenURI is that
 * passport).
 */
export async function lookupRateTarget(
  agentId: string,
  typed: { baseId: string; passport: string },
  options?: BaseReadOptions,
): Promise<RateTarget> {
  const lookup = rateLookup(typed);
  let answer: RateTarget;
  try {
    answer = await api<RateTarget>(rateLookupPath(agentId), {
      baseId: lookup.baseId,
      passport: lookup.passport,
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === 'lookup_mismatch')
      throw new RateTargetError(NOT_SAME_AGENT);
    throw error;
  }
  const checked = checkRateTarget(answer, lookup, Date.now(), agentId);
  await confirmRateTargetOnBase(checked, options);
  return checked;
}

const GIVEN_STATES: readonly string[] = [
  'awaiting_signature',
  'submitted',
  'included',
  'final',
  'failed',
  'expired',
  'cancel_pending',
  'cancelled',
];

/** One listed rating, well formed, or null (it isn't shown). Display only: nothing is signed. */
function givenRow(row: RatingGiven): RatingGiven | null {
  if (
    !row ||
    typeof row.withdrawalId !== 'string' ||
    !row.withdrawalId ||
    typeof row.ratedAgentId !== 'string' ||
    typeof row.baseId !== 'string' ||
    !BASE_ID.test(row.baseId) ||
    !isStars(row.stars) ||
    !GIVEN_STATES.includes(row.state) ||
    !Number.isFinite(row.createdAt)
  )
    return null;
  const explorerUrl =
    typeof row.explorerUrl === 'string' && /^https:\/\//.test(row.explorerUrl)
      ? row.explorerUrl
      : null;
  return {
    withdrawalId: row.withdrawalId,
    ratedAgentId: row.ratedAgentId,
    name: typeof row.name === 'string' ? row.name : '',
    baseId: row.baseId,
    short: typeof row.short === 'string' && SHORT.test(row.short) ? row.short : '',
    stars: row.stars,
    state: row.state,
    ...(typeof row.safe === 'boolean' ? { safe: row.safe } : {}),
    txHash: typeof row.txHash === 'string' ? row.txHash : null,
    blockNumber: Number.isSafeInteger(row.blockNumber) ? row.blockNumber : null,
    explorerUrl,
    createdAt: row.createdAt,
    updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : row.createdAt,
  };
}

/**
 * The ratings `agentId`'s wallet made, newest first, as the server stores them (GET
 * RATE_PATHS.ratings; 404 while ratings are off). Rows that aren't well formed are left out.
 */
export async function readRatingsGiven(agentId: string): Promise<RatingGiven[]> {
  const answer = await api<RatingsGiven>(ratingsPath(agentId), undefined, 'GET');
  const rows = Array.isArray(answer?.ratings) ? answer.ratings : [];
  return rows.map(givenRow).filter((row): row is RatingGiven => row !== null);
}

/** The rating's `to`: the lookup the owner confirmed, by its id only. */
export const rateTo = (target: RateTarget): RateToAgent => ({ lookupId: target.lookupId });

/**
 * The create answer: an owner operation like a withdrawal, under the same withdrawalId (sign it
 * with withdraw.ts signAndSend to signaturePath; read it with the withdrawal routes).
 */
export type RateSigningRequest = Omit<SigningRequest, 'summary'> & { summary: RateSummary };

export function createRating(
  agentId: string,
  body: { to: RateToAgent; stars: Stars; idempotencyKey: string },
) {
  // Only the lookup's id goes back: what it showed is the server's own record.
  return api<RateSigningRequest>(ratingsPath(agentId), {
    to: { lookupId: body.to.lookupId },
    stars: body.stars,
    idempotencyKey: body.idempotencyKey,
  });
}

const sameAddress = (value: unknown, address: string) =>
  typeof value === 'string' && isAddress(value) && getAddress(value) === getAddress(address);
/** A whole number the server wrote as a decimal string or a safe integer, equal to `decoded`. */
const sameInteger = (value: unknown, decoded: bigint) =>
  ((typeof value === 'string' && DECIMAL.test(value)) ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) &&
  BigInt(value) === decoded;

/**
 * Checks a prepared rating before the owner signs it, and returns the hash to sign. `wallet` is
 * the rater agent's wallet as the wallet route reported it; `expected` is the rating on screen:
 * the Base ID looked up and confirmed (on Base too: confirmRateTargetOnBase), and the stars chosen.
 * The same checks as a withdrawal's, in the same order (withdraw.ts checkOperation, which points
 * back here: change both), then the call and the summary.
 */
export function checkRateOperation(input: {
  request: RateSigningRequest;
  wallet: string;
  /**
   * The wallet's owner key and the rater agent: `wallet` must be exactly the wallet that key makes
   * for this agent (derive.ts), and an operation that also deploys it must use that same recipe.
   */
  owner: string;
  agentId: string;
  expected: { baseId: string; stars: Stars };
  /** The rater agent's own Base ID, when the screen knows it: a rating of it signs nothing. */
  raterBaseId?: string;
  /** Who may sponsor (tests pass their own); the pinned list otherwise. */
  sponsors?: SponsorAllowlist;
  /**
   * The rating's own lane (withdraw.ts laneFor), needed when the request says `lanes: true`: then
   * the nonce must be exactly laneNonce(request.withdrawalId), the rating's own id, as for a
   * withdrawal. Without `lanes: true` nothing changes.
   */
  lane?: LaneExpectation;
}): Hex {
  const { request, expected } = input;
  if (!isStars(expected?.stars)) throw new RatingCheckError('A rating is 1 to 5 whole stars.');
  if (typeof expected.baseId !== 'string' || !BASE_ID.test(expected.baseId))
    throw new RatingCheckError('The agent to rate has no Base ID.');
  if (!request || typeof request !== 'object')
    throw new RatingCheckError('The operation from the server isn’t well formed.');
  if (request.chainId !== WITHDRAWAL_CHAIN_ID)
    throw new RatingCheckError('This operation is for another network.');
  if (
    typeof request.entryPoint !== 'string' ||
    !isAddress(request.entryPoint, { strict: false }) ||
    getAddress(request.entryPoint) !== getAddress(WITHDRAWAL_ENTRY_POINT)
  )
    throw new RatingCheckError('This operation names another EntryPoint.');
  let op;
  try {
    op = userOperationFromRpc(request.userOperation);
  } catch {
    throw new RatingCheckError('The operation from the server isn’t well formed.');
  }
  const wallet =
    typeof input.wallet === 'string' && isAddress(input.wallet, { strict: false })
      ? getAddress(input.wallet)
      : null;
  if (!wallet || getAddress(op.sender) !== wallet)
    throw new RatingCheckError('The operation isn’t from this agent’s wallet.');
  // The wallet itself: derived here from the owner key and the agent, never taken on trust.
  if (!isOwnWallet(wallet, input.owner, input.agentId))
    throw new RatingCheckError('This isn’t the wallet your wallet key makes for this agent.');
  // Fees are covered: an allowed sponsor pays, never the wallet (shared/base/paymasters.ts),
  // whatever the summary says. Anything else fails closed.
  if (!sponsoredWithoutCharge(request.chainId, op.paymasterAndData, input.sponsors))
    throw new RatingCheckError(
      'The network fee isn’t covered by the approved sponsor; the wallet could be charged.',
    );
  const hash = ownerOperationHash(op);
  if (
    typeof request.userOpHash !== 'string' ||
    hash.toLowerCase() !== request.userOpHash.toLowerCase()
  )
    throw new RatingCheckError('The operation doesn’t match its hash.');
  // A first operation also deploys the wallet: only the pinned factory with exactly our owners and
  // index, as for withdrawals (withdraw.ts deploysOwnWallet).
  if (
    (op.initCode ?? '0x') !== '0x' &&
    !deploysOwnWallet(op.initCode as Hex, input.owner, input.agentId)
  )
    throw new RatingCheckError('The operation would set up the wallet with other owners.');
  // Never the replayable key; with lanes on, exactly the start of the rating's own lane, derived
  // here from its own id (never a key the server names), as for a withdrawal (withdraw.ts).
  const lane = checkNonceLane(
    op.nonce,
    request.lanes,
    input.lane && input.lane.withdrawalId === request.withdrawalId ? input.lane : undefined,
    false,
    RatingCheckError,
  );
  // Exactly one rating and nothing else (shared/base/rate.ts): a transfer, a batch or any other
  // call is refused here, as a rating is refused by every withdrawal check.
  const call = decodeRateCall(op.callData, wallet);
  if (!call) throw new RatingCheckError('The operation does something other than this rating.');
  if (call.agentId !== BigInt(expected.baseId))
    throw new RatingCheckError('The operation rates a different agent.');
  if (call.stars !== expected.stars)
    throw new RatingCheckError('The operation gives a different number of stars.');
  if (input.raterBaseId !== undefined) {
    if (typeof input.raterBaseId !== 'string' || !DECIMAL.test(input.raterBaseId))
      throw new RatingCheckError('The rating agent’s own Base ID isn’t readable.');
    if (call.agentId === BigInt(input.raterBaseId)) throw new RatingCheckError(NOT_ITSELF);
  }
  // What the screen shows comes from the server's summary: it must say exactly what is signed.
  const summary = request.summary;
  const mainnet = request.chainId === BASE_MAINNET;
  if (
    !summary ||
    typeof summary !== 'object' ||
    summary.kind !== 'rate' ||
    !sameAddress(summary.registry, RATE_REGISTRY) ||
    !sameInteger(summary.agentId, call.agentId) ||
    !sameInteger(summary.value, starsValue(call.stars)) ||
    summary.tag1 !== RATE_TAG ||
    (summary.stars !== undefined && summary.stars !== call.stars) ||
    !sameAddress(summary.from, op.sender) ||
    summary.network !== (mainnet ? 'Base' : 'Base Sepolia') ||
    summary.testnet !== !mainnet ||
    summary.sponsored !== true ||
    summary.fee?.paidBy !== 'sponsor' ||
    summary.deploysWallet !== ((op.initCode ?? '0x') !== '0x')
  )
    throw new RatingCheckError('The server’s summary doesn’t match the operation.');
  // One operation sets the wallet up at a time: while another that does is on its way, this waits.
  waitForWalletSetup(op.initCode, lane);
  return hash;
}
