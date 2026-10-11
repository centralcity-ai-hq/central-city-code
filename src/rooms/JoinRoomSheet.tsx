import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import { RoomsError, withRoomDeadline, type Room, type RoomsClient } from './api';
import { describe } from './useRoomThread';
import { useDialogFocus } from './useDialogFocus';
import { PanelHead } from './PanelV3';

/** One message for every unusable invite, so a code's existence never leaks. */
const INVALID = 'This invite is invalid or has expired. Ask the host for a new one.';

/** A link (https://.../j/..., /r/...#...) or a short code (7K4M-Q9XP); trimmed, code uppercased. */
export function readInvite(input: string): { link: string } | { code: string } | null {
  const value = input.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value) || value.startsWith('/')) return { link: value };
  return { code: value.toUpperCase() };
}

/**
 * "Join a room": a signed-in person pastes the invite link or the short code
 * the host shared and joins as themselves, a person in the room. Their AI can join later.
 */
export function JoinRoomSheet({
  client,
  accountName,
  onClose,
  onJoined,
}: {
  client: RoomsClient;
  accountName: string;
  onClose: () => void;
  onJoined: (room: Room) => void;
}) {
  const [invite, setInvite] = useState('');
  // You join as yourself; the name override stays tucked away until someone asks for it.
  const [name, setName] = useState(accountName.slice(0, 40));
  const [naming, setNaming] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID());
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  const sheet = useRef<HTMLFormElement>(null);
  useDialogFocus(sheet, onClose);

  async function join() {
    const parsed = readInvite(invite);
    if (!parsed) return;
    setBusy(true);
    setError('');
    try {
      const room = await withRoomDeadline(
        client.joinAsPerson({ ...parsed, name: name.trim(), idempotency_key: key.current }),
      );
      onJoined(room);
    } catch (err) {
      key.current = crypto.randomUUID();
      if (err instanceof RoomsError && err.code === 'invite_invalid') setError(INVALID);
      else if (err instanceof ApiError && err.status === 400) setError(INVALID);
      else if (err instanceof ApiError && err.status === 403)
        setError(
          "The host doesn't let people join this room as themselves. Your AI can still join with the invite.",
        );
      else setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="rm-backdrop rm-v3-scrim"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <form
        ref={sheet}
        className="rm-sheet rm-v3-sheet rm-join-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rm-join-title"
        onSubmit={(event) => {
          event.preventDefault();
          void join();
        }}
      >
        <PanelHead closeLabel="Close" onClose={onClose}>
          <h2 id="rm-join-title">Join a room</h2>
        </PanelHead>
        <p className="rm-muted">
          Paste the invite link or type the code the host gave you. You join as yourself.
        </p>
        <label className="rm-field">
          <span>Invite link or code</span>
          <input
            ref={field}
            className="rm-input"
            value={invite}
            autoComplete="off"
            spellCheck={false}
            placeholder="centralcity.ai/j/… or 7K4M-Q9XP"
            onChange={(event) => {
              setInvite(event.target.value);
              setError('');
            }}
          />
        </label>
        {naming ? (
          <label className="rm-field">
            <span>Your name in the room</span>
            <input
              className="rm-input"
              value={name}
              maxLength={40}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        ) : (
          <p className="rm-muted rm-join-identity">
            You join as {name || accountName}.{' '}
            <button type="button" className="rm-v2-link" onClick={() => setNaming(true)}>
              Use a different name
            </button>
          </p>
        )}
        {error ? (
          <p className="rm-inline-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="rm-v3-sheet-actions">
          <button type="button" className="rm-v3-btn rm-v3-btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="rm-v3-btn rm-v3-btn-primary"
            disabled={busy || !readInvite(invite)}
          >
            {busy ? 'Joining…' : 'Join room'}
          </button>
        </div>
      </form>
    </div>
  );
}
