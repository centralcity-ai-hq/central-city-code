import { expect, test, type Locator, type Page } from '@playwright/test';
import { openSettingsSection, workspaceSwitcher } from './settings-nav';
import { randomUUID } from 'node:crypto';
import type { WorkspaceKey } from '../shared/assistant';

const headers = { 'X-City-Request': '1' };
const endpoint = '/api/workspace-keys';
const unavailable = 'Access keys are temporarily unavailable.';
const refreshFailure =
  'The access keys could not be refreshed. Showing the previous list; it may have changed.';
const recordedAt = '2026-10-03T12:00:00.000Z';
const password = 'Local-test-only-passphrase-2026';
// Intercepted UI fixture only; this value is not a credential issued by the server.
const syntheticKey = 'test-workspace-key-0001';
// Public creation allows three workspaces per source per hour. Reuse real membership within
// this worker; every case still gets a fresh browser context and isolated key API fixtures.
let claimedMembership: { accountName: string; workspaceId: string } | undefined;

function key(overrides: Partial<WorkspaceKey> = {}): WorkspaceKey {
  return {
    id: 'test-workspace-key-record-0001',
    label: 'Original AI',
    primary: true,
    scopes: ['workspace:read'],
    createdAt: recordedAt,
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

async function claimedWorkspace(page: Page) {
  await page.route('**/api/events*', (route) => route.fulfill({ status: 204 }));
  if (claimedMembership) {
    const signedIn = await page.request.post('/api/auth/login', {
      headers,
      data: { name: claimedMembership.accountName, password },
    });
    expect(signedIn.status()).toBe(200);
    return claimedMembership.workspaceId;
  }
  const accountName = `Key-recovery-${randomUUID().slice(0, 8)}`;
  const registered = await page.request.post('/api/auth/register', {
    headers,
    data: { name: accountName, password },
  });
  expect(registered.status()).toBe(201);
  const created = await page.request.post('/api/public/workspaces', {
    data: { name: 'Synthetic key recovery workspace', idempotency_key: randomUUID() },
  });
  expect(created.status()).toBe(201);
  const workspace = (await created.json()) as { workspace_id: string; claim_token: string };
  const claimed = await page.request.post('/api/workspaces/claim', {
    headers,
    data: { claim_token: workspace.claim_token },
  });
  expect(claimed.status()).toBe(200);
  claimedMembership = { accountName, workspaceId: workspace.workspace_id };
  return workspace.workspace_id;
}

async function keyReads(page: Page) {
  const state = {
    keys: [key()],
    unavailable: false,
    reads: [] as (string | null)[],
    writes: [] as string[],
  };
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith(endpoint) && request.method() !== 'GET') {
      state.writes.push(`${request.method()} ${path}`);
    }
  });
  await page.route(
    (url) => url.pathname === endpoint || url.pathname.startsWith(`${endpoint}/`),
    async (route) => {
      const request = route.request();
      if (request.method() !== 'GET') {
        await route.fulfill({
          status: 405,
          json: { error: 'Unexpected key mutation in this fixture.' },
        });
        return;
      }
      state.reads.push(request.headers()['x-city-workspace'] ?? null);
      await route.fulfill(
        state.unavailable
          ? { status: 503, json: { error: unavailable } }
          : { json: { keys: state.keys } },
      );
    },
  );
  return state;
}

