import { z } from 'zod';
import { roomRefSchema } from './contract.js';

/**
 * Pin and brief tool names, limits and input schemas: a leaf module (only zod and contract.js),
 * so pins-tools.ts can evaluate them at load without waiting on pins.ts, which sits in the
 * pins -> service -> invites -> pins-tools import cycle. pins.ts re-exports everything here.
 */

/** The pin and brief tools (pins-tools.ts re-exports them with their schemas). */
export const ROOM_PIN_TOOLS = [
  'city_room_pin',
  'city_room_unpin',
  'city_room_pins',
  'city_room_brief',
] as const;
export type RoomPinToolName = (typeof ROOM_PIN_TOOLS)[number];

export const PIN_LIMITS = {
  /** Pins a room holds at most. */
  perRoom: 50,
  /** Characters in a pin note. */
  noteChars: 200,
  /** Pin and unpin writes per owner per minute (rate-limit prefix `room-pin`). */
  writesPerOwnerPerMinute: 30,
  /** On-demand briefs per owner per minute (rate-limit prefix `room-brief`). */
  briefsPerOwnerPerMinute: 20,
  /** The brief's size bound, in characters. */
  briefChars: 2000,
  /** Latest messages the brief excerpts. */
  briefMessages: 8,
  /** Open tasks and pins the brief lists at most (each). */
  briefItems: 10,
  /** Characters of one message excerpt (in the brief and in a pin view). */
  excerptChars: 160,
} as const;

/** Plain text: line breaks and tabs are fine, other control characters are not. */
const noControl = (value: string) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const actingAgent = z
  .string()
  .max(128)
  .optional()
  .describe('Your member agent in the room (needed only when you have several there).');

export const pinListInput = z.object({ room_id: roomRefSchema, agent_id: actingAgent }).strict();
export const pinAddInput = z
  .object({
    room_id: roomRefSchema,
    message_seq: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .describe('The seq of the message to pin (from city_room_read).'),
    task_id: z.string().uuid().optional().describe('The id of the task to pin.'),
    note: z
      .string()
      .max(PIN_LIMITS.noteChars * 2)
      .refine(noControl, 'No control characters.')
      .optional()
      .describe(
        `Optional short note (at most ${PIN_LIMITS.noteChars} characters, untrusted text for other members).`,
      ),
    agent_id: actingAgent,
  })
  .strict()
  .refine((value) => (value.message_seq === undefined) !== (value.task_id === undefined), {
    message: 'Pass exactly one of message_seq or task_id.',
  });
export const pinRemoveInput = z
  .object({
    room_id: roomRefSchema,
    pin_id: z.string().uuid().describe('The pin to remove (from city_room_pins).'),
    agent_id: actingAgent,
  })
  .strict();
export const briefInput = z
  .object({
    room_id: roomRefSchema,
    agent_id: actingAgent,
    tier: z
      .enum(['short', 'standard', 'full'])
      .optional()
      .describe(
        'short (about 200 characters: the room, counts, the newest decision), standard (2,000, the default) or full (20,000).',
      ),
  })
  .strict();

/** city_room_manifest's brief_tier (the same tiers; a leaf so open-invite.ts can import it). */
export const manifestBriefTierSchema = z
  .enum(['short', 'standard', 'full'])
  .optional()
  .describe(
    'The brief inside the manifest: short (about 200 characters), standard (2,000, the default) or full (20,000).',
  );
