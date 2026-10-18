import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from 'react';
import type { FeedStatus } from '../../shared/feed';
import { PublicFooter } from '../shell/PublicFooter';
import { PublicHeader } from '../shell/PublicHeader';
import { usePageTitle } from '../shell/usePageTitle';
import { readOfferedFilters, readRequestFilters } from './feedApi';
import { goTo, scrollFeedTop, useListBehind, useSearch } from './feedNav';
import { feedHref, feedRoute } from './feedPaths';
import { FEED_RECHECK_MS, loadFeedGate } from './feedStatus';
import { number } from './feedFormat';
import { FeedHead, FeedSignedIn, useLayout } from './FeedParts';
import { CallPage, ManagePage, RequestPage, ServicePage } from './DetailPages';
import { OfferedView } from './OfferedView';
import { RequestsView } from './RequestsView';
import './feed.css';
import './pay/pay.css';

/*
 * The Feed, a page of the signed-in workspace (the Feed mockup of 13 Oct, in the workspace shell):
 * Base services OFFERED (listed by x402 Bazaar, with its credit on every card) and requests
 * SEARCHED FOR. Behind CITY_FEED: until GET /api/public/feed answers 200 every Feed address is
 * the ordinary 404 page (src/Root.tsx) and the sidebar has no Feed entry. An external service is
 * never a Central City agent (no agent Pay, no Rate, no passport); while Feed pay is on for the
 * person, one of their own agents can pay a listed service from its own wallet ("Use with my
 * agent", src/feed/pay). The routes stay public for agents. Signed in, people post as their
 * account or as one of their agents; signed out, the page is read-only (PublicFeed), every action
 * asks for sign-in first, and a call's page (the owner's only) asks for it before it opens.
 */

type View = 'offered' | 'requests';

const VIEWS: Array<{ id: View; href: string; label: string }> = [
  { id: 'offered', href: feedHref.offered, label: 'Offered' },
  { id: 'requests', href: feedHref.requests, label: 'Searched for' },
];

/**
 * Offered | Searched for: two links (each view has its own address); arrow keys move between.
 * On a list the current view is the page; on a page for one service or request, its view is
 * only the current section.
 */
function FeedSwitch({
  current,
  onList,
  counts,
}: {
  current: View;
  onList: boolean;
  counts: Record<View, number>;
}) {
  const open = (href: string) => {
    goTo(href);
    scrollFeedTop();
  };
  const onKey = (event: KeyboardEvent<HTMLAnchorElement>, index: number) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    // With a modifier the keys are the browser's (Alt+Left is Back).
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    const next = (index + (event.key === 'ArrowRight' ? 1 : VIEWS.length - 1)) % VIEWS.length;
    const href = VIEWS[next]!.href;
    open(href);
    // The other view draws its own bar: focus follows to the same link there.
    window.requestAnimationFrame(() =>
      document.querySelector<HTMLAnchorElement>(`.fd-switch a[href="${href}"]`)?.focus(),
    );
  };
  const onClick = (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    open(href);
  };
  return (
    <nav className="fd-switch" aria-label="Feed views">
      {VIEWS.map((view, index) => (
        <a
          key={view.id}
          href={view.href}
          aria-current={current === view.id ? (onList ? 'page' : 'true') : undefined}
          onClick={(event) => onClick(event, view.href)}
          onKeyDown={(event) => onKey(event, index)}
        >
          <span>{view.label}</span>
          <span className="n">
            <span className="visually-hidden">: </span>
            {number.format(counts[view.id])}
            <span className="visually-hidden">
              {view.id === 'offered' ? ' services' : ' open requests'}
            </span>
          </span>
        </a>
      ))}
    </nav>
  );
}

/** The query string of an Offered list address ("/feed?q=pdf"); null for any other address. */
function offeredList(list: string | null): string | null {
  if (!list) return null;
  const at = list.indexOf('?');
  if (feedRoute(at < 0 ? list : list.slice(0, at))?.view !== 'offered') return null;
  return at < 0 ? '' : list.slice(at);
}

