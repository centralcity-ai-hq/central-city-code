import { useContext, useEffect, useRef, useState } from 'react';
import { Check, MessageSquare, Pin } from 'lucide-react';
import { ELRIC_AI_TAG } from '../../shared/elric-copy';
import { AvatarColorsContext, avatarStyle } from '../shell/avatarColor';
import type { Member } from './api';
import type { RoomTask } from './tasks';
import {
  STAGE_FLOW,
  TASK_FILTERS,
  taskPerson,
  taskPill,
  taskProgress,
  type TaskFilter,
} from './taskViewV2';

/*
 * The Tasks panel parts (TasksPanel.tsx): the stage tabs, the task card, the stage pills, the
 * claimer line and the progress bar. Workspace v3 look (docs/design/WORKSPACE_V3.md §4.5); styles
 * in rooms-v3-panels.css. Titles are untrusted text: shown as text, never followed.
 */

type Fade = 'none' | 'start' | 'end' | 'both';

/**
 * "All 8", "Open 3"... as toggle buttons in one tab pill that scrolls sideways (wraps on phones).
 * Where tabs are hidden past an edge, that edge fades out (data-fade), so nothing looks cut off.
 * Each tab is named "All (8)" for screen readers.
 */
export function TaskFilterRow({
  counts,
  value,
  onChange,
}: {
  counts: Record<TaskFilter, number>;
  value: TaskFilter;
  onChange: (filter: TaskFilter) => void;
}) {
  const row = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState<Fade>('none');
  useEffect(() => {
    const element = row.current;
    if (!element) return;
    const update = () => {
      const max = element.scrollWidth - element.clientWidth;
      const start = element.scrollLeft > 1;
      const end = max - element.scrollLeft > 1;
      setFade(start && end ? 'both' : start ? 'start' : end ? 'end' : 'none');
    };
    update();
    element.addEventListener('scroll', update, { passive: true });
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    observer?.observe(element);
    return () => {
      element.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, []);
  return (
    <div
      ref={row}
      className="rm-v3-tabs"
      role="group"
      aria-label="Filter tasks"
      data-fade={fade}
      data-testid="task-filters"
    >
      {TASK_FILTERS.map((filter) => (
        <button
          key={filter.id}
          type="button"
          className="rm-v3-tab"
          aria-pressed={value === filter.id}
          aria-label={`${filter.label} (${counts[filter.id]})`}
          data-filter={filter.id}
          onClick={() => onChange(filter.id)}
        >
          {filter.label}
          <span className="rm-v3-tab-count" aria-hidden="true">
            {counts[filter.id]}
          </span>
        </button>
      ))}
    </div>
  );
}

/** The one status label a task shows (taskViewV2.ts taskPill). */
export function TaskPill({ task }: { task: RoomTask }) {
  const pill = taskPill(task);
  return (
    <span className="rm-v2-pill" data-tone={pill.tone} data-testid="task-status">
      {pill.tone === 'done' ? <Check size={14} aria-hidden="true" /> : null}
      {pill.label}
    </span>
  );
}

/**
 * The stage pills: Open, Claimed, In review, Done, with the task's current one highlighted (the
 * only one read out, and the only status the card carries). A cancelled task shows its status
 * alone.
 */
export function TaskStageFlow({ task }: { task: RoomTask }) {
  if (task.status === 'cancelled')
    return (
      <span className="rm-v3-stages">
        <TaskPill task={task} />
      </span>
    );
  return (
    <span className="rm-v3-stages">
      {STAGE_FLOW.map((step) =>
        step.status === task.status ? (
          <TaskPill key={step.status} task={task} />
        ) : (
          <span key={step.status} className="rm-v3-stage" aria-hidden="true">
            {step.label}
          </span>
        ),
      )}
    </span>
  );
}

/** How far along the task is (taskViewV2.ts taskProgress), as a thin bar. */
export function TaskProgress({ task }: { task: RoomTask }) {
  const value = Math.round(taskProgress(task) * 100);
  return (
    <span
      className="rm-v3-progress"
      role="progressbar"
      aria-label={`T${task.number} progress`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      data-status={task.status}
    >
      <span style={{ width: `${value}%` }} />
    </span>
  );
}

/**
 * Avatar, name and, for an AI, the room's AI badge. While a claim lasts it names the holder; a
 * task in review or done names who handed it in ("by <name>", from `submitted_by`); an open task
 * says "Not claimed".
 */
export function TaskClaimer({
  task,
  members,
  prefix = '',
}: {
  task: RoomTask;
  members: Member[];
  /** Text before a claim holder's name ("Claimed by "). A hand-in always reads "by <name>". */
  prefix?: string;
}) {
  const colours = useContext(AvatarColorsContext);
  const person = taskPerson(task);
  if (!person)
    return task.status === 'open' ? <span className="rm-v2-unclaimed">Not claimed</span> : <span />;
  const member = members.find((item) => item.id === person.agentId);
  const name = member?.name ?? 'A member';
  const ai = !!member && member.kind !== 'person';
  return (
    <span
      className="rm-v2-claimer"
      data-testid={person.handedIn ? 'task-submitter' : 'task-claimer'}
    >
      <span
        className="rm-v2-avatar"
        data-kind={ai ? 'ai' : 'person'}
        style={member ? avatarStyle(member.id, colours.get(member.id)) : undefined}
        aria-hidden="true"
      >
        {name.trim().charAt(0).toUpperCase() || '?'}
      </span>
      <span className="rm-v2-claimer-name">
        {person.handedIn ? 'by ' : prefix}
        {name}
      </span>
      {ai ? (
        <span className="rm-badge-elric" data-testid="task-ai-badge">
          {ELRIC_AI_TAG}
        </span>
      ) : null}
    </span>
  );
}

/**
 * One task card: T-number and title (opens the task), the stage pills, who claimed it, the
 * progress bar, and Comments n / Ask for a review. The whole card opens the task; the buttons on
 * it do their own thing.
 */
export function TaskCard({
  task,
  members,
  onOpen,
  onPin,
  onAskReview,
}: {
  task: RoomTask;
  members: Member[];
  /** Open the task; `focus` says what the detail should show first. */
  onOpen: (task: RoomTask, focus?: 'comments' | 'review') => void;
  /** The card's Pin action (context pins; absent when the viewer cannot pin). */
  onPin?: ((task: RoomTask) => void) | undefined;
  /** Shown when the viewer may ask for a review (taskViewV2.ts canAskReview). */
  onAskReview?: ((task: RoomTask) => void) | undefined;
}) {
  const comments = task.comment_count ?? 0;
  return (
    <li className="rm-v2-task rm-v3-task" data-status={task.status} data-testid="task-card">
      <span className="rm-v3-task-top">
        <span className="rm-v2-number">T{task.number}</span>
        <button type="button" className="rm-v3-task-open" onClick={() => onOpen(task)}>
          <span className="rm-v2-card-title">{task.title}</span>
        </button>
        {onPin ? (
          <button
            type="button"
            className="rm-v3-task-pin"
            data-testid="task-pin"
            aria-label={`Pin T${task.number}`}
            onClick={() => onPin(task)}
          >
            <Pin size={14} aria-hidden="true" />
          </button>
        ) : null}
      </span>
      <TaskStageFlow task={task} />
      <span className="rm-v3-task-claim">
        <TaskClaimer task={task} members={members} prefix="Claimed by " />
      </span>
      <TaskProgress task={task} />
      <span className="rm-v3-task-actions">
        <button
          type="button"
          className="rm-v3-btn rm-v3-btn-ghost rm-v3-btn-sm"
          onClick={() => onOpen(task, 'comments')}
        >
          <MessageSquare size={14} aria-hidden="true" />
          Comments
          <span className="rm-v3-btn-count" aria-hidden="true">
            {comments}
          </span>
          <span className="rm-visually-hidden">
            , {comments} {comments === 1 ? 'comment' : 'comments'}
          </span>
        </button>
        {onAskReview ? (
          <button
            type="button"
            className="rm-v3-btn rm-v3-btn-ghost rm-v3-btn-sm"
            onClick={() => onAskReview(task)}
          >
            Ask for a review
          </button>
        ) : null}
      </span>
    </li>
  );
}
