/*
 * Spending limits in the browser (Operation Base Wallet W3; server: server/base/wallet/limits.ts).
 * The owner signs ONE spend permission per token for the agent's spender; that permission is what
 * Base enforces. The server prepares it; this module checks it against what the owner typed (this
 * wallet, USDC, the allowance the cap means under the server's model, the period, the next Berlin
 * midnight, no end) and recomputes its hash, so the owner signs exactly the limit on screen. A
 * revoke is the wallet's own SpendPermissionManager.revoke of exactly the limit shown, with the
 * network fee covered.
 *
 * The spender is the agent's own key, held by the server; the browser can't tell it from another
 * address, and the allowance bounds whoever holds it.
 *
 * The owner key is only ever a local inside signLimit / signRevoke: unlocked, used once, dropped.
 */
import {
  decodeFunctionData,
  encodeFunctionData,
  formatUnits,
  getAddress,
  isAddress,
  parseAbi,
  type Hex,
} from 'viem';
import { privateKeyToAccount, sign, signTypedData } from 'viem/accounts';
import { api, ApiError } from '../../api';
import { BASE_NETWORKS } from '../../../shared/base/chains';
import {
  checkRevokeOperation,
  DEFAULT_ONCHAIN_CAP_MODEL,
  LIMIT_PERIOD_SECONDS,
  LIMIT_PERMISSION_END,
  nextBerlinMidnight,
  onchainAllowance,
  permissionFromJson,
  permissionToJson,
  revokeCall,
  smartWalletMessageTypedData,
  spendPermissionHash,
  type LimitPeriod,
  type OnchainCapModel,
  type RpcUserOperation,
  type SpendPermissionJson,
} from '../../../shared/base/spend-limits';
import type { SpendPermission } from '../../../shared/base/types';
import { WALLET_CHAIN_ID } from '../../../shared/base/wallet-network';
import { pageOutOfDate, STALE_PAGE } from '../stalePage';
import { userOperationFromRpc } from '../../../shared/base/withdraw';
import { unlockVault } from '../vault';
import { sponsoredWithoutCharge, type SponsorAllowlist } from '../../../shared/base/paymasters';
import { isOwnWallet } from './derive';
import { deploysOwnWallet, WithdrawalLockedError } from './withdraw';

export type { LimitPeriod, OnchainCapModel };

const NETWORK = BASE_NETWORKS[WALLET_CHAIN_ID];
const USDC = NETWORK.tokens.USDC;

export type LimitState = 'signed' | 'approved' | 'revoke_pending' | 'revoked';
export type RevokeState =
  'awaiting_signature' | 'expired' | 'submitted' | 'included' | 'final' | 'failed';

/** Base's view of a limit at one block; null when Base couldn't be read (never zeros). */
export interface LimitOnchain {
  start: number;
  end: number;
  currentPeriodStart: number | null;
  currentPeriodEnd: number | null;
  spentRaw: string;
  leftRaw: string;
  readAtBlock: number;
  blockTime: number;
  phase: 'before_start' | 'active' | 'ended';
  approved: boolean;
  revoked: boolean;
}

/** Central City's own count over the Berlin calendar day / week / month (not a protection). */
export interface LimitCalendar {
  periodStart: number;
  periodEnd: number;
  spentRaw: string;
  leftRaw: string;
  timeZone: string;
}

export interface LimitRevoke {
  state: RevokeState;
  userOpHash: Hex | null;
  txHash: Hex | null;
  expiresAt?: number | null;
  revokedAt?: number;
  revokedAtBlock?: number;
}

/** One limit as GET …/wallet/limits lists it. */
export interface LimitView {
  permissionId: string;
  token: 'USDC';
  capRaw: string;
  capDisplay: string;
  onchainModel: OnchainCapModel;
  allowanceRaw: string;
  allowanceDisplay: string;
  boundaryBurstRaw: string;
  period: LimitPeriod;
  periodSeconds: number;
  permissionHash: Hex;
  state: LimitState;
  createdAt: number;
  onchain: LimitOnchain | null;
  calendar: LimitCalendar;
  revoke: LimitRevoke | null;
}

export interface LimitsView {
  chainId: number;
  network: string;
  testnet: boolean;
  /** The model a new limit gets now; each limit carries the one it was signed with. */
  onchainModel: OnchainCapModel;
  stale: boolean;
  readAtBlock: number | null;
  readAt: number | null;
  /** Newest first. */
  limits: LimitView[];
}

