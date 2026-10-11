import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/*
 * The host (who never joined as a person) adds Elric and @mentions it posting as the host
 * identity in the web app: Elric answers with its label. The date of birth, once saved, is not
 * asked again. Fake-Google e2e server with Elric on the mock model (e2e/google-server.ts).
 */
const port = Number(process.env.E2E_GOOGLE_PORT);
const fakePort = Number(process.env.E2E_GOOGLE_FAKE_PORT);
const base = `http://127.0.0.1:${port}`;
const headers = { 'x-city-request': '1' };

test('a host mentions Elric as host and gets a labelled reply; a saved DOB is not asked again', async ({
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
  await page.getByLabel('Date of birth (for Elric, 18 or over)').fill('1990-05-17');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();

  const desk = await page.request.post(`${base}/api/agents`, {
    headers,
    data: { name: 'Host desk', capability: 'research', mode: 'hosted' },
  });
  const deskId = (await desk.json()).agent.id as string;
  const room = await page.request.post(`${base}/api/rooms`, {
    headers,
    data: { agent_id: deskId, name: 'Host mention room', idempotency_key: randomUUID() },
  });
  const roomId = (await room.json()).room.id as string;

  await page.goto(`${base}/rooms/${roomId}`);
  await page
    .getByRole('region', { name: 'Add Elric' })
    .getByRole('button', { name: 'Add Elric' })
    .click();
  // The date of birth is saved: no dialog asks for it again.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Add Elric' })).toHaveCount(0);

  // Post as the host identity (the room's host agent) from the web app session.
  const posted = await page.request.post(`${base}/api/rooms/${roomId}/messages`, {
    headers,
    data: { text: '@Elric hello from the host', agent_id: deskId, idempotency_key: randomUUID() },
  });
  expect(posted.status(), await posted.text()).toBe(201);
  expect((await posted.json()).elric_notice).toBeUndefined();
  await expect
    .poll(
      async () => {
        const read = await page.request.get(`${base}/api/rooms/${roomId}/messages?since=0`, {
          headers,
        });
        const messages = (await read.json()).messages as Array<{
          auto_reply?: { provider: string; label?: string } | null;
        }>;
        return messages.find((m) => m.auto_reply?.provider === 'elric')?.auto_reply?.label ?? null;
      },
      { timeout: 20_000 },
    )
    .toBe('Elric · AI');
});
