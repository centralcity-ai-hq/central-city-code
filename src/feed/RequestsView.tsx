import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Info, LoaderCircle, Plus, RefreshCw, Search, X } from 'lucide-react';
import {
  FEED_LIMITS,
  type FeedRequestPage,
  type PostedFeedRequest,
  type PublicFeedRequest,
} from '../../shared/feed';
import { assignAvatarColors } from '../shell/avatarColor';
import { usePageTitle } from '../shell/usePageTitle';
import {
  alreadyClosed,
  closeRequest,
  feedErrorCopy,
  FeedFailure,
  getRequests,
  requestSearch,
  type RequestFilters,
} from './feedApi';
import {
  clearCompose,
  closeOverList,
  drawerOpen,
  goTo,
  leaveOverList,
  openOverList,
  peekCompose,
  useListBehind,
} from './feedNav';
import { feedHref } from './feedPaths';
import { number, plain, requestMatches, shownRequest, topTags } from './feedFormat';
import {
  Banner,
  Drawer,
  Empty,
  LayoutToggle,
  PillSelect,
  SignInButton,
  SkeletonCards,
  useNow,
  useSignedIn,
  type Layout,
} from './FeedParts';
import { addMine, dropMine, useMine } from './mine';
import { PostedCard, PostRequestForm } from './PostRequestForm';
import {
  RequestCard,
  RequestDetail,
  requestHitId,
  RequestListHead,
  RequestRow,
} from './RequestItem';

/*
 * Searched for: open requests ("I need X, budget Y, deadline Z"), newest first, as calm cards
 * (or a dense list). The filters live in the address (/feed/requests?q=&tag=). A card opens its
 * details in a drawer at the request's own address (/feed/requests/<id>, feedNav openOverList):
 * Back closes it and the list stays. Requests posted from this page load show first, marked
 * "Yours", with Close request in their details instead of Respond and Report.
 */

type Load =
  | { phase: 'loading' }
  | { phase: 'ready'; key: string; page: FeedRequestPage }
  | { phase: 'error'; error: unknown };

const TYPING_MS = 400;

const replace = (filters: RequestFilters) =>
  goTo(`${feedHref.requests}${requestSearch(filters)}`, { replace: true });

/** The tab names the request while its drawer is open, as its own page does. */
function DrawerTitle({ title }: { title: string }) {
  usePageTitle(`${title} · Feed · Central City`);
  return null;
}

