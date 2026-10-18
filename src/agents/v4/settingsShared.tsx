import './settings-actions.css';
import { ChevronLeft } from 'lucide-react';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { selectedWorkspaceId } from '../../api';
import { READ_DEADLINE_MS, failure } from './messagesRoomsShared';
import { confirmed } from './settingsActionsModel';
import { SettingsLifecycle, loadOf, settingsView, type SettingsRead } from './settingsLifecycle';

/*
 * What the v4 settings screens share (docs/design/my-agents-v4-mockup.html): the lifecycle hook
 * every screen runs on, the pushed-screen frame on the agent pane's own classes (agent-pane.css,
 * ap4-*), the confirm box (type the agent's name, then the one button) and the switch.
 */

/**
 * The screen's lifecycle (settingsLifecycle.ts) for this agent in the workspace selected now.
 * Another agent or workspace, and closing the screen, start a new generation: what was shown is
 * dropped and late answers of the old one never land. `reads` must be a module constant.
 */
export function useSettingsLifecycle(
  agentId: string,
  reads: Readonly<Record<string, SettingsRead>>,
  describe: (error: unknown) => string = failure,
) {
  const workspace = selectedWorkspaceId();
  const [controller] = useState(
    () => new SettingsLifecycle({ reads, describe, deadlineMs: READ_DEADLINE_MS }),
  );
  // Bound before paint and before any handler can run, so every request is for this pair.
  useLayoutEffect(() => {
    controller.bind(agentId, workspace);
  }, [controller, agentId, workspace]);
  useLayoutEffect(() => () => controller.close(), [controller]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  // Until the bind above has run for this pair, nothing of another pair is shown.
  const view = settingsView(state, agentId, workspace);
  return {
    controller,
    view,
    load: <T,>(name: string) => loadOf<T>(view, name),
  };
}

/**
 * Marks every Escape as handled (defaultPrevented) before anything else sees it, until the returned
 * cleanup runs. The pane and the page leave a handled Escape alone, so neither goes back nor
 * closes while a screen must stay open (e.g. a new key is on its way).
 */
export function holdEscape(target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>) {
  const hold = (event: Event) => {
    if ((event as Event & { key?: string }).key === 'Escape') event.preventDefault();
  };
  target.addEventListener('keydown', hold, { capture: true });
  return () => target.removeEventListener('keydown', hold, { capture: true });
}

/** A pushed screen of the agent pane: back link, title, an optional line, the body, the toast. */
export function SettingsFrame({
  backLabel,
  onBack,
  backDisabled = false,
  title,
  sub,
  notice,
  children,
}: {
  backLabel: string;
  onBack: () => void;
  /** Back can't be used right now (a signature is being sent). */
  backDisabled?: boolean;
  title: string;
  sub?: string;
  notice?: string;
  children: ReactNode;
}) {
  // While Back is disabled, Escape does not go back or close the pane either.
  useEffect(() => (backDisabled ? holdEscape(window) : undefined), [backDisabled]);
  return (
    <div className="ap4-wrap">
      <button type="button" className="ap4-back" onClick={onBack} disabled={backDisabled}>
        <ChevronLeft className="v4s-i" aria-hidden="true" />
        {backLabel}
      </button>
      <h3 className="ap4-title">{title}</h3>
      {sub ? <p className="ap4-note">{sub}</p> : null}
      {children}
      {notice ? (
        <div className="v4s-toast" role="status">
          {notice}
        </div>
      ) : null}
    </div>
  );
}

/** While a read is in flight: one quiet row (every read has a deadline, so it always ends). */
export function SettingsLoading() {
  return (
    <div className="ap4-group" role="status" aria-label="Loading">
      <div className="ap4-row v4s-still">
        <span className="v4s-spin" />
      </div>
    </div>
  );
}

/** A failed read: one line and a retry. */
export function SettingsError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <p className="ap4-note v4s-err" role="alert">
      {message}{' '}
      <button type="button" className="v4s-quiet" onClick={onRetry}>
        Try again
      </button>
    </p>
  );
}

/** An empty state: one bold line and one quiet line. */
export function SettingsEmpty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="v4s-empty">
      <b>{title}</b>
      <span>{children}</span>
    </div>
  );
}

/**
 * The mockup's one confirm pattern: a field "Type <name> to confirm" that takes focus, and a
 * full-width button that stays disabled until the name matches. Enter confirms once it matches;
 * Escape cancels (back to the previous screen). What was typed lives in the screen's lifecycle,
 * so it is cleared with every other agent or workspace, also when two agents share a name.
 */
export function ConfirmBox({
  name,
  typed,
  onTyped,
  label,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  name: string;
  typed: string;
  onTyped: (text: string) => void;
  label: string;
  busy: boolean;
  error: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const field = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const ok = confirmed(typed, name);
  // Focus starts in the field, and returns there when a request fails (the field was disabled).
  useEffect(() => {
    if (!busy) field.current?.focus();
  }, [busy, error]);
  function keys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) onCancel();
    } else if (event.key === 'Enter' && event.target === field.current) {
      event.preventDefault();
      if (ok && !busy) onConfirm();
    }
  }
  return (
    <div className="ap4-form" onKeyDown={keys}>
      <input
        ref={field}
        className="ap4-field"
        placeholder={`Type ${name} to confirm`}
        aria-label="Type the agent name to confirm"
        aria-describedby={error ? errorId : undefined}
        autoComplete="off"
        spellCheck={false}
        value={typed}
        disabled={busy}
        onChange={(event) => onTyped(event.target.value)}
      />
      <button
        type="button"
        className="ap4-btn v4s-wide"
        disabled={!ok || busy}
        aria-busy={busy || undefined}
        onClick={onConfirm}
      >
        {busy ? <span className="v4s-spin v4s-spin-on" aria-hidden="true" /> : null}
        {label}
      </button>
      {error ? (
        <p id={errorId} className="ap4-note v4s-err" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The mockup's switch: a 36 × 21 track, green when on, with a full-size tap area. */
export function Toggle({
  checked,
  label,
  disabled,
  onChange,
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="v4s-toggle"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}
