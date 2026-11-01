/**
 * Names of the room file tools. A leaf module with no imports: server/links/invites.ts and
 * server/remote-mcp/open-invite.ts use this list at load time, and in the single-file server
 * bundle an import cycle would otherwise leave it uninitialised and crash every request.
 */
export const ROOM_FILE_TOOLS = [
  'city_room_files',
  'city_room_file_versions',
  'city_room_file_upload',
  'city_room_file_finalize',
  'city_room_file_put',
  'city_room_file_download',
  'city_room_file_read',
  'city_room_link_save',
  'city_room_file_share',
] as const;
export type RoomFileToolName = (typeof ROOM_FILE_TOOLS)[number];
/** The file tools an invite-link guest gets: not city_room_file_share (its credential holds one room). */
export const GUEST_FILE_TOOLS: readonly RoomFileToolName[] = ROOM_FILE_TOOLS.filter(
  (name) => name !== 'city_room_file_share',
);
