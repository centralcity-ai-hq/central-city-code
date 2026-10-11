import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { workspaceTarget } from './workspace-density';

/*
 * Elric on/off in a room is one switch in the Members panel (one click each way, no question):
 * on = member, off = removed (and it can be switched on again), and no Elric items in the room menu (the sidebar links to
 * /elric. Nothing is mocked: the fake-Google e2e server (e2e/google-server.ts,
 * CITY_ELRIC_MOCK=1) gives a verified adult, like e2e/elric-host-add.spec.ts.
 */
const port = Number(process.env.E2E_GOOGLE_PORT);
const fakePort = Number(process.env.E2E_GOOGLE_FAKE_PORT);
const base = `http://127.0.0.1:${port}`;
const headers = { 'x-city-request': '1' };

test('the host switches Elric on and off in a room; the menu links to /elric', async ({ page }) => {
  const subject = String(Date.now()) + String(Math.floor(Math.random() * 1e6));
  await page.route('https://accounts.google.com/**', (route) =>
    route.fulfill({
      status: 302,
      headers: {
        location: `http://127.0.0.1:${fakePort}/authorize${new URL(route.request().url()).search}&e2e_subject=${subject}`,
      },
    }),
  );
  const created = await page.request.post(`${base}/api/auth/register`, {
    headers,
    data: { name: `Host ${randomUUID().slice(0, 8)}`, password: 'Local-test-only-passphrase-2026' },
  });
  expect(created.status()).toBe(201);
  await page.goto(`${base}/settings/account`);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Google account linked.' })).toHaveText(
    'Google account linked.',
  );
  await page.getByLabel('Date of birth (for Elric, 18 or over)').fill('1990-05-17');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();

  // The host's room, hosted by one of their agents; the host never joins as a person.
  const desk = await page.request.post(`${base}/api/agents`, {
    headers,
    data: { name: 'Host desk', capability: 'research', mode: 'hosted' },
  });
  expect(desk.status()).toBe(201);
  const room = await page.request.post(`${base}/api/rooms`, {
    headers,
    data: {
      agent_id: (await desk.json()).agent.id,
      name: 'Host room',
      idempotency_key: randomUUID(),
    },
  });
  expect(room.status()).toBe(201);
  const roomId = (await room.json()).room.id as string;

  const isMember = async () => {
    const members = await page.request.get(`${base}/api/rooms/${roomId}/members`, { headers });
    const list = (await members.json()).members as Array<{
      auto_reply?: { provider: string } | null;
    }>;
    return list.some((member) => member.auto_reply?.provider === 'elric');
  };

  await page.goto(`${base}/rooms/${roomId}`);
  await page.getByRole('button', { name: /^Members of / }).click();
  const panel = page.getByRole('complementary', { name: 'Members' });
  const toggle = panel.getByRole('switch', { name: 'Elric in this room' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(toggle).toHaveText('Elric in this roomOff');
  const box = await toggle.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(workspaceTarget(page.viewportSize()!.width));

  // On: one click (the date of birth is already known).
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect.poll(isMember).toBe(true);
  await expect(toggle).toBeEnabled();

  // Off: one click removes Elric, with no question (keyboard: Space).
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  // The change settles (server-confirmed) before the membership is read.
  await expect(toggle).not.toHaveAttribute('aria-busy', 'true');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect.poll(isMember).toBe(false);
  await expect(toggle).toBeEnabled();

  // On again: one click, and removing Elric never blocks adding it back.
  await page.keyboard.press('Enter');
  await expect(page.getByLabel(/Date of birth/)).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect.poll(isMember).toBe(true);
  await expect(toggle).toHaveText('Elric in this roomOn');

  // Presses while a change runs are ignored (click, Space, Enter): Off, Off ends Off, and the
  // switch shows it is busy.
  await page.route('**/api/rooms/*/members/*/remove', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.continue();
  });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-busy', 'true');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(
    await toggle.locator('.cc-switch-thumb').evaluate((el) => Number(getComputedStyle(el).opacity)),
  ).toBeLessThan(1);
  await toggle.click();
  await toggle.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('Enter');
  await expect(toggle).not.toHaveAttribute('aria-busy', 'true');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await page.waitForTimeout(500);
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect.poll(isMember).toBe(false);
  await page.unroute('**/api/rooms/*/members/*/remove');

  // The room menu has no Elric items: the sidebar's Elric entry is the way to Elric.
  await page.getByRole('button', { name: 'More room actions' }).click();
  const menu = page.getByRole('menu', { name: 'More room actions' });
  await expect(menu.getByRole('menuitem', { name: 'Add Elric' })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: 'Manage Elric' })).toHaveCount(0);
});

