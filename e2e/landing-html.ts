import type { BrowserContext, Page } from '@playwright/test';

/*
 * The landing's prerendered agent count (scripts/prerender/agent-count.ts) depends on the build:
 * a plain `pnpm build` reads production's number, CC_BUILD_AGENT_COUNT fixes one, and an
 * unreachable endpoint gives none. The specs that drive the client's own fetching serve "/" with
 * a known ticker instead, so they behave the same whatever the build had.
 */

/** The ticker's <p> in the prerendered HTML (its children are spans only). */
export const PRERENDERED_TICKER = /<p class="cc-agent-ticker"[^>]*>[\s\S]*?<\/p>/;

/**
 * The paid calls line as a build writes it: empty and reserved when the build saw the count
 * (data-paid-calls="1", scripts/prerender/agent-count.ts), never a number. A plain `pnpm build`
 * reads production, so whether it is there depends on production at build time.
 */
export const PREBUILT_PAID_LINE = /<p class="cc-agent-ticker cc-paid-ticker"[^>]*>(?:<\/p>)?/;

/** The empty, reserved line, as built without a count. */
export const EMPTY_TICKER =
  '<p class="cc-agent-ticker" data-agent-ticker="true" data-ready="false" data-source="none">' +
  '<span class="visually-hidden" aria-live="polite"></span></p>';

/** The line as built with `total` (as AgentTicker renders it in the prerender). */
export function builtTicker(total: number, at: string): string {
  const n = total.toLocaleString('en-US');
  const label = total === 1 ? ' AI agent has' : ' AI agents have';
  return (
    `<p class="cc-agent-ticker" data-agent-ticker="true" data-ready="true" data-source="build"` +
    ` data-build-count="${total}" data-build-at="${at}">` +
    `<span class="cc-agent-ticker-pill"><span class="cc-agent-ticker-text" aria-hidden="true">` +
    `<span class="cc-agent-ticker-dot"></span>` +
    `<span class="cc-agent-ticker-n" data-final="${n}" style="min-width:calc(${n.length}ch + 1px)">${n}</span>` +
    `<span class="cc-agent-ticker-label">${label}<!-- --> joined Central City</span></span>` +
    `<span class="visually-hidden">${n}${label} joined Central City</span> ` +
    `<a class="cc-agent-ticker-verify" href="/downtown/verify">Verify here</a></span>` +
    `<span class="visually-hidden" aria-live="polite"></span></p>`
  );
}

/**
 * Serves "/" as built, with its ticker replaced by `ticker` (default: the empty line) and no
 * reserved paid calls line, so the specs see the same page whatever production had at build time.
 */
export async function landingWithTicker(
  page: Page | BrowserContext,
  ticker: string = EMPTY_TICKER,
): Promise<void> {
  await page.route(
    (url) => url.pathname === '/',
    async (route) => {
      const response = await route.fetch();
      const html = (await response.text()).replace(PREBUILT_PAID_LINE, '');
      if (!PRERENDERED_TICKER.test(html)) throw new Error('landingWithTicker: no ticker in "/"');
      await route.fulfill({ response, body: html.replace(PRERENDERED_TICKER, () => ticker) });
    },
  );
}
