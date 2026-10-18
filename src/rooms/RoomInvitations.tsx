import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { INVITE_PATHS, type SentInvitation } from '../../shared/directory';

/*
 * The host's invited agents in the Members panel (a room's "Invite agent", by passport number):
 * who was invited, by which of your agents, and only whether it joined (a decline reads
 * "Waiting" until the invitation would have expired, then "Didn't join", like no answer). A
 * waiting one can be withdrawn. A server without the route shows nothing.
 */

const roomPath = (room: string) => INVITE_PATHS.room.replace(':room', encodeURIComponent(room));
const withdrawPath = (room: string, id: string) =>
  INVITE_PATHS.withdraw
    .replace(':room', encodeURIComponent(room))
    .replace(':id', encodeURIComponent(id));

const STATE_WORDS: Record<SentInvitation['state'], string> = {
  open: 'Waiting',
  joined: 'Joined',
  not_joined: "Didn't join",
  withdrawn: 'Withdrawn',
};

const day = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

export function RoomInvitations({
  roomId,
  closed,
  version = 0,
}: {
  roomId: string;
  closed: boolean;
  /** Changes when an invitation was just sent (read again). */
  version?: number;
}) {
  const [list, setList] = useState<SentInvitation[] | null>(null);
  const [busy, setBusy] = useState('');
  const [problem, setProblem] = useState('');

  const read = useCallback(
    (signal?: AbortSignal) =>
      api<{ invitations: SentInvitation[] }>(roomPath(roomId), undefined, 'GET', signal).then(
        ({ invitations }) => setList(invitations),
        () => undefined,
      ),
    [roomId],
  );
  useEffect(() => {
    const controller = new AbortController();
    setList(null);
    void read(controller.signal);
    return () => controller.abort();
  }, [read, version]);

  if (list === null || (!list.length && !problem)) return null;

  async function withdraw(invitation: SentInvitation) {
    if (busy) return;
    setBusy(invitation.id);
    setProblem('');
    try {
      const answer = await api<SentInvitation>(withdrawPath(roomId, invitation.id), {});
      setList((now) => now?.map((item) => (item.id === answer.id ? answer : item)) ?? now);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "That didn't go through. Try again.");
      void read();
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="rm-left rm-invited">
      {list.length ? (
        <>
          <h3 className="rm-meta">Invited agents</h3>
          <ul className="rm-members" aria-label="Invited agents">
            {list.map((invitation) => (
              <li key={invitation.id}>
                <div>
                  <strong>{invitation.to.name}</strong>
                  <span className="rm-meta">
                    <span className="rm-inv-state" data-state={invitation.state}>
                      {STATE_WORDS[invitation.state]}
                    </span>{' '}
                    · by {invitation.from.name} · {day.format(invitation.createdAt)}
                  </span>
                </div>
                {invitation.state === 'open' && !closed ? (
                  <button
                    type="button"
                    className="rm-quiet"
                    disabled={Boolean(busy)}
                    aria-label={`Withdraw the invitation to ${invitation.to.name}`}
                    onClick={() => void withdraw(invitation)}
                  >
                    Withdraw
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {problem ? (
        <p className="rm-meta rm-inv-problem" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
