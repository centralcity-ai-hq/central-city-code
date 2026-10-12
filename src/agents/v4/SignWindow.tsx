import { useEffect, useState } from 'react';
import { clockOffset, serverNow } from '../../shell/serverClock';
import { SIGNING_CLOCK_SKEW_MS } from '../../base/wallet/withdraw';

/*
 * K9: with lanes on, a prepared operation's covered fee is valid for about two minutes (the
 * server's fixed deadline, `expiresAt`). The review step says how long is left; at 0 nothing can
 * be signed and the screen offers to prepare it again. The deadline never slides.
 */

/** From this many seconds left the line turns amber. */
export const SIGN_WINDOW_LOW_SECONDS = 20;

/**
 * Whole seconds left until `expiresAt` (ms, the server's clock), ticking once a second; null when
 * there is none. Counted on the server's clock as the browser estimates it (serverClock.ts), so a
 * device clock that runs fast or slow shows the time actually left.
 */
export function useSecondsLeft(expiresAt: number | null, now: () => number = serverNow) {
  const left = () =>
    expiresAt === null ? null : Math.max(0, Math.ceil((expiresAt - now()) / 1000));
  const [seconds, setSeconds] = useState(left);
  useEffect(() => {
    setSeconds(left());
    if (expiresAt === null) return;
    const timer = window.setInterval(() => {
      const next = left();
      setSeconds(next);
      if (next === 0) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAt]);
  return seconds;
}

/** "1:45" for 105 seconds. */
export function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** The device clock is off by more than the browser's signing check tolerates (K8). */
export const CLOCK_OFF =
  'This device’s clock is off by more than a minute, so it can’t sign this. Set the clock to automatic time and prepare again.';

/** The quiet "Sign within 1:45" next to the buttons. */
export function SignWithin({ seconds }: { seconds: number }) {
  const low = seconds <= SIGN_WINDOW_LOW_SECONDS;
  if (Math.abs(clockOffset()) > SIGNING_CLOCK_SKEW_MS)
    return (
      <span className="w4-timer" data-low="" role="status">
        <i aria-hidden="true" />
        {CLOCK_OFF}
      </span>
    );
  return (
    <span className="w4-timer" data-low={low ? '' : undefined} role="timer" aria-live="off">
      <i aria-hidden="true" />
      Sign within {clock(seconds)}
    </span>
  );
}

/** At 0: nothing was signed; one way on. */
export function SignWindowClosed({
  what,
  busy,
  onPrepareAgain,
  onBack,
}: {
  what: string;
  busy: boolean;
  onPrepareAgain: () => void;
  onBack: () => void;
}) {
  return (
    <>
      <div className="w4-expired" role="status">
        <b>Time to sign ran out. Nothing was signed.</b> The covered fee is valid for about a
        minute. Prepare it again to {what}.
      </div>
      <div className="ap4-actions">
        <button
          type="button"
          className="ap4-btn"
          disabled={busy}
          aria-busy={busy}
          onClick={onPrepareAgain}
        >
          {busy ? 'Preparing…' : 'Prepare again'}
        </button>
        <button type="button" className="ap4-btn ap4-ghost" disabled={busy} onClick={onBack}>
          Back
        </button>
      </div>
    </>
  );
}
