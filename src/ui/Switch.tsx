import { useCallback, useEffect, useRef, useState, type Ref } from 'react';
import './switch.css';

/**
 * A one-click on/off switch (role="switch"): a native button, so Space and Enter toggle it, with a
 * 44px hit area and a focus ring. `disabledReason` disables it and explains why in a tooltip.
 */
export function Switch({
  checked,
  label,
  onChange,
  busy = false,
  disabledReason,
  showLabel = true,
  buttonRef,
  describedBy,
}: {
  checked: boolean;
  label: string;
  onChange: (next: boolean) => void;
  busy?: boolean;
  /** When set, the switch is disabled and this is its tooltip. */
  disabledReason?: string | null;
  /** False: the label is for screen readers only (the context names it). */
  showLabel?: boolean;
  /** The button itself (e.g. to give focus back to it). */
  buttonRef?: Ref<HTMLButtonElement>;
  /** The id of a short hint read after the switch (aria-describedby). */
  describedBy?: string;
}) {
  // While a change runs the switch stays focusable (a disabled button would drop keyboard
  // focus) but ignores presses (click, Space, Enter); the thumb dims and pulses meanwhile.
  const disabled = Boolean(disabledReason);
  return (
    <button
      type="button"
      role="switch"
      className="cc-switch"
      aria-checked={checked}
      aria-label={showLabel ? undefined : label}
      aria-busy={busy || undefined}
      aria-describedby={describedBy}
      ref={buttonRef}
      disabled={disabled}
      title={disabledReason ?? undefined}
      onClick={() => {
        if (!busy) onChange(!checked);
      }}
    >
      {showLabel ? <span className="cc-switch-label">{label}</span> : null}
      <span className="cc-switch-track" aria-hidden="true">
        <span className="cc-switch-thumb" />
      </span>
      {/* The state in words too (not only the colour); aria-checked carries it for readers. */}
      <span className="cc-switch-state" aria-hidden="true">
        {checked ? 'On' : 'Off'}
      </span>
    </button>
  );
}

/**
 * A switch that shows only the confirmed value: `set` marks the switch busy (aria-busy) and runs
 * `commit`; the shown value changes only once `commit` resolves, so the switch never says Off
 * (or On) before the server does. A failure keeps the confirmed value and shows an error toast
 * (no toast for an error marked `silent`). Presses while a change runs are ignored, so a second
 * tap never quietly asks for the opposite value. The shown value follows `value` when `value`
 * changes and no change is running.
 */
export function useOptimisticSwitch(
  value: boolean,
  commit: (next: boolean) => Promise<void>,
  failure: (next: boolean) => string,
) {
  const [shown, setShown] = useState(value);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const running = useRef(false);
  const latestCommit = useRef(commit);
  latestCommit.current = commit;
  useEffect(() => {
    if (!running.current) setShown(value);
  }, [value]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);
  const set = useCallback(
    async (next: boolean) => {
      if (running.current) return;
      running.current = true;
      setBusy(true);
      setToast('');
      try {
        await latestCommit.current(next);
        setShown(next);
      } catch (error) {
        setShown(!next);
        // A `silent` rejection hands over to another flow (a dialog) without an error.
        if (!(error as { silent?: boolean } | null)?.silent) setToast(failure(next));
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
    [failure],
  );
  return { shown, busy, toast, set, dismiss: () => setToast('') };
}

/** The error toast for a switch (the global .toast styles). */
export function SwitchToast({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  if (!text) return null;
  return (
    <div className="toast-region" aria-live="assertive" aria-atomic="true">
      <div className="toast" role="alert">
        <span>{text}</span>
        <button type="button" className="cc-switch-toast-close" onClick={onDismiss}>
          OK
        </button>
      </div>
    </div>
  );
}
