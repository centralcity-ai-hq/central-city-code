import { expect, test, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ConnectionInvite, ConnectionRequest } from '../shared/assistant';
import type { Capability, Snapshot } from '../shared/types';
import { openAdvancedGroup } from './settings-nav';
import { workspaceTarget } from './workspace-density';

/*
 * Agent permissions v3, "Your agents, your rules". Your own routes are real (the three CC agents
 * and their two routes, POST/DELETE /api/connections, POST /api/jobs); connections with other
 * people are synthetic fixtures behind /api/v2/connections/*, answered from a small in-test
 * state so every control (approve, deny, invites, requests, withdraw, end) can be exercised.
 * Every flow runs at 1440 and 390 px, light and dark. Screenshots go to PERM3_SHOTS when set
 * (local review only, never committed).
 */

const headers = { 'X-City-Request': '1' };
const base = '/api/v2/connections';
const sent = '2026-10-03T12:00:00.000Z';
const later = '2026-10-10T12:00:00.000Z';
/** Arrow and chevron characters: direction is drawn and said in words, never with glyphs. */
const ARROWS = new RegExp(
  `[${(
    [
      [0x2190, 0x21ff], // Arrows
      [0x27f0, 0x27ff], // Supplemental Arrows-A
      [0x2900, 0x297f], // Supplemental Arrows-B
      [0x2039, 0x203a], // single angle quotation marks
      [0xab, 0xab], // double angle quotation marks
      [0xbb, 0xbb],
    ] as const
  )
    .map(([from, to]) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`)
    .join('')}]`,
);

type Ids = { scout: string; porter: string; checker: string };
type Cross = {
  incoming: ConnectionRequest[];
  outgoing: ConnectionRequest[];
  invites: ConnectionInvite[];
  calls: Array<{ method: string; path: string; body: unknown }>;
};

function crossRequest(overrides: Partial<ConnectionRequest>): ConnectionRequest {
  return {
    id: 'test-request-0000',
    direction: 'incoming',
    status: 'pending',
    from_agent_id: 'test-peer-0001',
    from_agent_name: 'Ledger',
    from_owner_label: 'Northwind Research',
    to_agent_id: 'test-agent-0000',
    to_agent_name: null,
    note: '',
    requested_at: sent,
    expires_at: later,
    decided_at: null,
    revoked_at: null,
    ...overrides,
  };
}

/** Sample connections with other people: two waiting for you, one connected, two you sent. */
function sample(ids: Ids): Cross {
  return {
    incoming: [
      crossRequest({
        id: 'test-request-0001',
        to_agent_id: ids.checker,
        note: 'We send weekly supplier lists; Checker would check each company.',
      }),
      crossRequest({
        id: 'test-request-0002',
        from_agent_id: 'test-peer-0002',
        from_agent_name: 'Mapper',
        from_owner_label: 'Field Office',
        to_agent_id: ids.porter,
      }),
      crossRequest({
        id: 'test-request-0003',
        status: 'approved',
        from_agent_id: 'test-peer-0003',
        from_agent_name: 'Quill',
        from_owner_label: 'Harbor Labs',
        to_agent_id: ids.scout,
        decided_at: sent,
      }),
    ],
    outgoing: [
      crossRequest({
        id: 'test-outgoing-0001',
        direction: 'outgoing',
        from_agent_id: ids.scout,
        from_agent_name: 'Scout',
        from_owner_label: 'Your workspace',
        to_agent_id: 'test-peer-0004',
        to_agent_name: null,
      }),
      crossRequest({
        id: 'test-outgoing-0002',
        direction: 'outgoing',
        status: 'revoked',
        from_agent_id: ids.porter,
        from_agent_name: 'Porter',
        from_owner_label: 'Your workspace',
        to_agent_id: 'test-peer-0005',
        to_agent_name: 'Index',
        decided_at: sent,
        revoked_at: sent,
      }),
    ],
    invites: [
      {
        id: 'test-invite-0001',
        agent_id: ids.checker,
        created_at: sent,
        expires_at: later,
        status: 'active',
      },
      {
        id: 'test-invite-0002',
        agent_id: ids.scout,
        created_at: sent,
        expires_at: sent,
        status: 'expired',
      },
    ],
    calls: [],
  };
}

/** Answers /api/v2/connections/* from `state`, recording every write. */
async function mockCross(page: Page, state: Cross) {
  await page.route(
    (url) => url.pathname.startsWith(`${base}/`),
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname.slice(base.length);
      const method = request.method();
      if (method === 'GET' && path === '/requests')
        return route.fulfill({ json: { incoming: state.incoming, outgoing: state.outgoing } });
      if (method === 'GET' && path === '/invites')
        return route.fulfill({ json: { invites: state.invites } });
      const body = request.postDataJSON() as Record<string, string> | null;
      state.calls.push({ method, path, body });
      const decided = /^\/requests\/([^/]+)\/(decide|revoke)$/.exec(path);
      if (method === 'POST' && decided) {
        const item = [...state.incoming, ...state.outgoing].find((row) => row.id === decided[1])!;
        if (decided[2] === 'decide') {
          item.status = body?.decision === 'approve' ? 'approved' : 'denied';
          item.decided_at = later;
        } else {
          item.status = 'revoked';
          item.revoked_at = later;
        }
        return route.fulfill({ json: { request: item } });
      }
      if (method === 'POST' && path === '/requests') {
        const item = crossRequest({
          id: `test-outgoing-${randomUUID().slice(0, 8)}`,
          direction: 'outgoing',
          from_agent_id: body!.from_agent_id,
          from_owner_label: 'Your workspace',
          to_agent_id: 'test-peer-0009',
          note: body?.note ?? '',
          requested_at: later,
        });
        state.outgoing.unshift(item);
        return route.fulfill({ status: 201, json: { request: item, replayed: false } });
      }
      if (method === 'POST' && path === '/invites') {
        const invite: ConnectionInvite = {
          id: `test-invite-${randomUUID().slice(0, 8)}`,
          agent_id: body!.agent_id,
          created_at: later,
          expires_at: later,
          status: 'active',
        };
        state.invites.unshift(invite);
        // A synthetic, low-entropy code in the shape of a real one (cci_ and 43 characters).
        const code = `cci_${'test0'.repeat(9).slice(0, 43)}`;
        return route.fulfill({ status: 201, json: { invite, invite_token: code } });
      }
      const cancel = /^\/invites\/([^/]+)$/.exec(path);
      if (method === 'DELETE' && cancel) {
        state.invites.find((item) => item.id === cancel[1])!.status = 'revoked';
        return route.fulfill({ json: { ok: true } });
      }
      return route.fulfill({ status: 404, json: { error: 'Not mocked.' } });
    },
  );
}

async function setup(page: Page, scheme: 'light' | 'dark', options: { cross?: boolean } = {}) {
  await page.addInitScript((theme) => localStorage.setItem('cc-theme', theme), scheme);
  const registered = await page.request.post('/api/auth/register', {
    headers,
    data: {
      name: `Permissions-v3-${randomUUID().slice(0, 8)}`,
      password: 'Local-test-only-passphrase-2026',
    },
  });
  expect(registered.status()).toBe(201);
  expect((await page.request.post('/api/demo/start', { headers, data: {} })).ok()).toBe(true);
  // The CC agents come online on the server's next tick; Send work lists online routes only.
  await expect
    .poll(async () => (await snapshot(page)).stats.reachable, { timeout: 15_000 })
    .toBe(3);
  // The demonstration agents are found by what they do and given neutral names for this test
  // (PATCH /api/agents/:id, the My agents rename), so the expectations below read the same.
  const agents = (await snapshot(page)).agents;
  const rename = async (capability: Capability, name: string) => {
    const agent = agents.find((item) => item.isDemo && item.capability === capability)!;
    const renamed = await page.request.patch(`/api/agents/${agent.id}`, {
      headers,
      data: { name },
    });
    expect(renamed.ok()).toBe(true);
    return agent.id;
  };
  const ids = {
    scout: await rename('research', 'Scout'),
    porter: await rename('extract', 'Porter'),
    checker: await rename('verify', 'Checker'),
  };
  const cross =
    options.cross === false
      ? { ...sample(ids), incoming: [], outgoing: [], invites: [] }
      : sample(ids);
  await mockCross(page, cross);
  return { ids, cross };
}

async function snapshot(page: Page) {
  return (await (await page.request.get('/api/snapshot')).json()) as Snapshot;
}

async function open(page: Page) {
  await page.goto('/#connect');
  await expect(page.locator('.app-shell')).toBeVisible();
  await (
    await openAdvancedGroup(page)
  )
    .getByRole('button', { name: 'Agent permissions', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Agent permissions', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.sidebar.open')).toHaveCount(0);
}

const card = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const routes = (page: Page) =>
  card(page, 'Between your agents').getByRole('list', { name: 'Routes between your agents' });
const others = (page: Page) =>
  card(page, 'With other people').getByRole('list', { name: 'Connections with other people' });

async function expectFits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

async function expectNoArrows(scope: Locator) {
  expect(await scope.innerText()).not.toMatch(ARROWS);
}

/** Every visible control on the page is a full target (44 px on phones, 90% on desktop). */
async function expectTargets(page: Page) {
  const target = workspaceTarget(page.viewportSize()!.width);
  const small = await page.evaluate(
    (target) =>
      [...document.querySelectorAll<HTMLElement>('.perm3 button, .perm3 select, .perm3 input')]
        .filter((element) => element.offsetParent !== null)
        .map((element) => ({
          text: element.textContent?.trim() || element.getAttribute('aria-label') || '',
          height: Math.round(element.getBoundingClientRect().height * 100) / 100,
        }))
        .filter((item) => item.height < target),
    target,
  );
  expect(small).toEqual([]);
}

/** Opens a ⋯ menu from the keyboard; the first item takes focus. */
async function openMenu(page: Page, label: string | RegExp) {
  const button = page.getByRole('button', { name: label });
  await button.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: label });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  return { button, menu };
}

const VIEWS = [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
] as const;

for (const { width, height } of VIEWS) {
  for (const scheme of ['light', 'dark'] as const) {
    test.describe(`agent permissions v3 at ${width} px, ${scheme}`, () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width, height });
      });

      test('the page: header, facts, cards, words not arrows, targets and fit', async ({
        page,
      }) => {
        await setup(page, scheme);
        await open(page);
        await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
        const main = page.locator('main.adv2');
        await expect(main).toHaveAttribute('data-adv2-view', 'connections');
        await expect(page).toHaveTitle('Agent permissions · Central City');
        await expect(main.getByText('Your agents, your rules', { exact: true })).toBeVisible();
        await expect(
          main.getByText(
            'Each connection lets one agent send work to another, in one direction. You decide every route.',
          ),
        ).toBeVisible();
        await expect(
          main.getByRole('list', { name: 'What a connection means' }).getByRole('listitem'),
        ).toHaveText([
          'No tools or passwords are shared',
          'Work goes one way only',
          'End any connection at any time',
        ]);
        // Header: Requests (2 waiting), Invite someone (not on phones), New connection.
        // The chip's name starts with what it shows (label in name).
        const chip = main.getByRole('button', { name: 'Requests 2 waiting', exact: true });
        await expect(chip).toBeVisible();
        await expect(chip).toHaveText('Requests 2');
        await expect(main.getByRole('button', { name: 'Invite someone', exact: true })).toBeVisible(
          { visible: width > 640 },
        );
        await expect(
          main.locator('.perm3-topbar').getByRole('button', { name: 'New connection' }),
        ).toBeEnabled();
        await expect(main.locator('.perm3-pill-sub')).toHaveText('3 active');
        // The request: External, their workspace, the route drawn and said, their note.
        const requests = card(page, 'Waiting for your approval');
        const ledger = requests.getByRole('listitem').filter({ hasText: 'Ledger' });
        await expect(ledger.getByText('External', { exact: true })).toBeVisible();
        await expect(ledger).toContainText('Northwind Research');
        await expect(ledger).toContainText(
          "Wants to send work to Checker. Checker can't send work back.",
        );
        await expect(ledger.getByText('Ledger wants to send work to Checker')).toBeAttached();
        await expect(ledger).toContainText(
          'Their note · External, check before your agent follows it',
        );
        await expect(ledger).toContainText('We send weekly supplier lists');
        // Your routes: each drawn, then said in words, with its capability.
        await expect(routes(page).getByRole('listitem')).toHaveCount(2);
        const first = routes(page)
          .getByRole('listitem')
          .filter({ hasText: 'Scout sends work to Porter' });
        await expect(first).toContainText('Scout sends work to Porter. Not the other way.');
        await expect(first.getByText('Extraction', { exact: true })).toBeVisible();
        await expect(first.locator('.perm3-wire')).toBeVisible();
        // With other people: status pills.
        await expect(others(page).getByRole('listitem')).toHaveCount(3);
        await expect(others(page)).toContainText('Connected');
        await expect(others(page)).toContainText('Waiting for approval');
        await expect(others(page)).toContainText('Ended');
        await expect(page.getByText(/^Names, notes and messages from other people/)).toBeVisible();
        // Invite someone and Use an invite: side by side on desktop, stacked on phones.
        const [invite, use] = await Promise.all([
          card(page, 'Invite someone').boundingBox(),
          card(page, 'Use an invite').boundingBox(),
        ]);
        if (width > 640) expect(Math.round(invite!.y)).toBe(Math.round(use!.y));
        else expect(use!.y).toBeGreaterThan(invite!.y + invite!.height - 1);
        await expectNoArrows(main);
        await expectFits(page);
        await expectTargets(page);
        const dir = process.env.PERM3_SHOTS;
        if (dir)
          await page.screenshot({
            path: join(dir, `agent-permissions-${width}-${scheme}.png`),
            fullPage: true,
          });
        // Reduced motion: the travelling dot stops; the line and its end dot stay.
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await expect(first.locator('.perm3-wire i')).toBeHidden();
        await expect(first.locator('.perm3-wire')).toBeVisible();
      });

      test('new connection one way, then the way back from the menu', async ({ page }) => {
        await setup(page, scheme);
        await open(page);
        const opener = page
          .locator('.perm3-topbar')
          .getByRole('button', { name: 'New connection' });
        await opener.click();
        const sheet = page.getByRole('dialog', { name: 'New connection' });
        await expect(sheet.getByRole('combobox', { name: 'Sends work' })).toBeFocused();
        // Escape closes the sheet; focus goes back to the button that opened it.
        await page.keyboard.press('Escape');
        await expect(sheet).toHaveCount(0);
        await expect(opener).toBeFocused();
        await opener.click();
        await sheet
          .getByRole('combobox', { name: 'Sends work' })
          .selectOption({ label: 'Checker' });
        await sheet
          .getByRole('combobox', { name: 'Does the work' })
          .selectOption({ label: 'Checker' });
        await expect(sheet.getByText('Pick two different agents.')).toBeVisible();
        await expect(sheet.getByRole('button', { name: 'Connect', exact: true })).toBeDisabled();
        await sheet
          .getByRole('combobox', { name: 'Does the work' })
          .selectOption({ label: 'Scout' });
        await expect(sheet).toContainText(
          "Checker can send work to Scout. Scout can't send work back.",
        );
        await expectNoArrows(sheet);
        const posted = page.waitForRequest(
          (request) =>
            new URL(request.url()).pathname === '/api/connections' && request.method() === 'POST',
        );
        await sheet.getByRole('button', { name: 'Connect', exact: true }).click();
        const ids = Object.fromEntries((await snapshot(page)).agents.map((a) => [a.name, a.id]));
        expect((await posted).postDataJSON()).toEqual({
          fromAgentId: ids.Checker,
          toAgentId: ids.Scout,
        });
        await expect(sheet).toHaveCount(0);
        // The row keeps its ⋯ name while its words change once the way back exists.
        const row = routes(page)
          .getByRole('listitem')
          .filter({ has: page.getByRole('button', { name: 'More for Checker to Scout' }) });
        await expect(row).toContainText('Checker sends work to Scout. Not the other way.');
        await expect(routes(page).getByRole('listitem')).toHaveCount(3);
        // ⋯ (keyboard) > Let Scout send work back: the sheet opens reversed.
        const { menu } = await openMenu(page, 'More for Checker to Scout');
        await expect(menu.getByRole('menuitem')).toHaveText([
          'Let Scout send work back',
          'See work sent',
          'End connection',
        ]);
        await page.keyboard.press('Enter');
        await expect(sheet.getByRole('combobox', { name: 'Sends work' })).toHaveValue(ids.Scout);
        await expect(sheet.getByRole('combobox', { name: 'Does the work' })).toHaveValue(
          ids.Checker,
        );
        await sheet.getByRole('button', { name: 'Connect', exact: true }).click();
        await expect(sheet).toHaveCount(0);
        await expect(row).toContainText('Scout can also send work to Checker');
        await expect(routes(page).getByRole('listitem')).toHaveCount(4);
        // A route both ways has no "send work back" item.
        const again = await openMenu(page, 'More for Checker to Scout');
        await expect(again.menu.getByRole('menuitem')).toHaveText([
          'See work sent',
          'End connection',
        ]);
        await page.keyboard.press('Escape');
        await expect(again.menu).toHaveCount(0);
        await expect(again.button).toBeFocused();
        await expectFits(page);
      });

      test('new connection both ways makes two routes', async ({ page }) => {
        await setup(page, scheme);
        await open(page);
        await page.locator('.perm3-topbar').getByRole('button', { name: 'New connection' }).click();
        const sheet = page.getByRole('dialog', { name: 'New connection' });
        // An existing route is named; adding the way back is still possible.
        await sheet.getByRole('combobox', { name: 'Sends work' }).selectOption({ label: 'Scout' });
        await sheet
          .getByRole('combobox', { name: 'Does the work' })
          .selectOption({ label: 'Porter' });
        await expect(sheet.getByText('Scout can already send work to Porter.')).toBeVisible();
        await expect(sheet.getByRole('button', { name: 'Connect', exact: true })).toBeDisabled();
        await sheet.getByRole('checkbox', { name: 'Also let it send work back' }).check();
        await expect(
          sheet.getByText('Only the way back is added.', { exact: false }),
        ).toBeVisible();
        await expect(sheet.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
        // A new pair both ways: two POST /api/connections, one per direction.
        await sheet
          .getByRole('combobox', { name: 'Sends work' })
          .selectOption({ label: 'Checker' });
        await sheet
          .getByRole('combobox', { name: 'Does the work' })
          .selectOption({ label: 'Scout' });
        await expect(sheet).toContainText('Checker and Scout can send work to each other.');
        const bodies: unknown[] = [];
        page.on('request', (request) => {
          if (new URL(request.url()).pathname === '/api/connections' && request.method() === 'POST')
            bodies.push(request.postDataJSON());
        });
        await sheet.getByRole('button', { name: 'Connect', exact: true }).click();
        await expect(sheet).toHaveCount(0);
        await expect(page.getByText('Connected both ways.', { exact: false })).toBeVisible();
        const ids = Object.fromEntries((await snapshot(page)).agents.map((a) => [a.name, a.id]));
        expect(bodies).toEqual([
          { fromAgentId: ids.Checker, toAgentId: ids.Scout },
          { fromAgentId: ids.Scout, toAgentId: ids.Checker },
        ]);
        await expect(routes(page).getByRole('listitem')).toHaveCount(4);
        await expect(
          routes(page)
            .getByRole('listitem')
            .filter({ hasText: 'Scout can also send work to Checker' }),
        ).toHaveCount(1);
        await expect(
          routes(page)
            .getByRole('listitem')
            .filter({ hasText: 'Checker can also send work to Scout' }),
        ).toHaveCount(1);
      });

      test('both ways: a failed way back keeps the first route and says so', async ({ page }) => {
        await setup(page, scheme);
        await open(page);
        // The second POST /api/connections (the way back) fails once; the first goes through.
        let posts = 0;
        await page.route('**/api/connections', async (route) => {
          if (route.request().method() !== 'POST') return route.fallback();
          posts += 1;
          if (posts === 2)
            return route.fulfill({ status: 503, json: { error: 'Please try again.' } });
          return route.fallback();
        });
        await page.locator('.perm3-topbar').getByRole('button', { name: 'New connection' }).click();
        const sheet = page.getByRole('dialog', { name: 'New connection' });
        await sheet
          .getByRole('combobox', { name: 'Sends work' })
          .selectOption({ label: 'Checker' });
        await sheet
          .getByRole('combobox', { name: 'Does the work' })
          .selectOption({ label: 'Scout' });
        await sheet.getByRole('checkbox', { name: 'Also let it send work back' }).check();
        await sheet.getByRole('button', { name: 'Connect', exact: true }).click();
        // The sheet stays open with the reason; the page already shows the first route.
        await expect(sheet.getByRole('alert')).toContainText(
          'Checker can now send work to Scout, but the way back failed: Please try again.',
        );
        expect(posts).toBe(2);
        await expect(
          routes(page)
            .getByRole('listitem')
            .filter({ hasText: 'Checker sends work to Scout. Not the other way.' }),
        ).toHaveCount(1);
        // Trying again adds only the missing way back.
        await expect(
          sheet.getByText('Only the way back is added.', { exact: false }),
        ).toBeVisible();
        await sheet.getByRole('button', { name: 'Connect', exact: true }).click();
        await expect(sheet).toHaveCount(0);
        expect(posts).toBe(3);
        await expect(
          routes(page)
            .getByRole('listitem')
            .filter({ hasText: 'Scout can also send work to Checker' }),
        ).toHaveCount(1);
        await expectFits(page);
      });

      test('send work along a route, and not while the workspace is paused', async ({ page }) => {
        await setup(page, scheme);
        await open(page);
        const ids = Object.fromEntries((await snapshot(page)).agents.map((a) => [a.name, a.id]));
        await page.getByRole('button', { name: 'Send work from Scout to Porter' }).click();
        const dialog = page.getByRole('dialog', { name: 'Send work.' });
        await expect(dialog.getByRole('combobox', { name: 'Connection' })).toHaveValue(
          (await snapshot(page)).connections.find((c) => c.fromAgentId === ids.Scout)!.id,
        );
        await expectNoArrows(dialog);
        await dialog
          .getByLabel('Text to work on')
          .fill('Project: River Library\nSource: https://example.com/river');
        const posted = page.waitForRequest(
          (request) =>
            new URL(request.url()).pathname === '/api/jobs' && request.method() === 'POST',
        );
        await dialog.getByRole('button', { name: 'Send work', exact: true }).click();
        expect((await posted).postDataJSON()).toMatchObject({
          requesterId: ids.Scout,
          providerId: ids.Porter,
        });
        await expect(page.getByText('Work sent. Follow its progress here.')).toBeVisible();
        await page.keyboard.press('Escape');
        // "See work sent" opens Research & review.
        await openMenu(page, 'More for Scout to Porter');
        await page.getByRole('menuitem', { name: 'See work sent' }).click();
        await expect(
          page.getByRole('heading', { level: 1, name: 'Research & review', exact: true }),
        ).toBeVisible();
        // A paused workspace sends no work: every Send work waits.
        expect(
          (
            await page.request.post('/api/workspace/pause', { headers, data: { paused: true } })
          ).ok(),
        ).toBe(true);
        await open(page);
        await expect(page.getByText('Workspace paused.', { exact: false })).toBeVisible();
        for (const button of await page.getByRole('button', { name: /^Send work from / }).all())
          await expect(button).toBeDisabled();
      });

      test('end connection asks first, then ends the route', async ({ page }) => {
        await setup(page, scheme);
        await open(page);
        const { button } = await openMenu(page, 'More for Porter to Checker');
        await page.getByRole('menuitem', { name: 'End connection' }).click();
        const confirm = page.getByRole('dialog', { name: 'End connection?' });
        await expect(confirm).toContainText(
          "Porter can't send new work to Checker. Unfinished work between them stops.",
        );
        // The confirm sits in the window (not in the page's column) and fully on screen.
        const box = (await confirm.boundingBox())!;
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(height);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        await confirm.getByRole('button', { name: 'Keep it' }).click();
        await expect(confirm).toHaveCount(0);
        await expect(button).toBeFocused();
        await expect(routes(page).getByRole('listitem')).toHaveCount(2);
        // Escape keeps it too.
        await openMenu(page, 'More for Porter to Checker');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        await expect(page.getByRole('menuitem', { name: 'End connection' })).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(confirm).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(confirm).toHaveCount(0);
        await openMenu(page, 'More for Porter to Checker');
        await page.getByRole('menuitem', { name: 'End connection' }).click();
        const removed = page.waitForRequest(
          (request) =>
            request.method() === 'DELETE' &&
            new URL(request.url()).pathname.startsWith('/api/connections/'),
        );
        await confirm.getByRole('button', { name: 'End connection', exact: true }).click();
        await removed;
        await expect(confirm).toHaveCount(0);
        await expect(
          page.getByText('Connection ended. No new work can be sent this way.'),
        ).toBeVisible();
        await expect(routes(page).getByRole('listitem')).toHaveCount(1);
        await expect(routes(page)).not.toContainText('Porter sends work to Checker');
        expect((await snapshot(page)).connections).toHaveLength(1);
      });

      test('a failed end or deny keeps its confirm open with the reason', async ({ page }) => {
        await setup(page, scheme);
        await open(page);
        // End fails once: the confirm stays, says why, and the page shows no banner behind it.
        await page.route(
          (url) => url.pathname.startsWith('/api/connections/'),
          (route) =>
            route.request().method() === 'DELETE'
              ? route.fulfill({ status: 500, json: { error: 'The connection could not end.' } })
              : route.fallback(),
          { times: 1 },
        );
        await openMenu(page, 'More for Porter to Checker');
        await page.getByRole('menuitem', { name: 'End connection' }).click();
        const end = page.getByRole('dialog', { name: 'End connection?' });
        const confirmEnd = end.getByRole('button', { name: 'End connection', exact: true });
        await confirmEnd.click();
        await expect(end.getByRole('alert')).toHaveText('The connection could not end.');
        await expect(confirmEnd).toBeEnabled();
        await expect(page.locator('.error-banner')).toHaveCount(0);
        await expect(routes(page).getByRole('listitem')).toHaveCount(2);
        // Trying again ends it and closes the confirm.
        await confirmEnd.click();
        await expect(end).toHaveCount(0);
        await expect(routes(page).getByRole('listitem')).toHaveCount(1);
        // Deny fails once: the same, in the Deny confirm.
        await page.route(
          `**${base}/requests/test-request-0002/decide`,
          (route) =>
            route.fulfill({ status: 500, json: { error: 'The request could not be denied.' } }),
          { times: 1 },
        );
        await card(page, 'Waiting for your approval')
          .getByRole('button', { name: 'Deny connection request from Mapper' })
          .click();
        const deny = page.getByRole('dialog', { name: 'Deny request?' });
        await deny.getByRole('button', { name: 'Deny', exact: true }).click();
        await expect(deny.getByRole('alert')).toHaveText('The request could not be denied.');
        await deny.getByRole('button', { name: 'Deny', exact: true }).click();
        await expect(deny).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Requests 1 waiting' })).toBeVisible();
        // A confirm opened again starts without the last failure.
        await page.route(
          `**${base}/requests/test-request-0001/decide`,
          (route) => route.fulfill({ status: 500, json: { error: 'Not now.' } }),
          { times: 1 },
        );
        const ledgerDeny = card(page, 'Waiting for your approval').getByRole('button', {
          name: 'Deny connection request from Ledger',
        });
        await ledgerDeny.click();
        await deny.getByRole('button', { name: 'Deny', exact: true }).click();
        await expect(deny.getByRole('alert')).toHaveText('Not now.');
        await deny.getByRole('button', { name: 'Cancel', exact: true }).click();
        await ledgerDeny.click();
        await expect(deny).toBeVisible();
        await expect(deny.getByRole('alert')).toHaveCount(0);
      });

      test('approve, and deny after a confirm, requests from other people', async ({ page }) => {
        const { cross } = await setup(page, scheme);
        await open(page);
        // The Requests chip takes you to the requests.
        await page.getByRole('button', { name: 'Requests 2 waiting' }).click();
        await expect(page.locator('#perm3-requests-title')).toBeFocused();
        const requests = card(page, 'Waiting for your approval');
        await requests
          .getByRole('button', { name: 'Approve connection request from Ledger', exact: true })
          .click();
        await expect(card(page, 'With other people').getByRole('status')).toContainText(
          'Connection approved.',
        );
        expect(cross.calls).toContainEqual({
          method: 'POST',
          path: '/requests/test-request-0001/decide',
          body: { decision: 'approve' },
        });
        await expect(
          others(page).getByRole('listitem').filter({ hasText: 'Ledger' }),
        ).toContainText('Connected');
        await expect(page.getByRole('button', { name: 'Requests 1 waiting' })).toBeVisible();
        // Deny asks first; Cancel keeps the request.
        const deny = requests.getByRole('button', { name: 'Deny connection request from Mapper' });
        await deny.click();
        const confirm = page.getByRole('dialog', { name: 'Deny request?' });
        await expect(confirm).toContainText(
          "Mapper won't be connected to Porter. They can ask again after 7 days.",
        );
        await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(confirm).toHaveCount(0);
        await expect(deny).toBeFocused();
        expect(cross.calls.filter((call) => call.path.endsWith('/decide'))).toHaveLength(1);
        await deny.click();
        await confirm.getByRole('button', { name: 'Deny', exact: true }).click();
        await expect(confirm).toHaveCount(0);
        expect(cross.calls).toContainEqual({
          method: 'POST',
          path: '/requests/test-request-0002/decide',
          body: { decision: 'deny' },
        });
        await expect(card(page, 'With other people').getByRole('status')).toContainText(
          'Request denied. They can ask again after 7 days.',
        );
        await expect(requests).toHaveCount(0);
        await expect(page.getByRole('button', { name: /^Requests \d+ waiting$/ })).toHaveCount(0);
        await expect(
          others(page).getByRole('listitem').filter({ hasText: 'Mapper' }),
        ).toContainText('Denied');
      });

      test('invites: create, copy and cancel', async ({ page, context }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        const { cross, ids } = await setup(page, scheme);
        await open(page);
        if (width > 640) {
          await page.getByRole('button', { name: 'Invite someone', exact: true }).click();
          await expect(page.locator('#perm3-invite-title')).toBeFocused();
        }
        const invite = card(page, 'Invite someone');
        await invite
          .getByRole('combobox', { name: 'To your agent' })
          .selectOption({ label: 'Porter' });
        await invite.getByRole('button', { name: 'Create invite', exact: true }).click();
        expect(cross.calls).toContainEqual({
          method: 'POST',
          path: '/invites',
          body: { agent_id: ids.porter },
        });
        const issued = invite.getByRole('status').filter({ hasText: 'Invite to Porter.' });
        await expect(issued).toContainText('it is shown once and works once, for 7 days');
        await expect(issued.locator('code')).toHaveText(/^cci_/);
        await issued.getByRole('button', { name: 'Copy invite', exact: true }).click();
        await expect(invite.getByText('Invite copied to the clipboard.').first()).toBeAttached();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^cci_/);
        const yours = invite.getByRole('list', { name: 'Your invites' });
        await expect(yours.getByRole('listitem')).toHaveCount(3);
        const fresh = yours.getByRole('listitem').first();
        await expect(fresh).toContainText('Porter · Not used yet');
        await expect(fresh.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
        await expect(yours.getByRole('listitem').nth(2)).toContainText('Scout · Expired');
        await fresh.getByRole('button', { name: 'Cancel invite for Porter' }).click();
        await expect(
          invite.getByRole('status').filter({ hasText: 'Invite canceled.' }),
        ).toBeVisible();
        expect(cross.calls.at(-1)).toMatchObject({ method: 'DELETE' });
        await expect(yours.getByRole('listitem').first()).toContainText('Porter · Canceled');
        // The code of a canceled invite is no longer offered.
        await expect(invite.locator('code')).toHaveCount(0);
        await expectNoArrows(invite);
      });

      test('use an invite, filter the list, withdraw from the menu', async ({ page }) => {
        const { cross, ids } = await setup(page, scheme);
        await open(page);
        const use = card(page, 'Use an invite');
        const submit = use.getByRole('button', { name: 'Request connection', exact: true });
        await expect(submit).toBeDisabled();
        await use
          .getByRole('combobox', { name: 'From your agent' })
          .selectOption({ label: 'Checker' });
        await use
          .getByLabel('Their invite', { exact: true })
          .fill(`https://example.test/connect#cci_${'test0'.repeat(9).slice(0, 43)}`);
        await use.getByLabel('Note for them (optional)', { exact: true }).fill('Synthetic note');
        await submit.click();
        await expect(use.getByRole('status')).toContainText(
          'Connection request recorded. Check its status under With other people.',
        );
        expect(cross.calls.at(-1)).toMatchObject({
          method: 'POST',
          path: '/requests',
          body: { from_agent_id: ids.checker, note: 'Synthetic note' },
        });
        await expect(use.getByLabel('Their invite', { exact: true })).toHaveValue('');
        // Filters: All, Connected, Waiting, Ended.
        const list = others(page);
        const filters = card(page, 'With other people').getByRole('group', { name: 'Show' });
        await expect(filters.getByRole('button')).toHaveText([
          'All',
          'Connected',
          'Waiting',
          'Ended',
        ]);
        await expect(list.getByRole('listitem')).toHaveCount(4);
        await filters.getByRole('button', { name: 'Connected' }).click();
        await expect(filters.getByRole('button', { name: 'Connected' })).toHaveAttribute(
          'aria-pressed',
          'true',
        );
        await expect(list.getByRole('listitem')).toHaveCount(1);
        await expect(list).toContainText('Quill');
        await filters.getByRole('button', { name: 'Waiting' }).click();
        await expect(list.getByRole('listitem')).toHaveCount(2);
        await expect(list.getByRole('listitem').first()).toContainText(
          'With your Checker · You asked',
        );
        await filters.getByRole('button', { name: 'Ended' }).click();
        await expect(list.getByRole('listitem')).toHaveCount(1);
        await expect(list).toContainText('Index');
        await filters.getByRole('button', { name: 'All' }).click();
        await expect(list.getByRole('listitem')).toHaveCount(4);
        // ⋯ > Withdraw request (keyboard), then Escape and Tab close the menu.
        const { button, menu } = await openMenu(page, 'More for Their agent with your Checker');
        await page.keyboard.press('Escape');
        await expect(menu).toHaveCount(0);
        await expect(button).toBeFocused();
        await openMenu(page, 'More for Their agent with your Checker');
        await page.keyboard.press('Tab');
        await expect(menu).toHaveCount(0);
        await openMenu(page, 'More for Their agent with your Checker');
        await expect(page.getByRole('menuitem')).toHaveText(['Withdraw request']);
        await page.keyboard.press('Enter');
        const confirm = page.getByRole('dialog', { name: 'Withdraw request?' });
        await expect(confirm).toContainText(
          'Your request to connect Checker with Their agent is withdrawn.',
        );
        await confirm.getByRole('button', { name: 'Withdraw', exact: true }).click();
        await expect(card(page, 'With other people').getByRole('status')).toContainText(
          'Request withdrawn.',
        );
        expect(cross.calls.at(-1)).toMatchObject({
          method: 'POST',
          path: expect.stringMatching(/\/revoke$/),
        });
        // End a connection with another person.
        await openMenu(page, 'More for Quill with your Scout');
        await page.getByRole('menuitem', { name: 'End connection' }).click();
        const end = page.getByRole('dialog', { name: 'End connection?' });
        await expect(end).toContainText(
          'No more messages or work can pass between Quill and Scout.',
        );
        await end.getByRole('button', { name: 'End connection', exact: true }).click();
        await expect(card(page, 'With other people').getByRole('status')).toContainText(
          'Connection ended. No more messages or work can pass through it.',
        );
        expect(cross.calls.at(-1)).toEqual({
          method: 'POST',
          path: '/requests/test-request-0003/revoke',
          body: {},
        });
        await expect(list.getByRole('listitem').filter({ hasText: 'Quill' })).toContainText(
          'Ended',
        );
        await expectFits(page);
      });
    });
  }
}

