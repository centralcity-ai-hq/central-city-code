import { test, expect, type Page, type Route } from '@playwright/test';
import { ELRIC_AI_TAG } from '../shared/elric-copy';

/*
 * The /elric dashboard (docs/ELRIC.md "Dashboard chat"). The e2e server runs without CITY_ELRIC,
 * so /api/elric* and the chat room's message routes are served by page.route with the shapes of
 * server/elric/chat.ts and the rooms routes; tests/elric-chat.test.ts covers the real routes.
 * The page is drawn in Workspace v3
 * (docs/design/WORKSPACE_V3_ELRIC_AGENTS.md §1): a floating top bar, the chats column, a minimal
 * Home, action cards inside Elric's bubble, the first-visit card and the Manage Elric sheet.
 */
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'x-city-request': '1' };
const CHAT = 'c4a1e2f0-1b2c-4d3e-8f90-0a1b2c3d4e5f';
const PERSON = 'p-member-1';
const SHARED = { id: 'r-shared-1', name: 'Weekly planning' };

type Msg = { seq: number; own: boolean; text: string; model?: string };

async function mockElric(
  page: Page,
  opts: {
    messages?: Msg[];
    pending?: boolean;
    silent?: boolean;
    powerFails?: boolean;
    paused?: boolean;
  } = {},
) {
  const state = {
    messages: [...(opts.messages ?? [])],
    posts: [] as Array<{ room: string; body: Record<string, unknown> }>,
    asks: [] as unknown[],
    power: [] as string[],
    decisions: [] as Array<[string, unknown]>,
    pending: opts.pending
      ? [
          {
            id: 'a6f3c1d2-4b5e-4f60-9a71-8b2c3d4e5f60',
            tool: 'room_task_create',
            summary: 'Create task: Update the onboarding checklist',
            args_hash: 'a'.repeat(64),
            room: SHARED,
            created_at: '2026-10-01T09:00:00.000Z',
            expires_at: '2026-10-01T09:10:00.000Z',
          },
        ]
      : [],
  };
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const message = (item: Msg) => ({
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
    auto_reply: item.own ? null : { provider: 'elric', model: item.model ?? 'gemma-4-12b' },
  });
  const latest = () => state.messages.at(-1)?.seq ?? 0;
  const settings = { host_may_invoke: false, saved: [] as unknown[] };
  await page.route('**/api/elric', (route) =>
    json(route, {
      agent_id: 'elric-agent',
      status: opts.paused && !state.power.includes('resume') ? 'paused' : 'active',
      host_may_invoke: settings.host_may_invoke,
      eligible: true,
      eligibility_reason: null,
      usage: {
        used: { short: 3, summary: 0, tool: 1 },
        allowance: { short: 50, summary: 10, tool: 10 },
        resets_at: '2026-10-02T00:00:00.000Z',
      },
    }),
  );
  await page.route('**/api/elric/settings', (route) => {
    const body = route.request().postDataJSON() as { host_may_invoke: boolean };
    settings.saved.push(body);
    settings.host_may_invoke = body.host_may_invoke;
    return json(route, { agent_id: 'elric-agent', host_may_invoke: body.host_may_invoke });
  });
  await page.route('**/api/elric/chat*', (route) =>
    json(route, {
      room_id: CHAT,
      slug: 'elric-chat',
      person_member_id: PERSON,
      status: opts.paused && !state.power.includes('resume') ? 'paused' : 'active',
      latest_seq: latest(),
      waking: false,
      pending_count: state.pending.length,
    }),
  );
  for (const action of ['pause', 'resume'] as const)
    await page.route(`**/api/elric/${action}`, (route) => {
      state.power.push(action);
      if (opts.powerFails) return json(route, { error: 'x' }, 500);
      return json(route, {
        agent_id: 'elric-agent',
        status: action === 'pause' ? 'paused' : 'active',
      });
    });
  await page.route('**/api/elric/rooms', (route) =>
    json(route, { rooms: [{ ...SHARED, member_count: 3, hosting: true, elric_member: true }] }),
  );
  await page.route('**/api/elric/ask', (route) => {
    state.asks.push(route.request().postDataJSON());
    return json(route, { room_id: SHARED.id, person_member_id: 'p-shared', posts_publicly: true });
  });
  await page.route('**/api/elric/pending', (route) => json(route, { pending: state.pending }));
  await page.route('**/api/elric/pending/*/*', (route) => {
    const [, , , , id, decision] = new URL(route.request().url()).pathname.split('/');
    state.decisions.push([decision!, route.request().postDataJSON()]);
    state.pending = state.pending.filter((item) => item.id !== id);
    return json(route, { id, status: decision === 'approve' ? 'approved' : 'rejected' });
  });
  await page.route('**/api/rooms/*/messages*', (route) => {
    const room = new URL(route.request().url()).pathname.split('/')[3]!;
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      state.posts.push({ room, body });
      const posted = { seq: latest() + 1, own: true, text: String(body.text) };
      if (room === CHAT) {
        state.messages.push(posted);
        // Elric answers on the next poll (unless the turn fails: `silent`).
        if (!opts.silent)
          state.messages.push({
            seq: posted.seq + 1,
            own: false,
            text: 'Here is a **short** answer.',
          });
      }
      return json(route, { message: message(posted) }, 201);
    }
    const since = Number(new URL(route.request().url()).searchParams.get('since') ?? 0);
    const list = state.messages.filter((item) => item.seq > since).map(message);
    return json(route, {
      room: {
        id: CHAT,
        slug: 'elric-chat',
        name: 'Elric',
        topic: '',
        role: 'host',
        closed: false,
        history: 'full',
        member_count: 2,
        latest_seq: latest(),
        created_at: '2026-10-01T09:00:00.000Z',
      },
      messages: list,
      latest_seq: latest(),
      visible_from_seq: 0,
      next_since: latest(),
      has_more: false,
    });
  });
  return Object.assign(state, { settings });
}

async function signIn(page: Page) {
  const created = await page.request.post('/api/auth/register', {
    headers,
    data: { name: `Dash-owner-${crypto.randomUUID().slice(0, 8)}`, password: PASSWORD },
  });
  expect(created.status()).toBe(201);
}

/**
 * The first visit (no Elric yet): the GET /api/elric eligibility drives the card's two steps.
 * After the age is confirmed and Elric is created, the chat opens (GET /api/elric then names it).
 */
