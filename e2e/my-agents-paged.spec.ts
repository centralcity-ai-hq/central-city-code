import { expect, test, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Agent, AgentListPage, Snapshot } from '../shared/types';
import { mockFeed } from './feed-fixtures';
import { openAdvancedGroup } from './settings-nav';

/*
 * My agents in a workspace of more than 500 agents (shared/agent-pages.ts): the snapshot carries
 * the newest 100 with the total, Load more reads older pages from GET /api/agents, and the search
 * asks the server, which searches every agent. A workspace that is not paged reads nothing more.
 * The agents and those reads are synthetic fixtures served through page.route; the account is real.
 */

const headers = { 'X-City-Request': '1' };
const password = 'Local-test-only-passphrase-2026';
const TOTAL = 1234;

function agent(index: number, overrides: Partial<Agent> = {}): Agent {
  const at = new Date(Date.UTC(2026, 9, 15, 8) - index * 60_000).toISOString();
  return {
    id: randomUUID(),
    name: `Agent ${String(index).padStart(4, '0')}`,
    description: '',
    capability: 'research',
    mode: 'external',
    isDemo: false,
    status: 'offline',
    lastSeenAt: null,
    createdAt: at,
    revokedAt: null,
    ...overrides,
  };
}

const first = Array.from({ length: 100 }, (_, index) => agent(index + 1));
const second = Array.from({ length: 100 }, (_, index) => agent(index + 101));
const harbour = agent(900, { name: 'Harbour filings reader', description: 'Reads filings.' });

async function register(page: Page) {
  const registered = await page.request.post('/api/auth/register', {
    headers,
    data: { name: `Paged-${randomUUID().slice(0, 8)}`, password },
  });
  expect(registered.status()).toBe(201);
  return (await (await page.request.get('/api/snapshot')).json()) as Snapshot;
}

async function quietRoutes(page: Page) {
  await page.route('**/api/events*', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/rooms', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { rooms: [] } }) : route.fallback(),
  );
  await page.route('**/api/v2/connections/requests**', (route) =>
    route.fulfill({ json: { incoming: [], outgoing: [], next_before: null } }),
  );
  await page.route('**/api/agents/*/totals', (route) =>
    route.fulfill({ json: { tasks_done: 0, messages_sent: 0 } }),
  );
}

/** A paged workspace: the snapshot, and GET /api/agents answering pages, searches and ids. */
async function pagedFixture(page: Page) {
  const baseline = await register(page);
  const snapshot: Snapshot = {
    ...baseline,
    agents: first,
    agentsPage: {
      total: TOTAL,
      live: TOTAL,
      online: 0,
      limit: 100,
      count: 100,
      nextCursor: 'cursor-page-2',
    },
    stats: { ...baseline.stats, registered: TOTAL },
  };
  const reads: URLSearchParams[] = [];
  await quietRoutes(page);
  await page.route(/\/api\/snapshot(\?.*)?$/, (route) => route.fulfill({ json: snapshot }));
  await page.route(/\/api\/agents(\?.*)?$/, (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const params = new URL(route.request().url()).searchParams;
    reads.push(params);
    const answer = (agents: Agent[], matched: number, nextCursor: string | null) =>
      route.fulfill({
        json: { agents, total: TOTAL, matched, limit: 100, nextCursor } satisfies AgentListPage,
      });
    if (params.get('q')) {
      const needle = params.get('q')!.toLowerCase();
      const found = [...first, ...second, harbour].filter((item) =>
        item.name.toLowerCase().includes(needle),
      );
      return answer(found, found.length, null);
    }
    if (params.get('ids'))
      return answer(
        [...first, ...second, harbour].filter((item) =>
          params.get('ids')!.split(',').includes(item.id),
        ),
        1,
        null,
      );
    if (params.get('under')) return answer([], 0, null);
    if (params.get('cursor') === 'cursor-page-2') return answer(second, TOTAL, null);
    return answer(first, TOTAL, 'cursor-page-2');
  });
  return reads;
}

async function openMyAgents(page: Page) {
  await page.goto('/?workspace=v2&theme=light#connect');
  await expect(page.locator('.app-shell')).toBeVisible();
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole('navigation', { name: 'Workspace', exact: true })
    .getByRole('button', { name: /^My agents/ })
    .first()
    .click();
  return page.getByRole('region', { name: 'Agents', exact: true });
}

const rows = (list: ReturnType<Page['getByRole']>) =>
  list
    .getByRole('list', { name: 'Agents', exact: true })
    .getByRole('button', { name: /^Agent \d{4}, / });