/**
 * The query string of a Searched for list address ("/feed/requests?tag=pdf"); null for any other
 * address.
 */
function requestsList(list: string | null): string | null {
  if (!list) return null;
  const at = list.indexOf('?');
  if (feedRoute(at < 0 ? list : list.slice(0, at))?.view !== 'requests') return null;
  return at < 0 ? '' : list.slice(at);
}

/** The two lists name the tab; a page for one service or request names it itself. */
function ListTitle({ view }: { view: View }) {
  usePageTitle(view === 'offered' ? 'Feed · Central City' : 'Searched for · Feed · Central City');
  return null;
}

/**
 * Focus and in-page jumps stop below the sticky bar ("Your request is live" after posting, a card
 * that takes focus): its measured height, two rows on phones, as --fd-sticky-h on the page
 * (feed.css scroll-padding-top). Measured again whenever the bar changes size or is drawn anew.
 */
function useStickyPadding(
  page: RefObject<HTMLElement | null>,
  bar: string,
  windowScrolls: boolean,
) {
  useLayoutEffect(() => {
    const main = page.current;
    const toolbar = main?.querySelector<HTMLElement>('.fd-toolbar');
    if (!main || !toolbar) return;
    const row = toolbar.querySelector<HTMLElement>('.fd-tb-row1');
    const measure = () => {
      // On narrow pages only the first row sticks: the bar itself is display: contents there.
      const stuck = getComputedStyle(toolbar).display === 'contents' ? row : toolbar;
      const height = stuck ? stuck.getBoundingClientRect().height : 0;
      if (!stuck || height <= 0) return;
      // It sticks at its `top` (on the public pages, under their header); then a little room.
      const padding = `${Math.ceil((parseFloat(getComputedStyle(stuck).top) || 0) + height) + 12}px`;
      main.style.setProperty('--fd-sticky-h', padding);
      // Signed out the window scrolls, not the page.
      if (windowScrolls) document.documentElement.style.scrollPaddingTop = padding;
    };
    measure();
    const reset = () => {
      if (windowScrolls) document.documentElement.style.scrollPaddingTop = '';
    };
    if (typeof ResizeObserver === 'undefined') return reset;
    const observer = new ResizeObserver(measure);
    observer.observe(toolbar);
    if (row) observer.observe(row);
    return () => {
      observer.disconnect();
      reset();
    };
  }, [page, bar, windowScrolls]);
}

/**
 * The Feed page, once GET /api/public/feed answered 200 (Root's FeedRoute decides, and shows the
 * 404 page while the Feed is off). `status` is that answer: the counts on the view switch.
 */