async function mockFirstVisit(page: Page, reason: 'unverified' | 'age_unknown' | null) {
  const state = { ages: [] as unknown[], created: false };
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/elric', (route) => {
    if (route.request().method() === 'POST') {
      state.created = true;
      return json(route, { agent_id: 'elric-agent', created: true }, 201);
    }
    return json(
      route,
      state.created
        ? { agent_id: 'elric-agent', status: 'active', eligible: true, eligibility_reason: null }
        : {
            agent_id: null,
            status: null,
            eligible: reason === null || state.ages.length > 0,
            eligibility_reason: state.ages.length ? null : reason,
          },
    );
  });
  await page.route('**/api/elric/age', (route) => {
    state.ages.push(route.request().postDataJSON());
    return json(route, { eligible: true });
  });
  return state;
}

test('first visit: Meet Elric, Google linked with a green check, the age in a sheet, then the chat', async ({
  page,
}) => {
  // The chat's routes for after Elric is created; the first visit's status answers before.
  await mockElric(page);
  const state = await mockFirstVisit(page, 'age_unknown');
  await signIn(page);
  await page.goto('/elric');
  await expect(page.getByRole('heading', { name: 'Meet Elric' })).toBeVisible();
  // Nothing to manage yet: the top bar is Elric's pill only.
  await expect(
    page.locator('.elx-header').getByRole('button', { name: 'Manage Elric' }),
  ).toHaveCount(0);
  await expect(page.locator('.elx-header').getByRole('button', { name: 'New chat' })).toHaveCount(
    0,
  );
  const steps = page.getByRole('list', { name: 'Before you start' }).getByRole('listitem');
  await expect(steps).toHaveCount(2);
  await expect(steps.nth(0)).toHaveAttribute('data-done', 'true');
  await expect(steps.nth(0)).toContainText('Linked');
  await expect(steps.nth(1)).not.toHaveAttribute('data-done', 'true');
  // The card stands alone: no example panels under it.
  await expect(page.getByTestId('elric-example')).toHaveCount(0);
  // The date of birth sheet: focus in, Escape out, focus back on its button.
  const confirm = page.getByRole('button', { name: 'Confirm age' });
  await confirm.click();
  const sheet = page.getByRole('dialog', { name: 'Confirm your age' });
  await expect(sheet.getByLabel('Date of birth')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(confirm).toBeFocused();
  await confirm.click();
  await sheet.getByLabel('Date of birth').fill('1990-05-17');
  await sheet.getByRole('button', { name: 'Confirm your age' }).click();
  await expect(page.getByLabel('Message Elric')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What can I help with?' })).toBeVisible();
  expect(state.ages).toEqual([{ date_of_birth: '1990-05-17' }]);
  expect(state.created).toBe(true);
});

test('first visit without Google: Link Google first, the age step waits for it', async ({
  page,
}) => {
  await mockFirstVisit(page, 'unverified');
  await signIn(page);
  await page.goto('/elric');
  await expect(page.getByRole('heading', { name: 'Meet Elric' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Link Google' })).toHaveAttribute(
    'href',
    '/settings/account',
  );
  await expect(page.getByRole('button', { name: 'Confirm age' })).toBeDisabled();
  await expect(page.locator('.elx3-step[data-done]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start chatting' })).toHaveCount(0);
});

test('first visit, both steps done: two green checks and Start chatting', async ({ page }) => {
  await mockFirstVisit(page, null);
  await signIn(page);
  await page.goto('/elric');
  await expect(page.locator('.elx3-step[data-done]')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Start chatting' })).toBeVisible();
  await expect(page.getByTestId('elric-example')).toHaveCount(0);
});

test('without Elric on the server, /elric is not found', async ({ page }) => {
  await signIn(page);
  await page.goto('/elric');
  await expect(page.getByText('This page doesn’t exist.')).toBeVisible();
});

test('Home: the orb, one line, three suggestions, the top bar and a disabled send', async ({
  page,
}) => {
  await mockElric(page);
  const roomReads: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/elric/rooms') roomReads.push(request.url());
  });
  await signIn(page);
  await page.goto('/elric');
  await expect(page.getByRole('heading', { name: 'Elric', level: 1 })).toBeVisible();
  // One "built in" badge that still says AI to assistive technology.
  await expect(page.locator('.elx-title .elx-tag')).toHaveText(`built-in ${ELRIC_AI_TAG}`);
  await expect(page.getByRole('heading', { name: 'What can I help with?' })).toBeVisible();
  await expect(page.locator('.elx3-home .elx3-mark-orb')).toBeVisible();
  // Home is minimal: no approval pill without approvals, no example cards, no sub-headline.
  await expect(page.locator('.elx3-approve-pill')).toHaveCount(0);
  await expect(page.getByTestId('elric-example')).toHaveCount(0);
  await expect(page.locator('.elx3-home p')).toHaveCount(0);
  await expect(page.locator('.elx-chip')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Manage Elric' })).toBeVisible();
  // The live line (the rooms Elric is in) is read lazily: no request and no line on open.
  await page.waitForTimeout(800);
  expect(roomReads).toEqual([]);
  await expect(page.locator('.elx3-live')).toHaveCount(0);
  // Opening Manage Elric reads it once.
  await page.getByRole('button', { name: 'Manage Elric' }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.elx3-live')).toHaveText('On in 1 room');
  expect(roomReads).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'New chat' })).toBeVisible();
  const send = page.getByRole('button', { name: 'Send' });
  await expect(send).toBeDisabled();
  await page.locator('.elx-chip').first().click();
  await expect(page.getByLabel('Message Elric')).toHaveValue(
    'How do I invite my ChatGPT into a room?',
  );
  await expect(send).toBeEnabled();
  // No internal wording on the page.
  await expect(page.locator('body')).not.toContainText(/Status:|dispatch|#\d{3,}/);
});

const STARTERS = [
  'How do I invite my ChatGPT into a room?',
  'Explain how Central City rooms work',
  'What can you do for me?',
];

test('starters: a tap fills without sending, they go after a message and come back on New chat', async ({
  page,
}) => {
  const state = await mockElric(page);
  await signIn(page);
  await page.goto('/elric');
  const starters = page.getByRole('group', { name: 'Suggestions' }).getByRole('button');
  await expect(starters).toHaveText(STARTERS);
  const box = page.getByLabel('Message Elric');
  await starters.nth(1).click();
  await expect(box).toHaveValue(STARTERS[1]!);
  await expect(box).toBeFocused();
  expect(state.posts).toHaveLength(0);
  await page.keyboard.press('Enter');
  await expect(page.locator('.elx-bubble')).toHaveText(STARTERS[1]!);
  await expect(starters).toHaveCount(0);
  expect(state.posts).toHaveLength(1);
  await page.getByRole('button', { name: 'New chat' }).click();
  await expect(starters).toHaveCount(3);
  await expect(page.locator('body')).not.toContainText(/gemma|gpt-\d|claude-/i);
});

test('starters: reachable by keyboard with a visible focus', async ({ page }) => {
  const state = await mockElric(page);
  await signIn(page);
  await page.goto('/elric');
  const first = page.getByRole('button', { name: STARTERS[0]! });
  await first.focus();
  const outline = await first.evaluate((element) => getComputedStyle(element).outlineStyle);
  expect(outline).toBe('solid');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: STARTERS[1]! })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Message Elric')).toHaveValue(STARTERS[1]!);
  await expect(page.getByLabel('Message Elric')).toBeFocused();
  expect(state.posts).toHaveLength(0);
});

