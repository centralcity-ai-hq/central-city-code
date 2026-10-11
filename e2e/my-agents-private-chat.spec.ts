import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Agent, Snapshot } from '../shared/types';
import { workspaceScale } from './workspace-density';

/*
 * "Message <agent>" in My agents (the v4 pane): the private chat with one of your own agents. The
 * button opens the room (POST /api/rooms/private-agent, created on the first open) and lands on
 * its page; the agent's inbox stays on the Messages row. The agents, the route's answers and the
 * room are synthetic fixtures served through page.route (the e2e server has no such route yet);
 * the room's shapes are those of the real routes. MY_AGENTS_SHOTS=<dir> saves screenshots there.
 */

const headers = { 'X-City-Request': '1' };
const password = 'Local-test-only-passphrase-2026';
const at = '2026-10-03T12:00:00.000Z';
const ROUTE = '**/api/rooms/private-agent';

function agent(id: string, name: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name,
    description: 'Synthetic fixture',
    capability: 'research',
    mode: 'external',
    isDemo: false,
    status: 'online',
    lastSeenAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    createdAt: at,
    revokedAt: null,
    ...overrides,
  };
}

const scout = agent('11111111-1111-4111-8111-111111111111', 'Research scout');
const held = agent('33333333-3333-4333-8333-333333333333', 'Held reviewer', { pausedAt: at });
const gone = agent('55555555-5555-4555-8555-555555555555', 'Retired agent', {
  status: 'revoked',
  revokedAt: at,
});
const lengthy = agent(
  '66666666-6666-4666-8666-666666666666',
  'Quarterly market research and competitor pricing summary writer',
);

/** The room the route answers with (one per agent), as GET /api/rooms lists it for the host. */
function privateRoom(who: Agent) {
  return {
    id: `cccccccc-0000-4000-8000-${who.id.slice(-12)}`,
    slug: `chat-${who.id.slice(0, 12)}`,
    name: who.name,
    topic: '',
    role: 'host',
    closed: false,
    read_only: false,
    history: 'full',
    member_count: 2,
    member_cap: 2,
    latest_seq: 0,
    created_at: at,
    people_may_join: false,
    members_may_bring_ai: false,
    responders_allowed: true,
    // The owner's room view names the chat's agent (GET /api/rooms, the room's reads).
    private_agent_id: who.id,
  };
}

/** GET /api/agents/:id/answering: can the agent answer now (Auto-reply or its runtime). */
const canAnswer = (id: string) => ({
  agent_id: id,
  can: true,
  by: 'runtime',
  auto_reply: 'none',
  runtime_connected: true,
});
const cannotAnswer = (id: string, autoReply: 'none' | 'off' | 'paused' = 'none') => ({
  agent_id: id,
  can: false,
  by: null,
  auto_reply: autoReply,
  runtime_connected: false,
});

type Answer = { status: number; body?: unknown } | 'room';

/**
 * Signs up, serves the agents, and answers the private-chat route with `answers` in turn (then
 * with the room). `hold` keeps every answer back until it resolves. Returns the calls it saw.
 */
