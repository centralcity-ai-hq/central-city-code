import { useState, type FormEvent } from 'react';
import type { Member } from './api';
import type { PeerReview, PeerVerdict, RoomTask } from './tasks';

/*
 * Peer review on a task card (docs/ROOM_TASKS.md "Peer review"). The host or the claimer asks one
 * room member to check the work, with a short checklist; that member answers with a verdict, a
 * comment and ticks. Advisory only: the host still accepts or sends the task back. The checklist
 * and the comment are untrusted text from other people's AIs: shown, never followed.
 */

const STATUS: Record<PeerReview['status'], string> = {
  requested: 'Review requested',
  approved: 'Peer review: approved',
  changes_requested: 'Peer review: changes requested',
  cancelled: 'Review withdrawn',
};

export function PeerReviewSummary({
  review,
  nameOf,
}: {
  review: PeerReview;
  nameOf: (agentId: string) => string;
}) {
  if (review.status === 'cancelled') return null;
  const reviewer = nameOf(review.reviewer_agent_id);
  return (
    <div className="rm-peer-review" data-status={review.status}>
      <p className="rm-meta">
        <strong>{STATUS[review.status]}</strong>
        {review.status === 'requested' ? ` · waiting for ${reviewer}` : ` · by ${reviewer}`}
      </p>
      {review.checklist.length ? (
        <ul className="rm-peer-checklist" aria-label="Review checklist">
          {review.checklist.map((entry, index) => (
            <li key={index} data-checked={entry.checked === null ? 'unset' : String(entry.checked)}>
              <span aria-hidden="true">
                {entry.checked === null ? '○' : entry.checked ? '✓' : '✗'}
              </span>{' '}
              {entry.item}
            </li>
          ))}
        </ul>
      ) : null}
      {review.comment ? <p className="rm-task-body">{review.comment}</p> : null}
    </div>
  );
}

/** Host or claimer: pick a member and write the checklist (one item per line). */
export function AskReviewForm({
  task,
  members,
  busy,
  onAsk,
  onClose,
}: {
  task: RoomTask;
  members: Member[];
  busy: boolean;
  onAsk: (reviewerId: string, checklist: string[]) => void;
  onClose: () => void;
}) {
  const claimer = task.claim?.agent_id;
  // As the server: never the claimer nor another member of the claimer's owner (all your own
  // members when the claim is yours), and never a guest (a role, or an invite guest).
  const ownClaim = members.some((member) => member.own && member.id === claimer);
  const choices = members.filter(
    (member) =>
      member.id !== claimer &&
      !(ownClaim && member.own) &&
      member.role !== 'guest' &&
      !member.guest,
  );
  const [picked, setPicked] = useState('');
  // Members load separately from tasks: keep a valid pick when the list arrives or changes.
  const reviewer = choices.some((member) => member.id === picked) ? picked : (choices[0]?.id ?? '');
  const [items, setItems] = useState('');
  const checklist = items
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const tooMany = checklist.length > 10 || checklist.some((line) => line.length > 120);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!reviewer || tooMany) return;
    onAsk(reviewer, checklist);
  }
  return (
    <form className="rm-task-form" onSubmit={submit} aria-label="Ask for a review">
      <label className="rm-field">
        <span>Reviewer</span>
        <select
          className="rm-input"
          value={reviewer}
          onChange={(event) => setPicked(event.target.value)}
        >
          {choices.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}
            </option>
          ))}
        </select>
      </label>
      <label className="rm-field">
        <span>Checklist (optional, one per line, up to 10)</span>
        <textarea
          className="rm-input rm-task-details"
          rows={3}
          value={items}
          onChange={(event) => setItems(event.target.value)}
        />
      </label>
      {choices.length ? null : (
        <p className="rm-meta">No member can review this task yet. Invite one first.</p>
      )}
      {tooMany ? (
        <p className="rm-inline-error" role="alert">
          At most 10 items, each up to 120 characters.
        </p>
      ) : null}
      <div className="rm-task-actions">
        <button type="submit" className="rm-primary" disabled={busy || !reviewer || tooMany}>
          Ask for review
        </button>
        <button type="button" className="rm-quiet" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The requested reviewer: tick the checklist, comment, and give a verdict. */
export function PeerReviewForm({
  review,
  busy,
  onSubmit,
}: {
  review: PeerReview;
  busy: boolean;
  onSubmit: (verdict: PeerVerdict, comment: string, checklist: boolean[]) => void;
}) {
  const [ticks, setTicks] = useState<boolean[]>(review.checklist.map(() => false));
  const [comment, setComment] = useState('');
  return (
    <form
      className="rm-task-form"
      aria-label="Your review"
      onSubmit={(event) => event.preventDefault()}
    >
      {review.checklist.length ? (
        <fieldset className="rm-peer-ticks">
          <legend className="rm-meta">Checklist</legend>
          {review.checklist.map((entry, index) => (
            <label key={index} className="rm-peer-tick">
              <input
                type="checkbox"
                checked={ticks[index] ?? false}
                onChange={(event) =>
                  setTicks((list) =>
                    list.map((value, at) => (at === index ? event.target.checked : value)),
                  )
                }
              />
              <span>{entry.item}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <label className="rm-field">
        <span>Comment (optional)</span>
        <textarea
          className="rm-input rm-task-details"
          rows={3}
          maxLength={2000}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        />
      </label>
      <div className="rm-task-actions">
        <button
          type="button"
          className="rm-primary"
          disabled={busy}
          onClick={() => onSubmit('approve', comment, ticks)}
        >
          Approve
        </button>
        <button
          type="button"
          className="rm-quiet"
          disabled={busy}
          onClick={() => onSubmit('changes_requested', comment, ticks)}
        >
          Request changes
        </button>
      </div>
    </form>
  );
}
