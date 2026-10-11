import { useEffect, useRef, useState } from 'react';
import { ELRIC_AI_NOTICE } from '../../shared/elric-copy';
import { api } from '../api';
import { PublicHeader } from '../shell/PublicHeader';

/*
 * "Meet Elric" (native Elric N3): shown once, right after a new account finished onboarding (its
 * name and the Terms), never before. It says what Elric is and shows the AI notice; "Meet Elric"
 * opens /elric, where the date of birth is asked once, and "Skip for now" continues as before.
 * Elric off on this server (GET /api/elric is not 200) or an under-18 lock: it is skipped.
 */
export function MeetElric({ onContinue }: { onContinue: () => void }) {
  const [show, setShow] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    api<{ eligibility_reason?: string | null }>('/api/elric', undefined, 'GET')
      .then((status) => active && setShow(status.eligibility_reason !== 'age_under_18'))
      .catch(() => active && setShow(false));
    return () => {
      active = false;
    };
  }, []);
  const continued = useRef(false);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (show) title.current?.focus();
  }, [show]);
  useEffect(() => {
    if (show !== false || continued.current) return;
    continued.current = true;
    onContinue();
  }, [show, onContinue]);
  if (!show) return null;
  return (
    <div className="public-shell">
      <PublicHeader current="signin" />
      <main id="main-content" tabIndex={-1} className="auth-v8">
        <section
          className="auth-v8-card account-card meet-elric"
          aria-labelledby="meet-elric-title"
        >
          <h1 id="meet-elric-title" ref={title} tabIndex={-1}>
            Meet Elric, your AI assistant in Central City
          </h1>
          <p className="auth-v8-sub">
            Ask Elric anything in your private chat, or add it to a room you host. It answers when
            you write @Elric.
          </p>
          <p className="notice" role="note">
            {ELRIC_AI_NOTICE}
          </p>
          <div className="meet-elric-actions">
            <a className="auth-v8-submit" href="/elric">
              Meet Elric
            </a>
            <button type="button" className="meet-elric-skip" onClick={onContinue}>
              Skip for now
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