async function fixture(
  page: Page,
  options: {
    answers?: Answer[];
    hold?: Promise<void>;
    paused?: boolean;
    /** The answering route's answer for an agent (default: it can answer), or a status. */
    answering?: (id: string) => unknown;
    /** More agents in the workspace, after the usual ones. */
    extra?: Agent[];
  } = {},
) {
  const registered = await page.request.post('/api/auth/register', {
    headers,
    data: { name: `Private-chat-${randomUUID().slice(0, 8)}`, password },
  });
  expect(registered.status()).toBe(201);
  const baseline = (await (await page.request.get('/api/snapshot')).json()) as Snapshot;
  const snapshot: Snapshot = {
    ...baseline,
    agents: [scout, held, lengthy, gone, ...(options.extra ?? [])],
  };
  const calls: Array<{ method: string; body: unknown }> = [];
  const opened = new Set<Agent>();
  const answers = [...(options.answers ?? [])];
  await page.route('**/api/events*', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }));
  await page.route('**/api/agents/*/answering', (route) => {
    const id = new URL(route.request().url()).pathname.split('/')[3]!;
    const answer = (options.answering ?? canAnswer)(id);
    return typeof answer === 'number'
      ? route.fulfill({ status: answer, json: { error: 'Not found.' } })
      : route.fulfill({ json: answer });
  });
  // Remove (POST /api/agents/:id/revoke): the next snapshot has the agent removed.
  await page.route('**/api/agents/*/revoke', (route) => {
    const id = new URL(route.request().url()).pathname.split('/')[3];
    snapshot.agents = snapshot.agents.map((item) =>
      item.id === id ? { ...item, status: 'revoked', revokedAt: at } : item,
    );
    return route.fulfill({ json: { ok: true } });
  });
  await page.route(ROUTE, async (route) => {
    const request = route.request();
    const body = request.postDataJSON() as { agent_id: string };
    calls.push({ method: request.method(), body });
    await options.hold;
    const answer = answers.shift() ?? 'room';
    if (answer !== 'room') return route.fulfill({ status: answer.status, json: answer.body ?? {} });
    const who = snapshot.agents.find((item) => item.id === body.agent_id)!;
    const room = privateRoom(who);
    const created = !opened.has(who);
    opened.add(who);
    return route.fulfill({
      json: {
        room_id: room.id,
        slug: room.slug,
        person_member_id: 'person-0001',
        agent_id: who.id,
        status: who.pausedAt ? 'paused' : 'active',
        latest_seq: 0,
        created,
      },
    });
  });
  // The room's page: the list (the private room once opened), its messages and its two members.
  await page.route('**/api/rooms', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { rooms: [...opened].map(privateRoom) } })
      : route.fallback(),
  );
  const roomOf = (route: Route) => {
    const id = new URL(route.request().url()).pathname.split('/')[3]!;
    return [...opened].map(privateRoom).find((room) => room.id === id);
  };
  await page.route('**/api/rooms/*/messages*', (route) => {
    const room = roomOf(route);
    if (!room) return route.fallback();
    return route.fulfill({
      json: {
        room,
        messages: [],
        latest_seq: 0,
        visible_from_seq: 0,
        next_since: 0,
        has_more: false,
      },
    });
  });
  await page.route('**/api/rooms/*/members*', (route) => {
    const room = roomOf(route);
    if (!room) return route.fallback();
    const who = snapshot.agents.find((item) => item.name === room.name)!;
    const base = { owner_label: 'You', own: true, joined_at: at, status: 'active' };
    return route.fulfill({
      json: {
        room_id: room.id,
        members: [
          { ...base, id: 'person-0001', name: 'You', kind: 'person', role: 'host' },
          { ...base, id: who.id, name: who.name, kind: 'agent', role: 'member' },
        ],
      },
    });
  });
  return calls;
}

async function openMyAgents(page: Page, theme = 'light') {
  await page.goto(`/?workspace=v2&theme=${theme}#connect`);
  await expect(page.locator('.app-shell')).toBeVisible();
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole('navigation', { name: 'Workspace', exact: true })
    .getByRole('button', { name: /^My agents/ })
    .first()
    .click();
  const region = page.getByRole('region', { name: 'Agents', exact: true });
  await expect(region).toBeVisible();
  const rows = region.getByRole('list', { name: 'Agents', exact: true }).getByRole('listitem');
  await expect(rows.filter({ hasText: 'Research scout' })).toHaveCount(1);
  return { region, rows };
}

/** Opens one agent's pane from its row. */
async function openAgent(page: Page, who: Agent) {
  await page
    .getByRole('list', { name: 'Agents', exact: true })
    .getByRole('button', { name: new RegExp(`^${who.name}, `) })
    .click();
  const panel = page.getByRole('complementary', { name: `${who.name} details` });
  await expect(panel.getByRole('heading', { level: 2, name: who.name })).toBeVisible();
  return panel;
}

