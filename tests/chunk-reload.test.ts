import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  chunkReloadAvailable,
  failedAssetUrls,
  installChunkReload,
  isChunkLoadError,
  RELOAD_DELAYS_MS,
  RELOAD_WINDOW_MS,
  requestChunkReload,
  resetChunkReloadForTests,
} from '../src/shell/chunkReload.js';

/** A minimal browser: sessionStorage, location.reload, timers and window events. */
const store = new Map<string, string>();
let storageThrows = false;
let reloads = 0;
const timers: Array<{ run: () => void; delay: number }> = [];
const events = new EventTarget();
const fakeWindow = {
  sessionStorage: {
    getItem: (key: string) => {
      if (storageThrows) throw new Error('SecurityError');
      return store.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (storageThrows) throw new Error('SecurityError');
      store.set(key, value);
    },
  },
  location: { reload: () => (reloads += 1) },
  setTimeout: (run: () => void, delay: number) => timers.push({ run, delay }),
  addEventListener: events.addEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
};
(globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow;
installChunkReload();

/** A new page load: the in-page pending flag is gone, sessionStorage stays. */
function newPage() {
  resetChunkReloadForTests();
  timers.length = 0;
}
function runTimers() {
  for (const timer of timers.splice(0)) timer.run();
}
/** What Vite's preload helper does when a dynamic import fails. */
function preloadError(payload: unknown) {
  const event = new Event('vite:preloadError', { cancelable: true }) as Event & {
    payload?: unknown;
  };
  event.payload = payload;
  fakeWindow.dispatchEvent(event);
  return event;
}
const stale = new TypeError(
  'Failed to fetch dynamically imported module: https://centralcity.ai/assets/App-AbCd1234.js',
);

test('vercel.json: HTML is revalidated (no-cache); hashed assets cached for good; API untouched', () => {
  const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
    headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
  };
  const cacheFor = (path: string) => {
    let value: string | undefined;
    for (const rule of vercel.headers)
      if (new RegExp(`^${rule.source}$`).test(path))
        for (const h of rule.headers) if (h.key.toLowerCase() === 'cache-control') value = h.value;
    return value;
  };
  for (const path of ['/', '/index.html', '/app.html', '/rooms/abc', '/settings', '/privacy'])
    assert.equal(cacheFor(path), 'no-cache', path);
  // Hashed build assets never change under the same name: cached for a year.
  assert.equal(cacheFor('/assets/index-abc123.js'), 'public, max-age=31536000, immutable');
  for (const path of ['/api/elric', '/mcp', '/mcp/open', '/oauth/token', '/j/abc', '/a2a/x'])
    assert.equal(cacheFor(path), undefined, path);
  assert.equal(cacheFor('/llms.txt'), 'public, max-age=3600', 'specific rules still win');
});

/** A failed import nothing caught: the browser reports the rejection. */
function unhandled(reason: unknown) {
  const event = new Event('unhandledrejection') as Event & { reason?: unknown };
  event.reason = reason;
  fakeWindow.dispatchEvent(event);
}
/** A stale chunk on a fresh page: Vite reports it, and nobody handles the import. */
function staleImport(error: unknown = stale) {
  const event = preloadError(error);
  unhandled(error);
  return event;
}

beforeEach(() => {
  store.clear();
  storageThrows = false;
  reloads = 0;
  newPage();
});

test('recognizes chunk failures from Chrome, Safari, Firefox and CSS preloads only', () => {
  assert.equal(isChunkLoadError(stale), true);
  assert.equal(isChunkLoadError(new TypeError('Importing a module script failed.')), true);
  assert.equal(isChunkLoadError(new TypeError('error loading dynamically imported module')), true);
  assert.equal(isChunkLoadError(new Error('Unable to preload CSS for /assets/a.css')), true);
  assert.equal(isChunkLoadError(new TypeError('x is undefined')), false);
  // Values that are not errors never throw.
  for (const value of [undefined, null, 42, Symbol('x'), Object.create(null), { a: 1 }])
    assert.equal(isChunkLoadError(value), false);
  unhandled(Object.create(null));
  assert.equal(timers.length, 0);
});

test('a failed import nobody handles reloads the page once', () => {
  const event = staleImport();
  // Not prevented: the error still reaches the lazy screen's boundary or the caller's fallback.
  assert.equal(event.defaultPrevented, false);
  // The boundary catching the same failure does not schedule a second reload.
  assert.equal(chunkReloadAvailable(), true);
  assert.equal(requestChunkReload(), true);
  staleImport();
  assert.equal(timers.length, 1);
  assert.equal(timers[0]!.delay, 0);
  runTimers();
  assert.equal(reloads, 1);
});

