import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { AssistantGrant } from '../shared/assistant';
import { ASSISTANT_SCOPES } from '../shared/assistant';
import { openSettingsSection } from './settings-nav';

const headers = { 'X-City-Request': '1' };

async function register(page: Page) {
  const response = await page.request.post('/api/auth/register', {
    headers,
    data: {
      name: `App-permissions-${randomUUID().slice(0, 8)}`,
      password: 'Local-test-only-passphrase-2026',
    },
  });
  expect(response.status()).toBe(201);
}

function grant(id: string, label: string, scopes: AssistantGrant['scopes']): AssistantGrant {
  const now = Date.now();
  return {
    id,
    label,
    scopes,
    createdAt: new Date(now - 86_400_000).toISOString(),
    expiresAt: new Date(now + 7 * 86_400_000).toISOString(),
    renewal: 'rolling',
    endsAtLatest: null,
    lastUsedAt: null,
    revokedAt: null,
  };
}

/*
 * An app connected over OAuth holds rooms:join by default (server/oauth/server.ts); every
 * permission it holds is listed by its plain name, never as a raw scope such as "rooms: join".
 */
test('Connected apps names every permission an app holds in plain words', async ({ page }) => {
  await register(page);
  await page.route('**/api/assistant-access', (route) =>
    route.fulfill({
      json: {
        grants: [
          grant('test-grant-0001', 'Chat app', ['workspace:read', 'agents:create', 'rooms:join']),
          grant('test-grant-0002', 'Every permission', [...ASSISTANT_SCOPES]),
        ],
      },
    }),
  );
  await page.goto('/?workspace=v2#connect');
  await expect(page.locator('.app-shell')).toBeVisible();
  // Connected apps lives in Settings: Account → Settings → the section rail.
  await openSettingsSection(page, 'Connected apps');
  const list = page.locator('.assistant-grants');
  const chat = list.locator('li').filter({ hasText: 'Chat app' });
  // Each permission is its own chip, in the order the app holds them.
  await expect(chat.locator('.stv2-chip')).toHaveText([
    'See your workspace',
    'Create agents',
    'Join rooms',
  ]);
  const every = list.locator('li').filter({ hasText: 'Every permission' });
  await expect(every).toContainText('Host rooms');
  await expect(every).toContainText('Publish results');
  // No permission falls back to its raw scope ("rooms: join", "agents: wake", …).
  await expect(list).not.toContainText(/\b[a-z]+: [a-z]+\b/);
});
