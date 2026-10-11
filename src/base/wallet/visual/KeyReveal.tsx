/*
 * Base Wallet · the backup key, held to show (the product owner, 10 Oct 2026; the approved Base
 * Wallet mockup, v6). The key is 16 numbered groups of 4 in a 4-column grid, blurred dots until it
 * is shown. The "Press and hold to show" pill fills a ring over HOLD_MS while a pointer, Space or
 * Enter holds it and rewinds on release; when the ring is full each character decodes out of random
 * hex noise and settles in turn (walletVisualModel settleMs), then `onRevealed` is called.
 *
 * Until the ring is full the key is not in the page at all: the grid holds placeholders, not
 * hidden text. `data-state` on the root says hidden, decoding or revealed, and `data-revealed` is
 * "true" once every character has settled. A new `privateKey` hides the grid again. `children`
 * sit next to the pill (the screen's Copy key button). Under prefers-reduced-motion the hold still
 * takes HOLD_MS (it is the safety step, not decoration), and the key then appears at once.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { decodeFrame, keyGroups } from './walletVisualModel';
import { reducedMotion } from './motion';
import './wallet-visual.css';

export { keyGroups } from './walletVisualModel';

export interface KeyRevealProps {
  /** The owner key, 0x and 64 hex characters (src/base/vault/backupKey.ts). */
  privateKey: `0x${string}`;
  /** Called once, when every character has settled. */
  onRevealed?: () => void;
  /** Shown next to the hold pill. */
  children?: ReactNode;
}

type Phase = 'hidden' | 'decoding' | 'revealed';

/** Holding this long shows the key. */
export const HOLD_MS = 1100;
/** Letting go rewinds a full ring in this long. */
const REWIND_MS = 300;
const RING_R = 11;
const RING_C = 2 * Math.PI * RING_R;
const PLACEHOLDER = '••••';

export function KeyReveal({ privateKey, onRevealed, children }: KeyRevealProps) {
  const groups = useMemo(() => keyGroups(privateKey), [privateKey]);
  const [phase, setPhase] = useState<Phase>('hidden');
  const [cells, setCells] = useState<string[] | null>(null);
  const [shownKey, setShownKey] = useState(privateKey);
  if (shownKey !== privateKey) {
    setShownKey(privateKey);
    setPhase('hidden');
    setCells(null);
  }

  const progRef = useRef<SVGCircleElement>(null);
  const hold = useRef({ progress: 0, holding: false, last: 0, frame: 0 });
  const decodeFrameId = useRef(0);
  const phaseRef = useRef(phase);
  const onRevealedRef = useRef(onRevealed);
  const reported = useRef(false);
  useLayoutEffect(() => {
    phaseRef.current = phase;
    onRevealedRef.current = onRevealed;
  });

  // A new key (or leaving the screen) stops whatever was running and empties the ring.
  useEffect(() => {
    const state = hold.current;
    reported.current = false;
    return () => {
      cancelAnimationFrame(state.frame);
      cancelAnimationFrame(decodeFrameId.current);
      Object.assign(state, { progress: 0, holding: false, last: 0, frame: 0 });
      decodeFrameId.current = 0;
      paintRing(0);
    };
  }, [privateKey]);

  useEffect(() => {
    if (phase !== 'revealed' || reported.current) return;
    reported.current = true;
    onRevealedRef.current?.();
  }, [phase]);

  function paintRing(progress: number) {
    progRef.current?.style.setProperty('stroke-dashoffset', String(RING_C * (1 - progress)));
  }

  function decode() {
    setPhase('decoding');
    if (reducedMotion()) {
      setCells([...groups]);
      setPhase('revealed');
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const frame = decodeFrame(groups, now - start);
      setCells(frame.cells);
      if (frame.done) {
        decodeFrameId.current = 0;
        setPhase('revealed');
      } else decodeFrameId.current = requestAnimationFrame(step);
    };
    decodeFrameId.current = requestAnimationFrame(step);
  }

  function tick(now: number) {
    const state = hold.current;
    const dt = state.last ? now - state.last : 16;
    state.last = now;
    state.progress = Math.max(
      0,
      Math.min(1, state.progress + (state.holding ? dt / HOLD_MS : -dt / REWIND_MS)),
    );
    paintRing(state.progress);
    if (state.progress >= 1) {
      Object.assign(state, { holding: false, last: 0, frame: 0 });
      decode();
      return;
    }
    if (state.holding || state.progress > 0) state.frame = requestAnimationFrame(tick);
    else Object.assign(state, { last: 0, frame: 0 });
  }

  function press() {
    if (phaseRef.current !== 'hidden') return;
    const state = hold.current;
    state.holding = true;
    state.last = 0;
    if (!state.frame) state.frame = requestAnimationFrame(tick);
  }
  function release() {
    hold.current.holding = false;
  }

  function onPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    press();
  }
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    if (!event.repeat) press();
  }

  const done = phase !== 'hidden';
  return (
    <div
      className="wv-reveal"
      data-state={phase}
      data-revealed={phase === 'revealed' ? 'true' : 'false'}
    >
      <div
        className="wv-key"
        role="group"
        aria-label={`Backup key, ${groups.length} groups of 4 characters`}
        aria-busy={phase === 'decoding' || undefined}
      >
        {groups.map((group, index) => {
          const text = cells ? cells[index] : PLACEHOLDER;
          return (
            <span key={index} className="wv-key-group">
              <em>{index + 1}</em>
              <b
                className="wv-key-chars"
                data-noise={cells && text !== group ? '' : undefined}
                aria-hidden={phase === 'revealed' ? undefined : 'true'}
              >
                {text}
              </b>
            </span>
          );
        })}
      </div>
      <div className="wv-reveal-actions">
        <button
          type="button"
          className="wv-hold"
          data-done={done ? '' : undefined}
          aria-disabled={done || undefined}
          onPointerDown={onPointerDown}
          onPointerUp={release}
          onPointerLeave={release}
          onPointerCancel={release}
          onKeyDown={onKeyDown}
          onKeyUp={release}
          onBlur={release}
          onContextMenu={(event) => event.preventDefault()}
        >
          {done ? (
            'Shown once · save it now'
          ) : (
            <>
              <svg className="wv-hold-ring" viewBox="0 0 28 28" aria-hidden="true">
                <circle className="wv-hold-track" cx="14" cy="14" r={RING_R} />
                <circle
                  ref={progRef}
                  className="wv-hold-prog"
                  cx="14"
                  cy="14"
                  r={RING_R}
                  style={{ strokeDasharray: RING_C, strokeDashoffset: RING_C }}
                />
              </svg>
              Press and hold to show
            </>
          )}
        </button>
        {children}
      </div>
      <span className="visually-hidden" role="status">
        {phase === 'revealed' ? 'Backup key shown.' : ''}
      </span>
    </div>
  );
}