test('a failed switch rolls back and shows a toast', async ({ page }) => {
  const subject = String(Date.now()) + String(Math.floor(Math.random() * 1e6));
  await page.route('https://accounts.google.com/**', (route) =>
    route.fulfill({
      status: 302,
      headers: {
        location: `http://127.0.0.1:${fakePort}/authorize${new URL(route.request().url()).search}&e2e_subject=${subject}`,
      },
    }),
  );
  const created = await page.request.post(`${base}/api/auth/register`, {
    headers,
    data: { name: `Host ${randomUUID().slice(0, 8)}`, password: 'Local-test-only-passphrase-2026' },
  });
  expect(created.status()).toBe(201);
  await page.goto(`${base}/settings/account`);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Google account linked.' })).toHaveText(
    'Google account linked.',
  );
  await page.getByLabel('Date of birth (for Elric, 18 or over)').fill('1990-05-17');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();

  // The host's room, hosted by one of their agents; the host never joins as a person.
  const desk = await page.request.post(`${base}/api/agents`, {
    headers,
    data: { name: 'Host desk', capability: 'research', mode: 'hosted' },
  });
  expect(desk.status()).toBe(201);
  const room = await page.request.post(`${base}/api/rooms`, {
    headers,
    data: {
      agent_id: (await desk.json()).agent.id,
      name: 'Host room',
      idempotency_key: randomUUID(),
    },
  });
  expect(room.status()).toBe(201);
  const roomId = (await room.json()).room.id as string;

  await page.goto(`${base}/rooms/${roomId}`);
  await page.getByRole('button', { name: /^Members of / }).click();
  const toggle = page
    .getByRole('complementary', { name: 'Members' })
    .getByRole('switch', { name: 'Elric in this room' });
  await page.route('**/api/rooms/*/join', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }),
  );
  await toggle.click();
  await expect(page.getByRole('alert')).toContainText('Elric couldn’t join this room. Try again.');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
});

test('the switch never shows Off while Elric is still in the room', async ({ page }) => {
  const subject = String(Date.now()) + String(Math.floor(Math.random() * 1e6));
  await page.route('https://accounts.google.com/**', (route) =>
    route.fulfill({
      status: 302,
      headers: {
        location: `http://127.0.0.1:${fakePort}/authorize${new URL(route.request().url()).search}&e2e_subject=${subject}`,
      },
    }),
  );
  const created = await page.request.post(`${base}/api/auth/register`, {
    headers,
    data: { name: `Host ${randomUUID().slice(0, 8)}`, password: 'Local-test-only-passphrase-2026' },
  });
  expect(created.status()).toBe(201);
  await page.goto(`${base}/settings/account`);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Google account linked.' })).toHaveText(
    'Google account linked.',
  );
  await page.getByLabel('Date of birth (for Elric, 18 or over)').fill('1990-05-17');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  const desk = await page.request.post(`${base}/api/agents`, {
    headers,
    data: { name: 'Host desk', capability: 'research', mode: 'hosted' },
  });
  const room = await page.request.post(`${base}/api/rooms`, {
    headers,
    data: {
      agent_id: (await desk.json()).agent.id,
      name: 'Host room',
      idempotency_key: randomUUID(),
    },
  });
  const roomId = (await room.json()).room.id as string;
  const isMember = async () => {
    const res = await page.request.get(`${base}/api/rooms/${roomId}/members`, { headers });
    const list = (await res.json()).members as Array<{ auto_reply?: { provider: string } | null }>;
    return list.some((member) => member.auto_reply?.provider === 'elric');
  };

  await page.goto(`${base}/rooms/${roomId}`);
  await page.getByRole('button', { name: /^Members of / }).click();
  const toggle = page
    .getByRole('complementary', { name: 'Members' })
    .getByRole('switch', { name: 'Elric in this room' });
  await toggle.click();
  await expect(toggle).not.toHaveAttribute('aria-busy', 'true');
  await expect.poll(isMember).toBe(true);

  // The removal answers OK but is dropped: Elric stays in, so the switch must roll back to On.
  await page.route('**/api/rooms/*/members/*/remove', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
  );
  await toggle.click();
  await expect(page.getByRole('alert')).toContainText('Elric couldn’t be removed. Try again.');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(await isMember()).toBe(true);
});