/** POST …/limits/prepare: the permission to sign, as the server built it. */
export interface PreparedLimit {
  chainId: number;
  token: 'USDC';
  capRaw: string;
  capDisplay: string;
  onchainModel: OnchainCapModel;
  allowanceRaw: string;
  allowanceDisplay: string;
  boundaryBurstRaw: string;
  period: LimitPeriod;
  periodSeconds: number;
  permission: SpendPermissionJson;
  permissionHash: Hex;
  typedData: unknown;
  expiresAt: number;
}

/** POST …/limits/:id/revoke: the owner operation to sign. */
export interface RevokeRequest {
  permissionId: string;
  state: LimitState;
  revokeState: 'awaiting_signature';
  chainId: number;
  entryPoint: string;
  userOperation: RpcUserOperation;
  userOpHash: Hex;
  expiresAt: number;
  summary: {
    action: 'revoke_limit';
    wallet: string;
    contract: string;
    permissionHash: Hex;
    token: 'USDC';
    capRaw: string;
    allowanceRaw: string;
    period: LimitPeriod;
    deploysWallet: boolean;
  };
}

/** Refused before anything is signed; the message says what didn't match. */
export class LimitCheckError extends Error {}

const base = (agentId: string) => `/api/base/agents/${encodeURIComponent(agentId)}/wallet/limits`;

/** GET …/wallet/limits: the limits, or 'off' while the server doesn't offer them (404). */
export async function readLimits(
  agentId: string,
): Promise<{ kind: 'limits'; view: LimitsView } | { kind: 'off' }> {
  try {
    return { kind: 'limits', view: await api<LimitsView>(base(agentId), undefined, 'GET') };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { kind: 'off' };
    throw error;
  }
}

export const prepareLimit = (agentId: string, request: { capRaw: string; period: LimitPeriod }) =>
  api<PreparedLimit>(`${base(agentId)}/prepare`, request);

/** Base already shows the limit revoked: nothing to sign. */
export interface RevokeDone {
  permissionId: string;
  state: LimitState;
  revokeState: 'final';
}

/** Asks for the revoke: the server blocks the agent's spends at once and answers what to sign. */
export const askRevoke = (agentId: string, permissionId: string) =>
  api<RevokeRequest | RevokeDone>(
    `${base(agentId)}/${encodeURIComponent(permissionId)}/revoke`,
    {},
  );

/** The limit that is in force (or on its way out); null when there is none. */
export const currentLimit = (view: LimitsView): LimitView | null =>
  view.limits.find((limit) => limit.state !== 'revoked') ?? null;

