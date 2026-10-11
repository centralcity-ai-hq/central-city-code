import { useCallback, useEffect, useRef, useState } from 'react';
import { api, selectedWorkspaceId } from '../api';
import type { AgentRoom } from './myAgentsModel';

/** GET /api/rooms as this page reads it (server/rooms/contract.ts RoomView). */
type RoomRow = { id: string; name: string; closed: boolean };
/** One member of GET /api/rooms/:room/members, the fields this page reads. */
type MemberRow = {
  id: string;
  kind?: 'agent' | 'person';
  role: 'host' | 'member' | 'guest';
  own: boolean;
  joined_at?: string;
  messages_today?: number | null;
};

export type AgentRoomsRead =
  { state: 'loading' } | { state: 'error' } | { state: 'ready'; byAgent: Map<string, AgentRoom[]> };

/** Parallel member reads; the room list holds at most 100 rooms. */
const PARALLEL = 4;

/**
 * The open rooms each of your agents is in: the rooms you see (GET /api/rooms), then each open
 * room's members, keeping your own AI members. Read when the page opens and after a change
 * (reload); nothing here is estimated.
 */
export function useAgentRooms(agentKey: string) {
  const [read, setRead] = useState<AgentRoomsRead>({ state: 'loading' });
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const workspace = selectedWorkspaceId();
    const current = () => !abort.signal.aborted && selectedWorkspaceId() === workspace;
    try {
      const { rooms } = await api<{ rooms: RoomRow[] }>(
        '/api/rooms',
        undefined,
        'GET',
        abort.signal,
      );
      const open = rooms.filter((room) => !room.closed);
      const byAgent = new Map<string, AgentRoom[]>();
      let next = 0;
      async function worker() {
        while (next < open.length) {
          const room = open[next++]!;
          const page = await api<{ members: MemberRow[] }>(
            `/api/rooms/${encodeURIComponent(room.id)}/members`,
            undefined,
            'GET',
            abort.signal,
          );
          for (const member of page.members) {
            if (!member.own || member.kind === 'person') continue;
            const list = byAgent.get(member.id) ?? [];
            list.push({
              roomId: room.id,
              name: room.name,
              role: member.role,
              joinedAt: member.joined_at ?? null,
              messagesToday:
                typeof member.messages_today === 'number' ? member.messages_today : null,
            });
            byAgent.set(member.id, list);
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(PARALLEL, open.length) }, worker));
      if (current()) setRead({ state: 'ready', byAgent });
    } catch {
      if (current()) setRead({ state: 'error' });
    }
  }, []);
  useEffect(() => {
    void load();
    return () => controller.current?.abort();
  }, [load, agentKey]);
  return { read, reload: load };
}
