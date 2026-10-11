import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/*
 * A host adds Elric to a room they host, without ever having joined it as a person (the reported
 * path): Add Elric → Elric is a member. Nothing about the join is mocked; the
 * fake-Google e2e server (e2e/google-server.ts, CITY_ELRIC_MOCK=1) gives a verified identity.
 */
const port = Number(process.env.E2E_GOOGLE_PORT);
const fakePort = Number(process.env.E2E_GOOGLE_FAKE_PORT);
const base = `http://127.0.0.1:${port}`;
const headers = { 'x-city-request': '1' };

test('a host adds Elric to their own room (no person membership): Elric becomes a member', async ({
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
  const card = page.getByRole('region', { name: 'Add Elric' });
  await card.getByRole('button', { name: 'Add Elric' }).click();
  // The date of birth is asked here only when it isn't known yet.
  const dob = page.getByRole('dialog');
  if (await dob.isVisible().catch(() => false)) {
    await dob.getByLabel('Date of birth').fill('1990-05-17');
    await dob.getByRole('button', { name: 'Continue' }).click();
  }
  await expect(card).toHaveCount(0);
  await expect(page.getByText('This invite link is invalid or has expired')).toHaveCount(0);

  const members = await page.request.get(`${base}/api/rooms/${roomId}/members`, { headers });
  expect(members.status()).toBe(200);
  const list = (await members.json()).members as Array<{
    auto_reply?: { provider: string } | null;
  }>;
  expect(list.some((member) => member.auto_reply?.provider === 'elric')).toBe(true);
});