for (const scheme of ['light', 'dark'] as const) {
  test(`no horizontal scroll at 360 px (${scheme}), with a request, a sheet and a menu open`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await setup(page, scheme);
    await open(page);
    await expectFits(page);
    await expectTargets(page);
    await openMenu(page, 'More for Scout to Porter');
    await expectFits(page);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'New connection' }).first().click();
    await expect(page.getByRole('dialog', { name: 'New connection' })).toBeVisible();
    await expectFits(page);
  });
}

test('empty: no routes, no one else yet, nothing waiting', async ({ page }) => {
  await setup(page, 'light', { cross: false });
  for (const connection of (await snapshot(page)).connections) {
    const removed = await page.request.fetch(`/api/connections/${connection.id}`, {
      method: 'DELETE',
      headers,
      data: {},
    });
    expect(removed.ok()).toBe(true);
  }
  await open(page);
  const own = card(page, 'Between your agents');
  await expect(own.getByRole('status')).toContainText('Connect two agents');
  await expect(own.getByRole('status')).toContainText(
    'Choose which agent asks and which one does the work.',
  );
  await expect(card(page, 'With other people')).toContainText('No one yet');
  await expect(card(page, 'Waiting for your approval')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Requests \d+ waiting$/ })).toHaveCount(0);
  await own.getByRole('button', { name: 'New connection', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'New connection' })).toBeVisible();
});