test('starters on a phone: one per row, 44px targets, no sideways scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockElric(page);
  await signIn(page);
  await page.goto('/elric');
  const starters = page.locator('.elx-chip');
  await expect(starters).toHaveCount(3);
  const boxes = await Promise.all((await starters.all()).map((item) => item.boundingBox()));
  for (const [index, box] of boxes.entries()) {
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    if (index) expect(box!.y).toBeGreaterThan(boxes[index - 1]!.y + boxes[index - 1]!.height - 1);
  }
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
});

test('a message posts "@Elric …" as the person member and the reply shows its label', async ({
  page,
}) => {
  const state = await mockElric(page);
  await signIn(page);
  await page.goto('/elric');
  await page.getByLabel('Message Elric').fill('What changed this week?');
  await page.keyboard.press('Enter');
  await expect(page.locator('.elx-bubble')).toHaveText('What changed this week?');
  expect(state.posts[0]).toMatchObject({
    room: CHAT,
    body: { text: '@Elric What changed this week?', agent_id: PERSON },
  });
  // The dots show at once in Elric's place and go when the reply lands.
  const thinking = page.getByTestId('elric-thinking');
  await expect(thinking).toBeVisible();
  await expect(thinking).toHaveAttribute('aria-live', 'polite');
  await expect(thinking).toContainText('Elric is thinking');
  await expect(page.getByTestId('elric-reply')).toContainText('short answer', { timeout: 10_000 });
  await expect(thinking).toHaveCount(0);
  const byline = page.getByTestId('elric-reply').locator('.elx-byline');
  await expect(byline).toHaveText(/^Elric\s*built-in AI$/);
  await expect(byline).toHaveAttribute('title', 'Elric v1.0');
  // No model name anywhere users see.
  await expect(page.locator('body')).not.toContainText('gemma');
  // The reply's last line is not under the composer.
  const reply = await page.getByTestId('elric-reply').boundingBox();
  const dock = await page.locator('.elx-composer').boundingBox();
  expect(reply!.y + reply!.height).toBeLessThanOrEqual(dock!.y);
});

test('a proposed action waits for approval: Approve sends the args hash', async ({ page }) => {
  const state = await mockElric(page, {
    pending: true,
    messages: [
      { seq: 1, own: true, text: '@Elric Make a task for the checklist' },
      { seq: 2, own: false, text: 'I proposed a task. Approve it to create it.' },
    ],
  });
  await signIn(page);
  await page.goto('/elric');
  const card = page.getByTestId('elric-pending');
  await expect(card).toContainText('Waiting for your approval');
  await expect(card).toContainText('Update the onboarding checklist');
  // Inside Elric's bubble: Approve is the only filled button; Decline is the other choice.
  await expect(card.getByRole('button')).toHaveText(['Approve', 'Decline']);
  await expect(card.getByRole('button', { name: 'Approve' })).toHaveClass(/is-primary/);
  await expect(card.getByRole('button', { name: 'Decline' })).not.toHaveClass(/is-primary/);
  // Each button names its action for screen readers.
  await card
    .getByRole('button', {
      name: 'Approve: Create task: Update the onboarding checklist',
      exact: true,
    })
    .click();
  await expect(card).toHaveCount(0);
  expect(state.decisions[0]).toEqual(['approve', { args_hash: 'a'.repeat(64) }]);
  // The approved action stays in the bubble as done, with what it did, and takes the focus.
  const done = page.getByTestId('elric-done');
  await expect(done).toBeFocused();
  await expect(done).toContainText('Done');
  await expect(done).toContainText('Update the onboarding checklist');
  await expect(done).toContainText(SHARED.name);
});

test('Decline rejects a proposed action and nothing is created', async ({ page }) => {
  const state = await mockElric(page, {
    pending: true,
    messages: [
      { seq: 1, own: true, text: '@Elric Make a task for the checklist' },
      { seq: 2, own: false, text: 'I proposed a task. Approve it to create it.' },
    ],
  });
  await signIn(page);
  await page.goto('/elric');
  const card = page.getByTestId('elric-pending');
  await card
    .getByRole('button', { name: 'Decline: Create task: Update the onboarding checklist' })
    .click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId('elric-done')).toHaveCount(0);
  // Nothing is left to decide: focus goes to the composer, never to the page.
  await expect(page.getByLabel('Message Elric')).toBeFocused();
  expect(state.decisions).toEqual([['reject', {}]]);
});

test('Home with an approval waiting: one accent pill, Review opens the action card', async ({
  page,
}) => {
  await mockElric(page, { pending: true });
  await signIn(page);
  await page.goto('/elric');
  await expect(page.getByRole('heading', { name: 'What can I help with?' })).toBeVisible();
  const pill = page.locator('.elx3-approve-pill');
  await expect(pill).toHaveCount(1);
  await expect(pill).toContainText('1 action waiting for you');
  // No orange on Elric: the pill is the accent blue.
  const colour = await pill.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(colour).toBe('rgb(234, 241, 255)');
  await expect(page.getByTestId('elric-pending')).toHaveCount(0);
  await pill.getByRole('button', { name: 'Review' }).click();
  const card = page.getByTestId('elric-pending');
  await expect(card).toContainText('Update the onboarding checklist');
  await expect(page.getByRole('group', { name: 'Elric’s actions' })).toBeFocused();
  await expect(page.locator('.elx3-approve-pill')).toHaveCount(0);
});

