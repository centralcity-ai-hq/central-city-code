/*
 * Base Wallet · the deposit QR (the approved Base Wallet mockup, v6). Drawn on a canvas: the dark
 * modules fly in from scattered places and settle, the three finder squares first (solid squares)
 * and then the data from the middle outwards (near-square, a hair rounded). Settled modules
 * overlap by a fraction of a pixel, so the code scans with no seams. The card then leans toward
 * the pointer, up to 7° each way, with a soft sheen where the light would fall.
 *
 * The card is white in both themes and the modules near-black: a QR must stay dark on light to
 * scan. The canvas is an image named by the address. Under prefers-reduced-motion the code is
 * drawn settled at once and the card doesn't tilt.
 */
import { useEffect, useMemo, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { QR_FLIGHT_MS, easeOutQuart, qrModules } from './walletVisualModel';
import { qrMatrix } from './qrMatrix';
import { reducedMotion } from './motion';
import './wallet-visual.css';

export interface AssembledQRProps {
  /** What the code holds, e.g. "ethereum:0x…@8453" (EIP-681: the address on Base). */
  value: string;
  /** The code's side in CSS px, without the card's padding. */
  size?: number;
  /** What a screen reader hears; by default "QR code of the address 0x…". */
  label?: string;
  className?: string;
}

/** Near-black on the white card, in both themes. */
const QR_INK = '#111113';
/** Degrees of tilt per unit of pointer offset from the centre (±0.5 → ±7°). */
const TILT_DEG = 14;

/** The address inside an EIP-681 link ("ethereum:0xabc…@84532" → "0xabc…"), else the text. */
export function qrAddress(value: string): string {
  return value.replace(/^ethereum:/i, '').replace(/[@/?].*$/, '');
}

export function AssembledQR({ value, size = 184, label, className }: AssembledQRProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const sheenRef = useRef<HTMLSpanElement>(null);
  const matrix = useMemo(() => {
    try {
      return qrMatrix(value);
    } catch {
      return null; // too long for a QR code: the card stays blank
    }
  }, [value]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, size, size);
    if (!matrix) return;
    const cell = size / matrix.length;
    const modules = qrModules(matrix, size);
    const still = reducedMotion();
    const start = performance.now();
    let frame = 0;
    const paint = (now: number) => {
      context.clearRect(0, 0, size, size);
      context.fillStyle = QR_INK;
      let done = true;
      for (const piece of modules) {
        let p = still ? 1 : (now - start - piece.delay) / QR_FLIGHT_MS;
        if (p < 1) done = false;
        p = Math.max(0, Math.min(1, p));
        if (p === 0) continue;
        const e = easeOutQuart(p);
        const x = piece.fx + (piece.x - piece.fx) * e;
        const y = piece.fy + (piece.y - piece.fy) * e;
        // In flight a module is smaller; settled it is a hair bigger than its cell, so they touch.
        const side = cell * (0.4 + 0.6 * e) + (p === 1 ? 0.6 : 0);
        const radius = piece.finder ? 0 : cell * 0.14 * (1 - e) + cell * 0.08;
        const left = x + (cell - side) / 2;
        const top = y + (cell - side) / 2;
        context.globalAlpha = Math.min(1, p * 2);
        context.beginPath();
        if (radius > 0 && typeof context.roundRect === 'function')
          context.roundRect(left, top, side, side, radius);
        else context.rect(left, top, side, side);
        context.fill();
      }
      context.globalAlpha = 1;
      frame = done ? 0 : requestAnimationFrame(paint);
    };
    if (still) paint(start);
    else frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [matrix, size]);

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const card = cardRef.current;
    if (!card || reducedMotion()) return;
    const rect = card.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const clamp = (n: number) => Math.max(-0.5, Math.min(0.5, n));
    const px = clamp((event.clientX - rect.left) / rect.width - 0.5);
    const py = clamp((event.clientY - rect.top) / rect.height - 0.5);
    card.style.transition = 'transform .08s linear';
    card.style.transform = `rotateY(${px * TILT_DEG}deg) rotateX(${-py * TILT_DEG}deg) translateZ(0)`;
    sheenRef.current?.style.setProperty('--sx', `${(px + 0.5) * 100}%`);
    sheenRef.current?.style.setProperty('--sy', `${(py + 0.5) * 100}%`);
  }
  function onPointerLeave() {
    const card = cardRef.current;
    if (!card) return;
    card.style.transition = '';
    card.style.transform = '';
  }

  return (
    <div
      className={className ? `wv-qr ${className}` : 'wv-qr'}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      <div ref={cardRef} className="wv-qr-card">
        <canvas
          ref={canvasRef}
          className="wv-qr-canvas"
          role="img"
          aria-label={label ?? `QR code of the address ${qrAddress(value)}`}
          style={{ width: size, height: size }}
        />
        <span ref={sheenRef} className="wv-qr-sheen" aria-hidden="true" />
      </div>
    </div>
  );
}
