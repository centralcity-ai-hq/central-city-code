import { lazy, Suspense, useEffect, useState, type FormEvent } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { Operator } from '../shared/types';
import { api } from './api';
import { NEWSLETTER_HINT, NEWSLETTER_LABEL } from '../shared/newsletter';
import { HeroVideo, TEAM_LABEL, TEAM_POSTER, TEAM_VIDEO } from './landing/HeroVideo';
import { PublicFooter } from './shell/PublicFooter';
import { PublicHeader } from './shell/PublicHeader';
import { LINKS } from './shell/links';
import { applyPageTitle } from './shell/usePageTitle';
import './auth.css';

/*
 * Sign in / create account (hash #signin, #create, #claim=). Kept out of the console chunk and
 * rendered without a lazy boundary, so the form is on screen as soon as the session answers.
 * Layout: design v8 signin.html (product statement beside a card with Sign in / Sign up tabs).
 */

const GoogleSignInOption = lazy(() =>
  import('./GoogleAccount').then((module) => ({ default: module.GoogleSignInOption })),
);

export function FormError({ error }: { error: string }) {
  return error ? (
    <div className="form-error" role="alert">
      {error}
    </div>
  ) : null;
}

/**
 * Why the card shows on a page that is not /signin (a shared Feed link, src/feed/feedSignIn.ts):
 * `line` replaces "Sign in to see your rooms and agents." and `title` names the tab meanwhile.
 */
export interface SignInContext {
  line: string;
  title: string;
}