test('"@ room" asks the server first and posts in that room', async ({ page }) => {
  const state = await mockElric(page);
  await signIn(page);
  await page.goto('/elric');
  await page.getByRole('button', { name: 'Ask in a room' }).click();
  await page.getByRole('option', { name: SHARED.name }).click();
  await page.getByLabel('Message Elric').fill('Summarize today');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('status')).toContainText(`Posted in ${SHARED.name}`);
  expect(state.asks).toEqual([{ room_id: SHARED.id }]);
  expect(state.posts[0]).toMatchObject({
    room: SHARED.id,
    body: { text: '@Elric Summarize today', agent_id: 'p-shared' },
  });
});

test('mobile: the top bar fits on one row at 390px with 44px targets', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockElric(page);
  await signIn(page);
  await page.goto('/elric');
  await expect(page.getByRole('heading', { name: 'What can I help with?' })).toBeVisible();
  const header = await page.locator('.elx-header').boundingBox();
  // One row: 44px chips plus the bar's padding.
  expect(header!.height).toBeLessThanOrEqual(66);
  for (const name of ['Manage Elric', 'New chat']) {
    const box = await page.locator('.elx-header').getByRole('button', { name }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
  }
  // Manage Elric's switch row: the label and the switch make one target of 44px and up.
  await page.locator('.elx-header').getByRole('button', { name: 'Manage Elric' }).click();
  const row = page.getByRole('dialog', { name: 'Manage Elric' }).locator('.elx3-row-switch');
  const rowBox = (await row.boundingBox())!;
  expect(rowBox.height).toBeGreaterThanOrEqual(44);
  const label = (await row.locator('label').boundingBox())!;
  expect(label.height).toBeGreaterThanOrEqual(44);
  await page.keyboard.press('Escape');
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
});

test('a long thread and a 6-line draft: the last reply stays above the composer', async ({
  page,
}) => {
  const messages: Msg[] = [];
  for (let seq = 1; seq <= 24; seq += 2) {
    messages.push({ seq, own: true, text: `@Elric Question ${seq}` });
    messages.push({ seq: seq + 1, own: false, text: `Answer ${seq + 1}.\n\nA second paragraph.` });
  }
  await mockElric(page, { messages });
  // A slow machine: the Markdown renderer arrives late, so replies grow after the first scroll.
  await page.route(/\/assets\/Markdown-[^/]*\.js$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await signIn(page);
  await page.goto('/elric');
  await expect(page.getByTestId('elric-reply').last()).toContainText('Answer 24');
  const lastAboveDock = async () => {
    const reply = await page.getByTestId('elric-reply').last().boundingBox();
    const dock = await page.locator('.elx-dock').boundingBox();
    return reply!.y + reply!.height <= dock!.y;
  };
  // Right after loading, before any draft.
  await expect.poll(lastAboveDock).toBe(true);
  await page
    .getByLabel('Message Elric')
    .fill(['one', 'two', 'three', 'four', 'five', 'six'].join('\n'));
  await expect
    .poll(async () => {
      const reply = await page.getByTestId('elric-reply').last().boundingBox();
      const dock = await page.locator('.elx-dock').boundingBox();
      return reply!.y + reply!.height <= dock!.y;
    })
    .toBe(true);
  // Elric's replies (own:true for the owner) never render as the person's bubble.
  await expect(page.locator('.elx-bubble')).toHaveCount(12);
});

test('a turn that never answers: quiet lines at 10 s and 30 s, then an error with Try again', async ({
  page,
}) => {
  await page.clock.install();
  const state = await mockElric(page, { silent: true });
  await signIn(page);
  await page.goto('/elric');
  await page.getByLabel('Message Elric').fill('Hello');
  await page.keyboard.press('Enter');
  const thinking = page.getByTestId('elric-thinking');
  await expect(thinking).toBeVisible();
  await expect(thinking).toContainText('Elric');
  await expect(thinking.locator('.cc-thinking-line')).toHaveCount(0);
  await page.clock.fastForward(11_000);
  await expect(thinking.locator('.cc-thinking-line')).toHaveText('Thinking…');
  await page.clock.fastForward(20_000);
  await expect(thinking.locator('.cc-thinking-line')).toHaveText('Still working on it…');
  // Within the 55 s run budget it keeps waiting; after it, the plain error and Try again.
  await page.clock.fastForward(20_000);
  await expect(thinking).toBeVisible();
  await page.clock.fastForward(10_000);
  await expect(thinking).toHaveCount(0);
  await expect(page.getByText('Elric didn’t answer.')).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(thinking).toBeVisible();
  expect(state.posts.map((post) => post.body.text)).toEqual(['@Elric Hello', '@Elric Hello']);
});

test('the name opens the about sheet with the version; Escape closes it', async ({ page }) => {
  await mockElric(page);
  await signIn(page);
  await page.goto('/elric');
  // The page's heading; the workspace navigation has an "Elric" entry of its own.
  const name = page
    .getByRole('heading', { level: 1 })
    .getByRole('button', { name: 'Elric', exact: true });
  await expect(name).toHaveAttribute('title', 'Elric v1.0');
  await name.click();
  const sheet = page.getByRole('dialog', { name: 'Elric · Version 1.0' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'OK' })).toBeFocused();
  await expect(page.locator('body')).not.toContainText('gemma');
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(name).toBeFocused();
});

