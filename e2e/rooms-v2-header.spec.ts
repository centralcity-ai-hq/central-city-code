import {
  test,
  expect,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

/*
 * Smart Rooms v2 (preview), slices L1 and L2: the room header (title, honest counts, the
 * room pill that opens Members with its AIs-active line, Tasks, the host's Needs-you chip) and the
 * Members panel's clean roster.
 *
 * The overview, Needs-you, `says` and mute-all routes come from separate server changes, so this
 * spec mocks them with page.route. The member list is the real one with outside AIs appended
 * (their messages_today and says), so the panel has active AIs to show.
 */
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'x-city-request': '1' };

async function patient(call: () => Promise<APIResponse>): Promise<APIResponse> {
  for (let attempt = 0; ; attempt++) {
    const response = await call();
    if (response.status() !== 429 || attempt >= 6) return response;
    const wait = Number(response.headers()['retry-after'] ?? '5');
    await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(wait, 1), 20) * 1000));
  }
}
const why = async (response: APIResponse) =>
  `${response.status()} ${(await response.text()).slice(0, 300)}`;

const opened: BrowserContext[] = [];
test.afterEach(async () => {
  // Routes first, so a members request still in flight doesn't outlive its context.
  for (const context of opened)
    await Promise.all(context.pages().map((page) => page.unrouteAll({ behavior: 'ignoreErrors' })));
  await Promise.all(opened.splice(0).map((context) => context.close()));
});

const ROOM_NAME = 'Design System and UI review for the smart rooms upgrade';

/** The live line in the room pill: "1 AI active", "6 AIs active" (the active-now rule). */
const live = (count: number) => `${count} ${count === 1 ? 'AI' : 'AIs'} active`;
/** The room pill's tooltip and description: the whole counts line and what "active" covers. */
const ACTIVE_HINT = 'AIs connected to this room now';

/** Opens Members from the room pill (the top bar's only Members control; roster only since v3). */
async function openMembers(page: Page) {
  await page.getByTestId('room-pill').click();
  const members = page.getByRole('complementary', { name: 'Members' });
  await expect(members).toBeVisible();
  return members;
}

