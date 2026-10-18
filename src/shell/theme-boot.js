/*
 * Runs in <head> before the first paint (a classic, blocking script; vite.config.ts
 * `themeBoot` adds it with a hashed name). The public pages arrive prerendered inside #root, so
 * they paint before the app's module script runs; without this, a visitor who picked dark saw
 * the light page until the app applied the theme. Same rule as src/shell/theme.ts
 * getStoredThemePreference and getSystemTheme: ?theme=dark|light, else the stored choice, else
 * the device's light/dark setting (prefers-color-scheme). The app's applyStoredTheme
 * (src/main.tsx) then sets the rest (meta tags, toggle labels) and follows live changes of the
 * device setting while no theme is chosen.
 */
(function () {
  var theme = '';
  try {
    var query = new URLSearchParams(location.search).get('theme');
    var stored = localStorage.getItem('cc-theme');
    if (query === 'dark' || query === 'light') theme = query;
    else if (stored === 'dark' || stored === 'light') theme = stored;
  } catch (error) {
    // No storage (private mode, blocked): follow the device setting.
  }
  if (!theme) {
    try {
      theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (error) {
      theme = 'light';
    }
  }
  document.documentElement.dataset.theme = theme;
  // The hero's counts count in from 0 once the app runs (src/AgentTicker.tsx): keep the
  // prerendered digits hidden until then (src/landing/landing.css), except with reduced motion,
  // where the number simply shows. The app removes this marker when it mounts.
  try {
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches)
      document.documentElement.dataset.countIn = '1';
  } catch (error) {
    // No matchMedia: show the number.
  }
  document.documentElement.style.colorScheme = theme;
  // The home, Elric, Connect and Invite pages arrive with their signed-out copy
  // (#root[data-session-gated], shared/share-cards.ts). A browser that was signed in last time
  // (src/shell/prerendered.ts rememberSignedIn), or the home page opened at sign-in or Connect,
  // will show something else: hide that copy before the first paint (src/styles.css) instead of
  // flashing it. src/shell/prerendered.ts then drops it.
  var app = false;
  try {
    app = localStorage.getItem('cc-signed-in') === '1';
  } catch (error) {
    // No storage: show the copy.
  }
  if (/^#(signin|create|connect|claim=)/.test(location.hash)) app = true;
  if (app) document.documentElement.dataset.boot = 'app';
})();
