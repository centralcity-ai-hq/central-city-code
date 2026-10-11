/*
 * Base Wallet · the balance over the last 24 hours (the product owner, 10 Oct 2026; the approved
 * Base Wallet mockup, v6). Always the same width: the window ending `now`. The line starts at the
 * balance the window opened with (read from Base, never a made-up zero) and steps at each transfer
 * since, with soft corners, over a faint fill. It draws itself in once; each transfer is a dot.
 *
 * Moving a pointer or a finger across it scrubs: a dashed cursor and a dot follow, snapping to a
 * transfer within 10 px, and `onScrub` reports the time, the balance then and which transfer (its
 * index in `transfers`), or null when the pointer leaves. The parent rolls its balance and
 * highlights the row from that. With no transfer in the window this renders nothing (the parent
 * says "No transfers in the last 24 hours"). Under prefers-reduced-motion the line is drawn at once.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  DAY_MS,
  balanceAt,
  linePath,
  lineScale,
  lineTicks,
  scrubPoint,
  windowTransfers,
  type ScrubPoint,
  type WalletTransfer,
} from './walletVisualModel';
import './wallet-visual.css';

export { balanceAt, linePath, lineScale, windowTransfers } from './walletVisualModel';
export type { WalletTransfer, WalletTransferKind } from './walletVisualModel';

export type BalanceScrub = {
  /** The moment shown, ms since the epoch (a snapped transfer's own time). */
  at: number;
  /** The balance at that moment, USDC. */
  balance: number;
  /** The snapped transfer's index in `transfers`, or null between transfers. */
  transfer: number | null;
};

export interface BalanceLineProps {
  /** The balance when the window opened (`now - windowMs`), read from Base. */
  startBalance: number;
  /** Transfers of this address; those outside the window are left out. */
  transfers: readonly WalletTransfer[];
  /** The end of the window, ms since the epoch. */
  now: number;
  /** The window's length; 24 hours. */
  windowMs?: number;
  onScrub?: (state: BalanceScrub | null) => void;
  /** What a screen reader hears for the line. */
  label?: string;
  className?: string;
}

const LABEL =
  'The balance over the last 24 hours, from Base transfers. Move across it to see the balance at a time.';

export function BalanceLine({
  startBalance,
  transfers,
  now,
  windowMs = DAY_MS,
  onScrub,
  label = LABEL,
  className,
}: BalanceLineProps) {
  const list = useMemo(() => windowTransfers(transfers, now, windowMs), [transfers, now, windowMs]);
  const empty = list.length === 0;
  const from = now - windowMs;
  const boxRef = useRef<HTMLDivElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [drawn, setDrawn] = useState(false);
  const [scrub, setScrub] = useState<ScrubPoint | null>(null);
  const gradient = `wv-fade-${useId().replace(/[^\w-]/g, '')}`;

  const scale = useMemo(
    () =>
      size && size.width > 0
        ? lineScale({ startBalance, transfers: list, from, to: now, ...size })
        : null,
    [startBalance, list, from, now, size],
  );

  // The scrub reads the latest values from a frame callback, so they live in a ref too.
  const latest = useRef({ startBalance, list, scale, from, windowMs, onScrub });
  useLayoutEffect(() => {
    latest.current = { startBalance, list, scale, from, windowMs, onScrub };
  });

  // The width follows the column; the height is the stylesheet's.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const measure = () => {
      const width = box.clientWidth;
      const height = box.clientHeight || 52;
      setSize((prev) =>
        prev && prev.width === width && prev.height === height ? prev : { width, height },
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [empty]);

  // Draw the line in once, after it has been laid out undrawn.
  const ready = scale !== null;
  useEffect(() => {
    if (!ready || drawn) return;
    const frame = requestAnimationFrame(() => {
      if (pathRef.current) void getComputedStyle(pathRef.current).strokeDashoffset;
      setDrawn(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [ready, drawn]);

  const frame = useRef(0);
  const target = useRef<number | null>(null);
  const active = useRef(false);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  function timeAt(clientX: number): number {
    const { from: start, windowMs: span } = latest.current;
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return start + span;
    return start + Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * span;
  }
  function show(t: number) {
    const { startBalance: start, list: shown, scale: drawnScale, onScrub: report } = latest.current;
    if (!drawnScale || !shown.length) return;
    active.current = true;
    const point = scrubPoint(start, shown, drawnScale, t);
    setScrub(point);
    report?.({
      at: point.at,
      balance: point.balance,
      transfer: point.near >= 0 ? shown[point.near].index : null,
    });
  }
  function rest() {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    target.current = null;
    if (!active.current) return;
    active.current = false;
    setScrub(null);
    latest.current.onScrub?.(null);
  }
  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    target.current = timeAt(event.clientX);
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (target.current !== null) show(target.current);
    });
  }
  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    show(timeAt(event.clientX));
  }
  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType !== 'mouse') rest();
  }

  if (empty) return null;

  const width = scale?.width ?? 0;
  const height = scale?.height ?? 0;
  const d = scale ? linePath(startBalance, list, scale) : '';
  const zero = scale ? scale.y(0) : 0;
  const cursorX = scale && scrub ? scale.x(scrub.at) : 0;
  const ticks = lineTicks(windowMs);
  const classes = ['wv-line', className].filter(Boolean).join(' ');

  return (
    <div
      ref={boxRef}
      className={classes}
      role="img"
      aria-label={label}
      data-drawn={drawn ? '' : undefined}
      data-scrubbing={scrub ? '' : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={rest}
      onPointerCancel={rest}
    >
      {scale ? (
        <svg
          className="wv-line-svg"
          width={width}
          height={height}
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="currentColor" stopOpacity={0.09} />
              <stop offset="1" stopColor="currentColor" stopOpacity={0} />
            </linearGradient>
          </defs>
          <line className="wv-line-base" x1={0} x2={width} y1={zero} y2={zero} />
          <path
            className="wv-line-area"
            d={`${d} L${width} ${height} L0 ${height} Z`}
            fill={`url(#${gradient})`}
          />
          <path ref={pathRef} className="wv-line-path" d={d} pathLength={1} />
          {list.map((transfer, index) => (
            <circle
              key={transfer.index}
              className="wv-line-ev"
              data-hot={scrub?.near === index ? '' : undefined}
              cx={scale.x(transfer.at)}
              cy={scale.y(balanceAt(startBalance, list, transfer.at))}
              r={2.4}
            />
          ))}
          <line className="wv-line-cursor" x1={cursorX} x2={cursorX} y1={0} y2={height} />
          <circle
            className="wv-line-dot"
            cx={cursorX}
            cy={scale && scrub ? scale.y(scrub.balance) : 0}
            r={3}
          />
        </svg>
      ) : null}
      <div className="wv-line-ticks" aria-hidden="true">
        <span>{ticks[0]}</span>
        <span>{ticks[1]}</span>
        <span>{ticks[2]}</span>
      </div>
    </div>
  );
}
