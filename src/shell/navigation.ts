import { useSyncExternalStore } from 'react';
import { LINKS } from './links';

/*
 * Path navigation for the app shell. RoomsApp (src/rooms) moves inside /rooms with
 * history.pushState and follows popstate; the shell does the same, so both stay in step: every
 * shell navigation pushes (or replaces) the entry and then announces it with a popstate event.
 */
export function navigate(path: string, replace = false) {
  if (replace) window.history.replaceState(null, '', path);
  else window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/*
 * A short note that outlives a page change, for the console's toast on the next page ("Chat
 * deleted." once a deleted chat's page is gone). Memory only: the console shows it once.
 */
let nextPageNote = '';
export function noteForNextPage(text: string) {
  nextPageNote = text;
}
export function takeNextPageNote(): string {
  const text = nextPageNote;
  nextPageNote = '';
  return text;
}

/** Room pages: /rooms, /rooms/:id and the join page /r/:slug (shared/routes.ts). */
export function isRoomsPath(pathname: string) {
  return /^\/(?:rooms(?:\/[A-Za-z0-9_-]{1,64})?|r\/[A-Za-z0-9_-]{1,64})\/?$/.test(pathname);
}

/** Signed-in "Invite your AI": the rooms page opens the Invite sheet for the person's room. */
export const INVITE_ROOMS_PATH = '/rooms#invite';

let signedIn = false;
const listeners = new Set<() => void>();

/** Set by App once the session answers, so public pages can pick the signed-in destinations. */
export function setSignedIn(value: boolean) {
  if (value === signedIn) return;
  signedIn = value;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Where "Invite your AI" goes: the first-run Connect page, or the person's room when signed in. */
export function useInviteHref() {
  return useSyncExternalStore(
    subscribe,
    () => (signedIn ? INVITE_ROOMS_PATH : LINKS.invite),
    () => LINKS.invite,
  );
}
