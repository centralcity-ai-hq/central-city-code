import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { ApiError } from '../api';
import { withRoomDeadline, type Agent, type RoomsClient } from './api';
import { describe } from './useRoomThread';

/**
 * "Add my AI": a person in a room (not the host) adds one of their own AIs, with no invite link
 * (POST /api/rooms/:room/join { agent_id }; the server allows it while the account is a person
 * member and the host lets members bring their AI). An AI that is not in the list yet can join by
 * itself: connected over MCP, it joins the room by its id.
 */
export function AddMyAiSheet({
  client,
  roomId,
  inRoom,
  onClose,
  onAdded,
}: {
  client: RoomsClient;
  roomId: string;
  /** The viewer's agents already in this room. */
  inRoom: ReadonlySet<string>;
  onClose: () => void;
  onAdded: () => void;
}) {
  // Taken once: the members list refreshes while the sheet is open.
  const [taken] = useState(() => new Set(inRoom));
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const key = useRef(crypto.randomUUID());
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => close.current?.focus(), []);
  useEffect(() => {
    let active = true;
    withRoomDeadline(client.listAgents())
      .then((list) => {
        if (!active) return;
        const free = list.filter((agent) => !taken.has(agent.id));
        setAgents(free);
        if (free.length === 1) setChoice(free[0]!.id);
      })
      .catch((err) => {
        if (!active) return;
        setAgents([]);
        setError(describe(err));
      });
    return () => {
      active = false;
    };
  }, [client, taken]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function add() {
    if (!choice) return;
    setBusy(true);
    setError('');
    try {
      await withRoomDeadline(
        client.join({ room_id: roomId, agent_id: choice, idempotency_key: key.current }),
      );
      onAdded();
    } catch (err) {
      key.current = crypto.randomUUID();
      if (err instanceof ApiError && err.status === 403)
        setError("The host doesn't let members bring their own AI to this room.");
      else if (err instanceof ApiError && err.code === 'name_taken')
        setError(
          'A person in this room already uses your AI’s name. Rename your AI, then try again.',
        );
      else if (err instanceof ApiError && (err.code === 'room_full' || err.code === 'room_closed'))
        // The server's own sentence, e.g. "The room is full (50 members)."
        setError(err.message);
      else setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  const ask = `Join the Central City room ${roomId}`;
  return (
    <div
      className="rm-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <form
        className="rm-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rm-add-ai-title"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <div className="rm-sheet-head">
          <h2 id="rm-add-ai-title">Add my AI</h2>
          <button
            ref={close}
            type="button"
            className="rm-icon"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        {agents === null ? (
          <p className="rm-muted" role="status">
            Loading your AIs…
          </p>
        ) : agents.length ? (
          <fieldset className="rm-add-ai-list">
            <legend className="rm-muted">Choose which of your AIs joins this room.</legend>
            {agents.map((agent) => (
              <label key={agent.id} className="rm-add-ai-option">
                <input
                  type="radio"
                  name="rm-add-ai"
                  value={agent.id}
                  checked={choice === agent.id}
                  onChange={() => setChoice(agent.id)}
                />
                <span>{agent.name}</span>
              </label>
            ))}
          </fieldset>
        ) : (
          <p className="rm-muted">
            None of your AIs can join yet. <a href="/connect">Connect your AI</a> first.
          </p>
        )}
        <p className="rm-muted">
          Your AI isn't listed? Once it is connected, ask it: <code>{ask}</code>
        </p>
        {error ? (
          <p className="rm-inline-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="rm-actions">
          <button type="submit" className="rm-primary" disabled={busy || !choice}>
            {busy ? 'Adding…' : 'Add to room'}
          </button>
          <button type="button" className="rm-quiet" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
