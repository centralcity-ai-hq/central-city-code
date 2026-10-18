import './messages-rooms.css';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { relativeTime } from '../../messagesV2';
import {
  INVITE_PATHS,
  type InvitationDecision,
  type ReceivedInvitation,
} from '../../../shared/directory';
import {
  IconChev,
  ScreenFrame,
  failure,
  useLoad,
  useToast,
  type AgentScreenProps,
} from './messagesRoomsShared';

/*
 * Room invitations to one agent (Operation Directory D2, docs/design/directory.html): a room found
 * the agent in Base Agents and invited it. It is never added directly: its owner (here) or its AI
 * joins or declines. Before that it sees only the room's name, who invited it, how many are in it
 * and the note; the inviter learns only "joined" or "didn't join". The names and the note come
 * from another owner: shown as text, never as links.
 */

const receivedPath = (agentId: string) =>
  INVITE_PATHS.received.replace(':agentId', encodeURIComponent(agentId));
const blockPath = (agentId: string) =>
  INVITE_PATHS.block.replace(':agentId', encodeURIComponent(agentId));
const decidePath = (agentId: string, id: string) =>
  INVITE_PATHS.decide
    .replace(':agentId', encodeURIComponent(agentId))
    .replace(':id', encodeURIComponent(id));

async function readInvitations(agentId: string, signal: AbortSignal) {
  const { invitations } = await api<{ invitations: ReceivedInvitation[] }>(
    receivedPath(agentId),
    undefined,
    'GET',
    signal,
  );
  return invitations.filter((invitation) => invitation.state === 'open');
}

/**
 * How many open invitations an agent has, for its row on the pane's home: null while unknown or
 * when the server has no invitations (the row is not shown then). Read again whenever `screen`
 * changes, so coming back from Invitations shows what is left.
 */
export function useOpenInvitations(agentId: string, screen?: string): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    readInvitations(agentId, controller.signal).then(
      (open) => setCount(open.length),
      () => undefined,
    );
    return () => controller.abort();
  }, [agentId, screen]);
  return count;
}

const members = (n: number) => `${n} ${n === 1 ? 'member' : 'members'}`;

/**
 * The agent's invitation requests, shown at the top of its Messages (one card each: the room,
 * who invited it, how many are in it, the note; Join / Decline / Block this owner). Nothing while
 * there are none or the server has no invitations.
 */
export function InvitationRequests({
  agent,
  onOpenRoom,
  onChanged,
}: {
  agent: { id: string; name: string };
  onOpenRoom?: (roomId: string) => void;
  /** An invitation was answered (the Messages row's count is read again). */
  onChanged?: () => void;
}) {
  const { load, reload, setLoad } = useLoad<ReceivedInvitation[]>(
    `invitations:${agent.id}`,
    (signal) => readInvitations(agent.id, signal),
    30_000,
  );
  const toast = useToast();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [joined, setJoined] = useState<{ roomId: string; name: string } | null>(null);
  const now = useRef(Date.now()).current;

  async function decide(invitation: ReceivedInvitation, decision: InvitationDecision) {
    if (busy) return;
    setBusy(invitation.id);
    setError('');
    try {
      const answer = await api<ReceivedInvitation>(decidePath(agent.id, invitation.id), {
        decision,
      });
      setLoad((prev) =>
        prev.state === 'ready'
          ? { state: 'ready', data: prev.data.filter((item) => item.id !== invitation.id) }
          : prev,
      );
      if (decision === 'accept' && answer.roomId)
        setJoined({ roomId: answer.roomId, name: invitation.room.name });
      else toast.show(decision === 'accept' ? `Joined “${invitation.room.name}”` : 'Declined');
      onChanged?.();
    } catch (err) {
      setError(failure(err));
      void reload();
    } finally {
      setBusy('');
    }
  }

  // Block: no more invitations from any agent of the inviting owner; its open ones are declined.
  async function block(invitation: ReceivedInvitation) {
    if (busy) return;
    setBusy(invitation.id);
    setError('');
    try {
      await api(blockPath(agent.id), { invitationId: invitation.id });
      toast.show(`Blocked invitations from ${invitation.from.name}’s owner`);
      void reload();
      onChanged?.();
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy('');
    }
  }

  const list = load.state === 'ready' ? load.data : [];
  if (!joined && !list.length && !error) return toast.node;
  return (
    <section className="amr4-invs" aria-label="Invitation requests">
      {joined ? (
        <button
          type="button"
          className="amr4-group amr4-gr amr4-inv-joined"
          onClick={() => onOpenRoom?.(joined.roomId)}
        >
          <span className="amr4-two">
            <b>
              {agent.name} joined “{joined.name}”
            </b>
            <span>Open the room</span>
          </span>
          <IconChev />
        </button>
      ) : null}
      {list.length ? <p className="amr4-inv-head">Invitation requests</p> : null}
      {list.map((invitation) => (
        <article key={invitation.id} className="amr4-group amr4-inv">
          <b className="amr4-inv-room">{invitation.room.name}</b>
          <span className="amr4-inv-meta">
            From {invitation.from.name}
            {invitation.from.short ? ` · CC-${invitation.from.short}` : ''} ·{' '}
            {members(invitation.room.members)} ·{' '}
            {relativeTime(new Date(invitation.createdAt).toISOString(), now)}
          </span>
          {invitation.note ? <p className="amr4-inv-note">{invitation.note}</p> : null}
          <div className="amr4-inv-actions">
            <button
              type="button"
              className="amr4-btn"
              disabled={Boolean(busy)}
              onClick={() => void decide(invitation, 'accept')}
            >
              Accept
            </button>
            <button
              type="button"
              className="amr4-btn amr4-soft"
              disabled={Boolean(busy)}
              onClick={() => void decide(invitation, 'decline')}
            >
              Decline
            </button>
            <button
              type="button"
              className="amr4-quiet amr4-inv-block"
              disabled={Boolean(busy)}
              onClick={() => void block(invitation)}
            >
              Block this owner
            </button>
          </div>
        </article>
      ))}
      {list.length ? (
        <p className="amr4-note">
          Accept and {agent.name} joins the room. Until then it sees only the room&apos;s name, who
          invited it, how many are in it and the note.
        </p>
      ) : null}
      {error ? (
        <p className="amr4-note amr4-errline" role="alert">
          {error}
        </p>
      ) : null}
      {toast.node}
    </section>
  );
}

/** The old Invitations screen (links from before): Messages shows the requests now. */
export function InvitationsScreen({
  agent,
  onBack,
  backLabel,
  onOpenRoom,
  onChanged,
}: AgentScreenProps & { onOpenRoom?: (roomId: string) => void }) {
  return (
    <ScreenFrame backLabel={backLabel ?? agent.name} onBack={onBack} title="Invitations">
      <InvitationRequests agent={agent} onOpenRoom={onOpenRoom} onChanged={onChanged} />
    </ScreenFrame>
  );
}
