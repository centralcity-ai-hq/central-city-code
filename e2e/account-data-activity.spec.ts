import { test, expect, type Download, type Page, type Request } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { openSettingsSection, workspaceSwitcher } from './settings-nav';
import type { CityEvent, Operator, Snapshot, WorkspaceExport } from '../shared/types';
import { workspaceTarget } from './workspace-density';

const headers = { 'X-City-Request': '1' };
type SettingsPage = 'Data & export' | 'Activity log';

async function register(page: Page): Promise<Operator> {
  const response = await page.request.post('/api/auth/register', {
    headers,
    data: {
      name: `Account-settings-${randomUUID().slice(0, 8)}`,
      password: 'Local-test-only-passphrase-2026',
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).operator;
}

async function snapshot(page: Page): Promise<Snapshot> {
  const response = await page.request.get('/api/snapshot');
  expect(response.status()).toBe(200);
  return response.json();
}

async function exportRecord(page: Page): Promise<WorkspaceExport> {
  const response = await page.request.get('/api/workspace/export');
  expect(response.status()).toBe(200);
  return response.json();
}

async function readDownload(download: Download): Promise<WorkspaceExport> {
  expect(download.suggestedFilename()).toMatch(/^central-city-workspace-\d{4}-\d{2}-\d{2}\.json$/);
  const file = await download.path();
  expect(file).toBeTruthy();
  return JSON.parse(await readFile(file!, 'utf8')) as WorkspaceExport;
}

async function selectSettings(page: Page, name: SettingsPage) {
  await openSettingsSection(page, name);
  const region = page.getByRole('region', { name, exact: true });
  await expect(region).toBeVisible();
  return region;
}

async function openSettings(page: Page, name: SettingsPage, theme = 'light') {
  // The explicit console entry avoids the workspace preview's default Rooms landing.
  await page.goto(`/?workspace=v2&theme=${theme}#connect`);
  await expect(page.locator('.app-shell')).toBeVisible();
  return selectSettings(page, name);
}

async function quietStream(page: Page) {
  // These snapshot-state cases control refresh responses; SSE would add unrelated invalidations.
  await page.route('**/api/events*', (route) => route.fulfill({ status: 204 }));
}

function requestCompletion(page: Page, target: Request) {
  return new Promise<void>((resolve) => {
    const completed = (request: Request) => {
      if (request !== target) return;
      page.off('requestfinished', completed);
      page.off('requestfailed', completed);
      resolve();
    };
    page.on('requestfinished', completed);
    page.on('requestfailed', completed);
  });
}

async function holdNextExport(page: Page, record: WorkspaceExport) {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: (value: { request: Request; completed: Promise<void> }) => void;
  const intercepted = new Promise<{ request: Request; completed: Promise<void> }>((resolve) => {
    entered = resolve;
  });
  let finished!: () => void;
  const delivered = new Promise<void>((resolve) => {
    finished = resolve;
  });
  await page.route(
    '**/api/workspace/export',
    async (route) => {
      const request = route.request();
      entered({ request, completed: requestCompletion(page, request) });
      await pending;
      try {
        await route.fulfill({ json: record });
      } catch {
        expect(request.failure()?.errorText).toMatch(/abort|cancel/i);
      } finally {
        finished();
      }
    },
    { times: 1 },
  );
  return { intercepted, release, delivered };
}

async function scrollToTop(page: Page) {
  await page.evaluate(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

function activity(index: number, overrides: Partial<CityEvent> = {}): CityEvent {
  return {
    id: `settings-event-${index}`,
    type: 'workspace.updated',
    message: `Retained event ${index}`,
    agentId: null,
    jobId: null,
    createdAt: new Date(Date.now() - index * 60_000).toISOString(),
    ...overrides,
  };
}

async function completedExchange(page: Page) {
  const demo = await page.request.post('/api/demo/start', { headers, data: {} });
  expect(demo.status()).toBe(200);
  await expect.poll(async () => (await snapshot(page)).stats.reachable).toBe(3);
  const connection = (await snapshot(page)).connections[0]!;
  const response = await page.request.post('/api/jobs', {
    headers,
    data: {
      requesterId: connection.fromAgentId,
      providerId: connection.toAgentId,
      input: 'Project: Synthetic settings export\nSource: https://example.com/settings-record',
      idempotencyKey: randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  const id = (await response.json()).job.id as string;
  await expect
    .poll(async () => (await snapshot(page)).jobs.find((job) => job.id === id)?.status, {
      timeout: 15_000,
    })
    .toBe('completed');
  return id;
}

test('Data & export preserves version-one records', async ({ page }) => {
  const operator = await register(page);
  const jobId = await completedExchange(page);
  const before = await exportRecord(page);
  const region = await openSettings(page, 'Data & export');
  await expect(
    region.getByRole('heading', { name: 'Your workspace records', exact: true }),
  ).toBeVisible();
  await expect(region).toContainText(/private/i);
  await expect(region).toContainText('Authentication credentials are excluded.');
  await expect(region).toContainText(/import|restore|backup/i);
  await expect(region).toContainText(/delet/i);
  const pending = page.waitForEvent('download');
  await region.getByRole('button', { name: 'Download workspace', exact: true }).click();
  const record = await readDownload(await pending);
  expect(record.format).toBe('central-city-workspace');
  expect(record.version).toBe(1);
  expect(record.operator).toEqual(operator);
  expect(record.purpose).toBe('portable-records-not-a-recovery-backup');
  expect(record.retention).toEqual(before.retention);
  expect(record.agents).toHaveLength(3);
  expect(record.connections).toEqual(before.connections);
  expect(record.jobs.find((job) => job.id === jobId)?.input).toContain('Synthetic settings export');
  expect(record.jobs.find((job) => job.id === jobId)?.output).toBeTruthy();
  expect(record.events.map((event) => event.id)).toEqual(before.events.map((event) => event.id));
  for (const field of ['token_hash', 'leaseHash', 'idempotencyKey', 'privateCredential']) {
    expect(JSON.stringify(record)).not.toContain(field);
  }
  expect(record).not.toHaveProperty('rooms');
  expect(record).not.toHaveProperty('messages');
  await expect(region.getByRole('status')).toHaveText('Your download has started.');
  const after = await exportRecord(page);
  expect(after.connections).toEqual(before.connections);
  expect(after.jobs).toEqual(before.jobs);
  expect(after.events).toEqual(before.events);
});

test('download preparation prevents duplicates, failure retries, and a later failure clears old success', async ({
  page,
}) => {
  await register(page);
  const record = await exportRecord(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  await page.route('**/api/workspace/export', async (route) => {
    expect(route.request().method()).toBe('GET');
    requests += 1;
    if (requests === 1) await pending;
    await route.fulfill(
      requests === 2
        ? { json: record }
        : {
            status: 503,
            json: { error: 'The export could not be downloaded. Try again.' },
          },
    );
  });
  const region = await openSettings(page, 'Data & export');
  expect(requests).toBe(0);
  await region.getByRole('button', { name: 'Download workspace', exact: true }).click();
  await expect(region.getByRole('status')).toContainText('Preparing your file…');
  await expect(
    region.getByRole('button', { name: /Preparing your file|Download workspace/ }),
  ).toBeDisabled();
  await expect.poll(() => requests).toBe(1);
  await page.keyboard.press('Enter');
  expect(requests).toBe(1);
  release();
  await expect(region.getByRole('alert')).toContainText(
    'The export could not be downloaded. Try again.',
  );
  const download = page.waitForEvent('download');
  await region.getByRole('button', { name: 'Download workspace', exact: true }).click();
  expect((await readDownload(await download)).operator.id).toBe(record.operator.id);
  await expect(region.getByRole('alert')).toHaveCount(0);
  await expect(region.getByRole('status')).toHaveText('Your download has started.');
  await region.getByRole('button', { name: 'Download workspace', exact: true }).click();
  await expect(region.getByRole('alert')).toBeVisible();
  await expect(region.getByText('Your download has started.', { exact: true })).toHaveCount(0);
  expect(requests).toBe(3);
});

test('a mismatched export is blocked and unavailable workspace 404 shows friendly copy before retry', async ({
  page,
}) => {
  await register(page);
  const record = await exportRecord(page);
  let downloads = 0;
  page.on('download', () => {
    downloads += 1;
  });
  let requests = 0;
  await page.route('**/api/workspace/export', (route) => {
    requests += 1;
    return route.fulfill(
      requests === 1
        ? {
            json: { ...record, operator: { id: 'different-workspace', name: 'Another workspace' } },
          }
        : requests === 2
          ? {
              status: 404,
              json: { error: 'Workspace not found.' },
            }
          : { json: record },
    );
  });
  const region = await openSettings(page, 'Data & export');
  await region.getByRole('button', { name: 'Download workspace', exact: true }).click();
  await expect(region.getByRole('alert')).toBeVisible();
  await expect(region.getByText('Your download has started.', { exact: true })).toHaveCount(0);
  expect(downloads).toBe(0);
  await region.getByRole('button', { name: 'Download workspace', exact: true }).click();
  await expect(region.getByRole('alert')).toHaveText("Export isn't available for this workspace.");
  await expect(region).not.toContainText('Workspace not found.');
  await expect(region.getByText('Your download has started.', { exact: true })).toHaveCount(0);
  expect(downloads).toBe(0);
  const recovered = page.waitForEvent('download');
  await region.getByRole('button', { name: 'Download workspace', exact: true }).click();
  expect((await readDownload(await recovered)).operator.id).toBe(record.operator.id);
  await expect(region.getByRole('alert')).toHaveCount(0);
  expect(requests).toBe(3);
  expect(downloads).toBe(1);
});

test('leaving Data & export during a pending request prevents a late download', async ({
  page,
}) => {
  await register(page);
  const record = await exportRecord(page);
  const held = await holdNextExport(page, record);
  let downloads = 0;
  page.on('download', () => {
    downloads += 1;
  });
  const region = await openSettings(page, 'Data & export');
  await region.getByRole('button', { name: 'Download workspace', exact: true }).click();
  const intercepted = await held.intercepted;
  await expect(region.getByRole('status')).toContainText('Preparing your file…');
  const log = await selectSettings(page, 'Activity log');
  held.release();
  await held.delivered;
  await intercepted.completed;
  await expect(log).toBeVisible();
  await expect(page.getByText('Your download has started.', { exact: true })).toHaveCount(0);
  expect(downloads).toBe(0);
});

test('selected co-owned workspace controls both the export identity and activity', async ({
  page,
}) => {
  const operator = await register(page);
  const created = await page.request.post('/api/public/workspaces', {
    data: { name: 'Shared settings workspace', idempotency_key: randomUUID() },
  });
  expect(created.status()).toBe(201);
  const shared = (await created.json()) as { workspace_id: string; claim_token: string };
  const claim = await page.request.post('/api/workspaces/claim', {
    headers,
    data: { claim_token: shared.claim_token },
  });
  expect(claim.status()).toBe(200);
  for (const [workspace, name] of [
    [operator.id, 'Personal settings agent'],
    [shared.workspace_id, 'Shared settings agent'],
  ]) {
    const response = await page.request.post('/api/agents', {
      headers: { ...headers, 'X-City-Workspace': workspace! },
      data: {
        name,
        description: 'Synthetic settings isolation check.',
        capability: 'research',
        mode: 'external',
      },
    });
    expect(response.status()).toBe(201);
  }
  await openSettings(page, 'Activity log');
  await (await workspaceSwitcher(page)).selectOption(shared.workspace_id);
  let log = await selectSettings(page, 'Activity log');
  await expect(log).toContainText('Shared settings agent');
  await expect(log).not.toContainText('Personal settings agent');
  const region = await selectSettings(page, 'Data & export');
  const request = page.waitForRequest(
    (value) => new URL(value.url()).pathname === '/api/workspace/export',
  );
  const download = page.waitForEvent('download');
  await region.getByRole('button', { name: 'Download workspace', exact: true }).click();
  expect((await request).headers()['x-city-workspace']).toBe(shared.workspace_id);
  const record = await readDownload(await download);
  expect(record.operator.id).toBe(shared.workspace_id);
  expect(record.agents.map((agent) => agent.name)).toEqual(['Shared settings agent']);

  // The second export is in flight when its selected workspace disappears from the page.
  let lateDownloads = 0;
  page.on('download', () => {
    lateDownloads += 1;
  });
  const held = await holdNextExport(page, record);
  await region.getByRole('button', { name: 'Download workspace', exact: true }).click();
  const intercepted = await held.intercepted;
  expect(intercepted.request.headers()['x-city-workspace']).toBe(shared.workspace_id);
  await (await workspaceSwitcher(page)).selectOption(operator.id);
  log = await selectSettings(page, 'Activity log');
  held.release();
  await held.delivered;
  await intercepted.completed;
  await expect(log).toContainText('Personal settings agent');
  await expect(log).not.toContainText('Shared settings agent');
  await expect(page.getByText('Your download has started.', { exact: true })).toHaveCount(0);
  expect(lateDownloads).toBe(0);
});

test('Activity log distinguishes initial loading and failure from a recovered empty workspace', async ({
  page,
}) => {
  await register(page);
  const state = { ...(await snapshot(page)), events: [] };
  await quietStream(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let recovered = false;
  await page.route('**/api/snapshot', async (route) => {
    const recoveryAllowed = recovered;
    await pending;
    if (!recoveryAllowed) {
      await route.fulfill({
        status: 503,
        json: { error: 'Activity could not be loaded. Try again.' },
      });
    } else await route.fulfill({ json: state });
  });
  const region = await openSettings(page, 'Activity log');
  await expect(region.getByRole('status')).toContainText(/loading/i);
  await expect(region.getByText(/no (recent )?activity/i)).toHaveCount(0);
  release();
  await expect(region.getByRole('alert')).toContainText('Activity could not be loaded. Try again.');
  await expect(region.getByText(/no (recent )?activity/i)).toHaveCount(0);
  recovered = true;
  await region.getByRole('button', { name: 'Refresh activity', exact: true }).click();
  await expect(region.getByRole('alert')).toHaveCount(0);
  await expect(region.getByText(/no (recent )?activity/i)).toBeVisible();
  await expect(region.getByRole('listitem')).toHaveCount(0);
});

test('failed activity refresh retains recent events and a successful retry replaces them', async ({
  page,
}) => {
  await register(page);
  const state = await snapshot(page);
  await quietStream(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let phase: 'initial' | 'failed' | 'recovered' = 'initial';
  await page.route('**/api/snapshot', async (route) => {
    const requestedPhase = phase;
    if (requestedPhase === 'failed') {
      await pending;
      await route.fulfill({ status: 503, json: { error: 'Activity refresh failed. Try again.' } });
    } else {
      await route.fulfill({
        json: {
          ...state,
          events: [
            activity(1, {
              message:
                requestedPhase === 'initial'
                  ? 'Previously loaded activity.'
                  : 'Newly loaded activity.',
            }),
          ],
        },
      });
    }
  });
  const region = await openSettings(page, 'Activity log');
  await expect(region).toContainText('Previously loaded activity.');
  const refresh = region.getByRole('button', { name: 'Refresh activity', exact: true });
  phase = 'failed';
  await refresh.click();
  await expect(refresh).toBeDisabled();
  await expect(region).toContainText('Previously loaded activity.');
  release();
  await expect(region.getByRole('alert')).toContainText('Activity refresh failed. Try again.');
  await expect(region).toContainText('Previously loaded activity.');
  phase = 'recovered';
  await refresh.click();
  await expect(region).toContainText('Newly loaded activity.');
  await expect(region).not.toContainText('Previously loaded activity.');
  await expect(region.getByRole('alert')).toHaveCount(0);
});

test('activity describes the latest hundred only, keeps order, uses plain language and escapes event text', async ({
  page,
}) => {
  await register(page);
  const state = await snapshot(page);
  const untrusted = '<img src=x onerror="window.__settingsPwned=true">';
  const events = Array.from({ length: 100 }, (_, index) => activity(index + 1));
  events[0] = activity(1, { type: 'assistant.used', message: 'Claude used city_create_agent.' });
  events[1] = activity(2, { message: untrusted });
  await quietStream(page);
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: { ...state, events } }));
  const region = await openSettings(page, 'Activity log');
  await expect(region.getByRole('heading', { name: 'Recent activity', exact: true })).toBeVisible();
  await expect(region).toContainText('100 recent events');
  await expect(region).toContainText(/latest 100|100 most recent/i);
  const rows = region.getByRole('listitem');
  await expect(rows).toHaveCount(100);
  await expect(rows.first()).toContainText('Claude used “create agent”.');
  await expect(rows.last()).toContainText('Retained event 100');
  await expect(region).not.toContainText('city_create_agent');
  await expect(region.getByText(untrusted, { exact: true })).toBeVisible();
  await expect(region.locator('img')).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as Record<string, unknown>).__settingsPwned),
  ).toBeUndefined();
  await expect(
    region.getByRole('button', { name: /load (more|older)|next page|older (activity|events)/i }),
  ).toHaveCount(0);
});

test('a recent exchange opens with the keyboard while an older unavailable exchange stays readable', async ({
  page,
}) => {
  await register(page);
  const jobId = await completedExchange(page);
  const state = await snapshot(page);
  await quietStream(page);
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({
      json: {
        ...state,
        events: [
          activity(1, { type: 'job.completed', jobId, message: 'A result you can open.' }),
          activity(2, {
            type: 'job.completed',
            jobId: 'job-outside-snapshot',
            message: 'An older result outside the recent exchange list.',
          }),
        ],
      },
    }),
  );
  const region = await openSettings(page, 'Activity log');
  const older = region
    .getByRole('listitem')
    .filter({ hasText: 'An older result outside the recent exchange list.' });
  await expect(older).toBeVisible();
  await expect(older.getByRole('button')).toHaveCount(0);
  const opener = region.getByRole('button', { name: 'A result you can open.', exact: true });
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Result', exact: true })).toBeVisible();
  await expect(dialog).toContainText('Synthetic settings export');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

for (const theme of ['light', 'dark']) {
  for (const width of [360, 390, 1440]) {
    test(`settings data and activity fit ${width}px in ${theme} mode with keyboard controls`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 360 ? 780 : 900 });
      await register(page);
      const state = await snapshot(page);
      await quietStream(page);
      await page.route('**/api/snapshot', (route) =>
        route.fulfill({
          json: {
            ...state,
            events: [
              activity(1, {
                message:
                  'An activity entry with a long descriptive name and a long-unbroken-value-for-checking-that-narrow-phone-screens-wrap-without-horizontal-overflow.',
              }),
            ],
          },
        }),
      );
      const data = await openSettings(page, 'Data & export', theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const download = data.getByRole('button', { name: 'Download workspace', exact: true });
      await download.focus();
      await expect(download).toBeFocused();
      const downloadBounds = (await download.boundingBox())!;
      expect(downloadBounds.height).toBeGreaterThanOrEqual(workspaceTarget(width));
      expect(downloadBounds.width).toBeGreaterThanOrEqual(workspaceTarget(width));
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      const dataImage = testInfo.outputPath('data-export.png');
      await scrollToTop(page);
      await page.screenshot({ path: dataImage, fullPage: true });
      await testInfo.attach(`Data & export ${width}px ${theme}`, {
        path: dataImage,
        contentType: 'image/png',
      });
      const log = await selectSettings(page, 'Activity log');
      const refresh = log.getByRole('button', { name: 'Refresh activity', exact: true });
      await refresh.focus();
      const snapshotRequest = page.waitForRequest(
        (request) => new URL(request.url()).pathname === '/api/snapshot',
      );
      await page.keyboard.press('Enter');
      const response = await (await snapshotRequest).response();
      expect(response?.status()).toBe(200);
      await response!.finished();
      await expect(refresh).toBeEnabled();
      const refreshBounds = (await refresh.boundingBox())!;
      expect(refreshBounds.height).toBeGreaterThanOrEqual(workspaceTarget(width));
      expect(refreshBounds.width).toBeGreaterThanOrEqual(workspaceTarget(width));
      await expect(log.getByRole('listitem')).toHaveCount(1);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      const activityImage = testInfo.outputPath('activity-log.png');
      await scrollToTop(page);
      await page.screenshot({ path: activityImage, fullPage: true });
      await testInfo.attach(`Activity log ${width}px ${theme}`, {
        path: activityImage,
        contentType: 'image/png',
      });
    });
  }
}
