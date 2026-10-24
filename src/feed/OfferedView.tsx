import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Info, LoaderCircle, Plus, RefreshCw, Search, TriangleAlert, X } from 'lucide-react';
import { FEED_LIMITS, usdcToRaw, type FeedService, type FeedServicePage } from '../../shared/feed';
import { assignAvatarColors } from '../shell/avatarColor';
import { avatarKeyOf } from './avatarKey';
import { usePageTitle } from '../shell/usePageTitle';
import {
  feedErrorCopy,
  FeedFailure,
  getService,
  getServices,
  offeredSearch,
  sortOf,
  type OfferedFilters,
} from './feedApi';
import {
  closeOverList,
  composeFrom,
  drawerOpen,
  goTo,
  leaveOverList,
  openOverList,
  useListBehind,
} from './feedNav';
import { feedHref } from './feedPaths';
import { agoText, number, shownService, shownTitles, utcText, utcTime } from './feedFormat';
import {
  Banner,
  CreditLink,
  Drawer,
  Empty,
  isHosted,
  LayoutToggle,
  PillSelect,
  SignInButton,
  SkeletonCards,
  useNow,
  useSignedIn,
  type Layout,
} from './FeedParts';
import {
  hostHref,
  ServiceCard,
  ServiceDetail,
  ServiceHead,
  serviceHitId,
  ServiceListHead,
  ServiceRow,
} from './ServiceItem';
import { usePayAccess } from './pay/usePayAccess';
import { freeService, freeServiceIds, useSponsored } from './pay/sponsoredApi';
import { freeCovers, FREE_CHIP } from './pay/sponsoredModel';

/*
 * Offered: services any Base agent can call, listed by x402 Bazaar, as calm cards (or a dense
 * list). The filters live in the address (/feed?q=&max_price=&sort=&host=), so a filtered list
 * can be shared. An empty result names what excluded the services and offers to remove it;
 * nothing is ever broadened by itself. A card opens its details in a drawer, at the service's own
 * address (/feed/services/<id>, feedNav openOverList): Back closes it and the list stays.
 */

type Load =
  | { phase: 'loading' }
  | { phase: 'ready'; key: string; page: FeedServicePage }
  | { phase: 'preparing' }
  | { phase: 'error'; error: unknown };

const PRICES = ['0.001', '0.005', '0.01', '0.05', '0.1', '1', '10'];

/** Typing waits this long before the list follows (Enter applies at once). */
const TYPING_MS = 400;

function merge(shown: FeedServicePage, next: FeedServicePage): FeedServicePage {
  const ids = new Set(shown.services.map((service) => service.id));
  return {
    ...next,
    services: [...shown.services, ...next.services.filter((service) => !ids.has(service.id))],
    total: next.total ?? shown.total,
  };
}

const filtered = (filters: OfferedFilters) =>
  Boolean(filters.q.trim() || filters.maxPrice || filters.host || filters.free);

/**
 * The free filter's list (?free=1): the services a free first buy may be, each read on its own
 * (a short list), with the search words and the price limit applied here.
 */
async function freeServicesPage(
  ids: string[],
  filters: OfferedFilters,
  signal: AbortSignal,
): Promise<FeedServicePage> {
  const read = await Promise.all(ids.map((id) => getService(id, { signal }).catch(() => null)));
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const words = filters.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const max = filters.maxPrice ? usdcToRaw(filters.maxPrice) : null;
  const services = read.flatMap((detail) => {
    if (!detail) return [];
    const service = detail.service;
    const text = `${service.title} ${service.description}`.toLowerCase();
    if (!words.every((word) => text.includes(word))) return [];
    if (max !== null && (!service.price || BigInt(service.price.raw) > BigInt(max))) return [];
    return [service];
  });
  const first = read.find(Boolean);
  return {
    services,
    next: null,
    total: services.length,
    snapshotAt: first?.snapshotAt ?? null,
    degraded: false,
    sources: first?.sources ?? [],
  };
}

/** "32,061 services · showing 24", or with filters "3 services match". */
export function offeredCount(filters: OfferedFilters, page: FeedServicePage, shown: number) {
  const total = page.total;
  const count =
    total !== null ? number.format(total) : `${number.format(shown)}${page.next ? '+' : ''}`;
  const one = total !== null ? total === 1 : shown === 1 && !page.next;
  const showing = total !== null && shown < total ? ` · showing ${number.format(shown)}` : '';
  if (filtered(filters)) return `${count} ${one ? 'service matches' : 'services match'}${showing}`;
  return `${count} ${one ? 'service' : 'services'}${showing}`;
}

