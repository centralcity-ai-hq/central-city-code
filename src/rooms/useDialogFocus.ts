import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [href], [tabindex="0"]';

/** A control inside a closed <details> (other than its own summary) cannot take focus. */
function reachable(element: HTMLElement) {
  const closed = element.closest('details:not([open])');
  if (!closed) return true;
  return (
    element.tagName === 'SUMMARY' &&
    element.parentElement === closed &&
    !closed.parentElement?.closest('details:not([open])')
  );
}

/**
 * A modal sheet's keyboard contract: Tab and Shift+Tab stay inside the dialog, Escape closes it
 * wherever focus is, and on close focus goes back to the control that opened it. Focus moves in
 * only when nothing inside has it yet (a field with autoFocus keeps it).
 *
 * The returnFocusTo option is the fallback for when the opener is gone by the time the dialog
 * closes (a menu item whose menu closed when the dialog opened): it is asked at close for the
 * control that should take focus instead (for example the menu's own button).
 */
export function useDialogFocus(
  dialog: RefObject<HTMLElement | null>,
  onClose: () => void,
  options: { returnFocusTo?: () => HTMLElement | null | undefined } = {},
) {
  const close = useRef(onClose);
  close.current = onClose;
  const fallback = useRef(options.returnFocusTo);
  fallback.current = options.returnFocusTo;
  // The opener, read during the first render: autoFocus has moved focus by the time effects run.
  const opener = useRef(document.activeElement as HTMLElement | null);
  useEffect(() => {
    const element = dialog.current;
    const previous = opener.current;
    if (element && !element.contains(document.activeElement))
      element.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close.current();
        return;
      }
      if (event.key !== 'Tab' || !element) return;
      const focusable = [...element.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(reachable);
      const first = focusable[0];
      const last = focusable.at(-1);
      const inside = element.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || !inside)) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !inside)) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', keys);
    return () => {
      document.removeEventListener('keydown', keys);
      if (previous?.isConnected && previous !== document.body) previous.focus();
      else fallback.current?.()?.focus();
    };
  }, [dialog]);
}
