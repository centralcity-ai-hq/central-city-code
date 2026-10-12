/*
 * The Base registration as the client sees it: the server's identity view and the pure rules the
 * Base screen in My agents v4 follows. No React, no requests.
 */

/** Base mainnet: the only network the register route serves. */
export const BASE_MAINNET = 8453;
export const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
/** How long to wait before asking again when the server doesn't say. */
export const POLL_MS = 5000;
/** A server that names a shorter wait still gets at least this long between requests. */
export const MIN_POLL_MS = 1000;
/** After a server error while polling, the panel waits this long and then asks again. */
export const BACKOFF_MS = 30_000;
/** A request that hasn't answered by then is given up, so the next tick can ask again. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** The status read after a given-up request gets its own limit, so it can't hang the panel either. */
export const RECOVERY_TIMEOUT_MS = 15_000;

export type IdentityState = 'pending' | 'submitted' | 'confirmed' | 'failed';
export type Stage =
  | 'registering'
  | 'rechecking'
  | 'handing_over'
  | 'registered'
  | 'finalizing'
  | 'confirmed'
  | 'failed';
const STAGES: readonly string[] = [
  'registering',
  'rechecking',
  'handing_over',
  'registered',
  'finalizing',
  'confirmed',
  'failed',
];
// 'registered': Base has made the registration safe (about a minute in); final comes later.
const IN_PROGRESS: readonly Stage[] = [
  'registering',
  'rechecking',
  'handing_over',
  'registered',
  'finalizing',
];

/** The wallet the server bound to this agent. Older servers send only the address and state. */
export interface BoundWallet {
  address?: string | null;
  ownerAddress?: string | null;
  state?: string;
}
/**
 * One identity as the server reports it. Everything after agentUri is sent by newer servers only;
 * when it is missing the panel follows `state` and `erc8004AgentId` as it always did.
 */
export interface IdentityView {
  state: IdentityState;
  /** The final Base ID, once the registration can no longer change. */
  erc8004AgentId: string | null;
  agentUri: string;
  /** The Base ID from an included, verified registration; a replaced block can still change it. */
  provisionalAgentId?: string | null;
  stage?: string;
  finality?: 'included' | 'safe' | 'final' | null;
  /** True exactly when the server accepts a new attempt. */
  canRetry?: boolean;
  pollAfterMs?: number | null;
  mintTxHash?: string | null;
  txHash?: string | null;
  /** When the current attempt started (epoch ms), from servers that send it. */
  startedAt?: number | null;
  /** When the Base ID was first seen in a block (epoch ms), from servers that send it. */
  idSeenAt?: number | null;
}
export interface RegistrationRow extends IdentityView {
  chainId: number;
  wallet?: BoundWallet | null;
}
export interface RegisterReply {
  wallet?: BoundWallet | null;
  identity: IdentityView;
}
/** What the panel shows: always the whole of the latest answer, never pieces of older ones. */
export interface View {
  identity: IdentityView | null;
  wallet: BoundWallet | null;
}
/** The server refused the owner named here: the agent's wallet is already bound to another one. */
export interface Conflict {
  ownerAddress: string | null;
  retry: boolean;
}

export function stageOf(identity: IdentityView): Stage {
  if (identity.stage && STAGES.includes(identity.stage)) return identity.stage as Stage;
  if (identity.state === 'confirmed' || identity.state === 'failed') return identity.state;
  return identity.erc8004AgentId ? 'handing_over' : 'registering';
}

export function inProgress(identity: IdentityView | null): boolean {
  return identity !== null && IN_PROGRESS.includes(stageOf(identity));
}

/**
 * The Base ID the finished view shows, or null while the agent isn't finished yet. Once the
 * hand-over is in a block the agent is live and shows as finished; finality follows by itself.
 * While Base re-checks, only a final ID is shown: a provisional one can still change.
 */
export function finishedId(identity: IdentityView, stage: Stage): string | null {
  if (stage === 'confirmed' || stage === 'finalizing' || stage === 'registered')
    return identity.erc8004AgentId ?? identity.provisionalAgentId ?? null;
  if (stage === 'rechecking') return identity.erc8004AgentId;
  return null;
}

export const FINALIZING_INFO =
  'Live now. Base usually finalizes in 15–30 minutes, sometimes longer. Nothing to do: it finishes by itself and the public Central City passport appears.';

/** Older servers have no canRetry: a failure, or a registration not minted yet, could be retried. */
export function retryAllowed(identity: IdentityView, stage: Stage): boolean {
  if (typeof identity.canRetry === 'boolean') return identity.canRetry;
  return stage === 'failed' || !identity.erc8004AgentId;
}

export function pollDelay(identity: IdentityView | null): number {
  const after = identity?.pollAfterMs;
  return typeof after === 'number' && Number.isFinite(after)
    ? Math.max(MIN_POLL_MS, after)
    : POLL_MS;
}

export const validAddress = (value: unknown): string | null =>
  typeof value === 'string' && ADDRESS.test(value) ? value : null;
export const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
