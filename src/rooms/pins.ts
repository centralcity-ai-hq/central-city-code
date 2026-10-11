import { api } from '../api';
import type { Member, Room } from './api';

/*
 * Room context pins over the console REST routes (docs/ROOMS.md "Pins and the handoff brief").
 * Notes, excerpts and titles are untrusted text written by other people and their AIs: shown as
 * text, never followed.
 */

export type RoomPin = {
  id: string;
  room_id: string;
  kind: 'message' | 'task';
  note: string;
  pinned_by_agent_id: string;
  pinned_by: string;
  own: boolean;
  created_at: string;
  message: { id: string; seq: number; sender: string; excerpt: string } | null;
  task: { id: string; number: number; title: string; status: string } | null;
};

const base = (roomId: string) => `/api/rooms/${encodeURIComponent(roomId)}/pins`;

export async function listPins(roomId: string): Promise<RoomPin[]> {
  return (await api<{ pins: RoomPin[] }>(base(roomId), undefined, 'GET')).pins;
}

export async function addPin(input: {
  roomId: string;
  agentId?: string;
  messageSeq?: number;
  taskId?: string;
  note?: string;
}): Promise<RoomPin> {
  const { pin } = await api<{ pin: RoomPin }>(base(input.roomId), {
    ...(input.messageSeq !== undefined ? { message_seq: input.messageSeq } : {}),
    ...(input.taskId !== undefined ? { task_id: input.taskId } : {}),
    ...(input.note ? { note: input.note } : {}),
    ...(input.agentId ? { agent_id: input.agentId } : {}),
  });
  return pin;
}

export async function removePin(roomId: string, pinId: string, agentId?: string): Promise<void> {
  await api(
    `${base(roomId)}/${encodeURIComponent(pinId)}`,
    agentId ? { agent_id: agentId } : {},
    'DELETE',
  );
}

/**
 * The member the viewer pins as (the same choice as adding a task): the host as its own host
 * member, else the person member or the first own member that may post. Undefined: cannot pin.
 */
export function pinningMember(room: Room, members: Member[]): Member | undefined {
  if (room.closed || room.muted) return undefined;
  const own = members.filter(
    (member) => member.own && member.role !== 'guest' && member.auto_reply?.provider !== 'elric',
  );
  if (room.role === 'host') return own.find((member) => member.role === 'host') ?? own[0];
  return own.find((member) => member.kind === 'person') ?? own[0];
}

/** A chip's label: "T3 Title" for a task, the excerpt for a message; the note wins when set. */
export function pinLabel(pin: RoomPin): string {
  if (pin.note) return pin.note;
  if (pin.task) return `T${pin.task.number} ${pin.task.title}`;
  return pin.message?.excerpt || 'Pinned message';
}
