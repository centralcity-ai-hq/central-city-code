/*
 * Base Wallet visuals: the pure parts of the odometer, the 24-hour balance line, the backup key
 * reveal and the assembling QR (the approved Base Wallet mockup, v6). No DOM and no React here,
 * so the tests read the same numbers the components draw.
 */
import { backupGroups } from '../../vault/backupKey';

/* ---------- odometer ---------- */

/** Each digit column starts this much after the one to its right. */
export const ODOMETER_STAGGER_MS = 28;

export type OdometerCell =
  | { kind: 'digit'; digit: number; key: string; delayMs: number }
  | { kind: 'char'; char: string; key: string };

/**
 * The columns of a value: a digit becomes a 0–9 column that rolls to `digit`, anything else ("."
 * or ",") stays still. Keys count from the right, so when the length changes the columns keep
 * their place against the right edge, as the mockup's re-roll does.
 */
export function odometerCells(value: string): OdometerCell[] {
  const chars = [...value];
  const n = chars.length;
  return chars.map((char, index) => {
    const fromRight = n - 1 - index;
    return /\d/.test(char)
      ? {
          kind: 'digit',
          digit: Number(char),
          key: `d${fromRight}`,
          delayMs: fromRight * ODOMETER_STAGGER_MS,
        }
      : { kind: 'char', char, key: `c${fromRight}` };
  });
}

/**
 * Where a new digit column starts rolling from: the previous value's digit at the same place
 * counted from the right, or 0 when there was none (or it wasn't a digit).
 */
export function odometerStartDigit(previous: string, length: number, index: number): number {
  const prev = [...previous];
  const char = prev[prev.length - length + index];
  return char !== undefined && /\d/.test(char) ? Number(char) : 0;
}

/* ---------- the 24-hour balance line ---------- */

export const DAY_MS = 86_400_000;
/** A pointer this close (CSS px) to a transfer's dot snaps to the transfer. */
export const SNAP_PX = 10;

export type WalletTransferKind = 'received' | 'spent' | 'withdrawn';
export type WalletTransfer = {
  /** When it happened, ms since the epoch. */
  at: number;
  /** Signed USDC: positive in, negative out. */
  amount: number;
  kind: WalletTransferKind;
  label: string;
};
/** A transfer inside the window, with its place in the list the caller passed. */
export type WindowTransfer = WalletTransfer & { index: number };

type Step = Pick<WalletTransfer, 'at' | 'amount'>;

/** USDC has 6 decimals: sums are rounded there, so 8 + 28.2 − 3 is 33.2 and not 33.199999…. */
const usdc = (value: number) => Math.round(value * 1e6) / 1e6;

/**
 * The balance at time `t`: the balance the window starts with plus every transfer up to and
 * including `t`. Before the first transfer that is `start`; after the last, the balance now.
 */
export function balanceAt(start: number, transfers: readonly Step[], t: number): number {
  let sum = start;
  for (const transfer of transfers) if (transfer.at <= t) sum += transfer.amount;
  return usdc(sum);
}

/**
 * The transfers the line shows: after the window opened (`now - windowMs`, whose balance is the
 * start balance) up to and including `now`, oldest first.
 */
export function windowTransfers(
  transfers: readonly WalletTransfer[],
  now: number,
  windowMs: number = DAY_MS,
): WindowTransfer[] {
  const from = now - windowMs;
  return transfers
    .map((transfer, index) => ({ ...transfer, index }))
    .filter((transfer) => transfer.at > from && transfer.at <= now)
    .sort((a, b) => a.at - b.at || a.index - b.index);
}

export type LineScale = {
  width: number;
  height: number;
  from: number;
  to: number;
  x: (t: number) => number;
  y: (balance: number) => number;
};

/**
 * Time to x across the whole width (the window, oldest at 0, now at `width`) and balance to y,
 * zero at the bottom and the highest balance 8% under the top, as in the mockup.
 */
export function lineScale(options: {
  startBalance: number;
  transfers: readonly Step[];
  from: number;
  to: number;
  width: number;
  height: number;
  pad?: number;
}): LineScale {
  const { startBalance, transfers, from, to, width, height, pad = 4 } = options;
  const balances = [startBalance];
  let running = startBalance;
  for (const transfer of transfers) balances.push((running = usdc(running + transfer.amount)));
  const lo = Math.min(0, ...balances);
  let hi = Math.max(0, ...balances) * 1.08;
  if (!(hi > lo)) hi = lo + 1;
  const span = to - from || 1;
  return {
    width,
    height,
    from,
    to,
    x: (t) => (Math.max(0, Math.min(span, t - from)) / span) * width,
    y: (balance) => height - pad - ((balance - lo) / (hi - lo)) * (height - pad * 2),
  };
}

const n2 = (value: number) => String(Math.round(value * 100) / 100);

/**
 * The line as an SVG path: it holds the balance, then steps at each transfer with a soft corner
 * pair (one cubic curve), from the window's start at x 0 to now at the full width. Corners never
 * reach past the next transfer, so two close transfers still read as two steps.
 */
