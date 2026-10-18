/*
 * Owner withdrawals in the browser (Operation Base Wallet W2; server: server/base/wallet/
 * withdrawals.ts). The server prepares an unsigned operation from the agent's wallet; this module
 * checks it against what the owner asked for and signs its raw userOpHash with the unlocked owner
 * key (shared/base/withdraw.ts). Nothing is signed unless the operation recomputes to the hash the
 * server sent, comes from this wallet, and decodes to exactly the one call on the screen: the token,
 * the amount and the destination the owner typed (or a no-op, for a cancel).
 *
 * The owner key is only ever a local inside signAndSend: unlocked, used once, dropped.
 */
import {
  decodeFunctionData,
  getAddress,
  isAddress,
  parseAbi,
  sha256,
  stringToBytes,
  type Hex,
} from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import { api, ApiError } from '../../api';
import {
  decodeOwnerCall,
  ownerOperationHash,
  userOperationFromRpc,
  WITHDRAWAL_CHAIN_ID,
  WITHDRAWAL_ENTRY_POINT,
  type RpcUserOperation,
  type WithdrawalState,
  type WithdrawalToken,
} from '../../../shared/base/withdraw';
import { BASE_MAINNET, BASE_NETWORKS } from '../../../shared/base/chains';
import {
  laneNonce,
  LaneKeyError,
  nonceKeyOf,
  REPLAYABLE_NONCE_KEY,
  SEQUENTIAL_NONCE_KEY,
} from '../../../shared/base/lanes';
import {
  sponsoredWithoutCharge,
  sponsoredWithinDeadline,
  sponsorshipWindow,
  type SponsorAllowlist,
} from '../../../shared/base/paymasters';
import { unlockVault } from '../vault';
import { pageOutOfDate, STALE_PAGE } from '../stalePage';
import { isOwnWallet, walletAccountIndex } from './derive';

export { walletAccountIndex };
import type { Amount, WalletView } from './api';

export type { WithdrawalState, WithdrawalToken };

export interface WithdrawalFee {
  paidBy: 'sponsor' | 'wallet';
  token: 'ETH';
  max: Amount;
}

/** The create answer: what the owner is asked to sign. */
export interface SigningRequest {
  withdrawalId: string;
  state: WithdrawalState;
  userOperation: RpcUserOperation;
  userOpHash: Hex;
  entryPoint: string;
  chainId: number;
  expiresAt: number;
  /**
   * The server runs operations in lanes (CITY_BASE_LANES=1): this one has its own nonce key, and
   * the wallet's next operation needn't wait for it. Absent: one operation at a time, as before.
   */
  lanes?: boolean;
  summary: {
    kind: 'withdraw';
    token: WithdrawalToken;
    amount: Amount;
    from: string;
    to: string;
    network: string;
    testnet: boolean;
    sponsored: boolean;
    fee: WithdrawalFee;
    deploysWallet: boolean;
    toIsContract: boolean | null;
  };
}

/** A withdrawal as the server reads it now. */
export interface WithdrawalView {
  withdrawalId: string;
  state: WithdrawalState;
  token: WithdrawalToken;
  amount: Amount;
  from: string;
  to: string;
  network: string;
  chainId: number;
  userOpHash: Hex;
  sponsored: boolean;
  fee: WithdrawalFee;
  txHash: Hex | null;
  blockNumber: number | null;
  errorCode: string | null;
  explorerUrl: string | null;
  expiresAt: number | null;
  /** The withdrawal's own operation, when the server sends it (needed to cancel after a reload). */
  userOperation?: RpcUserOperation;
  /**
   * In a block Base already settled at its safe head (or final). Only the GET read's answer counts:
   * a POST answer's is never used. An older server sends none.
   */
  safe?: boolean;
  /**
   * A payment's names, if the server's open list carries them (display only, checked before use).
   * Otherwise a line names what this browser kept, or the address.
   */
  payment?: WithdrawalAnchor['payment'];
  cancel: null | {
    state: 'awaiting_signature' | 'submitted' | 'included' | 'final' | 'failed' | 'expired';
    userOpHash: Hex;
    userOperation: RpcUserOperation | null;
    entryPoint: string;
    expiresAt: number | null;
    sponsored: boolean;
    fee: WithdrawalFee;
    txHash: Hex | null;
    explorerUrl: string | null;
  };
  createdAt: number;
  updatedAt: number;
}

/** Refused before anything is signed; the message says what didn't match. */
export class WithdrawalCheckError extends Error {}

/**
 * How far ahead of Base this device's clock may run before a sponsorship looks expired here. The
 * server's deadline stays the authority (it answers 409 sponsorship_expired once it has passed).
 */
export const SIGNING_CLOCK_SKEW_MS = 60_000;

export const SIGNING_CLOCK_BEHIND =
  'This device’s clock is behind, so the sponsorship hasn’t started here yet. Set the clock to automatic time and prepare the operation again.';
export const SIGNING_WINDOW_EXPIRED =
  'This sponsorship is no longer valid. Prepare the operation again.';

/** Rechecked before signing and before sending; the server's original deadline never slides. */
export function checkSigningWindow(
  request: {
    lanes?: boolean;
    chainId: number;
    expiresAt: number | null;
    userOperation: RpcUserOperation;
  },
  now = Date.now(),
  sponsors?: SponsorAllowlist,
) {
  if (request.lanes !== true || request.userOperation.paymasterAndData === '0x') return;
  const data = request.userOperation.paymasterAndData;
  const window = { now, deadline: request.expiresAt ?? 0, expirySkewMs: SIGNING_CLOCK_SKEW_MS };
  if (sponsoredWithinDeadline(request.chainId, data, window, sponsors)) return;
  // A sponsorship that would be valid a little later: this clock is behind Base, not expired.
  const later = { ...window, now: now + SIGNING_CLOCK_SKEW_MS };
  const startsLater =
    typeof data === 'string' &&
    sponsorshipWindow(data).validAfter > BigInt(now) &&
    sponsoredWithinDeadline(request.chainId, data, later, sponsors);
  throw new WithdrawalCheckError(startsLater ? SIGNING_CLOCK_BEHIND : SIGNING_WINDOW_EXPIRED);
}

