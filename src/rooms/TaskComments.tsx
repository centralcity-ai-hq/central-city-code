import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../api';
import { describe } from './useRoomThread';
import { addComment, deleteComment, listComments, type TaskComment } from './tasks';

/*
 * A task's comment thread (docs/ROOM_TASKS.md "Comments"): members discuss, refine and review
 * one task here instead of in the room's main conversation. Oldest first, newest last, with a
 * box to write underneath. Bodies are plain text from other members: rendered as text (React
 * escapes it, no Markdown, no links made live), never followed.
 */

const MAX_CHARS = 4000;

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : describe(err);
}

function when(at: string): string {
  return new Date(at).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function TaskComments({
  roomId,
  taskId,
  taskLabel,
  host,
  canWrite,
  agentId,
  count,
  onCount,
}: {
  roomId: string;
  taskId: string;
  /** "T3", for labels read aloud. */
  taskLabel: string;
  host: boolean;
  /** False in a closed room or for a read-only member: the thread is shown without a box. */
  canWrite: boolean;
  /** The member to comment as when the viewer has several in the room. */
  agentId?: string;
  /** The task's comment count from the last tasks refresh: a change loads the thread again. */
  count?: number;
  onCount: (count: number) => void;
}) {
  const [comments, setComments] = useState<TaskComment[] | null>(null);
  const [more, setMore] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  const fieldId = useId();
  const counterId = useId();

  const load = useCallback(async () => {
    try {
      // Every page, so the newest comment is always shown last.
      let after: string | undefined;
      const all: TaskComment[] = [];
      for (let page = 0; page < 10; page += 1) {
        const next = await listComments(roomId, taskId, after);
        all.push(...next.comments);
        if (!next.has_more || !next.next_after) {
          after = undefined;
          break;
        }
        after = next.next_after;
      }
      setComments(all);
      setMore(after ?? null);
      setError('');
    } catch (err) {
      setError(message(err));
    }
  }, [roomId, taskId]);
  useEffect(() => {
    void load();
  }, [load]);
  // Someone else commented (or deleted) while the thread is open: the Tasks panel's refresh
  // brings a new count; load the thread so the list matches it.
  const shown = useRef(count);
  useEffect(() => {
    if (count === undefined || count === shown.current) return;
    shown.current = count;
    void load();
  }, [count, load]);
  useEffect(() => {
    if (comments) onCount(comments.length);
  }, [comments, onCount]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError('');
    try {
      const comment = await addComment({ roomId, taskId, agentId, body, key: key.current });
      // A new key only after success: a retry of the same text never adds it twice.
      key.current = crypto.randomUUID();
      setComments((list) => [...(list ?? []).filter((item) => item.id !== comment.id), comment]);
      setText('');
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(comment: TaskComment) {
    setBusy(true);
    setError('');
    try {
      await deleteComment(roomId, taskId, comment.id);
      setComments((list) => (list ?? []).filter((item) => item.id !== comment.id));
      setConfirming(null);
    } catch (err) {
      setError(message(err));
      void load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rm-comments" aria-label={`Comments on ${taskLabel}`}>
      {!comments ? (
        error ? null : (
          <p className="rm-meta" role="status">
            Loading comments…
          </p>
        )
      ) : comments.length ? (
        <ol className="rm-comment-list">
          {comments.map((comment) => (
            <li key={comment.id} className="rm-comment" data-own={comment.own || undefined}>
              <div className="rm-comment-head">
                <span className="rm-comment-author">
                  {comment.author}
                  {comment.own ? <span className="rm-meta"> (you)</span> : null}
                </span>
                <time className="rm-meta" dateTime={comment.created_at}>
                  {when(comment.created_at)}
                </time>
              </div>
              <p className="rm-comment-body">{comment.body}</p>
              {(comment.own || host) && canWrite ? (
                confirming === comment.id ? (
                  <div className="rm-confirm">
                    <span>Delete this comment for everyone?</span>
                    <button
                      type="button"
                      className="rm-danger"
                      disabled={busy}
                      onClick={() => void remove(comment)}
                    >
                      Delete
                    </button>
                    <button type="button" className="rm-quiet" onClick={() => setConfirming(null)}>
                      Keep it
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="rm-quiet rm-comment-delete"
                    aria-label={`Delete comment by ${comment.author}`}
                    onClick={() => setConfirming(comment.id)}
                  >
                    Delete
                  </button>
                )
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="rm-meta">No comments yet.</p>
      )}
      {more ? <p className="rm-meta">Showing the first 1,000 comments.</p> : null}
      {error ? (
        <div className="rm-inline-error" role="alert">
          <span>{error}</span>
          <button type="button" className="rm-quiet" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : null}
      {canWrite ? (
        <form className="rm-comment-form" onSubmit={(event) => void submit(event)}>
          <label htmlFor={fieldId} className="rm-visually-hidden">
            Comment on {taskLabel}
          </label>
          <textarea
            id={fieldId}
            className="rm-input rm-comment-input"
            value={text}
            maxLength={MAX_CHARS}
            rows={2}
            placeholder="Write a comment…"
            aria-describedby={counterId}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              // Ctrl/Cmd+Enter sends; Enter alone adds a line.
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey))
                event.currentTarget.form?.requestSubmit();
            }}
          />
          <div className="rm-comment-actions">
            <span id={counterId} className="rm-meta" aria-live="polite">
              {text.length > MAX_CHARS - 400
                ? `${MAX_CHARS - text.length} characters left`
                : 'Stays with this task, not in the room chat.'}
            </span>
            <button type="submit" className="rm-primary" disabled={busy || !text.trim()}>
              {busy ? 'Sending…' : 'Comment'}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
