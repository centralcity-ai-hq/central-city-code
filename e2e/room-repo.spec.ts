import { test, expect, type Browser, type Page } from '@playwright/test';

/*
 * The room's Code panel (src/rooms/RepoPanel.tsx) over the repository routes from #164. The e2e
 * server runs without CITY_ROOM_REPOS and without a GitHub App, so these tests answer the repo
 * routes in the browser (the server behavior has its own tests in tests/room-repos*.test.ts).
 * Without the flag the routes answer 404 and the room shows no Code button.
 */
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'x-city-request': '1' };
const NOTICE =
  "All members of this room will be able to read files in acme/website (a private repository) and propose changes. Only the room host can open pull requests from the room. Pull requests opened from the room run the proposed code in the repository's CI with its secrets.";

async function account(browser: Browser, label: string) {
  const context = await browser.newContext();
  const created = await context.request.post('/api/auth/register', {
    headers,
    data: { name: `${label}-${crypto.randomUUID().slice(0, 8)}`, password: PASSWORD },
  });
  expect(created.status()).toBe(201);
  return { request: context.request, page: await context.newPage() };
}

async function hostRoom(browser: Browser) {
  const host = await account(browser, 'repo-host');
  const agent = await host.request.post('/api/agents', {
    headers,
    data: { name: 'Host agent', description: 'e2e', capability: 'research', mode: 'external' },
  });
  const created = await host.request.post('/api/rooms', {
    headers,
    data: {
      agent_id: (await agent.json()).agent.id,
      name: 'Launch plan',
      idempotency_key: crypto.randomUUID(),
    },
  });
  expect(created.status()).toBe(201);
  return { host, room: (await created.json()).room as { id: string } };
}

type Binding = { repo: string; default_branch: string; private: boolean; bound_at: string };

