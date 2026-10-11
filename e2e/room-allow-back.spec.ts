import { test, expect as baseExpect, type Browser, type Page } from '@playwright/test';

/*
 * "Allow back in" (docs/ROOM_MANAGEMENT.md): the host's Members panel lists removed members whose
 * owners cannot rejoin under "Removed", and one inline-confirmed button lifts the ban (the remove
 * route with block_rejoin: false). The owner rejoins with a live link; members never see the list.
 */
const expect = baseExpect.configure({ timeout: 15_000 });
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'X-City-Request': '1' };

type Account = Awaited<ReturnType<typeof account>>;
async function account(browser: Browser, label: string) {
  const context = await browser.newContext();
  const name = `${label}-${crypto.randomUUID().slice(0, 8)}`;
  const created = await context.request.post('/api/auth/register', {
    headers,
    data: { name, password: PASSWORD },
  });
  expect(created.status()).toBe(201);
  const page = await context.newPage();
  return { name, context, request: context.request, page };
}

async function agent(owner: Account, name: string) {
  const response = await owner.request.post('/api/agents', {
    headers,
    data: { name, capability: 'research', mode: 'hosted' },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).agent.id as string;
}

async function hostRoom(owner: Account, name: string) {
  const hostAgent = await agent(owner, 'Host agent');
  const response = await owner.request.post('/api/rooms', {
    headers,
    data: { agent_id: hostAgent, name, idempotency_key: crypto.randomUUID() },
  });
  expect(response.status()).toBe(201);
  const room = (await response.json()).room as { id: string; slug: string };
  const minted = await owner.request.post(`/api/rooms/${room.id}/link`, { headers, data: {} });
  expect(minted.status()).toBe(200);
  const link = (await minted.json()).link as string;
  return { ...room, link, token: new URL(link).hash.slice(1) };
}

async function join(owner: Account, room: { id: string; token: string }, agentName: string) {
  const response = await owner.request.post(`/api/rooms/${room.id}/join`, {
    headers,
    data: { token: room.token, create: { name: agentName }, idempotency_key: crypto.randomUUID() },
  });
  expect(response.status()).toBe(200);
  return (await response.json()).agent_id as string;
}

async function openMembers(page: Page) {
  await page.getByRole('button', { name: /^Members of / }).click();
  const panel = page.getByRole('complementary', { name: 'Members' });
  await expect(panel).toBeVisible();
  return panel;
}

test('the host allows a removed member back in from the Members panel; members never see Removed', async ({
  browser,
}) => {
  const host = await account(browser, 'Host');
  const room = await hostRoom(host, 'Launch plan');
  const guest = await account(browser, 'Guest');
  const guestAgent = await join(guest, room, 'Guest agent');

  // The host removes the member with a rejoin ban (console route, as the row menu does).
  const removed = await host.request.post(`/api/rooms/${room.id}/members/${guestAgent}/remove`, {
    headers,
    data: { reason: 'Cooling off.' },
  });
  expect(removed.status()).toBe(200);
  // Banned: rejoining with the live link is refused.
  const refused = await guest.request.post(`/api/rooms/${room.id}/join`, {
    headers,
    data: { token: room.token, agent_id: guestAgent, idempotency_key: crypto.randomUUID() },
  });
  expect(refused.status()).toBe(403);

  await host.page.goto(`/rooms/${room.id}`);
  const members = await openMembers(host.page);
  const list = members.getByRole('list', { name: 'Removed' });
  const row = list.getByRole('listitem').filter({ hasText: 'Guest agent' });
  await expect(row.getByText(/cannot rejoin/)).toBeVisible();

  // The inline confirm opens in place; Cancel returns focus to the button (nothing changes).
  await row.getByRole('button', { name: 'Allow back in' }).click();
  const confirm = row.getByRole('group', { name: /may join again with a live invite link/ });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(row.getByRole('button', { name: 'Allow back in' })).toBeFocused();
  await expect(row).toBeVisible();

  // Confirm: the server is asked with block_rejoin: false and the row leaves the list.
  const sent = host.page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      request.url().endsWith(`/rooms/${room.id}/members/${guestAgent}/remove`),
  );
  await row.getByRole('button', { name: 'Allow back in' }).click();
  await row
    .getByRole('group', { name: /may join again with a live invite link/ })
    .getByRole('button', { name: 'Allow back in' })
    .click();
  expect((await sent).postDataJSON()).toEqual({ block_rejoin: false });
  await expect(members.getByRole('list', { name: 'Removed' })).toHaveCount(0);

  // The owner rejoins with the live link.
  const back = await guest.request.post(`/api/rooms/${room.id}/join`, {
    headers,
    data: { token: room.token, agent_id: guestAgent, idempotency_key: crypto.randomUUID() },
  });
  expect(back.status()).toBe(200);

  // A member who does not host never sees Removed or its button.
  await guest.page.goto(`/rooms/${room.id}`);
  const guestPanel = await openMembers(guest.page);
  await expect(guestPanel.getByRole('list', { name: 'Removed' })).toHaveCount(0);
  await expect(guestPanel.getByRole('button', { name: 'Allow back in' })).toHaveCount(0);
});
