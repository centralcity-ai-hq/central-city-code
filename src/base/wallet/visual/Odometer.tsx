/*
 * Base Wallet · the odometer (the approved Base Wallet mockup, v6): a number whose every digit is
 * a column of 0–9 that rolls to its value, right to left, ODOMETER_STAGGER_MS apart, with the
 * mockup's spring. Dots and commas stay still. When the length changes (9.99 → 10.00) the columns
 * keep their place against the right edge and a new column rolls in from the old digit there, or
 * from 0. `instant` jumps without rolling (a first paint, a value that isn't news).
 *
 * Screen readers get the plain value; the columns are hidden from them. Under
 * prefers-reduced-motion the digits change at once.
 */
import { useLayoutEffect, useRef } from 'react';
import { odometerCells, odometerStartDigit } from './walletVisualModel';
import { reducedMotion } from './motion';
import './wallet-visual.css';

export interface OdometerProps {
  /** The text to show, already formatted ("25.00", "18,402,113"). */
  value: string;
  className?: string;
  /** Jump to the value without rolling. */
  instant?: boolean;
}

const DIGITS = Array.from({ length: 10 }, (_, digit) => <i key={digit}>{digit}</i>);
const shift = (digit: number) => `translateY(${-digit}em)`;

export function Odometer({ value, className, instant = false }: OdometerProps) {
  const cells = odometerCells(value);
  const rootRef = useRef<HTMLSpanElement>(null);
  const strips = useRef(new Map<string, HTMLSpanElement>());
  const placed = useRef(new WeakSet<HTMLSpanElement>());
  const previous = useRef('');

  // A column that has just appeared starts at the old digit in its place and then rolls; one that
  // was already there rolls on from where it is (the browser's transition does that by itself).
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = value;
    const length = cells.length;
    const still = instant || reducedMotion();
    const fresh: Array<{ strip: HTMLSpanElement; from: number; to: number }> = [];
    cells.forEach((cell, index) => {
      if (cell.kind !== 'digit') return;
      const strip = strips.current.get(cell.key);
      if (!strip || placed.current.has(strip)) return;
      placed.current.add(strip);
      const from = odometerStartDigit(before, length, index);
      if (!still && from !== cell.digit) fresh.push({ strip, from, to: cell.digit });
    });
    if (!fresh.length) return;
    // transitionProperty is the one transition longhand React doesn't set here, so clearing it
    // afterwards leaves the stagger (transitionDelay) in place.
    for (const { strip, from } of fresh) {
      strip.style.transitionProperty = 'none';
      strip.style.transform = shift(from);
    }
    void rootRef.current?.offsetWidth;
    for (const { strip, to } of fresh) {
      strip.style.transitionProperty = '';
      strip.style.transform = shift(to);
    }
  }, [value, instant]); // eslint-disable-line react-hooks/exhaustive-deps -- cells come from value

  return (
    <span ref={rootRef} className={className ? `wv-odo ${className}` : 'wv-odo'}>
      <span className="visually-hidden">{value}</span>
      {cells.map((cell) =>
        cell.kind === 'digit' ? (
          <span key={cell.key} className="wv-odo-col" aria-hidden="true">
            <span
              ref={(strip) => {
                if (strip) strips.current.set(cell.key, strip);
                else strips.current.delete(cell.key);
              }}
              className="wv-odo-strip"
              style={{
                transform: shift(cell.digit),
                transitionDelay: `${instant ? 0 : cell.delayMs}ms`,
                transitionDuration: instant ? '0s' : undefined,
              }}
            >
              {DIGITS}
            </span>
          </span>
        ) : (
          <span key={cell.key} className="wv-odo-char" aria-hidden="true">
            {cell.char}
          </span>
        ),
      )}
    </span>
  );
}
