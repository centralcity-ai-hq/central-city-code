/**
 * Name of the room manifest tool. A leaf module with no imports: server/links/invites.ts and
 * server/remote-mcp/open-invite.ts use it at load time, and in the single-file server bundle an
 * import cycle would otherwise leave it uninitialised and crash every request.
 */
export const ROOM_MANIFEST_TOOL = 'city_room_manifest' as const;
export const ROOM_MANIFEST_TOOLS = [ROOM_MANIFEST_TOOL] as const;
export type RoomManifestToolName = (typeof ROOM_MANIFEST_TOOLS)[number];