export function RequestsView({
  filters,
  switcher,
  layout,
  onLayout,
  openCount,
  openId,
  onListCount,
  onPosted,
  onClosed,
}: {
  filters: RequestFilters;
  /** Offered | Searched for, at the start of the sticky bar. */
  switcher: ReactNode;
  layout: Layout;
  onLayout: (layout: Layout) => void;
  /** Open requests in the Feed (the switch's count), for "2 of 14 open requests". */
  openCount: number | null;
  /** The request whose drawer is open (the address is its own), else null. */
  openId: string | null;
  /**
   * Once the list is read: how many open requests it shows when it is the whole Feed (no filter,
   * no next page), else null (it can't count them).
   */
  onListCount: (count: number | null) => void;
  /** A new open request (the view switch's count follows). */
  onPosted: () => void;
  /** One of this page load's requests was closed (the count follows). */
  onClosed: () => void;
}) {
  const key = requestSearch(filters);
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [reload, setReload] = useState(0);
  const [more, setMore] = useState<'idle' | 'loading' | 'failed'>('idle');
  // Read in the initializer (which may run twice in development), cleared once mounted.
  const signedIn = useSignedIn();
  const [compose, setCompose] = useState(() => peekCompose());
  // Signed out the list is read-only: the form never opens.
  const [posting, setPosting] = useState(compose !== null && signedIn);
  const [posted, setPosted] = useState<{ answer: PostedFeedRequest; lapsed: boolean } | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const [closeProblem, setCloseProblem] = useState<{ id: string; text: string } | null>(null);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [allTags, setAllTags] = useState<string[]>([]);
  const [announce, setAnnounce] = useState('');
  const [focusId, setFocusId] = useState<string | null>(null);
  const mine = useMine();
  const now = useNow();
  const postButton = useRef<HTMLButtonElement>(null);
  const moreAbort = useRef<AbortController | null>(null);
  // Where focus goes once the drawer is gone (its card left the list: Close request).
  const afterDrawer = useRef<string | null>(null);
  // A read again (cursor_stale, Try again) skips the browser's cache, and focus goes to the list's
  // heading once it is there (the button that asked is gone meanwhile).
  const reloads = useRef(0);
  const fresh = useRef<{ key: string; reload: number } | null>(null);
  const headNext = useRef(false);
  const readAgain = () => {
    reloads.current += 1;
    fresh.current = { key, reload: reloads.current };
    headNext.current = true;
    setReload(reloads.current);
  };

  useEffect(() => {
    const controller = new AbortController();
    // A page still on its way belongs to the list before: it never lands on this one.
    moreAbort.current?.abort();
    setMore('idle');
    setLoad({ phase: 'loading' });
    const noStore = fresh.current?.key === key && fresh.current.reload === reload;
    getRequests(filters, null, {
      signal: controller.signal,
      ...(noStore ? { cache: 'no-store' as const } : {}),
    })
      .then((page) => {
        setLoad({ phase: 'ready', key, page });
        if (!filters.q && !filters.tag) setAllTags(topTags(page.requests, ''));
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoad({ phase: 'error', error });
      });
    return () => controller.abort();
    // `filters` is read through `key`, which changes whenever they do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reload]);
  useEffect(() => clearCompose(), []);
  useEffect(() => () => moreAbort.current?.abort(), []);
  useEffect(() => {
    if (load.phase === 'loading' || !headNext.current) return;
    headNext.current = false;
    document.getElementById('fd-list-h')?.focus();
  }, [load]);
  useEffect(() => {
    // Waits for this list (a cleared search reloads it) until the card is there.
    if (!focusId || load.phase !== 'ready' || load.key !== key) return;
    const element = document.getElementById(requestHitId(focusId));
    if (!element) return;
    element.scrollIntoView({ block: 'center' });
    element.focus({ preventScroll: true });
    setFocusId(null);
  }, [focusId, load, key]);

  async function showMore() {
    if (load.phase !== 'ready' || !load.page.next || more === 'loading') return;
    const controller = new AbortController();
    moreAbort.current = controller;
    setMore('loading');
    try {
      const next = await getRequests(filters, load.page.next, { signal: controller.signal });
      const known = new Set(load.page.requests.map((request) => request.id));
      const first = next.requests.find(
        (request) => !known.has(request.id) && shownRequest(request),
      );
      setLoad((current) =>
        current.phase !== 'ready' || current.key !== key
          ? current
          : {
              ...current,
              page: {
                next: next.next,
                requests: [
                  ...current.page.requests,
                  ...next.requests.filter((request) => !known.has(request.id)),
                ],
              },
            },
      );
      setMore('idle');
      if (first) setFocusId(first.id);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof FeedFailure && error.code === 'cursor_stale') {
        setMore('idle');
        readAgain();
      } else setMore('failed');
    }
  }

  async function closeMine(id: string, token: string) {
    setClosing(id);
    setCloseProblem(null);
    try {
      await closeRequest(id, token).catch((error: unknown) => {
        // Closed already (elsewhere, or it expired): closed all the same.
        if (!alreadyClosed(error)) throw error;
      });
      dropMine(id);
      setClosed((current) => new Set([...current, id]));
      onClosed();
      if (posted?.answer.request.id === id) setPosted(null);
      afterDrawer.current = 'fd-list-h';
      if (openId === id) closeOverList();
      setAnnounce('Request closed.');
    } catch (error) {
      const copy = feedErrorCopy(error, 'close');
      setCloseProblem({ id, text: `${copy.title} ${copy.detail}` });
    } finally {
      setClosing(null);
    }
  }

  const page = load.phase === 'ready' ? load.page : null;
  // Counted only from the list read for these filters (not the one before, still on screen).
  const current = load.phase === 'ready' && load.key === key;
  const mineOpen = mine.filter(
    (entry) => entry.request.status === 'open' && !closed.has(entry.request.id),
  );
  const mineIds = new Set(mineOpen.map((entry) => entry.request.id));
  const listed = (page?.requests ?? []).filter(
    (request) => shownRequest(request) && !closed.has(request.id) && !mineIds.has(request.id),
  );
  // Yours shows when the server listed it for these filters, or when it would (posted after the
  // list was read): the two read the same words.
  const serverIds = new Set(current ? (page?.requests ?? []).map((request) => request.id) : []);
  const yours = mineOpen.filter(
    (entry) => serverIds.has(entry.request.id) || requestMatches(entry.request, filters),
  );
  const shown = yours.length + listed.length;
  const filtered = Boolean(filters.q || filters.tag);
  const tags = topTags(
    [...mineOpen.map((entry) => entry.request), ...(page?.requests ?? [])],
    filters.tag,
  );
  const tagMenu = allTags.length
    ? [...new Set([...allTags, ...(filters.tag ? [filters.tag] : [])])]
    : tags;
  // One list of posters (keyed by request, oldest first), so a new request never changes the
  // colour of the ones already there; cards, rows and details read the same map.
  const everyone = [...yours.map((entry) => entry.request), ...listed];
  const colourKey = everyone.map((request) => request.id).join(' ');
  const colours = useMemo(
    () =>
      assignAvatarColors(
        everyone.map((request) => ({
          id: request.id,
          joinedAt: new Date(request.createdAt).toISOString(),
        })),
      ),
    // The ids cover every input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [colourKey],
  );
  const countText =
    load.phase === 'loading'
      ? 'Reading…'
      : !page
        ? 'Searched for'
        : filtered
          ? `${number.format(shown)}${page.next ? '+' : ''}${openCount !== null ? ` of ${number.format(openCount)}` : ''} open ${openCount === 1 ? 'request' : 'requests'}`
          : `${number.format(shown)}${page.next ? '+' : ''} open ${shown === 1 ? 'request' : 'requests'}`;
  const openForm = () => {
    setPosted(null);
    setPosting(true);
  };
  const mineEntryOf = (id: string) => yours.find((entry) => entry.request.id === id) ?? null;
  const open = openId
    ? (mineEntryOf(openId)?.request ?? listed.find((request) => request.id === openId) ?? null)
    : null;
  const openMine = open ? mineEntryOf(open.id) : null;
  const colourOf = (request: PublicFeedRequest) => colours.get(request.id) ?? '';
  const openRequest = (id: string) => openOverList(feedHref.request(id));
  const listCount = current ? (!filtered && !load.page.next ? shown : null) : undefined;
  useEffect(() => {
    if (listCount !== undefined) onListCount(listCount);
  }, [listCount, onListCount]);
  // A drawer address whose request this list doesn't hold (after a reload the list may have
  // changed, or it was further down): the request's own page shows instead. One closed here
  // closes its drawer by itself.
  const lost = openId !== null && open === null && !closed.has(openId) && current;
  useEffect(() => {
    if (lost) leaveOverList();
  }, [lost]);
  useEffect(() => {
    if (open || !afterDrawer.current) return;
    document.getElementById(afterDrawer.current)?.focus();
    afterDrawer.current = null;
  }, [open]);

  return (
    <>
      <div className="fd-toolbar">
        <div className="fd-tb-row1">
          {switcher}
          <RequestSearch filters={filters} />
        </div>
        <div className="fd-tb-ctl">
          {tagMenu.length ? (
            <PillSelect
              id="fd-tag"
              label="Tag"
              value={filters.tag}
              set={Boolean(filters.tag)}
              options={[
                { value: '', label: 'All' },
                ...tagMenu.map((tag) => ({ value: tag, label: tag })),
              ]}
              onChange={(tag) => replace({ ...filters, tag })}
            />
          ) : null}
          <LayoutToggle value={layout} onChange={onLayout} />
        </div>
      </div>

      {posting ? (
        <PostRequestForm
          initialTitle={compose ?? ''}
          onPosted={(answer, lapsed) => {
            setCompose(null);
            setPosting(false);
            setPosted({ answer, lapsed });
            if (answer.request.status === 'open') {
              addMine(answer);
              onPosted();
            }
          }}
          onCancel={() => {
            setCompose(null);
            setPosting(false);
            window.setTimeout(() => postButton.current?.focus(), 0);
          }}
        />
      ) : posted ? (
        <PostedCard
          posted={posted.answer}
          lapsed={posted.lapsed}
          onSee={() => {
            const id = posted.answer.request.id;
            setPosted(null);
            if (filtered) replace({ q: '', tag: '' });
            setFocusId(id);
          }}
          onAnother={openForm}
        />
      ) : null}

      <section className="fd-results" aria-labelledby="fd-list-h">
        <div className="fd-rhead">
          <h2 className="fd-rh" id="fd-list-h" tabIndex={-1} aria-live="polite">
            {countText}
          </h2>
          {posting ? null : signedIn ? (
            <button ref={postButton} type="button" className="fd-btn primary" onClick={openForm}>
              <Plus size={15} aria-hidden="true" />
              Post a request
            </button>
          ) : (
            <SignInButton action="post" />
          )}
        </div>
        <p className="fd-strip">
          <Info size={15} aria-hidden="true" />
          <span>
            Open a request to <b>respond</b> or report it. Budgets are information only: no money
            moves through the Feed. A request closes at its deadline, or{' '}
            {Math.round(FEED_LIMITS.requestTtlMs / 86_400_000)} days after posting.
          </span>
        </p>

        {load.phase === 'loading' ? (
          <SkeletonCards label="Loading requests" count={4} />
        ) : load.phase === 'error' ? (
          <RequestsError error={load.error} onRetry={readAgain} />
        ) : shown === 0 ? (
          filtered ? (
            <Empty
              title="No open request matches"
              help="Try other words, or post your own request."
            >
              <button
                type="button"
                className="fd-btn"
                onClick={() => {
                  // The button leaves with the empty state: focus goes to the search.
                  replace({ q: '', tag: '' });
                  document.getElementById('fd-rq')?.focus();
                }}
              >
                Clear filters
              </button>
            </Empty>
          ) : (
            <Empty
              title="No open requests yet"
              help="Post what you need. People and agents who can do it see it here."
            >
              {posting ? null : signedIn ? (
                <button type="button" className="fd-btn primary" onClick={openForm}>
                  <Plus size={15} aria-hidden="true" />
                  Post a request
                </button>
              ) : (
                <SignInButton action="post" />
              )}
            </Empty>
          )
        ) : layout === 'list' ? (
          <div className="fd-table">
            <RequestListHead />
            <ul className="fd-rows" aria-label="Requests">
              {yours.map((entry) => (
                <RequestRow
                  key={entry.request.id}
                  request={entry.request}
                  now={now}
                  colour={colourOf(entry.request)}
                  mine
                  onOpen={() => openRequest(entry.request.id)}
                />
              ))}
              {listed.map((request) => (
                <RequestRow
                  key={request.id}
                  request={request}
                  now={now}
                  colour={colourOf(request)}
                  onOpen={() => openRequest(request.id)}
                />
              ))}
            </ul>
          </div>
        ) : (
          <ul className="fd-grid" aria-label="Requests">
            {yours.map((entry) => (
              <RequestCard
                key={entry.request.id}
                request={entry.request}
                now={now}
                colour={colourOf(entry.request)}
                mine
                onOpen={() => openRequest(entry.request.id)}
              />
            ))}
            {listed.map((request) => (
              <RequestCard
                key={request.id}
                request={request}
                now={now}
                colour={colourOf(request)}
                onOpen={() => openRequest(request.id)}
              />
            ))}
          </ul>
        )}

        {page?.next ? (
          <div className="fd-more">
            {more === 'failed' ? (
              <Banner tone="bad" title="More requests couldn’t be loaded">
                The list above hasn’t changed. Press Load more to try again.
              </Banner>
            ) : null}
            <button
              type="button"
              className="fd-btn"
              aria-disabled={more === 'loading' || undefined}
              onClick={() => void showMore()}
            >
              {more === 'loading' ? (
                <>
                  <LoaderCircle className="spin" size={14} aria-hidden="true" />
                  Reading…
                </>
              ) : (
                'Load more'
              )}
            </button>
          </div>
        ) : null}
        <p className="visually-hidden" aria-live="polite">
          {announce}
        </p>
      </section>

      {open ? (
        <Drawer labelledBy="fd-dh" returnTo={requestHitId(open.id)} onClose={closeOverList}>
          <DrawerTitle title={plain(open.title)} />
          <RequestDetail
            key={open.id}
            headId="fd-dh"
            request={open}
            now={now}
            colour={colourOf(open)}
            mine={Boolean(openMine)}
            manage
            closing={closing === open.id}
            closeProblem={closeProblem?.id === open.id ? closeProblem.text : ''}
            onCloseRequest={
              openMine ? () => void closeMine(open.id, openMine.manageToken) : undefined
            }
            onTag={() => {
              // The tag's list reads; its heading takes focus once it is there.
              headNext.current = true;
            }}
            onClose={closeOverList}
          />
        </Drawer>
      ) : null}
    </>
  );
}

function RequestsError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const copy = feedErrorCopy(error, 'list');
  return (
    <Banner
      tone="bad"
      title="The requests couldn’t be loaded"
      action={
        <button type="button" className="fd-btn" onClick={onRetry}>
          <RefreshCw size={14} aria-hidden="true" />
          Try again
        </button>
      }
    >
      {`${copy.title} ${copy.detail}`}
    </Banner>
  );
}

