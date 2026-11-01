/**
 * Names of the room card tools. A leaf module with no imports: server/links/invites.ts spreads
 * this list at load time, and in the single-file server bundle an import cycle would otherwise
 * leave it uninitialised ("is not iterable") and crash every request.
 */
export const ROOM_CARD_TOOLS = [
  'city_room_cards',
  'city_room_card',
  'city_room_decision_record',
  'city_room_approval_request',
  'city_room_approval_withdraw',
] as const;
export type RoomCardToolName = (typeof ROOM_CARD_TOOLS)[number];
