import { expect, test, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { ConnectionRequest } from '../shared/assistant';
import type { Agent, Snapshot } from '../shared/types';
import { WORKSPACE_SCALE, workspaceTarget } from './workspace-density';

const headers = { 'X-City-Request': '1' };
const password = 'Local-test-only-passphrase-2026';
const at = '2026-10-03T12:00:00.000Z';
const REQUESTS = '/api/v2/connections/requests';

function agent(id: string, name: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name,
    description: 'Synthetic fixture',
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

const scout = agent('11111111-1111-4111-8111-111111111111', 'Research scout');
const writer = agent('22222222-2222-4222-8222-222222222222', 'Draft writer', {
  status: 'offline',
  mode: 'hosted',
});
const held = agent('33333333-3333-4333-8333-333333333333', 'Held reviewer', { pausedAt: at });
const child = agent('44444444-4444-4444-8444-444444444444', 'Scout helper', {
  parentAgentId: scout.id,
  depth: 1,
});
const gone = agent('55555555-5555-4555-8555-555555555555', 'Retired agent', {
  status: 'revoked',
  revokedAt: at,
});

const requestId = '66666666-6666-4666-8666-666666666666';
function pending(): ConnectionRequest {
  return {
    id: requestId,
    direction: 'incoming',
    status: 'pending',
    from_agent_id: '77777777-7777-4777-8777-777777777777',
    from_agent_name: 'Agent Horizon',
    from_owner_label: 'Account 4a12b8c9',
    to_agent_id: scout.id,
    to_agent_name: scout.name,
    note: '',
    requested_at: at,
    expires_at: new Date(Date.now() + 5 * 86_400_000 + 60_000).toISOString(),
    decided_at: null,
    revoked_at: null,
  };
}

async function register(page: Page) {
  const registered = await page.request.post('/api/auth/register', {
    headers,
    data: { name: `My-agents-${randomUUID().slice(0, 8)}`, password },
  });
  expect(registered.status()).toBe(201);
}

/** A signed-in workspace with a static agent list and mocked cross-owner requests. */
async function fixture(page: Page, requests: ConnectionRequest[] = [pending()]) {
  await register(page);
  const baseline = (await (await page.request.get('/api/snapshot')).json()) as Snapshot;
  const snapshot: Snapshot = { ...baseline, agents: [scout, writer, held, child, gone] };
  const calls: string[] = [];
  let incoming = requests;
  await page.route('**/api/events*', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }));
  await page.route(`**${REQUESTS}**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path.endsWith('/decide')) {
      calls.push(`decide ${(request.postDataJSON() as { decision: string }).decision}`);
      incoming = [];
      return route.fulfill({ json: { ok: true } });
    }
    if (request.method() === 'GET' && path === REQUESTS)
      return route.fulfill({ json: { incoming, outgoing: [], next_before: null } });
    return route.fallback();
  });
  await page.route('**/api/agents/*/revoke', (route) => {
    calls.push(`revoke ${new URL(route.request().url()).pathname.split('/')[3]}`);
    return route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/agents/*/rotate-credential', (route) => {
    calls.push('rotate');
    return route.fulfill({
      json: { agent: scout, token: `cc_agent_test_${'x'.repeat(32)}` },
    });
  });
  return calls;
}

async function openMyAgents(page: Page, preview = true, theme = 'light') {
  await page.goto(`/?workspace=${preview ? 'v2' : 'v1'}&theme=${theme}#connect`);
  await expect(page.locator('.app-shell')).toBeVisible();
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole('navigation', { name: 'Workspace', exact: true })
    // The nav item carries the pending request count ("My agents 1").
    .getByRole('button', { name: preview ? /^My agents/ : 'Agents' })
    .first()
    .click();
  const region = page.getByRole('region', { name: 'Agents', exact: true });
  await expect(region).toBeVisible();
  return region;
}

/** Opens an agent's detail from its list row (My agents v4: the row names its quiet line). */
async function openPanel(page: Page, region: Locator, name: string, line: string | RegExp) {
  await region
    .getByRole('listitem')
    .filter({ hasText: name })
    .getByRole('button', {
      name: typeof line === 'string' ? `${name}, ${line}` : new RegExp(`^${name}, `),
      exact: typeof line === 'string',
    })
    .click();
  const panel = page.getByRole('complementary', { name: `${name} details` });
  await expect(panel).toBeVisible();
  return panel;
}

const sizes = [
  { width: 390, height: 844 },
  { width: 1440, height: 1000 },
];

for (const size of sizes)
  for (const theme of ['light', 'dark'])
    test(`My agents v2 renders real status and kind at ${size.width}px ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await fixture(page);
      const region = await openMyAgents(page, true, theme);
      const list = region.getByRole('list', { name: 'Agents', exact: true });
      await expect(list.getByRole('listitem')).toHaveCount(5);
      const cards = list.getByRole('listitem');
      // Live agents first, removed last.
      await expect(cards.first()).toContainText('Research scout');
      await expect(cards.last()).toContainText('Retired agent');
      // One quiet line per row, from real fields only; the kind lives in the detail.
      await expect(cards.filter({ hasText: 'Research scout' })).toContainText('Active now');
      await expect(cards.filter({ hasText: 'Held reviewer' })).toContainText('Paused');
      await expect(cards.filter({ hasText: 'Retired agent' })).toContainText('Removed');
      // No hosted line, no invented model or metrics.
      await expect(region).not.toContainText('Hosted by Central City');
      await expect(region).not.toContainText(/\d+ runs|GPT|Claude/);
      // A removed agent is listed, faded, and not opened: there is nothing left to manage.
      await expect(cards.filter({ hasText: 'Retired agent' }).getByRole('button')).toHaveCount(0);
      const writerPanel = await openPanel(page, region, 'Draft writer', /./);
      await expect(writerPanel).toContainText('Template agent');
      await page.keyboard.press('Escape');
      // Pending request with owner label and expiry, in the requests sheet.
      await region.getByRole('button', { name: 'Requests, 1 pending' }).click();
      const requests = page
        .getByRole('complementary', { name: 'Connection requests' })
        .getByRole('list', { name: 'Pending connection requests' });
      await expect(requests).toContainText('Agent Horizon');
      await expect(requests).toContainText('Account 4a12b8c9');
      await expect(requests).toContainText('Expires in 5 days');
      await page.keyboard.press('Escape');
      // Touch targets and no horizontal scroll (a row is one button the size of the row). The
      // header icons draw 30px on wide screens; their tap area is a 44px ring around the glyph.
      for (const button of await region.getByRole('button').all()) {
        if (!(await button.isVisible())) continue;
        const box = await button.boundingBox();
        if (!box) continue;
        // Header icons and the detail's buttons draw at Rooms' size; their tap area is a ring.
        const icon = await button.evaluate(
          (element) =>
            element.classList.contains('ma4-icon') ||
            element.classList.contains('ap4-btn') ||
            element.classList.contains('ma3-btn'),
        );
        if (icon && size.width > 900) {
          const hit = await button.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const probe = element.classList.contains('ma4-icon')
              ? document.elementFromPoint(rect.left - 6, rect.top + rect.height / 2)
              : document.elementFromPoint(rect.left + rect.width / 2, rect.top - 3);
            return probe === element || element.contains(probe);
          });
          expect(hit).toBe(true);
        } else expect(box.height).toBeGreaterThanOrEqual(workspaceTarget(size.width));
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`my-agents-${size.width}-${theme}.png`),
        fullPage: true,
      });
    });

for (const size of sizes) {
  test(`remove confirms the consequences and revokes at ${size.width}px`, async ({ page }) => {
    await page.setViewportSize(size);
    const calls = await fixture(page);
    const region = await openMyAgents(page);
    const panel = await openPanel(page, region, 'Research scout', 'Active now');
    await panel.getByRole('button', { name: 'More for Research scout' }).click();
    await panel.getByRole('menuitem', { name: 'Remove agent' }).click();
    await expect(panel).toContainText('1 agent created under it goes too: Scout helper.');
    // Back keeps the agent.
    await panel.getByRole('button', { name: 'Research scout', exact: true }).click();
    expect(calls).toEqual([]);
    await panel.getByRole('button', { name: 'More for Research scout' }).click();
    await panel.getByRole('menuitem', { name: 'Remove agent' }).click();
    await panel
      .getByRole('textbox', { name: 'Type Research scout to confirm' })
      .fill('Research scout');
    await panel.getByRole('button', { name: 'Remove agent', exact: true }).click();
    await expect(page.getByText('Research scout was removed.')).toBeVisible();
    expect(calls).toEqual([`revoke ${scout.id}`]);
  });

  for (const decision of ['approve', 'deny'] as const)
    test(`pending request ${decision} at ${size.width}px`, async ({ page }) => {
      await page.setViewportSize(size);
      const calls = await fixture(page);
      const region = await openMyAgents(page);
      await region.getByRole('button', { name: 'Requests, 1 pending' }).click();
      const sheet = page.getByRole('complementary', { name: 'Connection requests' });
      await sheet
        .getByRole('button', {
          name: `${decision === 'approve' ? 'Approve' : 'Deny'} connection request from Agent Horizon`,
        })
        .click();
      await expect(
        page.getByText(
          decision === 'approve'
            ? 'Connection from Agent Horizon approved.'
            : 'Request denied. They can ask again after 7 days.',
        ),
      ).toBeVisible();
      expect(calls).toEqual([`decide ${decision}`]);
      await expect(sheet.getByRole('list', { name: 'Pending connection requests' })).toHaveCount(0);
      await page.keyboard.press('Escape');
      // The Requests icon drops its count once nothing is pending.
      await expect(region.getByRole('button', { name: 'Requests', exact: true })).toBeVisible();
    });
}

test('request read failure shows an error with Retry', async ({ page }) => {
  await register(page);
  let fail = true;
  await page.route(`**${REQUESTS}**`, (route) =>
    fail
      ? route.fulfill({ status: 500, json: { error: 'Request read failed.' } })
      : route.fulfill({ json: { incoming: [pending()], outgoing: [], next_before: null } }),
  );
  const region = await openMyAgents(page);
  await expect(region.getByRole('alert')).toContainText('Connection requests could not be loaded');
  fail = false;
  await region.getByRole('button', { name: 'Retry' }).click();
  await expect(region.getByRole('button', { name: 'Requests, 1 pending' })).toBeVisible();
});

test('empty workspace offers add and claim', async ({ page }) => {
  await register(page);
  const region = await openMyAgents(page);
  await expect(region.getByRole('heading', { name: 'Your agents live here.' })).toBeVisible();
  await region.getByRole('button', { name: 'Add an agent', exact: true }).last().click();
  await expect(page.getByRole('complementary', { name: 'Add an agent' })).toBeVisible();
  await page.keyboard.press('Escape');
  await region.getByRole('button', { name: 'Claim from a link' }).first().click();
  await expect(page.getByLabel('Claim agents your AI created')).toBeFocused();
});

for (const size of sizes)
  test(`claim links still work with the preview on at ${size.width}px`, async ({ page }) => {
    await page.setViewportSize(size);
    const created = await page.request.post('/api/public/agents', {
      headers: { 'content-type': 'application/json' },
      data: { template: 'template:research-analyst@1.0.0', idempotency_key: randomUUID() },
    });
    expect(created.status()).toBe(201);
    const result = (await created.json()) as {
      agent: { id: string };
      claim: { claim_token: string };
    };
    await register(page);
    await openMyAgents(page);
    await page.goto(`/#claim=${result.claim.claim_token}`);
    const input = page.getByLabel('Claim agents your AI created');
    await expect(input).toHaveValue(result.claim.claim_token);
    expect(new URL(page.url()).hash).toBe('');
    await page.getByRole('button', { name: 'Claim', exact: true }).click();
    await expect(page.getByText('The agents are now in your workspace.')).toBeVisible();
    // The claim sheet closes once the claim went through.
    await expect(page.getByRole('dialog', { name: 'Claim from a link' })).toHaveCount(0);
    const region = page.getByRole('region', { name: 'Agents', exact: true });
    await expect(region.getByRole('list', { name: 'Agents', exact: true })).toContainText(
      'Research',
    );
  });

