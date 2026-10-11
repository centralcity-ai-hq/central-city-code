import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/*
 * A brand-new Google-linked account that has not given its date of birth yet creates a room:
 * "Add Elric" is offered right away (GET /api/elric: eligibility_reason 'age_unknown'), asks
 * the date of birth once, then Elric is a member. Nothing mocked: the fake-Google e2e server.
 */
const port = Number(process.env.E2E_GOOGLE_PORT);
const fakePort = Number(process.env.E2E_GOOGLE_FAKE_PORT);
const base = `http://127.0.0.1:${port}`;
const headers = { 'x-city-request': '1' };

test('no date of birth yet: Add Elric is offered in a new room, asks it once, adds Elric', async ({
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
    data: { name: `Host ${randomUUID().slice(0, 8)}`, password: 'Local-test-only-passphrase-2026' },
  });
  expect(created.status()).toBe(201);
  await page.goto(`${base}/settings/account`);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Google account linked.' }),
  ).toBeVisible();
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

  const status = await (await page.request.get(`${base}/api/elric`, { headers })).json();
  expect(status.eligible).toBe(false);
  expect(status.eligibility_reason).toBe('age_unknown');

  await page.goto(`${base}/rooms/${roomId}`);
  const card = page.getByRole('region', { name: 'Add Elric' });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Add Elric' }).click();
  const dob = page.getByRole('dialog');
  await expect(dob).toBeVisible();
  await dob.getByLabel('Date of birth').fill('1990-05-17');
  await dob.getByRole('button', { name: 'Continue' }).click();
  await expect(card).toHaveCount(0);

  const members = await page.request.get(`${base}/api/rooms/${roomId}/members`, { headers });
  const list = (await members.json()).members as Array<{
    auto_reply?: { provider: string } | null;
  }>;
  expect(list.some((member) => member.auto_reply?.provider === 'elric')).toBe(true);
});

test('the header "+ Add Elric" asks the missing date of birth once, then adds Elric', async ({
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
  await expect(
    page.getByRole('status').filter({ hasText: 'Google account linked.' }),
  ).toBeVisible();
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

  await page.goto(`${base}/rooms/${roomId}`);
  const head = page.locator('.rm-room-head');
  const add = head.getByRole('button', { name: 'Add Elric' });
  await expect(add).toBeVisible();
  await add.click();
  const dob = page.getByRole('dialog');
  await dob.getByLabel('Date of birth').fill('1990-05-17');
  await dob.getByRole('button', { name: 'Continue' }).click();
  await expect.poll(isMember).toBe(true);
  const toggle = head.getByRole('switch', { name: 'Elric' });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  // Off (one click, no question) and on again: no second date-of-birth question.
  await toggle.click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect.poll(isMember).toBe(false);
  // The switch settles (off, enabled again) before the next click, or the click lands while the
  // first change is still saving and is ignored.
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect.poll(isMember).toBe(true);
  await expect(page.getByLabel('Date of birth')).toHaveCount(0);
});
