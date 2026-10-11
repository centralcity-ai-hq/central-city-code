/**
 * Development and e2e harness only (never imported by the production entry). It mounts RoomsApp
 * against the live console API exactly as the app shell will: capturePendingJoin() runs first,
 * before any render. It stands in for the shell's /signin page with a minimal sign-in form.
 * See docs/ROOMS_UX.md for the production mount.
 */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../shell/tokens.css';
import '../styles.css';
import { api } from '../api';
import { createHttpRoomsClient } from './api';
import { capturePendingJoin, safeNext } from './pendingJoin';
import { RoomsApp } from './RoomsApp';
import { describe } from './useRoomThread';

capturePendingJoin();

const client = createHttpRoomsClient();
// `?embedded=1` mounts RoomsApp as an app shell would (e2e/rooms-embedded.spec.ts); read once,
// so it holds as RoomsApp moves between room paths.
const embedded = new URLSearchParams(location.search).get('embedded') === '1';

function SignIn() {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  return (
    <div className="rm-app rm-app-join">
      <form
        className="rm-join"
        onSubmit={(event) => {
          event.preventDefault();
          setError('');
          api('/api/auth/login', { name, password })
            .then(() =>
              window.location.assign(safeNext(new URLSearchParams(location.search).get('next'))),
            )
            .catch((err) => setError(describe(err)));
        }}
      >
        <h1>Sign in</h1>
        <label className="rm-field">
          <span>Account name</span>
          <input className="rm-input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="rm-field">
          <span>Password</span>
          <input
            className="rm-input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error ? (
          <p className="rm-inline-error" role="alert">
            {error}
          </p>
        ) : null}
        <button className="rm-primary" type="submit">
          Sign in
        </button>
      </form>
    </div>
  );
}

function Harness() {
  const [session, setSession] = useState<{
    operator: { id: string; name: string } | null;
  } | null>(null);
  useEffect(() => {
    // A failed session read (for example a rate-limited 429) is retried, never read as signed out.
    let active = true;
    void (async () => {
      for (let attempt = 0; active; attempt++) {
        try {
          const value = await api<{ operator: { id: string; name: string } | null }>(
            '/api/session',
            undefined,
            'GET',
          );
          if (active) setSession(value);
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 8000)));
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);
  if (location.pathname === '/signin') return <SignIn />;
  if (!session) return null;
  return (
    <RoomsApp
      client={client}
      signedIn={Boolean(session.operator)}
      workspaceId={session.operator?.id ?? 'signed-out'}
      accountName={session.operator?.name ?? ''}
      onSignIn={(next) => window.location.assign(`/signin?next=${encodeURIComponent(next)}`)}
      embedded={embedded}
    />
  );
}

if (import.meta.env.DEV) createRoot(document.getElementById('root')!).render(<Harness />);
else document.body.textContent = 'Test harness unavailable.';