/** Not signed for now: something on its way has to land first. The message says what. */
export class WithdrawalWaitError extends Error {}

export const WALLET_SETTING_UP = 'Wait a moment: your wallet is being set up on Base.';

/**
 * With lanes on (the signing request's `lanes: true`), what the operation's nonce must be:
 * `withdrawalId` is the operation's own id (for a cancel, the id of the operation it cancels).
 * `deploying`: ids of other open operations that set the wallet up; while one is on its way, an
 * operation that would also set it up isn't signed.
 */
export interface LaneExpectation {
  withdrawalId: string;
  deploying?: readonly string[];
}

/** True when an operation (as JSON-RPC carries it) also deploys the wallet. */
export const deploysWallet = (userOperation: RpcUserOperation | null | undefined) =>
  !!userOperation && typeof userOperation.initCode === 'string' && userOperation.initCode !== '0x';

/** The kind of refusal a check throws: a WithdrawalCheckError, or one built on it (a rating's). */
type Refusal = new (message: string) => WithdrawalCheckError;

/**
 * The operation is exactly at the start of its own lane: nonce === laneNonce(withdrawalId), the
 * key the browser derives from the id itself (never one the server names), never the replayable
 * key 8453, never the shared lane 0. Throws `refuse` otherwise.
 */
function checkLane(
  nonce: bigint,
  lane: LaneExpectation,
  cancel: boolean,
  refuse: Refusal = WithdrawalCheckError,
) {
  const key = nonceKeyOf(nonce);
  if (key === REPLAYABLE_NONCE_KEY)
    throw new refuse(
      'This operation uses the wallet’s replayable nonce, so it could be replayed on other networks.',
    );
  if (key === SEQUENTIAL_NONCE_KEY)
    throw new refuse(
      cancel
        ? 'This cancel isn’t in the lane of the operation it cancels; it would cancel nothing.'
        : 'This operation isn’t in its own lane.',
    );
  let own: bigint;
  try {
    own = laneNonce(lane.withdrawalId);
  } catch (error) {
    if (error instanceof LaneKeyError) throw new refuse(error.message);
    throw error;
  }
  if (nonce !== own)
    throw new refuse(
      cancel
        ? 'This cancel isn’t in the lane of the operation it cancels; it would cancel nothing.'
        : 'This operation isn’t in its own lane.',
    );
}

/**
 * The nonce check every owner operation passes before it is signed (a withdrawal or payment here,
 * a rating in rate.ts checkRateOperation): never the replayable key 8453, laned or not. With
 * `lanes` true (the signing request's own), a `lane` must be given or nothing is signed, and the
 * nonce must be exactly laneNonce(lane.withdrawalId). Otherwise nothing else changes. Returns the
 * lane it checked (undefined without lanes).
 */
export function checkNonceLane(
  nonce: bigint,
  lanes: boolean | undefined,
  given: LaneExpectation | undefined,
  cancel: boolean,
  refuse: Refusal = WithdrawalCheckError,
): LaneExpectation | undefined {
  if (nonceKeyOf(nonce) === REPLAYABLE_NONCE_KEY)
    throw new refuse(
      'This operation uses the wallet’s replayable nonce, so it could be replayed on other networks.',
    );
  const lane = lanes === true ? given : undefined;
  if (lanes === true && !lane)
    throw new refuse('This operation’s lane couldn’t be checked, so nothing was signed.');
  if (lane) checkLane(nonce, lane, cancel, refuse);
  return lane;
}

/**
 * With lanes on, one operation sets the wallet up at a time: an operation that would also set it
 * up (`initCode` other than 0x) waits while another that does is on its way (WithdrawalWaitError).
 */
export function waitForWalletSetup(
  initCode: string | undefined,
  lane: LaneExpectation | undefined,
) {
  if (
    lane &&
    (initCode ?? '0x') !== '0x' &&
    (lane.deploying ?? []).some((id) => id !== lane.withdrawalId)
  )
    throw new WithdrawalWaitError(WALLET_SETTING_UP);
}

const base = (agentId: string) =>
  `/api/base/agents/${encodeURIComponent(agentId)}/wallet/withdrawals`;

/** A typed address, checked (EIP-55 when mixed case); null when it isn't one. */
export function addressOrNull(text: string): `0x${string}` | null {
  const value = text.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  return isAddress(value, { strict: true }) ? getAddress(value) : null;
}

export function createWithdrawal(
  agentId: string,
  request: { token: WithdrawalToken; amount: string | 'max'; to: string; idempotencyKey: string },
) {
  return api<SigningRequest>(base(agentId), request);
}

export const readWithdrawal = (agentId: string, withdrawalId: string) =>
  api<WithdrawalView>(`${base(agentId)}/${encodeURIComponent(withdrawalId)}`, undefined, 'GET');

/** Asks for the no-op at the withdrawal's nonce; the answer carries it to sign. */
export const askCancel = (agentId: string, withdrawalId: string) =>
  api<WithdrawalView>(`${base(agentId)}/${encodeURIComponent(withdrawalId)}/cancel`, {});

/**
 * Drops an operation that was prepared but never signed (a cancel discards it on the server), so
 * the next one isn't held up behind it. Best effort: an unsigned one also expires by itself.
 */
export async function discardUnsigned(agentId: string, withdrawalId: string) {
  try {
    await askCancel(agentId, withdrawalId);
  } catch {
    // Not answered: it expires on its own.
  }
}

/**
 * Checks an unsigned operation before the owner signs it, and returns its hash. `wallet` is the
 * agent's wallet as the wallet route reported it; `expected` is what the owner asked for (a
 * withdrawal, with 'max' when the server picks the amount), or a cancel.
 *
 * rate.ts checkRateOperation repeats the checks up to the call, in this order: change both.
 */
