import { useSyncExternalStore, type MouseEvent } from 'react';
import { navigate } from '../shell/navigation';
import { markInAppChange } from '../shell/pageNavigation';

/*
 * Moving around the Feed without a reload. The address changes and Root follows (popstate),
 * so the workspace shell stays. Filters live in the query string; nothing secret ever does.
 */

function subscribe(listener: () => void) {
  window.addEventListener('popstate', listener);
  return () => window.removeEventListener('popstate', listener);
}

/** The address bar's query string, live (popstate: Back, Forward and goTo). */
export function useSearch(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.search,
    () => '',
  );
}

/** The Feed page's own scroller (the workspace page area scrolls inside it). */
export function feedScroller(): HTMLElement | null {
  return document.getElementById('main-content');
}

/**
 * Back to the top of the Feed: its own scroller in the workspace, the window on the public pages
 * (signed out, the page is as long as its content and the window scrolls).
 */
export function scrollFeedTop() {
  feedScroller()?.scrollTo(0, 0);
  window.scrollTo(0, 0);
}

/**
 * A Feed address: `replace` for filter changes; `top` scrolls the page up and moves focus to it,
 * as a page change does. A filter change is the list's own entry: one that lands on a drawer's
 * entry (a search whose typing pause ended as a drawer opened) drops the list the drawer covered,
 * so the entry never reads as a drawer at a list's address.
 */
export function goTo(url: string, options: { replace?: boolean; top?: boolean } = {}) {
  if (options.replace) {
    const state: unknown = window.history.state;
    if (listBehind(state)) {
      const { [LIST_KEY]: _list, ...rest } = state as Record<string, unknown>;
      window.history.replaceState(rest, '', url);
    } else window.history.replaceState(state, '', url);
  } else window.history.pushState(null, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
  if (options.top) {
    scrollFeedTop();
    feedScroller()?.focus({ preventScroll: true });
  }
}

/*
 * A drawer over a list is its own history entry, at the address of what it shows
 * (/feed/services/<id>): Back, a phone's too, closes it, and the address bar can be shared. The
 * entry keeps the list's address, so the list stays as it was underneath. A reload keeps it too;
 * a link opened anew has none, and shows the thing's own page.
 */
const LIST_KEY = 'feedList';

const stateOf = (): Record<string, unknown> => {
  const state: unknown = window.history.state;
  return state && typeof state === 'object' ? { ...(state as Record<string, unknown>) } : {};
};

/** The Feed list a drawer entry covers ("/feed?q=pdf"); null for any other entry. */
export function listBehind(state: unknown): string | null {
  if (!state || typeof state !== 'object') return null;
  const list = (state as Record<string, unknown>)[LIST_KEY];
  return typeof list === 'string' && /^\/feed(?:[/?]|$)/.test(list) ? list : null;
}

/** Whether a drawer entry is the current one (a drawer is open over a list). */
export const drawerOpen = () => listBehind(window.history.state) !== null;

/** The list the current entry's drawer covers, live (popstate). */
export function useListBehind(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => listBehind(window.history.state),
    () => null,
  );
}

/** Opens `url` (one service's address) as a drawer entry over the list shown now. */
export function openOverList(url: string) {
  const state = stateOf();
  const list = listBehind(state) ?? `${window.location.pathname}${window.location.search}`;
  // Already over a list (it can't be clicked then, but never stack two): this entry moves.
  if (listBehind(state)) window.history.replaceState({ ...state, [LIST_KEY]: list }, '', url);
  else window.history.pushState({ ...state, [LIST_KEY]: list }, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

let leaving = false;

/** Closes the drawer entry: Back, to the list it covers (once, however often it is asked). */
export function closeOverList() {
  const list = listBehind(window.history.state);
  if (!list || leaving) return;
  leaving = true;
  const done = () => {
    leaving = false;
    window.clearTimeout(timer);
  };
  window.addEventListener('popstate', done, { once: true });
  // No entry to go back to (the tab opened on this one): the list takes this entry's place.
  const timer = window.setTimeout(() => {
    window.removeEventListener('popstate', done);
    leaving = false;
    if (listBehind(window.history.state) === list) leaveOverList(list);
  }, 1000);
  window.history.back();
}

/**
 * The drawer entry becomes an ordinary one, at `url` (default: its own address, whose page then
 * shows). Back still returns to the list it covered.
 */
export function leaveOverList(url = `${window.location.pathname}${window.location.search}`) {
  const { [LIST_KEY]: _list, ...rest } = stateOf();
  window.history.replaceState(rest, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

const plainClick = (event: MouseEvent<HTMLAnchorElement>) =>
  !event.defaultPrevented &&
  event.button === 0 &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey;

/** For an <a href> inside the Feed: a plain click stays in the page; modified clicks are the browser's. */
export function feedClick(url: string, options: { replace?: boolean; top?: boolean } = {}) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (!plainClick(event)) return;
    event.preventDefault();
    goTo(url, options);
  };
}

/**
 * For an <a href> to another workspace page (Rooms): the shell stays, as from the sidebar.
 * `state` rides in the new history entry (what Rooms opens with, sidebarRooms.ts).
 */
export function workspaceClick(url: string, state?: Record<string, unknown>) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (!plainClick(event)) return;
    event.preventDefault();
    markInAppChange();
    if (!state) return navigate(url);
    window.history.pushState(state, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  };
}

/*
 * "Post it as a request" from Offered: the search words travel to the form in memory, never in
 * the address.
 */
let composeTitle: string | null = null;

export function composeFrom(title: string) {
  composeTitle = title;
}

/** The title Offered handed over; null when the form was not asked for from there. */
export function peekCompose(): string | null {
  return composeTitle;
}

/** Called once the form has opened with it, so a later visit starts without it. */
export function clearCompose() {
  composeTitle = null;
}
