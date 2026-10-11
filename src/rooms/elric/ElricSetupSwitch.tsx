import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
  type RefObject,
} from 'react';
import { ELRIC_AI_NOTICE } from '../../../shared/elric-copy';
import { Switch } from '../../ui/Switch';

/** The step a host still needs before Elric can join: a linked Google account, or the age. */
export type ElricSetupStep = 'google' | 'dob';

/**
 * What the caller's date of birth submit ended with: null (done, Elric is in the room),
 * 'closed' (another dialog takes over, e.g. under 18), or an error to show under the field.
 */
export type ElricDobOutcome = null | 'closed' | { error: string };

export interface ElricSetupSwitchProps {
  label: string;
  /** The missing step, or null: then it is the plain one-click switch. */
  step: ElricSetupStep | null;
  /** Saves the date of birth and adds Elric (the room's existing add flow). */
  onDob: (dateOfBirth: string) => Promise<ElricDobOutcome>;
  checked: boolean;
  busy?: boolean;
  disabledReason?: string | null;
  /** The plain switch's change (only without a missing step). */
  onToggle: (next: boolean) => void;
}

const HINT: Record<ElricSetupStep, string> = {
  google: 'Needs a linked Google account.',
  dob: 'Needs your date of birth.',
};

/**
 * The host's Elric switch. While one step is missing it looks and focuses like the switch (off),
 * and a click, Enter or Space opens a small popover that says why and offers the step: Link
 * Google, or the date of birth right there (saved with the existing add flow, which then adds
 * Elric). Escape, Not now or a click outside closes it and focus goes back to the switch; Tab
 * stays inside while it is open. Without a missing step it is the plain one-click switch; the
 * same button stays in place across the change, so focus stays on it.
 */
export function ElricSetupSwitch({
  label,
  step,
  onDob,
  checked,
  busy = false,
  disabledReason = null,
  onToggle,
}: ElricSetupSwitchProps): ReactElement {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const pending = step && !checked ? step : null;
  useEffect(() => {
    if (!pending) setOpen(false);
  }, [pending]);
  return (
    <div className="rm-elric-setup">
      <Switch
        label={label}
        checked={pending ? false : checked}
        busy={pending ? false : busy}
        disabledReason={pending ? null : disabledReason}
        buttonRef={trigger}
        {...(pending ? { describedBy: `${id}-hint` } : {})}
        onChange={(next) => (pending ? setOpen((value) => !value) : onToggle(next))}
      />
      {pending ? (
        <span id={`${id}-hint`} className="visually-hidden">
          {HINT[pending]}
        </span>
      ) : null}
      {open && pending ? (
        <SetupPopover
          id={id}
          step={pending}
          onDob={onDob}
          trigger={trigger}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

function SetupPopover({
  id,
  step,
  onDob,
  trigger,
  onClose,
}: {
  id: string;
  step: ElricSetupStep;
  onDob: ElricSetupSwitchProps['onDob'];
  trigger: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [dob, setDob] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const element = box.current;
    element?.querySelector<HTMLElement>('input, a[href], button')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close.current();
        return;
      }
      if (event.key !== 'Tab' || !element) return;
      const items = [
        ...element.querySelectorAll<HTMLElement>(
          'input:not(:disabled), a[href], button:not(:disabled)',
        ),
      ];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const inside = element.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
    };
    // A press outside closes it (the switch itself toggles it, so it is not "outside").
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!element?.contains(target) && !trigger.current?.contains(target)) close.current();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
      trigger.current?.focus();
    };
  }, [trigger]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!dob || busy) return;
    setBusy(true);
    setError('');
    const outcome = await onDob(dob);
    if (outcome === null || outcome === 'closed') {
      close.current();
      return;
    }
    setError(outcome.error);
    setBusy(false);
  }

  const title = `${id}-title`;
  return (
    <div
      ref={box}
      className="rm-elric-popover"
      role="dialog"
      aria-modal="true"
      aria-labelledby={title}
      aria-describedby={`${id}-why`}
      data-testid="elric-setup-popover"
    >
      {step === 'google' ? (
        <>
          <h2 id={title} className="rm-elric-popover-title">
            Link Google to use Elric
          </h2>
          <p id={`${id}-why`} className="rm-muted">
            Elric needs a linked Google account and is for adults 18+.
          </p>
          <div className="rm-actions">
            <a className="rm-primary rm-elric-popover-link" href="/settings/account">
              Link Google
            </a>
            <button type="button" className="rm-quiet" onClick={() => close.current()}>
              Not now
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          <h2 id={title} className="rm-elric-popover-title">
            Confirm your age
          </h2>
          <p id={`${id}-why`} className="rm-muted">
            Elric is for adults 18+. Enter your date of birth once.
          </p>
          <input
            type="date"
            className="rm-input"
            required
            aria-label="Date of birth"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            value={dob}
            disabled={busy}
            onChange={(event) => setDob(event.target.value)}
          />
          <p className="rm-dob-note">Used to confirm you're 18+.</p>
          <p className="rm-muted rm-dob-disclosure">{ELRIC_AI_NOTICE}</p>
          {error ? (
            <p id={`${id}-error`} className="rm-dob-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="rm-actions">
            <button type="submit" className="rm-primary" disabled={busy || !dob}>
              {busy ? 'Checking…' : 'Continue'}
            </button>
            <button
              type="button"
              className="rm-quiet"
              disabled={busy}
              onClick={() => close.current()}
            >
              Not now
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
