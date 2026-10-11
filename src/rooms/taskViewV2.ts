import type { RoomTask } from './tasks';

/*
 * Smart Rooms v2 (preview) Tasks sheet: the filter row and the ONE status each card shows.
 * Pure functions over the real task model (src/rooms/tasks.ts), so they are unit-tested on their
 * own (tests/rooms-v2-tasks.test.ts).
 */

export type TaskFilter = 'all' | 'open' | 'claimed' | 'in_review' | 'done';

export const TASK_FILTERS: { id: TaskFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'open', label: 'Open' },
  { id: 'claimed', label: 'Claimed' },
  { id: 'in_review', label: 'In review' },
  { id: 'done', label: 'Done' },
];

/** How many tasks each chip shows. "All" counts every task, cancelled ones included. */
export function countTasks(tasks: readonly RoomTask[]): Record<TaskFilter, number> {
  const counts: Record<TaskFilter, number> = {
    all: tasks.length,
    open: 0,
    claimed: 0,
    in_review: 0,
    done: 0,
  };
  for (const task of tasks) {
    if (task.status !== 'cancelled') counts[task.status] += 1;
  }
  return counts;
}

/** The tasks one chip shows, in the order given. */
export function filterTasks<T extends Pick<RoomTask, 'status'>>(
  tasks: readonly T[],
  filter: TaskFilter,
): T[] {
  return filter === 'all' ? [...tasks] : tasks.filter((task) => task.status === filter);
}

/**
 * The pill's tone: neutral grey (open, cancelled), blue (claimed), stronger blue (in review),
 * green only for done. No orange anywhere.
 */
export type TaskPillTone = 'neutral' | 'accent' | 'strong' | 'done' | 'muted';

/** What the peer review adds to the stage, or null when it adds nothing. */
function reviewNote(task: RoomTask): string | null {
  switch (task.peer_review?.status) {
    case 'requested':
      return 'review asked';
    case 'changes_requested':
      return 'changes asked';
    case 'approved':
      return 'peer approved';
    default:
      return null;
  }
}

/**
 * The single status a card shows. The stage comes first; the peer review is folded in after a
 * dot, so a card never carries two status labels. "Needs review" and "In review" are one label
 * ("In review"); "Accepted" and "Approved" are one label ("Done").
 */
export function taskPill(task: RoomTask): { label: string; tone: TaskPillTone } {
  switch (task.status) {
    case 'open':
      return { label: 'Open', tone: 'neutral' };
    case 'claimed': {
      const note = reviewNote(task);
      return { label: note ? `Claimed · ${note}` : 'Claimed', tone: 'accent' };
    }
    case 'in_review': {
      const note = reviewNote(task);
      return { label: note ? `In review · ${note}` : 'In review', tone: 'strong' };
    }
    case 'done':
      return { label: 'Done', tone: 'done' };
    default:
      return { label: 'Cancelled', tone: 'muted' };
  }
}

/**
 * Whose name a card shows: the claim holder while a claim lasts; once the work is handed in (in
 * review or done), the member who handed it in, as "by <name>". Null when there is nobody to name
 * (open, cancelled, or a server without `submitted_by`, which also hides removed members).
 */
export function taskPerson(task: RoomTask): { agentId: string; handedIn: boolean } | null {
  if (task.claim) return { agentId: task.claim.agent_id, handedIn: false };
  if ((task.status === 'in_review' || task.status === 'done') && task.submitted_by)
    return { agentId: task.submitted_by, handedIn: true };
  return null;
}

/*
 * Workspace v3 task cards (docs/design/WORKSPACE_V3.md §4.5): the stage pills (the status flow,
 * the current one highlighted) and the progress bar, both from the task's real status.
 */

/** The steps a task moves through, in order (a cancelled task leaves the flow). */
export const STAGE_FLOW: { status: Exclude<RoomTask['status'], 'cancelled'>; label: string }[] = [
  { status: 'open', label: 'Open' },
  { status: 'claimed', label: 'Claimed' },
  { status: 'in_review', label: 'In review' },
  { status: 'done', label: 'Done' },
];

/**
 * How far along the flow a task is, 0 to 1: open 0, claimed 1/3, in review 2/3, done 1. A
 * cancelled task shows no progress.
 */
export function taskProgress(task: Pick<RoomTask, 'status'>): number {
  const index = STAGE_FLOW.findIndex((step) => step.status === task.status);
  return index < 0 ? 0 : index / (STAGE_FLOW.length - 1);
}

/**
 * Whether the viewer may ask for a peer review of this task: the task is claimed or handed in,
 * the room is open, the viewer hosts or holds the claim, and no review is waiting already.
 * The same rule as the task detail's "Ask for review".
 */
export function canAskReview(
  task: Pick<RoomTask, 'status' | 'claim' | 'peer_review'>,
  viewer: { host: boolean; closed: boolean; own: ReadonlySet<string> },
): boolean {
  const live = task.status !== 'done' && task.status !== 'cancelled' && !viewer.closed;
  const started = task.status === 'claimed' || task.status === 'in_review';
  const claimer = !!task.claim && viewer.own.has(task.claim.agent_id);
  return live && started && (viewer.host || claimer) && task.peer_review?.status !== 'requested';
}
