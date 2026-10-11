import { api } from '../api';

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
  result: { kind: string; ref: string; revision: string } | null;
  /**
   * The member agent that handed the work in, kept through review and done (absent from older
   * servers; null before a hand-in and while that member is removed from the room).
   */
  submitted_by?: string | null;
  /** The latest peer review (advisory); absent from older servers. */
  peer_review?: PeerReview | null;
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

/**
 * Tasks in the room with the room's stage list (empty when it uses none), or null when this
 * server has no room tasks (404).
 */
export async function listTasks(
  roomId: string,
): Promise<{ tasks: RoomTask[]; stages: string[] } | null> {
  const response = await fetch(`${base(roomId)}?limit=100`, { credentials: 'same-origin' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Tasks couldn't be loaded. Try again.");
  const value = (await response.json()) as { tasks: RoomTask[]; stages?: string[] };
  return { tasks: value.tasks, stages: value.stages ?? [] };
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

/** Host review: approve (done), reject (back to open for another try) or cancel. */
export async function decideTask(
  roomId: string,
  taskId: string,
  decision: TaskDecision,
): Promise<RoomTask> {
  const { task } = await api<{ task: RoomTask }>(
    `${base(roomId)}/${encodeURIComponent(taskId)}/update`,
    { decision },
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
