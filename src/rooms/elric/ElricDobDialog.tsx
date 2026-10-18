import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { X } from 'lucide-react';
import { ELRIC_AI_NOTICE } from '../../../shared/elric-copy';

export interface ElricDobDialogProps {
  onSubmit: (dateOfBirth: string) => void;
  onClose: () => void;
  busy?: boolean;
  error?: string | null;
}

/**
 * Minimalist Date of Birth step in the Add Elric flow.
 * Single field, one primary button ("Continue"), sentence case,
 * and the note under the field:
 * "Used to confirm you're 18+ and for anonymous statistics."
 */
export function ElricDobDialog({
  onSubmit,
  onClose,
  busy = false,
  error = null,
}: ElricDobDialogProps): ReactElement {
  const [dob, setDob] = useState('');
  const fieldRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  // The latest onClose, so the focus effect runs once: the room passes a new onClose on every
  // render, and re-running the effect would send focus to the page behind the dialog.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        close.current();
        return;
      }
      if (e.key === 'Tab' && formRef.current) {
        const focusable = formRef.current.querySelectorAll<HTMLElement>(
          'input, button:not([disabled])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          last.focus();
          e.preventDefault();
        } else if (!e.shiftKey && document.activeElement === last) {
          first.focus();
          e.preventDefault();
        }
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      previousFocusRef.current?.focus();
    };
  }, []);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!dob || busy) return;
    onSubmit(dob);
  }

  return (
    <div className="rm-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        ref={formRef}
        className="rm-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="elric-dob-title"
        tabIndex={-1}
        onSubmit={handleSubmit}
      >
        <div className="rm-sheet-head">
          <h2 id="elric-dob-title" className="rm-dob-title">
            Date of birth
          </h2>
          <button type="button" className="rm-icon" aria-label="Close" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="rm-field rm-dob-field">
          <input
            ref={fieldRef}
            type="date"
            className="rm-input"
            required
            aria-label="Date of birth"
            value={dob}
            onChange={(e) => setDob(e.target.value)}
            disabled={busy}
          />
        </div>
        <p className="rm-muted rm-dob-note">Used to confirm you're 18+.</p>
        <p className="rm-muted rm-dob-disclosure">{ELRIC_AI_NOTICE}</p>
        {error ? (
          <p className="rm-error rm-dob-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="rm-actions">
          <button type="submit" className="rm-primary" disabled={busy || !dob}>
            {busy ? 'Checking…' : 'Continue'}
          </button>
          <button type="button" className="rm-quiet" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
