import { useCallback, useEffect, useRef, useState } from 'react';

/** A typed password goes after this long without a key press or tap, as on the wallet key. */
export const IDLE_LOCK_MS = 5 * 60_000;

/**
 * The wallet password typed on a signing screen, and when it goes: the page is hidden or left,
 * IDLE_LOCK_MS pass without input, or the screen closes. `alive()` marks a signing as it starts;
 * the mark it returns is false once the password went meanwhile, so a signature made in between is
 * dropped, never sent (signAndSend's `alive`). `busy`: a signing is under way, so the page is
 * watched even after the field was cleared.
 */
export function usePasswordLock(busy: boolean) {
  const [password, setPassword] = useState('');
  const session = useRef(0);
  const lock = useCallback(() => {
    session.current += 1;
    setPassword('');
  }, []);
  useEffect(
    () => () => {
      session.current += 1;
    },
    [],
  );
  const guarded = password !== '' || busy;
  useEffect(() => {
    if (!guarded) return;
    let last = Date.now();
    const touch = () => {
      last = Date.now();
    };
    const hidden = () => {
      if (document.visibilityState === 'hidden') lock();
    };
    const idle = window.setInterval(() => {
      if (Date.now() - last >= IDLE_LOCK_MS) lock();
    }, 5_000);
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', lock);
    window.addEventListener('pointerdown', touch, true);
    window.addEventListener('keydown', touch, true);
    return () => {
      window.clearInterval(idle);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', lock);
      window.removeEventListener('pointerdown', touch, true);
      window.removeEventListener('keydown', touch, true);
    };
  }, [guarded, lock]);
  const alive = () => {
    const started = session.current;
    return () => session.current === started;
  };
  return { password, setPassword, alive };
}