test('a failed confirming read rolls back and shows a toast', async ({ page }) => {
  const subject = String(Date.now()) + String(Math.floor(Math.random() * 1e6));
  await page.route('https://accounts.google.com/**', (route) =>
    route.fulfill({
      status: 302,
      headers: {
        location: `http://127.0.0.1:${fakePort}/authorize${new URL(route.request().url()).search}&e2e_subject=${subject}`,
      },
    }),
  );
  const created = await page.request.post(`${base}/api/auth/register`, {
    headers,
    data: { name: `Host ${randomUUID().slice(0, 8)}`, password: 'Local-test-only-passphrase-2026' },
  });
  expect(created.status()).toBe(201);
  await page.goto(`${base}/settings/account`);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Google account linked.' })).toHaveText(
    'Google account linked.',
  );
  await page.getByLabel('Date of birth (for Elric, 18 or over)').fill('1990-05-17');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  const desk = await page.request.post(`${base}/api/agents`, {
    headers,
    data: { name: 'Host desk', capability: 'research', mode: 'hosted' },
  });
  const room = await page.request.post(`${base}/api/rooms`, {
    headers,
    data: {
      agent_id: (await desk.json()).agent.id,
      name: 'Host room',
      idempotency_key: randomUUID(),
    },
  });
  const roomId = (await room.json()).room.id as string;
  const isMember = async () => {
    const res = await page.request.get(`${base}/api/rooms/${roomId}/members`, { headers });
    const list = (await res.json()).members as Array<{ auto_reply?: { provider: string } | null }>;
    return list.some((member) => member.auto_reply?.provider === 'elric');
  };

  await page.goto(`${base}/rooms/${roomId}`);
  await page.getByRole('button', { name: /^Members of / }).click();
  const toggle = page
    .getByRole('complementary', { name: 'Members' })
    .getByRole('switch', { name: 'Elric in this room' });
  await toggle.click();
  await expect(toggle).not.toHaveAttribute('aria-busy', 'true');
  await expect.poll(isMember).toBe(true);

  // The removal goes through, but every members read after it fails: nothing confirms Off,
  // so the switch rolls back to On with the error (it never settles unconfirmed).
  let removed = false;
  page.on('response', (r) => {
    if (r.url().endsWith('/remove')) removed = true;
  });
  await page.route('**/api/rooms/*/members', (route) =>
    removed && route.request().method() === 'GET'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' })
      : route.continue(),
  );
  await toggle.click();
  await expect(page.getByRole('alert')).toContainText('Elric couldn’t be removed. Try again.');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(removed).toBe(true);
});

test('a late, stale members list never turns Off into a silent no-op', async ({ page }) => {
  const subject = String(Date.now()) + String(Math.floor(Math.random() * 1e6));
  await page.route('https://accounts.google.com/**', (route) =>
    route.fulfill({
      status: 302,
      headers: {
        location: `http://127.0.0.1:${fakePort}/authorize${new URL(route.request().url()).search}&e2e_subject=${subject}`,
      },
    }),
  );
  const created = await page.request.post(`${base}/api/auth/register`, {
    headers,
    data: { name: `Host ${randomUUID().slice(0, 8)}`, password: 'Local-test-only-passphrase-2026' },
  });
  expect(created.status()).toBe(201);
  await page.goto(`${base}/settings/account`);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Google account linked.' })).toHaveText(
    'Google account linked.',
  );
  await page.getByLabel('Date of birth (for Elric, 18 or over)').fill('1990-05-17');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  const desk = await page.request.post(`${base}/api/agents`, {
    headers,
    data: { name: 'Host desk', capability: 'research', mode: 'hosted' },
  });
  const room = await page.request.post(`${base}/api/rooms`, {
    headers,
    data: {
      agent_id: (await desk.json()).agent.id,
      name: 'Host room',
      idempotency_key: randomUUID(),
    },
  });
  const roomId = (await room.json()).room.id as string;
  const isMember = async () => {
    const res = await page.request.get(`${base}/api/rooms/${roomId}/members`, { headers });
    const list = (await res.json()).members as Array<{ auto_reply?: { provider: string } | null }>;
    return list.some((member) => member.auto_reply?.provider === 'elric');
  };

  await page.goto(`${base}/rooms/${roomId}`);
  await page.getByRole('button', { name: /^Members of / }).click();
  const toggle = page
    .getByRole('complementary', { name: 'Members' })
    .getByRole('switch', { name: 'Elric in this room' });

  const staleBody = await (
    await page.request.get(`${base}/api/rooms/${roomId}/members`, { headers })
  ).text();
  let joined = false;
  let served = false;
  let count = 0;
  page.on('response', (r) => {
    if (r.url().endsWith('/join')) joined = true;
  });
  await page.route('**/api/rooms/*/members', async (route) => {
    if (route.request().method() !== 'GET' || ++count !== 1) return route.continue();
    served = true;
    while (!joined) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 400));
    await route.fulfill({ status: 200, contentType: 'application/json', body: staleBody });
  });
  // A members read that answers after the join with the list from before it.
  await toggle.click();
  await expect.poll(isMember).toBe(true);
  await expect(toggle).not.toHaveAttribute('aria-busy', 'true');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.waitForTimeout(1000);
  let removes = 0;
  let shownOff = false;
  page.on('request', (r) => {
    if (r.url().includes('/remove')) removes++;
  });
  await toggle.focus();
  await page.keyboard.press('Space');
  // Off is shown only once the server has removed Elric.
  for (let i = 0; i < 40; i++) {
    const off = (await toggle.getAttribute('aria-checked')) === 'false';
    if (off && (await isMember())) shownOff = true;
    await page.waitForTimeout(50);
  }
  await expect(toggle).not.toHaveAttribute('aria-busy', 'true');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect.poll(isMember).toBe(false);
  expect(served).toBe(true);
  expect(removes).toBe(1);
  expect(shownOff).toBe(false);
});

