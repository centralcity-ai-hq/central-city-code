import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CircleAlert, CircleCheck, LoaderCircle } from 'lucide-react';
import { api, selectedWorkspaceId } from './api';
import { ConfirmDialog } from './components';
import {
  SettingsLayout,
  SettingsLoading,
  SettingsSectionHead,
  type SettingsSection,
} from './settings/SettingsLayout';
import './settings/account-data.css';
import { openWorkspaceView } from './shell/workspaceDestinations';
import { useWorkspaceV2 } from './shell/workspaceV2';
import { safeReturnPath } from '../shared/return-path';
import { NEWSLETTER_HINT, NEWSLETTER_LABEL } from '../shared/newsletter';
import { NewsletterSettings } from './settings/Newsletter';
import type { Operator } from '../shared/types';
import { PublicFooter } from './shell/PublicFooter';
import { PublicHeader } from './shell/PublicHeader';
import { clearPendingDraft } from './elric/pendingDraft';
import './auth.css';

/*
 * Sign in with Google and the Google account link (docs/GOOGLE_SIGNIN.md). Shown only when the
 * server says the feature is on (GET /api/auth/google). The server redirects back with
 * ?google=<outcome>; these are the sentences for each outcome.
 */

/** Same markup as Auth's FormError (not imported: Auth imports this module). */
function FormError({ error }: { error: string }) {
  return error ? (
    <div className="form-error" role="alert">
      {error}
    </div>
  ) : null;
}

export interface GoogleLinkState {
  enabled: boolean;
  /** An account just created with Google that has not chosen its account name yet. */
  handle_needed?: boolean;
  linked: { email: string; hd: string | null; linked_at: string } | null;
}

const OUTCOMES: Record<string, { text: string; error: boolean }> = {
  linked: { text: 'Google account linked.', error: false },
  cancelled: { text: 'Google sign-in was cancelled.', error: true },
  expired: {
    text: 'That attempt expired or was opened in another browser. Try again.',
    error: true,
  },
  not_linked: {
    text: 'No account is linked to that Google account. Sign in with your password, then link Google in Account.',
    error: true,
  },
  linked_elsewhere: {
    text: 'That Google account is linked to another Central City account.',
    error: true,
  },
  already_linked: {
    text: 'This account is linked to another Google account. Unlink it first.',
    error: true,
  },
  ineligible: { text: 'Use a gmail.com address or a Google Workspace account.', error: true },
  unverified: { text: "Google hasn't verified that email address.", error: true },
  failed: { text: "Google sign-in didn't complete. Try again.", error: true },
  relink_cooldown: {
    text: 'That Google account was unlinked from another Central City account in the last 30 days. Try again later.',
    error: true,
  },
  elric_age_under_18: {
    text: 'Google account linked. Elric is only for people aged 18 or over.',
    error: true,
  },
  welcome: { text: 'Your account is ready. Choose your account name.', error: false },
  email_exists: {
    text: 'An account with this email exists. Sign in with your password, then link Google in Account.',
    error: true,
  },
  signup_limited: {
    text: 'Too many new accounts from this network. Try again later.',
    error: true,
  },
  signup_closed: { text: "New accounts can't be created right now.", error: true },
  elric_age_unknown: {
    text: 'Google account linked. Add your date of birth below to use Elric.',
    error: true,
  },
};