export function linePath(
  startBalance: number,
  transfers: readonly Step[],
  scale: LineScale,
): string {
  const { width, x, y } = scale;
  const radius = Math.min(7, width / 70);
  const xs = transfers.map((transfer) => x(transfer.at));
  let d = `M0 ${n2(y(startBalance))}`;
  let balance = startBalance;
  transfers.forEach((transfer, index) => {
    const ex = xs[index];
    const before = index > 0 ? (ex - xs[index - 1]) / 2 : radius;
    const after = index < xs.length - 1 ? (xs[index + 1] - ex) / 2 : radius;
    const r = Math.max(0, Math.min(radius, before, after));
    const next = usdc(balance + transfer.amount);
    const y0 = n2(y(balance));
    const y1 = n2(y(next));
    d +=
      ` L${n2(Math.max(0, ex - r))} ${y0}` +
      ` C${n2(ex)} ${y0} ${n2(ex)} ${y1} ${n2(Math.min(width, ex + r))} ${y1}`;
    balance = next;
  });
  return `${d} L${n2(width)} ${n2(y(balance))}`;
}

export type ScrubPoint = { at: number; balance: number; near: number };

/**
 * What the scrub shows at time `t`: a transfer whose dot is within SNAP_PX of the pointer snaps
 * the cursor to it (the nearest one; `near` is its place in `transfers`, else -1), and the
 * balance is read at that moment.
 */
export function scrubPoint(
  startBalance: number,
  transfers: readonly Step[],
  scale: LineScale,
  t: number,
): ScrubPoint {
  const px = scale.x(t);
  let near = -1;
  let best = SNAP_PX;
  transfers.forEach((transfer, index) => {
    const distance = Math.abs(scale.x(transfer.at) - px);
    if (distance < best) {
      best = distance;
      near = index;
    }
  });
  const at = near >= 0 ? transfers[near].at : t;
  return { at, balance: balanceAt(startBalance, transfers, at), near };
}

/** The tick labels under the line: "24h ago · 12h · Now" for the usual day. */
export function lineTicks(windowMs: number = DAY_MS): [string, string, string] {
  const hours = windowMs / 3_600_000;
  const label = (h: number) => `${Math.round(h * 10) / 10}h`;
  return [`${label(hours)} ago`, label(hours / 2), 'Now'];
}

/* ---------- the backup key, decoded ---------- */

/** The 16 groups of 4 (src/base/vault/backupKey.ts), without the 0x. */
export const keyGroups = backupGroups;

const HEX = '0123456789abcdef';
/** Character `i` of the key settles this long after the reveal starts. */
export const settleMs = (index: number) => index * 16 + 220;
/** When the last of the 64 characters has settled. */
export const DECODE_MS = settleMs(63);

/**
 * One frame of the decode: each character is random hex noise until its settle time, then the
 * real one. `done` once every character has settled.
 */
export function decodeFrame(
  groups: readonly string[],
  elapsedMs: number,
  random: () => number = Math.random,
): { cells: string[]; done: boolean } {
  let done = true;
  const cells = groups.map((group, groupIndex) => {
    let out = '';
    for (let i = 0; i < group.length; i++) {
      if (elapsedMs >= settleMs(groupIndex * group.length + i)) out += group[i];
      else {
        done = false;
        out += HEX[Math.floor(random() * 16) % 16];
      }
    }
    return out;
  });
  return { cells, done };
}

/* ---------- the QR that assembles ---------- */

/** The three 7×7 finder squares in the corners (not the bottom right). */
export function isFinder(row: number, col: number, count: number): boolean {
  return (row < 7 && col < 7) || (row < 7 && col >= count - 7) || (row >= count - 7 && col < 7);
}

export type QrModule = {
  /** Where it settles (CSS px, top left of its cell). */
  x: number;
  y: number;
  /** Where it flies in from. */
  fx: number;
  fy: number;
  /** When it starts flying, ms after the start. */
  delay: number;
  finder: boolean;
};

/** One flight lasts this long. */
export const QR_FLIGHT_MS = 700;

/**
 * The dark modules of a QR matrix, each with a scattered start: the finder squares first, then
 * the data from the middle outwards with a little jitter.
 */
export function qrModules(
  matrix: readonly (readonly boolean[])[],
  size: number,
  random: () => number = Math.random,
): QrModule[] {
  const n = matrix.length;
  const cell = size / n;
  const modules: QrModule[] = [];
  matrix.forEach((row, r) =>
    row.forEach((dark, c) => {
      if (!dark) return;
      const finder = isFinder(r, c, n);
      const angle = random() * Math.PI * 2;
      const distance = 60 + random() * 140;
      modules.push({
        x: c * cell,
        y: r * cell,
        fx: c * cell + Math.cos(angle) * distance,
        fy: r * cell + Math.sin(angle) * distance,
        delay: finder
          ? random() * 120
          : 160 + Math.hypot(r - n / 2, c - n / 2) * 18 + random() * 220,
        finder,
      });
    }),
  );
  return modules;
}

/** Ease-out quart: fast start, soft landing. */
export const easeOutQuart = (t: number) => 1 - Math.pow(1 - t, 4);
