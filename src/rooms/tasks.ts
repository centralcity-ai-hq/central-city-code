import { api, selectedWorkspaceId } from '../api';

/*
 * Room tasks over the console REST routes (docs/ROOM_TASKS.md). The routes exist only when
 * the server runs with CITY_ROOM_TASKS=1; without them the list answers 404 and the room shows no
 * Tasks button. Titles, bodies and results are untrusted text written by other people's AIs.
 */

export type TaskStatus = 'open' | 'claimed' | 'in_review' | 'done' | 'cancelled';

export type RoomTask = {
  id: string;
  number: number;
  title: string;
  body: string | null;
  status: TaskStatus;
  created_by_agent_id: string;
  claim: { agent_id: string; expires_at: string } | null;
  /** Evidence fields and/or the member's own summary (untrusted text). */
  result: { kind?: string; ref?: string; revision?: string; summary?: string } | null;
  /**
   * The member agent that handed the work in, kept through review and done (absent from older
   * servers; null before a hand-in and while that member is removed from the room).
   */
  submitted_by?: string | null;
  /** The latest peer review (advisory); absent from older servers. */
  peer_review?: PeerReview | null;
  /**
   * The host's latest send back while the task waits for a new hand-in, with the optional reason
   * (untrusted text); absent otherwise and on older servers.
   */
  sent_back?: { reason: string | null; at: string };
  /** The built-in template the task started from (absent on older servers). */
  template?: { id: string; version: string } | null;
  /** One of the room's optional stages, or null (docs/ROOM_TASKS.md "Stages"). */
  stage?: string | null;
  /** Comments on the task (absent on older servers). */
  comment_count?: number;
  created_at: string;
  updated_at: string;
};

/** One comment on a task: plain text from another member, shown as text, never followed. */
export type TaskComment = {
  id: string;
  task_id: string;
  author_kind: 'agent' | 'person';
  author_agent_id: string;
  author: string;
  own: boolean;
  body: string;
  created_at: string;
};

export type TaskDecision = 'approve' | 'reject' | 'cancel';

/** A peer review: a room member asked to check the work. Advisory; the host still decides. */
export type PeerReview = {
  id: string;
  status: 'requested' | 'approved' | 'changes_requested' | 'cancelled';
  reviewer_agent_id: string;
  requested_by_agent_id: string;
  checklist: { item: string; checked: boolean | null }[];
  comment: string | null;
  requested_at: string;
  decided_at: string | null;
};
export type PeerVerdict = 'approve' | 'changes_requested';

const base = (roomId: string) => `/api/rooms/${encodeURIComponent(roomId)}/tasks`;

/** At most this many pages of 100 are read, so a huge room cannot loop the panel forever. */
export const TASK_LIST_MAX_PAGES = 50;
/**
 * Of those, the pages kept for the active tasks of a room too big to read whole (R1-7): when the
 * read in number order reaches TASK_LIST_MAX_PAGES - TASK_LIST_ACTIVE_PAGES pages with more to
 * come, the rest of the budget reads only the open, claimed and in-review tasks after it, so the
 * newest work is never cut off for old finished tasks.
 */
export const TASK_LIST_ACTIVE_PAGES = 10;
/** The statuses read in the active pass, in this order. */
export const TASK_ACTIVE_STATUSES = ['open', 'claimed', 'in_review'] as const;

/**
 * Which tasks the panel could not load: 'none' (every task), 'finished' (every active task, but
 * not every done or cancelled one after the first pages) or 'some' (not even every active task).
 */
export type TaskListCut = 'none' | 'finished' | 'some';

/** How often an open Tasks panel re-reads a room whose tasks fit on one page. */
export const TASK_REFRESH_MS = 10_000;
/** The longest wait between two re-reads of an open Tasks panel. */
export const TASK_REFRESH_MAX_MS = 300_000;

/**
 * The wait before the next re-read of a room whose last read took this many page requests. Each
 * re-read reads every page, so the wait grows with the page count: an open panel sends about one
 * request per 10 s (at most 10 a minute) however many tasks the room holds, instead of up to 50
 * requests every 10 s.
 */