export function checkOperation(input: {
  userOperation: RpcUserOperation;
  userOpHash: Hex;
  entryPoint: string;
  chainId: number;
  wallet: string;
  /**
   * The wallet's owner key and its agent: `wallet` must be exactly the wallet that key makes for
   * this agent (derive.ts), and an operation that also deploys it must use that same recipe.
   */
  owner: string;
  agentId: string;
  /** Who may sponsor (tests pass their own); the pinned list otherwise. */
  sponsors?: SponsorAllowlist;
  expected:
    | { kind: 'withdraw'; token: WithdrawalToken; amount: string | 'max'; to: string }
    /**
     * A cancel: the wallet's own no-op at the nonce of `original`, the withdrawal it cancels (its
     * operation and the hash it was signed as). A no-op anywhere else would cancel nothing.
     */
    | { kind: 'noop'; original: { userOperation: RpcUserOperation; userOpHash: Hex } };
  /**
   * The signing request's `lanes` (for a cancel: whether the operation it cancels is laned). When
   * true, `lane` must be given and the nonce must be exactly laneNonce(lane.withdrawalId).
   */
  lanes?: boolean;
  /** The operation's own lane (laneFor), only when `lanes` is true. */
  lane?: LaneExpectation;
}): Hex {
  if (input.chainId !== WITHDRAWAL_CHAIN_ID)
    throw new WithdrawalCheckError(
      pageOutOfDate(input.chainId) ? STALE_PAGE : 'This operation is for another network.',
    );
  if (getAddress(input.entryPoint) !== getAddress(WITHDRAWAL_ENTRY_POINT))
    throw new WithdrawalCheckError('This operation names another EntryPoint.');
  let op;
  try {
    op = userOperationFromRpc(input.userOperation);
  } catch {
    throw new WithdrawalCheckError('The operation from the server isn’t well formed.');
  }
  if (getAddress(op.sender) !== getAddress(input.wallet))
    throw new WithdrawalCheckError('The operation isn’t from this agent’s wallet.');
  // The wallet itself: derived here from the owner key and the agent, never taken on trust.
  if (!isOwnWallet(input.wallet, input.owner, input.agentId))
    throw new WithdrawalCheckError('This isn’t the wallet your wallet key makes for this agent.');
  // Fees are covered (the product owner's decision): an allowed sponsor pays, never the wallet
  // (shared/base/paymasters.ts), whatever the summary says. Anything else fails closed.
  if (!sponsoredWithoutCharge(input.chainId, op.paymasterAndData, input.sponsors))
    throw new WithdrawalCheckError(
      'The network fee isn’t covered by the approved sponsor; the wallet could be charged.',
    );
  const hash = ownerOperationHash(op);
  if (hash.toLowerCase() !== input.userOpHash.toLowerCase())
    throw new WithdrawalCheckError('The operation doesn’t match its hash.');
  // A first operation also deploys the wallet: only by the Coinbase Smart Wallet factory, with
  // exactly the owners and index our wallets are made with (server/base/wallet/service.ts). Base's
  // EntryPoint makes sure what it deploys is `sender`; this makes sure `sender` is that wallet.
  if (
    (op.initCode ?? '0x') !== '0x' &&
    !deploysOwnWallet(op.initCode as Hex, input.owner, input.agentId)
  )
    throw new WithdrawalCheckError('The operation would set up the wallet with other owners.');
  // The replayable key is never an owner operation's, laned or not; with lanes, its own lane.
  const lane = checkNonceLane(op.nonce, input.lanes, input.lane, input.expected.kind === 'noop');
  const call = decodeOwnerCall(op.callData, getAddress(input.wallet));
  if (!call) throw new WithdrawalCheckError('The operation does something other than a transfer.');
  const expected = input.expected;
  if (expected.kind === 'noop') {
    if (call.kind !== 'noop')
      throw new WithdrawalCheckError('This isn’t the cancel you asked for.');
    // Bound to the withdrawal it cancels: that operation is this wallet's own (its hash recomputes)
    // and the no-op takes its nonce, so once either lands the other never can.
    let original;
    try {
      original = userOperationFromRpc(expected.original.userOperation);
    } catch {
      throw new WithdrawalCheckError('The withdrawal to cancel isn’t well formed.');
    }
    if (ownerOperationHash(original).toLowerCase() !== expected.original.userOpHash.toLowerCase())
      throw new WithdrawalCheckError('The withdrawal to cancel doesn’t match its hash.');
    if (getAddress(original.sender) !== getAddress(input.wallet))
      throw new WithdrawalCheckError('The withdrawal to cancel isn’t from this agent’s wallet.');
    if (decodeOwnerCall(original.callData, getAddress(input.wallet))?.kind !== 'withdraw')
      throw new WithdrawalCheckError('There is no withdrawal to cancel.');
    if (op.nonce !== original.nonce)
      throw new WithdrawalCheckError(
        'This cancel isn’t at the withdrawal’s nonce; it would cancel nothing.',
      );
    // Exactly the original's nonce (key and seq, above), and that nonce in the original's lane.
    if (lane) checkLane(original.nonce, lane, true);
    return hash;
  }
  if (call.kind !== 'withdraw' || call.token !== expected.token)
    throw new WithdrawalCheckError('The operation moves a different token.');
  if (call.to !== getAddress(expected.to))
    throw new WithdrawalCheckError('The operation sends to a different address.');
  if (expected.amount !== 'max' && call.amount !== BigInt(expected.amount))
    throw new WithdrawalCheckError('The operation sends a different amount.');
  if (call.amount <= 0n) throw new WithdrawalCheckError('The operation sends nothing.');
  // One operation sets the wallet up: while another that does is on its way, this one waits.
  waitForWalletSetup(op.initCode, lane);
  return hash;
}

const NETWORK = BASE_NETWORKS[WITHDRAWAL_CHAIN_ID];
const factoryAbi = parseAbi(['function createAccount(bytes[] owners, uint256 nonce)']);

