import './messages-rooms.css';
import { useRef, useState } from 'react';
import { api } from '../../api';
import {
  addableRooms,
  agentRooms,
  membersLabel,
  type MemberLite,
  type RoomLite,
} from './messagesRoomsModel';
import {
  ErrorLine,
  IconChev,
  IconPlus,
  LoadingRow,
  ScreenFrame,
  failure,
  useLoad,
  useToast,
  type AgentScreenProps,
} from './messagesRoomsShared';

/** Parallel member reads; the room list holds at most 100 rooms. */
const PARALLEL = 4;
/** Members per page (the server's maximum); larger rooms continue with next_cursor. */
const MEMBERS_PAGE = 1000;

type RoomsData = { rooms: RoomLite[]; members: Map<string, MemberLite[]> };

/**
 * The rooms you see (GET /api/rooms, closed ones too) and each room's members, so the agent's
 * rooms (open: live, closed: ended) and the rooms it can be added to are both known.
 */
async function readRooms(signal: AbortSignal): Promise<RoomsData> {
  const { rooms } = await api<{ rooms: RoomLite[] }>('/api/rooms', undefined, 'GET', signal);
  const members = new Map<string, MemberLite[]>();
  let next = 0;
  async function worker() {
    while (next < rooms.length) {
      const room = rooms[next++]!;
      const list: MemberLite[] = [];
      let cursor: string | undefined;
      do {
        const query = `limit=${MEMBERS_PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const page = await api<{ members: MemberLite[]; next_cursor?: string | null }>(
          `/api/rooms/${encodeURIComponent(room.id)}/members?${query}`,
          undefined,
          'GET',
          signal,
        );
        list.push(...page.members);
        cursor = page.next_cursor ?? undefined;
      } while (cursor);
      members.set(room.id, list);
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, rooms.length) }, worker));
  return { rooms, members };
}

/** The rooms read for one agent, shared by Rooms and Add to a room. */
function useAgentRoomsV4(agentId: string) {
  return useLoad<RoomsData>(`rooms:${agentId}`, readRooms);
}

/**
 * Rooms of one agent: each room with its members and live/ended state, Leave (never for the
 * room's host agent), and "Add to a room". Empty: "Not in any room".
 */
export function RoomsScreen({ agent, onBack, onOpen, onChanged, backLabel }: AgentScreenProps) {
  const { load, reload, setLoad } = useAgentRoomsV4(agent.id);
  const toast = useToast();
  const [leaving, setLeaving] = useState('');
  const [error, setError] = useState('');
  const rows =
    load.state === 'ready' ? agentRooms(load.data.rooms, load.data.members, agent.id) : [];

  async function leave(roomId: string, name: string) {
    if (leaving) return;
    setLeaving(roomId);
    setError('');
    try {
      await api(`/api/rooms/${encodeURIComponent(roomId)}/leave`, { agent_id: agent.id });
      setLoad((prev) => {
        if (prev.state !== 'ready') return prev;
        const members = new Map(prev.data.members);
        members.set(
          roomId,
          (members.get(roomId) ?? []).filter((member) => member.id !== agent.id),
        );
        const rooms = prev.data.rooms.map((room) =>
          room.id === roomId ? { ...room, member_count: Math.max(0, room.member_count - 1) } : room,
        );
        return { state: 'ready', data: { rooms, members } };
      });
      toast.show(`Left “${name}”`);
      onChanged?.();
    } catch (err) {
      setError(failure(err));
    } finally {
      setLeaving('');
    }
  }

  return (
    <ScreenFrame backLabel={backLabel ?? agent.name} onBack={onBack} title="Rooms">
      {load.state === 'loading' ? (
        <LoadingRow />
      ) : load.state === 'error' ? (
        <ErrorLine message={load.message} onRetry={() => void reload()} />
      ) : (
        <>
          {rows.length ? (
            <div className="amr4-group">
              {rows.map((room) => (
                <div key={room.id} className="amr4-gr">
                  <span className="amr4-dot" data-off={room.status === 'ended' || undefined} />
                  <span className="amr4-two">
                    <b>{room.name}</b>
                    <span>
                      {membersLabel(room.memberCount)} · {room.status}
                    </span>
                  </span>
                  {room.canLeave ? (
                    <button
                      type="button"
                      className="amr4-quiet amr4-leave"
                      disabled={Boolean(leaving)}
                      onClick={() => void leave(room.id, room.name)}
                    >
                      Leave
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="amr4-hero2">
              <b>Not in any room</b>
              <span>Add {agent.name} to a room to work with others.</span>
            </div>
          )}
          {error ? (
            <p className="amr4-note amr4-errline" role="alert">
              {error}
            </p>
          ) : null}
          <button
            type="button"
            className="amr4-btn amr4-soft amr4-block"
            onClick={() => onOpen('rooms-add')}
          >
            <IconPlus />
            Add to a room
          </button>
        </>
      )}
      {toast.node}
    </ScreenFrame>
  );
}

/**
 * "Add to a room": the person's rooms the server lets this agent join (the owner hosts the room,
 * or is in it as a person while the host lets members bring their AI). Choosing one adds the
 * agent (POST /api/rooms/:room/join {agent_id}) and returns to Rooms.
 */
export function AddToRoomScreen({ agent, onBack, onChanged, backLabel }: AgentScreenProps) {
  const { load, reload } = useAgentRoomsV4(agent.id);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const key = useRef(crypto.randomUUID());
  const rooms =
    load.state === 'ready' ? addableRooms(load.data.rooms, load.data.members, agent.id) : [];

  async function add(roomId: string) {
    if (busy) return;
    setBusy(roomId);
    setError('');
    try {
      await api(`/api/rooms/${encodeURIComponent(roomId)}/join`, {
        agent_id: agent.id,
        idempotency_key: key.current,
      });
      onChanged?.();
      onBack();
    } catch (err) {
      key.current = crypto.randomUUID();
      setError(failure(err));
      setBusy('');
    }
  }

  return (
    <ScreenFrame backLabel={backLabel ?? 'Rooms'} onBack={onBack} title="Add to a room">
      {load.state === 'loading' ? (
        <LoadingRow />
      ) : load.state === 'error' ? (
        <ErrorLine message={load.message} onRetry={() => void reload()} />
      ) : rooms.length ? (
        <div className="amr4-group">
          {rooms.map((room) => (
            <button
              key={room.id}
              type="button"
              className="amr4-gr"
              disabled={Boolean(busy)}
              onClick={() => void add(room.id)}
            >
              <span className="amr4-dot" />
              <span className="amr4-two">
                <b>{room.name}</b>
                <span>{membersLabel(room.member_count)}</span>
              </span>
              {busy === room.id ? <span className="amr4-spin" /> : <IconChev />}
            </button>
          ))}
        </div>
      ) : (
        <div className="amr4-hero2">
          <b>No room to add {agent.name} to</b>
          <span>Rooms you host or are in show up here.</span>
        </div>
      )}
      {error ? (
        <p className="amr4-note amr4-errline" role="alert">
          {error}
        </p>
      ) : null}
    </ScreenFrame>
  );
}