test('a failure Vite reports with another message still counts once unhandled', () => {
  staleImport(new Error('Network error'));
  assert.equal(timers.length, 1);
});

test('an optional chunk with its own fallback (handled) does not reload', () => {
  preloadError(stale);
  assert.equal(timers.length, 0);
});

test('a chunk that keeps failing stops reloading after the budget: no loop', () => {
  for (let page = 0; page < 10; page += 1) {
    newPage();
    staleImport();
    requestChunkReload();
    runTimers();
  }
  assert.equal(reloads, RELOAD_DELAYS_MS.length);
  // The boundary then shows the error state with its Reload button.
  newPage();
  assert.equal(chunkReloadAvailable(), false);
  assert.equal(requestChunkReload(), false);
});

test('the reloads back off, and a later incident gets a fresh budget', () => {
  const delays: number[] = [];
  for (let page = 0; page < RELOAD_DELAYS_MS.length; page += 1) {
    newPage();
    staleImport();
    delays.push(timers[0]!.delay);
  }
  assert.deepEqual(delays, RELOAD_DELAYS_MS);
  const [, last] = store.get('cc.chunkReload')!.split('@');
  store.set('cc.chunkReload', `${RELOAD_DELAYS_MS.length}@${Number(last) - RELOAD_WINDOW_MS - 1}`);
  newPage();
  assert.equal(requestChunkReload(), true);
});

test('the window counts from the last reload: a chunk failing every 25 s still stops', (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  for (let page = 0; page < 10; page += 1) {
    newPage();
    staleImport();
    runTimers();
    now += 25_000; // each failure is under the window after the previous reload, not the first
  }
  assert.equal(reloads, RELOAD_DELAYS_MS.length);
  newPage();
  assert.equal(chunkReloadAvailable(), false);
});

test('without sessionStorage the page never reloads by itself', () => {
  storageThrows = true;
  staleImport();
  assert.equal(timers.length, 0);
  assert.equal(chunkReloadAvailable(), false);
  assert.equal(requestChunkReload(), false);
});

test('an unhandled error that is not a missing chunk does not reload', () => {
  unhandled(new TypeError('x is undefined'));
  assert.equal(timers.length, 0);
});

test('a failed chunk is refetched past the browser cache before the reload (a stored 404 is replaced)', async () => {
  newPage();
  store.clear();
  reloads = 0;
  const fetched: Array<{ url: string; cache?: string }> = [];
  const win = fakeWindow as typeof fakeWindow & {
    fetch?: (url: string, init?: RequestInit) => Promise<unknown>;
    location: { reload: () => number; origin?: string };
  };
  win.location.origin = 'https://centralcity.ai';
  win.fetch = async (url, init) => {
    fetched.push({ url, cache: init?.cache });
    return {};
  };
  try {
    const css = new Error(
      'Unable to preload CSS for https://centralcity.ai/assets/App-B5Vw_7VI.css',
    );
    assert.equal(requestChunkReload(css), true);
    runTimers();
    // The reload waits for the refetch.
    assert.equal(reloads, 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(fetched, [
      { url: 'https://centralcity.ai/assets/App-B5Vw_7VI.css', cache: 'reload' },
    ]);
    assert.equal(reloads, 1);
  } finally {
    delete win.fetch;
    delete win.location.origin;
  }
});

test("only this site's /assets/ URLs are ever refetched", () => {
  const origin = 'https://centralcity.ai';
  assert.deepEqual(
    failedAssetUrls(
      new TypeError(
        'Failed to fetch dynamically imported module: https://centralcity.ai/assets/App-AbCd1234.js',
      ),
      origin,
    ),
    ['https://centralcity.ai/assets/App-AbCd1234.js'],
  );
  assert.deepEqual(
    failedAssetUrls(
      new Error('Unable to preload CSS for https://evil.example/assets/x.css'),
      origin,
    ),
    [],
  );
  assert.deepEqual(
    failedAssetUrls(new Error('Unable to preload CSS for https://centralcity.ai/api/x'), origin),
    [],
  );
  assert.deepEqual(failedAssetUrls(Object.create(null), origin), []);
});

test('without fetch (or nothing to refetch) the reload happens at once, as before', () => {
  newPage();
  store.clear();
  reloads = 0;
  assert.equal(requestChunkReload(new Error('ChunkLoadError')), true);
  runTimers();
  assert.equal(reloads, 1);
});
