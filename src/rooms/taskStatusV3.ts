import type { RoomMessage } from './api';
import type { RoomTask } from './tasks';

/*
 * Workspace v3 status pills (docs/design/WORKSPACE_V3.md §1.4, §4.2): a task's state shows under
 * the thread line that created or claimed it. Pure functions, unit tested
 * (tests/rooms-v3-room.test.ts). The lines are the server's system lines
 * (server/rooms/tasks-service.ts), the state is the room's task list: nothing is guessed.
 */

/** The verbs of the server's task system lines that place a status pill. */
const ANCHOR_VERBS: ReadonlyArray<RegExp> = [/ created task #(\d+): /, / claimed task #(\d+): /];
/** Any task system line (to refresh the task list when one arrives). */
const TASK_LINE = / task #\d+: |^The host (?:accepted|sent back|cancelled) task #\d+: /;

const isSystem = (message: RoomMessage) =>
  (message as { sender_kind?: string }).sender_kind === 'system';
const textOf = (message: RoomMessage) =>
  message.text || message.parts?.map((part) => (part.type === 'text' ? part.text : '')).join('');

/** The task number a "created task #n" or "claimed task #n" line reports, or null. */
export function anchorTaskNumber(text: string): number | null {
  let best: { number: number; at: number } | null = null;
  for (const pattern of ANCHOR_VERBS) {
    const match = pattern.exec(text);
    // The earliest verb wins: the member's name comes first, the task title after it.
    if (match && (best === null || match.index < best.at))
      best = { number: Number(match[1]), at: match.index };
  }
  return best && Number.isSafeInteger(best.number) && best.number > 0 ? best.number : null;
}

/** Whether a message is a server task line (any task change). */
export function isTaskLine(message: RoomMessage): boolean {
  return isSystem(message) && TASK_LINE.test(textOf(message) ?? '');
}

/**
 * Where each task's pill goes: the id of the newest created/claimed line per task number among
 * the loaded messages (one pill per task), mapped to that number.
 */
export function pillAnchors(messages: readonly RoomMessage[]): Map<string, number> {
  const latest = new Map<number, string>();
  for (const message of messages) {
    if (!isSystem(message)) continue;
    const number = anchorTaskNumber(textOf(message) ?? '');
    if (number !== null) latest.set(number, message.id);
  }
  return new Map([...latest].map(([number, id]) => [id, number]));
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a task line was written about this sender: the exact server form
 * "<name> created task #n: " or "<name> claimed task #n: " for that number. A name that only
 * starts the same ("Nova" for "Nova Bot created task #3: …") does not match.
 */
export function lineIsBy(text: string, sender: string, number: number): boolean {
  if (!sender) return false;
  return new RegExp(`^${escapeRegExp(sender)} (?:created|claimed) task #${number}: `).test(text);
}

/**
 * Where the status pills go: under a message (by id) or after a line (by id), with the task
 * number. `folded` maps the lines whose pill went under the message just before them (line id →
 * task number): the pill already says it there, so the list can fold the line away.
 */
export type PillPlacement = {
  on: Map<string, number>;
  after: Map<string, number>;
  folded: Map<string, number>;
};

/**
 * One pass over the loaded messages (memoised by the list on `messages`): each task's newest
 * created/claimed line places its pill. When the message right before that line was posted by
 * the member the line names (exact name, see lineIsBy) within `windowMs`, the pill goes under
 * that message, where the work was asked for; otherwise under the line itself.
 */
export function pillPlacement(messages: readonly RoomMessage[], windowMs: number): PillPlacement {
  const latest = new Map<number, number>();
  messages.forEach((message, index) => {
    if (!isSystem(message)) return;
    const number = anchorTaskNumber(textOf(message) ?? '');
    if (number !== null) latest.set(number, index);
  });
  const on = new Map<string, number>();
  const after = new Map<string, number>();
  const folded = new Map<string, number>();
  for (const [number, index] of latest) {
    const line = messages[index]!;
    const before = messages[index - 1];
    if (
      before &&
      !isSystem(before) &&
      !on.has(before.id) &&
      lineIsBy(textOf(line) ?? '', before.sender, number) &&
      Date.parse(line.created_at) - Date.parse(before.created_at) <= windowMs
    ) {
      on.set(before.id, number);
      folded.set(line.id, number);
    } else after.set(line.id, number);
  }
  return { on, after, folded };
}

export type PillTone = 'warn' | 'accent' | 'ok' | 'idle';

/** "Task · open", "Claimed · In progress" (or the task's stage), "In review", "✓ Done". */
export function taskPill(task: RoomTask): { label: string; tone: PillTone } {
  switch (task.status) {
    case 'open':
      return { label: 'Task · open', tone: 'warn' };
    case 'claimed':
      return { label: `Claimed · ${task.stage?.trim() || 'In progress'}`, tone: 'warn' };
    case 'in_review':
      return { label: 'In review', tone: 'accent' };
    case 'done':
      return { label: '✓ Done', tone: 'ok' };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'idle' };
  }
}