/** USDC base units as text, at least two decimals ("20.00", "10.005"). */
export function usdcText(raw: bigint | string): string {
  const text = formatUnits(BigInt(raw), USDC.decimals);
  const [whole, fraction = ''] = text.split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

export const PERIOD_WORDS: Readonly<Record<LimitPeriod, string>> = {
  day: 'a day',
  week: 'a week',
  month: 'a month',
};

/** "20.00 USDC a day". */
export const limitText = (limit: Pick<LimitView, 'capRaw' | 'period'>) =>
  `${usdcText(limit.capRaw)} USDC ${PERIOD_WORDS[limit.period]}`;

/**
 * The cap the owner typed, in USDC base units: a positive amount with at most two decimals
 * ("20", "20.5", "20.50"; a comma works as the decimal point). Null when it isn't one.
 */
export function capFromText(text: string): string | null {
  const value = text.trim().replace(',', '.');
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  const raw = BigInt(match[1]!) * 1_000_000n + BigInt((match[2] ?? '').padEnd(2, '0')) * 10_000n;
  return raw > 0n ? raw.toString(10) : null;
}

/** How far ahead of the next Berlin midnight a limit prepared just before it may start. */
export const MIDNIGHT_SKEW_MS = 5 * 60_000;

export interface CheckedLimit {
  permission: SpendPermission;
  hash: Hex;
  /** What the owner key signs: the wallet's replay-safe wrapper around the permission hash. */
  typedData: ReturnType<typeof smartWalletMessageTypedData>;
  chainId: number;
  capRaw: string;
  period: LimitPeriod;
  model: OnchainCapModel;
  allowance: bigint;
  start: number;
}

/**
 * Checks a prepared limit before the owner signs it, and returns what to sign. `wallet` and
 * `spender` are the agent's wallet and spending key as the wallet route reported them; `capRaw`
 * and `period` are what the owner chose. Throws LimitCheckError on any mismatch.
 */
export function checkLimit(input: {
  prepared: Pick<PreparedLimit, 'chainId' | 'permission' | 'permissionHash' | 'onchainModel'>;
  wallet: string;
  /** The wallet's owner key and agent: `wallet` must be the one that key makes for this agent. */
  owner: string;
  agentId: string;
  /** The agent's spending key: the only key the limit may let spend. */
  spender: string | null | undefined;
  capRaw: string;
  period: LimitPeriod;
  now?: number;
}): CheckedLimit {
  const { prepared, period } = input;
  const now = input.now ?? Date.now();
  if (prepared.chainId !== WALLET_CHAIN_ID)
    throw new LimitCheckError(
      pageOutOfDate(prepared.chainId) ? STALE_PAGE : 'This limit is for another network.',
    );
  // The product owner's decision: on Base the allowance is half the cap per period. Another model
  // needs a change here and its review, never only a server setting.
  const model = prepared.onchainModel;
  if (model !== DEFAULT_ONCHAIN_CAP_MODEL)
    throw new LimitCheckError('The limit uses a different on-chain cap than this page allows.');
  const permission = permissionFromJson(prepared.permission);
  if (!permission) throw new LimitCheckError('The limit from the server isn’t well formed.');
  const hash = spendPermissionHash(WALLET_CHAIN_ID, permission);
  if (typeof prepared.permissionHash !== 'string' || hash !== prepared.permissionHash.toLowerCase())
    throw new LimitCheckError('The limit doesn’t match its hash.');
  if (permission.account !== getAddress(input.wallet))
    throw new LimitCheckError('The limit isn’t for this agent’s wallet.');
  if (!isOwnWallet(input.wallet, input.owner, input.agentId))
    throw new LimitCheckError('This isn’t the wallet your wallet key makes for this agent.');
  if (typeof input.spender !== 'string' || !isAddress(input.spender))
    throw new LimitCheckError('This page can’t tell which key the agent spends with.');
  if (permission.spender !== getAddress(input.spender))
    throw new LimitCheckError('The limit lets a different key spend than this agent’s.');
  if (permission.token !== getAddress(USDC.address))
    throw new LimitCheckError('The limit is for a different token.');
  if (!/^[1-9][0-9]*$/.test(input.capRaw)) throw new LimitCheckError('The limit has no amount.');
  const allowance = onchainAllowance(BigInt(input.capRaw), model);
  if (allowance < 1n || permission.allowance !== allowance)
    throw new LimitCheckError('Base would allow a different amount than your limit.');
  if (permission.period !== LIMIT_PERIOD_SECONDS[period])
    throw new LimitCheckError('The limit counts a different period.');
  // The next 00:00 in Berlin; prepared seconds before midnight, the server may see the one after.
  const next = nextBerlinMidnight(now);
  const after = nextBerlinMidnight(next * 1000);
  if (permission.start * 1000 <= now) throw new LimitCheckError('The limit starts in the past.');
  if (
    permission.start !== next &&
    !(permission.start === after && next * 1000 - now <= MIDNIGHT_SKEW_MS)
  )
    throw new LimitCheckError('The limit doesn’t start at the next midnight in Berlin.');
  if (permission.end !== LIMIT_PERMISSION_END)
    throw new LimitCheckError('The limit has an end of its own.');
  if (permission.extraData !== '0x') throw new LimitCheckError('The limit carries extra data.');
  return {
    permission,
    hash,
    typedData: smartWalletMessageTypedData(WALLET_CHAIN_ID, permission.account, hash),
    chainId: WALLET_CHAIN_ID,
    capRaw: input.capRaw,
    period,
    model,
    allowance,
    start: permission.start,
  };
}

/*
 * The agent's spending key as the owner confirmed it, kept per wallet in this browser (trust on
 * first use). The wallet route and the prepared limit are two answers of the same server; a key the
 * owner saw and signed for before is what a later limit is held to: a different one is shown as a
 * change and needs the owner's explicit confirmation. Another browser starts without a pin.
 */
const spenderKey = (wallet: string) => `cc-spender:${WALLET_CHAIN_ID}:${wallet.toLowerCase()}`;

export function readSpenderPin(wallet: string): `0x${string}` | null {
  try {
    const value = localStorage.getItem(spenderKey(wallet));
    return value && isAddress(value) ? getAddress(value) : null;
  } catch {
    return null;
  }
}

/** This browser couldn't keep the confirmed spending key, so the limit wasn't sent. */
export class SpenderPinError extends Error {
  constructor() {
    super(
      'This browser can’t keep the spending key you confirmed (its site storage is blocked or full), so nothing was sent.',
    );
  }
}

/**
 * Keeps the confirmed key, read back to be sure; throws SpenderPinError when it can't be kept. Run
 * right before the signature is sent (signLimit's beforeSend), so a lost answer can't lose it and
 * a browser that can't keep it sends nothing.
 */
export function pinSpender(wallet: string, spender: string) {
  const value = getAddress(spender);
  try {
    localStorage.setItem(spenderKey(wallet), value);
    if (readSpenderPin(wallet) === value) return;
  } catch {
    // Blocked or full: refused below.
  }
  throw new SpenderPinError();
}

const PERMISSION_TUPLE =
  '(address account,address spender,address token,uint160 allowance,uint48 period,uint48 start,uint48 end,uint256 salt,bytes extraData)';
const walletAbi = parseAbi(['function execute(address target, uint256 value, bytes data)']);
const revokeAbi = parseAbi([`function revoke(${PERMISSION_TUPLE} spendPermission)`]);

/** The permission a wallet's execute(SpendPermissionManager, 0, revoke(p)) revokes, or null. */
function revokedPermission(callData: Hex): SpendPermission | null {
  try {
    const outer = decodeFunctionData({ abi: walletAbi, data: callData });
    const inner = decodeFunctionData({ abi: revokeAbi, data: outer.args[2] });
    const p = inner.args[0];
    return {
      account: getAddress(p.account),
      spender: getAddress(p.spender),
      token: getAddress(p.token),
      allowance: p.allowance,
      period: p.period,
      start: p.start,
      end: p.end,
      salt: p.salt,
      extraData: p.extraData.toLowerCase() as Hex,
    };
  } catch {
    return null;
  }
}

/**
 * Checks a revoke operation before the owner signs it, and returns its hash: from this wallet, on
 * the wallet network, with a paymaster (fees are covered), its one call the wallet revoking
 * exactly the limit shown, and the hash its own. Throws LimitCheckError on any mismatch.
 */
export function checkRevoke(input: {
  request: Pick<
    RevokeRequest,
    'permissionId' | 'chainId' | 'entryPoint' | 'userOperation' | 'userOpHash'
  >;
  wallet: string;
  /**
   * The wallet's owner key and agent: `wallet` must be the one that key makes for this agent, and
   * a revoke that also deploys it must be that same recipe.
   */
  owner: string;
  agentId: string;
  limit: Pick<LimitView, 'permissionId' | 'permissionHash' | 'allowanceRaw' | 'periodSeconds'>;
  /** Who may sponsor (tests pass their own); the pinned list otherwise. */
  sponsors?: SponsorAllowlist;
}): Hex {
  const { request, limit } = input;
  if (request.chainId !== WALLET_CHAIN_ID)
    throw new LimitCheckError(
      pageOutOfDate(request.chainId) ? STALE_PAGE : 'This operation is for another network.',
    );
  if (
    typeof request.entryPoint !== 'string' ||
    getAddress(request.entryPoint) !== NETWORK.contracts.entryPointV06
  )
    throw new LimitCheckError('This operation names another EntryPoint.');
  if (request.permissionId !== limit.permissionId)
    throw new LimitCheckError('This isn’t the revoke of the limit shown.');
  let op;
  try {
    op = userOperationFromRpc(request.userOperation);
  } catch {
    throw new LimitCheckError('The operation from the server isn’t well formed.');
  }
  const wallet = getAddress(input.wallet);
  if (op.sender !== wallet)
    throw new LimitCheckError('The operation isn’t from this agent’s wallet.');
  if (!isOwnWallet(wallet, input.owner, input.agentId))
    throw new LimitCheckError('This isn’t the wallet your wallet key makes for this agent.');
  // Fees are covered: an allowed sponsor pays, never the wallet (shared/base/paymasters.ts, the same
  // rule as withdrawals). Anything else fails closed.
  if (!sponsoredWithoutCharge(WALLET_CHAIN_ID, op.paymasterAndData, input.sponsors))
    throw new LimitCheckError(
      'The network fee isn’t covered by the approved sponsor; the wallet could be charged.',
    );
  // Also deploying the wallet: only the pinned factory with exactly our owners and index, as for
  // withdrawals (withdraw.ts deploysOwnWallet).
  if (
    (op.initCode ?? '0x') !== '0x' &&
    !deploysOwnWallet(op.initCode as Hex, input.owner, input.agentId)
  )
    throw new LimitCheckError('The operation would set up the wallet with other owners.');
  const permission = revokedPermission(op.callData);
  if (!permission)
    throw new LimitCheckError('The operation does something other than revoking this limit.');
  if (
    spendPermissionHash(WALLET_CHAIN_ID, permission) !== limit.permissionHash.toLowerCase() ||
    permission.account !== wallet ||
    permission.token !== getAddress(USDC.address) ||
    permission.allowance !== BigInt(limit.allowanceRaw) ||
    permission.period !== limit.periodSeconds
  )
    throw new LimitCheckError('The operation revokes a different limit.');
  // The call data must be exactly the wallet executing that revoke: nothing riding along.
  const call = revokeCall(WALLET_CHAIN_ID, permission);
  const exact = encodeFunctionData({
    abi: walletAbi,
    functionName: 'execute',
    args: [call.target, call.value, call.data],
  });
  if (op.callData.toLowerCase() !== exact.toLowerCase())
    throw new LimitCheckError('The operation does something other than revoking this limit.');
  let hash: Hex;
  try {
    hash = checkRevokeOperation(WALLET_CHAIN_ID, request.userOperation, { wallet, permission });
  } catch {
    throw new LimitCheckError('The operation does something other than revoking this limit.');
  }
  if (typeof request.userOpHash !== 'string' || hash !== request.userOpHash.toLowerCase())
    throw new LimitCheckError('The operation doesn’t match its hash.');
  return hash;
}

/**
 * A wallet another key owns (an agent's identity wallet, say): this key's signature would be
 * refused, so nothing is signed. Defense in depth: the reported owner isn't proof of Base's.
 */
function ownsWallet(privateKey: Hex, signer: string | undefined) {
  if (signer !== undefined && privateKeyToAccount(privateKey).address !== getAddress(signer))
    throw new LimitCheckError('Your wallet key isn’t this wallet’s owner, so nothing was signed.');
}

/**
 * Unlocks the owner key with the password, signs the checked limit (the wallet's typed-data
 * wrapper around its hash) and stores it. The key never leaves this function.
 */
export async function signLimit(
  agentId: string,
  checked: CheckedLimit,
  password: string,
  /** False once the screen locked (hidden, idle, left): then nothing is signed or sent. */
  alive: () => boolean = () => true,
  /** The wallet's owner key as the wallet reports it: the unlocked key must be it. */
  signer?: string,
  /** Runs once the signature is made, right before it is sent (keep the confirmed key first). */
  beforeSend: () => void = () => {},
) {
  if (!alive()) throw new WithdrawalLockedError();
  const privateKey = await unlockVault(password);
  if (!alive()) throw new WithdrawalLockedError();
  ownsWallet(privateKey, signer);
  const signature = await signTypedData({ privateKey, ...checked.typedData });
  if (!alive()) throw new WithdrawalLockedError();
  beforeSend();
  return api<Omit<LimitView, 'onchain' | 'calendar' | 'revoke'>>(base(agentId), {
    permission: permissionToJson(checked.permission),
    capRaw: checked.capRaw,
    period: checked.period,
    signature,
  });
}

/**
 * Unlocks the owner key with the password, signs the already-checked revoke hash (raw, no prefix:
 * a Coinbase Smart Wallet checks exactly that hash) and sends the signature. The key never leaves
 * this function.
 */
export async function signRevoke(
  agentId: string,
  permissionId: string,
  hash: Hex,
  password: string,
  alive: () => boolean = () => true,
  signer?: string,
) {
  if (!alive()) throw new WithdrawalLockedError();
  const privateKey = await unlockVault(password);
  if (!alive()) throw new WithdrawalLockedError();
  ownsWallet(privateKey, signer);
  const signature = await sign({ hash, privateKey, to: 'hex' });
  if (!alive()) throw new WithdrawalLockedError();
  return api<{ permissionId: string; state: LimitState; revoke: LimitRevoke }>(
    `${base(agentId)}/${encodeURIComponent(permissionId)}/revoke/signature`,
    { signature },
  );
}
