import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/*
 * Elric's answers appear smoothly as they are written (/elric). The fake-Google e2e server
 * (CITY_ELRIC_MOCK=1) streams "stream slowly" like a real model: a few words every 100 ms for
 * about 4 s (server/elric/endpoints.ts). The page records the length of the answer on screen at
 * every frame: it must grow in many small steps (not a few jumps), history must not animate after
 * a reload, and with reduced motion the text shows without the reveal.
 */
const port = Number(process.env.E2E_GOOGLE_PORT);
const fakePort = Number(process.env.E2E_GOOGLE_FAKE_PORT);
const base = `http://127.0.0.1:${port}`;
const headers = { 'x-city-request': '1' };
const FINAL_START = 'Here is a calm answer';
const FINAL_END = 'which ends the answer.';

async function signIn(page: Page) {
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
}

async function openChat(page: Page) {
  await signIn(page);
  await page.goto(`${base}/elric`);
  await page.getByRole('button', { name: 'Start chatting' }).click();
  await expect(page.getByLabel('Message Elric')).toBeVisible();
}

/** Starts recording, at every frame, the length of Elric's newest answer on screen. */
async function record(page: Page) {
  await page.evaluate(() => {
    const replies = () => document.querySelectorAll('[data-testid="elric-reply"]');
    const before = replies().length;
    const samples: { t: number; len: number }[] = [];
    (window as unknown as { __samples: typeof samples }).__samples = samples;
    const frame = (t: number) => {
      const draft = document.querySelector('[data-testid="elric-draft"] .elx-reply');
      const list = replies();
      const reply =
        list.length > before ? list[list.length - 1]!.querySelector('.elx-reply') : null;
      const len = (draft ?? reply)?.textContent?.length ?? 0;
      const last = samples.at(-1);
      if (!last || last.len !== len) samples.push({ t, len });
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

type Sample = { t: number; len: number };
async function samples(page: Page): Promise<Sample[]> {
  return page.evaluate(() => (window as unknown as { __samples: Sample[] }).__samples);
}

/** Steps (changes of length), the largest single jump, and the longest pause while growing. */
function measure(list: Sample[]) {
  const grow = list.filter((item) => item.len > 0);
  let maxJump = 0;
  let maxPause = 0;
  for (let i = 1; i < grow.length; i += 1) {
    maxJump = Math.max(maxJump, grow[i]!.len - grow[i - 1]!.len);
    maxPause = Math.max(maxPause, grow[i]!.t - grow[i - 1]!.t);
  }
  maxJump = Math.max(maxJump, grow[0]?.len ?? 0);
  const final = grow.at(-1)?.len ?? 0;
  return { steps: grow.length, maxJump, maxPause: Math.round(maxPause), final };
}

async function ask(page: Page) {
  await page.getByLabel('Message Elric').fill('stream slowly');
  await page.keyboard.press('Enter');
  const reply = page.getByTestId('elric-reply').last();
  await expect(reply).toContainText(FINAL_END, { timeout: 20_000 });
  await expect(page.getByTestId('elric-draft')).toHaveCount(0);
  await expect(reply).toContainText(FINAL_START);
  // Settled: the finished answer is the normal, readable message (not hidden from screen readers).
  await expect(reply.locator('[aria-hidden="true"].md-stream')).toHaveCount(0);
  return reply;
}

test('a streamed answer appears in many small, even steps; history does not animate', async ({
  page,
}) => {
  await openChat(page);
  await record(page);
  const reply = await ask(page);
  const live = measure(await samples(page));
  console.log('live reveal', JSON.stringify(live));
  // Many small steps, not a few jumps: the answer is ~300 characters.
  expect(live.steps).toBeGreaterThan(40);
  expect(live.maxJump).toBeLessThan(40);
  // Rendered as Markdown once complete (bold and the list), without the raw markers.
  await expect(reply.locator('strong')).toHaveText('some bold words');
  await expect(reply.locator('li')).toHaveCount(3);
  await expect(reply).not.toContainText('**');

  // After a reload the answer is history: it shows complete at once.
  await page.reload();
  await expect(page.getByTestId('elric-reply').last()).toContainText(FINAL_END);
  await page.evaluate(() => {
    const samples: { t: number; len: number; reveal: boolean }[] = [];
    (window as unknown as { __samples: typeof samples }).__samples = samples;
    const started = performance.now();
    const frame = (t: number) => {
      const list = document.querySelectorAll('[data-testid="elric-reply"]');
      const body = list[list.length - 1]?.querySelector('.elx-reply');
      samples.push({
        t,
        len: body?.textContent?.length ?? 0,
        reveal: !!body?.querySelector('.md-stream'),
      });
      if (t - started < 1000) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  await page.waitForTimeout(1200);
  const history = (await samples(page)) as (Sample & { reveal: boolean })[];
  // Never revealed: complete from the first frame (it may show as plain text until parsed).
  expect(history.some((item) => item.reveal)).toBe(false);
  expect(Math.min(...history.map((item) => item.len))).toBeGreaterThanOrEqual(live.final);
});

test('with reduced motion the answer shows without the reveal effect', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openChat(page);
  const drafts = new Set<number>();
  page.on('response', async (response) => {
    if (!response.url().includes('/elric-drafts')) return;
    const body = (await response.json().catch(() => null)) as {
      drafts?: { text: string }[];
    } | null;
    for (const item of body?.drafts ?? []) drafts.add(item.text.length);
  });
  await record(page);
  await ask(page);
  const shown = measure(await samples(page));
  console.log('reduced motion', JSON.stringify(shown), 'drafts read', drafts.size);
  // Each change on screen is a draft read from the server (or the final message): no reveal.
  expect(shown.steps).toBeLessThanOrEqual(drafts.size + 2);
});

test('in a room, Elric’s streamed answer is revealed smoothly and stays in view', async ({
  page,
}) => {
  await signIn(page);
  const desk = await page.request.post(`${base}/api/agents`, {
    headers,
    data: { name: 'Host desk', capability: 'research', mode: 'hosted' },
  });
  expect(desk.status()).toBe(201);
  const hostAgent = (await desk.json()).agent.id as string;
  const room = await page.request.post(`${base}/api/rooms`, {
    headers,
    data: { agent_id: hostAgent, name: 'Host room', idempotency_key: randomUUID() },
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
  const elricMessages = page.locator('[data-testid="room-message"]:has([data-kind="elric"])');
  await page.evaluate(() => {
    const replies = () => document.querySelectorAll('[data-testid="room-message"]');
    const before = replies().length;
    const samples: { t: number; len: number }[] = [];
    (window as unknown as { __samples: typeof samples }).__samples = samples;
    const frame = (t: number) => {
      const draft = document.querySelector('[data-testid="room-elric-draft"] .rm-bubble');
      const list = replies();
      const last = list.length > before ? list[list.length - 1]! : null;
      const reply = last?.querySelector('[data-kind="elric"]')
        ? last.querySelector('.rm-bubble')
        : null;
      // The thinking dots (and their spoken label) are not the answer.
      const thinking = draft?.querySelector('.rm-elric-dots');
      const len = thinking ? 0 : ((draft ?? reply)?.textContent?.length ?? 0);
      const previous = samples.at(-1);
      if (!previous || previous.len !== len) samples.push({ t, len });
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill('@Elric stream slowly');
  await box.press('Enter');
  const reply = elricMessages.filter({ hasText: FINAL_END });
  await expect(reply).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByTestId('room-elric-draft')).toHaveCount(0);
  await expect(reply.locator('.md-stream')).toHaveCount(0);
  const live = measure(await samples(page));
  console.log('room reveal', JSON.stringify(live));
  expect(live.steps).toBeGreaterThan(40);
  expect(live.maxJump).toBeLessThan(40);
  await expect(reply.locator('.rm-bubble strong')).toHaveText('some bold words');

  // Reopened, the room shows the answer at once.
  await page.reload();
  await expect(elricMessages.filter({ hasText: FINAL_END })).toHaveCount(1);
  await expect(page.locator('.md-stream')).toHaveCount(0);
});