const replace = (filters: OfferedFilters) =>
  goTo(`${feedHref.offered}${offeredSearch(filters)}`, { replace: true });

/** "Post it as a request": Searched for, with the form open and the search as its title. */
function postFromSearch(q: string) {
  composeFrom(q ? q.charAt(0).toUpperCase() + q.slice(1) : '');
  goTo(feedHref.requests, { top: true });
}

const focusListHead = () =>
  window.setTimeout(() => document.getElementById('fd-list-h')?.focus(), 0);

/** The tab names the service while its drawer is open, as its own page does. */
function DrawerTitle({ title }: { title: string }) {
  usePageTitle(`${title} · Feed · Central City`);
  return null;
}

export function OfferedView({
  filters,
  openId,
  switcher,
  layout,
  onLayout,
}: {
  filters: OfferedFilters;
  /** The service whose drawer is open (the address is its own), else null. */
  openId: string | null;
  /** Offered | Searched for, at the start of the sticky bar. */
  switcher: ReactNode;
  layout: Layout;
  onLayout: (layout: Layout) => void;
}) {
  const key = offeredSearch(filters);
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [reload, setReload] = useState(0);
  const [more, setMore] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [restarted, setRestarted] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const now = useNow();
  const moreAbort = useRef<AbortController | null>(null);
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

  const signedInNow = useSignedIn();
  const access = usePayAccess(signedInNow);
  // Free first buys: the chip on Central City's services while one of the person's agents has
  // one, and the free filter's list (the agent page's Choose).
  const sponsored = useSponsored(signedInNow);
  const anyFree = [...sponsored.agents.values()].includes('free');
  const freeFor = (service: FeedService) =>
    anyFree &&
    freeService(sponsored, service.id) &&
    freeCovers(service.price?.raw, sponsored.creditMaxRaw);
  const freeIds = filters.free ? freeServiceIds(sponsored).join(',') : '';
  // Signed out there is nothing to read: the free list is simply empty.
  const freeWait = Boolean(filters.free && signedInNow && !sponsored.known);

  useEffect(() => {
    const controller = new AbortController();
    moreAbort.current?.abort();
    setMore('idle');
    setLoad({ phase: 'loading' });
    if (freeWait) return () => controller.abort();
    const noStore = fresh.current?.key === key && fresh.current.reload === reload;
    (filters.free
      ? freeServicesPage(freeIds ? freeIds.split(',') : [], filters, controller.signal)
      : getServices(filters, null, {
          signal: controller.signal,
          ...(noStore ? { cache: 'no-store' as const } : {}),
        })
    )
      .then((page) => setLoad({ phase: 'ready', key, page }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof FeedFailure && error.code === 'source_unavailable')
          setLoad({ phase: 'preparing' });
        else setLoad({ phase: 'error', error });
      });
    return () => controller.abort();
    // `filters` is read through `key`, which changes whenever they do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reload, freeIds, freeWait]);
  useEffect(() => () => moreAbort.current?.abort(), []);
  useEffect(() => {
    if (load.phase === 'loading' || !headNext.current) return;
    headNext.current = false;
    document.getElementById('fd-list-h')?.focus();
  }, [load]);
  // "Refreshed while you read it" belongs to the list it happened to; a new search starts clean.
  useEffect(() => setRestarted(false), [key]);
  useEffect(() => {
    if (!focusId) return;
    document.getElementById(serviceHitId(focusId))?.focus();
    setFocusId(null);
  }, [focusId]);

  async function showMore() {
    if (load.phase !== 'ready' || !load.page.next || more === 'loading') return;
    const controller = new AbortController();
    moreAbort.current = controller;
    setMore('loading');
    try {
      const next = await getServices(filters, load.page.next, { signal: controller.signal });
      const known = new Set(load.page.services.map((service) => service.id));
      const first = next.services.find(
        (service) => !known.has(service.id) && shownService(service),
      );
      setLoad((current) =>
        current.phase === 'ready' && current.key === key
          ? { ...current, page: merge(current.page, next) }
          : current,
      );
      setMore('idle');
      // The pages line up again: "refreshed while you read it" is over.
      setRestarted(false);
      // Reading goes on at the first new card.
      if (first) setFocusId(first.id);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof FeedFailure && error.code === 'cursor_stale') {
        // A new read of x402 Bazaar finished: the pages no longer line up. Page 1 again.
        setRestarted(true);
        setMore('idle');
        readAgain();
      } else setMore('failed');
    }
  }

  const page = load.phase === 'ready' ? load.page : null;
  const services = useMemo(() => (page ? page.services.filter(shownService) : []), [page]);
  const titles = useMemo(() => shownTitles(services), [services]);
  // One list, keyed by host in the order loaded: a service keeps its colour as more load, and
  // its card and its details always agree.
  const colours = useMemo(() => assignAvatarColors(services.map(avatarKeyOf)), [services]);
  const source = page?.sources[0];
  const retry = readAgain;
  const open = openId ? (services.find((service) => service.id === openId) ?? null) : null;
  const ready = load.phase !== 'loading';
  const signedIn = signedInNow;
  // Whether the strip may say "Nothing is paid through the Feed.": not while Feed pay is on for
  // the person, and not before that is known (docs/FEED_PAY.md section 12).
  const payAccess = access.phase;
  const payWords = !signedIn
    ? 'off'
    : payAccess === 'on'
      ? 'on'
      : payAccess === 'unknown'
        ? null
        : 'off';
  // A drawer address whose service this list doesn't hold (after a reload the list may have
  // changed, or it was further down): the service's own page shows instead.
  useEffect(() => {
    if (openId && ready && !open) leaveOverList();
  }, [openId, ready, open]);
  const titleOf = (service: FeedService) => titles.get(service.id) ?? service.provider.host;
  const colourOf = (service: FeedService) => colours.get(avatarKeyOf(service)) ?? '';
  const isFiltered = filtered(filters);
  const parts = [
    filters.q.trim() ? `“${filters.q.trim()}”` : '',
    filters.maxPrice ? `up to $${filters.maxPrice} a call` : '',
    filters.host ? `from ${filters.host}` : '',
    filters.free ? FREE_CHIP : '',
  ].filter(Boolean);

  return (
    <>
      <div className="fd-toolbar">
        <div className="fd-tb-row1">
          {switcher}
          <SearchForm filters={filters} />
        </div>
        <div className="fd-tb-ctl">
          <FilterSelects filters={filters} />
          <LayoutToggle value={layout} onChange={onLayout} />
        </div>
      </div>

      <section className="fd-results" aria-labelledby="fd-list-h">
        <div className="fd-rhead">
          <h2 className="fd-rh" id="fd-list-h" tabIndex={-1} aria-live="polite">
            {load.phase === 'loading'
              ? 'Reading…'
              : page
                ? offeredCount(filters, page, services.length)
                : 'Offered'}
          </h2>
          <SourceLine page={page} now={now} />
        </div>
        <p className="fd-strip">
          <Info size={15} aria-hidden="true" />
          <span>
            {services.some((service) => isHosted(service.source)) ? (
              <>
                <b>Services</b> listed by x402 Bazaar (external, not Central City agents) and by
                Central City agents (fee included). Prices are per call.
              </>
            ) : (
              <>
                <b>External services</b> listed by x402 Bazaar, not Central City agents. Prices are
                per call.
              </>
            )}
            {payWords === 'on'
              ? ' Use with my agent pays one from your agent’s own wallet after you confirm.'
              : payWords === 'off'
                ? ' Nothing is paid through the Feed.'
                : null}
          </span>
        </p>

        {page?.degraded ? (
          <Banner
            tone="warn"
            title="Source refresh delayed"
            action={
              <button type="button" className="fd-btn" onClick={retry}>
                <RefreshCw size={14} aria-hidden="true" />
                Try again
              </button>
            }
          >
            {source?.lastSuccessAt
              ? `x402 Bazaar hasn’t answered since ${utcText(source.lastSuccessAt)} (${agoText(source.lastSuccessAt, now)}). Prices and paid calls may have changed since then. We keep trying.`
              : 'x402 Bazaar hasn’t answered lately. Prices and paid calls may have changed since the last read. We keep trying.'}
          </Banner>
        ) : null}
        {restarted && load.phase === 'ready' ? (
          <Banner tone="note" title="The list was refreshed while you read it">
            x402 Bazaar was read again, so the list starts again from the top.
          </Banner>
        ) : null}
        {parts.length ? (
          <p className="fd-active">
            <span>
              Filtered by{' '}
              {parts.map((part, index) => (
                <span key={part}>
                  {index ? ' · ' : ''}
                  <b>{part}</b>
                </span>
              ))}
            </span>
            <button
              type="button"
              className="fd-link"
              onClick={() => {
                replace({
                  q: '',
                  maxPrice: '',
                  sort: filters.sort === 'relevance' ? '' : filters.sort,
                  host: '',
                });
                document.getElementById('fd-q')?.focus();
              }}
            >
              <X size={14} aria-hidden="true" />
              Clear filters
            </button>
          </p>
        ) : null}

        {load.phase === 'loading' ? (
          <SkeletonCards label="Loading services" />
        ) : load.phase === 'preparing' ? (
          <Banner
            tone="bad"
            title="The Feed couldn’t be loaded"
            action={
              <button type="button" className="fd-btn" onClick={retry}>
                <RefreshCw size={14} aria-hidden="true" />
                Try again
              </button>
            }
          >
            x402 Bazaar hasn’t been read yet, so there is no list to show. Nothing is wrong with
            your search. Try again in a moment.
          </Banner>
        ) : load.phase === 'error' ? (
          <ListError error={load.error} onRetry={retry} />
        ) : services.length === 0 ? (
          <OfferedEmpty filters={filters} />
        ) : layout === 'list' ? (
          <div className="fd-table">
            <ServiceListHead />
            <ul className="fd-rows" aria-label="Services">
              {services.map((service) => (
                <ServiceRow
                  key={service.id}
                  service={service}
                  freeBuy={freeFor(service)}
                  title={titleOf(service)}
                  colour={colourOf(service)}
                  onOpen={() => openOverList(feedHref.service(service.id))}
                />
              ))}
            </ul>
          </div>
        ) : (
          <ul className="fd-grid" aria-label="Services">
            {services.map((service) => (
              <ServiceCard
                key={service.id}
                service={service}
                freeBuy={freeFor(service)}
                title={titleOf(service)}
                colour={colourOf(service)}
                onOpen={() => openOverList(feedHref.service(service.id))}
              />
            ))}
          </ul>
        )}

        {page?.next ? (
          <div className="fd-more">
            {more === 'failed' ? (
              <Banner tone="bad" title="More services couldn’t be loaded">
                The list above hasn’t changed. Press Load more to try again.
              </Banner>
            ) : null}
            {page.total !== null ? (
              <span>
                Showing {number.format(services.length)} of {number.format(page.total)} services
              </span>
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

        {load.phase === 'ready' && (services.length > 0 || !isFiltered) ? (
          <div className="fd-didnt">
            <div>
              <b>Didn’t find it?</b>
              <span>
                Post what you need. People and agents who can do it see it in Searched for.
              </span>
            </div>
            {signedIn ? (
              <button
                type="button"
                className="fd-btn tonal"
                onClick={() => postFromSearch(filters.q.trim())}
              >
                <Plus size={15} aria-hidden="true" />
                Post a request
              </button>
            ) : (
              <SignInButton action="post" className="fd-btn tonal" />
            )}
          </div>
        ) : null}
      </section>

      {open ? (
        <Drawer labelledBy="fd-dh" returnTo={serviceHitId(open.id)} onClose={closeOverList}>
          <DrawerTitle title={titleOf(open)} />
          <ServiceHead
            id="fd-dh"
            service={open}
            title={titleOf(open)}
            colour={colourOf(open)}
            onClose={closeOverList}
          />
          <ServiceDetail
            service={open}
            now={now}
            hostFiltered={Boolean(filters.host)}
            onClose={closeOverList}
            onHost={(host) => {
              // Every service of the site: the search and price limit go, as on its own page.
              leaveOverList(hostHref(host));
              focusListHead();
            }}
          />
        </Drawer>
      ) : null}
    </>
  );
}

function ListError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const copy = feedErrorCopy(error, 'list');
  return (
    <Banner
      tone="bad"
      title="The list couldn’t be loaded"
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

function OfferedEmpty({ filters }: { filters: OfferedFilters }) {
  const signedIn = useSignedIn();
  const q = filters.q.trim();
  const { maxPrice, host } = filters;
  if (!q && !maxPrice && !host)
    return (
      <Empty
        title="No services are listed yet"
        help="Central City lists Base services from x402 Bazaar after each full read."
      />
    );
  const what = [
    q ? `“${q}”` : '',
    maxPrice ? `at $${maxPrice} or less per call` : '',
    host ? `from ${host}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <Empty
      title={`No service matches ${what}`}
      help={
        q && maxPrice
          ? 'Remove the price limit, try other words, or post what you’re searching for.'
          : q
            ? 'Try other words, or post what you’re searching for so people and agents who can do it see it.'
            : maxPrice
              ? 'No listed service costs this little per call. Services without a listed price are left out.'
              : undefined
      }
    >
      {maxPrice ? (
        <button
          type="button"
          className="fd-btn"
          onClick={() => {
            // The button leaves with the empty state: focus goes to the list it brings.
            replace({ ...filters, maxPrice: '' });
            focusListHead();
          }}
        >
          Remove the price limit
        </button>
      ) : null}
      {host ? (
        <button
          type="button"
          className="fd-btn"
          onClick={() => {
            replace({ ...filters, host: '' });
            focusListHead();
          }}
        >
          Show all sites
        </button>
      ) : null}
      {q ? (
        <button
          type="button"
          className="fd-btn"
          onClick={() => {
            replace({ ...filters, q: '', sort: filters.sort === 'relevance' ? '' : filters.sort });
            document.getElementById('fd-q')?.focus();
          }}
        >
          Clear search
        </button>
      ) : null}
      {q ? (
        signedIn ? (
          <button type="button" className="fd-btn primary" onClick={() => postFromSearch(q)}>
            <Plus size={15} aria-hidden="true" />
            Post it as a request
          </button>
        ) : (
          <SignInButton action="post" />
        )
      ) : null}
    </Empty>
  );
}

const cleanQuery = (text: string) =>
  Array.from(text.trim().replace(/\s+/g, ' ')).slice(0, FEED_LIMITS.queryMax).join('');

function SearchForm({ filters }: { filters: OfferedFilters }) {
  const [q, setQ] = useState(filters.q);
  const sent = useRef(filters.q);
  const timer = useRef(0);
  // The filters as they are when the typing pause ends: one chosen meanwhile is kept.
  const latest = useRef(filters);
  useEffect(() => {
    latest.current = filters;
  }, [filters]);
  // The address changed (Back, Clear filters): the field follows it, unless it is what we sent.
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
    const words = cleanQuery(text);
    if (words === now.q) return;
    sent.current = words;
    // The site filter stays: a search within one site's services is still that site's.
    replace({
      ...now,
      q: words,
      sort: now.sort === 'relevance' && !words ? '' : now.sort,
    });
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    apply(q);
  }
  return (
    <form className="fd-search" role="search" aria-label="Search services" onSubmit={submit}>
      <Search size={16} aria-hidden="true" />
      <label htmlFor="fd-q" className="visually-hidden">
        Search services
      </label>
      <input
        id="fd-q"
        type="search"
        value={q}
        maxLength={FEED_LIMITS.queryMax}
        onChange={(event) => {
          const text = event.target.value;
          setQ(text);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => apply(text), TYPING_MS);
        }}
        placeholder="Search services, like “pdf to text”"
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
            document.getElementById('fd-q')?.focus();
          }}
        >
          <X size={15} aria-hidden="true" />
        </button>
      ) : null}
    </form>
  );
}

function FilterSelects({ filters }: { filters: OfferedFilters }) {
  const prices = [...PRICES];
  // A shared address may carry a limit the menu doesn't list: it is kept and shown.
  if (filters.maxPrice && !prices.includes(filters.maxPrice) && usdcToRaw(filters.maxPrice))
    prices.push(filters.maxPrice);
  const sort = sortOf(filters);
  return (
    <>
      <PillSelect
        id="fd-max"
        label="Price"
        value={filters.maxPrice}
        set={Boolean(filters.maxPrice)}
        options={[
          { value: '', label: 'Any' },
          ...prices.map((price) => ({ value: price, label: `Up to $${price}` })),
        ]}
        onChange={(maxPrice) => replace({ ...filters, maxPrice })}
      />
      <PillSelect
        id="fd-sort"
        label="Sort"
        value={sort}
        options={[
          { value: 'most_used', label: 'Most used' },
          { value: 'relevance', label: 'Relevance', disabled: !filters.q.trim() },
          { value: 'cheapest', label: 'Cheapest' },
          { value: 'newest', label: 'Newest' },
        ]}
        onChange={(value) => replace({ ...filters, sort: value as OfferedFilters['sort'] })}
      />
    </>
  );
}

function SourceLine({ page, now }: { page: FeedServicePage | null; now: number }) {
  if (page?.degraded && page.snapshotAt !== null)
    return (
      <p className="fd-fresh" data-state="delayed">
        <TriangleAlert size={14} aria-hidden="true" />
        <span>
          Source refresh delayed · last refreshed {utcTime(page.snapshotAt)} · <CreditLink />
        </span>
      </p>
    );
  return (
    <p className="fd-fresh">
      <span>
        {page && page.snapshotAt !== null ? `Updated ${agoText(page.snapshotAt, now)} · ` : ''}
        <CreditLink />
      </span>
    </p>
  );
}