/** Each owner as the factory takes it: one 32-byte word holding the address. */
const ownerWord = (address: string) => `0x${'00'.repeat(12)}${address.slice(2).toLowerCase()}`;

/**
 * initCode is the pinned factory's createAccount with exactly [owner key, SpendPermissionManager],
 * in that order and nothing more, at this agent's account index. Anything else is false.
 */
export function deploysOwnWallet(
  initCode: Hex,
  owner: string | undefined,
  agentId: string | undefined,
): boolean {
  const factory = NETWORK.contracts.smartWalletFactory;
  const manager = NETWORK.contracts.spendPermissionManager;
  if (!owner || !agentId || !factory || !manager || initCode.length < 42) return false;
  if (getAddress(initCode.slice(0, 42)) !== getAddress(factory)) return false;
  try {
    const call = decodeFunctionData({ abi: factoryAbi, data: `0x${initCode.slice(42)}` as Hex });
    const [owners, index] = call.args;
    const expected = [ownerWord(owner), ownerWord(manager)];
    return (
      owners.length === expected.length &&
      owners.every((word, at) => word.toLowerCase() === expected[at]) &&
      index === walletAccountIndex(agentId)
    );
  } catch {
    return false;
  }
}

/** What the owner signs, read from the checked operation itself (never from the summary). */
export interface CheckedIntent {
  token: WithdrawalToken;
  amount: bigint;
  from: `0x${string}`;
  to: `0x${string}`;
  network: 'Base' | 'Base Sepolia';
  testnet: boolean;
  deploysWallet: boolean;
}

/**
 * The confirm screen's values, decoded from an operation checkOperation passed: token, amount,
 * from, to, network and whether it also sets up the wallet. The server's summary must say exactly
 * the same; if any field differs nothing is signed, so what is shown is what is signed.
 */
export function checkedIntent(request: SigningRequest, wallet: string): CheckedIntent {
  let op;
  try {
    op = userOperationFromRpc(request.userOperation);
  } catch {
    throw new WithdrawalCheckError('The operation from the server isn’t well formed.');
  }
  const call = decodeOwnerCall(op.callData, getAddress(wallet));
  if (call?.kind !== 'withdraw')
    throw new WithdrawalCheckError('The operation isn’t a withdrawal.');
  const mainnet = request.chainId === BASE_MAINNET;
  const intent: CheckedIntent = {
    token: call.token,
    amount: call.amount,
    from: getAddress(op.sender),
    to: call.to,
    network: mainnet ? 'Base' : 'Base Sepolia',
    testnet: !mainnet,
    deploysWallet: (op.initCode ?? '0x') !== '0x',
  };
  const summary = request.summary;
  const sameAddress = (value: unknown, address: string) =>
    typeof value === 'string' && isAddress(value) && getAddress(value) === address;
  if (
    !summary ||
    summary.token !== intent.token ||
    summary.amount?.raw !== intent.amount.toString() ||
    !sameAddress(summary.from, intent.from) ||
    !sameAddress(summary.to, intent.to) ||
    summary.network !== intent.network ||
    summary.testnet !== intent.testnet ||
    summary.deploysWallet !== intent.deploysWallet
  )
    throw new WithdrawalCheckError('The server’s summary doesn’t match the operation.');
  return intent;
}

/** The checked request's decoded amount (the 'max' case: what the server picked). */
export function decodedAmount(userOperation: RpcUserOperation, wallet: string): bigint | null {
  try {
    const call = decodeOwnerCall(userOperationFromRpc(userOperation).callData, getAddress(wallet));
    return call?.kind === 'withdraw' ? call.amount : null;
  } catch {
    return null;
  }
}

/**
 * Unlocks the owner key with the password, signs the already-checked hash (raw, no prefix: a
 * Coinbase Smart Wallet checks exactly that hash) and sends the signature. The key never leaves
 * this function.
 */
export async function signAndSend(
  path: string,
  hash: Hex,
  password: string,
  /** False once the screen locked (hidden, idle, left): then nothing is signed or sent. */
  alive: () => boolean = () => true,
  /** Runs once the signature is made, right before it is sent (keep the anchor first). */
  beforeSend: () => void = () => {},
  /** The wallet's owner key as the wallet reports it: the unlocked key must be it. */
  signer?: string,
) {
  if (!alive()) throw new WithdrawalLockedError();
  const privateKey = await unlockVault(password);
  if (!alive()) throw new WithdrawalLockedError();
  // A wallet another key owns (an agent's identity wallet, say): this key's signature would be
  // refused on Base, so nothing is signed. Defense in depth: the reported owner isn't proof.
  if (signer !== undefined && privateKeyToAccount(privateKey).address !== getAddress(signer))
    throw new WithdrawalCheckError(
      'Your wallet key isn’t this wallet’s owner, so nothing was signed.',
    );
  const signature = await sign({ hash, privateKey, to: 'hex' });
  if (!alive()) throw new WithdrawalLockedError();
  beforeSend();
  return api<WithdrawalView>(path, { signature });
}

/** A form's idempotency key and the request body it was last sent with (null: not sent yet). */
export interface RequestKey {
  key: string;
  body: string | null;
}
export const newRequestKey = (): RequestKey => ({ key: crypto.randomUUID(), body: null });

/**
 * The key to send this body with. The same body again (a retry after a lost answer) keeps the key,
 * so the server answers with what it kept; an edited body gets a new key, never refused as another
 * use of the old one (idempotency_conflict).
 */
export function keyFor(held: RequestKey, body: unknown): string {
  const text = JSON.stringify(body);
  if (held.body !== null && held.body !== text) held.key = crypto.randomUUID();
  held.body = text;
  return held.key;
}

/** The screen locked while a signature was being made: it was dropped, nothing was sent. */
export class WithdrawalLockedError extends Error {
  constructor() {
    super('The page locked before sending, so nothing was sent. Sign again.');
  }
}

/**
 * The withdrawal this browser checked and signed, kept for this agent so a cancel after a reload is
 * still bound to it: its operation (no secret in it) and the hash it was signed as. Read back only
 * when the server's withdrawal has that same hash.
 */