async function shot(page: Page, name: string) {
  const dir = process.env.MY_AGENTS_SHOTS;
  await page.screenshot({
    path: dir ? `${dir}/private-chat-${name}.png` : test.info().outputPath(`${name}.png`),
  });
}

const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

/** The room's page for `who`, with its name on top. */
async function expectRoomPage(page: Page, who: Agent) {
  await expect(page).toHaveURL(new RegExp(`/rooms/${privateRoom(who).id}$`));
  await expect(page.getByRole('heading', { level: 1, name: who.name })).toBeVisible();
}

const views = [
  { width: 1440, height: 900, theme: 'light' },
  { width: 1440, height: 900, theme: 'dark' },
  { width: 390, height: 844, theme: 'light' },
  { width: 390, height: 844, theme: 'dark' },
];

for (const view of views)
  test(`Message <name> opens the private chat on its room's page at ${view.width}px ${view.theme}`, async ({
    page,
  }) => {
    await page.setViewportSize(view);
    const calls = await fixture(page);
    await openMyAgents(page, view.theme);
    const panel = await openAgent(page, scout);
    const button = panel.getByRole('button', { name: 'Message Research scout', exact: true });
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('title', 'Message Research scout');
    // The size of the pane's buttons: 34 workspace px, 44 px on a phone.
    const { height } = (await button.boundingBox())!;
    if (view.width <= 640) expect(Math.round(height)).toBe(44);
    else expect(Math.abs(height - 34 * workspaceScale(view.width))).toBeLessThanOrEqual(1);
    expect(await noSidewaysScroll(page)).toBe(true);
    await shot(page, `pane-${view.width}-${view.theme}`);
    await button.click();
    await expectRoomPage(page, scout);
    expect(calls).toEqual([{ method: 'POST', body: { agent_id: scout.id } }]);
    expect(await noSidewaysScroll(page)).toBe(true);
    await shot(page, `room-${view.width}-${view.theme}`);
  });

test('a double click opens the chat once; the button says Opening… meanwhile', async ({ page }) => {
  let release = () => {};
  const hold = new Promise<void>((resolve) => (release = resolve));
  const calls = await fixture(page, { hold });
  await openMyAgents(page);
  const panel = await openAgent(page, scout);
  const button = panel.locator('[data-k="message"]');
  await button.dblclick();
  await expect(button).toHaveText('Opening…');
  await expect(button).toHaveAttribute('aria-busy', 'true');
  await expect(button).toBeDisabled();
  // Focus stays on it while it opens; a third click does nothing either.
  await expect(button).toBeFocused();
  await button.dispatchEvent('click');
  release();
  await expectRoomPage(page, scout);
  expect(calls).toHaveLength(1);
});

test('after a failure Try again opens the chat; both tries ask for the same agent', async ({
  page,
}) => {
  const calls = await fixture(page, { answers: [{ status: 503 }] });
  await openMyAgents(page);
  const panel = await openAgent(page, scout);
  const button = panel.getByRole('button', { name: 'Message Research scout', exact: true });
  await button.click();
  await expect(panel.getByRole('alert')).toHaveText("Couldn't open the chat. Try again.");
  // The button is back; Try again sits under the actions with the error.
  await expect(button).toBeEnabled();
  await expect(button).toBeFocused();
  await shot(page, 'error');
  await panel.getByRole('button', { name: 'Try again', exact: true }).click();
  await expectRoomPage(page, scout);
  expect(calls).toEqual([
    { method: 'POST', body: { agent_id: scout.id } },
    { method: 'POST', body: { agent_id: scout.id } },
  ]);
});