for (const size of sizes)
  test(`Elric's row opens Elric's own detail at ${size.width}px`, async ({ page }) => {
    await page.setViewportSize(size);
    const elric = agent('88888888-8888-4888-8888-888888888888', 'Elric', { mode: 'hosted' });
    const calls = await fixture(page);
    const baseline = (await (await page.request.get('/api/snapshot')).json()) as Snapshot;
    await page.route('**/api/snapshot', (route) =>
      route.fulfill({ json: { ...baseline, agents: [elric, scout, writer] } }),
    );
    const none = { short: 0, summary: 0, tool: 0 };
    const waiting = (id: string) => ({
      id,
      tool: 'room_task_create',
      summary: 'Create a task',
      args_hash: 'hash',
      room: null,
      created_at: at,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const chat = {
      id: '99999999-9999-4999-8999-999999999999',
      slug: 'launch-plan',
      title: 'Launch plan',
      person_member_id: 'member',
      created_at: at,
      updated_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      latest_seq: 4,
      read_only: false,
    };
    await page.route('**/api/elric**', (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({
        json:
          path === '/api/elric'
            ? {
                agent_id: elric.id,
                status: 'active',
                usage: { used: none, allowance: none, resets_at: at },
              }
            : path === '/api/elric/pending'
              ? { pending: [waiting('p1'), waiting('p2')] }
              : path === '/api/elric/conversations'
                ? { conversations: [chat] }
                : { turns: [], next_cursor: null },
      });
    });
    const region = await openMyAgents(page);
    const rows = region.getByRole('listitem');
    // Pinned first, built in (Elric's own state); no hosted line.
    const card = rows.first();
    await expect(card).toContainText('Elric');
    await expect(card).toContainText('Built in');
    await expect(card).not.toContainText('Hosted by Central City');
    // One control: the row, which opens Elric's own detail like any other row.
    await expect(card.getByRole('button')).toHaveCount(1);
    await expect(rows.filter({ hasText: 'Elric' })).toHaveCount(1);
    const trigger = card.getByRole('button', { name: 'Elric, Built in', exact: true });
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(card).toHaveAttribute('data-open', 'true');
    const panel = page.getByRole('complementary', { name: 'Elric details' });
    await expect(panel.getByRole('heading', { level: 2, name: 'Elric' })).toBeFocused();
    await expect(panel).toContainText('On · Built in');
    await expect(panel.getByRole('button', { name: 'Chat', exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    // Real values only: 2 approvals waiting, the latest chat and when it was last active.
    await expect(panel.getByRole('button', { name: /^Approvals/ })).toContainText('2');
    await expect(panel.getByRole('button', { name: /^Chats/ })).toContainText('Launch plan · 2h');
    await expect(panel.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    // Elric is never removed or rotated from here.
    await expect(panel.getByRole('button', { name: /Remove|Rotate|More for/ })).toHaveCount(0);
    await expect(page.getByRole('complementary', { name: /details$/ })).toHaveCount(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    // Escape closes the detail; focus returns to Elric's row.
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(calls).toEqual([]);
  });
