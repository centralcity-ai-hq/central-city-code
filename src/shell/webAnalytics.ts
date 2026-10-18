/*
 * Vercel Web Analytics (cookieless page views, docs/PRIVACY: "Website statistics"). Loaded only on
 * the production host: the script is served by Vercel at /_vercel/insights (same origin, so the
 * CSP's script-src 'self' covers it); on localhost, previews and e2e it does not exist.
 *
 * Before a view is sent, its URL is reduced to the page kind: the query and the fragment are
 * dropped (join codes and private manage codes live there) and path segments that name one
 * thing become ":id", so no room, agent, request or passport number leaves the browser.
 */

export const ANALYTICS_HOSTS = new Set(['centralcity.ai', 'www.centralcity.ai']);
const SCRIPT_SRC = '/_vercel/insights/script.js';

/** Sections whose sub-pages are public, fixed pages (their names may be reported). */
const PUBLIC_SECTIONS = new Set(['docs', 'help', 'explorer', 'trust']);
const WORD = /^[a-z]+(?:-[a-z]+)*$/;

/**
 * The URL a page view reports: origin + path, no query, no fragment. The first segment stays
 * when it is a plain word (the page kind); deeper segments stay only under PUBLIC_SECTIONS, and
 * everything else (room slugs, ids, codes, passport numbers) becomes ":id".
 */
export function analyticsUrl(href: string): string {
  const url = new URL(href);
  const parts = url.pathname.split('/').filter(Boolean);
  const section = parts[0] ?? '';
  const kept = parts.map((part, i) => {
    const word = WORD.test(part);
    if (i === 0) return word ? part : ':id';
    return word && PUBLIC_SECTIONS.has(section) ? part : ':id';
  });
  return `${url.origin}/${kept.join('/')}`;
}

type AnalyticsEvent = { type: string; url: string };
type VaFn = ((...args: unknown[]) => void) & { q?: unknown[] };
declare global {
  interface Window {
    va?: VaFn;
    vaq?: unknown[];
  }
}

/** Adds the analytics script once, on the production host only. */
export function installWebAnalytics(win: Window = window): void {
  if (!ANALYTICS_HOSTS.has(win.location.hostname)) return;
  if (win.document.querySelector(`script[src="${SCRIPT_SRC}"]`)) return;
  win.va =
    win.va ??
    ((...args: unknown[]) => {
      (win.vaq = win.vaq ?? []).push(args);
    });
  win.va('beforeSend', (event: AnalyticsEvent) => ({ ...event, url: analyticsUrl(event.url) }));
  const script = win.document.createElement('script');
  script.src = SCRIPT_SRC;
  script.defer = true;
  win.document.head.appendChild(script);
}