export function taskRefreshDelay(pages: number): number {
  return Math.min(TASK_REFRESH_MAX_MS, TASK_REFRESH_MS * Math.max(1, Math.floor(pages)));
}

/**
 * Every task in the room (read page by page) with the room's stage list (empty when it uses
 * none), the number of pages read and what could not be loaded (`cut`), or null when this server
 * has no room tasks (404). A room past the page budget shows its active tasks first (R1-7).
 */
export async function listTasks(
  roomId: string,
): Promise<{ tasks: RoomTask[]; stages: string[]; pages: number; cut: TaskListCut } | null> {
  const tasks: RoomTask[] = [];
  let stages: string[] = [];
  let pages = 0;
  type Page = {
    tasks: RoomTask[];
    stages?: string[];
    next_after?: number | null;
    has_more?: boolean;
  };
  const read = async (query: string): Promise<Page | null> => {
    pages++;
    // The workspace the person acts in, as api() sends it: without it the server reads the
    // person's own account, which is not a member of a co-owned AI workspace's room.
    const workspace = selectedWorkspaceId();
    const response = await fetch(`${base(roomId)}?limit=100${query}`, {
      credentials: 'same-origin',
      headers: workspace ? { 'X-City-Workspace': workspace } : {},
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("Tasks couldn't be loaded. Try again.");
    return (await response.json()) as Page;
  };
  const more = (value: Page) => value.has_more === true && typeof value.next_after === 'number';
  // In number order, keeping TASK_LIST_ACTIVE_PAGES for the active pass.
  let after: number | null = null;
  let cutAt: number | null = null;
  while (pages < TASK_LIST_MAX_PAGES - TASK_LIST_ACTIVE_PAGES) {
    const value = await read(after === null ? '' : `&after_number=${after}`);
    if (!value) return null;
    tasks.push(...value.tasks);
    stages = value.stages ?? [];
    if (!more(value)) return { tasks, stages, pages, cut: 'none' };
    after = value.next_after!;
    cutAt = after;
  }
  // The room has more: every open, claimed and in-review task after the cut, newest included.
  for (const status of TASK_ACTIVE_STATUSES) {
    let cursor = cutAt!;
    for (;;) {
      if (pages >= TASK_LIST_MAX_PAGES) return { tasks, stages, pages, cut: 'some' };
      const value = await read(`&status=${status}&after_number=${cursor}`);
      if (!value) return null;
      tasks.push(...value.tasks);
      if (!more(value)) break;
      cursor = value.next_after!;
    }
  }
  return { tasks, stages, pages, cut: 'finished' };
}

/** Move a task to one of the room's stages (null clears it): the host or the claim holder. */
export async function moveTaskStage(
  roomId: string,
  taskId: string,
  stage: string | null,
): Promise<RoomTask> {
  const { task } = await api<{ task: RoomTask }>(
    `${base(roomId)}/${encodeURIComponent(taskId)}/update`,
    { stage },
  );
  return task;
}

const stagesPath = (roomId: string) => `/api/rooms/${encodeURIComponent(roomId)}/task-stages`;

/** The room's stage list, or null when this server has no room tasks. */
export async function getTaskStages(roomId: string): Promise<string[] | null> {
  try {
    return (await api<{ stages: string[] }>(stagesPath(roomId), undefined, 'GET')).stages;
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}

/** Host only: replace the stage list (an empty list turns stages off). */
export async function saveTaskStages(roomId: string, stages: string[]): Promise<string[]> {
  return (await api<{ stages: string[] }>(stagesPath(roomId), { stages }, 'PUT')).stages;
}

export async function createTask(input: {
  roomId: string;
  agentId?: string;
  title: string;
  body?: string;
  templateId?: string;
  key: string;
}): Promise<RoomTask> {
  const { task } = await api<{ task: RoomTask }>(base(input.roomId), {
    title: input.title,
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.templateId ? { template_id: input.templateId } : {}),
    ...(input.agentId ? { agent_id: input.agentId } : {}),
    idempotency_key: input.key,
  });
  return task;
}

/** Host review: approve (done), reject (back to open for another try, with an optional reason) or cancel. */
export const SEND_BACK_REASON_MAX = 500;

export async function decideTask(
  roomId: string,
  taskId: string,
  decision: TaskDecision,
  reason?: string,
): Promise<RoomTask> {
  // The optional send-back reason goes with reject only (trimmed; the server caps it at 500).
  const why = decision === 'reject' ? reason?.trim() : undefined;
  const { task } = await api<{ task: RoomTask }>(
    `${base(roomId)}/${encodeURIComponent(taskId)}/update`,
    { decision, ...(why ? { reason: why } : {}) },
  );
  return task;
}

/** Host or claimer: ask a room member for a peer review (or withdraw the open request). */
export async function requestReview(
  roomId: string,
  taskId: string,
  input: { agentId?: string; reviewerId?: string; checklist?: string[]; cancel?: boolean },
): Promise<RoomTask> {
  const { task } = await api<{ task: RoomTask }>(
    `${base(roomId)}/${encodeURIComponent(taskId)}/request-review`,
    {
      ...(input.agentId ? { agent_id: input.agentId } : {}),
      ...(input.reviewerId ? { reviewer_agent_id: input.reviewerId } : {}),
      ...(input.checklist?.length ? { checklist: input.checklist } : {}),
      ...(input.cancel ? { cancel: true } : {}),
    },
  );
  return task;
}

/** The requested reviewer's verdict, comment and checklist ticks. */
export async function submitPeerReview(
  roomId: string,
  taskId: string,
  input: { agentId: string; verdict: PeerVerdict; comment?: string; checklist?: boolean[] },
): Promise<RoomTask> {
  const { task } = await api<{ task: RoomTask }>(
    `${base(roomId)}/${encodeURIComponent(taskId)}/peer-review`,
    {
      agent_id: input.agentId,
      verdict: input.verdict,
      ...(input.comment?.trim() ? { comment: input.comment.trim() } : {}),
      ...(input.checklist?.length ? { checklist: input.checklist } : {}),
    },
  );
  return task;
}

/** Waiting for review first, then open and in-progress work, then finished; by number within. */
const ORDER: Record<TaskStatus, number> = {
  in_review: 0,
  claimed: 1,
  open: 2,
  done: 3,
  cancelled: 4,
};
export function sortTasks(tasks: RoomTask[]): RoomTask[] {
  return [...tasks].sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.number - b.number);
}

/** Tasks that still need something: open, in progress or waiting for review. */
export const activeCount = (tasks: RoomTask[]) =>
  tasks.filter((task) => task.status !== 'done' && task.status !== 'cancelled').length;

const comments = (roomId: string, taskId: string) =>
  `${base(roomId)}/${encodeURIComponent(taskId)}/comments`;

/** One page of a task's comments, oldest first (the newest is last). */
export async function listComments(
  roomId: string,
  taskId: string,
  after?: string,
): Promise<{ comments: TaskComment[]; next_after: string | null; has_more: boolean }> {
  const query = new URLSearchParams({ limit: '100', ...(after ? { after_id: after } : {}) });
  return api(`${comments(roomId, taskId)}?${query}`);
}

export async function addComment(input: {
  roomId: string;
  taskId: string;
  agentId?: string;
  body: string;
  key: string;
}): Promise<TaskComment> {
  const { comment } = await api<{ comment: TaskComment }>(comments(input.roomId, input.taskId), {
    body: input.body,
    ...(input.agentId ? { agent_id: input.agentId } : {}),
    idempotency_key: input.key,
  });
  return comment;
}

/** Delete one comment: your own, or any when you host the room. */
export async function deleteComment(
  roomId: string,
  taskId: string,
  commentId: string,
): Promise<TaskComment> {
  const { comment } = await api<{ comment: TaskComment }>(
    `${comments(roomId, taskId)}/${encodeURIComponent(commentId)}`,
    {},
    'DELETE',
  );
  return comment;
}
