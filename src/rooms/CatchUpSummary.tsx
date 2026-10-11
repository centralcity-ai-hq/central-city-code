import { useState } from 'react';
import { ThinkingDots } from '../elric/ThinkingDots';
import { CATCH_UP_NOTHING_TEXT, CATCH_UP_TITLE, useCatchUp } from './useCatchUp';
import { catchUpView } from './catchUpView';

/**
 * Elric's "While you were away" catch-up inside the New-since divider (Smart Rooms v2 preview).
 * Collapsed by default: nothing is fetched (or billed) until "Catch me up" is clicked. The range
 * is after this device's read mark (the divider's own mark; people have no server cursor) up to
 * the newest message shown when the button was clicked.
 *
 * Bullet text is plain text (React escapes it; no Markdown, no HTML). Each cited seq jumps to
 * that message; a task number opens the task.
 */
export function CatchUpSummary({
  roomId,
  afterSeq,
  latestSeq,
  onMessage,
  onTask,
}: {
  roomId: string;
  /** This device's read mark when the room opened. */
  afterSeq: number;
  /** The newest message seq loaded now (the range end, taken on click). */
  latestSeq: number | undefined;
  onMessage: (seq: number) => void;
  onTask: (taskNumber: number) => void;
}) {
  const [range, setRange] = useState<{ toSeq?: number } | null>(null);
  const state = useCatchUp(roomId, {
    afterSeq,
    ...(range?.toSeq !== undefined ? { toSeq: range.toSeq } : {}),
    enabled: range !== null,
  });
  const view = catchUpView(range === null ? { status: 'idle' } : state);

  if (view.kind === 'hidden') return null;
  if (view.kind === 'unavailable')
    return (
      <p className="rm-catchup-line rm-catchup-quiet" data-testid="room-catch-up-unavailable">
        {view.text}
      </p>
    );
  if (view.kind === 'collapsed')
    return (
      <button
        type="button"
        className="rm-catchup-open"
        data-testid="room-catch-up-open"
        onClick={() => setRange(latestSeq !== undefined ? { toSeq: latestSeq } : {})}
      >
        Catch me up
      </button>
    );

  const retry = (
    <button type="button" className="rm-catchup-retry" onClick={state.reload}>
      Try again
    </button>
  );
  return (
    <section
      className="rm-elric-catchup-card"
      data-testid="room-catch-up"
      data-state={view.kind}
      aria-label={CATCH_UP_TITLE}
      aria-busy={view.kind === 'loading'}
    >
      <h3 className="rm-catchup-title">{CATCH_UP_TITLE}</h3>
      {view.kind === 'loading' ? (
        <ThinkingDots className="rm-catchup-thinking" />
      ) : view.kind === 'limited' ? (
        <p className="rm-catchup-line rm-catchup-notice" role="status">
          {view.text} {retry}
        </p>
      ) : view.kind === 'error' ? (
        <p className="rm-catchup-line" role="status">
          Couldn&rsquo;t load the catch-up. {retry}
        </p>
      ) : (
        <>
          {view.nothing ? (
            <p className="rm-catchup-line rm-catchup-quiet">{CATCH_UP_NOTHING_TEXT}</p>
          ) : null}
          {view.sections.map((section) => (
            <div key={section.kind} className="rm-catchup-section">
              <h4>{section.title}</h4>
              <ul>
                {section.bullets.map((bullet, index) => (
                  <li key={index}>
                    <span className="rm-catchup-text">{bullet.text}</span>
                    {bullet.task_number !== undefined ? (
                      <button
                        type="button"
                        className="rm-catchup-cite"
                        aria-label={`Open task T${bullet.task_number}`}
                        onClick={() => onTask(bullet.task_number!)}
                      >
                        T{bullet.task_number}
                      </button>
                    ) : null}
                    {bullet.seqs.map((seq) => (
                      <button
                        key={seq}
                        type="button"
                        className="rm-catchup-cite"
                        aria-label={`Go to message ${seq}`}
                        data-seq={seq}
                        onClick={() => onMessage(seq)}
                      >
                        #{seq}
                      </button>
                    ))}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {view.notice ? (
            <p className="rm-catchup-line rm-catchup-notice" role="status">
              {view.notice}
            </p>
          ) : null}
          {view.retry ? (
            <p className="rm-catchup-line" role="status">
              Elric couldn&rsquo;t finish the summary. {retry}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
