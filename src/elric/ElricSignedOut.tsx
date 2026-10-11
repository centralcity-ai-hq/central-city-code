import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Moon, Sun } from 'lucide-react';
import { api } from '../api';
import { CityMark, useTheme } from '../brand';
import { ELRIC_AI_TAG, ELRIC_NAME } from '../../shared/elric-copy';
import { usePageTitle } from '../shell/usePageTitle';
import { PAGE_TITLES } from '../../shared/page-titles';
import { MascotPeek } from './ElricMascot';
import { clearPendingDraft, readPendingDraft, savePendingDraft } from './pendingDraft';
import './dashboard.css';

/**
 * /elric for a signed-out visitor (design mockup v2): Elric's clean chat screen,
 * "What can I help with?", a composer and four everyday suggestions (a suggestion fills the
 * composer). Send with text turns the Send button into "Continue with Google" and shows one quiet
 * line under the composer: "Elric needs a Google account (18+)." with Not now. The typed
 * message stays in this tab only (pendingDraft.ts) and is back in the composer after sign-in;
 * nothing is sent anywhere first.
 */
const SUGGESTIONS: Array<[string, string]> = [
  ['Invite ChatGPT to a room', 'step by step'],
  ['Summarize my room', 'key points and decisions'],
  ['Plan tasks with my team', 'turn a goal into tasks'],
  ['What is Central City?', 'how rooms and AIs work together'],
];

export type AuthMode = 'signin' | 'register';

/** Light/dark with a plain moon or sun (the stroked icons, never one that reads as a spinner). */
function ThemeButton() {
  const { isDark, toggleTheme } = useTheme();
  return (
    <button
      type="button"
      className="elx-icon"
      aria-label={isDark ? 'Use light theme' : 'Use dark theme'}
      title={isDark ? 'Light theme' : 'Dark theme'}
      onClick={toggleTheme}
    >
      {isDark ? (
        <Sun size={18} strokeWidth={1.75} aria-hidden="true" />
      ) : (
        <Moon size={18} strokeWidth={1.75} aria-hidden="true" />
      )}
    </button>
  );
}

/** Google's "G" as one shape in the current text colour (no new colours). */
function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"
      />
    </svg>
  );
}

export function ElricSignedOut({ onAuth }: { onAuth: (mode: AuthMode) => void }) {
  usePageTitle(PAGE_TITLES['/elric']);
  // After Send with text: the Send button is "Continue with Google" and the hint line shows.
  const [gate, setGate] = useState(false);
  // A message typed before (e.g. back from Google without signing in) is still here.
  const [draft, setDraft] = useState(readPendingDraft);
  const [google, setGoogle] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let live = true;
    // Continue with Google only when the server has it on (like the sign-in page).
    void api<{ enabled?: boolean }>('/api/auth/google', undefined, 'GET')
      .then((value) => live && setGoogle(value.enabled === true))
      .catch(() => live && setGoogle(false));
    return () => {
      live = false;
    };
  }, []);
  // Send never leaves the page: it keeps the draft (this tab only) and turns into the sign-in step.
  const send = () => {
    if (!draft.trim()) {
      input.current?.focus();
      return;
    }
    savePendingDraft(draft);
    setError('');
    setGate(true);
    // The same button, now "Continue with Google": focus moves to it.
    window.requestAnimationFrame(() => button.current?.focus());
  };
  const restore = () => {
    if (!gate) return;
    setGate(false);
    setError('');
  };
  const notNow = () => {
    clearPendingDraft();
    restore();
    input.current?.focus();
  };
  const auth = (mode: AuthMode) => {
    savePendingDraft(draft);
    onAuth(mode);
  };
  async function continueWithGoogle() {
    if (busy) return;
    setError('');
    setBusy(true);
    savePendingDraft(draft);
    try {
      const { url } = await api<{ url: string }>('/api/auth/google/start', {
        intent: 'signin',
        // Back to the chat after Google (the server allows only known paths: shared/return-path.ts).
        next: '/elric',
      });
      window.location.assign(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google sign-in is not available right now.');
      setBusy(false);
    }
  }

  return (
    <div className="elx elx-out">
      <header className="elx-header elx-out-header">
        <a className="elx-home" href="/" aria-label="Central City home">
          <CityMark small />
        </a>
        <div className="elx-title">
          <h1 className="elx-out-brand">{ELRIC_NAME}</h1>
          <span className="elx-tag">{ELRIC_AI_TAG}</span>
          <MascotPeek />
        </div>
        <div className="elx-actions">
          <button type="button" className="elx-link-button" onClick={() => auth('signin')}>
            Log in
          </button>
          <button type="button" className="elx-pill" onClick={() => auth('register')}>
            Sign up for free
          </button>
          <ThemeButton />
        </div>
      </header>

      <main className="elx-out-main">
        <div className="elx-out-hero">
          <span className="elx-sheet-mark" aria-hidden="true">
            <CityMark />
          </span>
          <h2>What can I help with?</h2>
          <form
            className="elx-composer elx-out-composer"
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            <textarea
              ref={input}
              rows={2}
              value={draft}
              maxLength={4000}
              placeholder="Message Elric"
              aria-label="Message Elric"
              onFocus={restore}
              onChange={(event) => {
                setDraft(event.target.value);
                restore();
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            {/* One button: Send, or after Send the sign-in step (its width eases between them). */}
            <button
              ref={button}
              type={gate ? 'button' : 'submit'}
              className={`elx-send${gate ? ' is-signin' : ''}`}
              aria-label={gate ? undefined : 'Send'}
              disabled={gate && busy}
              onClick={
                gate ? () => (google ? void continueWithGoogle() : auth('signin')) : undefined
              }
            >
              {gate ? (
                <span className="elx-send-label">
                  {google ? <GoogleMark /> : null}
                  {google ? 'Continue with Google' : 'Log in'}
                </span>
              ) : (
                <ArrowUp size={18} strokeWidth={2} aria-hidden="true" />
              )}
            </button>
          </form>
          <div className="elx-out-gate" aria-live="polite" data-testid="elric-signin-hint">
            {gate ? (
              <p className="elx-meta">
                Elric needs a Google account (18+).{' '}
                <button type="button" className="elx-out-notnow" onClick={notNow}>
                  Not now
                </button>
              </p>
            ) : null}
            {gate && error ? (
              <p className="elx-meta elx-auth-error" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <p className="elx-meta elx-out-note">
            Elric can make mistakes. Check important information.
          </p>
          <div className="elx-out-cards">
            {SUGGESTIONS.map(([title, line]) => (
              <button
                key={title}
                type="button"
                className="elx-out-card"
                onClick={() => {
                  setDraft(title);
                  input.current?.focus();
                }}
              >
                <span>{title}</span>
                <span className="elx-meta">{line}</span>
              </button>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
