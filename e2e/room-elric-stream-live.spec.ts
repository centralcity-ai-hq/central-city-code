import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/*
 * Streamed Elric answers in a room: after the owner's own @Elric post, Elric's answer forms in
 * its place in the thread (drafts, GET /api/rooms/:room/elric-drafts): the thinking dots until
 * the first words, then the forming text, then the posted message replaces it. No mocks: the
 * fake-Google e2e server (CITY_ELRIC_MOCK=1) streams "stream please" in three chunks.
 */
const port = Number(process.env.E2E_GOOGLE_PORT);
const fakePort = Number(process.env.E2E_GOOGLE_FAKE_PORT);
const base = `http://127.0.0.1:${port}`;
const headers = { 'x-city-request': '1' };

test('with earlier Elric replies and a long thread, the dots and the draft show in view, then the reply, no pill', async ({
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

  // The host's room, hosted by one of their agents; the host never joins as a person.
  const desk = await page.request.post(`${base}/api/agents`, {
    headers,
    data: { name: 'Host desk', capability: 'research', mode: 'hosted' },
  });
  expect(desk.status()).toBe(201);
  const hostAgent = (await desk.json()).agent.id as string;
  const room = await page.request.post(`${base}/api/rooms`, {
    headers,
    data: {
      agent_id: hostAgent,
      name: 'Host room',
      idempotency_key: randomUUID(),
    },
  });
  expect(room.status()).toBe(201);
  const roomId = (await room.json()).room.id as string;

  await page.goto(`${base}/rooms/${roomId}`);
  const card = page.getByRole('region', { name: 'Add Elric' });
  await card.getByRole('button', { name: 'Add Elric' }).click();
  const dob = page.getByRole('dialog');
  if (await dob.isVisible().catch(() => false)) {
    await dob.getByLabel('Date of birth').fill('1990-05-17');
    await dob.getByRole('button', { name: 'Continue' }).click();
  }
  await expect(card).toHaveCount(0);

  const box = page.getByRole('textbox', { name: 'Message' });
  // An earlier exchange with Elric, then enough messages that the thread scrolls.
  await box.fill('@Elric hello');
  await box.press('Enter');
  await expect(page.getByTestId('room-message').filter({ hasText: 'Elric' }).last()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId('room-elric-draft')).toHaveCount(0, { timeout: 15_000 });
  for (let i = 0; i < 25; i += 1) {
    await page.request.post(`${base}/api/rooms/${roomId}/messages`, {
      headers,
      data: { text: `Filler line ${i}`, idempotency_key: randomUUID(), agent_id: hostAgent },
    });
  }
  await expect(page.getByTestId('room-message').filter({ hasText: 'Filler line 24' })).toBeVisible({
    timeout: 15_000,
  });

  await box.fill('@Elric stream please');
  await box.press('Enter');
  const scroller = page.getByTestId('room-scroll');
  const inView = async (locator: ReturnType<typeof page.getByTestId>) => {
    const area = (await scroller.boundingBox())!;
    const item = await locator.boundingBox();
    return Boolean(
      item && item.y >= area.y - 1 && item.y + item.height <= area.y + area.height + 1,
    );
  };
  const draft = page.getByTestId('room-elric-draft');
  // The dots appear right away, in view under the post.
  await expect(draft).toBeVisible({ timeout: 5_000 });
  await expect.poll(() => inView(draft)).toBe(true);
  // It is revealed smoothly, so it shows the answer's first words (a growing beginning of it), in
  // view. Checked together while the draft is there: once the whole answer is in, the posted
  // message may replace it at any moment, leaving no draft to measure.
  const full = 'Streaming reply, part two, part three.';
  await expect
    .poll(
      async () => {
        const text = (
          (await draft
            .locator('.rm-bubble')
            .textContent()
            .catch(() => '')) ?? ''
        ).trim();
        return text.length > 0 && full.startsWith(text) && (await inView(draft));
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  const reply = page
    .getByTestId('room-message')
    .filter({ hasText: 'Streaming reply, part two, part three.' });
  await expect(reply).toHaveCount(1, { timeout: 15_000 });
  await expect(draft).toHaveCount(0);
  await expect.poll(() => inView(reply)).toBe(true);
  await expect(page.getByRole('button', { name: /new message/i })).toHaveCount(0);
});