test('a paged workspace lists 100 agents of all, loads older ones, and shows the total', async ({
  page,
}) => {
  const reads = await pagedFixture(page);
  const list = await openMyAgents(page);
  await expect(list.getByText('Showing 100 of 1,234 agents')).toBeVisible();
  await expect(rows(list)).toHaveCount(100);
  await list.getByRole('button', { name: 'Load more', exact: true }).click();
  await expect(list.getByText('Showing 200 of 1,234 agents')).toBeVisible();
  await expect(rows(list)).toHaveCount(200);
  await expect(list.getByRole('button', { name: 'Agent 0200, ', exact: false })).toBeVisible();
  // The last page: nothing more to load.
  await expect(list.getByRole('button', { name: 'Load more', exact: true })).toHaveCount(0);
  expect(reads.some((params) => params.get('cursor') === 'cursor-page-2')).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('the search asks the server, finds an agent on no loaded page, and opens it', async ({
  page,
}) => {
  const reads = await pagedFixture(page);
  const list = await openMyAgents(page);
  await expect(rows(list)).toHaveCount(100);
  await list.getByRole('button', { name: 'Search agents', exact: true }).click();
  await list.getByRole('textbox', { name: 'Search agents' }).fill('harbour');
  await expect(list.getByText('1 of 1 match')).toBeVisible();
  const found = list.getByRole('button', { name: /^Harbour filings reader, / });
  await expect(found).toBeVisible();
  await expect(rows(list)).toHaveCount(0);
  expect(reads.some((params) => params.get('q') === 'harbour')).toBe(true);
  await found.click();
  await expect(
    page.getByRole('complementary', { name: 'Harbour filings reader details' }),
  ).toBeVisible();
  // Clearing the search shows the loaded page again.
  await list.getByRole('textbox', { name: 'Search agents' }).fill('');
  await expect(rows(list)).toHaveCount(100);
  await expect(list.getByText('Showing 100 of 1,234 agents')).toBeVisible();
});

test('a workspace that is not paged reads no pages and shows no pager', async ({ page }) => {
  const baseline = await register(page);
  const small: Snapshot = { ...baseline, agents: first.slice(0, 3) };
  const pageReads: string[] = [];
  await quietRoutes(page);
  await page.route(/\/api\/snapshot(\?.*)?$/, (route) => {
    pageReads.push(route.request().url());
    return route.fulfill({ json: small });
  });
  page.on('request', (request) => {
    if (request.method() === 'GET' && /\/api\/agents(\?|$)/.test(request.url()))
      pageReads.push(request.url());
  });
  const list = await openMyAgents(page);
  await expect(rows(list)).toHaveCount(3);
  await list.getByRole('button', { name: 'Search agents', exact: true }).click();
  await list.getByRole('textbox', { name: 'Search agents' }).fill('Agent 0002');
  await expect(rows(list)).toHaveCount(1);
  await expect(list.getByText(/Showing \d+ of/)).toHaveCount(0);
  await expect(list.getByRole('button', { name: 'Load more', exact: true })).toHaveCount(0);
  // Only the plain snapshot was read: no include=, no GET /api/agents.
  expect(pageReads.length).toBeGreaterThan(0);
  expect(
    pageReads.every((url) => new URL(url).pathname === '/api/snapshot' && !new URL(url).search),
  ).toBe(true);
});

/*
 * The pickers of an agent to act as, in a paged workspace: they start from the snapshot's newest
 * page and search every agent on the server (GET /api/agents?live=1&q=), so an older agent can
 * still be chosen. `harbour` is on no page the snapshot carries.
 */

test('a new room can be hosted by an older agent found with the search', async ({ page }) => {
  const reads = await pagedFixture(page);
  await page.goto('/rooms');
  await page.getByRole('button', { name: 'New room' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New room' });
  await dialog.locator('summary', { hasText: 'Host' }).click();
  const hosts = dialog.getByRole('radiogroup', { name: 'Host agent' });
  await expect(hosts.getByRole('radio')).toHaveCount(100);
  await expect(hosts.getByRole('radio', { name: harbour.name })).toHaveCount(0);
  await dialog.getByRole('searchbox', { name: 'Search all your agents' }).fill('harbour');
  const older = hosts.getByRole('radio', { name: harbour.name });
  await expect(older).toBeVisible();
  await older.check();
  await expect(dialog.locator('.rm-new-room-host-now')).toHaveText(harbour.name);
  expect(reads.some((params) => params.get('q') === 'harbour' && params.get('live') === '1')).toBe(
    true,
  );
  // Clearing the search keeps the chosen host offered, with the newest page.
  await dialog.getByRole('searchbox', { name: 'Search all your agents' }).fill('');
  await expect(hosts.getByRole('radio')).toHaveCount(101);
  await expect(hosts.getByRole('radio', { name: harbour.name })).toBeChecked();
});

test('a Feed request can be posted as an older agent found with the search', async ({ page }) => {
  await mockFeed(page);
  await pagedFixture(page);
  await page.goto('/feed/requests');
  await expect(page.getByRole('heading', { level: 1, name: 'Feed' })).toBeVisible();
  await page.getByRole('button', { name: 'Post a request' }).click();
  const form = page.getByRole('form', { name: 'Post a request' });
  const postAs = form.getByLabel('Post as');
  await expect(postAs.locator('option')).toHaveCount(101);
  await form.getByRole('searchbox', { name: 'Search all your agents' }).fill('harbour');
  await expect(postAs.locator('option', { hasText: harbour.name })).toHaveCount(1);
  await postAs.selectOption({ label: harbour.name });
  await expect(form).toContainText(`Posted as ${harbour.name}, your agent.`);
});

test('a new connection can name an older agent found with the search', async ({ page }) => {
  await pagedFixture(page);
  await page.goto('/#connect');
  await expect(page.locator('.app-shell')).toBeVisible();
  await (
    await openAdvancedGroup(page)
  )
    .getByRole('button', { name: 'Agent permissions', exact: true })
    .click();
  await page.locator('.perm3-topbar').getByRole('button', { name: 'New connection' }).click();
  const sheet = page.getByRole('dialog', { name: 'New connection' });
  const worker = sheet.getByLabel('Does the work');
  await expect(worker.locator('option', { hasText: harbour.name })).toHaveCount(0);
  await sheet.getByRole('searchbox', { name: 'Search all your agents' }).nth(1).fill('harbour');
  await expect(worker.locator('option', { hasText: harbour.name })).toHaveCount(1);
  await worker.selectOption({ label: harbour.name });
  await expect(sheet.locator('.perm3-say')).toContainText(harbour.name);
});