function RequestSearch({ filters }: { filters: RequestFilters }) {
  const [q, setQ] = useState(filters.q);
  const sent = useRef(filters.q);
  const timer = useRef(0);
  // The filters as they are when the typing pause ends: a tag chosen meanwhile is kept.
  const latest = useRef(filters);
  useEffect(() => {
    latest.current = filters;
  }, [filters]);
  useEffect(() => {
    if (filters.q !== sent.current) {
      sent.current = filters.q;
      setQ(filters.q);
    }
  }, [filters.q]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  // A typing pause that ends while a drawer is open (a card clicked right after typing) waits for
  // it to close: the drawer's history entry stays its own, and Close or Back still leaves it.
  const waiting = useRef<string | null>(null);
  const over = useListBehind();
  useEffect(() => {
    if (over || waiting.current === null) return;
    const text = waiting.current;
    waiting.current = null;
    apply(text);
  }, [over]);
  function apply(text: string) {
    window.clearTimeout(timer.current);
    if (drawerOpen()) {
      waiting.current = text;
      return;
    }
    const now = latest.current;
    const words = Array.from(text.trim()).slice(0, FEED_LIMITS.queryMax).join('');
    if (words === now.q) return;
    sent.current = words;
    replace({ ...now, q: words });
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    apply(q);
  }
  return (
    <form className="fd-search" role="search" aria-label="Search requests" onSubmit={submit}>
      <Search size={16} aria-hidden="true" />
      <label htmlFor="fd-rq" className="visually-hidden">
        Search requests
      </label>
      <input
        id="fd-rq"
        type="search"
        value={q}
        maxLength={FEED_LIMITS.queryMax}
        onChange={(event) => {
          const text = event.target.value;
          setQ(text);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => apply(text), TYPING_MS);
        }}
        placeholder="Search requests, like “invoices”"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
      />
      {q ? (
        <button
          type="button"
          className="fd-clear"
          aria-label="Clear search"
          onClick={() => {
            setQ('');
            apply('');
            document.getElementById('fd-rq')?.focus();
          }}
        >
          <X size={15} aria-hidden="true" />
        </button>
      ) : null}
    </form>
  );
}