export interface WithdrawalAnchor {
  withdrawalId: string;
  userOperation: RpcUserOperation;
  userOpHash: Hex;
  /**
   * A payment (Base Pay) rather than a withdrawal: who was paid, as checked here, so a reopened
   * screen names the payment and its recipient. Display only; the cancel binds to the operation.
   */
  payment?: { name: string; short: string; baseId: string; note: string | null };
}
/**
 * Where an anchor is kept: a rating (WalletRateScreen) has its own, so Withdraw and Pay, which read
 * theirs to resume a transfer, never take a rating for a withdrawal.
 */
export type AnchorStore = 'transfer' | 'rating';
const anchorKey = (agentId: string, store: AnchorStore = 'transfer') =>
  store === 'rating' ? `cc-rating:${agentId}` : `cc-withdrawal:${agentId}`;

/** This browser couldn't keep the anchor, so the signature wasn't sent. */
export class WithdrawalAnchorError extends Error {
  constructor() {
    super(
      'This browser can’t keep a record of the withdrawal (its site storage is blocked or full), so nothing was sent.',
    );
  }
}

/**
 * Keeps the anchor, read back to be sure. Throws WithdrawalAnchorError when it can't be kept: run
 * right before a signature is sent, that stops the sending, since a lost answer would then leave
 * nothing to resume or cancel from.
 */
export function saveAnchor(
  agentId: string,
  anchor: WithdrawalAnchor,
  store: AnchorStore = 'transfer',
) {
  try {
    localStorage.setItem(anchorKey(agentId, store), JSON.stringify(anchor));
    const kept = readAnchor(agentId, store);
    if (kept?.withdrawalId === anchor.withdrawalId && kept.userOpHash === anchor.userOpHash) return;
  } catch {
    // Blocked or full: refused below.
  }
  throw new WithdrawalAnchorError();
}
export function readAnchor(
  agentId: string,
  store: AnchorStore = 'transfer',
): WithdrawalAnchor | null {
  try {
    const value = JSON.parse(localStorage.getItem(anchorKey(agentId, store)) ?? 'null') as unknown;
    if (!value || typeof value !== 'object') return null;
    const anchor = value as WithdrawalAnchor;
    if (
      typeof anchor.withdrawalId !== 'string' ||
      typeof anchor.userOpHash !== 'string' ||
      typeof anchor.userOperation !== 'object'
    )
      return null;
    const paid = anchor.payment;
    // A malformed payment record only loses the names, never the anchor itself.
    const payment =
      paid &&
      typeof paid.name === 'string' &&
      typeof paid.short === 'string' &&
      typeof paid.baseId === 'string' &&
      (paid.note === null || typeof paid.note === 'string')
        ? paid
        : undefined;
    return { ...anchor, payment };
  } catch {
    return null;
  }
}
/** The operation an anchor or a released record is for. */
type Operation = { withdrawalId: string; userOpHash: string };
const same = (a: Operation, b: Operation) =>
  a.withdrawalId === b.withdrawalId && a.userOpHash.toLowerCase() === b.userOpHash.toLowerCase();

/**
 * Clears the anchor only while it is still this operation's: an older one finishing (in another
 * tab, say) never clears the one signed after it. True when nothing of this one is left anchored.
 */
export function clearAnchor(
  agentId: string,
  operation: Operation,
  store: AnchorStore = 'transfer',
): boolean {
  try {
    const kept = readAnchor(agentId, store);
    if (kept && same(kept, operation)) localStorage.removeItem(anchorKey(agentId, store));
    return true;
  } catch {
    return false;
  }
}

/**
 * Operations released from the anchor once Base settled them at its safe head, so the wallet could
 * start its next one. Nothing else in the browser lists what went out, so each is kept here (no
 * secret in it) and shown as a quiet line until it is final. A day at most, a few at a time.
 */
export interface ReleasedOperation {
  withdrawalId: string;
  userOpHash: Hex;
  payment?: WithdrawalAnchor['payment'];
  releasedAt: number;
}
const releasedKey = (agentId: string) => `cc-withdrawal-released:${agentId}`;
const RELEASED_MAX = 8;
const RELEASED_FOR_MS = 24 * 60 * 60_000;

export function readReleased(agentId: string): ReleasedOperation[] {
  try {
    const value = JSON.parse(localStorage.getItem(releasedKey(agentId)) ?? '[]') as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(
      (entry): entry is ReleasedOperation =>
        !!entry &&
        typeof entry.withdrawalId === 'string' &&
        typeof entry.userOpHash === 'string' &&
        typeof entry.releasedAt === 'number' &&
        entry.releasedAt > Date.now() - RELEASED_FOR_MS,
    );
  } catch {
    return [];
  }
}

function writeReleased(agentId: string, list: ReleasedOperation[]) {
  if (list.length) localStorage.setItem(releasedKey(agentId), JSON.stringify(list));
  else localStorage.removeItem(releasedKey(agentId));
}

/**
 * Releases an operation at Base's safe head: recorded first, then its anchor cleared (only while
 * it is still this one's). False when it couldn't be recorded: the anchor then stays, and the
 * screen still offers the next operation.
 */
export function releaseAnchor(
  agentId: string,
  operation: Operation & { userOpHash: Hex; payment?: WithdrawalAnchor['payment'] },
): boolean {
  try {
    const list = readReleased(agentId).filter(
      (entry) => entry.withdrawalId !== operation.withdrawalId,
    );
    const entry: ReleasedOperation = {
      withdrawalId: operation.withdrawalId,
      userOpHash: operation.userOpHash,
      payment: operation.payment,
      releasedAt: Date.now(),
    };
    writeReleased(agentId, [entry, ...list].slice(0, RELEASED_MAX));
    if (!readReleased(agentId).some((kept) => same(kept, operation))) return false;
  } catch {
    return false;
  }
  return clearAnchor(agentId, operation);
}

