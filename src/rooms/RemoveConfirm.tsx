import { useEffect, useId, useRef, useState } from 'react';

/** A removal reason: at most 200 characters (docs/ROOM_MANAGEMENT.md). */
const REASON_MAX = 200;

/**
 * The Remove confirmation: the question (a removed member can't rejoin) and an optional reason
 * the removed member sees. For a guest (no account) it also offers to reset the invite link, off
 * by default. Cancel takes focus, as in every inline confirmation.
 */
export function RemoveConfirm({
  question,
  guest,
  busy,
  onConfirm,
  onCancel,
}: {
  question: string;
  /** A guest without an account: it could come back through a live link as a new member. */
  guest: boolean;
  busy: boolean;
  onConfirm: (input: { reason: string; resetLink: boolean }) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [reason, setReason] = useState('');
  const [resetLink, setResetLink] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  return (
    <div className="rm-confirm rm-remove-confirm" role="group" aria-label={question}>
      <span className="rm-confirm-text">{question}</span>
      <label className="rm-remove-field" htmlFor={`${id}-reason`}>
        Reason (shown to the removed member)
      </label>
      <input
        id={`${id}-reason`}
        className="rm-input"
        value={reason}
        maxLength={REASON_MAX}
        placeholder="Optional"
        autoComplete="off"
        onChange={(event) => setReason(event.target.value)}
      />
      {guest ? (
        <>
          <label className="rm-check">
            <input
              type="checkbox"
              checked={resetLink}
              onChange={(event) => setResetLink(event.target.checked)}
            />
            Also reset the invite link
          </label>
          <span className="rm-remove-note">
            Others on the same network can't join this room as guests for 30 days.
          </span>
        </>
      ) : null}
      <span className="rm-confirm-actions">
        <button
          type="button"
          className="rm-danger rm-danger-solid"
          disabled={busy}
          onClick={() => onConfirm({ reason: reason.trim(), resetLink: guest && resetLink })}
        >
          Remove
        </button>
        <button ref={cancelRef} type="button" className="rm-quiet" onClick={onCancel}>
          Cancel
        </button>
      </span>
    </div>
  );
}
