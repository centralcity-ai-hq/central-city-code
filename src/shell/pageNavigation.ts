/*
 * Page changes inside the app, without a reload. A tap on a plain link to another public page
 * (docs, Downtown, the trust pages, …) used to load the whole document again: a white frame,
 * then "Opening Central City", then the page, at the top. Instead, the next page's chunk loads
 * while the current page stays on screen, then the two cross-fade (the View Transitions API,
 * where the browser has it; motion.css styles it) and the new page starts at the top. Back and
 * Forward return to where the visitor was on that page.
 *
 * Root decides which paths it can show this way (pageLoader); anything else (other origins,
 * new tabs, modifier keys, downloads, a query or a fragment, a link a component already
 * handled) keeps the browser's own navigation.
 */
type Loader = () => Promise<unknown>;

/** Scroll positions of the entries this page has created, by entry key (memory only). */
const scrollByEntry = new Map<string, number>();
let activeEntry: string | undefined;
let lastScrollY = 0;
/** Set while Root applies a page change made here, so it renders it as a transition. */
let inAppChange = false;
/** Where to scroll once the next page has rendered: a number, or null to leave it alone. */
let scrollTarget: number | null = null;
let focusMain = false;
let committed: (() => void) | null = null;
let sequence = 0;

const reducedMotion = () =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const entryOf = (state: unknown) =>
  state && typeof state === 'object' && 'ccEntry' in state
    ? String((state as { ccEntry: unknown }).ccEntry)
    : undefined;
const newEntry = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * The page's canonical link follows an in-app change (same origin as the one the page arrived
 * with). Crawlers always load each address itself and get its own prerendered head.
 */
function followCanonical(path: string) {
  const link = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (link) link.href = new URL(path, link.href).href;
}

/** The link a click would follow in-app, or null for the browser's own navigation. */
function inAppTarget(event: MouseEvent, pageLoader: (path: string) => Loader | null) {
  if (event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (!(link instanceof HTMLAnchorElement)) return null;
  if ((link.target && link.target !== '_self') || link.hasAttribute('download')) return null;
  const url = new URL(link.href, window.location.href);
  if (url.origin !== window.location.origin || url.search || url.hash) return null;
  const load = pageLoader(url.pathname);
  return load ? { path: url.pathname, load } : null;
}

/** Goes to an in-app page: its chunk first (old page still shown), then the swap. */
async function go(path: string, load: Loader) {
  const mine = ++sequence;
  try {
    await load();
  } catch {
    // The chunk could not load: let the browser try the page itself.
    window.location.assign(path);
    return;
  }
  if (mine !== sequence) return;
  if (!activeEntry) {
    activeEntry = newEntry();
    window.history.replaceState({ ...window.history.state, ccEntry: activeEntry }, '');
  }
  scrollByEntry.set(activeEntry, window.scrollY);
  const swap = () =>
    new Promise<void>((resolve) => {
      committed = resolve;
      // Never hold the screen for long if the render takes a while.
      window.setTimeout(resolve, 1000);
      activeEntry = newEntry();
      inAppChange = true;
      scrollTarget = 0;
      focusMain = true;
      window.history.pushState({ ccEntry: activeEntry }, '', path);
      followCanonical(path);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
  if (typeof document.startViewTransition === 'function' && !reducedMotion())
    document.startViewTransition(swap);
  else void swap();
}

/**
 * Starts in-app page changes for links Root can render (pageLoader returns the page's chunk).
 * Returns the cleanup.
 */
export function installInAppLinks(pageLoader: (path: string) => Loader | null) {
  activeEntry ??= entryOf(window.history.state);
  const click = (event: MouseEvent) => {
    const target = inAppTarget(event, pageLoader);
    if (!target) return;
    event.preventDefault();
    if (target.path === window.location.pathname && !window.location.search) {
      // The page itself: back to its top, as a reload would, without the reload.
      if (!window.location.hash)
        return window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
    }
    void go(target.path, target.load);
  };
  const scroll = () => {
    lastScrollY = window.scrollY;
  };
  document.addEventListener('click', click);
  window.addEventListener('scroll', scroll, { passive: true });
  return () => {
    document.removeEventListener('click', click);
    window.removeEventListener('scroll', scroll);
  };
}

/**
 * The next popstate is a page change inside the signed-in workspace (its navigation): Root
 * renders it as a transition, so the shell stays and a page still loading its code keeps the
 * current page on screen rather than a loading screen. Scroll and focus are left to the page.
 */
export function markInAppChange() {
  inAppChange = true;
}

/**
 * Called by Root on every popstate. True when the change was made here, or is Back or Forward
 * between entries made here (render it as a transition: the old page stays until the new one is
 * ready). On Back and Forward it remembers the scroll position of the page being left and plans
 * the one of the page returned to.
 */
export function takeInAppChange() {
  if (inAppChange) {
    inAppChange = false;
    return true;
  }
  scrollTarget = null;
  const entry = entryOf(window.history.state);
  if (!entry || entry === activeEntry) return false;
  if (activeEntry) scrollByEntry.set(activeEntry, lastScrollY);
  activeEntry = entry;
  scrollTarget = scrollByEntry.get(entry) ?? null;
  followCanonical(window.location.pathname);
  return true;
}

/** Called by Root once the page for a new path has rendered (a layout effect). */
export function pageCommitted() {
  const target = scrollTarget;
  scrollTarget = null;
  if (target !== null) {
    // A page whose content is still loading may be too short at first: try for a moment.
    let tries = 0;
    const place = () => {
      window.scrollTo(0, target);
      if (Math.abs(window.scrollY - target) > 1 && ++tries < 60) requestAnimationFrame(place);
    };
    place();
    lastScrollY = target;
  }
  if (focusMain) {
    focusMain = false;
    // As after a page load: reading and Tab start at the new page's content.
    document.getElementById('main-content')?.focus({ preventScroll: true });
  }
  committed?.();
  committed = null;
}
