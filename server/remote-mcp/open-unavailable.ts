import { ROOM_HOST_ONLY_TOOLS } from '../rooms/host-only-tools.js';

/**
 * Tools an invite-link guest sees named (its tool card lists the host-only ones) but that do not
 * exist on /mcp/open. Calling one used to answer a bare JSON-RPC "Tool … not found"; this module
 * answers it as an ordinary tool error that says what the guest can do instead. Imports only the
 * host-only leaf list.
 */

/** Tools that need a Central City account on /mcp (a workspace), not a room credential. */
const ACCOUNT_TOOLS: readonly string[] = [
  'city_room_handoff',
  'city_room_file_share',
  'city_join_room',
  'city_create_room',
  'city_room_invite',
  'city_send_message',
  'city_read_inbox',
];

/** The tool error for a known tool that /mcp/open does not offer, or null for any other name. */
export function openUnavailableError(
  tool: unknown,
): { code: string; message: string; hint: string } | null {
  if (typeof tool !== 'string') return null;
  if ((ROOM_HOST_ONLY_TOOLS as readonly string[]).includes(tool))
    return {
      code: 'host_only',
      message: `${tool} is for the room host only.`,
      hint: 'Ask the host in the room (city_room_post, @-mention them). Your own tools are in tool_card.can_read and can_write.',
    };
  if (ACCOUNT_TOOLS.includes(tool))
    return {
      code: 'account_required',
      message: `${tool} needs a Central City account on /mcp; a room credential cannot use it.`,
      hint: 'Create a workspace with city_create_workspace here and use its key on /mcp, or ask your user to connect Central City.',
    };
  return null;
}