/** The outcome in ?google= (removed from the address bar once read). */
export function useGoogleOutcome() {
  const [outcome] = useState(() => {
    const value = new URLSearchParams(window.location.search).get('google');
    return value && Object.hasOwn(OUTCOMES, value) ? OUTCOMES[value]! : null;
  });
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('google')) return;
    params.delete('google');
    const query = params.toString();
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`,
    );
  }, []);
  return outcome;
}

export function useGoogleLink() {
  const [state, setState] = useState<GoogleLinkState | null>(null);
  useEffect(() => {
    let active = true;
    api<GoogleLinkState>('/api/auth/google', undefined, 'GET')
      .then((value) => active && setState(value))
      .catch(() => active && setState({ enabled: false, linked: null }));
    return () => {
      active = false;
    };
  }, []);
  return [state, setState] as const;
}

/** "Continue with Google": starts the flow on the server, then goes to Google. */
export function GoogleButton({ intent }: { intent: 'signin' | 'link' }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function go() {
    setBusy(true);
    setError('');
    try {
      // Signing in from an allowlisted page (e.g. /elric) comes back to it (the server re-checks).
      const next = intent === 'signin' ? safeReturnPath(window.location.pathname) : null;
      const { url } = await api<{ url: string }>('/api/auth/google/start', {
        intent,
        ...(next ? { next } : {}),
      });
      window.location.assign(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : OUTCOMES.failed!.text);
      setBusy(false);
    }
  }
  return (
    <>
      <button type="button" className="auth-v8-google" disabled={busy} onClick={() => void go()}>
        {busy ? <LoaderCircle size={17} className="spin" aria-hidden="true" /> : null}
        Continue with Google
      </button>
      <FormError error={error} />
    </>
  );
}

/**
 * Sign-in's "Continue with Google" (only when the server has the feature on), with the outcome
 * Google's redirect came back with. Loaded lazily by Auth.
 */
export function GoogleSignInOption(_props: { register: boolean }) {
  const [state] = useGoogleLink();
  const outcome = useGoogleOutcome();
  return (
    <>
      {outcome?.error ? <FormError error={outcome.text} /> : null}
      {/* One button for both: an unknown Google account gets a new account. */}
      {state?.enabled ? (
        <div className="auth-v8-alt">
          <span className="auth-v8-or">or</span>
          <GoogleButton intent="signin" />
        </div>
      ) : null}
    </>
  );
}

interface AgeView {
  date_of_birth: string | null;
  age_check: 'over_18' | 'under_18' | 'unknown';
  locked: boolean;
}

/** Date of birth for Elric's 18+ age confirmation: view, enter or correct (not once locked). */
function DateOfBirth() {
  const { view, value, setValue, busy, error, saved, save } = useDateOfBirth();
  if (!view) return null;
  return (
    <>
      <h2 className="account-heading">Date of birth</h2>
      {view.locked ? (
        <p className="auth-v8-sub">Elric is only for people aged 18 or over.</p>
      ) : (
        <form onSubmit={save} className="auth-v8-form">
          <label>
            Date of birth (for Elric, 18 or over)
            <input
              type="date"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              required
            />
          </label>
          <FormError error={error} />
          {saved ? (
            <p className="notice" role="status">
              Saved.
            </p>
          ) : null}
          <button className="auth-v8-google" disabled={busy}>
            {busy ? <LoaderCircle size={17} className="spin" aria-hidden="true" /> : null}
            Save
          </button>
        </form>
      )}
    </>
  );
}

/** The age check behind the date of birth form (GET/POST /api/elric/age, Google link required). */
function useDateOfBirth() {
  const [view, setView] = useState<AgeView | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    api<AgeView>('/api/elric/age', undefined, 'GET')
      .then((result) => {
        if (!active) return;
        setView(result);
        setValue(result.date_of_birth ?? '');
      })
      .catch(() => active && setView({ date_of_birth: null, age_check: 'unknown', locked: false }));
    return () => {
      active = false;
    };
  }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      await api('/api/elric/age', { date_of_birth: value });
      setView({ date_of_birth: value, age_check: 'over_18', locked: false });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The date of birth couldn't be saved.");
      api<AgeView>('/api/elric/age', undefined, 'GET')
        .then(setView)
        .catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }
  return { view, value, setValue, busy, error, saved, save };
}

/** The account name for an account created with Google (asked once, after the first sign-in). */
function ChooseName({ onSaved }: { onSaved: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/google/handle', { name: name.trim() });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The account name couldn't be saved.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <h2 className="account-heading">Account name</h2>
      <form onSubmit={save} className="auth-v8-form">
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
        <p className="auth-v8-note">
          By creating an account, you agree to our <a href="/terms">Terms of Service</a> and{' '}
          <a href="/privacy">Privacy Policy</a>.
        </p>
        <FormError error={error} />
        <button className="auth-v8-submit" disabled={busy}>
          {busy ? <LoaderCircle size={17} className="spin" aria-hidden="true" /> : null}
          Save name
        </button>
      </form>
    </>
  );
}

/** /settings/account: link or unlink the person's Google account. */
export function AccountPage() {
  const workspaceV2 = useWorkspaceV2();
  return workspaceV2 ? <AccountSettingsV2 /> : <ClassicAccountPage />;
}

function ClassicAccountPage() {
  const outcome = useGoogleOutcome();
  const [state, setState] = useGoogleLink();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function unlink() {
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/google/unlink', {});
      setState((value) => (value ? { ...value, linked: null } : value));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The Google account couldn't be unlinked.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="public-shell">
      <PublicHeader current="signin" />
      <main id="main-content" tabIndex={-1} className="auth-v8">
        <section className="auth-v8-card account-card" aria-labelledby="account-title">
          <h1 id="account-title">Account</h1>
          <h2 className="account-heading">Google account</h2>
          {outcome ? (
            outcome.error ? (
              <FormError error={outcome.text} />
            ) : (
              <p className="notice" role="status">
                {outcome.text}
              </p>
            )
          ) : null}
          {!state ? (
            <LoaderCircle size={17} className="spin" aria-label="Loading" />
          ) : !state.enabled ? (
            <p className="auth-v8-sub">Sign in with Google isn't available on this server.</p>
          ) : state.handle_needed ? (
            <ChooseName
              onSaved={() => {
                // A new account that started from an allowlisted page goes back there.
                const next = safeReturnPath(
                  new URLSearchParams(window.location.search).get('next'),
                );
                if (next) window.location.assign(next);
                else setState((value) => (value ? { ...value, handle_needed: false } : value));
              }}
            />
          ) : state.linked ? (
            <>
              <p className="auth-v8-sub">
                Linked to <strong>{state.linked.email}</strong>.
              </p>
              <FormError error={error} />
              <button
                type="button"
                className="auth-v8-google"
                disabled={busy}
                onClick={() => void unlink()}
              >
                {busy ? <LoaderCircle size={17} className="spin" aria-hidden="true" /> : null}
                Unlink
              </button>
              <DateOfBirth />
            </>
          ) : (
            <>
              <p className="auth-v8-sub">
                Link a gmail.com or Google Workspace account. Central City stores its Google ID,
                email address and Workspace domain, and no Google password or token.
              </p>
              <GoogleButton intent="link" />
            </>
          )}
          <p className="auth-v8-foot">
            <a href="/">Back to your workspace</a>
          </p>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}

/**
 * Workspace v2 Settings › Account: only what the account really has. The account name, the
 * Google link (link, or unlink with its 30-day relink cooldown) and Elric's age check.
 */
function AccountSettingsV2() {
  const outcome = useGoogleOutcome();
  const [state, setState] = useGoogleLink();
  const [session, setSession] = useState<Operator | null>(null);
  const [sessionError, setSessionError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [unlinked, setUnlinked] = useState(false);
  const unlinkButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let active = true;
    setSessionError('');
    api<{ operator: Operator | null }>('/api/session', undefined, 'GET')
      .then((value) => {
        if (!active) return;
        if (value.operator) setSession(value.operator);
        else setSessionError('You’re signed out. Sign in again to see your account.');
      })
      .catch((err: unknown) => {
        if (active)
          setSessionError(err instanceof Error ? err.message : 'Your account couldn’t be loaded.');
      });
    return () => {
      active = false;
    };
  }, [attempt]);
  function closeConfirm() {
    if (busy) return;
    setConfirming(false);
    window.setTimeout(() => unlinkButton.current?.focus());
  }
  async function unlink() {
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/google/unlink', {});
      setState((value) => (value ? { ...value, linked: null } : value));
      setConfirming(false);
      setUnlinked(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The Google account couldn't be unlinked.");
    } finally {
      setBusy(false);
    }
  }
  const open = (section: SettingsSection) => {
    if (section === 'account') return;
    // The console keeps its sections per workspace (src/shell/workspaceDestinations.ts).
    const workspaceId = selectedWorkspaceId() ?? session?.id;
    if (workspaceId) openWorkspaceView(section, workspaceId);
  };
  return (
    <main id="main-content" tabIndex={-1} className="stv2-page">
      <SettingsLayout section="account" onSection={open}>
        <section className="account-data" aria-label="Account">
          <SettingsSectionHead
            title="Account"
            lede="Your account name, the Google account you can sign in with, the age check Elric needs, and the newsletter."
          />
          {outcome ? (
            outcome.error ? (
              <p className="account-data-error" role="alert">
                <CircleAlert size={18} aria-hidden="true" />
                {outcome.text}
              </p>
            ) : (
              <p className="account-data-status stv2-notice" role="status">
                <CircleCheck size={16} aria-hidden="true" />
                {outcome.text}
              </p>
            )
          ) : null}
          <div className="account-data-card">
            <h3>Profile</h3>
            {sessionError ? (
              <div className="account-data-error" role="alert">
                <CircleAlert size={18} aria-hidden="true" />
                <div>
                  <p>{sessionError}</p>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => setAttempt((value) => value + 1)}
                  >
                    Try again
                  </button>
                </div>
              </div>
            ) : !session ? (
              <SettingsLoading label="Loading your account…" rows={1} />
            ) : (
              <dl className="account-data-facts">
                <div>
                  <dt>Account name</dt>
                  <dd>{session.name}</dd>
                </div>
              </dl>
            )}
          </div>
          <div className="account-data-card">
            <h3>Google account</h3>
            {unlinked ? (
              <p className="account-data-status stv2-notice" role="status">
                <CircleCheck size={16} aria-hidden="true" />
                Google account unlinked.
              </p>
            ) : null}
            {!state ? (
              <SettingsLoading label="Loading your Google link…" rows={1} />
            ) : !state.enabled ? (
              <p className="account-data-muted">
                Sign in with Google isn’t available on this server.
              </p>
            ) : state.handle_needed ? (
              <ChooseName
                onSaved={() => {
                  const next = safeReturnPath(
                    new URLSearchParams(window.location.search).get('next'),
                  );
                  if (next) window.location.assign(next);
                  else setState((value) => (value ? { ...value, handle_needed: false } : value));
                }}
              />
            ) : state.linked ? (
              <div className="stv2-row">
                <div className="stv2-row-copy">
                  <p>
                    Linked to <strong>{state.linked.email}</strong>{' '}
                    <span className="stv2-pill live">Linked</span>
                  </p>
                  <p className="account-data-muted">
                    Linked {formatLinkedDate(state.linked.linked_at)}. If you unlink it, it can’t be
                    linked to a different Central City account for 30 days.
                  </p>
                </div>
                <button
                  ref={unlinkButton}
                  type="button"
                  className="button stv2-danger"
                  onClick={() => {
                    setError('');
                    setUnlinked(false);
                    setConfirming(true);
                  }}
                >
                  Unlink Google
                </button>
              </div>
            ) : (
              <div className="stv2-row stv2-row-stack">
                <p className="account-data-muted">
                  Link a gmail.com or Google Workspace account. Central City stores its Google ID,
                  email address and Workspace domain, and no Google password or token.
                </p>
                <GoogleButton intent="link" />
              </div>
            )}
          </div>
          <div className="account-data-card">
            <h3>Newsletter</h3>
            <NewsletterSettings />
          </div>
          <div className="account-data-card">
            <h3>Age check for Elric</h3>
            {state?.enabled && state.linked ? (
              <AgeCheck />
            ) : (
              <p className="account-data-muted">
                Elric is for people aged 18 or over. It needs a linked Google account and your date
                of birth.
              </p>
            )}
          </div>
        </section>
      </SettingsLayout>
      {confirming && state?.linked ? (
        <ConfirmDialog
          title="Unlink Google?"
          confirmLabel="Unlink Google"
          busy={busy}
          error={error}
          status={busy ? 'Unlinking…' : undefined}
          onClose={closeConfirm}
          onConfirm={() => void unlink()}
        >
          <p>
            You’ll no longer sign in with <strong>{state.linked.email}</strong>. The date of birth
            saved for Elric is deleted. Elric stops working for you until you link Google again. For
            30 days, this Google account can’t be linked to a different Central City account;
            linking it back to this one is fine.
          </p>
        </ConfirmDialog>
      ) : null}
    </main>
  );
}

/** "on 3 Oct 2026" in the visitor's locale. */
function formatLinkedDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'earlier'
    : `on ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)}`;
}

/** Elric's age check in Settings: its state, and the date of birth form while it may change. */
function AgeCheck() {
  const { view, value, setValue, busy, error, saved, save } = useDateOfBirth();
  if (!view) return <SettingsLoading label="Loading your age check…" rows={1} />;
  if (view.locked || view.age_check === 'under_18')
    return <p className="account-data-muted">Elric is only for people aged 18 or over.</p>;
  const verified = view.age_check === 'over_18';
  return (
    <>
      <div className="stv2-row-copy">
        <p>
          {verified ? 'Confirmed: 18 or over' : 'Date of birth not added yet'}{' '}
          <span className={`stv2-pill ${verified ? 'live' : 'pending'}`}>
            {verified ? 'Verified' : 'Needed for Elric'}
          </span>
        </p>
        <p className="account-data-muted">
          Your date of birth is used only for this check. Unlinking Google deletes it.
        </p>
      </div>
      <form onSubmit={save} className="stv2-form">
        <label>
          Date of birth (for Elric, 18 or over)
          <input
            type="date"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            required
          />
        </label>
        <button className="button secondary" disabled={busy}>
          {busy ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : null}
          Save
        </button>
      </form>
      {error ? (
        <p className="account-data-error" role="alert">
          <CircleAlert size={18} aria-hidden="true" />
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="account-data-status" role="status">
          <CircleCheck size={16} aria-hidden="true" />
          Saved.
        </p>
      ) : null}
    </>
  );
}

/** GET /api/session's onboarding status of an account created with Google. */
export interface OnboardingState {
  required: boolean;
  name_needed: boolean;
  terms_needed: boolean;
  terms_version: string;
  /** Whether the newsletter opt-in is offered (the Google account has a verified address). */
  newsletter_available?: boolean;
}

/**
 * The onboarding screen of an account created with Google: its name (once) and the acceptance
 * of the Terms of Service and Privacy Policy. Root shows it on every route until it is done; the
 * server records the accepted version and time (POST /api/auth/onboarding).
 */
export function OnboardingPage({
  state,
  onDone,
}: {
  state: OnboardingState;
  onDone: (operator: Operator) => void;
}) {
  const outcome = useGoogleOutcome();
  const [name, setName] = useState('');
  const [accepted, setAccepted] = useState(false);
  // The newsletter opt-in: unticked by default and never required (docs/EMAIL.md).
  const [newsletter, setNewsletter] = useState(false);
  // Offered when the account is being created (not on a later Terms update).
  const offerNewsletter = Boolean(state.newsletter_available && state.name_needed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api<{ operator: Operator }>('/api/auth/onboarding', {
        ...(state.name_needed ? { name: name.trim() } : {}),
        terms_version: state.terms_version,
        accept_terms: true,
        ...(offerNewsletter ? { newsletter } : {}),
      });
      onDone(result.operator);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Your account couldn't be set up. Try again.");
      setBusy(false);
    }
  }
  async function signOut() {
    await api('/api/auth/logout', {}).catch(() => undefined);
    clearPendingDraft();
    window.location.assign('/');
  }
  return (
    <div className="public-shell">
      <PublicHeader current="signin" />
      <main id="main-content" tabIndex={-1} className="auth-v8">
        <section className="auth-v8-card account-card" aria-labelledby="onboarding-title">
          <h1 id="onboarding-title">
            {state.name_needed ? 'Finish creating your account' : 'Accept the Terms to continue'}
          </h1>
          {outcome && !outcome.error ? (
            <p className="notice" role="status">
              {outcome.text}
            </p>
          ) : null}
          {!state.name_needed ? (
            <p className="auth-v8-sub">
              To continue, accept the current Terms of Service and Privacy Policy.
            </p>
          ) : null}
          <form onSubmit={save} className="auth-v8-form">
            {state.name_needed ? (
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
            ) : null}
            <label className="auth-v8-check">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(event) => setAccepted(event.target.checked)}
                required
              />
              <span>
                I accept the{' '}
                <a href="/terms" target="_blank" rel="noopener">
                  Terms of Service
                </a>{' '}
                and the{' '}
                <a href="/privacy" target="_blank" rel="noopener">
                  Privacy Policy
                </a>
                .
              </span>
            </label>
            {offerNewsletter ? (
              <div className="auth-v8-newsletter">
                <label className="auth-v8-check">
                  <input
                    type="checkbox"
                    checked={newsletter}
                    onChange={(event) => setNewsletter(event.target.checked)}
                  />
                  <span>{NEWSLETTER_LABEL}</span>
                </label>
                {/* The Google account's verified address is used; no field is needed. */}
                <p
                  className={`auth-v8-note${newsletter ? '' : ' is-ghost'}`}
                  aria-hidden={!newsletter}
                  role="status"
                >
                  {NEWSLETTER_HINT}
                </p>
              </div>
            ) : null}
            <FormError error={error} />
            <button className="auth-v8-submit" disabled={busy || !accepted}>
              {busy ? <LoaderCircle size={17} className="spin" aria-hidden="true" /> : null}
              Continue
            </button>
          </form>
          <p className="auth-v8-foot">
            <button type="button" className="text-link" onClick={() => void signOut()}>
              Sign out
            </button>
          </p>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