/** Done (final, or it never went): its quiet line goes. */
export function dropReleased(agentId: string, withdrawalId: string) {
  try {
    writeReleased(
      agentId,
      readReleased(agentId).filter((entry) => entry.withdrawalId !== withdrawalId),
    );
  } catch {}
}

/**
 * What the server's signature route refuses before it stores anything (server/base/wallet/
 * withdrawals.ts sign): a malformed or wrong signature, an expired or unknown operation, one not
 * as prepared, funds moved meanwhile, or the sponsor paused or busy (refused and rolled back).
 * Anything else, a 5xx (even chain_unavailable, which can follow the stored signature), a lost
 * answer or an unknown code, may come after the signature was accepted.
 */
export const SIGNATURE_REFUSALS: ReadonlySet<string> = new Set([
  'invalid_body',
  'invalid_signature',
  'not_found',
  'expired',
  'signature_mismatch',
  'operation_mismatch',
  'funds_moved',
  'sponsor_paused',
  'sponsor_busy',
  'sponsorship_expired',
]);

/** True only for a refusal the server makes before accepting the signature: nothing was sent. */
export function signatureRefused(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    typeof error.code === 'string' &&
    SIGNATURE_REFUSALS.has(error.code)
  );
}

/**
 * After a signature's answer was lost or unclear: the same operation read once, by its id and the
 * hash signed here. 'sent': the server has it signed (its view); 'never': it can no longer be
 * signed (expired), so nothing went; 'unsigned': still awaiting its signature; 'unknown': not read,
 * or not the operation signed here. Nothing new is ever prepared or cancelled here.
 */
export type Reconciled =
  { k: 'sent'; view: WithdrawalView } | { k: 'never' } | { k: 'unsigned' } | { k: 'unknown' };
export async function reconcileSignature(
  agentId: string,
  operation: { withdrawalId: string; userOpHash: string },
  read: typeof readWithdrawal = readWithdrawal,
): Promise<Reconciled> {
  let view: WithdrawalView;
  try {
    view = await read(agentId, operation.withdrawalId);
  } catch {
    return { k: 'unknown' };
  }
  if (!view || view.withdrawalId !== operation.withdrawalId || !same(view, operation))
    return { k: 'unknown' };
  if (view.state === 'awaiting_signature') return { k: 'unsigned' };
  if (view.state === 'expired') return { k: 'never' };
  // A GET read's `safe` counts; the line reads it again anyway.
  return { k: 'sent', view };
}

export const signaturePath = (agentId: string, withdrawalId: string) =>
  `${base(agentId)}/${encodeURIComponent(withdrawalId)}/signature`;
export const cancelSignaturePath = (agentId: string, withdrawalId: string) =>
  `${base(agentId)}/${encodeURIComponent(withdrawalId)}/cancel/signature`;

/** States after which nothing more happens to a withdrawal. */
export const DONE: readonly WithdrawalState[] = ['final', 'failed', 'expired', 'cancelled'];

/**
 * An anchored operation already done at a screen's first read (final, or it never went): nothing
 * more can happen to it, so the screen isn't held on it. It is released as at the safe head
 * (recorded, then its anchor cleared only while it is still its own) and shows as a quiet line over
 * an empty form. True when the screen opens on its form. Another operation under its id, one still
 * on its way, or a record that can't be kept: false, and the screen shows it as before.
 */
export function releaseIfDone(
  agentId: string,
  anchor: WithdrawalAnchor,
  view: Pick<WithdrawalView, 'withdrawalId' | 'userOpHash' | 'state'>,
): boolean {
  if (!same(anchor, view) || !DONE.includes(view.state)) return false;
  return releaseAnchor(agentId, {
    withdrawalId: anchor.withdrawalId,
    userOpHash: anchor.userOpHash,
    payment: anchor.payment,
  });
}

/**
 * Reads the anchored operation once as a screen opens; true when it was already done and released
 * (the screen opens on its form). Any miss is false: the status screen reads it again, and says so
 * when the server no longer knows it.
 */
export async function releasedAtOpen(agentId: string, anchor: WithdrawalAnchor) {
  try {
    return releaseIfDone(agentId, anchor, await readWithdrawal(agentId, anchor.withdrawalId));
  } catch {
    return false;
  }
}

export const SENT_HEADLINE = 'Sent · awaiting finality';
export const SENT_NOTE = 'Final in about 15 minutes.';

/** Where an owner operation stands on its screens. */
export interface SentStatus {
  /**
   * 'sent': in a block Base settled at its safe head, not final yet. The recipient has the money,
   * but nothing says paid or final before Base does.
   */
  phase: 'on_its_way' | 'sent' | 'final' | 'failed' | 'expired' | 'cancelled' | 'cancelling';
  /** Above the steps; null keeps the screen as it was before `safe`. */
  headline: string | null;
  /** A quiet line under the headline. */
  note: string | null;
  /** A few words for a one-line list. */
  short: string;
  /** Nothing more can happen to its anchor: the wallet may start its next operation. */
  released: boolean;
}

/**
 * The status for the server's `state` and `safe`, from the GET read only (a POST answer's `safe` is
 * never passed in). Without `safe` (an older server) nothing here differs from before it: 'sent'
 * needs exactly included and safe true, and any later answer is shown as it is, never a stale one.
 */
export function sentStatus(
  view: { state: WithdrawalState; safe?: boolean },
  noun: 'payment' | 'withdrawal',
): SentStatus {
  const ended = (phase: SentStatus['phase'], short: string): SentStatus => ({
    phase,
    headline: null,
    note: null,
    short,
    released: true,
  });
  switch (view.state) {
    case 'final': {
      const done = noun === 'payment' ? 'Paid ✓' : 'Withdrawn ✓';
      return { phase: 'final', headline: done, note: null, short: done, released: true };
    }
    case 'failed':
      return ended('failed', 'Didn’t go through');
    case 'expired':
      return ended('expired', 'Never sent');
    case 'cancelled':
      return ended('cancelled', 'Cancelled');
    case 'cancel_pending':
      return { ...ended('cancelling', 'Cancelling'), released: false };
    case 'included':
      if (view.safe === true)
        return {
          phase: 'sent',
          headline: SENT_HEADLINE,
          note: SENT_NOTE,
          short: SENT_HEADLINE,
          released: true,
        };
      return { ...ended('on_its_way', 'In a block'), released: false };
    default:
      return { ...ended('on_its_way', 'On its way'), released: false };
  }
}

