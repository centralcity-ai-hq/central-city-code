import { useCallback, type ReactElement } from 'react';
import { Plus } from 'lucide-react';
import { SwitchToast, useOptimisticSwitch } from '../../ui/Switch';
import { ElricSetupSwitch, type ElricDobOutcome, type ElricSetupStep } from './ElricSetupSwitch';

/**
 * Whether the room header shows the Elric switch at all. Only the room's host sees it, and never
 * someone under 18: for them it is left out of the page entirely (not shown disabled).
 */
export function showHeaderElricSwitch({
  host,
  eligibilityReason,
}: {
  host: boolean;
  eligibilityReason?: string | null;
}): boolean {
  return host && eligibilityReason !== 'age_under_18';
}

export interface ElricHeaderSwitchProps {
  /** Elric is a member of the room. */
  on: boolean;
  disabledReason: string | null;
  /** Adds (true) or removes (false) Elric; rejects to roll the switch back. */
  change: (next: boolean) => Promise<void>;
  /**
   * Set when Elric was never added (no Elric yet for this account): while off, a "+ Add Elric"
   * button shows instead of the switch and calls this (it asks the date of birth if needed).
   */
  onAdd?: (() => void) | null;
  /**
   * A step the host still needs (no Google link, or no date of birth): the switch opens a small
   * popover with that step instead of being disabled.
   */
  setup?: ElricSetupStep | null;
  /** The date of birth submit for the popover (adds Elric when it passes). */
  onDob?: ((dateOfBirth: string) => Promise<ElricDobOutcome>) | null;
  /** The add started by `onAdd` is running. */
  adding?: boolean;
}

/**
 * The host's Elric switch in the room header. On adds Elric straight away (the date of birth is
 * asked only the first time, by the caller). Off removes it straight away too.
 */
export function ElricHeaderSwitch({
  on,
  disabledReason,
  change,
  onAdd = null,
  adding = false,
  setup = null,
  onDob = null,
}: ElricHeaderSwitchProps): ReactElement {
  const failure = useCallback(
    (next: boolean) =>
      next ? 'Elric couldn’t join this room. Try again.' : 'Elric couldn’t be removed. Try again.',
    [],
  );
  const toggle = useOptimisticSwitch(on, change, failure);
  // No Google link: nothing to add yet, so the switch itself explains the step.
  if (setup !== 'google' && onAdd && !on && !toggle.busy && !disabledReason) {
    return (
      <div className="rm-head-elric">
        <button
          type="button"
          className="rm-outline rm-head-btn rm-head-add-elric"
          aria-busy={adding || undefined}
          onClick={() => {
            if (!adding) onAdd();
          }}
        >
          <Plus size={16} aria-hidden="true" />
          {/* Narrow screens show "+ Elric"; the name stays "Add Elric". */}
          <span>
            <span className="rm-head-label">Add </span>Elric
          </span>
        </button>
      </div>
    );
  }
  return (
    <div className="rm-head-elric">
      <ElricSetupSwitch
        label="Elric"
        step={onDob ? setup : null}
        onDob={onDob ?? (async () => null)}
        checked={toggle.shown}
        busy={toggle.busy}
        disabledReason={disabledReason}
        onToggle={(next) => void toggle.set(next)}
      />
      <SwitchToast text={toggle.toast} onDismiss={toggle.dismiss} />
    </div>
  );
}
