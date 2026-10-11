import { expect, test, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Agent, Snapshot } from '../shared/types';

/*
 * My agents v4 · Developer details and Rotate key (⋯ → Developer details): who created the agent
 * and under which agent, what was written about it, and the rotate warnings. The agent list is a
 * synthetic fixture served through page.route, and so is the rotation; the account is real.
 */

const headers = { 'X-City-Request': '1' };
const password = 'Local-test-only-passphrase-2026';
const at = '2026-10-11T08:00:00.000Z';
const ROTATED = 'test-token-0001-rotated';

function agent(id: string, name: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name,
    description: '',
    capability: 'research',
    mode: 'external',
    isDemo: false,
    status: 'online',
    lastSeenAt: at,
    createdAt: at,
    revokedAt: null,
    ...overrides,
  };
}

const lead = agent('11111111-1111-4111-8111-111111111111', 'Harbor Lead', {
  createdBy: { kind: 'assistant' },
});
const courier = agent('22222222-2222-4222-8222-222222222222', 'Courier', {
  description: 'Reads filings and flags what changed.',
  createdBy: { kind: 'anonymous-client' },
  claimedAt: at,
  parentAgentId: lead.id,
  depth: 1,
  credentialHint: '…a91f',
});
const plain = agent('33333333-3333-4333-8333-333333333333', 'Plain', { mode: 'hosted' });

async function fixture(page: Page) {
  const registered = await page.request.post('/api/auth/register', {
    headers,
    data: { name: `Developer-${randomUUID().slice(0, 8)}`, password },
  });
  expect(registered.status()).toBe(201);
  const baseline = (await (await page.request.get('/api/snapshot')).json()) as Snapshot;
  const snapshot: Snapshot = { ...baseline, agents: [lead, courier, plain] };
  await page.route('**/api/events*', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }));
  await page.route('**/api/rooms', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { rooms: [] } }) : route.fallback(),
  );
  await page.route('**/api/v2/connections/requests**', (route) =>
    route.fulfill({ json: { incoming: [], outgoing: [], next_before: null } }),
  );
  await page.route('**/api/agents/*/totals', (route) =>
    route.fulfill({ json: { tasks_done: 0, messages_sent: 0 } }),
  );
  const rotations: string[] = [];
  await page.route('**/api/agents/*/rotate-credential', (route) => {
    const id = new URL(route.request().url()).pathname.split('/')[3]!;
    rotations.push(id);
    return route.fulfill({ json: { agent: courier, token: ROTATED } });
  });
  return rotations;
}

/** ⋯ → Developer details of `name`, in its pane on My agents v4. */
async function openDeveloper(page: Page, name: string) {
  await page.goto('/?workspace=v2&theme=light#connect');
  await expect(page.locator('.app-shell')).toBeVisible();
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole('navigation', { name: 'Workspace', exact: true })
    .getByRole('button', { name: /^My agents/ })
    .first()
    .click();
  await page
    .getByRole('region', { name: 'Agents', exact: true })
    .getByRole('button', { name: new RegExp(`^${name}, `) })
    .click();
  const pane = page.getByRole('complementary', { name: `${name} details` });
  await pane.getByRole('button', { name: `More for ${name}` }).click();
  await pane.getByRole('menuitem', { name: 'Developer details' }).click();
  await expect(pane.getByRole('heading', { name: 'Developer details', exact: true })).toBeVisible();
  return pane;
}

const row = (pane: Locator, label: string) =>
  pane.locator('.ap4-row').filter({ has: pane.page().locator('.ap4-k', { hasText: label }) });

test('Developer details says who created the agent, under which agent, and what it is about', async ({
  page,
}) => {
  await fixture(page);
  const pane = await openDeveloper(page, 'Courier');
  await expect(row(pane, 'Agent ID')).toContainText('22222222…22222');
  // An AI app made it, and it was claimed into this workspace; it lives under Harbor Lead.
  await expect(row(pane, 'Created by').locator('.ap4-v')).toHaveText('An AI app · claimed');
  await expect(row(pane, 'Created under').locator('.ap4-v')).toHaveText('Harbor Lead');
  await expect(row(pane, 'About').locator('.ap4-v')).toHaveText(
    'Reads filings and flags what changed.',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('an agent your AI created, with nothing written about it, shows no About and no parent', async ({
  page,
}) => {
  await fixture(page);
  let pane = await openDeveloper(page, 'Harbor Lead');
  await expect(row(pane, 'Created by').locator('.ap4-v')).toHaveText('Your AI');
  await expect(row(pane, 'Created under')).toHaveCount(0);
  // No "Research specialist" filler for an empty description.
  await expect(row(pane, 'About')).toHaveCount(0);
  await expect(pane).not.toContainText('specialist');

  pane = await openDeveloper(page, 'Plain');
  await expect(row(pane, 'Created by').locator('.ap4-v')).toHaveText('You');
});

test('Rotate key warns that unfinished work is canceled, and the new key says where it goes', async ({
  page,
}) => {
  const rotations = await fixture(page);
  const pane = await openDeveloper(page, 'Courier');
  await pane.getByRole('button', { name: 'Rotate key' }).click();
  await expect(pane.getByRole('heading', { name: 'Rotate key', exact: true })).toBeVisible();
  await expect(pane).toContainText(
    'Stop the agent first. The old key stops working at once and unfinished work for Courier is canceled; its connections and history stay.',
  );
  await pane.getByRole('textbox', { name: 'Type the agent name to confirm' }).fill('Courier');
  await pane.getByRole('button', { name: 'Rotate key', exact: true }).click();
  await expect(pane.getByRole('heading', { name: 'New key', exact: true })).toBeVisible();
  expect(rotations).toEqual([courier.id]);
  await expect(pane).toContainText('Shown once. Copy it now; the old key stopped working.');
  await expect(pane).toContainText(
    'Put it in Courier’s setup and restart it. Anyone with this key can act as Courier; never paste it into a chat.',
  );
  // Shown masked; the whole key is never on the page as text.
  await expect(pane).not.toContainText(ROTATED);
});
