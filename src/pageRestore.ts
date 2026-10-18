/**
 * Runs `reset` whenever the browser shows this page again from its back/forward cache (the
 * `pageshow` event with `persisted`), e.g. after Back from Google. Such a page comes back with its
 * React state as it was when it left, so a button that was busy before leaving would stay busy.
 * Returns the cleanup.
 */
export function onPageRestore(
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  reset: () => void,
) {
  const listener = (event: Event) => {
    if ((event as Event & { persisted?: boolean }).persisted) reset();
  };
  target.addEventListener('pageshow', listener);
  return () => target.removeEventListener('pageshow', listener);
}
