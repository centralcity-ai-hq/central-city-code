import { test, expect, type Page, type Route } from '@playwright/test';
import { workspaceScale } from './workspace-density';

/*
 * The Elric mascot on /elric: signed out, a small drawing lying on the header's bottom line right
 * of the wordmark (both themes, phone and desktop); signed in, the Workspace v3 top bar is a
 * floating pill with Elric's avatar and no header line, so no peeking mascot there
 * (docs/design/WORKSPACE_V3_ELRIC_AGENTS.md §1); and a resting one beside the "used up for today"
 * notice only. Decorative throughout. The e2e server runs without
 * CITY_ELRIC, so /api/elric* and the chat room's message routes are served by page.route with the
 * shapes of the real routes (as in elric-dashboard.spec.ts).
 */
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'x-city-request': '1' };
const CHAT = 'c4a1e2f0-1b2c-4d3e-8f90-0a1b2c3d4e5f';
const PERSON = 'p-member-1';
const LIMIT_TEXT = 'Short answers used up for today. Resets at 00:00 UTC.';

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Elric on and signed in; `limit` makes every post come back with the limit notice. */
async function mockElric(page: Page, opts: { limit?: boolean; chatName?: string } = {}) {
  const messages: Array<{ seq: number; own: boolean; text: string }> = [];
  const message = (item: { seq: number; own: boolean; text: string }) => ({
    id: `m-${item.seq}`,
    seq: item.seq,
    origin: 'external',
    sender: item.own ? 'You' : 'Elric',
    sender_agent_id: item.own ? PERSON : 'elric-agent',
    sender_owner_label: 'You',
    own: true,
    text: item.text,
    parts: [{ type: 'text', text: item.text }],
    created_at: '2026-10-01T09:00:00.000Z',
    format: 'markdown',
    auto_reply: item.own ? null : { provider: 'elric', model: 'gemma-4-12b' },
  });
  const latest = () => messages.at(-1)?.seq ?? 0;
  await page.route('**/api/elric', (route) =>
    json(route, { agent_id: 'elric-agent', status: 'active' }),
  );
  await page.route('**/api/elric/chat*', (route) =>
    json(route, {
      room_id: CHAT,
      slug: 'elric-chat',
      person_member_id: PERSON,
      status: 'active',
      latest_seq: latest(),
      waking: false,
      pending_count: 0,
    }),
  );
  await page.route('**/api/elric/rooms', (route) => json(route, { rooms: [] }));
  await page.route('**/api/elric/pending', (route) => json(route, { pending: [] }));
  await page.route('**/api/rooms/*/messages*', (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      const posted = { seq: latest() + 1, own: true, text: String(body.text) };
      messages.push(posted);
      if (!opts.limit) messages.push({ seq: posted.seq + 1, own: false, text: 'A short answer.' });
      return json(
        route,
        {
          message: message(posted),
          ...(opts.limit
            ? {
                elric_notice: {
                  code: 'elric_limit',
                  kind: 'short',
                  text: LIMIT_TEXT,
                  resets_at: '2026-10-02T00:00:00.000Z',
                },
              }
            : {}),
        },
        201,
      );
    }
    const since = Number(new URL(route.request().url()).searchParams.get('since') ?? 0);
    return json(route, {
      room: {
        id: CHAT,
        slug: 'elric-chat',
        name: opts.chatName ?? 'Elric',
        topic: '',
        role: 'host',
        closed: false,
        history: 'full',
        member_count: 2,
        latest_seq: latest(),
        created_at: '2026-10-01T09:00:00.000Z',
      },
      messages: messages.filter((item) => item.seq > since).map(message),
      latest_seq: latest(),
      visible_from_seq: 0,
      next_since: latest(),
      has_more: false,
    });
  });
}

async function signIn(page: Page) {
  const created = await page.request.post('/api/auth/register', {
    headers,
    data: { name: `Mascot-${crypto.randomUUID().slice(0, 8)}`, password: PASSWORD },
  });
  expect(created.status()).toBe(201);
}

/** Signed out with Elric on: GET /api/elric answers 401. */
async function mockSignedOut(page: Page) {
  await page.route('**/api/auth/google', (route) => json(route, { enabled: false, linked: null }));
  await page.route('**/api/elric', (route) => json(route, { error: 'Sign in to continue.' }, 401));
}

/** Whether the title row leaves the mascot room before the first header control. */
async function roomForPeek(page: Page) {
  const header = page.locator('.elx-header');
  const anchor = (await header.locator('.elx-mascot-anchor').boundingBox())!;
  const actions = (await header.locator('.elx-actions').boundingBox())!;
  return anchor.x + anchor.width <= actions.x - 4;
}

/**
 * The header mascot is decorative, sits on the bottom line and overlaps nothing in the header.
 * With whenRoom (narrow phones, where system fonts decide the buttons' width) he may stay out of
 * sight, but only when the controls really leave him no room.
 */
