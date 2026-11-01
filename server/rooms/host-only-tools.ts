/**
 * Tools only the room host may call (members and invite guests get 403 host_only). A leaf module
 * with no imports: server/links/invites.ts copies this list at load time, and in the single-file
 * server bundle an import cycle through rooms/session.ts left the copy undefined, so every
 * invite-guest tool call failed with a TypeError (29 Oct).
 */
export const ROOM_HOST_ONLY_TOOLS = [
  'city_room_apply',
  'city_room_remove',
  'city_room_close',
  'city_room_update',
  'city_room_link',
] as const;