test('no on/off switch in the /elric header; a paused Elric points to Manage Elric', async ({
  page,
}) => {
  await mockElric(page, { paused: true });
  await signIn(page);
  await page.goto('/elric');
  await expect(page.locator('.elx-header').getByRole('switch')).toHaveCount(0);
  await expect(page.getByLabel('Message Elric')).toBeDisabled();
  await expect(page.getByText(/Elric is paused\./)).toBeVisible();
  // No starters where typing isn't possible.
  await expect(page.locator('.elx-chip')).toHaveCount(0);
  // Resume it in Manage Elric: the sheet, where Resume brings the composer back.
  await page.getByRole('button', { name: 'Resume it in Manage Elric' }).click();
  const sheet = page.getByRole('dialog', { name: 'Manage Elric' });
  await expect(sheet.getByText('Paused')).toBeVisible();
  await sheet.getByRole('button', { name: 'Resume Elric' }).click();
  // The same button now says Pause Elric, and keeps the focus.
  await expect(sheet.getByRole('button', { name: 'Pause Elric' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(page.getByLabel('Message Elric')).toBeEnabled();
  await expect(page.getByText(/Elric is paused\./)).toHaveCount(0);
});

test('Manage Elric: a sheet with the real settings, and Activity in the console', async ({
  page,
}) => {
  const state = await mockElric(page);
  await signIn(page);
  await page.goto('/elric');
  const manage = page.locator('.elx-header').getByRole('button', { name: 'Manage Elric' });
  await manage.click();
  const sheet = page.getByRole('dialog', { name: 'Manage Elric' });
  await expect(sheet).toBeVisible();
  // Only settings that exist: room hosts may ask (host_may_invoke), today's allowance, pause.
  const hosts = sheet.getByRole('switch', { name: 'Room hosts can ask your Elric' });
  await expect(hosts).toHaveAttribute('aria-checked', 'false');
  await expect(sheet.getByRole('switch')).toHaveCount(1);
  await expect(sheet.getByRole('meter', { name: 'Answers used today' })).toHaveAttribute(
    'aria-valuetext',
    '3 of 50',
  );
  await expect(sheet).toContainText('Google account linked · Age confirmed');
  await expect(sheet.getByRole('button', { name: 'Pause Elric' })).toBeVisible();
  await hosts.click();
  await expect(hosts).toHaveAttribute('aria-checked', 'true');
  expect(state.settings.saved).toEqual([{ host_may_invoke: true }]);
  // The whole row is the target: its words toggle the switch too.
  await sheet.getByText('Room hosts can ask your Elric').click();
  await expect(hosts).toHaveAttribute('aria-checked', 'false');
  expect(state.settings.saved).toEqual([{ host_may_invoke: true }, { host_may_invoke: false }]);
  // Escape closes it and focus goes back to the chip.
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(manage).toBeFocused();
  await manage.click();
  const avatar = page.getByRole('dialog', { name: 'Manage Elric' }).getByRole('link', {
    name: 'Activity',
  });
  await expect(avatar).toHaveAttribute('href', '/#elric');
  // The console's Elric view: status, pending and turns.
  const kinds = { short: 0, summary: 0, tool: 0 };
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.route('**/api/elric**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const body =
      path === '/api/elric'
        ? {
            agent_id: 'a-1',
            status: 'active',
            usage: { used: kinds, allowance: kinds, resets_at: '2026-10-03T00:00:00Z' },
          }
        : path === '/api/elric/pending'
          ? { pending: [] }
          : { turns: [], next_cursor: null };
    return route.fulfill({ json: body });
  });
  await avatar.click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Elric.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
});

test('with reduced motion the thinking indicator is one still dot', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockElric(page, { silent: true });
  await signIn(page);
  await page.goto('/elric');
  await page.getByLabel('Message Elric').fill('Hello');
  await page.keyboard.press('Enter');
  const dots = page.getByTestId('elric-thinking').locator('.cc-thinking-dots > span');
  await expect(dots.first()).toBeVisible();
  await expect(dots.nth(1)).toBeHidden();
  expect(await dots.first().evaluate((dot) => getComputedStyle(dot).animationName)).toBe('none');
});

/**
 * The chat history (F16, GET/POST/PATCH/DELETE /api/elric/conversations): served here over the
 * dashboard mock, with each conversation its own room of messages.
 */
async function mockConversations(page: Page) {
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const OLD = 'conv-old-0000-0000-0000-000000000001';
  const state = {
    list: [
      { id: CHAT, title: 'Weekly planning ideas', latest: 2 } as {
        id: string;
        title: string;
        latest: number;
        source?: string;
      },
      { id: OLD, title: 'Older chat', latest: 1 },
    ],
    rooms: new Map<string, Array<{ seq: number; own: boolean; text: string }>>([
      [
        CHAT,
        [
          { seq: 1, own: true, text: '@Elric Ideas for the weekly planning?' },
          { seq: 2, own: false, text: 'Three ideas for the week.' },
        ],
      ],
      [OLD, [{ seq: 1, own: true, text: '@Elric An older question' }]],
    ]),
    created: 0,
  };
  const view = (item: { id: string; title: string; latest: number; source?: string }) => ({
    id: item.id,
    slug: item.id,
    title: item.title,
    title_source: item.source ?? 'fallback',
    person_member_id: PERSON,
    created_at: '2026-10-02T08:00:00.000Z',
    updated_at: '2026-10-02T08:00:00.000Z',
    latest_seq: item.latest,
    read_only: false,
  });
  await page.route('**/api/elric/conversations**', (route) => {
    const request = route.request();
    const id = decodeURIComponent(new URL(request.url()).pathname.split('/')[4] ?? '');
    if (!id && request.method() === 'GET')
      return json(route, { conversations: state.list.map(view) });
    if (!id && request.method() === 'POST') {
      state.created += 1;
      const created = { id: `conv-new-${state.created}`, title: 'New chat', latest: 0 };
      state.list.unshift(created);
      state.rooms.set(created.id, []);
      return json(route, view(created), 201);
    }
    const item = state.list.find((entry) => entry.id === id);
    if (!item) return json(route, { error: 'Conversation not found.' }, 404);
    if (request.method() === 'PATCH') {
      item.title = (request.postDataJSON() as { title: string }).title;
      item.source = 'user';
      return json(route, view(item));
    }
    if (request.method() === 'DELETE') {
      state.list = state.list.filter((entry) => entry.id !== id);
      return json(route, { deleted: true, id });
    }
    return json(route, view(item));
  });
  await page.route('**/api/rooms/*/messages*', (route) => {
    const room = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3]!);
    const list = state.rooms.get(room) ?? [];
    if (route.request().method() === 'POST') {
      const text = String((route.request().postDataJSON() as { text: string }).text);
      const posted = { seq: list.length + 1, own: true, text };
      list.push(posted);
      state.rooms.set(room, list);
      const item = state.list.find((entry) => entry.id === room)!;
      item.latest = posted.seq;
      // The first message names a new conversation.
      if (item.title === 'New chat') item.title = text.replace(/^@Elric\s+/, '');
      return json(
        route,
        {
          message: {
            id: `${room}-${posted.seq}`,
            ...posted,
            sender_agent_id: PERSON,
            sender: 'You',
            sender_owner_label: 'You',
            origin: 'external',
            parts: [{ type: 'text', text }],
            created_at: '2026-10-02T08:00:00.000Z',
          },
        },
        201,
      );
    }
    return json(route, {
      room: {
        id: room,
        slug: room,
        name: 'Elric',
        topic: '',
        role: 'host',
        closed: false,
        history: 'full',
        member_count: 2,
        latest_seq: list.length,
        created_at: '2026-10-02T08:00:00.000Z',
      },
      messages: list.map((item) => ({
        id: `${room}-${item.seq}`,
        ...item,
        own: true,
        origin: 'external',
        sender: item.own ? 'You' : 'Elric',
        sender_agent_id: item.own ? PERSON : 'elric-agent',
        sender_owner_label: 'You',
        parts: [{ type: 'text', text: item.text }],
        created_at: '2026-10-02T08:00:00.000Z',
        format: 'markdown',
        auto_reply: item.own ? null : { provider: 'elric', model: 'elric-1.0' },
      })),
      latest_seq: list.length,
      visible_from_seq: 0,
      next_since: list.length,
      has_more: false,
    });
  });
  return state;
}

