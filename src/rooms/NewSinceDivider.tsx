import type { ReactNode } from 'react';
import { updatesLabel, type NewSince } from './newSince';

/**
 * One thin row above the first unread message (Smart Rooms v2 preview): a centered pill with
 * hairlines on both sides. It sits in the message list and scrolls with it; it is never pinned.
 *
 * `summary` is the slot for an expandable catch-up summary under the pill. RoomView fills it with Elric's catch-up (CatchUpSummary) in the v2 preview;
 * and with no summary nothing is rendered there.
 */
export function NewSinceDivider({
  info,
  time,
  summary,
}: {
  info: NewSince;
  /** The formatted "since" time (HH:MM). */
  time: string;
  /** Expandable catch-up summary slot (v2: CatchUpSummary). */
  summary?: ReactNode;
}) {
  const label = `New since ${time} · ${updatesLabel(info.count, info.more)}`;
  return (
    <li className="rm-unread-divider" data-testid="room-new-since">
      <div className="rm-unread-divider-line" role="separator" aria-label={label}>
        <span className="rm-unread-pill" aria-hidden="true">
          <span className="rm-unread-dot" />
          {label}
        </span>
      </div>
      {summary ? (
        <div className="rm-unread-summary" data-slot="new-since-summary">
          {summary}
        </div>
      ) : null}
    </li>
  );
}
