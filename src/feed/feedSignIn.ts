import { useSyncExternalStore } from 'react';
import type { SignInContext } from '../Auth';
import { feedRoute } from './feedPaths';

/*
 * Signed out, the Feed is read-only (src/Root.tsx): services and requests can be browsed and
 * opened, and every action (Respond, Report, Post a request) is "Sign in to …". That button asks
 * for sign-in at the same address, as its own history entry (Back returns to the page as it
 * was). Once signed in, that entry is left for the one the action came from (leaveFeedSignIn):
 * the page shows as it was, signed in, and the person chooses the action again (nothing reopens
 * it by itself). The card names the action and the tab. Pure and tiny, like feedPaths.ts: Root
 * imports it, so it stays out of the Feed's chunk.
 */

/** The tab's title on every Feed address before the page names it (the /feed share card's too). */
export const FEED_TITLE = 'Feed · Central City';

export type FeedSignInAction = 'respond' | 'report' | 'post' | 'use';

const ACTIONS: readonly FeedSignInAction[] = ['respond', 'report', 'post', 'use'];

/** Where the action rides: the history entry's state, so a reload or Back keeps or drops it. */
const KEY = 'feedSignIn';

/** The words on the button that asks for it. */
export const SIGN_IN_LABEL: Record<FeedSignInAction, string> = {
  respond: 'Sign in to respond',
  report: 'Sign in to report',
  post: 'Sign in to post',
  use: 'Sign in to use it',
};

const LINES: Record<FeedSignInAction, string> = {
  respond: 'Sign in to respond to this request.',
  report: 'Sign in to report this request.',
  post: 'Sign in or create a free account to post your request.',
  use: 'Sign in to use this service with your agent.',
};

/** The action a history entry asked sign-in for, if any. */
export function signInActionOf(state: unknown): FeedSignInAction | null {
  if (!state || typeof state !== 'object') return null;
  const action = (state as Record<string, unknown>)[KEY];
  return ACTIONS.find((each) => each === action) ?? null;
}

/** Signed out, an action's button: sign-in at this same address, as a new history entry. */
export function askFeedSignIn(action: FeedSignInAction): void {
  const state: unknown = window.history.state;
  const base = state && typeof state === 'object' ? (state as Record<string, unknown>) : {};
  window.history.pushState(
    { ...base, [KEY]: action },
    '',
    `${window.location.pathname}${window.location.search}`,
  );
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo(0, 0);
}

/**
 * A session that lapsed while the page still shows it signed in (a Feed pay route answered 401):
 * the action is asked for as askFeedSignIn does, then the page loads again, so Root reads the
 * session afresh and shows the sign-in card for it at this same address.
 */
export function askFeedSignInAgain(action: FeedSignInAction): void {
  askFeedSignIn(action);
  window.location.reload();
}

/**
 * Signed in from the card an action asked for: Back to the entry the action came from (the same
 * address, the page as it was). The sign-in entry would otherwise stay behind the page as a copy
 * of it, and Close or Back (a drawer's Close is Back) would land on that copy and look dead. The
 * entry no longer asks for sign-in first, so Forward to it, or a tab with no entry before it,
 * shows the page.
 */
export function leaveFeedSignIn(): void {
  const state: unknown = window.history.state;
  if (!signInActionOf(state)) return;
  const { [KEY]: _action, ...rest } = state as Record<string, unknown>;
  window.history.replaceState(rest, '', `${window.location.pathname}${window.location.search}`);
  window.history.back();
}

function subscribe(listener: () => void) {
  window.addEventListener('popstate', listener);
  return () => window.removeEventListener('popstate', listener);
}

/** The action this history entry asks sign-in for, live (popstate: the button, Back, Forward). */
export function useFeedSignInAction(): FeedSignInAction | null {
  return useSyncExternalStore(
    subscribe,
    () => signInActionOf(window.history.state),
    () => null,
  );
}

/**
 * The sign-in card's words on a Feed address: the action asked for, or, on a page that needs an
 * account to read (a request's private page without its code, a paid call's page), that page.
 */
export function feedSignInContext(
  pathname: string,
  action: FeedSignInAction | null = null,
): SignInContext | null {
  const route = feedRoute(pathname);
  if (!route) return null;
  if (route.view === 'manage') return { line: 'Sign in to close your request.', title: FEED_TITLE };
  if (route.view === 'call') return { line: 'Sign in to see this call.', title: FEED_TITLE };
  return {
    line: action ? LINES[action] : 'Sign in or create a free account to use the Feed.',
    title: FEED_TITLE,
  };
}