test('chat history: newest first, switch, new chat keeps the old ones, rename and delete', async ({
  page,
}) => {
  await mockElric(page);
  const state = await mockConversations(page);
  await signIn(page);
  await page.goto('/elric');
  const side = page.getByRole('navigation', { name: 'Chats' });
  const chats = side.locator('.elx-side-chat');
  await expect(chats).toHaveText(['Weekly planning ideas', 'Older chat']);
  await expect(chats.first()).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('elric-reply')).toContainText('Three ideas for the week.');
  // Exactly one "New chat" control: the top bar's, none in the chats column.
  await expect(page.getByRole('button', { name: 'New chat' })).toHaveCount(1);
  await expect(page.locator('.elx-header').getByRole('button', { name: 'New chat' })).toHaveCount(
    1,
  );
  await expect(side.getByRole('button', { name: 'New chat' })).toHaveCount(0);
  // Inside the workspace, its own navigation leads back (Elric is the current page there), so
  // the chat list has no Workspace link of its own.
  await expect(side.getByRole('link', { name: 'Workspace' })).toHaveCount(0);
  const workspaceNav = page.getByRole('navigation', { name: 'Workspace' });
  await expect(workspaceNav.getByRole('button', { name: 'Elric' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(workspaceNav.getByRole('button', { name: 'Rooms' })).toBeVisible();

  // Switch to the older chat.
  await chats.nth(1).click();
  await expect(chats.nth(1)).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.elx-bubble')).toHaveText(['An older question']);

  // New chat keeps the others: a fresh composer, stored (and listed) with its first message.
  await page.getByRole('button', { name: 'New chat' }).click();
  await expect(chats).toHaveCount(2);
  await expect(side.locator('.elx-side-chat[aria-current="page"]')).toHaveCount(0);
  await expect(page.locator('.elx-chip')).toHaveCount(3);
  expect(state.created).toBe(0);
  await page.getByLabel('Message Elric').fill('Plan the launch');
  await page.keyboard.press('Enter');
  await expect(chats.first()).toHaveText('Plan the launch');
  await expect(chats.first()).toHaveAttribute('aria-current', 'page');

  // Rename and delete from the ⋯ menu, each as a sheet.
  await side.getByRole('button', { name: 'More for Older chat' }).click();
  await side.getByRole('menuitem', { name: 'Rename' }).click();
  const rename = page.getByRole('dialog', { name: 'Rename chat' });
  await expect(rename.getByLabel('Chat name')).toBeFocused();
  await rename.getByLabel('Chat name').fill('Archive notes');
  await rename.getByRole('button', { name: 'Save name' }).click();
  await expect(rename).toHaveCount(0);
  await expect(chats.nth(2)).toHaveText('Archive notes');
  // Focus is back on the chat's ⋯ button.
  await expect(side.getByRole('button', { name: 'More for Archive notes' })).toBeFocused();
  await side.getByRole('button', { name: 'More for Archive notes' }).click();
  await side.getByRole('menuitem', { name: 'Delete' }).click();
  await page
    .getByRole('alertdialog', { name: 'Delete this chat?' })
    .getByRole('button', { name: 'Delete' })
    .click();
  await expect(chats).toHaveText(['Plan the launch', 'Weekly planning ideas']);
  expect(state.list.map((item) => item.title)).toEqual([
    'Plan the launch',
    'Weekly planning ideas',
  ]);
});

test('the phone drawer: focus on the open chat, Escape closes, focus back on Chats', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockElric(page);
  await mockConversations(page);
  await signIn(page);
  await page.goto('/elric');
  const toggle = page.getByRole('button', { name: 'Chats' });
  const side = page.getByRole('navigation', { name: 'Chats' });
  await toggle.click();
  const open = side.getByRole('button', { name: 'Weekly planning ideas', exact: true });
  await expect(open).toBeFocused();
  // Tab stays inside the drawer: from the first item back to the last one shown, and on.
  await page.keyboard.press('Shift+Tab');
  await expect(side.getByRole('button', { name: 'More for Older chat' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(open).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(side).toBeHidden();
  await expect(toggle).toBeFocused();
});

test('chat history on a phone: a drawer from the header', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockElric(page);
  await mockConversations(page);
  await signIn(page);
  await page.goto('/elric');
  const side = page.getByRole('navigation', { name: 'Chats' });
  await expect(side).toBeHidden();
  await page.getByRole('button', { name: 'Chats' }).click();
  await expect(side).toBeVisible();
  await side.locator('.elx-side-chat').nth(1).click();
  await expect(side).toBeHidden();
  await expect(page.locator('.elx-bubble')).toHaveText(['An older question']);
  // New chat on a phone: one tap, from the top bar.
  await page.getByRole('button', { name: 'New chat' }).click();
  await expect(side).toBeHidden();
  await expect(page.locator('.elx-chip')).toHaveCount(3);
  // Back to the workspace from the keyboard: the drawer closes with Escape, and the workspace
  // navigation (its own drawer on a phone) leads to Rooms.
  await page.getByRole('button', { name: 'Chats' }).click();
  await expect(side).toBeVisible();
  await expect(side.getByRole('link', { name: 'Workspace' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(side).toBeHidden();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const rooms = page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', {
    name: 'Rooms',
  });
  await expect(rooms).toBeVisible();
  await rooms.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/rooms$/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('new chat: the first message creates the chat and goes to it, never the previous chat', async ({
  page,
}) => {
  await mockElric(page);
  const state = await mockConversations(page);
  await signIn(page);
  await page.goto('/elric');
  const side = page.getByRole('navigation', { name: 'Chats' });
  const chats = side.locator('.elx-side-chat');
  await expect(chats).toHaveText(['Weekly planning ideas', 'Older chat']);
  // A slow create: the message waits for the new chat.
  let created!: () => void;
  const answered = new Promise<void>((done) => (created = done));
  await page.route('**/api/elric/conversations', async (route) => {
    if (route.request().method() === 'POST') await answered;
    await route.fallback();
  });
  await page.getByRole('button', { name: 'New chat' }).click();
  await page.getByLabel('Message Elric').fill('Sent before the chat was ready');
  await page.keyboard.press('Enter');
  setTimeout(created, 300);
  await expect(chats.first()).toHaveText('Sent before the chat was ready');
  await expect(chats.first()).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.elx-bubble')).toHaveText(['Sent before the chat was ready']);
  await expect(page.getByLabel('Message Elric')).toHaveValue('');
  expect(state.rooms.get(CHAT)!.map((item) => item.text)).toEqual([
    '@Elric Ideas for the weekly planning?',
    'Three ideas for the week.',
  ]);
  expect(state.rooms.get('conv-new-1')!.map((item) => item.text)).toEqual([
    '@Elric Sent before the chat was ready',
  ]);
});

test('deleting the open chat leaves a fresh composer, never a stored empty chat', async ({
  page,
}) => {
  await mockElric(page);
  const state = await mockConversations(page);
  await signIn(page);
  await page.goto('/elric');
  const side = page.getByRole('navigation', { name: 'Chats' });
  const chats = side.locator('.elx-side-chat');
  for (const title of ['Weekly planning ideas', 'Older chat']) {
    await side.getByRole('button', { name: `More for ${title}` }).click();
    await side.getByRole('menuitem', { name: 'Delete' }).click();
    await page
      .getByRole('alertdialog', { name: 'Delete this chat?' })
      .getByRole('button', { name: 'Delete' })
      .click();
  }
  await expect(chats).toHaveCount(0);
  await expect(page.locator('.elx-chip')).toHaveCount(3);
  expect(state.created).toBe(0);
  expect(state.list).toEqual([]);
});

test('chat history: the short title replaces the first message after the reply, no reload', async ({
  page,
}) => {
  await mockElric(page);
  const state = await mockConversations(page);
  await signIn(page);
  await page.goto('/elric');
  const side = page.getByRole('navigation', { name: 'Chats' });
  const chats = side.locator('.elx-side-chat');
  await page.getByRole('button', { name: 'New chat' }).click();
  await page.getByLabel('Message Elric').fill('Which phone is better, iphone 12 or 16');
  await page.keyboard.press('Enter');
  await expect(chats.first()).toHaveText('Which phone is better, iphone 12 or 16');
  const box = await chats.first().boundingBox();
  // The server answers, then names the conversation a moment later.
  const item = state.list[0]!;
  const room = state.rooms.get(item.id)!;
  room.push({ seq: room.length + 1, own: false, text: 'The 16 is newer.' });
  item.latest = room.length;
  // Later than the first refresh after the reply: the sidebar keeps asking until it is there.
  setTimeout(() => {
    item.title = 'Compare iPhone 12 and 16';
    item.source = 'auto';
  }, 3_000);
  await expect(page.getByTestId('elric-reply')).toContainText('The 16 is newer.');
  await expect(chats.first()).toHaveText('Compare iPhone 12 and 16', { timeout: 15_000 });
  // Same row, same place: no layout jump.
  expect((await chats.first().boundingBox())?.y).toBe(box?.y);
  await expect(side).not.toContainText('elric-1.0');
});

for (const viewport of [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: '390 px drawer', width: 390, height: 844 },
])
  test(`chat history: a long title ellipsizes and every chat keeps its More button in view (${viewport.name})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await mockElric(page);
    const state = await mockConversations(page);
    state.list[1]!.title = 'A very long chat title that goes on and on well past the sidebar edge';
    await signIn(page);
    await page.goto('/elric');
    const side = page.getByRole('navigation', { name: 'Chats' });
    if (viewport.width < 900) await page.getByRole('button', { name: 'Chats' }).click();
    await expect(side.locator('.elx-side-chat')).toHaveCount(2);
    // The drawer has slid in fully, to the left edge of the Elric page (beside the workspace
    // navigation on a wide screen).
    const start = await page
      .locator('.elx')
      .evaluate((element) => element.getBoundingClientRect().left);
    await expect.poll(() => side.evaluate((nav) => nav.getBoundingClientRect().left)).toBe(start);
    const edge = await side.evaluate((nav) => nav.getBoundingClientRect().right);
    for (const more of await side.getByRole('button', { name: /^More for / }).all()) {
      const box = (await more.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(edge + 0.5);
    }
    // Nothing in the list is wider than the sidebar (no sideways scroll inside it).
    expect(await side.evaluate((nav) => nav.scrollWidth <= nav.clientWidth)).toBe(true);
    const long = side.locator('.elx-side-chat').nth(1);
    expect(await long.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  });

/**
 * Every visible control inside Elric's page that is under 44px on either side. A switch is
 * left out: its whole row (the label) is its 44px target, as Manage Elric's test checks.
 */
async function smallTargets(page: Page) {
  return page.locator('.elx3').evaluate((root) =>
    Array.from(
      root.querySelectorAll<HTMLElement>(
        'button:not([role="switch"]), a[href], [role="button"], select',
      ),
    )
      .filter((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return box.width > 0 && box.height > 0 && style.visibility !== 'hidden';
      })
      .map((element) => {
        const box = element.getBoundingClientRect();
        return {
          name:
            element.getAttribute('aria-label') || element.textContent?.trim() || element.tagName,
          width: Math.round(box.width * 10) / 10,
          height: Math.round(box.height * 10) / 10,
        };
      })
      .filter((target) => target.width < 44 || target.height < 44),
  );
}

test('phone: one top bar (the shell row steps aside, Elric’s bar carries ☰) and 44px targets', async ({
  page,
}) => {
  // Sheets settle in without their scale-in, so they are measured at rest.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await mockElric(page, { pending: true });
  await mockConversations(page);
  await signIn(page);
  await page.goto('/elric');
  await page.getByRole('button', { name: 'New chat' }).click();
  await expect(page.getByRole('heading', { name: 'What can I help with?' })).toBeVisible();
  // One row: the shell's ☰ row is hidden and Elric's bar is the only header at the top.
  await expect(page.locator('header.cc-app-header')).toBeHidden();
  const bar = page.locator('.elx-header');
  const menu = bar.getByRole('button', { name: 'Open navigation', exact: true });
  await expect(menu).toBeVisible();
  const box = (await bar.boundingBox())!;
  expect(box.y).toBe(0);
  expect(box.height).toBeLessThanOrEqual(64);
  // The chips sit on that one row.
  const top = (await menu.boundingBox())!.y;
  for (const name of ['Chats', 'Manage Elric', 'New chat'])
    expect((await bar.getByRole('button', { name }).boundingBox())!.y).toBe(top);
  // Home (with an approval waiting) and the composer: every control is 44px and up.
  await expect(page.locator('.elx3-approve-pill')).toBeVisible();
  expect(await smallTargets(page)).toEqual([]);
  // Manage Elric and the about sheet, with their close buttons.
  await bar.getByRole('button', { name: 'Manage Elric' }).click();
  await expect(page.getByRole('dialog', { name: 'Manage Elric' })).toBeVisible();
  expect(await smallTargets(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await bar.getByRole('button', { name: 'Elric', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await smallTargets(page)).toEqual([]);
  await page.keyboard.press('Escape');
  // The composer with a draft, then the action card the approval pill opens.
  await page.getByLabel('Message Elric').fill('Hello');
  expect(await smallTargets(page)).toEqual([]);
  await page.locator('.elx3-approve-pill').getByRole('button', { name: 'Review' }).click();
  await expect(page.getByTestId('elric-pending')).toBeVisible();
  expect(await smallTargets(page)).toEqual([]);
  // The workspace menu stays one tap away.
  await menu.click();
  await expect(
    page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Rooms' }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('wide screen: the shell has no top row and Elric’s bar has no ☰', async ({ page }) => {
  await mockElric(page);
  await signIn(page);
  await page.goto('/elric');
  await expect(page.getByRole('heading', { name: 'What can I help with?' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open navigation', exact: true })).toHaveCount(0);
  await expect(page.locator('.elx-header .elx3-menu')).toBeHidden();
});

test('first visit: the welcome orb is 72px; Home keeps its 52px orb', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockElric(page);
  await mockFirstVisit(page, null);
  await signIn(page);
  await page.goto('/elric');
  await expect(page.getByRole('heading', { name: 'Meet Elric' })).toBeVisible();
  // One top bar on the first visit too.
  await expect(page.locator('header.cc-app-header')).toBeHidden();
  const orb = (await page.locator('.elx3-gate .elx3-mark-orb').boundingBox())!;
  expect(orb.width).toBeCloseTo(72, 1);
  expect(orb.height).toBeCloseTo(72, 1);
  await page.getByRole('button', { name: 'Start chatting' }).click();
  await expect(page.getByRole('heading', { name: 'What can I help with?' })).toBeVisible();
  const home = (await page.locator('.elx3-home .elx3-mark-orb').boundingBox())!;
  expect(home.width).toBeCloseTo(52, 1);
  expect(home.height).toBeCloseTo(52, 1);
});

for (const theme of ['light', 'dark'] as const)
  test(`Send (${theme}): the accent fill with a white arrow, faded while disabled`, async ({
    page,
  }) => {
    await page.addInitScript((value) => localStorage.setItem('cc-theme', value), theme);
    await mockElric(page);
    await signIn(page);
    await page.goto('/elric');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const send = page.getByRole('button', { name: 'Send' });
    await expect(send).toBeDisabled();
    const accent = await page.locator('.elx3').evaluate((root) => {
      const probe = document.createElement('i');
      probe.style.color = getComputedStyle(root).getPropertyValue('--accent');
      root.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    const look = () =>
      send.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          opacity: Number(style.opacity),
          background: style.backgroundColor,
          color: style.color,
        };
      });
    await expect.poll(async () => (await look()).opacity).toBeLessThan(1);
    expect(await look()).toMatchObject({ background: accent, color: 'rgb(255, 255, 255)' });
    await page.getByLabel('Message Elric').fill('Hello');
    await expect(send).toBeEnabled();
    await page.mouse.move(0, 0);
    await expect.poll(async () => (await look()).opacity).toBe(1);
    expect(await look()).toMatchObject({ background: accent, color: 'rgb(255, 255, 255)' });
  });

test('opened from the navigation, the chat area lines up with the chats column as after a reload', async ({
  page,
}) => {
  // dashboard.css's pre-v3 has-side offsets used to win when its file loaded after elric-v3.css
  // (in-app navigation), shifting the page right by the column's width until a reload.
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockElric(page);
  await page.route('**/api/elric/conversations**', (route) =>
    route.fulfill({ json: { conversations: [] } }),
  );
  await signIn(page);
  const edges = async () => {
    await expect(page.getByRole('heading', { name: 'What can I help with?' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Chats' })).toBeVisible();
    return page.evaluate(() => {
      const right = (selector: string) =>
        Math.round(document.querySelector(selector)!.getBoundingClientRect().right);
      const left = (selector: string) =>
        Math.round(document.querySelector(selector)!.getBoundingClientRect().left);
      return {
        side: right('.elx3 .elx-side'),
        main: left('.elx3 .elx-main'),
        dock: left('.elx3 .elx-dock'),
        dockRight: right('.elx3 .elx-dock'),
        width: window.innerWidth,
      };
    });
  };
  await page.goto('/?workspace=v2#connect');
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('button', { name: 'Elric' })
    .click();
  const opened = await edges();
  expect(opened.main).toBe(opened.side);
  expect(opened.dock).toBe(opened.side);
  expect(opened.dockRight).toBeLessThanOrEqual(opened.width);
  await page.reload();
  expect(await edges()).toEqual(opened);
});
