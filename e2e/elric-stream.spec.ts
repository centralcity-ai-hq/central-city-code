import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/*
 * Streamed answers on /elric: while Elric writes, its answer forms in the reply's place (drafts,
 * GET /api/rooms/:room/elric-drafts), the dots show until the first words, and the posted
 * message replaces the draft. Nothing is mocked: the fake-Google e2e server (CITY_ELRIC_MOCK=1)
 * streams "stream please" in three chunks 400 ms apart (server/elric/endpoints.ts).
 */
const port = Number(process.env.E2E_GOOGLE_PORT);
const fakePort = Number(process.env.E2E_GOOGLE_FAKE_PORT);
const base = `http://127.0.0.1:${port}`;
const headers = { 'x-city-request': '1' };

test('an answer streams in place, then the posted message replaces it', async ({ page }) => {
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

  await page.goto(`${base}/elric`);
  // A verified adult starts with one click; the private chat opens.
  await page.getByRole('button', { name: 'Start chatting' }).click();
  const input = page.getByLabel('Message Elric');
  await expect(input).toBeVisible();

  const drafts: string[] = [];
  page.on('response', async (response) => {
    if (!response.url().includes('/elric-drafts')) return;
    const body = (await response.json().catch(() => null)) as {
      drafts?: { text: string }[];
    } | null;
    for (const item of body?.drafts ?? []) drafts.push(item.text);
  });
  await input.fill('stream please');
  await page.keyboard.press('Enter');

  // The first words show as Elric's forming answer, before the message is posted.
  const forming = page.getByTestId('elric-draft');
  // It is revealed smoothly, so it shows the answer's first words (a growing beginning of it).
  const full = 'Streaming reply, part two, part three.';
  await expect
    .poll(
      async () => {
        const text = (
          (await forming
            .locator('.elx-reply')
            .textContent()
            .catch(() => '')) ?? ''
        ).trim();
        return text.length > 0 && full.startsWith(text);
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  await expect(forming).toContainText('AI');
  // Then the posted message takes its place: one reply, no draft left.
  const reply = page.getByTestId('elric-reply').last();
  await expect(reply).toContainText('Streaming reply, part two, part three.', { timeout: 15_000 });
  await expect(forming).toHaveCount(0);
  await expect(page.getByTestId('elric-thinking')).toHaveCount(0);
  // It grew in steps (more than one distinct non-empty draft was read).
  expect(new Set(drafts.filter(Boolean)).size).toBeGreaterThan(1);
});
