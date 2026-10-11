import type { ReactNode } from 'react';
import { X } from 'lucide-react';

/*
 * Workspace v3 (docs/design/WORKSPACE_V3.md §4.5, §4.6): the shared parts of the room's side
 * panels (Tasks, Members, Search) and sheets (New room, Join a room, Invite, Room settings).
 * Styles: rooms-v3-panels.css.
 */

/** A panel or sheet header: the title (and anything beside it) and a round close button. */
export function PanelHead({
  closeLabel,
  onClose,
  children,
  className = '',
}: {
  /** The close button's name ("Close tasks"). */
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rm-v3-head${className ? ` ${className}` : ''}`}>
      <div className="rm-v3-head-titles">{children}</div>
      <button type="button" className="rm-v3-close" aria-label={closeLabel} onClick={onClose}>
        <X size={16} strokeWidth={2.2} aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * An on/off row: the label on the left and a switch on the right. The control is a native
 * checkbox drawn as a switch, so labels, Space, forms and assistive tech work as before.
 */
export function SwitchRow({
  label,
  checked,
  onChange,
  disabled = false,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** A short line under the label. */
  hint?: ReactNode;
}) {
  return (
    <label className="rm-v3-switch-row">
      <span className="rm-v3-switch-text">
        <span>{label}</span>
        {hint ? <span className="rm-v3-switch-hint">{hint}</span> : null}
      </span>
      <input
        type="checkbox"
        className="rm-v3-switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}