export function Feed({
  path,
  status,
  signedIn = true,
}: {
  path: string;
  status: FeedStatus;
  /** Signed out: read-only (PublicFeed), every action asks for sign-in. */
  signedIn?: boolean;
}) {
  // Requests posted (+1) and closed (-1) from this page load, on top of the status's count.
  const [opened, setOpened] = useState(0);
  // The last whole, unfiltered Searched for list counted itself (with `opened` at that moment):
  // what the list shows wins over a status read at another moment (the two are cached apart).
  const [listCount, setListCount] = useState<{ count: number; opened: number } | null>(null);
  const openedNow = useRef(opened);
  openedNow.current = opened;
  const counted = useRef(false);
  counted.current = listCount !== null;
  const onListCount = useCallback((count: number | null) => {
    if (count !== null) setListCount({ count, opened: openedNow.current });
    // A list that can't count itself (filtered, or more pages): the status is read again, unless
    // it is recent or this page load changed the count itself (a re-read would count those twice).
    else if (!counted.current && openedNow.current === 0)
      void loadFeedGate({ maxAgeMs: FEED_RECHECK_MS });
  }, []);
  const search = useSearch();
  const behind = useListBehind();
  const page = useRef<HTMLElement>(null);
  const route = feedRoute(path) ?? { view: 'offered' as const };
  // A service opened from Offered: its address, with its drawer over the list it came from.
  const overSearch = route.view === 'service' ? offeredList(behind) : null;
  const over = route.view === 'service' && overSearch !== null ? route.id : null;
  // A request opened from Searched for: its address, with its drawer over the list it came from.
  const requestsOver = route.view === 'request' ? requestsList(behind) : null;
  const requestDrawer = route.view === 'request' && requestsOver !== null ? route.id : null;
  const view: View =
    route.view === 'offered' || route.view === 'service' || route.view === 'call'
      ? 'offered'
      : 'requests';
  const [layout, setLayout] = useLayout();
  const counts = {
    offered: status.services,
    requests: listCount
      ? Math.max(0, listCount.count + opened - listCount.opened)
      : Math.max(0, status.openRequests + opened),
  };
  const onList =
    route.view === 'offered' ||
    route.view === 'requests' ||
    over !== null ||
    requestDrawer !== null;
  const switcher = <FeedSwitch current={view} onList={onList} counts={counts} />;
  useStickyPadding(page, requestDrawer ? 'requests' : route.view, !signedIn);
  return (
    <FeedSignedIn.Provider value={signedIn}>
      <main
        id="main-content"
        tabIndex={-1}
        className={signedIn ? 'fd-page' : 'fd-page fd-public'}
        ref={page}
      >
        <div className="fd-wrap">
          <FeedHead />
          {route.view === 'offered' || over !== null ? (
            <>
              <ListTitle view="offered" />
              <OfferedView
                filters={readOfferedFilters(overSearch ?? search)}
                openId={over}
                switcher={switcher}
                layout={layout}
                onLayout={setLayout}
              />
            </>
          ) : route.view === 'requests' || requestDrawer ? (
            <>
              <ListTitle view="requests" />
              <RequestsView
                filters={readRequestFilters(requestsOver ?? search)}
                switcher={switcher}
                layout={layout}
                onLayout={setLayout}
                openCount={counts.requests}
                openId={requestDrawer}
                onListCount={onListCount}
                onPosted={() => setOpened((value) => value + 1)}
                onClosed={() => setOpened((value) => value - 1)}
              />
            </>
          ) : (
            <>
              <div className="fd-toolbar">
                <div className="fd-tb-row1">{switcher}</div>
              </div>
              {route.view === 'service' ? (
                <ServicePage key={route.id} id={route.id} />
              ) : route.view === 'call' ? (
                <CallPage key={route.id} id={route.id} />
              ) : route.view === 'request' ? (
                <RequestPage
                  key={route.id}
                  id={route.id}
                  onClosed={() => setOpened((value) => value - 1)}
                />
              ) : (
                <ManagePage
                  key={route.id}
                  id={route.id}
                  onClosed={() => setOpened((value) => value - 1)}
                />
              )}
            </>
          )}
        </div>
      </main>
    </FeedSignedIn.Provider>
  );
}

/**
 * Signed out, the Feed is read-only, between the public pages' header and footer: services and
 * requests can be browsed and opened; Respond, Report and Post a request ask for sign-in at the
 * same address (src/Root.tsx), where the Feed then opens signed in.
 */
export function PublicFeed({ path, status }: { path: string; status: FeedStatus }) {
  return (
    <div className="public-shell">
      <PublicHeader current="rooms" />
      <Feed path={path} status={status} signedIn={false} />
      <PublicFooter />
    </div>
  );
}

/**
 * Signed out, the private link's page (/feed/requests/<id>/manage#ccf_…) on the public pages'
 * header and footer: its code closes the request without an account, so no sign-in comes first.
 * Root shows it only while the code is held (feedPaths.ts signedOutManageId).
 */
export function SignedOutManage({ id }: { id: string }) {
  return (
    <FeedSignedIn.Provider value={false}>
      <div className="public-shell">
        <PublicHeader current="rooms" />
        <main id="main-content" tabIndex={-1} className="fd-page fd-public">
          <div className="fd-wrap">
            <FeedHead />
            <ManagePage key={id} id={id} />
          </div>
        </main>
        <PublicFooter />
      </div>
    </FeedSignedIn.Provider>
  );
}

export default Feed;