/** Answers the repo routes in the browser; records what the page sent. */
async function mockRepo(page: Page, roomId: string, initial: Binding | null) {
  let binding = initial;
  const sent: { path: string; body: unknown }[] = [];
  await page.route(`**/api/rooms/${roomId}/repo**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.method() === 'POST' ? request.postDataJSON() : undefined;
    sent.push({ path, body });
    if (request.method() === 'GET')
      return route.fulfill({ json: { room_id: roomId, binding, head_sha: null, can_apply: true } });
    if (path.endsWith('/preview')) {
      if (body.repo !== 'acme/website')
        return route.fulfill({
          status: 404,
          json: { error: 'repo_not_available', message: 'Not available.' },
        });
      return route.fulfill({
        json: {
          room_id: roomId,
          repo: 'acme/website',
          default_branch: 'main',
          private: true,
          notice: NOTICE,
          confirm_repo: 'acme/website',
        },
      });
    }
    if (path.endsWith('/disconnect')) {
      binding = null;
      return route.fulfill({ json: { room_id: roomId, unbound: true } });
    }
    binding = {
      repo: body.repo,
      default_branch: 'main',
      private: true,
      bound_at: new Date().toISOString(),
    };
    return route.fulfill({ status: 201, json: { room_id: roomId, binding, replaced: false } });
  });
  return sent;
}

async function openCode(page: Page, roomId: string) {
  await page.goto(`/rooms/${roomId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Launch plan' })).toBeVisible();
  // Code lives in the top bar's "…" menu.
  await page.getByRole('button', { name: 'More room actions' }).click();
  await page.getByRole('menuitem', { name: /^Code/ }).click();
  const panel = page.getByRole('complementary', { name: 'Code' });
  await expect(panel).toBeVisible();
  return panel;
}

test('without room repositories on the server, the room shows no Code button', async ({
  browser,
}) => {
  const { host, room } = await hostRoom(browser);
  const off = await host.request.get(`/api/rooms/${room.id}/repo`);
  expect(off.status()).toBe(200);
  expect(await off.json()).toEqual({ available: false });
  await host.page.goto(`/rooms/${room.id}`);
  await expect(host.page.getByRole('heading', { level: 1, name: 'Launch plan' })).toBeVisible();
  await expect(
    host.page.locator('.rm-room-head').getByRole('button', { name: 'Invite', exact: true }),
  ).toBeVisible();
  await expect(host.page.getByRole('button', { name: /^Code/ })).toHaveCount(0);
  await host.page.getByRole('button', { name: 'More room actions' }).click();
  await expect(host.page.getByRole('menu', { name: 'More room actions' })).toBeVisible();
  await expect(host.page.getByRole('menuitem', { name: /^Code/ })).toHaveCount(0);
});

test('the host connects a repository only after ticking the notice and typing its name', async ({
  browser,
}) => {
  const { host, room } = await hostRoom(browser);
  const sent = await mockRepo(host.page, room.id, null);
  const panel = await openCode(host.page, room.id);

  // A repository the host's GitHub app does not cover: plain words, no code.
  await panel.getByLabel('Repository').fill('acme/other');
  await panel.getByRole('button', { name: 'Continue' }).click();
  await expect(panel.getByRole('alert')).toContainText("This repository isn't available.");
  await expect(panel).not.toContainText('repo_not_available');

  // A pasted GitHub address works too.
  await panel.getByLabel('Repository').fill('https://github.com/acme/website');
  await panel.getByRole('button', { name: 'Continue' }).click();
  await expect(panel.getByRole('note')).toHaveText(NOTICE);
  const connect = panel.getByRole('button', { name: 'Connect repository' });
  await expect(connect).toBeDisabled();
  await panel.getByRole('checkbox', { name: /every member of this room can read/ }).check();
  await expect(connect).toBeDisabled();
  await panel.getByLabel('Type the repository name to confirm').fill('acme/websit');
  await expect(connect).toBeDisabled();
  await panel.getByLabel('Type the repository name to confirm').fill('acme/website');
  await connect.click();
  await expect(panel).toContainText('Connected repository');
  await expect(panel).toContainText('acme/website');
  await host.page.getByRole('button', { name: 'More room actions' }).click();
  await expect(
    host.page.getByRole('menuitem', { name: 'Code, connected to acme/website' }),
  ).toBeVisible();
  await host.page.keyboard.press('Escape');
  expect(sent.find((item) => item.path.endsWith('/repo') && item.body)?.body).toEqual({
    repo: 'acme/website',
    acknowledge_member_read: true,
    confirm_repo: 'acme/website',
  });

  // Disconnect asks first.
  await panel.getByRole('button', { name: 'Disconnect repository' }).click();
  await expect(panel).toContainText('Members stop reading acme/website at once.');
  await panel.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(panel.getByLabel('Repository')).toBeVisible();
  expect(sent.some((item) => item.path.endsWith('/repo/disconnect'))).toBe(true);
});

test('members see the connected repository, read-only', async ({ browser }) => {
  const { host, room } = await hostRoom(browser);
  const minted = await host.request.post(`/api/rooms/${room.id}/link`, { headers, data: {} });
  const token = new URL((await minted.json()).link as string).hash.slice(1);
  const member = await account(browser, 'repo-member');
  expect(
    (
      await member.request.post(`/api/rooms/${room.id}/join`, {
        headers,
        data: { token, create: { name: 'Scout' }, idempotency_key: crypto.randomUUID() },
      })
    ).ok(),
  ).toBeTruthy();
  await mockRepo(member.page, room.id, {
    repo: 'acme/website',
    default_branch: 'main',
    private: false,
    bound_at: '2026-09-29T10:00:00.000Z',
  });
  const panel = await openCode(member.page, room.id);
  await expect(panel).toContainText('acme/website');
  await expect(panel).toContainText('Public · main branch main');
  await expect(panel.getByRole('button', { name: /Disconnect|Continue/ })).toHaveCount(0);
  await expect(panel.getByRole('textbox')).toHaveCount(0);
});

for (const scheme of ['light', 'dark'] as const)
  test(`the Code panel fits 360 px (${scheme})`, async ({ browser }) => {
    const { host, room } = await hostRoom(browser);
    await mockRepo(host.page, room.id, null);
    await host.page.setViewportSize({ width: 360, height: 780 });
    await host.page.addInitScript((theme) => localStorage.setItem('cc-theme', theme), scheme);
    const panel = await openCode(host.page, room.id);
    await panel.getByLabel('Repository').fill('acme/website');
    await panel.getByRole('button', { name: 'Continue' }).click();
    await expect(panel.getByRole('note')).toBeVisible();
    expect(
      await panel.evaluate(
        (element) =>
          [...element.querySelectorAll('*')].filter(
            (child) => child.getBoundingClientRect().right > innerWidth + 0.5,
          ).length,
      ),
    ).toBe(0);
  });
