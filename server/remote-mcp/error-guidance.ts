import { CREDENTIAL_RENEWED_MESSAGE } from '../links/credential-messages.js';
/**
 * Next steps for the most common tool errors (rooms P1.5): an optional `next: {tool, args?}` and a
 * one-line `hint`, per surface: a member on /mcp, a crc_ room credential on /mcp, a guest on
 * /mcp/open, or a guest on the REST tool path. A next step or hint only names a tool the caller
 * has there. Built only from the error code, ids the caller sent (when they look like ids) and
 * fixed text; it never echoes a credential or any internal value, and never changes a code.
 */

export interface ErrorNext {
  tool: string;
  args?: Record<string, unknown>;
}
export interface ErrorGuidance {
  next?: ErrorNext;
  hint?: string;
}

/** Where the call came from (which tools exist there). */
export type GuidanceSurface = 'member' | 'room_only' | 'invite' | 'rest_guest';

/** The last-resort wait for a 429 whose source gave no time (limits carry their own window). */
export const DEFAULT_RETRY_AFTER_MS = 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Short lowercase slugs (each part at most 24 characters, so no secret fits). */
const SLUG = /^[a-z0-9]{1,24}(?:-[a-z0-9]{1,24}){0,7}$/;
/** Anything that looks like a credential, recovery code, key or token. */
const CREDENTIAL = /^(?:crc|crk|cct|ccs|cck|sk|pk|key|tok)_|[A-Za-z0-9_-]{32,}/i;

/** An id the caller sent, echoed only when it is a UUID, a short slug or a task number. */
export function ref(value: unknown): string | number | undefined {
  if (typeof value === 'number')
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return undefined;
  if (UUID.test(value)) return value;
  if (CREDENTIAL.test(value)) return undefined;
  return SLUG.test(value) ? value : undefined;
}

const NO_ACCESS_MEMBER =
  "You need the room's join link: call city_join_room with link, agent_id and idempotency_key (or city_join_invite with the link if you have no account).";
const NO_ACCESS_INVITE =
  'Join with the invite link the host gave you (or a rejoin link with your recovery_code), then use the room_credential it returns.';
const NO_ACCESS_CREDENTIAL =
  'Your room credential works only for its own room and member: leave out room_id and agent_id, or ask the host for a new invite link.';
const NO_ACCESS_REST =
  'Join with the invite link the host gave you (POST /api/public/invites/redeem), then send the room_credential it returns as the bearer.';
const RENEW_INVITE =
  'Renew with city_room_renew (or POST /api/public/invites/renew), or ask the host for a rejoin link and use your recovery code.';
const RENEW_ELSEWHERE =
  'Renew with POST /api/public/invites/renew (or city_room_renew on /mcp/open), or ask the host for a rejoin link and use your recovery code.';

export function errorGuidance(input: {
  code: string;
  status: number;
  /** The tool's arguments as sent (only room_id and task_id are read). */
  args: unknown;
  surface: GuidanceSurface;
  /** Whether the caller has this tool on its surface (default: every tool may be named). */
  has?: (tool: string) => boolean;
  details?: unknown;
  message?: string;
}): ErrorGuidance {
  const has = input.has ?? (() => true);
  const guest = input.surface !== 'member';
  const args = (input.args && typeof input.args === 'object' ? input.args : {}) as Record<
    string,
    unknown
  >;
  // A guest's credential fixes its room: never echo a room id back to it.
  const roomId = guest ? undefined : ref(args.room_id);
  const room = roomId !== undefined ? { room_id: roomId } : undefined;
  /** next only for a tool the caller has. */
  const next = (tool: string, nextArgs?: Record<string, unknown>) =>
    has(tool) ? { next: { tool, ...(nextArgs ? { args: nextArgs } : {}) } } : {};
  switch (input.code) {
    case 'not_a_member':
    case 'room_not_found':
      // The same answer for both codes (whether a room exists is never told).
      switch (input.surface) {
        case 'member':
          return { ...next('city_join_room'), hint: NO_ACCESS_MEMBER };
        case 'invite':
          return { ...next('city_join_invite'), hint: NO_ACCESS_INVITE };
        case 'room_only':
          return { hint: NO_ACCESS_CREDENTIAL };
        default:
          return { hint: NO_ACCESS_REST };
      }
    case 'room_credential_expired':
      // Past its expiry a renew is refused too: only the host's rejoin link keeps the member.
      if (!guest) return {};
      return {
        ...next('city_join_invite'),
        hint: 'Renewing no longer works. Ask the host for a rejoin link for your member and pass it with your recovery_code to city_join_invite (the original invite link would make a new member).',
      };
    case 'room_credential_invalid':
    case 'room_credential_denied':
      if (!guest) return {};
      // The previous credential of a renew (links/invites.ts credentialRenewed, server text):
      // another renew is not the way, the new credential is.
      if (input.message?.startsWith(CREDENTIAL_RENEWED_MESSAGE))
        return {
          hint: 'You already renewed: use the room_credential that city_room_renew returned. The old one only reads, for 10 minutes after the renew.',
        };
      return input.surface === 'invite'
        ? { ...next('city_room_renew'), hint: RENEW_INVITE }
        : { hint: RENEW_ELSEWHERE };
    case 'agent_not_found':
      return guest
        ? { hint: 'Your room credential fixes your agent: leave out agent_id.' }
        : {
            ...next('city_workspace'),
            hint: 'city_workspace lists your agents and their ids; pass one of those agent_id values.',
          };
    case 'read_only':
      return {
        hint: has('city_room_approval_request')
          ? 'Your role here is read-only. Ask the host in the room to let you take part, or ask for an approval with city_room_approval_request if you are a member.'
          : 'Your role here is read-only. Ask the host to let you take part.',
      };
    case 'task_claimed':
      return {
        ...next('city_room_task_list', { ...(room ?? {}), status: 'open' }),
        hint: 'Another member holds this task until details.expires_at (details.claimed_by). Pick an open task instead.',
      };
    case 'claim_stale': {
      const taskId = ref(args.task_id);
      const nextArgs = { ...(room ?? {}), ...(taskId !== undefined ? { task_id: taskId } : {}) };
      return {
        ...next('city_room_task_get', Object.keys(nextArgs).length ? nextArgs : undefined),
        hint: 'Your claim token no longer holds: read the task to see who holds it now, and claim again only if it is open.',
      };
    }
    case 'unknown_cursor':
    case 'invalid_cursor':
      return { hint: 'Call again without cursor to start from the first page.' };
    case 'room_full':
      // Never the member cap (a host's plan is not told to others).
      return { hint: 'Ask the host to free a seat.' };
    case 'file_refused':
      if (!/larger than|too large|size/i.test(input.message ?? '')) return {};
      return has('city_room_link_save')
        ? { hint: 'For a file over the size limit, share a link instead with city_room_link_save.' }
        : { hint: 'The file is over the size limit: share a link to it in a message instead.' };
    case 'agent_paused':
      return { hint: 'Your owner resumes it in the console; nothing to retry.' };
    default:
      return {};
  }
}
