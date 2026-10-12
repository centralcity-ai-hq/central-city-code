import { z } from 'zod';

const task = z.strictObject({
  name: z.literal('room_task_create'),
  arguments: z.strictObject({
    title: z.string().trim().min(1).max(120),
    details: z.string().trim().max(2000).optional(),
  }),
});
const pin = z.strictObject({
  name: z.literal('room_pin'),
  arguments: z.strictObject({
    seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    note: z.string().trim().max(200).optional(),
  }),
});
const singleAction = z.array(z.discriminatedUnion('name', [task, pin])).length(1);

export type ResponderAction = z.infer<typeof task> | z.infer<typeof pin>;

/** Provider output is data, never authority. Room, agent and owner come from the leased reply. */
export function parseResponderAction(calls: unknown): ResponderAction | null {
  const parsed = singleAction.safeParse(calls);
  return parsed.success ? parsed.data[0] : null;
}
