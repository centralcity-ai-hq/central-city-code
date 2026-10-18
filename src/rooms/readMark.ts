/**
 * When an open room counts as read (RoomView onRead: the device mark and POST /read, which also
 * clears the room's @mentions). Only while the person can see the newest message: the tab is
 * visible and the list follows the bottom. A message that arrives in a background tab, or while
 * the reader is scrolled up, stays unread until they come back to it.
 */
export function shouldMarkRead(state: {
  newest: number;
  visible: boolean;
  atBottom: boolean;
}): boolean {
  return state.newest > 0 && state.visible && state.atBottom;
}

/** Whether the page is showing (no document, as in tests, counts as visible). */
export function pageVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}