test('the room header: + Add Elric first, then the host switch next to Tasks; it fits at 360 px', async ({
  page,
}) => {
  const subject = String(Date.now()) + String(Math.floor(Math.random() * 1e6));
  await page.route('https://accounts.google.com/**', (route) =>
    route.fulfill({
      status: 302,
      headers: {
        location: `http://127.0.0.1:${fakePort}/authorize${new URL(route.request().url()).search}&e2e_subject=${subject}`,
      },
    }),
  );
  const created = await page.request.post(`${base}/api/auth/register`, {
    headers,
    data: { name: `Head ${randomUUID().slice(0, 8)}`, password: 'Local-test-only-passphrase-2026' },
  });
  expect(created.status()).toBe(201);
  await page.goto(`${base}/settings/account`);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Google account linked.' })).toHaveText(
    'Google account linked.',
  );
  await page.getByLabel('Date of birth (for Elric, 18 or over)').fill('1990-05-17');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  const desk = await page.request.post(`${base}/api/agents`, {
    headers,
    data: { name: 'Head desk', capability: 'research', mode: 'hosted' },
  });
  const room = await page.request.post(`${base}/api/rooms`, {
    headers,
    data: {
      agent_id: (await desk.json()).agent.id,
      name: 'Head room',
      idempotency_key: randomUUID(),
    },
  });
  const roomId = (await room.json()).room.id as string;
  const isMember = async () => {
    const res = await page.request.get(`${base}/api/rooms/${roomId}/members`, { headers });
    const list = (await res.json()).members as Array<{ auto_reply?: { provider: string } | null }>;
    return list.some((member) => member.auto_reply?.provider === 'elric');
  };

  // The narrowest phone the spec supports, with Elric and Tasks in the header.
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto(`${base}/rooms/${roomId}`);
  const head = page.locator('.rm-room-head');
  const fits = async () => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      360,
    );
    for (const item of await head.locator('.rm-head-actions > *').all()) {
      const box = await item.boundingBox();
      if (box) expect(box.x + box.width).toBeLessThanOrEqual(360);
    }
  };
  // On a phone the top bar wraps instead of folding: the room pill (Members) and Tasks stay in
  // the row, each exactly once, and More holds only the room actions.
  const more = head.getByRole('button', { name: 'More room actions' });
  await expect(more).toBeVisible();
  await expect(head.getByRole('button', { name: /^Members of / })).toHaveCount(1);
  await expect(head.getByRole('button', { name: /^Tasks, / })).toHaveCount(1);
  await more.click();
  const menu = page.getByRole('menu', { name: 'More room actions' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /^Tasks/ })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: /^Members/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // Elric was never added: "+ Add Elric", not a switch.
  const add = head.getByRole('button', { name: 'Add Elric' });
  await expect(add).toBeVisible();
  await expect(head.getByRole('switch')).toHaveCount(0);
  await fits();

  // One click adds Elric (the date of birth is already known: no question).
  await add.click();
  await expect.poll(isMember).toBe(true);
  const toggle = head.getByRole('switch', { name: 'Elric' });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByLabel(/Date of birth/)).toHaveCount(0);
  await expect(add).toHaveCount(0);
  await fits();

  // Off: one click, no question. Elric leaves the room, and the header keeps the switch (now off).
  await toggle.click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  // The change settles (server-confirmed) before the membership is read.
  await expect(toggle).not.toHaveAttribute('aria-busy', 'true');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect.poll(isMember).toBe(false);
  await expect(add).toHaveCount(0);
  await fits();

  // On again straight away, from the keyboard, with no date-of-birth question.
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect.poll(isMember).toBe(true);
  await expect(page.getByLabel(/Date of birth/)).toHaveCount(0);
});
