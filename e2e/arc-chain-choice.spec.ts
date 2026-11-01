import { expect, test, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Agent, Snapshot } from '../shared/types';

/*
 * Operation Arc: Choose a chain on the Base screen, shown only while /api/public/arc/rated
 * answers 200. Fixtures and helpers as in base-registration.spec.ts.
 *
 * Original note: "Make it a Base agent" for one agent on My agents v4. Every behaviour is checked on the agent's
 * Base screen (its pane's Base row → Base, docs/design/my-agents-v4-mockup.html), which runs on
 * src/base/useBaseRegistration.ts. The agent list and the Base routes are synthetic fixtures
 * served through page.route; nothing reaches a chain.
 *
 * The pane's home reads the status for its Base row as well, so the status answers below follow
 * the registration (before or after the first request), never the count of reads.
 */

const headers = { 'X-City-Request': '1' };
const password = 'Local-test-only-passphrase-2026';
const at = '2026-10-09T08:00:00.000Z';
const OWNER = `0x${'ab'.repeat(20)}`;

const atlas: Agent = {
  id: '99999999-9999-4999-8999-999999999999',
  name: 'Harbor',
  description: 'Synthetic fixture',
  capability: 'research',
  mode: 'hosted',
  isDemo: false,
  status: 'online',
  lastSeenAt: at,
  createdAt: at,
  revokedAt: null,
  visibility: 'public',
};

async function fixture(page: Page) {
  const registered = await page.request.post('/api/auth/register', {
    headers,
    data: { name: `Base-reg-${randomUUID().slice(0, 8)}`, password },
  });
  expect(registered.status()).toBe(201);
  const baseline = (await (await page.request.get('/api/snapshot')).json()) as Snapshot;
  const snapshot: Snapshot = { ...baseline, agents: [atlas] };
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
}

async function gotoMyAgents(page: Page) {
  await page.goto('/?workspace=v2&theme=light#connect');
  await expect(page.locator('.app-shell')).toBeVisible();
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole('navigation', { name: 'Workspace', exact: true })
    .getByRole('button', { name: /^My agents/ })
    .first()
    .click();
}

/** Harbor's pane on My agents v4, at the agent's home (Base, Messages, Rooms, …). */
async function openPane(page: Page) {
  await gotoMyAgents(page);
  const region = page.getByRole('region', { name: 'Agents', exact: true });
  await region.getByRole('button', { name: /^Harbor, / }).click();
  return page.getByRole('complementary', { name: 'Harbor details' });
}

/** The Base row on the agent's home: "Base" and where the registration stands. */
const baseRow = (pane: Locator) => pane.getByRole('button', { name: /^ERC-8004/ });

/** The agent's Base screen: its home's Base row, pushed inside the same pane. */
async function openBaseScreen(page: Page, pane?: Locator) {
  const home = pane ?? (await openPane(page));
  await baseRow(home).click();
  return home.getByRole('region', { name: /^Harbor · / });
}

const agentUri = 'https://centralcity.ai/a/k3P9xQ';
const OWNER_ADDR = OWNER;

async function routes(page: Page, arcStatus: number) {
  let probes = 0;
  await page.route('**/api/public/arc/rated**', (route) => {
    probes += 1;
    return route.fulfill({ status: arcStatus, json: arcStatus === 200 ? { agents: [] } : {} });
  });
  await page.route('**/api/base/agents/*/registration', (route) =>
    route.fulfill({ json: { identities: [] } }),
  );
  const sent: Record<string, unknown>[] = [];
  await page.route('**/api/base/agents/*/register', (route) => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        wallet: { address: `0x${'cd'.repeat(20)}`, state: 'derived' },
        identity: { state: 'submitted', erc8004AgentId: null, agentUri },
      },
    });
  });
  return { sent, probes: () => probes };
}

test('with Arc on, the owner chooses a chain first and Arc sends chainId 5042', async ({
  page,
}) => {
  await fixture(page);
  const { sent } = await routes(page, 200);
  const screen = await openBaseScreen(page);
  await expect(screen.getByText('Choose a chain')).toBeVisible();
  const base = screen.getByRole('radio', { name: /Base/ });
  const arc = screen.getByRole('radio', { name: /Arc/ });
  await expect(base).toBeChecked();
  await expect(screen.getByText('Coinbase’s network. Where most agents are today.')).toBeVisible();
  await expect(
    screen.getByText('Circle’s network. Gas paid in USDC, final in about a second.'),
  ).toBeVisible();
  await expect(
    screen.getByText('An agent lives on one chain. You can’t move it later.'),
  ).toBeVisible();
  await expect(screen.getByLabel('Your wallet address')).toHaveCount(0);
  await arc.check();
  await screen.getByRole('button', { name: 'Continue', exact: true }).click();
  // Chosen: the screen is named for Arc from here on.
  const onArc = page
    .getByRole('complementary', { name: 'Harbor details' })
    .getByRole('region', { name: 'Harbor · Arc', exact: true });
  await expect(onArc.getByRole('heading', { name: 'Arc', exact: true })).toBeVisible();
  await expect(onArc.getByText('Choose a chain')).toHaveCount(0);
  await onArc.getByLabel('Your wallet address').fill(OWNER_ADDR);
  await onArc.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toEqual({ ownerAddress: OWNER_ADDR, chainId: 5042 });
  // The register answer doesn't name the chain: the one chosen does.
  await expect(onArc.getByText('Registering on Arc', { exact: true })).toBeVisible();
});

test('with Arc on, Base chosen: every word stays Base’s', async ({ page }) => {
  await fixture(page);
  const { sent } = await routes(page, 200);
  const screen = await openBaseScreen(page);
  await screen.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(screen.getByRole('heading', { name: 'Base', exact: true })).toBeVisible();
  await expect(screen.getByText('Give Harbor a Base identity')).toBeVisible();
  await expect(screen.getByText('Its own ID and wallet on Base. Free.')).toBeVisible();
  await screen.getByLabel('Your wallet address').fill(OWNER_ADDR);
  await screen.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toEqual({ ownerAddress: OWNER_ADDR });
  await expect(screen.getByText('Registering on Base', { exact: true })).toBeVisible();
});

test('with Arc off, the Base screen is unchanged and Base sends no chainId', async ({ page }) => {
  await fixture(page);
  const { sent, probes } = await routes(page, 404);
  const screen = await openBaseScreen(page);
  await expect(screen.getByLabel('Your wallet address')).toBeVisible();
  await expect(screen.getByText('Choose a chain')).toHaveCount(0);
  await expect(screen.getByRole('radio')).toHaveCount(0);
  expect(probes()).toBeLessThanOrEqual(1);
  await screen.getByLabel('Your wallet address').fill(OWNER_ADDR);
  await screen.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toEqual({ ownerAddress: OWNER_ADDR });
});