test('a paused agent says so quietly; its chat still opens', async ({ page }) => {
  const calls = await fixture(page);
  await openMyAgents(page);
  const panel = await openAgent(page, held);
  await expect(panel).toContainText('Held reviewer is paused. It answers after you resume.');
  await shot(page, 'paused');
  const button = panel.getByRole('button', { name: 'Message Held reviewer', exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expectRoomPage(page, held);
  expect(calls).toEqual([{ method: 'POST', body: { agent_id: held.id } }]);
});

test('a paused agent without a chat yet: the refusal says to resume it first', async ({ page }) => {
  await fixture(page, {
    answers: [{ status: 409, body: { error: 'Held reviewer is paused.', code: 'agent_paused' } }],
  });
  await openMyAgents(page);
  const panel = await openAgent(page, held);
  await panel.getByRole('button', { name: 'Message Held reviewer', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveText(
    'Held reviewer is paused. Resume it to start a chat.',
  );
  // Said once: the quiet paused note steps aside while the error shows.
  await expect(panel).not.toContainText('It answers after you resume.');
  await expect(page).not.toHaveURL(/\/rooms\//);
});

test('an agent that is not yours (404) says so, in plain words', async ({ page }) => {
  await fixture(page, {
    answers: [{ status: 404, body: { error: 'Agent not found.', code: 'agent_not_found' } }],
  });
  await openMyAgents(page);
  const panel = await openAgent(page, scout);
  await panel.getByRole('button', { name: 'Message Research scout', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveText("This agent isn't yours, or it was removed.");
});

test('a removed agent has no Message button', async ({ page }) => {
  const calls = await fixture(page);
  const { rows } = await openMyAgents(page);
  // A removed agent's row doesn't open; one removed while open keeps its pane, without actions.
  await expect(rows.filter({ hasText: 'Retired agent' }).getByRole('button')).toHaveCount(0);
  const panel = await openAgent(page, scout);
  await expect(panel.getByRole('button', { name: 'Message Research scout' })).toBeVisible();
  await panel.getByRole('button', { name: 'More for Research scout' }).click();
  await panel.getByRole('menuitem', { name: 'Remove agent' }).click();
  await panel
    .getByRole('textbox', { name: 'Type Research scout to confirm' })
    .fill('Research scout');
  await panel.getByRole('button', { name: 'Remove agent', exact: true }).click();
  await expect(page.getByText('Research scout was removed.')).toBeVisible();
  await expect(panel).toContainText('Removed ·');
  await expect(panel.getByRole('button', { name: /^(Message |Opening)/ })).toHaveCount(0);
  await expect(panel.locator('[data-k="message"]')).toHaveCount(0);
  await expect(panel).not.toContainText('Try again');
  expect(calls).toEqual([]);
});

test("the agent's inbox stays on the Messages row", async ({ page }) => {
  const calls = await fixture(page);
  await openMyAgents(page);
  const panel = await openAgent(page, scout);
  await panel.getByRole('button', { name: /^Messages/ }).click();
  await expect(panel.getByRole('heading', { name: 'Messages', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel.getByRole('button', { name: /^Messages/ })).toBeFocused();
  expect(calls).toEqual([]);
});

for (const view of views.filter((item) => item.width <= 640))
  test(`a long name ends in an ellipsis at ${view.width}px ${view.theme}; nothing scrolls sideways`, async ({
    page,
  }) => {
    await page.setViewportSize(view);
    await fixture(page);
    await openMyAgents(page, view.theme);
    const panel = await openAgent(page, lengthy);
    const button = panel.getByRole('button', { name: `Message ${lengthy.name}`, exact: true });
    await expect(button).toHaveAttribute('title', `Message ${lengthy.name}`);
    expect(Math.round((await button.boundingBox())!.height)).toBe(44);
    // The label is cut short, not the row: Pause and ⋯ stay whole and on screen.
    const label = button.locator('.ap4-label');
    expect(await label.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    for (const other of [
      panel.getByRole('button', { name: 'Pause', exact: true }),
      panel.getByRole('button', { name: `More for ${lengthy.name}` }),
    ]) {
      const box = (await other.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(view.width);
      expect(Math.round(box.height)).toBe(44);
    }
    expect(await noSidewaysScroll(page)).toBe(true);
    await shot(page, `long-name-${view.width}-${view.theme}`);
  });

/** The pane's Auto-reply row, found by its whole accessible name (label, hint, action/value). */
const autoReplyRow = (panel: Locator, name: string) =>
  panel.getByRole('button', { name, exact: true });

test("an agent that can't answer says so on its Auto-reply row; Set up opens its Auto-reply", async ({
  page,
}) => {
  await fixture(page, { answering: (id) => (id === scout.id ? cannotAnswer(id) : canAnswer(id)) });
  await openMyAgents(page);
  const panel = await openAgent(page, scout);
  const row = autoReplyRow(panel, "Auto-reply, Research scout can't reply yet, Set up");
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-tone', 'off');
  await expect(row.locator('.ap4-hint')).toHaveText("Research scout can't reply yet");
  await expect(row.locator('.ap4-act')).toHaveText('Set up');
  await expect(row.locator('.ap4-dot')).toHaveCSS('background-color', 'rgb(224, 163, 46)');
  // No loose line under the header buttons any more, and no button inside the row.
  await expect(panel.locator('[data-k="cant-answer"]')).toHaveCount(0);
  await expect(row.locator('button')).toHaveCount(0);
  await shot(page, 'cant-answer-pane');
  await row.click();
  await expect(panel.getByRole('heading', { name: 'Auto-reply' }).first()).toBeVisible();
});

test('the Auto-reply row: paused, replies through an AI app, replies with a model, or plain when unknown', async ({
  page,
}) => {
  const answers: Record<string, unknown> = {
    [scout.id]: cannotAnswer(scout.id, 'paused'),
    [lengthy.id]: 404,
  };
  await fixture(page, { answering: (id) => answers[id] ?? canAnswer(id) });
  await page.route('**/api/responder/models**', (route) =>
    route.fulfill({
      json: {
        models: [
          {
            provider: 'anthropic',
            id: 'fixture-model',
            name: 'Fixture Model',
            est_cost_per_reply_usd: 0.01,
            default: true,
          },
        ],
      },
    }),
  );
  await page.route('**/api/agents/*/responder', (route) =>
    route.fulfill({
      json: {
        agent_id: new URL(route.request().url()).pathname.split('/')[3],
        enabled: true,
        status: 'active',
        pause_reason: null,
        paused_until: null,
        provider: 'anthropic',
        model: 'fixture-model',
        instructions: '',
        daily_reply_cap: 100,
        daily_spend_cap_usd: 2,
        key: null,
        replies_available: true,
      },
    }),
  );
  await openMyAgents(page);
  let panel = await openAgent(page, scout);
  // Auto-reply paused: grey dot, Resume (the row only opens the screen).
  let row = autoReplyRow(panel, "Auto-reply, Research scout won't reply, Resume");
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-tone', 'paused');
  await expect(row.locator('.ap4-dot')).toHaveCSS('background-color', 'rgb(154, 166, 184)');
  await expect(panel.locator('[data-k="cant-answer"]')).toHaveCount(0);
  // It answers through its connected AI app: green dot, Auto-reply Off.
  answers[scout.id] = canAnswer(scout.id);
  await page.reload();
  await openMyAgents(page);
  panel = await openAgent(page, scout);
  row = autoReplyRow(panel, 'Auto-reply, Research scout replies through an AI app, Off');
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-tone', 'on');
  await expect(row.locator('.ap4-dot')).toHaveCSS('background-color', 'rgb(29, 158, 117)');
  await expect(row.locator('.ap4-v')).toHaveText('Off');
  // It answers through Auto-reply: the model's name from its settings, On.
  answers[scout.id] = {
    agent_id: scout.id,
    can: true,
    by: 'auto_reply',
    auto_reply: 'on',
    runtime_connected: false,
  };
  await page.reload();
  await openMyAgents(page);
  panel = await openAgent(page, scout);
  row = autoReplyRow(panel, 'Auto-reply, Research scout replies with Fixture Model, On');
  await expect(row).toBeVisible();
  await expect(row.locator('.ap4-hint')).toHaveText('Research scout replies with Fixture Model');
  // The route isn't there (404): the plain row, nothing guessed.
  panel = await openAgent(page, lengthy);
  row = autoReplyRow(panel, 'Auto-reply');
  await expect(row).toBeVisible();
  await expect(row.locator('.ap4-dot')).toHaveCount(0);
  await expect(row.locator('.ap4-hint')).toHaveCount(0);
});

test("in the private chat, an agent that can't answer says so above the composer and links to its Auto-reply", async ({
  page,
}) => {
  await fixture(page, { answering: (id) => (id === scout.id ? cannotAnswer(id) : canAnswer(id)) });
  await openMyAgents(page);
  const panel = await openAgent(page, scout);
  await panel.getByRole('button', { name: 'Message Research scout', exact: true }).click();
  await expectRoomPage(page, scout);
  const hint = page.getByTestId('cant-answer');
  await expect(hint).toContainText("Research scout can't answer yet.");
  await expect(hint).toHaveCSS('opacity', '1');
  expect(await noSidewaysScroll(page)).toBe(true);
  await shot(page, 'cant-answer-room');
  await hint.getByRole('link', { name: 'Set up Auto-reply', exact: true }).click();
  // /agents is My agents, shown at "/" like every console view; the link is cleaned once opened.
  await expect(page).toHaveURL(/\/$/);
  const again = page.getByRole('complementary', { name: 'Research scout details' });
  await expect(again.getByRole('heading', { name: 'Auto-reply' }).first()).toBeVisible();
});

/*
 * Regression (live, 11 Oct): a CC agent (hosted, scripted, no AI model; the host New room makes)
 * has a live heartbeat from its scripted runtime, which never answers. The route answered can:true
 * by:'runtime' for it, so nothing said it can't answer. It now answers this exact shape: the pane
 * and the private chat say it can't answer yet, like for any agent without Auto-reply or an AI.
 */
test("a CC agent whose scripted runtime is up can't answer: its pane and private chat say so", async ({
  page,
}) => {
  const lion = agent('77777777-7777-4777-8777-777777777777', 'Lion', {
    mode: 'hosted',
    isDemo: true,
  });
  await fixture(page, {
    extra: [lion],
    answering: (id) =>
      id === lion.id
        ? {
            agent_id: id,
            can: false,
            by: null,
            auto_reply: 'none',
            runtime_connected: true,
            scripted: true,
          }
        : canAnswer(id),
  });
  await openMyAgents(page);
  const panel = await openAgent(page, lion);
  await expect(autoReplyRow(panel, "Auto-reply, Lion can't reply yet, Set up")).toBeVisible();
  await panel.getByRole('button', { name: 'Message Lion', exact: true }).click();
  await expectRoomPage(page, lion);
  const hint = page.getByTestId('cant-answer');
  await expect(hint).toContainText("Lion can't answer yet.");
  await expect(hint.getByRole('link', { name: 'Set up Auto-reply', exact: true })).toHaveAttribute(
    'href',
    `/agents#agent=${lion.id}:autoreply`,
  );
});

test('the private chat offers nothing that would share or end it, and says who is in it', async ({
  page,
}) => {
  await fixture(page);
  await openMyAgents(page);
  const panel = await openAgent(page, scout);
  await panel.getByRole('button', { name: 'Message Research scout', exact: true }).click();
  await expectRoomPage(page, scout);
  await expect(page.locator('.rm-empty')).toContainText(
    'Only you and Research scout are in this chat.',
  );
  await expect(page.getByRole('button', { name: 'Invite', exact: true })).toHaveCount(0);
  // You write as yourself only: the agent answers for itself, so there is no Post as.
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  await expect(page.locator('.rm3-postas')).toHaveCount(0);
  await page
    .getByRole('button', { name: /More room actions|More/ })
    .first()
    .click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  for (const item of ['Room settings', 'Connect AI', 'Invite your AI', 'End or delete room'])
    await expect(menu.getByRole('menuitem', { name: item })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: /Mute this room/ })).toHaveCount(1);
  await shot(page, 'private-chat-clean');
});
