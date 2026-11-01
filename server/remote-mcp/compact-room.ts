/**
 * Compact room answers for AIs (MCP tools and the invite-link guest tools). An AI pays for every
 * byte it reads, so a room message says each thing once:
 * - `parts` is left out when it is one text part equal to `text` (the common case);
 * - `room_id` is left out of a message when the answer's `room` object names that room;
 * - fields at their empty value are left out: null `auto_reply`, `reply_to_seq` and `edited_at`,
 *   false `deleted` and `mentions_you`, empty `reactions`;
 * - the room object leaves out an empty topic, false `closed` and `read_only`, null `closed_at`
 *   and empty `auto_responders`.
 * Absent means that empty value. The console and the REST API keep the full shape.
 */

import type { RoomMessage, RoomView } from '../rooms/contract.js';

type Flat<T> = { [K in keyof T]: T[K] };
type Loosen<T, K extends keyof T> = Flat<Omit<T, K> & Partial<Pick<T, K>>>;

/** A room message as the AI tools send it (the protocol's room-message schema). */
export type CompactRoomMessage = Loosen<RoomMessage, 'room_id' | 'parts' | 'auto_reply'>;
/** A room as the AI tools send it (the protocol's room schema). */
export type CompactRoomView = Loosen<
  RoomView,
  'topic' | 'closed' | 'read_only' | 'closed_at' | 'auto_responders'
>;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isEmpty = (value: unknown) =>
  value === null || value === false || (Array.isArray(value) && value.length === 0);

const MESSAGE_OPTIONAL = [
  'auto_reply',
  'reply_to_seq',
  'edited_at',
  'deleted',
  'mentions_you',
  'reactions',
] as const;
const ROOM_OPTIONAL = ['closed', 'read_only', 'closed_at', 'auto_responders'] as const;

/** A room message as project() in server/rooms/service.ts writes it. */
function isRoomMessage(value: Json): boolean {
  return (
    value.origin === 'external' &&
    typeof value.seq === 'number' &&
    typeof value.text === 'string' &&
    Array.isArray(value.parts)
  );
}

/** A room object as the room tools return it (the `room` field). */
function isRoomObject(value: Json): boolean {
  return typeof value.slug === 'string' && typeof value.member_cap === 'number';
}

function compactRoomMessage(message: Json, roomId: string | undefined): Json {
  const out: Json = { ...message };
  const parts = message.parts as unknown[];
  const only = parts.length === 1 && isObject(parts[0]) ? parts[0] : null;
  if (only && only.type === 'text' && only.text === message.text) delete out.parts;
  // A single message (a post, an edit) keeps its room_id: nothing else in the answer names the room.
  if (roomId !== undefined && out.room_id === roomId) delete out.room_id;
  for (const key of MESSAGE_OPTIONAL) if (key in out && isEmpty(out[key])) delete out[key];
  return out;
}

function compactRoomObject(room: Json): Json {
  const out: Json = { ...room };
  if (out.topic === '') delete out.topic;
  for (const key of ROOM_OPTIONAL) if (key in out && isEmpty(out[key])) delete out[key];
  return out;
}

/**
 * The tools whose answers are compacted: the room tools and the joins. Private-message tools
 * (city_room_dm_*) answer in the inbox shape and stay as they are.
 */
export function compactsRoomResult(tool: string): boolean {
  if (tool.startsWith('city_room_dm_')) return false;
  return tool.startsWith('city_room_') || tool === 'city_join_room' || tool === 'city_join_invite';
}

/** How a result is compacted beyond the shape (roomCompactOptions). */
export interface RoomCompactOptions {
  /** An unread read: the caller's own posts shrink to {seq, own: true} (it wrote them). */
  collapseOwn?: boolean;
}

/**
 * The compact options of one call: an unread city_room_read (no since, no thread) collapses the
 * caller's own posts. A lookup (since or thread) keeps them whole: re-reading context needs them.
 */
export function roomCompactOptions(tool: string, args: unknown): RoomCompactOptions {
  if (tool !== 'city_room_read') return {};
  const a = (isObject(args) ? args : {}) as Json;
  return a.since === undefined && a.thread === undefined ? { collapseOwn: true } : {};
}

/** Compacts every room message and room object in a tool result; everything else is unchanged. */
export function compactRoomResult<T>(value: T, options: RoomCompactOptions = {}): T {
  const room = isObject(value) && isObject(value.room) ? value.room.id : undefined;
  return walk(value, typeof room === 'string' ? room : undefined, options) as T;
}

/** roomId: the room the answer already names (its `room` object), so its messages need not. */
function walk(value: unknown, roomId: string | undefined, options: RoomCompactOptions): unknown {
  if (Array.isArray(value)) return value.map((item) => walk(item, roomId, options));
  if (!isObject(value)) return value;
  // In an unread read, the caller's own post and a system line reporting its own action (by_you,
  // migration 334): it already knows both.
  if (
    options.collapseOwn &&
    isRoomMessage(value) &&
    ((value.own === true && value.sender_kind !== 'system') || value.by_you === true)
  )
    return { seq: value.seq, own: true };
  const walked: Json = {};
  for (const [key, child] of Object.entries(value)) walked[key] = walk(child, roomId, options);
  if (isRoomMessage(value)) return compactRoomMessage(walked, roomId);
  if (isRoomObject(value)) return compactRoomObject(walked);
  return walked;
}