/* ---------- lanes: several operations on their way at once ---------- */

/**
 * An operation this browser checked and signed in its own lane, kept per wallet until it is done,
 * so its History line names it and its cancel stays bound to it after a reload (no secret in it).
 * Like the anchor it is kept, read back, before the signature leaves, but it never blocks the next
 * operation. `laned: false`: an operation from before lanes (an anchor carried over), cancelled at
 * its nonce without a lane.
 */
export interface LaneRecord {
  withdrawalId: string;
  userOperation: RpcUserOperation;
  userOpHash: Hex;
  payment?: WithdrawalAnchor['payment'];
  signedAt: number;
  laned: boolean;
}
const lanesKey = (agentId: string) => `cc-withdrawal-lanes:${agentId}`;
const lanesOnKey = (agentId: string) => `cc-wallet-lanes:${agentId}`;
/** More than the server lets be open at once is never kept; the oldest go first. */
const LANE_RECORDS_MAX = 120;
const LANE_RECORDS_FOR_MS = 24 * 60 * 60_000;

const paymentNames = (value: unknown): WithdrawalAnchor['payment'] => {
  const paid = value as WithdrawalAnchor['payment'];
  return paid &&
    typeof paid === 'object' &&
    typeof paid.name === 'string' &&
    typeof paid.short === 'string' &&
    typeof paid.baseId === 'string' &&
    (paid.note === null || typeof paid.note === 'string')
    ? { name: paid.name, short: paid.short, baseId: paid.baseId, note: paid.note }
    : undefined;
};

export function readLaneRecords(agentId: string): LaneRecord[] {
  try {
    const value = JSON.parse(localStorage.getItem(lanesKey(agentId)) ?? '[]') as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (entry): entry is LaneRecord =>
          !!entry &&
          typeof entry.withdrawalId === 'string' &&
          typeof entry.userOpHash === 'string' &&
          typeof entry.userOperation === 'object' &&
          entry.userOperation !== null &&
          typeof entry.signedAt === 'number' &&
          typeof entry.laned === 'boolean' &&
          entry.signedAt > Date.now() - LANE_RECORDS_FOR_MS,
      )
      .map((entry) => ({ ...entry, payment: paymentNames(entry.payment) }));
  } catch {
    return [];
  }
}

function writeLaneRecords(agentId: string, list: LaneRecord[]) {
  if (list.length) localStorage.setItem(lanesKey(agentId), JSON.stringify(list));
  else localStorage.removeItem(lanesKey(agentId));
}

/**
 * Keeps the record, read back to be sure; throws WithdrawalAnchorError when it can't be kept (run
 * right before the signature is sent, that stops the sending, as the anchor does).
 */
export function saveLaneRecord(agentId: string, record: LaneRecord) {
  try {
    const rest = readLaneRecords(agentId).filter(
      (entry) => entry.withdrawalId !== record.withdrawalId,
    );
    writeLaneRecords(agentId, [record, ...rest].slice(0, LANE_RECORDS_MAX));
    if (readLaneRecords(agentId).some((kept) => same(kept, record))) return;
  } catch {
    // Blocked or full: refused below.
  }
  throw new WithdrawalAnchorError();
}

/** Done (final, failed, cancelled, unknown to the server): its record goes. */
export function dropLaneRecord(agentId: string, withdrawalId: string) {
  try {
    writeLaneRecords(
      agentId,
      readLaneRecords(agentId).filter((entry) => entry.withdrawalId !== withdrawalId),
    );
  } catch {}
}

/**
 * Whether the server last said it runs lanes for this wallet (a create answer's `lanes`), so a
 * reopened screen shows the server's open list. Only ever a display choice: every operation is
 * checked against its own request's `lanes`.
 */
export function lanesRemembered(agentId: string): boolean {
  try {
    return localStorage.getItem(lanesOnKey(agentId)) === '1';
  } catch {
    return false;
  }
}
export function rememberLanes(agentId: string, on: boolean) {
  try {
    if (on) localStorage.setItem(lanesOnKey(agentId), '1');
    else localStorage.removeItem(lanesOnKey(agentId));
  } catch {}
}

/**
 * With lanes on, an anchor from before (one operation at a time) becomes a record like any other:
 * its line shows in History and its cancel stays bound to it; it no longer holds the screen.
 */
export function carryAnchorOver(agentId: string): boolean {
  const anchor = readAnchor(agentId);
  if (!anchor) return true;
  try {
    saveLaneRecord(agentId, {
      withdrawalId: anchor.withdrawalId,
      userOperation: anchor.userOperation,
      userOpHash: anchor.userOpHash,
      payment: anchor.payment,
      signedAt: Date.now(),
      laned: false,
    });
  } catch {
    return false;
  }
  return clearAnchor(agentId, anchor);
}

const isView = (value: unknown): value is WithdrawalView => {
  const view = value as WithdrawalView;
  return (
    !!view &&
    typeof view === 'object' &&
    typeof view.withdrawalId === 'string' &&
    typeof view.state === 'string' &&
    (view.token === 'USDC' || view.token === 'ETH') &&
    typeof view.amount?.raw === 'string' &&
    /^[0-9]{1,78}$/.test(view.amount.raw) &&
    typeof view.to === 'string' &&
    typeof view.userOpHash === 'string'
  );
};

/**
 * The wallet's open operations, newest first, in one read (GET ?open=1). Malformed entries are
 * dropped; a payment's names are kept only when they are plain strings.
 */
