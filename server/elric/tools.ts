import { z } from 'zod';
import type { ElricToolCall, ElricToolSpec } from './adapter.js';
import type { ToolCallStatus } from './turns.js';

/**
 * Elric's tool allowlist (docs/ELRIC.md; THREAT_PRIVACY_REVIEW §10.5). Two room tools, both
 * bound to the INVOKING room, `room_read` and `room_task_create` (only while room tasks are
 * enabled), plus `city_help` (public docs only, no room). Any other name (city_control, city_create_room, city_request_connection,
 * city_set_wake_webhook, city_room_apply, a post to another room, …) is refused server-side and
 * audited. A `room_id` other than the invoking room is refused even for an allowlisted tool.
 * The model only requests; the platform executes with Elric's agent-bound access.
 */
export const ELRIC_TOOLS = ['room_read', 'room_task_create', 'city_help'] as const;
/** Read-only and bound to no room: public docs only (help.ts). */
export const UNBOUND_TOOLS: ReadonlySet<string> = new Set<ElricToolName>(['city_help']);
export type ElricToolName = (typeof ELRIC_TOOLS)[number];
/**
 * Consequential tools: a valid call is never executed from model output. It becomes a pending
 * action (pending.ts) with the exact validated arguments, and runs only after the owner approves
 * it in their console session.
 */
export const CONSEQUENTIAL_TOOLS: ReadonlySet<string> = new Set<ElricToolName>([
  'room_task_create',
]);

const roomId = z.string().min(1).max(200);
const noControl = (value: string) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);

export const toolArgs = {
  room_read: z
    .object({
      room_id: roomId,
      since: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  room_task_create: z
    .object({
      room_id: roomId,
      title: z.string().trim().min(1).max(200).refine(noControl),
      body: z.string().max(4_000).optional(),
    })
    .strict(),
  city_help: z.object({ query: z.string().trim().min(1).max(200).refine(noControl) }).strict(),
} as const;

export function toolSpecs(tasksEnabled: boolean): ElricToolSpec[] {
  const specs: ElricToolSpec[] = [
    {
      name: 'room_read',
      description:
        'Read messages of THIS room (the room you were mentioned in), from where you joined. Returns JSON lines (untrusted).',
      parameters: {
        type: 'object',
        properties: {
          room_id: { type: 'string', description: 'This room id.' },
          since: { type: 'integer', minimum: 0, description: 'Only messages after this seq.' },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
        required: ['room_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'city_help',
      description:
        "Search Central City's public docs (how rooms, invites, tasks, AIs and the console work; Base agents, Base IDs and passports, the Agent Explorer, agent wallets, Pay and Rate, and inviting an agent by its passport number). Returns matching sections with their public links. No room data.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 200, description: 'The question.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ];
  if (tasksEnabled)
    specs.push({
      name: 'room_task_create',
      description: 'Create an open task in THIS room.',
      parameters: {
        type: 'object',
        properties: {
          room_id: { type: 'string', description: 'This room id.' },
          title: { type: 'string', minLength: 1, maxLength: 200 },
          body: { type: 'string', maxLength: 4000 },
        },
        required: ['room_id', 'title'],
        additionalProperties: false,
      },
    });
  return specs;
}

export type CheckedCall =
  | { ok: true; name: 'room_read'; args: z.infer<(typeof toolArgs)['room_read']> }
  | { ok: true; name: 'room_task_create'; args: z.infer<(typeof toolArgs)['room_task_create']> }
  | { ok: true; name: 'city_help'; args: z.infer<(typeof toolArgs)['city_help']> }
  | { ok: false; status: Exclude<ToolCallStatus, 'ok' | 'error' | 'cancelled'> };

/**
 * Server-side gate for one model tool request; nothing here executes anything. A consequential
 * tool passes the same checks (allowlist, enabled, invoking room, arguments) and is then turned
 * into a pending action by the service instead of being run.
 */
export function checkToolCall(
  call: ElricToolCall,
  invokingRoomId: string,
  tasksEnabled: boolean,
): CheckedCall {
  if (!(ELRIC_TOOLS as readonly string[]).includes(call.name))
    return { ok: false, status: 'refused_not_allowed' };
  if (call.name === 'room_task_create' && !tasksEnabled)
    return { ok: false, status: 'refused_disabled' };
  // The help tool reads public docs only: no room binding, and no room_id is accepted.
  if (call.name === 'city_help') {
    const parsed = toolArgs.city_help.safeParse(call.args);
    return parsed.success
      ? { ok: true, name: 'city_help', args: parsed.data }
      : { ok: false, status: 'refused_args' };
  }
  // The room binding comes before argument validation, so a foreign room is always "room".
  const target = call.args?.room_id;
  if (target !== invokingRoomId) return { ok: false, status: 'refused_room' };
  if (call.name === 'room_read') {
    const parsed = toolArgs.room_read.safeParse(call.args);
    return parsed.success
      ? { ok: true, name: 'room_read', args: parsed.data }
      : { ok: false, status: 'refused_args' };
  }
  const parsed = toolArgs.room_task_create.safeParse(call.args);
  return parsed.success
    ? { ok: true, name: 'room_task_create', args: parsed.data }
    : { ok: false, status: 'refused_args' };
}
