import { useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { api, ApiError } from './api';
import { NEWSLETTER_CONFIRMED_TEXT, NEWSLETTER_UNSUBSCRIBED_TEXT } from '../shared/newsletter';
import { PublicFooter } from './shell/PublicFooter';
import { PublicHeader } from './shell/PublicHeader';
import { usePageTitle } from './shell/usePageTitle';
import './shell/shell.css';

/*
 * The pages the newsletter emails link to (docs/EMAIL.md): /newsletter/confirm?t=… and
 * /newsletter/unsubscribe?t=…. Opening a link changes nothing (mail scanners and link previews
 * open them too); the button POSTs the signed link. No sign-in is needed.
 */

const COPY = {
  confirm: {
    title: 'Confirm your subscription',
    text: 'Click below to start receiving the Central City newsletter. We only write occasionally.',
    button: 'Confirm subscription',
    done: NEWSLETTER_CONFIRMED_TEXT,
    invalid:
      'This confirmation link is invalid or has expired. Sign up again in your account settings.',
  },
  unsubscribe: {
    title: 'Unsubscribe from the newsletter',
    text: 'Unsubscribe from the Central City newsletter? Your account is not affected.',
    button: 'Unsubscribe',
    done: NEWSLETTER_UNSUBSCRIBED_TEXT,
    invalid: 'This unsubscribe link is invalid. You can also unsubscribe in your account settings.',
  },
} as const;

export function NewsletterLinkPage({ action }: { action: 'confirm' | 'unsubscribe' }) {
  const copy = COPY[action];
  usePageTitle(`${copy.title} · Central City`);
  const token = new URLSearchParams(window.location.search).get('t') ?? '';
  // 'error': the request failed for another reason (rate limit, server, network). The link may
  // still be good, so the button stays and can be pressed again.
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'invalid' | 'error'>(
    token ? 'idle' : 'invalid',
  );
  async function submit() {
    setState('busy');
    try {
      await api(`/api/newsletter/${action}?t=${encodeURIComponent(token)}`, {});
      setState('done');
    } catch (err) {
      const invalid =
        err instanceof ApiError && (err.status === 400 || err.code === 'newsletter_link_invalid');
      setState(invalid ? 'invalid' : 'error');
    }
  }
  return (
    <div className="public-shell">
      <PublicHeader current="notfound" />
      <main id="main-content" tabIndex={-1} className="public-main cc-state-page">
        <section className="cc-state cc-not-found" aria-labelledby="newsletter-title">
          <p className="cc-not-found-eyebrow">Newsletter</p>
          <h1 id="newsletter-title">{copy.title}</h1>
          <p role={state === 'done' || state === 'invalid' ? 'status' : undefined}>
            {state === 'done' ? copy.done : state === 'invalid' ? copy.invalid : copy.text}
          </p>
          {state === 'error' ? <p role="alert">That didn't go through. Try again.</p> : null}
          <div className="cc-not-found-actions">
            {state === 'idle' || state === 'busy' || state === 'error' ? (
              <button
                type="button"
                className="button primary large"
                disabled={state === 'busy'}
                onClick={() => void submit()}
              >
                {state === 'busy' ? (
                  <LoaderCircle size={17} className="spin" aria-hidden="true" />
                ) : null}
                {copy.button}
              </button>
            ) : (
              <a className="button primary large" href="/">
                Open Central City
              </a>
            )}
            <a className="button secondary large" href="/settings/account">
              Account settings
            </a>
          </div>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