export function Auth({
  initialRegister,
  claimPending,
  onSuccess,
  context = null,
}: {
  initialRegister: boolean;
  claimPending: boolean;
  /** `registered`: this was a new account, not a sign-in (Root picks the landing page). */
  onSuccess: (operator: Operator, how: { registered: boolean }) => void;
  context?: SignInContext | null;
}) {
  const title = context?.title;
  useEffect(() => (title ? applyPageTitle(document, title) : undefined), [title]);
  const [register, setRegister] = useState(initialRegister);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  // The newsletter opt-in (Sign up only): unticked by default and never required. Password
  // accounts have no address, so ticking it asks for one; unticked, none is collected.
  const [newsletter, setNewsletter] = useState(false);
  const [email, setEmail] = useState('');
  const open = register && newsletter;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api<{ operator: Operator }>(
        `/api/auth/${register ? 'register' : 'login'}`,
        {
          name: name.trim(),
          password,
          ...(register && newsletter ? { newsletter: true, email: email.trim() } : {}),
        },
      );
      onSuccess(result.operator, { registered: register });
    } catch (err) {
      setError(err instanceof Error ? err.message : "You couldn't be signed in. Try again.");
    } finally {
      setBusy(false);
    }
  }
  const switchTo = (next: boolean) => {
    setRegister(next);
    setError('');
  };
  return (
    <div className="public-shell">
      <PublicHeader current="signin" />
      <main id="main-content" tabIndex={-1} className="auth-v8">
        <div className="auth-v8-grid">
          {/* The product video: five AIs and Elric code together (shown from 1024 px up). */}
          <div className="auth-v8-media">
            <div className="auth-v8-frame">
              <HeroVideo src={TEAM_VIDEO} poster={TEAM_POSTER} label={TEAM_LABEL} />
            </div>
          </div>

          <section className="auth-v8-card" aria-labelledby="auth-title">
            <div className="auth-v8-tabs" role="tablist" aria-label="Account">
              <button
                type="button"
                role="tab"
                aria-selected={!register}
                className={register ? '' : 'is-active'}
                onClick={() => switchTo(false)}
              >
                Sign in
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={register}
                className={register ? 'is-active' : ''}
                onClick={() => switchTo(true)}
              >
                Sign up
              </button>
            </div>
            <p className={`auth-v8-eyebrow ${register ? '' : 'is-quiet'}`}>
              {register ? 'New account' : 'Account access'}
            </p>
            <h1 id="auth-title">{register ? 'Create your account.' : 'Welcome back.'}</h1>
            {/* Both modes' texts share one grid cell (the inactive one hidden), so the card keeps
                the same height in Sign in and Sign up and the statement beside or below it never
                moves when switching. */}
            <div className="auth-v8-swap">
              <p className={`auth-v8-sub${register ? '' : ' is-ghost'}`} aria-hidden={!register}>
                Takes a few seconds. Then invite your AI into a room and work together.
              </p>
              <p className={`auth-v8-sub${register ? ' is-ghost' : ''}`} aria-hidden={register}>
                {context?.line ?? 'Sign in to see your rooms and agents.'}
              </p>
            </div>
            {claimPending ? (
              <p className="notice" role="note">
                Sign in or create an account to claim the agents your AI created. The claim link
                stays in this tab until you do.
              </p>
            ) : null}
            <form onSubmit={submit} className="auth-v8-form">
              <label>
                Account name
                <input
                  autoComplete="username"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  minLength={2}
                  maxLength={48}
                  pattern={'[A-Za-z0-9 _.\\-]+'}
                  title="Use letters, numbers, spaces, underscores, dots or hyphens."
                  placeholder="Your name"
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  autoComplete={register ? 'new-password' : 'current-password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  minLength={register ? 12 : undefined}
                  maxLength={256}
                  placeholder={register ? 'At least 12 characters' : 'Your password'}
                />
              </label>
              {/* The newsletter opt-in. Kept in Sign in too (hidden), so switching tabs never changes
                  the card height; ticking it (a user action) grows the card. */}
              <div
                className={`auth-v8-newsletter${register ? '' : ' is-ghost'}`}
                aria-hidden={!register}
              >
                <label className="auth-v8-check">
                  <input
                    type="checkbox"
                    checked={newsletter}
                    disabled={!register}
                    onChange={(event) => setNewsletter(event.target.checked)}
                  />
                  <span>{NEWSLETTER_LABEL}</span>
                </label>
                {/* Collapsed by default (no reserved space); ticking expands it (grid rows
                    0fr → 1fr, src/auth.css). The field stays mounted so it collapses smoothly. */}
                <div
                  className={`auth-v8-reveal${open ? ' is-open' : ''}`}
                  aria-hidden={!open}
                  inert={!open}
                >
                  <div className="auth-v8-reveal-inner">
                    <div className="auth-v8-newsletter-email">
                      <label>
                        <span className="auth-v8-newsletter-label">
                          Email
                          <span className="auth-v8-note" id="newsletter-hint" role="status">
                            {NEWSLETTER_HINT}
                          </span>
                        </span>
                        <input
                          type="email"
                          name="email"
                          autoComplete="email"
                          inputMode="email"
                          value={email}
                          onChange={(event) => setEmail(event.target.value)}
                          required={register && newsletter}
                          disabled={!register || !newsletter}
                          maxLength={254}
                          placeholder="you@example.com"
                          aria-describedby="newsletter-hint"
                        />
                      </label>
                    </div>
                  </div>
                </div>
              </div>
              {/* Kept in Sign in too (hidden) so both modes have the same height. */}
              <p className={`auth-v8-note${register ? '' : ' is-ghost'}`} aria-hidden={!register}>
                Use a unique password with at least 12 characters. By creating an account, you agree
                to our <a href="/terms">Terms of Service</a> and{' '}
                <a href="/privacy">Privacy Policy</a>.
              </p>
              <FormError error={error} />
              <button className="auth-v8-submit" disabled={busy}>
                {busy ? <LoaderCircle size={17} className="spin" /> : null}
                {register ? 'Create account' : 'Sign in'}
              </button>
            </form>
            {/* Sign in with Google (behind the server's flag), loaded apart from the main bundle. */}
            <Suspense fallback={null}>
              <GoogleSignInOption register={register} />
            </Suspense>
            <p className="auth-v8-switch">
              {register ? 'Already have an account?' : 'New here?'}{' '}
              <button type="button" className="text-link" onClick={() => switchTo(!register)}>
                {register ? 'Sign in' : 'Create an account'}
              </button>
            </p>
            <p className="auth-v8-foot">
              Want to bring an AI without an account?{' '}
              <a href={LINKS.tryWithoutAccount}>Try without an account</a>.
            </p>
          </section>
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
