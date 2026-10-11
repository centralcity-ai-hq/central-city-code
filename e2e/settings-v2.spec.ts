import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { openSettingsSection } from './settings-nav';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AssistantGrant } from '../shared/assistant';
import type { CityEvent, Snapshot } from '../shared/types';
import { workspaceTarget } from './workspace-density';

/*
 * Workspace v2 Settings (?workspace=v2): one header and section rail around Connected apps,
 * Data & export, Activity log and Account; Account shows only real fields. Screenshots go to
 * the test output, or to SETTINGS_V2_SHOTS when set (local review only, never committed).
 */

const headers = { 'X-City-Request': '1' };
const SECTIONS = ['Connected apps', 'Data & export', 'Activity log', 'Account'] as const;

async function register(page: Page) {
  const name = `Settings-v2-${randomUUID().slice(0, 8)}`;
  const response = await page.request.post('/api/auth/register', {
    headers,
    data: { name, password: 'Local-test-only-passphrase-2026' },
  });
  expect(response.status()).toBe(201);
  return name;
}

function grant(overrides: Partial<AssistantGrant> = {}): AssistantGrant {
  const now = Date.now();
  return {
    id: 'test-grant-0001',
    label: 'Desktop research app',
    scopes: ['workspace:read', 'messages:read', 'messages:send'],
    createdAt: new Date(now - 86_400_000).toISOString(),
    expiresAt: new Date(now + 29 * 86_400_000).toISOString(),
    renewal: 'rolling',
    endsAtLatest: new Date(now + 300 * 86_400_000).toISOString(),
    lastUsedAt: new Date(now - 12 * 60_000).toISOString(),
    revokedAt: null,
    ...overrides,
  };
}

function event(index: number, type: string, message: string): CityEvent {
  return {
    id: `settings-v2-event-${index}`,
    type,
    message,
    agentId: null,
    jobId: null,
    createdAt: new Date(Date.now() - index * 600_000).toISOString(),
  };
}

const EVENTS = [
  event(1, 'connection.authorized', 'Connection allowed from Build worker to Report queue.'),
  event(2, 'job.completed', 'Report queue returned an answer for “Summarise telemetry”.'),
  event(3, 'agent.registered', 'Agent Build runner was added.'),
  event(4, 'assistant.granted', 'Desktop research app was given access.'),
  event(5, 'job.submitted', 'Build worker asked Report queue for a changelog summary.'),
];

async function withActivity(page: Page) {
  const state = (await (await page.request.get('/api/snapshot')).json()) as Snapshot;
  // Fixed events: the stream would only add unrelated invalidations.
  await page.route('**/api/events*', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({ json: { ...state, events: EVENTS } }),
  );
}

async function withGoogle(page: Page, linked: boolean) {
  await page.route('**/api/auth/google', (route) =>
    route.fulfill({
      json: {
        enabled: true,
        linked: linked
          ? { email: 'person@example.com', hd: null, linked_at: '2026-09-28T10:00:00.000Z' }
          : null,
      },
    }),
  );
  await page.route('**/api/elric/age', (route) =>
    route.fulfill({
      json: { date_of_birth: '1990-04-12', age_check: 'over_18', locked: false },
    }),
  );
}

/** Opens Connected apps the way a person does: Account → Settings → the section rail. */
async function openFromAccountMenu(page: Page, theme = 'light') {
  await page.goto(`/?workspace=v2&theme=${theme}#connect`);
  await expect(page.locator('.app-shell')).toBeVisible();
  await openSettingsSection(page, 'Connected apps');
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
}

const rail = (page: Page) => page.getByRole('navigation', { name: 'Settings sections' });

async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

/**
 * Exactly one rail item is current (aria-current="page"), it is the expected section, it sits
 * fully inside the rail (the phone strip scrolls it into view), and no other item shares its
 * look (a hover or focus left on another item must not read as current).
 */
