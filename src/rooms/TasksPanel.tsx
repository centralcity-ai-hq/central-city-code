import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { ArrowLeft, MessageSquare, Plus, X } from 'lucide-react';
import { ApiError } from '../api';
import type { Member, Room } from './api';
import {
  createTask,
  decideTask,
  listTasks,
  requestReview,
  moveTaskStage,
  sortTasks,
  submitPeerReview,
  taskRefreshDelay,
  type PeerVerdict,
  type RoomTask,
  type TaskDecision,
  type TaskStatus,
} from './tasks';
import { requestKey } from './requestKey';
import { describe } from './useRoomThread';
import { AskReviewForm, PeerReviewForm, PeerReviewSummary } from './PeerReview';
import { TASK_TEMPLATES, findTaskTemplate } from '../../shared/task-templates';
import { StagePill } from './TaskStages';
import { MessageBoundary } from './markdown/Boundary';
import { withoutBidiControls } from './markdown/format';
import { useRoomsV2 } from './roomsV2';
import { canAskReview, countTasks, filterTasks, type TaskFilter } from './taskViewV2';
import { TaskCard, TaskClaimer, TaskFilterRow, TaskProgress, TaskStageFlow } from './TasksV2';
import { PanelHead } from './PanelV3';
import { pageVisible } from './readMark';

/*
 * The room's Tasks panel (docs/COPY_GLOSSARY.md wording): every task with its CURRENT state only.
 * Changes to a task appear as lines in the room thread, so the panel keeps no history.
 * Members (people and their AIs) add tasks; the host reviews what members hand in.
 * Titles, details and results are untrusted text from other people's AIs: shown, never followed.
 */

const LABEL: Record<TaskStatus, string> = {
  open: 'Open',
  claimed: 'In progress',
  in_review: 'Needs review',
  done: 'Accepted',
  cancelled: 'Cancelled',
};

/** How often the open panel refreshes the list (tasks change when members claim or hand in). */

// A task's comment thread loads on first open, so the room's first load stays the same size.
const TaskComments = lazy(() =>
  import('./TaskComments').then((module) => ({ default: module.TaskComments })),
);

// Task details are Markdown (templates write "## Problem" and lists), shown with the same safe
// renderer as room messages (no raw HTML, safe links); its chunk is shared with the message list.
const Markdown = lazy(() =>
  import('./markdown/Markdown').then((module) => ({ default: module.Markdown })),
);

/** A task's details as Markdown; plain text (shortened) until the renderer arrives or if it fails. */
function TaskBody({ body }: { body: string }) {
  const clean = withoutBidiControls(body);
  const plain = (
    <p className="rm-task-plain">{clean.length > 280 ? `${clean.slice(0, 279)}…` : clean}</p>
  );
  return (
    <div className="rm-task-body rm-task-md" data-testid="task-body">
      <MessageBoundary fallback={plain}>
        <Suspense fallback={plain}>
          <Markdown text={clean} />
        </Suspense>
      </MessageBoundary>
    </div>
  );
}

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : describe(err);
}

/**
 * "Start from": blank or one of the built-in templates (shared/task-templates.ts), as native
 * radios styled as chips, so arrow keys move between them and readers hear one choice. Names
 * only: a template labels the task and never fills the title or details.
 */
function TemplatePicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  return (
    <fieldset className="rm-task-templates">
      <legend>Start from</legend>
      <div className="rm-template-chips">
        {[{ id: '', name: 'Blank' }, ...TASK_TEMPLATES].map((item) => (
          <label key={item.id || 'blank'} className="rm-template-chip">
            <input
              type="radio"
              name="task-template"
              value={item.id}
              checked={value === item.id}
              onChange={() => onChange(item.id)}
            />
            <span>{item.name}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function until(at: string): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function TaskItem({
  task,
  roomId,
  host,
  closed,
  members,
  canComment,
  commentAs,
  nameOf,
  busy,
  onDecide,
  onAskReview,
  onWithdrawReview,
  onPeerReview,
  stages = [],
  mine = false,
  onStage,
  detail = false,
  startAsking = false,
}: {
  task: RoomTask;
  roomId: string;
  host: boolean;
  closed: boolean;
  members: Member[];
  /** Whether the viewer may write comments (an open room, not read-only). */
  canComment: boolean;
  /** The member to comment as (several own members in the room). */
  commentAs?: string;
  nameOf: (agentId: string) => string;
  busy: boolean;
  onDecide: (task: RoomTask, decision: TaskDecision) => void;
  onAskReview: (task: RoomTask, reviewerId: string, checklist: string[]) => Promise<boolean>;
  onWithdrawReview: (task: RoomTask) => void;
  onPeerReview: (
    task: RoomTask,
    agentId: string,
    verdict: PeerVerdict,
    comment: string,
    checklist: boolean[],
  ) => void;
  /** The room's optional stages (empty: no stage UI). */
  stages?: string[];
  /** True when one of the viewer's own agents holds the claim. */
  mine?: boolean;
  onStage?: (task: RoomTask, stage: string | null) => void;
  /** Rooms v2 detail view: the panel draws the head, and comments start open. */
  detail?: boolean;
  /** Open with the "Ask for a review" form showing (the card's Ask for a review). */
  startAsking?: boolean;
}) {
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [asking, setAsking] = useState(startAsking);
  const own = new Set(members.filter((member) => member.own).map((member) => member.id));
  const review = task.peer_review ?? null;
  const live = task.status !== 'done' && task.status !== 'cancelled' && !closed;
  const claimer = !!task.claim && own.has(task.claim.agent_id);
  // A review checks someone's work: offered once the task is claimed, not on an open task.
  const canAsk = canAskReview(task, { host, closed, own });
  const canWithdraw = live && (host || claimer) && review?.status === 'requested';
  const reviewing =
    live && review?.status === 'requested' && own.has(review.reviewer_agent_id) && !claimer;
  const [showComments, setShowComments] = useState(detail);
  const [commentCount, setCommentCount] = useState(task.comment_count ?? 0);
  useEffect(() => setCommentCount(task.comment_count ?? 0), [task.comment_count]);
  const onCount = useCallback((count: number) => setCommentCount(count), []);
  const threadId = useId();
  const status =
    task.status === 'open'
      ? 'Waiting for a member to take it.'
      : task.status === 'claimed' && task.claim
        ? `${nameOf(task.claim.agent_id)} is working on it, until about ${until(task.claim.expires_at)}.`
        : task.status === 'in_review'
          ? host
            ? 'Handed in. Accept it, or send it back for another try.'
            : 'Handed in. Waiting for the host’s review.'
          : task.status === 'done'
            ? 'The host accepted the result.'
            : 'The host cancelled this task.';
  const canCancel = host && !closed && task.status !== 'done' && task.status !== 'cancelled';
  const Root = detail ? 'div' : 'li';
  return (
    <Root className="rm-task" data-status={task.status}>
      {detail ? null : (
        <div className="rm-task-head">
          <strong className="rm-task-title">
            <span className="rm-task-number">T{task.number}</span> {task.title}
          </strong>
          <span className="rm-task-status" data-status={task.status}>
            <span className="rm-task-dot" aria-hidden="true" />
            {LABEL[task.status]}
          </span>
        </div>
      )}
      <StagePill
        taskNumber={task.number}
        stage={task.stage ?? null}
        stages={stages}
        canMove={!closed && !!onStage && (host || (mine && task.status === 'claimed'))}
        busy={busy}
        onMove={(stage) => onStage?.(task, stage)}
      />
      {task.body ? <TaskBody body={task.body} /> : null}
      <p className="rm-meta">{status}</p>
      {task.result && (task.status === 'in_review' || task.status === 'done') ? (
        <p className="rm-task-result">
          <span className="rm-meta">Result: </span>
          <span className="rm-task-ref">{task.result.ref}</span>
        </p>
      ) : null}
      {review ? <PeerReviewSummary review={review} nameOf={nameOf} /> : null}
      {reviewing && review ? (
        <PeerReviewForm
          review={review}
          busy={busy}
          onSubmit={(verdict, comment, ticks) =>
            onPeerReview(task, review.reviewer_agent_id, verdict, comment, ticks)
          }
        />
      ) : null}
      {asking ? (
        <AskReviewForm
          task={task}
          members={members}
          busy={busy}
          onClose={() => setAsking(false)}
          onAsk={(reviewerId, checklist) =>
            void onAskReview(task, reviewerId, checklist).then((done) => {
              if (done) setAsking(false);
            })
          }
        />
      ) : canAsk ? (
        <button type="button" className="rm-quiet rm-task-cancel" onClick={() => setAsking(true)}>
          Ask for review
        </button>
      ) : canWithdraw ? (
        <button
          type="button"
          className="rm-quiet rm-task-cancel"
          disabled={busy}
          onClick={() => onWithdrawReview(task)}
        >
          Withdraw review request
        </button>
      ) : null}
      {host && !closed && task.status === 'in_review' ? (
        <div className="rm-task-actions">
          <button
            type="button"
            className="rm-primary"
            disabled={busy}
            onClick={() => onDecide(task, 'approve')}
          >
            Accept
          </button>
          <button
            type="button"
            className="rm-quiet"
            disabled={busy}
            onClick={() => onDecide(task, 'reject')}
          >
            Send back
          </button>
        </div>
      ) : null}
      {canCancel ? (
        confirmCancel ? (
          <div className="rm-confirm">
            <span>Cancel {`T${task.number}`}? Members can no longer work on it.</span>
            <button
              type="button"
              className="rm-danger"
              disabled={busy}
              onClick={() => onDecide(task, 'cancel')}
            >
              Cancel task
            </button>
            <button type="button" className="rm-quiet" onClick={() => setConfirmCancel(false)}>
              Keep it
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="rm-quiet rm-task-cancel"
            onClick={() => setConfirmCancel(true)}
          >
            Cancel task
          </button>
        )
      ) : null}
      <button
        type="button"
        className="rm-quiet rm-task-comments-toggle"
        aria-expanded={showComments}
        aria-controls={threadId}
        onClick={() => setShowComments((open) => !open)}
      >
        <MessageSquare size={16} aria-hidden="true" />
        {showComments ? 'Hide comments' : 'Comments'}
        {commentCount ? (
          <>
            <span className="rm-task-comment-count" aria-hidden="true">
              {commentCount}
            </span>
            <span className="rm-visually-hidden">
              , {commentCount} {commentCount === 1 ? 'comment' : 'comments'}
            </span>
          </>
        ) : null}
      </button>
      <div id={threadId} hidden={!showComments}>
        {showComments ? (
          <Suspense
            fallback={
              <p className="rm-meta" role="status">
                Loading comments…
              </p>
            }
          >
            <TaskComments
              roomId={roomId}
              taskId={task.id}
              taskLabel={`T${task.number}`}
              host={host}
              canWrite={canComment && !closed}
              agentId={commentAs}
              count={task.comment_count}
              onCount={onCount}
            />
          </Suspense>
        ) : null}
      </div>
    </Root>
  );
}

/** Loads the room's tasks; `available` is false when this server has no room tasks. */
export function useRoomTasks(roomId: string, active: boolean) {
  const [tasks, setTasks] = useState<RoomTask[] | null>(null);
  const [stages, setStages] = useState<string[]>([]);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  // Pages the last read took: a bigger room is re-read less often (taskRefreshDelay).
  const pages = useRef(1);
  const refresh = useCallback(async () => {
    try {
      const list = await listTasks(roomId);
      setAvailable(list !== null);
      if (list) {
        pages.current = list.pages;
        setTasks(list.tasks);
        setStages(list.stages);
      }
      setError('');
    } catch (err) {
      setError(message(err));
    }
  }, [roomId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: number | undefined;
    // The next re-read is planned only after this one ends, so two never overlap, and a hidden
    // tab skips its turn.
    const tick = async () => {
      if (pageVisible()) await refresh();
      if (!stopped) timer = window.setTimeout(() => void tick(), taskRefreshDelay(pages.current));
    };
    // Opening the panel shows fresh tasks and stages (the host may have just edited them).
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [active, refresh]);
  return { tasks, stages, available, error, refresh, setTasks };
}

export function TasksPanel({
  room,
  members,
  state,
  startAdding = 0,
  openNumber = null,
  onClose,
  openTask = null,
  onPinTask,
}: {
  room: Room;
  members: Member[];
  state: ReturnType<typeof useRoomTasks>;
  /** Changes when the composer asks for a new task: open the form. */
  startAdding?: number;
  /** v2: open this task's detail (a T-number cited by the catch-up); `key` changes per click. */
  openNumber?: { number: number; key: number } | null;
  onClose: () => void;
  /** Smart Rooms v2: a task to open (a context pin); `key` changes on every request. */
  openTask?: { id: string; key: number } | null;
  /** Smart Rooms v2: the task card's Pin action (absent when the viewer cannot pin). */
  onPinTask?: ((task: RoomTask) => void) | undefined;
}) {
  const host = room.role === 'host';
  const hostAgent = members.find((member) => member.role === 'host' && member.own);
  // Any posting member may add a task, as on the task tools: the host as its host agent, a
  // member as themselves when they joined as a person, else as their own member agent.
  const ownMembers = members.filter((member) => member.own && member.role !== 'guest');
  const actingMember = host
    ? hostAgent
    : (ownMembers.find((member) => member.kind === 'person') ?? ownMembers[0]);
  // A muted member reads but cannot post, so it adds no tasks either (the server refuses too).
  const canAdd = !room.closed && !room.muted && (host || actingMember !== undefined);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [adding, setAdding] = useState(startAdding > 0);
  useEffect(() => {
    if (startAdding) setAdding(true);
  }, [startAdding]);
  // Smart Rooms v2 preview: a filter row, compact cards and a detail view per task.
  const v2 = useRoomsV2();
  const [filter, setFilter] = useState<TaskFilter>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  // The card's Ask for a review opens the task with the review form showing.
  const [openAsking, setOpenAsking] = useState(false);
  useEffect(() => {
    if (startAdding) setOpenId(null);
  }, [startAdding]);
  const openTaskKey = openTask?.key;
  useEffect(() => {
    if (!openTask) return;
    setOpenAsking(false);
    setOpenId(openTask.id);
    setMissingNumber(null);
  }, [openTaskKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const openKey = openNumber?.key;
  const loadedTasks = state.available ? state.tasks : null;
  // A cited task that is not in the loaded list: say so (never a dead click) and load the list
  // again once; when the fresh list has it, its detail opens.
  const [missingNumber, setMissingNumber] = useState<number | null>(null);
  const refetchedKey = useRef<number | null>(null);
  useEffect(() => {
    if (!openNumber) return;
    if (state.available === false) return setMissingNumber(openNumber.number);
    if (!loadedTasks) return;
    const task = loadedTasks.find((item) => item.number === openNumber.number);
    if (task) {
      setOpenAsking(false);
      setOpenId(task.id);
      setMissingNumber(null);
      return;
    }
    setOpenId(null);
    setMissingNumber(openNumber.number);
    if (refetchedKey.current !== openNumber.key) {
      refetchedKey.current = openNumber.key;
      void state.refresh();
    }
  }, [openKey, loadedTasks, state.available]); // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [actionError, setActionError] = useState('');
  const key = useRef(requestKey());
  const nameOf = (agentId: string) =>
    members.find((member) => member.id === agentId)?.name ?? 'A member';
  // Comments act as one of the viewer's own members: the person when they joined as themselves,
  // else their host or first own agent (never their Elric, which only answers when asked).
  const own = members.filter((member) => member.own && member.auto_reply?.provider !== 'elric');
  const commentAs =
    own.length > 1
      ? (own.find((member) => member.kind === 'person') ??
          own.find((member) => member.role === 'host') ??
          own[0])!.id
      : undefined;
  const { tasks, stages, error, refresh, setTasks } = state;
  const ownAgents = new Set(members.filter((member) => member.own).map((member) => member.id));

  function resetForm() {
    setTitle('');
    setBody('');
    setTemplateId('');
    setAdding(false);
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    const template = findTaskTemplate(templateId);
    setBusy(true);
    setFormError('');
    // With a template an empty body stays empty: the server fills the template's body only
    // when no body is sent (API and MCP callers), and the console always sends one.
    const request = {
      roomId: room.id,
      agentId: actingMember?.id,
      title: title.trim(),
      body: template ? body.trim() : body.trim() || undefined,
      templateId: template?.id,
    };
    try {
      // The same key for a retry of the same form (it never adds the task twice); any edit to
      // the form, or another acting member, takes a new key.
      const task = await createTask({
        ...request,
        key: key.current.for({
          roomId: request.roomId,
          agentId: request.agentId ?? null,
          title: request.title,
          body: request.body ?? null,
          templateId: request.templateId ?? null,
        }),
      });
      key.current.done();
      setTasks((list) => [task, ...(list ?? []).filter((item) => item.id !== task.id)]);
      resetForm();
    } catch (err) {
      setFormError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function decide(task: RoomTask, decision: TaskDecision) {
    setBusy(true);
    setActionError('');
    try {
      const updated = await decideTask(room.id, task.id, decision);
      setTasks((list) => (list ?? []).map((item) => (item.id === updated.id ? updated : item)));
    } catch (err) {
      setActionError(message(err));
      void refresh();
    } finally {
      setBusy(false);
    }
  }

  const replace = (updated: RoomTask) =>
    setTasks((list) => (list ?? []).map((item) => (item.id === updated.id ? updated : item)));
  async function run(work: () => Promise<RoomTask>): Promise<boolean> {
    setBusy(true);
    setActionError('');
    try {
      replace(await work());
      return true;
    } catch (err) {
      setActionError(message(err));
      void refresh();
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function stage(task: RoomTask, next: string | null) {
    setBusy(true);
    setActionError('');
    try {
      const updated = await moveTaskStage(room.id, task.id, next);
      setTasks((list) => (list ?? []).map((item) => (item.id === updated.id ? updated : item)));
    } catch (err) {
      setActionError(
        err instanceof ApiError && err.code === 'stage_not_allowed'
          ? 'Only the host or the member working on this task can change its stage.'
          : err instanceof ApiError && err.code === 'unknown_stage'
            ? 'That stage is no longer in this room. Pick another one.'
            : message(err),
      );
      void refresh();
    } finally {
      setBusy(false);
    }
  }
  /** Asking as the claimer uses the claiming agent; the host uses the host agent. */
  const askerFor = (task: RoomTask) =>
    task.claim && members.some((member) => member.own && member.id === task.claim!.agent_id)
      ? task.claim.agent_id
      : hostAgent?.id;

  const sorted = tasks ? sortTasks(tasks) : null;
  const addForm = (
    <form className="rm-task-form" onSubmit={(event) => void add(event)}>
      <TemplatePicker value={templateId} onChange={setTemplateId} />
      <label className="rm-field">
        <span>Task</span>
        <input
          className="rm-input"
          value={title}
          maxLength={200}
          required
          autoFocus
          onChange={(event) => setTitle(event.target.value)}
          placeholder="What should be done?"
        />
      </label>
      <label className="rm-field">
        <span>Details (optional)</span>
        <textarea
          className="rm-input rm-task-details"
          value={body}
          maxLength={16_384}
          rows={3}
          placeholder="Add details (optional)"
          onChange={(event) => setBody(event.target.value)}
        />
      </label>
      {formError ? (
        <p className="rm-inline-error" role="alert">
          {formError}
        </p>
      ) : null}
      <div className="rm-task-actions">
        <button type="submit" className="rm-primary" disabled={busy || !title.trim()}>
          {busy ? 'Adding…' : 'Add task'}
        </button>
        <button type="button" className="rm-quiet" onClick={() => setAdding(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
  const errorBox =
    error || actionError ? (
      <div className="rm-inline-error" role="alert">
        <span>{actionError || error}</span>
        <button type="button" className="rm-quiet" onClick={() => void refresh()}>
          Retry
        </button>
      </div>
    ) : null;
  const loading =
    !sorted && !error ? (
      <p className="rm-meta" role="status">
        Loading tasks…
      </p>
    ) : null;
  const empty = (
    <p className="rm-meta">{host ? 'No tasks yet. Add the first one.' : 'No tasks yet.'}</p>
  );
  const renderItem = (task: RoomTask, detail = false, startAsking = false) => (
    <TaskItem
      key={`${task.id}${startAsking ? '-ask' : ''}`}
      task={task}
      roomId={room.id}
      host={host}
      closed={room.closed}
      members={members}
      canComment={!room.readOnly}
      commentAs={commentAs}
      nameOf={nameOf}
      busy={busy}
      onDecide={(item, decision) => void decide(item, decision)}
      onAskReview={(item, reviewerId, checklist) =>
        run(() =>
          requestReview(room.id, item.id, {
            agentId: askerFor(item),
            reviewerId,
            checklist,
          }),
        )
      }
      onWithdrawReview={(item) =>
        void run(() => requestReview(room.id, item.id, { agentId: askerFor(item), cancel: true }))
      }
      onPeerReview={(item, agentId, verdict, comment, checklist) =>
        void run(() => submitPeerReview(room.id, item.id, { agentId, verdict, comment, checklist }))
      }
      stages={stages}
      mine={!!task.claim && ownAgents.has(task.claim.agent_id)}
      onStage={(item, next) => void stage(item, next)}
      detail={detail}
      startAsking={startAsking}
    />
  );

  if (v2) {
    // The open task, while it is still in the list (a refresh may drop a cancelled one).
    const opened = openId ? (sorted?.find((task) => task.id === openId) ?? null) : null;
    const shown = sorted ? filterTasks(sorted, filter) : null;
    const viewer = { host, closed: room.closed, own: ownAgents };
    const open = (task: RoomTask, focus?: 'comments' | 'review') => {
      setAdding(false);
      setOpenAsking(focus === 'review');
      setOpenId(task.id);
    };
    // Workspace v3 (docs/design/WORKSPACE_V3.md §4.5): a 360px panel with a fixed header, a
    // scrolling body and, on the list, a New task button at the foot.
    return (
      <aside
        className="rm-panel rm-tasks-panel rm-v2-tasks rm-v3-panel"
        aria-label="Tasks"
        data-view={opened ? 'detail' : 'list'}
      >
        {opened ? (
          <>
            <PanelHead closeLabel="Close tasks" onClose={onClose} className="rm-v3-detail-head">
              <button
                type="button"
                className="rm-v2-back"
                onClick={() => {
                  setOpenId(null);
                  setOpenAsking(false);
                }}
              >
                <ArrowLeft size={16} aria-hidden="true" />
                All tasks
              </button>
              <h2 className="rm-v2-detail-title">
                T{opened.number}: {opened.title}
              </h2>
            </PanelHead>
            <div className="rm-v3-body">
              <div className="rm-v3-detail-meta">
                <TaskStageFlow task={opened} />
                <TaskClaimer task={opened} members={members} prefix="Claimed by " />
                <TaskProgress task={opened} />
              </div>
              {errorBox}
              {renderItem(opened, true, openAsking)}
            </div>
          </>
        ) : (
          <>
            <PanelHead closeLabel="Close tasks" onClose={onClose}>
              <h2>
                Tasks
                {sorted ? <span className="rm-v3-head-count">{sorted.length}</span> : null}
              </h2>
            </PanelHead>
            <div className="rm-v3-body">
              {canAdd && adding ? addForm : null}
              {errorBox}
              {missingNumber !== null ? (
                <p className="rm-quiet" role="status" data-testid="tasks-missing">
                  T{missingNumber} isn&rsquo;t in the loaded tasks. It may have been removed or you
                  may not see it here.
                </p>
              ) : null}
              {sorted && sorted.length ? (
                <TaskFilterRow counts={countTasks(sorted)} value={filter} onChange={setFilter} />
              ) : null}
              {!sorted && !error ? (
                <div className="rm-v2-skeletons">
                  <p className="rm-visually-hidden" role="status">
                    Loading tasks…
                  </p>
                  {[0, 1, 2].map((index) => (
                    <div key={index} className="rm-v2-skeleton" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </div>
                  ))}
                </div>
              ) : null}
              {shown && sorted ? (
                sorted.length === 0 ? (
                  adding ? null : (
                    <div className="rm-v3-empty">
                      <strong>{host ? 'No tasks yet. Add the first one.' : 'No tasks yet.'}</strong>
                      <span>Members take a task, work on it and hand in a result.</span>
                    </div>
                  )
                ) : shown.length ? (
                  <ul className="rm-v3-task-list" aria-label="Room tasks">
                    {shown.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        members={members}
                        onOpen={open}
                        onPin={onPinTask}
                        onAskReview={
                          canAskReview(task, viewer) ? (item) => open(item, 'review') : undefined
                        }
                      />
                    ))}
                  </ul>
                ) : (
                  <div className="rm-v3-empty">
                    <strong>No tasks in this stage.</strong>
                  </div>
                )
              ) : null}
            </div>
            {canAdd && !adding ? (
              <div className="rm-v3-foot">
                <button
                  type="button"
                  className="rm-v3-btn rm-v3-btn-primary rm-v3-btn-block"
                  onClick={() => setAdding(true)}
                >
                  <Plus size={16} strokeWidth={2.4} aria-hidden="true" />
                  New task
                </button>
              </div>
            ) : null}
          </>
        )}
      </aside>
    );
  }

  return (
    <aside className="rm-panel rm-tasks-panel" aria-label="Tasks">
      <div className="rm-sheet-head">
        <h2>Tasks{tasks ? ` · ${tasks.length}` : ''}</h2>
        <button type="button" className="rm-icon" aria-label="Close tasks" onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <p className="rm-meta">
        {host
          ? 'Add work for the room. Members take a task, work on it and hand in a result for you to review.'
          : 'Work for this room. Members add tasks, take one and hand in a result for the host to review.'}
      </p>
      {canAdd ? (
        adding ? (
          addForm
        ) : (
          <button type="button" className="rm-primary" onClick={() => setAdding(true)}>
            New task
          </button>
        )
      ) : null}
      {errorBox}
      {!sorted ? (
        loading
      ) : sorted.length ? (
        <ul className="rm-tasks" aria-label="Room tasks">
          {sorted.map((task) => renderItem(task))}
        </ul>
      ) : (
        empty
      )}
    </aside>
  );
}