async function expectPeekOnTheLine(page: Page, opts: { whenRoom?: boolean } = {}) {
  const header = page.locator('.elx-header');
  const peek = header.locator('.elx-mascot-peek');
  // Signed out, the page arrives prerendered and the live screen then replaces those nodes:
  // measure the live header, not elements that are about to be swapped out.
  await expect(page.locator('[data-prerendered]')).toHaveCount(0);
  await expect(peek).toBeAttached();
  await page.evaluate(() => document.fonts.ready);
  if (opts.whenRoom && !(await roomForPeek(page))) {
    await expect(peek).toBeHidden();
    return;
  }
  await expect(peek).toBeVisible();
  await expect(peek).toHaveAttribute('alt', '');
  await expect(header.locator('.elx-mascot-anchor')).toHaveAttribute('aria-hidden', 'true');
  expect(await peek.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  expect(await peek.evaluate((img) => getComputedStyle(img).pointerEvents)).toBe('none');
  const box = (await peek.boundingBox())!;
  const bar = (await header.boundingBox())!;
  // Signed in, Elric is inside the workspace, drawn at its scale; signed out it is full size.
  const scale = (await page.locator('.app-shell').count())
    ? workspaceScale(page.viewportSize()!.width)
    : 1;
  expect(Math.round(box.height)).toBe(Math.round(24 * scale));
  // Its bottom is on the header's 1px bottom border.
  expect(Math.abs(box.y + box.height - (bar.y + bar.height))).toBeLessThanOrEqual(1);
  // Right of the wordmark and the AI tag, clear of them and of every header control.
  const tag = (await header.locator('.elx-tag').boundingBox())!;
  const name = (await header.locator('h1').boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(tag.x + tag.width);
  expect(box.x).toBeGreaterThanOrEqual(name.x + name.width);
  for (const control of await header.locator('.elx-actions > *').all()) {
    if (!(await control.isVisible())) continue;
    const other = (await control.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(other.x);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
}

/**
 * Signed in (Workspace v3): the top bar is Elric's pill and its chips, with no header line for
 * the mascot to lie on and nothing outside the viewport.
 */
async function expectV3TopBar(page: Page) {
  const header = page.locator('.elx-header');
  await expect(header.locator('.elx3-pill')).toBeVisible();
  await expect(header.locator('.elx-mascot-peek')).toHaveCount(0);
  const width = page.viewportSize()!.width;
  for (const control of await header.locator('.elx3-pill, button').all()) {
    if (!(await control.isVisible())) continue;
    const box = (await control.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
}

for (const width of [360, 390, 1440]) {
  test(`signed in at ${width}px: no mascot in the v3 top bar, none at the notice`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
    await mockElric(page);
    await signIn(page);
    await page.goto('/elric');
    await expect(page.getByRole('heading', { name: 'What can I help with?' })).toBeVisible();
    await expectV3TopBar(page);
    // A normal turn: no resting mascot anywhere.
    await page.getByLabel('Message Elric').fill('Hello');
    await page.keyboard.press('Enter');
    await expect(page.getByText('A short answer.')).toBeVisible();
    await expect(page.locator('.elx-mascot-rest')).toHaveCount(0);
  });

  test(`signed out at ${width}px: the same mascot on the header line`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
    await mockSignedOut(page);
    await page.goto('/elric');
    await expect(page.getByRole('heading', { name: 'What can I help with?' })).toBeVisible();
    await expectPeekOnTheLine(page, { whenRoom: width < 380 });
  });
}

test('the header mascot holds its place at 360px and in dark mode', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await mockSignedOut(page);
  await page.goto('/elric?theme=dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expectPeekOnTheLine(page, { whenRoom: true });
  expect(
    await page.locator('.elx-mascot-peek').evaluate((img) => getComputedStyle(img).filter),
  ).toContain('invert');
});

test('the header mascot steps out of sight rather than cover a control, and comes back', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockSignedOut(page);
  await page.goto('/elric');
  const peek = page.locator('.elx-mascot-peek');
  await expect(peek).toBeVisible();
  // Wider buttons (as with wide system fonts) leave no room: he is hidden, nothing is covered.
  const wide = await page.addStyleTag({
    content: '.elx-out-header .elx-pill { padding: 0 48px !important; }',
  });
  await expect(peek).toBeHidden();
  expect(await roomForPeek(page)).toBe(false);
  await wide.evaluate((style) => (style as HTMLStyleElement).remove());
  await expect(peek).toBeVisible();
  await expectPeekOnTheLine(page);
});

test('the resting mascot shows only with the daily limit notice, copy unchanged', async ({
  page,
}) => {
  await mockElric(page, { limit: true });
  await signIn(page);
  await page.goto('/elric');
  await expect(page.locator('.elx-mascot-rest')).toHaveCount(0);
  await page.getByLabel('Message Elric').fill('Hello');
  await page.keyboard.press('Enter');
  const notice = page.locator('.elx-notice.is-limit');
  await expect(notice).toHaveText(LIMIT_TEXT);
  const rest = notice.locator('.elx-mascot-rest');
  await expect(rest).toBeVisible();
  await expect(rest).toHaveAttribute('alt', '');
  await expect(rest).toHaveAttribute('aria-hidden', 'true');
  expect(Math.round((await rest.boundingBox())!.height)).toBe(
    Math.round(38 * workspaceScale(page.viewportSize()!.width)),
  );
  // Another notice replaces it: the mascot goes with the limit notice.
  await page.getByRole('button', { name: 'New chat' }).click();
  await expect(page.locator('.elx-mascot-rest')).toHaveCount(0);
});

for (const width of [360, 390]) {
  test(`signed in at ${width}px with a long chat name: the v3 top bar still fits`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await mockElric(page, {
      chatName: 'A Very Long Comprehensive Architecture Chat Room Name With Lots Of Words',
    });
    await signIn(page);
    await page.goto('/elric');
    await expect(page.getByRole('heading', { name: 'What can I help with?' })).toBeVisible();
    await expectV3TopBar(page);
  });
}
