import { useSyncExternalStore } from 'react';
import type { PostedFeedRequest, PublicFeedRequest } from '../../shared/feed';
import { onFeedForget } from './feedPaths';

/*
 * Requests posted from this page load, with the private token that closes each one. Memory only:
 * never stored, never in an address; a reload forgets them, and so does signing out (Root calls
 * feedPaths forgetFeedSession), so they never reach the next account in this tab. The posting
 * account can still close its requests while signed in, and the private link keeps working.
 */

export interface MineEntry {
  request: PublicFeedRequest;
  manageToken: string;
}

let mine: readonly MineEntry[] = [];
const listeners = new Set<() => void>();

function set(next: readonly MineEntry[]) {
  mine = next;
  for (const listener of listeners) listener();
}

export function addMine(posted: PostedFeedRequest) {
  set([
    { request: posted.request, manageToken: posted.manageToken },
    ...mine.filter((entry) => entry.request.id !== posted.request.id),
  ]);
}

/** A request of this page load was closed: it leaves the list of yours. */
export function dropMine(id: string) {
  set(mine.filter((entry) => entry.request.id !== id));
}

export function mineEntry(id: string): MineEntry | null {
  return mine.find((entry) => entry.request.id === id) ?? null;
}

/** Forget this page load's requests (sign-out; tests). */
export function resetMine() {
  if (mine.length) set([]);
}

onFeedForget(resetMine);

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMine(): readonly MineEntry[] {
  return useSyncExternalStore(
    subscribe,
    () => mine,
    () => mine,
  );
}
