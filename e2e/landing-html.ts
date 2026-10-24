import type { BrowserContext, Page } from '@playwright/test';

/*
 * The landing's prerendered agent count and Base agents number (scripts/prerender/agent-count.ts)
 * depend on the build: a plain `pnpm build` reads production's numbers, CC_BUILD_AGENT_COUNT (and
 * CC_BUILD_BASE_AGENTS) fixes them, and an unreachable endpoint gives none. They sit in the "AI
 * agents joined" and "Central City base agents" cells of the live numbers
 * (src/landing/LiveNumbers.tsx). The specs that drive the client's own fetching serve "/" with
 * known cells instead, so they behave the same whatever the build had.
 */

/** The agents cell in the prerendered HTML (its children are a <dt> and a <dd> only). */
export const PRERENDERED_AGENTS = /<div class="cc-kc" data-stat="agents"[^>]*>[\s\S]*?<\/div>/;

/** The Base agents cell in the prerendered HTML (a <dt> and a <dd> only). */
export const PRERENDERED_BASE = /<div class="cc-kc" data-stat="base"[^>]*>[\s\S]*?<\/div>/;

/** The live numbers' sentence for screen readers, as prerendered. */
export const PRERENDERED_SENTENCE =
  /<p class="visually-hidden">(?:(?:Live on Central City|Central City, last known): [^<]*|Numbers of Central City\.)<\/p>/;

/** The cell as built without a count: a dash. */
export const EMPTY_AGENTS =
  '<div class="cc-kc" data-stat="agents" data-agent-ticker="true">' +
  '<dt>AI agents joined</dt><dd>–</dd></div>';
const EMPTY_SENTENCE = '<p class="visually-hidden">Numbers of Central City.</p>';

/** The Base agents cell as built without a number: a dash. */
export const EMPTY_BASE =
  '<div class="cc-kc" data-stat="base"><dt>Central City base agents</dt><dd>–</dd></div>';

/** The Base agents cell as built with `total`. */
export function builtBase(total: number, at: string): string {
  return (
    `<div class="cc-kc" data-stat="base" data-build-base="${total}" data-build-base-at="${at}">` +
    `<dt>Central City base agents</dt><dd>${total.toLocaleString('en-US')}</dd></div>`
  );
}

/** The cell as built with `total` (as LiveNumbers renders it in the prerender). */
export function builtAgents(total: number, at: string): string {
  return (
    `<div class="cc-kc" data-stat="agents" data-agent-ticker="true"` +
    ` data-build-count="${total}" data-build-at="${at}">` +
    `<dt>AI agents joined</dt><dd>${total.toLocaleString('en-US')}</dd></div>`
  );
}

/** The sentence as built with `total` agents (and `base` Base agents, when given). */
export function builtSentence(total: number | null, base: number | null = null): string {
  const parts = [
    base !== null ? `${base.toLocaleString('en-US')} Central City base agents` : null,
    total !== null ? `${total.toLocaleString('en-US')} AI agents joined` : null,
  ].filter(Boolean);
  return parts.length
    ? `<p class="visually-hidden">Central City, last known: ${parts.join(', ')}.</p>`
    : EMPTY_SENTENCE;
}

/**
 * Serves "/" as built, with its agents and Base agents cells replaced: `build` gives the build's
 * count and `base` its Base agents number, null (default) the dash, so the specs see the same
 * page whatever production had at build time.
 */
export async function landingWithAgents(
  page: Page | BrowserContext,
  build: { total: number; at: string } | null = null,
  base: { total: number; at: string } | null = null,
): Promise<void> {
  await page.route(
    (url) => url.pathname === '/',
    async (route) => {
      const response = await route.fetch();
      const html = await response.text();
      if (
        !PRERENDERED_AGENTS.test(html) ||
        !PRERENDERED_BASE.test(html) ||
        !PRERENDERED_SENTENCE.test(html)
      )
        throw new Error('landingWithAgents: no live numbers in "/"');
      const cell = build ? builtAgents(build.total, build.at) : EMPTY_AGENTS;
      const baseCell = base ? builtBase(base.total, base.at) : EMPTY_BASE;
      const sentence = builtSentence(build?.total ?? null, base?.total ?? null);
      await route.fulfill({
        response,
        body: html
          .replace(PRERENDERED_AGENTS, () => cell)
          .replace(PRERENDERED_BASE, () => baseCell)
          .replace(PRERENDERED_SENTENCE, () => sentence),
      });
    },
  );
}

/** GET /api/session as a signed-out visitor of an installation that has an owner. */
export async function signedOutSession(page: Page | BrowserContext): Promise<void> {
  await page.route('**/api/session', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ operator: null, setupRequired: false }),
        })
      : route.fallback(),
  );
}
