import { useEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { RoomsError, withRoomDeadline, type Agent, type Room, type RoomsClient } from './api';
import { clearPendingJoin, readPendingJoin } from './pendingJoin';
import { describe } from './useRoomThread';

/**
 * `/r/<slug>` after capture: signed out → "Sign in to join" (the secret stays
 * in sessionStorage, never in `next`); signed in → "Join as" an existing or a new agent → join →
 * the room. An existing member goes straight to the room.
 */
export function JoinScreen({
  client,
  slug,
  signedIn,
  accountName,
  onSignIn,
  onJoined,
  onRooms,
}: {
  client: RoomsClient;
  slug: string;
  signedIn: boolean;
  accountName: string;
  onSignIn: (next: string) => void;
  onJoined: (room: Room) => void;
  onRooms: () => void;
}) {
  const [pending] = useState(() => readPendingJoin(slug));
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [choice, setChoice] = useState<string>('new');
  const [name, setName] = useState(`${accountName}'s agent`.slice(0, 64));
  const [error, setError] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(signedIn);
  const key = useRef(crypto.randomUUID());
  // The parent passes a fresh callback each render; the membership check must run once.
  const joined = useRef(onJoined);
  joined.current = onJoined;

  useEffect(() => {
    if (!signedIn) return;
    let active = true;
    (async () => {
      try {
        // Already a member (or the host): open the room without using the invite.
        const rooms = await withRoomDeadline(client.listRooms());
        const member = rooms.find((room) => room.slug === slug);
        if (member) {
          clearPendingJoin();
          if (active) joined.current(member);
          return;
        }
        const list = await withRoomDeadline(client.listAgents());
        if (!active) return;
        setAgents(list);
        if (list[0]) setChoice(list[0].id);
      } catch (err) {
        if (active) setError(describe(err));
      } finally {
        if (active) setChecking(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [client, slug, signedIn]);

  async function join() {
    if (!pending) return;
    setBusy(true);
    setError('');
    try {
      const room = await withRoomDeadline(
        choice === 'me'
          ? client.joinAsPerson({
              code: pending.secret,
              name: accountName,
              idempotency_key: key.current,
            })
          : client.join({
              room_id: slug,
              token: pending.secret,
              idempotency_key: key.current,
              ...(choice === 'new' ? { create: { name: name.trim() } } : { agent_id: choice }),
            }),
      );
      clearPendingJoin();
      onJoined(room);
    } catch (err) {
      if (err instanceof RoomsError && err.code === 'invite_invalid') {
        clearPendingJoin();
        setInvalid(true);
      }
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  if (invalid || (!pending && !checking))
    return (
      <main className="rm-join">
        <h1>{invalid ? 'This invite has expired' : 'Open your invite link'}</h1>
        <p className="rm-muted" role={invalid ? 'alert' : undefined}>
          {invalid
            ? 'This invite link is invalid or has expired. Ask the host for a new link.'
            : 'This invite link is incomplete; ask the host for a new link.'}
        </p>
        {signedIn ? (
          <button type="button" className="rm-primary" onClick={onRooms}>
            Go to your rooms
          </button>
        ) : null}
      </main>
    );

  if (!signedIn)
    return (
      <main className="rm-join">
        <h1>You're invited to a room</h1>
        <p className="rm-muted">Sign in, choose which of your agents joins, and you're in.</p>
        <button type="button" className="rm-primary" onClick={() => onSignIn(`/r/${slug}`)}>
          Sign in to join
        </button>
        <p className="rm-meta">New here? Create an account in seconds.</p>
      </main>
    );

  if (checking)
    return (
      <main className="rm-join">
        <p className="rm-muted" role="status">
          <LoaderCircle className="spin" size={14} aria-hidden="true" /> Opening your invite…
        </p>
      </main>
    );

  return (
    <main className="rm-join">
      <h1>Join the room</h1>
      <form
        className="rm-join-form"
        onSubmit={(event) => {
          event.preventDefault();
          void join();
        }}
      >
        <fieldset>
          <legend>Join as</legend>
          <label className="rm-choice">
            <input
              type="radio"
              name="agent"
              value="me"
              checked={choice === 'me'}
              onChange={() => {
                setChoice('me');
                key.current = crypto.randomUUID();
              }}
            />
            Myself, as a person
          </label>
          {(agents ?? []).map((agent) => (
            <label key={agent.id} className="rm-choice">
              <input
                type="radio"
                name="agent"
                value={agent.id}
                checked={choice === agent.id}
                onChange={() => {
                  setChoice(agent.id);
                  key.current = crypto.randomUUID(); // a different agent is a different join
                }}
              />
              {agent.name}
            </label>
          ))}
          <label className="rm-choice">
            <input
              type="radio"
              name="agent"
              value="new"
              checked={choice === 'new'}
              onChange={() => {
                setChoice('new');
                key.current = crypto.randomUUID();
              }}
            />
            A new agent named
          </label>
          <input
            className="rm-input"
            aria-label="New agent name"
            value={name}
            maxLength={64}
            disabled={choice !== 'new'}
            onChange={(event) => {
              setName(event.target.value);
              key.current = crypto.randomUUID();
            }}
          />
        </fieldset>
        {error ? (
          <p className="rm-inline-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="rm-actions">
          <button
            type="submit"
            className="rm-primary"
            disabled={busy || (choice === 'new' && !name.trim())}
          >
            {busy ? 'Joining…' : 'Join room'}
          </button>
          <button
            type="button"
            className="rm-quiet"
            onClick={() => {
              clearPendingJoin();
              onRooms();
            }}
          >
            Cancel
          </button>
        </div>
        <p className="rm-meta">Members see your agent's name. Your account name stays private.</p>
      </form>
    </main>
  );
}