/** Opens the Room settings sheet (More room actions → Room settings). */
async function openRoomSettings(page: Page) {
  await page.locator('.rm-room-head').getByRole('button', { name: 'More room actions' }).click();
  await page.getByRole('menuitem', { name: 'Room settings', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Room settings' });
  await expect(sheet).toBeVisible();
  return sheet;
}

async function roomHost(browser: Browser, theme: 'light' | 'dark' = 'light') {
  const context = await browser.newContext();
  opened.push(context);
  // The preview flag and the theme, as a visitor who picked them earlier would have them.
  await context.addInitScript((value) => {
    localStorage.setItem('cc-rooms-v2', 'v2');
    localStorage.setItem('cc-theme', value);
  }, theme);
  const request = context.request;
  const created = await patient(() =>
    request.post('/api/auth/register', {
      headers,
      data: { name: `Head-${crypto.randomUUID().slice(0, 8)}`, password: PASSWORD },
    }),
  );
  expect(created.status(), await why(created)).toBe(201);
  const agent = await patient(() =>
    request.post('/api/agents', {
      headers,
      data: { name: 'Host agent', capability: 'research', mode: 'external' },
    }),
  );
  expect(agent.ok(), await why(agent)).toBeTruthy();
  const agentId = (await agent.json()).agent.id as string;
  const room = await patient(() =>
    request.post('/api/rooms', {
      headers,
      data: { agent_id: agentId, name: ROOM_NAME, idempotency_key: crypto.randomUUID() },
    }),
  );
  expect(room.status(), await why(room)).toBe(201);
  return { context, agentId, room: (await room.json()).room as { id: string } };
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const says = (text: string) => ({
  text,
  eta: null,
  set_at: minutesAgo(1),
  expires_at: new Date(Date.now() + 20 * 60_000).toISOString(),
  self_reported: true,
});
// Times sit mid-minute: the list may be fetched again after the panel read the clock.
const outsideAis = () => [
  {
    id: 'ai-sonnet',
    name: 'Sonnet Scout',
    kind: 'agent',
    role: 'member',
    owner_label: 'Maya',
    own: false,
    joined_at: minutesAgo(300),
    status: 'active',
    last_active_at: minutesAgo(2.5),
    messages_today: 14,
    says: says('running <b>test</b> harness'),
  },
  {
    id: 'ai-gpt',
    name: 'GPT Helper',
    kind: 'agent',
    role: 'member',
    owner_label: 'Omar',
    own: false,
    joined_at: minutesAgo(300),
    status: 'active',
    last_active_at: minutesAgo(9.5),
    messages_today: 3,
    says: null,
  },
  {
    id: 'ai-sleepy',
    name: 'Sleepy Bot',
    kind: 'agent',
    role: 'member',
    owner_label: 'Lee',
    own: false,
    joined_at: minutesAgo(300),
    status: 'idle',
    last_active_at: minutesAgo(40),
    messages_today: 0,
    says: null,
  },
];
const OVERVIEW = {
  members: { total: 10_500, people: 10_480, ais: 20, ais_active_15m: 6 },
  tasks: { open: 3, claimed: 3, in_review: 1, done: 2 },
  unread: { messages: null, mentions: 0, mentions_capped: false },
  latest_seq: 1,
  as_of: new Date().toISOString(),
};
const NEEDS_YOU = [
  {
    kind: 'task_to_review',
    id: 'task-7',
    since: minutesAgo(30),
    task: { id: 'task-7', number: 7, title: 'Header fits at 360 px', status: 'in_review' },
  },
  {
    kind: 'mention',
    id: 'ai-sonnet:1',
    since: minutesAgo(5),
    agent_id: 'x',
    message_seq: 1,
    from_name: 'Sonnet Scout',
    excerpt: 'can you check this?',
  },
];

type Mocks = {
  overview?: unknown | 404;
  needsYou?: unknown[] | 404;
  /** Outside AIs added to the real member list; `false` leaves the list as the server sends it. */
  ais?: Array<Record<string, unknown>> | false;
  /** Make the viewer a member instead of the host (the room as the server sends it otherwise). */
  asMember?: boolean;
  muteAll?: (body: unknown) => void;
};

async function mock(page: Page, roomId: string, mocks: Mocks = {}) {
  const base = `**/api/rooms/${roomId}`;
  await page.route(`${base}/overview`, (route) =>
    mocks.overview === 404
      ? route.fulfill({ status: 404, json: { error: 'Not found' } })
      : route.fulfill({ json: { room_id: roomId, ...((mocks.overview as object) ?? OVERVIEW) } }),
  );
  await page.route(`${base}/needs-you*`, (route) =>
    mocks.needsYou === 404
      ? route.fulfill({ status: 404, json: { error: 'Not found' } })
      : route.fulfill({ json: { room_id: roomId, items: mocks.needsYou ?? NEEDS_YOU } }),
  );
  // The room's list and the Members panel's pages (?limit, ?cursor, ?q) both get the AIs.
  await page.route(
    (url) => url.pathname === `/api/rooms/${roomId}/members`,
    async (route) => {
      const response = await route.fetch();
      const value = (await response.json()) as { members: Array<Record<string, unknown>> };
      const ais = mocks.ais === false ? [] : (mocks.ais ?? outsideAis());
      const members =
        mocks.ais === false ? value.members : value.members.map((m) => ({ ...m, says: null }));
      const q = new URL(route.request().url()).searchParams.get('q')?.toLowerCase();
      const extra = q ? ais.filter((m) => String(m.name).toLowerCase().startsWith(q)) : ais;
      await route.fulfill({ response, json: { ...value, members: [...members, ...extra] } });
    },
  );
  await page.route(
    (url) => url.pathname === `/api/rooms/${roomId}/tasks`,
    (route) =>
      route.fulfill({
        json: {
          stages: [],
          tasks: [
            {
              id: 'task-3',
              number: 3,
              title: 'Ctrl/Cmd+K search drawer shortcuts',
              body: null,
              status: 'claimed',
              created_by_agent_id: 'host',
              claim: { agent_id: 'ai-sonnet', expires_at: minutesAgo(-60) },
              result: null,
              created_at: minutesAgo(100),
              updated_at: minutesAgo(5),
            },
          ],
        },
      }),
  );
  await page.route(`${base}/mute-ais`, async (route) => {
    mocks.muteAll?.(route.request().postDataJSON());
    await route.fulfill({ json: { room_id: roomId, changed: 2 } });
  });
  if (mocks.asMember) {
    const asMember = async (route: Parameters<Parameters<Page['route']>[1]>[0]) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch();
      const value = (await response.json()) as {
        rooms?: Array<{ role: string }>;
        room?: { role: string };
      };
      value.rooms?.forEach((room) => (room.role = 'member'));
      if (value.room) value.room.role = 'member';
      await route.fulfill({ response, json: value });
    };
    await page.route('**/api/rooms', asMember);
    await page.route(`${base}/messages*`, asMember);
  }
}

test('v2 header: title with tooltip, honest counts, Members and Tasks buttons and Needs you', async ({
  browser,
}) => {
  const { context, room } = await roomHost(browser);
  const page = await context.newPage();
  await mock(page, room.id);
  await page.goto(`/rooms/${room.id}`);

  const title = page.getByRole('heading', { level: 1, name: ROOM_NAME });
  await expect(title).toBeVisible();
  await expect(title).toHaveAttribute('title', ROOM_NAME);
  await expect(title).toHaveCSS('text-overflow', 'ellipsis');
  // The room pill carries the honest counts: its live line is the AIs active now, its name and
  // tooltip (and description) the whole counts line; it opens the Members panel.
  const pill = page.getByTestId('room-pill');
  await expect(pill).toHaveAccessibleName(`Members of ${ROOM_NAME}: 10.5k members, 6 AIs active`);
  const hint = `10.5k members · 6 AIs active now (20 in room). ${ACTIVE_HINT}`;
  await expect(pill).toHaveAttribute('title', hint);
  await expect(pill).toHaveAccessibleDescription(hint);
  await expect(page.getByTestId('room-live')).toHaveText(live(6));
  // No separate Members chip and no combined chip: the pill counts the members, Tasks its open
  // count. The pill is the top bar's one button that opens Members.
  const head = page.locator('.rm-room-head');
  await expect(page.getByTestId('members-button')).toHaveCount(0);
  await expect(head.getByRole('button', { name: /Members/ })).toHaveCount(1);
  await expect(page.getByTestId('activity-chip')).toHaveCount(0);
  await expect(page.getByTestId('tasks-button')).toHaveAccessibleName(/^Tasks, \d+ to do$/);
  const shell = page.locator('.rm3-pill');
  await expect(pill).toHaveAttribute('aria-expanded', 'false');
  await expect(shell).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await pill.click();
  const members = page.getByRole('complementary', { name: 'Members' });
  await expect(members).toBeVisible();
  await expect(pill).toHaveAttribute('aria-expanded', 'true');
  // While its panel is open the pill has the active-chip look: accent-soft with the accent line.
  await expect(shell).toHaveCSS('background-color', 'rgb(234, 241, 255)');
  await expect(shell).toHaveCSS('border-top-color', 'rgb(199, 215, 251)');
  await pill.click();
  await expect(members).toBeHidden();
  await expect(pill).toHaveAttribute('aria-expanded', 'false');
  // The panel's own Close button brings focus back to the pill.
  await pill.click();
  await members.getByRole('button', { name: 'Close members' }).click();
  await expect(members).toBeHidden();
  await expect(pill).toBeFocused();
  // From the keyboard: Enter on the focused pill opens Members, Space closes it again.
  await page.keyboard.press('Enter');
  await expect(members).toBeVisible();
  await expect(pill).toHaveAttribute('aria-expanded', 'true');
  await pill.focus();
  await page.keyboard.press('Space');
  await expect(members).toBeHidden();
  await expect(pill).toHaveAttribute('aria-expanded', 'false');

  // The host sees "Needs you (2)"; it lists the task and the mention.
  const needs = page.getByTestId('needs-you-chip');
  await expect(needs).toHaveAccessibleName('Needs you (2)');
  await needs.click();
  const list = page.getByRole('region', { name: 'Needs you' });
  await expect(
    list.getByRole('button', { name: /Review T7: Header fits at 360 px/ }),
  ).toBeVisible();
  await expect(list.getByText('Sonnet Scout mentioned you: "can you check this?"')).toBeVisible();
  // A task entry opens the Tasks panel.
  await list.getByRole('button', { name: /Review T7/ }).click();
  await expect(list).toBeHidden();
  await expect(page.getByRole('button', { name: /^Tasks/ })).toHaveAttribute(
    'aria-expanded',
    'true',
  );

  // The existing actions stay: in the row, and Connect AI in More (§6).
  for (const name of [/^Members of /, /^Tasks/, 'Search this room', 'Invite', 'More room actions'])
    await expect(page.getByRole('button', { name }).first()).toBeVisible();
  await page.getByRole('button', { name: 'More room actions' }).click();
  await expect(page.getByRole('menuitem', { name: 'Connect AI' })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('Needs you: hidden when nothing waits, and never shown to a member who is not the host', async ({
  browser,
}) => {
  const { context, room } = await roomHost(browser);
  const page = await context.newPage();
  await mock(page, room.id, { needsYou: [] });
  await page.goto(`/rooms/${room.id}`);
  await expect(page.getByTestId('room-pill')).toBeVisible();
  await expect(page.getByTestId('needs-you-chip')).toHaveCount(0);

  const member = await context.newPage();
  await mock(member, room.id, { asMember: true });
  let asked = false;
  member.on('request', (request) => {
    if (request.url().includes('/needs-you')) asked = true;
  });
  await member.goto(`/rooms/${room.id}`);
  await expect(member.getByRole('heading', { level: 1, name: ROOM_NAME })).toBeVisible();
  await expect(member.getByTestId('room-pill')).toBeVisible();
  await expect(member.getByRole('button', { name: 'Invite' })).toHaveCount(0);
  await expect(member.getByTestId('needs-you-chip')).toHaveCount(0);
  expect(asked).toBe(false);
});

test('Members is a clean roster: activity pills and says on the rows, Mute in the row menus', async ({
  browser,
}) => {
  const { context, room } = await roomHost(browser);
  const page = await context.newPage();
  await mock(page, room.id, {
    ais: [
      ...outsideAis(),
      {
        ...outsideAis()[0]!,
        id: 'ai-elric',
        name: 'Elric',
        owner_label: 'Central City',
        auto_reply: { provider: 'elric' },
      },
    ],
    asMember: true,
  });
  await page.goto(`/rooms/${room.id}`);
  const panel = await openMembers(page);
  // Workspace v3: no Active-now section and no task summary — the panel is the roster, with
  // Search on top, then PEOPLE and AIs, and the self-reported footnote.
  await expect(panel.getByRole('region', { name: 'Active now' })).toHaveCount(0);
  await expect(panel.getByTestId('task-summary')).toHaveCount(0);
  await expect(panel.getByRole('searchbox', { name: 'Search members' })).toBeVisible();
  await expect(panel.getByRole('heading', { name: /^AIs / })).toBeVisible();
  await expect(
    panel.getByText('Model names are self-reported by each AI, not verified.'),
  ).toBeVisible();
  const rows = panel.getByTestId('member-row');
  await expect(rows.filter({ hasText: 'Sleepy Bot' })).toHaveCount(1);

  // Other owners' members and Elric get a Message button; your own members never do (this room
  // has no person of yours; tests/rooms-direct.test.ts covers your own person).
  await expect(panel.getByRole('link', { name: 'Message Elric' })).toBeVisible();
  await expect(
    rows.filter({ hasText: 'Host agent' }).getByRole('link', { name: /Message/ }),
  ).toHaveCount(0);

  // Your own AI (the host agent) carries its badge and no Mute anywhere on the row.
  const own = rows.filter({ hasText: 'Host agent' });
  await expect(own.getByTestId('member-badge').filter({ hasText: 'AI · your agent' })).toHaveCount(
    1,
  );
  await expect(own.getByRole('button', { name: /Mute/ })).toHaveCount(0);
  await expect(own.getByRole('button', { name: 'Actions for Host agent' })).toHaveCount(0);

  // An active outside AI: the pill, and says as plain text in quotes (markup stays text).
  const sonnet = rows.filter({ hasText: 'Sonnet Scout' });
  await expect(sonnet.getByTestId('member-badge')).toContainText("AI · Maya's agent");
  const activity = sonnet.getByTestId('member-activity');
  await expect(activity).toHaveAttribute('data-active', 'true');
  await expect(activity).toContainText('active 2 min ago · 14 today');
  const saysLine = sonnet.locator('.rm-v2-member-says');
  await expect(saysLine).toHaveText('says: “running <b>test</b> harness”');
  await expect(saysLine.locator('b')).toHaveCount(0);
  const gpt = rows.filter({ hasText: 'GPT Helper' });
  await expect(gpt.getByTestId('member-activity')).toContainText('active 9 min ago · 3 today');
  await expect(gpt.locator('.rm-v2-member-says')).toHaveCount(0);
  // No progress bars or tool activity for outside AIs.
  await expect(panel.locator('progress, [role="progressbar"]')).toHaveCount(0);

  // Per-member Mute stays in the row's ⋯ menu (host only; never for your own agent — covered
  // in the host room of the settings spec).
});

test('Mute all AIs (Room settings → More settings) asks first, then calls mute-ais; Unmute all lifts it', async ({
  browser,
}) => {
  const { context, room } = await roomHost(browser);
  const page = await context.newPage();
  const bodies: unknown[] = [];
  await mock(page, room.id, { muteAll: (body) => bodies.push(body) });
  let dialogs = 0;
  page.on('dialog', (dialog) => {
    dialogs++;
    void dialog.dismiss();
  });
  await page.goto(`/rooms/${room.id}`);
  // Workspace v3: the Members panel is the roster only; the bulk controls live in the Room
  // settings sheet, collapsed under More settings.
  const members = await openMembers(page);
  await expect(members.getByRole('button', { name: 'Mute all AIs' })).toHaveCount(0);
  const panel = await openRoomSettings(page);
  await panel.getByText('More settings', { exact: true }).click();

  await panel.getByRole('button', { name: 'Mute all AIs' }).click();
  const confirm = panel.getByRole('group', { name: 'Mute all AIs?' });
  await expect(confirm).toContainText("They can still read but can't post");
  // Cancel first: nothing is sent.
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
  expect(bodies).toEqual([]);

  await panel.getByRole('button', { name: 'Mute all AIs' }).click();
  await panel
    .getByRole('group', { name: 'Mute all AIs?' })
    .getByRole('button', { name: 'Mute all AIs' })
    .click();
  await expect(panel.getByRole('status').filter({ hasText: 'Muted' })).toHaveText('Muted 2 AIs.');
  expect(bodies).toEqual([{ muted: true }]);

  await panel.getByRole('button', { name: 'Unmute all' }).click();
  await expect(panel.getByRole('status').filter({ hasText: 'Unmuted' })).toHaveText(
    'Unmuted 2 AIs.',
  );
  expect(bodies).toEqual([{ muted: true }, { muted: false }]);
  expect(dialogs).toBe(0);
});

test('without the new server routes the header degrades: list counts, no Needs you, no Mute all', async ({
  browser,
}) => {
  const { context, room } = await roomHost(browser);
  const page = await context.newPage();
  await mock(page, room.id, { overview: 404, needsYou: 404, ais: false });
  // An older server: members carry no self-reported status field at all (the current server
  // always sends `says`, so strip it to stand in for one without it).
  await page.route(`**/api/rooms/${room.id}/members`, async (route) => {
    const response = await route.fetch();
    const value = (await response.json()) as { members: Array<Record<string, unknown>> };
    const members = value.members.map(({ says: _says, ...rest }) => rest);
    await route.fulfill({ response, json: { ...value, members } });
  });
  await page.goto(`/rooms/${room.id}`);
  // The room's own member count and the member list: 2 members, no AI active (the host agent
  // just created the room, so it counts as active only if the server says so).
  const pill = page.getByTestId('room-pill');
  await expect(pill).toHaveAccessibleName(
    new RegExp(`^Members of ${ROOM_NAME}: 2 members, \\d AIs? active$`),
  );
  await expect(pill).toHaveAccessibleDescription(
    new RegExp(`^2 members · \\d AIs? active now \\(1 in room\\)\\. ${ACTIVE_HINT}$`),
  );
  await expect(page.getByTestId('needs-you-chip')).toHaveCount(0);
  // Members is the roster (no bulk controls there), and Room settings hides them too: an older
  // server sends no `says`, so the sheet knows the bulk route is missing.
  const members = await openMembers(page);
  await expect(members.getByRole('button', { name: 'Mute all AIs' })).toHaveCount(0);
  await expect(members.getByRole('button', { name: 'Unmute all' })).toHaveCount(0);
  const settings = await openRoomSettings(page);
  await settings.getByText('More settings', { exact: true }).click();
  await expect(settings.getByRole('button', { name: 'Mute all AIs' })).toHaveCount(0);
  await expect(settings.getByRole('button', { name: 'Unmute all' })).toHaveCount(0);
});

test('the room pill reads "0 AIs active" and idles when no AI is active now', async ({
  browser,
}) => {
  const { context, room } = await roomHost(browser);
  const page = await context.newPage();
  await mock(page, room.id, {
    overview: {
      ...OVERVIEW,
      members: { ...OVERVIEW.members, ais_active_15m: 0, ais_active_now: 0 },
    },
  });
  await page.route(`**/api/rooms/${room.id}/members`, async (route) => {
    const response = await route.fetch();
    const value = (await response.json()) as { members: Array<Record<string, unknown>> };
    // Everyone idle: the host agent too.
    const members = [...value.members, outsideAis()[2]!].map((m) => ({
      ...m,
      status: 'idle',
      active_now: false,
      last_active_at: minutesAgo(30),
      says: null,
    }));
    await route.fulfill({ response, json: { members } });
  });
  await page.goto(`/rooms/${room.id}`);
  await expect(page.getByTestId('room-live')).toHaveText(live(0));
  await expect(page.getByTestId('room-live')).toHaveAttribute('data-idle', 'true');
});

test('the badge equals the active rows in Members; connected AIs read "Active now"', async ({
  browser,
}) => {
  const { context, room } = await roomHost(browser);
  const page = await context.newPage();

  // The real server first: overview and member list come from one rule.
  await page.goto(`/rooms/${room.id}`);
  const button = page.getByTestId('room-live');
  await expect(button).toHaveText(/^\d+ AIs? active$/);
  let panel = await openMembers(page);
  // Opening the panel (re)loads the member list; until it lands the live line shows the
  // overview's count and the panel the previous list. Compare the two in the same settled read
  // instead of freezing the pill count at the first instant and waiting for the line to match.
  const pills = panel.locator('.rm-v2-member-activity[data-active]');
  await expect
    .poll(async () => {
      const [shown, line] = await Promise.all([pills.count(), button.textContent()]);
      return line?.trim() === live(shown) ? 'equal' : `live line ${line} vs ${shown} active rows`;
    })
    .toBe('equal');
  for (const pill of await pills.all())
    await expect(pill.locator('.rm-v2-member-activity-text')).toHaveText(/^Active now\b/);
  await page.close();

  // A room like the reported one: Elric and an outside AI are connected (their list times are
  // 10 minutes old snapshots), one AI is idle, and the overview's older 15-minute count says 6.
  const mocked = await context.newPage();
  const connected = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    ...outsideAis()[0]!,
    id,
    name,
    says: null,
    status: 'active',
    active_now: true,
    last_active_at: minutesAgo(10.5),
    ...extra,
  });
  await mock(mocked, room.id, {
    ais: [
      connected('ai-elric', 'Elric', { auto_reply: { provider: 'elric' }, owner_label: 'You' }),
      connected('ai-online', 'Online Scout'),
      { ...outsideAis()[2]!, active_now: false, last_active_at: minutesAgo(10.5) },
    ],
    // ais_active_now: the host agent (just joined), Elric and the online AI.
    overview: {
      ...OVERVIEW,
      members: { ...OVERVIEW.members, ais_active_15m: 6, ais_active_now: 3 },
    },
  });
  await mocked.goto(`/rooms/${room.id}`);
  const badge = mocked.getByTestId('room-live');
  await expect(badge).toHaveText(live(3));
  panel = await openMembers(mocked);
  const active = panel.locator('.rm-v2-member-activity[data-active]');
  await expect(active).toHaveCount(3);
  await expect(badge).toHaveText(live(await active.count()));
  const rows = panel.getByTestId('member-row');
  await expect(rows.filter({ hasText: 'Elric' })).toHaveCount(1);
  // Sleepy Bot is in the roster, but not counted as active.
  await expect(rows.filter({ hasText: 'Sleepy Bot' })).toHaveCount(1);
  await expect(
    rows.filter({ hasText: 'Sleepy Bot' }).locator('.rm-v2-member-activity[data-active]'),
  ).toHaveCount(0);
  for (const pill of await active.all()) {
    await expect(pill.locator('.rm-v2-member-activity-text')).toHaveText(/^Active now\b/);
    await expect(pill).not.toContainText('min ago');
  }
});

for (const theme of ['light', 'dark'] as const)
  for (const width of [360, 390])
    test(`v2 header fits ${width} px (${theme}): no horizontal scroll, 44 px targets`, async ({
      browser,
    }) => {
      const { context, room } = await roomHost(browser, theme);
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 844 });
      await mock(page, room.id);
      await page.goto(`/rooms/${room.id}`);
      await expect(page.getByRole('heading', { level: 1, name: ROOM_NAME })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const header = page.locator('.rm-room-head');
      // No combined counts chip. Needs you shows its icon and a count; the pill keeps its live
      // line on phones.
      await expect(page.getByTestId('activity-chip')).toHaveCount(0);
      await expect(page.getByTestId('needs-you-chip').locator('.rv2-chip-short')).toHaveText('2');
      await expect(page.getByTestId('needs-you-chip').locator('.rv2-chip-full')).toBeHidden();
      await expect(page.getByTestId('room-live')).toHaveText(live(6));
      await expect(page.getByTestId('needs-you-chip').locator('svg.lucide-inbox')).toBeVisible();
      await expect(page.locator('.rm-room-head .rv2-pip')).toHaveCount(0);

      const overflow = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        head: (() => {
          const el = document.querySelector('.rm-room-head')!;
          return el.scrollWidth - el.clientWidth;
        })(),
      }));
      expect(overflow.doc, 'page scrolls sideways').toBeLessThanOrEqual(0);
      expect(overflow.head, 'header overflows').toBeLessThanOrEqual(0);

      // Every header control is inside the viewport (a chip scrolled into view within its
      // strip) and at least 44 px tall and wide.
      const boxes = await header
        .locator('button:visible, [role="switch"]:visible')
        .evaluateAll((elements) =>
          elements.map((el) => {
            el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            const r = el.getBoundingClientRect();
            return {
              name: el.getAttribute('aria-label') ?? el.textContent ?? '',
              left: r.left,
              right: r.right,
              width: r.width,
              height: r.height,
            };
          }),
        );
      // The ☰ chip opens the workspace shell's drawer from the room's own top bar (one top bar
      // on phones: the shell's row steps aside).
      await expect(page.locator('header.cc-app-header')).toBeHidden();
      await expect(
        header.getByRole('button', { name: 'Open navigation', exact: true }),
      ).toBeVisible();
      const opener = await page
        .getByRole('button', { name: 'Open navigation', exact: true })
        .evaluate((el) => {
          const r = el.getBoundingClientRect();
          return {
            name: 'Open navigation',
            left: r.left,
            right: r.right,
            width: r.width,
            height: r.height,
          };
        });
      expect(await header.getByRole('button', { name: 'Open menu' }).count()).toBe(0);
      expect(boxes.length).toBeGreaterThanOrEqual(4);
      boxes.push(opener);
      for (const box of boxes) {
        expect(box.left, `${box.name} left`).toBeGreaterThanOrEqual(0);
        expect(box.right, `${box.name} right`).toBeLessThanOrEqual(width);
        expect(box.width, `${box.name} width`).toBeGreaterThanOrEqual(44);
        expect(box.height, `${box.name} height`).toBeGreaterThanOrEqual(44);
      }
      // The title is not squeezed to nothing.
      const titleBox = (await page.getByRole('heading', { level: 1 }).boundingBox())!;
      expect(titleBox.width).toBeGreaterThan(40);

      // Two rows: the pill (it opens Members) with More, then one strip of chips (Needs you,
      // Tasks, Search, ... and Invite last) that never wraps; Connect AI is in More.
      const rows = await header.evaluate((head) => {
        const centre = (el: Element) => {
          const r = el.getBoundingClientRect();
          return Math.round(r.top + r.height / 2);
        };
        const chips = [...head.querySelector('.rm3-chips')!.children].filter(
          (el) => el.getClientRects().length,
        );
        return {
          pill: centre(head.querySelector('.rm3-pill')!),
          more: centre(head.querySelector('.rm-more')!),
          chips: [...new Set(chips.map(centre))],
          names: chips.map((el) => el.getAttribute('aria-label') ?? el.textContent ?? ''),
          last: chips.at(-1)?.textContent,
          pillButton: centre(head.querySelector('.rm3-pill [data-testid="room-pill"]')!),
        };
      });
      expect(Math.abs(rows.more - rows.pill)).toBeLessThanOrEqual(1);
      expect(rows.chips).toHaveLength(1);
      expect(rows.chips[0]!).toBeGreaterThan(rows.pill);
      expect(rows.last).toBe('Invite');
      // Members opens from the pill in row 1; the strip has no Members chip.
      expect(Math.abs(rows.pillButton - rows.pill)).toBeLessThanOrEqual(1);
      expect(rows.names.filter((name) => /Members/.test(name))).toEqual([]);
      const pill = header.getByTestId('room-pill');
      await expect(pill).toHaveAccessibleName(
        `Members of ${ROOM_NAME}: 10.5k members, 6 AIs active`,
      );
      const pillBox = (await pill.boundingBox())!;
      expect(pillBox.height).toBeGreaterThanOrEqual(44);
      expect(pillBox.width).toBeGreaterThanOrEqual(44);
      for (const name of [/^Tasks, \d+ to do$/, 'Search this room'])
        await expect(header.getByRole('button', { name })).toBeVisible();
      await page.getByRole('button', { name: 'More room actions' }).click();
      await expect(page.getByRole('menuitem', { name: 'Connect AI' })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: /^Members/ })).toHaveCount(0);
      await expect(page.getByRole('menuitem', { name: 'Invite' })).toHaveCount(0);
      await expect(header.getByRole('button', { name: 'Invite', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');

      // Needs you while open: the active chip is accent-soft with the accent line (§4.1).
      const needs = page.getByTestId('needs-you-chip');
      await needs.click();
      await expect(needs).toHaveAttribute('aria-expanded', 'true');
      await expect(needs).toHaveCSS(
        'background-color',
        theme === 'light' ? 'rgb(234, 241, 255)' : 'rgb(26, 42, 82)',
      );
      await expect(needs).toHaveCSS(
        'border-top-color',
        theme === 'light' ? 'rgb(199, 215, 251)' : 'rgb(44, 67, 128)',
      );
      await expect(needs).toHaveAccessibleName('Needs you (2)');
      await page.keyboard.press('Escape');

      // Members opens from the pill as a sheet and still does not scroll sideways.
      await page.getByTestId('room-pill').click();
      await expect(page.getByRole('complementary', { name: 'Members' })).toBeVisible();
      const panelOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(panelOverflow).toBeLessThanOrEqual(0);
    });

test('with the real overview route (no mocks): counts from the server, no Needs you when nothing waits', async ({
  browser,
}) => {
  const { context, room } = await roomHost(browser);
  const page = await context.newPage();
  const overview = page.waitForResponse((response) =>
    response.url().endsWith(`/api/rooms/${room.id}/overview`),
  );
  await page.goto(`/rooms/${room.id}`);
  const answer = await overview;
  // On a server without the route the header falls back (tested above); here it answers.
  test.skip(answer.status() === 404, 'this server has no room overview yet');
  expect(answer.status()).toBe(200);
  const pill = page.getByTestId('room-pill');
  await expect(pill).toHaveAccessibleName(
    new RegExp(`^Members of ${ROOM_NAME}: 2 members, [01] AIs? active$`),
  );
  await expect(pill).toHaveAccessibleDescription(
    new RegExp(`^2 members · [01] AIs? active now \\(1 in room\\)\\. ${ACTIVE_HINT}$`),
  );
  await expect(page.getByTestId('room-live')).toHaveText(/^[01] AIs? active$/);
  await expect(page.getByTestId('members-button')).toHaveCount(0);
  await expect(page.getByTestId('activity-chip')).toHaveCount(0);
  await expect(page.getByTestId('needs-you-chip')).toHaveCount(0);
});

for (const theme of ['light', 'dark'] as const)
  test(`desktop (${theme}): 32 px message actions and status pills, and a backdrop behind the top bar`, async ({
    browser,
  }) => {
    const { context, agentId, room } = await roomHost(browser, theme);
    const request = context.request;
    for (let index = 0; index < 12; index++) {
      const posted = await patient(() =>
        request.post(`/api/rooms/${room.id}/messages`, {
          headers,
          data: {
            text: `Line ${index + 1}: enough text to fill the thread so it scrolls under the bar.`,
            idempotency_key: crypto.randomUUID(),
          },
        }),
      );
      expect(posted.ok(), await why(posted)).toBeTruthy();
    }
    const task = await patient(() =>
      request.post(`/api/rooms/${room.id}/tasks`, {
        headers,
        data: {
          agent_id: agentId,
          title: 'Draft the launch post',
          idempotency_key: crypto.randomUUID(),
        },
      }),
    );
    expect(task.ok(), await why(task)).toBeTruthy();
    const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/rooms/${room.id}`);
    await expect(page.getByRole('heading', { level: 1, name: ROOM_NAME })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

    // §1.5: nothing under 32 px on desktop (at the workspace's 90% density, as every size).
    const min = 32 * 0.9 - 0.5;
    const status = page.locator('.rm3 .rm3-status').first();
    await expect(status).toBeVisible();
    expect((await status.boundingBox())!.height).toBeGreaterThanOrEqual(min);
    const message = page.locator('.rm3 .rm-message').filter({ hasText: 'Line 12:' });
    await message.hover();
    const actions = message.locator('.rm3-action');
    // The hover row appears with a short transition: wait for it rather than count at once.
    await expect.poll(() => actions.count()).toBeGreaterThanOrEqual(3);
    // §2 radii: an AI's avatar in the pill is a rounded square (8 px at 28 px, at 90%).
    await expect(page.locator('.rm3-pill .rm3-av[data-kind="agent"]').first()).toHaveCSS(
      'border-top-left-radius',
      '7.2px',
    );
    for (const action of await actions.all()) {
      await expect(action).toBeVisible();
      const box = (await action.boundingBox())!;
      expect(box.height, await action.innerText()).toBeGreaterThanOrEqual(min);
    }

    // The top bar's backdrop: the page colour fading to transparent, and the thread fades out
    // under it, so no message text shows between the chips.
    const look = await page.evaluate(() => {
      const head = getComputedStyle(document.querySelector('.rm-room-head')!);
      const scroll = getComputedStyle(document.querySelector('.rm3 .rm-scroll')!);
      return {
        image: head.backgroundImage,
        mask: scroll.maskImage || scroll.webkitMaskImage,
      };
    });
    expect(look.image).toMatch(/^linear-gradient/);
    expect(look.image).toContain(theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(11, 16, 32)');
    expect(look.mask).toMatch(/linear-gradient/);
    // Scrolled up, the message nearest the bar starts below it (nothing is drawn over the bar).
    await page.locator('.rm3 .rm-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight / 2));
    const headBottom = (await page.locator('.rm-room-head').boundingBox())!;
    const scrollTop = (await page.locator('.rm3 .rm-scroll').boundingBox())!;
    expect(scrollTop.y).toBeGreaterThanOrEqual(headBottom.y + headBottom.height - 0.5);
  });
