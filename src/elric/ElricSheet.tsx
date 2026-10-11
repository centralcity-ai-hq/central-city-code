import { useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useDialogFocus } from '../rooms/useDialogFocus';

/**
 * A Workspace v3 sheet on the Elric page (WORKSPACE_V3.md §4.6): a centered card (22px radius)
 * over a scrim, a title and a round close. The rooms' keyboard contract (useDialogFocus): focus
 * moves in (a field with autoFocus keeps it), Tab stays inside, Escape or the scrim closes it, and
 * focus goes back to the control that opened it.
 */
export function ElricSheet({
  title,
  onClose,
  children,
  className = '',
  role = 'dialog',
  returnFocusTo,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  role?: 'dialog' | 'alertdialog';
  /** Where focus goes on close when the opener is gone (a menu item whose menu closed). */
  returnFocusTo?: () => HTMLElement | null | undefined;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const id = useId();
  useDialogFocus(sheet, onClose, returnFocusTo ? { returnFocusTo } : {});
  return (
    <div
      className="elx3-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={sheet}
        className={`elx3-sheet${className ? ` ${className}` : ''}`}
        role={role}
        aria-modal="true"
        aria-labelledby={`${id}-title`}
      >
        <div className="elx3-sheet-head">
          <h2 id={`${id}-title`}>{title}</h2>
          <button type="button" className="elx3-x" aria-label="Close" onClick={onClose}>
            <X size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