export async function readOpenWithdrawals(agentId: string): Promise<WithdrawalView[]> {
  const answer = await api<{ withdrawals?: unknown }>(`${base(agentId)}?open=1`, undefined, 'GET');
  if (!Array.isArray(answer?.withdrawals)) throw new Error('The open list couldn’t be read.');
  return answer.withdrawals
    .filter(isView)
    .map((view) => ({ ...view, payment: paymentNames(view.payment) }));
}

/**
 * Whether the server runs lanes for this wallet right now, from its open list: answered (the list
 * exists only while lanes are on), 404 (off: one operation at a time, as before), or null when it
 * couldn't be read (the screen then goes by what this browser remembers). Display only: every
 * operation is still checked against its own request's `lanes`.
 */
export async function lanesOnServer(
  agentId: string,
  read: typeof readOpenWithdrawals = readOpenWithdrawals,
): Promise<boolean | null> {
  try {
    await read(agentId);
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return false;
    return null;
  }
}

/** The most operations a wallet may have on their way at once, unless the server says. */
export const OPEN_MAX = 100;

const count = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;

/** An amount the server attached (`{ display }`), only when it reads as a plain number. */
const shownOf = (value: unknown): string | null => {
  const display = (value as { display?: unknown } | null)?.display;
  return typeof display === 'string' && /^[0-9]{1,30}(\.[0-9]{1,18})?$/.test(display)
    ? display
    : null;
};

/** What a refusal is worded for: the screen's operation and token. */
export interface RefusalContext {
  /** Pay: 'payment'; Withdraw: 'withdrawal' (the counts name both, as the server counts both). */
  noun: 'payment' | 'withdrawal';
  token: WithdrawalToken;
}

const counted = (noun: RefusalContext['noun'], n: number | null) => {
  const one = noun === 'payment' ? 'payment' : 'payment or withdrawal';
  const many = noun === 'payment' ? 'payments' : 'payments and withdrawals';
  if (n === 1) return `1 ${one} is still on its way`;
  return `${n ?? 'some'} ${many} are still on their way`;
};

const until = (at: number) =>
  new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/**
 * The plain line for a refusal from the server's lanes (pay without waiting), or null when the
 * error isn't one of them (the screen then words it as before). The numbers come from the answer's
 * `details`, used only when they are plain numbers. operation_pending is worded here only when
 * `settingUp` (lanes on and the wallet not on Base yet: one operation sets it up at a time).
 */
export function laneRefusal(
  error: unknown,
  context: RefusalContext = { noun: 'payment', token: 'USDC' },
  settingUp = false,
): string | null {
  if (!(error instanceof ApiError)) return null;
  const details = (error.details ?? {}) as Record<string, unknown>;
  const { noun } = context;
  switch (error.code) {
    case 'too_many_open': {
      const max = count(details.max) ?? OPEN_MAX;
      const many = noun === 'payment' ? 'payments' : 'payments and withdrawals';
      return `${max} ${many} are still on their way. Wait for one to finish.`;
    }
    case 'funds_held':
      return `Not enough ${context.token} while ${counted(noun, count(details.open))}.`;
    case 'funds_moved': {
      const token =
        details.token === 'USDC' || details.token === 'ETH' ? details.token : context.token;
      const available = shownOf(details.available);
      const needed = shownOf(details.needed);
      const amounts =
        available && needed ? ` (${needed} ${token} needed, ${available} available)` : '';
      return `The wallet no longer holds enough ${token} for this ${noun}${amounts}. Nothing was sent.`;
    }
    case 'sponsor_paused': {
      const at = count(details.retryAt);
      return `Several ${noun === 'payment' ? 'payments' : 'payments or withdrawals'} from this wallet didn’t go through on Base, so new ones pause ${at ? `until ${until(at)}` : 'for a while'}.`;
    }
    case 'sponsor_busy':
      return count(details.retryAfterSeconds)
        ? 'Busy right now. Try again in a minute.'
        : `This ${noun}’s network fee is more than Central City can cover right now. Nothing was sent.`;
    case 'lane_collision':
      return `That ${noun} couldn’t be prepared. Nothing was sent. Try again.`;
    case 'cancel_over_headroom':
      return 'This can’t be cancelled right now: the network fee is higher than was set aside for it. Try again when fees are lower.';
    case 'operation_pending':
      return settingUp ? WALLET_SETTING_UP : null;
    default:
      return null;
  }
}

/** States of an operation that was signed and isn't done yet. */
const SIGNED_OPEN: readonly WithdrawalState[] = ['submitted', 'included', 'cancel_pending'];

/**
 * What a request's operation is checked against with lanes on (undefined when the request didn't
 * say `lanes: true`: then nothing changes). An operation that would also set the wallet up learns
 * which others on their way do: from the server's open list and this browser's records; one signed
 * elsewhere whose operation isn't known counts while Base doesn't have the wallet yet.
 */
export async function laneFor(
  agentId: string,
  request: Pick<SigningRequest, 'lanes' | 'withdrawalId' | 'userOperation'>,
  wallet: Pick<WalletView, 'deployed'>,
  read: typeof readOpenWithdrawals = readOpenWithdrawals,
): Promise<LaneExpectation | undefined> {
  if (request.lanes !== true) return undefined;
  if (!deploysWallet(request.userOperation)) return { withdrawalId: request.withdrawalId };
  const records = readLaneRecords(agentId);
  const recordOf = (id: string) => records.find((entry) => entry.withdrawalId === id);
  const deploying = new Set<string>();
  let open: WithdrawalView[] | null = null;
  try {
    open = await read(agentId);
  } catch {
    // Not read: this browser's own records still count.
  }
  if (open)
    for (const view of open) {
      if (!SIGNED_OPEN.includes(view.state)) continue;
      const known = view.userOperation ?? recordOf(view.withdrawalId)?.userOperation;
      if (known ? deploysWallet(known) : !wallet.deployed) deploying.add(view.withdrawalId);
    }
  else
    for (const entry of records)
      if (deploysWallet(entry.userOperation)) deploying.add(entry.withdrawalId);
  deploying.delete(request.withdrawalId);
  return { withdrawalId: request.withdrawalId, deploying: [...deploying] };
}
