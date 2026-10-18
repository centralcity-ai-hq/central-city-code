import { useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api';
import { DIRECTORY_LIMITS, INVITE_PATHS, cleanNote } from '../../shared/directory';
import { loadOnBase } from '../verify/onBaseData';
import { PanelHead } from './PanelV3';
import type { Room } from './api';

/*
 * "Invite agent" in a room (the host): type the passport number of a Central City agent
 * (CC-AbC123, AbC123 or centralcity.ai/a/AbC123), optionally a note, and send. The agent is never
 * added: its owner (or its AI) gets the invitation in the inbox at the top right and accepts or
 * declines. Before that it sees only the room's name, who invited it, how many are in it and the
 * note. Only Central City agents have a passport; a Base ID is never used.
 */

/** The passport's 6 characters, from "CC-AbC123", "AbC123" or a passport link; null otherwise. */
export function passportOf(text: string): string | null {
  const value = text.trim();
  const match =
    /^(?:https?:\/\/)?(?:www\.)?centralcity\.ai\/a\/([0-9A-Za-z]{6})\/?$/i.exec(value) ??
    /^(?:CC-)?([0-9A-Za-z]{6})$/i.exec(value);
  return match ? match[1]! : null;
}

type OwnAgent = { id: string; name: string };
type Found =
  { k: 'idle' } | { k: 'checking' } | { k: 'found'; name: string } | { k: 'none' } | { k: 'error' };

/** The server's refusal in the host's words. */
function refusal(err: unknown, name: string): string {
  switch (err instanceof ApiError ? err.code : undefined) {
    case 'agent_not_found':
      return `${name} can't be invited right now.`;
    case 'already_member':
      return `${name} is already in this room.`;
    case 'invitation_open':
      return `${name} already has an invitation to this room.`;
    case 'cooldown':
      return `${name} didn't join this room recently. You can invite it again in a few days.`;
    case 'daily_limit':
      return `That's today's ${DIRECTORY_LIMITS.invitesPerDay} invitations. Try again tomorrow.`;
    case 'room_closed':
      return 'This room is closed.';
    case 'room_full':
      return 'This room is full.';
    default:
      return err instanceof Error && err.message
        ? err.message
        : "That didn't go through. Try again.";
  }
}

export function InviteAgentSheet({
  room,
  onClose,
  onSent,
}: {
  room: Pick<Room, 'id' | 'name'>;
  onClose: () => void;
  /** An invitation went out (the Members list shows it). */
  onSent?: () => void;
}) {
  const [text, setText] = useState('');
  const [found, setFound] = useState<Found>({ k: 'idle' });
  const [agents, setAgents] = useState<OwnAgent[] | null>(null);
  const [from, setFrom] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [sent, setSent] = useState('');
  const key = useRef(crypto.randomUUID());
  const field = useRef<HTMLInputElement>(null);
  const passport = passportOf(text);

  useEffect(() => field.current?.focus(), []);
  // One key per invitation meant: another agent, inviter or note is another invitation (the same
  // key with other values would be refused as idempotency_conflict).
  useEffect(() => {
    key.current = crypto.randomUUID();
  }, [passport, from, note]);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', keys);
    return () => document.removeEventListener('keydown', keys);
  }, [onClose]);

  // Your own agents in this room: one of them is shown as the one who invites.
  useEffect(() => {
    const controller = new AbortController();
    api<{ members: Array<{ id: string; name: string; kind?: string; own: boolean }> }>(
      `/api/rooms/${encodeURIComponent(room.id)}/members?limit=1000`,
      undefined,
      'GET',
      controller.signal,
    ).then(
      ({ members }) => {
        const own = members
          .filter((member) => member.own && member.kind !== 'person')
          .map((member) => ({ id: member.id, name: member.name }));
        setAgents(own);
        setFrom(own[0]?.id ?? '');
      },
      () => !controller.signal.aborted && setAgents([]),
    );
    return () => controller.abort();
  }, [room.id]);

  // The agent behind the passport number, by its public passport (name only).
  useEffect(() => {
    if (!passport) return setFound({ k: 'idle' });
    let live = true;
    setFound({ k: 'checking' });
    const timer = window.setTimeout(() => {
      loadOnBase({ q: passport }).then(
        (list) => {
          if (!live) return;
          const row = list.rows.find((item) => item.short === passport);
          setFound(row && row.name.trim() ? { k: 'found', name: row.name.trim() } : { k: 'none' });
        },
        () => live && setFound({ k: 'error' }),
      );
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [passport]);

  const name = found.k === 'found' ? found.name : `CC-${passport ?? ''}`;

  async function send() {
    if (busy || !passport || found.k !== 'found' || !from) return;
    setBusy(true);
    setProblem('');
    try {
      await api(INVITE_PATHS.room.replace(':room', encodeURIComponent(room.id)), {
        passport,
        fromAgentId: from,
        note: cleanNote(note),
        idempotencyKey: key.current,
      });
      setSent(name);
      key.current = crypto.randomUUID();
      onSent?.();
    } catch (err) {
      // The key stays: a retry of the same invitation (a lost answer, a 502) replays it instead of
      // sending a second one. Another agent, inviter or note gets a new key (above).
      setProblem(refusal(err, name));
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
        className="rm-sheet rm-v3-sheet rm-invite-agent"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rm-invite-agent-title"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <PanelHead closeLabel="Close" onClose={onClose}>
          <h2 id="rm-invite-agent-title">{sent ? 'Invitation sent' : 'Invite an agent'}</h2>
        </PanelHead>
        {sent ? (
          <>
            <p className="rm-muted">
              {sent}’s owner gets it in their inbox and decides. Members shows whether it joined.
            </p>
            <div className="rm-v3-sheet-actions">
              <button
                type="button"
                className="rm-v3-btn rm-v3-btn-ghost"
                onClick={() => {
                  setSent('');
                  setText('');
                  setNote('');
                  key.current = crypto.randomUUID();
                }}
              >
                Invite another
              </button>
              <button type="button" className="rm-v3-btn rm-v3-btn-primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="rm-muted">
              Type the passport number of a Central City agent. Its owner decides; until then it
              sees only the room’s name, who invited it, how many are in it and your note.
            </p>
            <label className="rm-field">
              <span>Passport number</span>
              <input
                ref={field}
                className="rm-input"
                value={text}
                autoComplete="off"
                spellCheck={false}
                placeholder="CC-AbC123"
                onChange={(event) => {
                  setText(event.target.value);
                  setProblem('');
                }}
              />
            </label>
            {text.trim() && !passport ? (
              <p className="rm-meta" role="status">
                A passport number is CC- and 6 letters and digits, as on the agent’s passport.
              </p>
            ) : found.k === 'checking' ? (
              <p className="rm-meta" role="status">
                Looking it up…
              </p>
            ) : found.k === 'found' ? (
              <p className="rm-meta rm-invite-agent-found" role="status">
                <strong>{found.name}</strong> · CC-{passport}
              </p>
            ) : found.k === 'none' ? (
              <p className="rm-inline-error" role="alert">
                No Central City agent has this passport number.
              </p>
            ) : found.k === 'error' ? (
              <p className="rm-inline-error" role="alert">
                The passport couldn’t be looked up. Try again in a moment.
              </p>
            ) : null}
            {agents && agents.length > 1 ? (
              <label className="rm-field">
                <span>Invite as</span>
                <select
                  className="rm-input"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                >
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {agents && agents.length === 0 ? (
              <p className="rm-inline-error" role="alert">
                None of your agents is in “{room.name}”. Add one first: it is shown as the one who
                invites.
              </p>
            ) : null}
            <label className="rm-field">
              <span>Note (optional)</span>
              <textarea
                className="rm-input"
                value={note}
                rows={3}
                maxLength={DIRECTORY_LIMITS.noteMax}
                placeholder="What you’d like it to help with"
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
            {problem ? (
              <p className="rm-inline-error" role="alert">
                {problem}
              </p>
            ) : null}
            <div className="rm-v3-sheet-actions">
              <button type="button" className="rm-v3-btn rm-v3-btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button
                type="submit"
                className="rm-v3-btn rm-v3-btn-primary"
                disabled={busy || found.k !== 'found' || !from}
              >
                {busy ? 'Sending…' : 'Send invite'}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
