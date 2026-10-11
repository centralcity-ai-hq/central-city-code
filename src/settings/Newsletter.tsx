import { useEffect, useState, type FormEvent } from 'react';
import { CircleAlert, CircleCheck, LoaderCircle } from 'lucide-react';
import { api } from '../api';
import {
  NEWSLETTER_HINT,
  NEWSLETTER_STATUS_LABEL,
  type NewsletterStatus,
} from '../../shared/newsletter';
import { SettingsLoading } from './SettingsLayout';

interface NewsletterView {
  status: NewsletterStatus;
  /** The newsletter's address (pending or subscribed), else the linked Google address. */
  email: string | null;
  has_account_email: boolean;
}

const PILL: Record<NewsletterStatus, string> = {
  none: '',
  unsubscribed: '',
  pending: 'pending',
  subscribed: 'live',
};

/**
 * Settings > Account: the newsletter (docs/EMAIL.md). Subscribing sends a confirmation email
 * (double opt-in) and asks for an address when the account has none; unsubscribing is one click.
 */
export function NewsletterSettings() {
  const [view, setView] = useState<NewsletterView | null>(null);
  const [loadError, setLoadError] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  useEffect(() => {
    let active = true;
    api<NewsletterView>('/api/account/newsletter', undefined, 'GET')
      .then((value) => active && setView(value))
      .catch(
        (err: unknown) =>
          active &&
          setLoadError(err instanceof Error ? err.message : 'The newsletter couldn’t be loaded.'),
      );
    return () => {
      active = false;
    };
  }, []);
  async function change(subscribe: boolean, event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setError('');
    setDone('');
    try {
      const next = await api<NewsletterView>('/api/account/newsletter', {
        subscribe,
        ...(subscribe && !view?.has_account_email ? { email: email.trim() } : {}),
      });
      setView(next);
      setDone(subscribe ? NEWSLETTER_HINT : 'You’re unsubscribed. Your account is not affected.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The newsletter setting couldn’t be saved.');
    } finally {
      setBusy(false);
    }
  }
  if (loadError)
    return (
      <p className="account-data-error" role="alert">
        <CircleAlert size={18} aria-hidden="true" />
        {loadError}
      </p>
    );
  if (!view) return <SettingsLoading label="Loading your newsletter setting…" rows={1} />;
  const on = view.status === 'pending' || view.status === 'subscribed';
  const spinner = busy ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : null;
  return (
    <>
      <div className="stv2-row">
        <div className="stv2-row-copy">
          <p className="stv2-row-title">
            {on && view.email ? <strong>{view.email}</strong> : 'Product news, occasionally.'}{' '}
            <span
              className={`stv2-pill ${PILL[view.status]}`.trim()}
              data-testid="newsletter-status"
            >
              {NEWSLETTER_STATUS_LABEL[view.status]}
            </span>
          </p>
          <p className="account-data-muted">
            {view.status === 'pending'
              ? 'Open the link in the email we sent to confirm. Unconfirmed sign-ups are deleted after 30 days.'
              : on
                ? 'You can also unsubscribe with the link in any newsletter. We do not track opens or clicks.'
                : view.has_account_email
                  ? NEWSLETTER_HINT
                  : 'Enter your email below. We’ll send a link to confirm.'}
          </p>
        </div>
        {on ? (
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => void change(false)}
          >
            {spinner}
            Unsubscribe
          </button>
        ) : view.has_account_email ? (
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={() => void change(true)}
          >
            {spinner}
            Subscribe
          </button>
        ) : null}
      </div>
      {!on && !view.has_account_email ? (
        <form onSubmit={(event) => void change(true, event)} className="stv2-form">
          <label>
            Email
            <input
              type="email"
              autoComplete="email"
              inputMode="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              maxLength={254}
              placeholder="you@example.com"
            />
          </label>
          <button className="button primary" disabled={busy}>
            {spinner}
            Subscribe
          </button>
        </form>
      ) : null}
      {error ? (
        <p className="account-data-error" role="alert">
          <CircleAlert size={18} aria-hidden="true" />
          {error}
        </p>
      ) : null}
      {done ? (
        <p className="account-data-status" role="status">
          <CircleCheck size={16} aria-hidden="true" />
          {done}
        </p>
      ) : null}
    </>
  );
}
