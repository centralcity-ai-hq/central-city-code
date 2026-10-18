import { formatUnits } from 'viem';
import { usdcText } from '../../base/wallet/limits';
import {
  sentStatus,
  type LaneRecord,
  type WithdrawalAnchor,
  type WithdrawalToken,
  type WithdrawalView,
} from '../../base/wallet/withdraw';

/*
 * History (pay without waiting, lanes on), without React: what a line says, which lines show, which
 * operations are read by themselves, and when the open list is read next. WalletHistory.tsx keeps
 * the state and the timers; everything it decides is here.
 */

/** Every 3 s while one is on its way. */
export const POLL_MS = 3_000;
/** About every 12 s once all are settled at Base's safe head (or the list can't be read). */
export const SAFE_POLL_MS = 12_000;
/** Lines shown at once; the rest are counted. */
export const SHOWN_MAX = 20;
/** Operations that left the open list, read by themselves per tick (the rest next tick). */
export const OUTCOME_READS_PER_TICK = 4;
/** How long a finished line stays, saying how it ended, before it leaves the list. */
export const DONE_SHOWN_MS = 20_000;

export interface Line {
  view: WithdrawalView;
  /** As this browser checked and signed it: the only operation its cancel binds to. */
  record?: LaneRecord;
  payment?: WithdrawalAnchor['payment'];
  at: number;
}

const DECIMALS: Record<WithdrawalToken, number> = { USDC: 6, ETH: 18 };
/** As the status screens show them (WithdrawalStatus.tsx shortHex, shownAmount). */
const shortHex = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
const shownAmount = (raw: bigint, token: WithdrawalToken) => {
  const text = formatUnits(raw, DECIMALS[token]);
  // Exact: every digit that is signed is shown (at least two decimals).
  return token === 'USDC' ? usdcText(raw) : text;
};

export const sameHash = (a: { userOpHash: string }, b: { userOpHash: string }) =>
  a.userOpHash.toLowerCase() === b.userOpHash.toLowerCase();

export const nounOf = (line: Pick<Line, 'payment'>) => (line.payment ? 'payment' : 'withdrawal');

const toOf = (line: Pick<Line, 'payment' | 'view'>) =>
  line.payment ? line.payment.name.trim() || `CC-${line.payment.short}` : shortHex(line.view.to);

/** "12.50 USDC to Harbor" (or to the short address). */
export const textOf = (line: Pick<Line, 'payment' | 'view'>) =>
  `${shownAmount(BigInt(line.view.amount.raw), line.view.token)} ${line.view.token} to ${toOf(line)}`;

/** The line's state, in exactly the words the status screens use (withdraw.ts sentStatus). */
export const stateOf = (line: Pick<Line, 'payment' | 'view'>) =>
  line.view.state === 'awaiting_signature'
    ? { ...sentStatus(line.view, nounOf(line)), short: NOT_SENT_YET }
    : sentStatus(line.view, nounOf(line));

/** Kept here, its signature's answer unclear, and the server still awaits it. */
export const NOT_SENT_YET = 'Not sent yet';

/** Basescan, and only Basescan, for an operation in a block. */
export const explorerOf = (view: Pick<WithdrawalView, 'blockNumber' | 'explorerUrl'>) =>
  view.blockNumber !== null &&
  typeof view.explorerUrl === 'string' &&
  /^https:\/\/(sepolia\.)?basescan\.org\/tx\/0x[0-9a-fA-F]{64}$/.test(view.explorerUrl)
    ? view.explorerUrl
    : null;

/**
 * A line, as read now: this browser's record binds only while its hash is the server's; the names
 * come from the record, the server, what was shown before, or a released one, in that order.
 */
export function merged(
  before: Line | undefined,
  view: WithdrawalView,
  record: LaneRecord | undefined,
  payment?: WithdrawalAnchor['payment'],
  at?: number,
): Line {
  const mine = record && sameHash(record, view) ? record : before?.record;
  return {
    view,
    record: mine && sameHash(mine, view) ? mine : undefined,
    payment: mine?.payment ?? view.payment ?? before?.payment ?? payment,
    at: before?.at ?? mine?.signedAt ?? at ?? view.createdAt,
  };
}

/**
 * Lines finished at least DONE_SHOWN_MS ago leave (they are in the wallet's own history now); the
 * rest, newest first, each marked done when it is. `done`: when each was first seen done.
 */
export function visibleLines(
  known: Map<string, Line>,
  done: Map<string, number>,
  now = Date.now(),
): Array<Line & { done: boolean }> {
  for (const [id, at] of done) if (now - at >= DONE_SHOWN_MS) known.delete(id);
  return [...known.values()]
    .sort((a, b) => b.at - a.at)
    .map((line) => ({ ...line, done: done.has(line.view.withdrawalId) }));
}

/** When the next finished line leaves, in ms from `now`; null when none is showing. */
export function nextSweep(known: Map<string, Line>, done: Map<string, number>, now = Date.now()) {
  const left = [...done.entries()]
    .filter(([id]) => known.has(id))
    .map(([, at]) => at + DONE_SHOWN_MS - now);
  return left.length ? Math.max(250, Math.min(...left)) : null;
}

/**
 * The operations read by themselves this tick: shown or kept here (signed here, or released), not
 * done, and not in the open list (`listed` null: the list couldn't be read, so none is in it).
 */
export function toReadAlone(
  known: Map<string, Line>,
  done: Map<string, number>,
  listed: ReadonlySet<string> | null,
  kept: ReadonlyArray<{ withdrawalId: string }>,
): string[] {
  const left = new Set<string>();
  const out = (id: string) => !done.has(id) && !listed?.has(id);
  for (const id of known.keys()) if (out(id)) left.add(id);
  for (const entry of kept) if (out(entry.withdrawalId)) left.add(entry.withdrawalId);
  return [...left].slice(0, OUTCOME_READS_PER_TICK);
}

/**
 * When to read again: null when nothing is on its way (nor kept here unfinished); every POLL_MS
 * while the list reads and one is still moving; SAFE_POLL_MS once all are settled at the safe head,
 * or while the list can't be read.
 */
export function pollDelay(
  known: Map<string, Line>,
  done: Map<string, number>,
  keptOpen: boolean,
  listed: boolean,
): number | null {
  const live = [...known.entries()].filter(([id]) => !done.has(id)).map(([, line]) => line);
  if (!live.length && !keptOpen) return null;
  const moving = live.some((line) => !stateOf(line).released);
  return listed && moving ? POLL_MS : SAFE_POLL_MS;
}