async function currentSection(page: Page, label: (typeof SECTIONS)[number]) {
  const nav = rail(page);
  const current = nav.locator('[aria-current="page"]');
  await expect(current).toHaveCount(1);
  await expect(current).toHaveText(label);
  await expect
    .poll(async () => {
      const [strip, item] = await Promise.all([nav.boundingBox(), current.boundingBox()]);
      return Boolean(
        strip && item && item.x >= strip.x - 1 && item.x + item.width <= strip.x + strip.width + 1,
      );
    })
    .toBe(true);
  const looks = await nav.getByRole('button').evaluateAll((items) =>
    items.map((item) => ({
      current: item.getAttribute('aria-current') === 'page',
      background: getComputedStyle(item).backgroundColor,
    })),
  );
  const active = looks.find((item) => item.current)!.background;
  for (const item of looks.filter((entry) => !entry.current))
    expect(item.background, 'a non-current section looks current').not.toBe(active);
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
  const dir = process.env.SETTINGS_V2_SHOTS;
  const path = dir ? join(dir, `${name}.png`) : testInfo.outputPath(`${name}.png`);
  await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

test('the section rail moves between all four sections and back, keeping one current item', async ({
  page,
}) => {
  const name = await register(page);
  await withActivity(page);
  await openFromAccountMenu(page);
  const nav = rail(page);
  for (const label of SECTIONS)
    await expect(nav.getByRole('button', { name: label, exact: true })).toBeVisible();
  await expect(nav.locator('[aria-current="page"]')).toHaveText('Connected apps');
  await expect(page.getByRole('heading', { name: 'Connected apps', level: 2 })).toBeVisible();

  await nav.getByRole('button', { name: 'Data & export', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Data & export', exact: true })).toBeVisible();
  await expect(nav.locator('[aria-current="page"]')).toHaveText('Data & export');

  await nav.getByRole('button', { name: 'Activity log', exact: true }).click();
  const log = page.getByRole('region', { name: 'Activity log', exact: true });
  await expect(log.getByRole('listitem')).toHaveCount(EVENTS.length);

  await nav.getByRole('button', { name: 'Account', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/account$/);
  const account = page.getByRole('region', { name: 'Account', exact: true });
  await expect(account.getByText(name, { exact: true })).toBeVisible();
  await expect(rail(page).locator('[aria-current="page"]')).toHaveText('Account');
  // Only fields the account has: no handle, no session list.
  await expect(account).not.toContainText(/handle|sessions/i);

  await rail(page).getByRole('button', { name: 'Connected apps', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connected apps', level: 2 })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/settings\/account$/);
  await expect(page.getByRole('region', { name: 'Account', exact: true })).toBeVisible();
});

test('Activity log filters narrow the loaded events by area and say what they show', async ({
  page,
}) => {
  await register(page);
  await withActivity(page);
  await openFromAccountMenu(page);
  await rail(page).getByRole('button', { name: 'Activity log', exact: true }).click();
  const log = page.getByRole('region', { name: 'Activity log', exact: true });
  const filters = log.getByRole('group', { name: 'Show events from' });
  await expect(filters.getByRole('button')).toHaveText([
    'All (5)',
    'Exchanges (2)',
    'Connections (1)',
    'Agents (1)',
    'Account (1)',
  ]);
  await filters.getByRole('button', { name: 'Exchanges (2)' }).click();
  await expect(filters.getByRole('button', { name: 'Exchanges (2)' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(log.getByRole('listitem')).toHaveCount(2);
  await expect(log.getByRole('status')).toHaveText('2 of 5 recent events');
  await filters.getByRole('button', { name: 'All (5)' }).click();
  await expect(log.getByRole('listitem')).toHaveCount(5);
  await expect(log.getByRole('status')).toHaveText('5 recent events');
});

test('Account unlinks Google only after a confirmation that states the 30-day rule', async ({
  page,
}) => {
  await register(page);
  await withGoogle(page, true);
  let unlinks = 0;
  await page.route('**/api/auth/google/unlink', async (route) => {
    unlinks += 1;
    if (unlinks === 1)
      await route.fulfill({
        status: 409,
        json: {
          error: 'This account signs in with Google only, so it stays linked.',
          code: 'google_only',
        },
      });
    else await route.fulfill({ json: { linked: null } });
  });
  await page.goto('/settings/account?workspace=v2');
  const account = page.getByRole('region', { name: 'Account', exact: true });
  await expect(account).toContainText('person@example.com');
  await expect(account).toContainText('30 days');
  await expect(account.getByText('Verified', { exact: true })).toBeVisible();
  const opener = account.getByRole('button', { name: 'Unlink Google', exact: true });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Unlink Google?', exact: true });
  await expect(dialog).toContainText('30 days');
  await expect(dialog).toContainText('date of birth');
  await expect(dialog).toContainText('Elric stops working for you until you link Google again.');
  expect(unlinks).toBe(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();

  await opener.click();
  await dialog.getByRole('button', { name: 'Unlink Google', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    'This account signs in with Google only, so it stays linked.',
  );
  await dialog.getByRole('button', { name: 'Unlink Google', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  // The section reads the account again meanwhile (its loading lines are statuses too).
  await expect(
    account.getByRole('status').filter({ hasText: 'Google account unlinked.' }),
  ).toHaveText('Google account unlinked.');
  await expect(account.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  expect(unlinks).toBe(2);
});

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1440, 390]) {
    test(`settings sections fit ${width}px in ${theme} with 44px targets`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await register(page);
      await withActivity(page);
      await withGoogle(page, true);
      await page.route('**/api/assistant-access', (route) =>
        route.fulfill({
          json: {
            grants: [
              grant(),
              grant({
                id: 'test-grant-0002',
                label: 'Editor assistant',
                scopes: ['workspace:read', 'agents:create', 'jobs:create'],
                renewal: 'fixed',
                endsAtLatest: null,
                lastUsedAt: null,
              }),
            ],
          },
        }),
      );
      await openFromAccountMenu(page, theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const nav = rail(page);
      for (const label of SECTIONS) {
        const box = (await nav.getByRole('button', { name: label, exact: true }).boundingBox())!;
        expect(box.height).toBeGreaterThanOrEqual(workspaceTarget(width));
      }
      const revoke = page.getByRole('button', {
        name: 'Remove access for Desktop research app',
        exact: true,
      });
      await expect(revoke).toBeVisible();
      expect((await revoke.boundingBox())!.height).toBeGreaterThanOrEqual(workspaceTarget(width));
      await currentSection(page, 'Connected apps');
      await noHorizontalScroll(page);
      await shot(page, testInfo, `settings-connected-apps-${width}-${theme}`);

      await nav.getByRole('button', { name: 'Data & export', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Data & export', exact: true })).toBeVisible();
      await currentSection(page, 'Data & export');
      await noHorizontalScroll(page);
      await shot(page, testInfo, `settings-data-export-${width}-${theme}`);

      await nav.getByRole('button', { name: 'Activity log', exact: true }).click();
      const log = page.getByRole('region', { name: 'Activity log', exact: true });
      await expect(log.getByRole('listitem')).toHaveCount(EVENTS.length);
      for (const filter of await log.getByRole('group').getByRole('button').all())
        expect((await filter.boundingBox())!.height).toBeGreaterThanOrEqual(workspaceTarget(width));
      await currentSection(page, 'Activity log');
      await noHorizontalScroll(page);
      await shot(page, testInfo, `settings-activity-log-${width}-${theme}`);

      await nav.getByRole('button', { name: 'Account', exact: true }).click();
      const account = page.getByRole('region', { name: 'Account', exact: true });
      await expect(account).toContainText('person@example.com');
      const unlink = account.getByRole('button', { name: 'Unlink Google', exact: true });
      expect((await unlink.boundingBox())!.height).toBeGreaterThanOrEqual(workspaceTarget(width));
      await currentSection(page, 'Account');
      await noHorizontalScroll(page);
      await shot(page, testInfo, `settings-account-${width}-${theme}`);
    });
  }
}
