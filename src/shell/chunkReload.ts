/**
 * Recovery from stale chunks after a deploy. A tab that loaded the previous build still refers to
 * its hashed chunk files, which the new deployment no longer serves; the first lazy screen it
 * opens then fails to load. A fresh page load fetches the new index (served `no-cache`, see
 * vercel.json) and with it the new chunk names, so the page reloads itself.
 *
 * Two paths lead here and share one guard: the error boundary (src/shell/ErrorBoundary), which
 * catches a failed React.lazy screen, and a global handler for a failed import nothing else
 * handled (Vite's `vite:preloadError`, then `unhandledrejection`). Whichever comes first
 * schedules the reload; the other sees it pending and does not count it again.
 *
 * `window.location.reload()` keeps the address as it is, path, query and hash included.
 *
 * Before each reload, the failed chunk itself is fetched once more past the browser's cache
 * (`cache: 'reload'`). Hashed assets are served `immutable` for a year (vercel.json), and that
 * header comes with the edge's 404 too when the page and its chunk briefly come from two builds
 * during a deploy: the browser then keeps the 404 and every reload fails again on it, until the
 * error page. The refetch replaces that stored answer with the real file.
 */

const reloadKey = 'cc.chunkReload';

/**
 * Reloads allowed for chunk failures before the error shows, and the wait before each one.
 * One is not enough right after a deploy: while the production alias moves to the new build,
 * the edge can answer the reloaded page from one build and its chunk from the other, so the
 * first reload can miss too (four deploys in two minutes were seen in production).
 */
export const RELOAD_DELAYS_MS = [0, 1000, 3000];
/** A reload this long after the previous one starts a new incident with a fresh budget. */
export const RELOAD_WINDOW_MS = 60_000;

/** A failed dynamic import: after a deploy, the old chunk names no longer exist. */
export function isChunkLoadError(error: unknown) {
  let message: string;
  try {
    message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  } catch {
    // A value with no string form (e.g. Object.create(null)) is not a chunk failure.
    return false;
  }
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|ChunkLoadError/i.test(
    message,
  );
}

/** Set once this page has scheduled its reload, so the second path doesn't count it again. */
let pending = false;

/** This site's hashed assets named by a chunk failure (its message carries the URL). */
const failedAssets = new Set<string>();
/** The longest a refetch may hold up the reload. */
export const REFETCH_TIMEOUT_MS = 4000;

/**
 * The same-origin `/assets/` URLs a chunk failure names ("Unable to preload CSS for <url>",
 * "Failed to fetch dynamically imported module: <url>"). Anything else is never fetched.
 */
export function failedAssetUrls(error: unknown, origin = window.location?.origin): string[] {
  let message: string;
  try {
    message = error instanceof Error ? error.message : String(error);
  } catch {
    return [];
  }
  const urls: string[] = [];
  for (const match of message.matchAll(/https?:\/\/[^\s'")]+/g)) {
    try {
      const url = new URL(match[0]);
      if (url.origin === origin && url.pathname.startsWith('/assets/')) urls.push(url.href);
    } catch {
      // Not a URL.
    }
  }
  return urls;
}

/** Remembers the assets this failure names, to refetch before the reload. */
function noteFailure(error: unknown) {
  for (const url of failedAssetUrls(error)) failedAssets.add(url);
}

/**
 * Fetches each remembered asset past the browser cache, so a 404 it stored during a deploy is
 * replaced; then reloads. Without fetch (or nothing to refetch) it reloads at once. A refetch
 * that fails or hangs never blocks the reload for longer than REFETCH_TIMEOUT_MS.
 */
function refetchThenReload() {
  const urls = [...failedAssets];
  failedAssets.clear();
  const get = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
  if (!urls.length || !get) {
    window.location.reload();
    return;
  }
  const refetched = Promise.all(
    urls.map((url) => get(url, { cache: 'reload', credentials: 'same-origin' }).catch(() => null)),
  );
  const timeout = new Promise((resolve) => window.setTimeout(resolve, REFETCH_TIMEOUT_MS));
  void Promise.race([refetched, timeout]).finally(() => window.location.reload());
}

/**
 * How many chunk reloads this tab made in the current incident (sessionStorage `n@lastAt`, the
 * time of the last reload or refused failure). The incident lasts while each failure follows the
 * previous one within RELOAD_WINDOW_MS, so a chunk that keeps failing every 20 s spends one
 * budget and ends on the error page. Pure read; null when storage is unavailable (then the page
 * never reloads by itself, so a failure can never turn into a reload loop).
 */
function reloadsSoFar(now = Date.now()): number | null {
  try {
    const [count, last] = (window.sessionStorage.getItem(reloadKey) ?? '').split('@').map(Number);
    if (!count || !last || now - last > RELOAD_WINDOW_MS) return 0;
    return count;
  } catch {
    return null;
  }
}

/** Whether a chunk failure now leads to a reload (pending, or still within the budget). */
export function chunkReloadAvailable() {
  if (pending) return true;
  const count = reloadsSoFar();
  return count !== null && count < RELOAD_DELAYS_MS.length;
}

/**
 * Schedules the reload for a chunk failure; false when the budget is spent or storage is
 * unavailable (the caller then shows the error state with its Reload button).
 */
export function requestChunkReload(error?: unknown) {
  if (error !== undefined) noteFailure(error);
  if (pending) return true;
  const now = Date.now();
  const count = reloadsSoFar(now);
  if (count === null) return false;
  if (count >= RELOAD_DELAYS_MS.length) {
    // Budget spent: a failure that keeps coming keeps the incident open (no fresh budget later).
    try {
      window.sessionStorage.setItem(reloadKey, `${count}@${now}`);
    } catch {
      // Storage gone: no reload either way.
    }
    return false;
  }
  try {
    window.sessionStorage.setItem(reloadKey, `${count + 1}@${now}`);
  } catch {
    return false;
  }
  pending = true;
  window.setTimeout(refetchThenReload, RELOAD_DELAYS_MS[count]);
  return true;
}

/** Failures Vite reported through `vite:preloadError` (a chunk or its preloaded CSS). */
const missingChunks = new WeakSet<object>();

/**
 * Listens for Vite's `vite:preloadError`, fired when a dynamic import or one of its preloaded
 * dependencies fails, and reloads once that failure goes unhandled. The event is not prevented,
 * so the error still propagates: a lazy screen's error boundary shows the reloading state (and
 * requests the reload itself), and code with its own fallback for an optional chunk (the phone
 * menu's plain links, a message's plain text) keeps working without a reload. Only a failure no
 * one caught reaches `unhandledrejection` and reloads here.
 */
export function installChunkReload() {
  window.addEventListener('vite:preloadError', (event) => {
    const payload = (event as Event & { payload?: unknown }).payload;
    if (payload && typeof payload === 'object') missingChunks.add(payload);
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = (event as Event & { reason?: unknown }).reason;
    // Only a missing chunk: any other error is a real bug and must not reload the page.
    const missing = reason && typeof reason === 'object' && missingChunks.has(reason);
    if (missing || isChunkLoadError(reason)) requestChunkReload(reason);
  });
}

/**
 * The error page's Reload: refetches the assets this failure names past the cache, then reloads
 * (the same healing as the automatic reloads, without counting against their budget).
 */
export function reloadAfterChunkFailure(error: unknown) {
  noteFailure(error);
  refetchThenReload();
}

/** For tests: forget the pending reload of this page. */
export function resetChunkReloadForTests() {
  pending = false;
  failedAssets.clear();
}