async function openKeys(page: Page, workspaceId: string) {
  // Enter the existing console, select the real co-owned workspace, then use Account navigation.
  await page.goto('/?workspace=v2#connect');
  await expect(page.locator('.app-shell')).toBeVisible();
  await (await workspaceSwitcher(page)).selectOption(workspaceId);
  await expect(await workspaceSwitcher(page)).toHaveValue(workspaceId);
  await expect(page.getByText('AI workspace · you co-own it', { exact: true })).toBeVisible();
  await openSettingsSection(page, 'Connected apps');
  const panel = page.getByRole('region', { name: 'AI access keys', exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

function rows(panel: Locator) {
  return panel.getByRole('list', { name: 'AI access keys', exact: true }).getByRole('listitem');
}

async function refreshOnce(panel: Locator, state: Awaited<ReturnType<typeof keyReads>>) {
  const before = state.reads.length;
  const refresh = panel.getByRole('button', { name: 'Refresh', exact: true });
  await refresh.click();
  await expect
    .poll(() => state.reads.length, { timeout: 5_000, message: 'Refresh starts a key-list read' })
    .toBeGreaterThan(before);
  // Waiting for the control to settle catches the old run(refresh, load) second GET as well.
  await expect(refresh).toBeEnabled();
  await expect(
    panel.getByRole('status').filter({ hasText: /Loading access keys|Refreshing access keys/ }),
  ).toHaveCount(0);
  expect(state.reads.length).toBe(before + 1);
}

test('failed initial key read stops loading and one Refresh recovers the selected workspace list', async ({
  page,
}) => {
  const workspaceId = await claimedWorkspace(page);
  const state = await keyReads(page);
  state.unavailable = true;
  const panel = await openKeys(page, workspaceId);
  await expect(panel.getByRole('alert')).toContainText('The access keys could not be loaded.');
  await expect(panel.getByRole('alert')).toContainText('Use Refresh to try again.');
  await expect(panel.getByRole('status').filter({ hasText: /Loading/ })).toHaveCount(0);
  await expect(rows(panel)).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  expect(state.reads).toEqual([workspaceId]);
  state.unavailable = false;
  await refreshOnce(panel, state);
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(rows(panel)).toHaveCount(1);
  await expect(rows(panel)).toContainText('Original AI');
  expect(state.reads).toEqual([workspaceId, workspaceId]);
  expect(state.writes).toEqual([]);
});

test('a later failed key Refresh retains prior rows and a single retry replaces them', async ({
  page,
}) => {
  const workspaceId = await claimedWorkspace(page);
  const state = await keyReads(page);
  const panel = await openKeys(page, workspaceId);
  await expect(rows(panel)).toHaveCount(1);
  await expect(panel.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  state.unavailable = true;
  await refreshOnce(panel, state);
  await expect(panel.getByRole('alert')).toContainText(refreshFailure);
  await expect(rows(panel)).toHaveCount(1);
  await expect(rows(panel)).toContainText('Original AI');
  state.keys = [key({ label: 'Updated AI metadata', lastUsedAt: recordedAt })];
  state.unavailable = false;
  await refreshOnce(panel, state);
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(rows(panel)).toContainText('Updated AI metadata');
  await expect(rows(panel)).not.toContainText('Original AI');
  expect(state.reads.every((id) => id === workspaceId)).toBe(true);
  expect(state.writes).toEqual([]);
});

test('mint identifies its workspace while pending and GET-only recovery preserves the issued key until saved', async ({
  page,
}) => {
  const workspaceId = await claimedWorkspace(page);
  const state = await keyReads(page);
  const minted = key({
    id: 'test-workspace-key-record-0002',
    label: 'Synthetic helper',
    primary: false,
  });
  let submitted: unknown;
  let mintEntered = false;
  let mintDelivered = false;
  let deliveryError: unknown;
  let releaseMint!: () => void;
  const mintResponse = new Promise<void>((resolve) => {
    releaseMint = resolve;
  });
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    submitted = route.request().postDataJSON();
    mintEntered = true;
    try {
      await mintResponse;
      state.keys = [key(), minted];
      state.unavailable = true;
      await route.fulfill({ status: 201, json: { key: minted, workspace_key: syntheticKey } });
    } catch (error) {
      deliveryError = error;
    } finally {
      mintDelivered = true;
    }
  });
  const panel = await openKeys(page, workspaceId);
  await expect(rows(panel)).toHaveCount(1);
  const pending = panel.getByRole('status').filter({ hasText: 'Creating an access key for' });
  await expect(pending).toHaveCount(0);
  try {
    await panel.getByRole('textbox', { name: 'New key for', exact: true }).fill(minted.label);
    await panel.getByRole('button', { name: 'Create key', exact: true }).click();
    await expect
      .poll(() => mintEntered, { timeout: 5_000, message: 'Mint POST reaches the held response' })
      .toBe(true);
    await expect(pending).toHaveText(
      'Creating an access key for Synthetic key recovery workspace. Keep this workspace open until the key appears; it can only be shown once.',
    );
    await expect(panel.locator('.key-secret')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Create key', exact: true })).toBeDisabled();
    expect(state.writes).toEqual([`POST ${endpoint}`]);
  } finally {
    // Release even when a pending-state assertion fails; settlement never waits indefinitely.
    releaseMint();
    await expect
      .poll(() => !mintEntered || mintDelivered, {
        timeout: 5_000,
        message: 'Held mint response is released',
      })
      .toBe(true);
    if (deliveryError) throw deliveryError;
  }
  const issued = panel
    .getByRole('status')
    .filter({ hasText: 'Access key for Synthetic helper created.' });
  await expect(issued).toContainText('It is shown only once.');
  await expect(issued.locator('code')).toHaveText(syntheticKey);
  await expect(pending).toHaveCount(0);
  await expect(panel.getByRole('alert')).toContainText(refreshFailure);
  await expect(pending).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Create key', exact: true })).toBeDisabled();
  expect(submitted).toEqual({ label: minted.label, scopes: ['workspace:read'] });
  expect(state.writes).toEqual([`POST ${endpoint}`]);
  await refreshOnce(panel, state);
  await expect(panel.getByRole('alert')).toContainText(refreshFailure);
  await expect(issued.locator('code')).toHaveText(syntheticKey);
  expect(state.writes).toEqual([`POST ${endpoint}`]);
  state.unavailable = false;
  await refreshOnce(panel, state);
  await expect(rows(panel)).toHaveCount(2);
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(issued.locator('code')).toHaveText(syntheticKey);
  await issued.getByRole('button', { name: 'I saved it', exact: true }).click();
  await expect(issued).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Create key', exact: true })).toBeEnabled();
  await refreshOnce(panel, state);
  await expect(panel.locator('.key-secret')).toHaveCount(0);
  expect(state.reads.every((id) => id === workspaceId)).toBe(true);
  expect(state.writes).toEqual([`POST ${endpoint}`]);
});

test('confirmed removal followed by a failed read recovers with GET without repeating DELETE', async ({
  page,
}) => {
  const workspaceId = await claimedWorkspace(page);
  const state = await keyReads(page);
  await page.route(`**${endpoint}/${key().id}`, async (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    state.keys = [key({ revokedAt: recordedAt })];
    state.unavailable = true;
    await route.fulfill({ json: { key: state.keys[0] } });
  });
  const panel = await openKeys(page, workspaceId);
  await expect(rows(panel)).toHaveCount(1);
  const remove = panel.getByRole('button', { name: 'Remove access key Original AI', exact: true });
  await remove.click();
  await expect(panel.getByRole('alert')).toContainText(refreshFailure);
  await expect(rows(panel)).toHaveCount(1);
  expect(state.writes).toEqual([`DELETE ${endpoint}/${key().id}`]);
  state.unavailable = false;
  await refreshOnce(panel, state);
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(rows(panel).getByText('Removed', { exact: true })).toBeVisible();
  await expect(remove).toBeDisabled();
  expect(state.reads.every((id) => id === workspaceId)).toBe(true);
  expect(state.writes).toEqual([`DELETE ${endpoint}/${key().id}`]);
});
