/*
 * Public content pages arrive with their markup already inside #root (scripts/prerender, built
 * by vite.config.ts), so crawlers read their text. The client mounts with createRoot, which
 * replaces that markup. Until the page's chunk has loaded, the loading fallback shows the same
 * markup instead of the boot screen, so the page does not flash.
 */

let markup = '';
let container: HTMLElement | null = null;

const SIGNED_IN_KEY = 'cc-signed-in';

/**
 * Reads the prerendered markup once, before React mounts. A session-gated page's signed-out copy
 * that src/shell/theme-boot.js hid (a browser signed in last time) is dropped: the boot screen
 * shows while the session answers, as before.
 */
export function capturePrerendered(root: HTMLElement) {
  container = root;
  if (root.hasAttribute('data-session-gated') && document.documentElement.dataset.boot === 'app') {
    root.removeAttribute('data-session-gated');
    root.replaceChildren();
    markup = '';
    return;
  }
  markup = root.innerHTML.trim();
}

/** Remembered for theme-boot.js: whether this browser's last session answer was signed in. */
export function rememberSignedIn(signedIn: boolean) {
  try {
    if (signedIn) window.localStorage.setItem(SIGNED_IN_KEY, '1');
    else window.localStorage.removeItem(SIGNED_IN_KEY);
  } catch {
    // No storage: the signed-out copy shows until the session answers.
  }
}

/** The markup the page arrived with, until the first screen has rendered. */
export function prerendered() {
  return markup;
}

/**
 * The first screen is on (or failed): later loading states show the boot screen, and `#root` is
 * no longer marked busy and disabled (shared/share-cards.ts withPrerenderedRoot). Until then its
 * buttons and fields are the static copy's, which do nothing.
 */
export function releasePrerendered() {
  markup = '';
  container?.removeAttribute('aria-busy');
  container?.removeAttribute('aria-disabled');
  container?.removeAttribute('data-session-gated');
  container = null;
}
