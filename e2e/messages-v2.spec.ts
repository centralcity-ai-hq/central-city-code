import { test, expect, type Page } from '@playwright/test';
import type { AgentMessage, ConversationSummary } from '../server/messaging/contract';
import { WORKSPACE_SCALE, workspaceTarget } from './workspace-density';

/*
 * Messages, Workspace v3 (docs/design/WORKSPACE_V3.md §5): the floating pill with the live unread
 * count, the All / Unread / Agents tabs, one card list (name + badge, owner and room, last line,
 * relative time, unread), the thread view with Back, the room bubble rules, the ⋯ menu and the
 * floating composer (Enter sends, Shift+Enter adds a line), motion, and the loading, empty and
 * error states. Mocked lists are typed by the server contract, so
 * they carry only real fields. Screenshots go to shots/ (not committed).
 */
const headers = { 'X-City-Request': '1' };
async function workspace(page: Page) {
  const response = await page.request.post('/api/auth/register', {
    headers,
    data: {
      name: `Messages preview ${crypto.randomUUID().slice(0, 8)}`,
      password: 'Local-test-only-passphrase-2026',
    },
  });
  expect(response.status()).toBe(201);
}
async function seed(page: Page) {
  await workspace(page);
  await page.request.post('/api/demo/start', { headers, data: {} });
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const agents = snapshot.agents as Array<{ id: string; name: string }>;
  const to = agents.find((agent) => agent.name === 'Relay')!.id;
  const from = agents.find((agent) => agent.id !== to)!.id;
  const response = await page.request.post(`/api/agents/${from}/messages`, {
    headers,
    data: { to_agent_id: to, text: 'Ready for review', idempotency_key: crypto.randomUUID() },
  });
  expect(response.status()).toBe(201);
}
async function open(page: Page, preview = true) {
  await page.goto(`/?workspace=${preview ? 'v2' : 'v1'}`);
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  const messages = page
    .getByRole('navigation', { name: 'Workspace', exact: true })
    .getByRole('button', { name: /^Messages/ });
  // Wait for the shell: phones show the menu button, desktops the navigation itself.
  await expect(menu.or(messages).first()).toBeVisible();
  if (await menu.isVisible()) await menu.click();
  await messages.click();
}
const panel = (page: Page) => page.getByRole('region', { name: 'Messages', exact: true });
const inbox = (page: Page) => page.getByRole('navigation', { name: 'Conversations', exact: true });
const dark = (page: Page) =>
  page.locator('html').evaluate((element) => element.setAttribute('data-theme', 'dark'));
const light = (page: Page) =>
  page.locator('html').evaluate((element) => element.setAttribute('data-theme', 'light'));

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
function message(
  context: string,
  seq: number,
  from: { id: string; name: string },
  to: { id: string; name: string },
  text: string,
  minutes: number,
): AgentMessage {
  return {
    origin: 'external',
    from_owner_label: null,
    id: `${context}-${seq}`,
    seq,
    kind: 'message',
    from_agent_id: from.id,
    from_agent_name: from.name,
    to_agent_id: to.id,
    to_agent_name: to.name,
    context_id: context,
    reply_to: null,
    parts: [{ type: 'text', text }],
    created_at: minutesAgo(minutes),
    room_id: 'room-planning',
  };
}
const me = { id: 'm-self', name: 'Sam' };
const scout = { id: 'm-scout', name: 'Scout' };
const jamie = { id: 'm-jamie', name: 'Jamie' };
const relay = { id: 'm-relay', name: 'Relay' };
const threads: Record<string, AgentMessage[]> = {
  'dm-scout': [
    message('dm-scout', 1, scout, me, 'The draft agenda is ready for your review.', 30),
    message('dm-scout', 2, me, scout, 'Thanks. Please add the budget item.', 20),
    message('dm-scout', 3, scout, me, 'Added. Anything else before tomorrow?', 5),
    message(
      'dm-scout',
      4,
      scout,
      me,
      ['@Sam the build is green:', '```', 'pnpm build', '```'].join('\n'),
      4,
    ),
  ],
  'dm-jamie': [message('dm-jamie', 1, jamie, me, 'Can we move our call to Friday?', 90)],
  'dm-relay': [message('dm-relay', 1, relay, me, 'Nightly summary posted.', 600)],
};
function summary(
  context: string,
  peer: typeof scout,
  kind: 'agent' | 'person',
  ownerLabel: string | null,
  room: string,
  unread: number,
  capped = false,
): ConversationSummary {
  const messages = threads[context]!;
  return {
    context_id: context,
    message_count: messages.length,
    participants: [me.id, peer.id],
    last_message: messages.at(-1)!,
    unread,
    unread_capped: capped,
    direct: {
      context_id: context,
      room_id: 'room-planning',
      room_name: room,
      self: { ...me, kind: 'person', owner_label: 'Account 1a2b3c4d', is_self: true },
      peer: { ...peer, kind, owner_label: ownerLabel, is_self: false },
    },
  };
}
const conversations = [
  summary('dm-scout', scout, 'agent', 'Northwind', 'planning', 3),
  summary('dm-jamie', jamie, 'person', 'Account 9f8e7d6c', 'design-review', 0),
  summary('dm-relay', relay, 'agent', 'Harbor Labs', 'ops', 99, true),
];
async function mockInbox(page: Page) {
  let reads = 0;
  await page.route('**/api/messages/conversations', (route) =>
    route.fulfill({ json: { conversations } }),
  );
  await page.route('**/api/messages/conversations/*', (route) => {
    const context = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop()!);
    return route.fulfill({
      json: { messages: threads[context] ?? [], has_more: false, next_before: null },
    });
  });
  await page.route('**/api/messages/direct/*/read', (route) => {
    reads++;
    return route.fulfill({ json: { ok: true } });
  });
  return () => reads;
}

test('1440: one card list with badges, owners, origins and 99+; the thread has bubbles and the privacy line', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await workspace(page);
  await mockInbox(page);
  await open(page);
  const list = inbox(page);
  const rows = list.getByRole('button');
  await expect(rows).toHaveCount(3);
  // One view at a time: the inbox is one card list (at most 980 px, at the workspace's 90%),
  // the thread opens in its place with Back in its top bar.
  const thread = panel(page).getByRole('region', { name: 'Conversation' });
  await expect(list).toBeVisible();
  await expect(thread).toBeHidden();
  expect((await list.boundingBox())!.width).toBeLessThanOrEqual(980 * WORKSPACE_SCALE + 1);
  await expect(page.getByRole('button', { name: 'Back to inbox' })).toBeHidden();
  await expect(panel(page)).toContainText(
    'Private messages reach everyone you share a room with: people, your own AIs and invited AIs.',
  );

  // Name + badge, the owner and the room it started in, the last line, the time, unread.
  const scoutRow = rows.filter({ hasText: 'Scout' });
  await expect(scoutRow.locator('.msg3-tag')).toHaveText('AI');
  await expect(scoutRow).toContainText('Northwind · From #planning');
  await expect(scoutRow).toContainText('the build is green');
  await expect(scoutRow.locator('.msg-v2-time')).toHaveText('4m');
  await expect(scoutRow.locator('.msg-v2-badge [aria-hidden="true"]')).toHaveText('3');
  await expect(scoutRow).toHaveAccessibleName(/3 unread/);
  const relayRow = rows.filter({ hasText: 'Relay' });
  await expect(relayRow.locator('.msg-v2-badge [aria-hidden="true"]')).toHaveText('99+');
  await expect(relayRow).toHaveAccessibleName(/More than 99 unread/);
  const jamieRow = rows.filter({ hasText: 'Jamie' });
  await expect(jamieRow.locator('.msg3-tag')).toHaveText('person');
  await expect(jamieRow).toContainText('From #design-review');
  // A person's account label is never shown as an owner.
  await expect(jamieRow).not.toContainText('Account 9f8e7d6c');
  await expect(jamieRow.locator('.msg-v2-badge')).toHaveCount(0);
  // The pill's live total: 3 + 99 capped.
  const live = panel(page).locator('.msg-v2-heading .msg3-live');
  await expect(live.locator(':scope > span[aria-hidden="true"]')).toHaveText('99+ unread');
  await expect(live).toContainText('More than 99 unread');
  await expect(
    page.getByRole('heading', { name: 'Messages', exact: true, level: 1 }),
  ).toBeVisible();

  // Tabs: Unread and Agents filter the same list.
  const tabs = panel(page).getByRole('group', { name: 'Show' });
  await tabs.getByRole('button', { name: 'Unread' }).click();
  await expect(tabs.getByRole('button', { name: 'Unread' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(rows).toHaveCount(2);
  await expect(jamieRow).toHaveCount(0);
  await tabs.getByRole('button', { name: 'Agents' }).click();
  await expect(rows).toHaveCount(2);
  await expect(jamieRow).toHaveCount(0);
  await tabs.getByRole('button', { name: 'All' }).click();
  await expect(rows).toHaveCount(3);

  // No Refresh button beside the pill: the inbox polls on its own.
  await expect(panel(page).getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(0);
  expect((await scoutRow.boundingBox())!.height).toBeGreaterThanOrEqual(workspaceTarget(1440));
  await page.screenshot({ path: 'shots/messages-v2-1440-light.png' });

  await scoutRow.click();
  await expect(list).toBeHidden();
  await expect(thread).toBeVisible();
  const head = thread.locator('.msg-v2-head');
  await expect(head.getByRole('heading', { name: 'Scout' })).toBeVisible();
  await expect(head.locator('.msg3-tag')).toHaveText('AI');
  await expect(head).toContainText('Northwind · From #planning');
  await expect(thread).toContainText(
    "Private: you and Scout. Scout's owner (Northwind) can read it too. Private messages never post to room feeds.",
  );
  // Own messages: right-aligned in the accent bubble, the time under it, no avatar.
  const own = page.getByTestId('message').filter({ hasText: 'Please add the budget item' });
  await expect(own).toHaveAttribute('data-own', 'true');
  await expect(own.locator('.msg-byline strong')).toHaveText('You');
  await expect(own.locator('.msg-v2-avatar')).toHaveCount(0);
  await expect(own.locator('.msg-bubble')).toHaveCSS('background-color', 'rgb(37, 99, 235)');
  const ownBox = (await own.boundingBox())!;
  const theirs = page.getByTestId('message').filter({ hasText: 'Anything else' });
  const theirBox = (await theirs.boundingBox())!;
  expect(ownBox.x + ownBox.width).toBeGreaterThan(theirBox.x + theirBox.width);
  // Others: avatar, name + badge + owner + time.
  await expect(theirs.locator('.msg-v2-avatar')).toHaveCount(1);
  await expect(theirs.locator('.msg-byline strong')).toHaveText('Scout');
  await expect(theirs.locator('.msg3-tag')).toHaveText('AI');
  await expect(theirs.locator('.msg3-owner')).toHaveText('Northwind');
  await expect(theirs.locator('.msg-byline time')).toHaveAttribute('datetime', /T/);
  // Mentions of the thread's members are styled; fenced code is a dark block.
  const code = page.getByTestId('message').filter({ hasText: 'the build is green' });
  await expect(code.locator('.msg3-mention')).toHaveText('@Sam');
  await expect(code.locator('.msg3-code')).toHaveText('pnpm build');
  await expect(code.locator('.msg3-code')).toHaveCSS('background-color', 'rgb(11, 16, 32)');
  // No per-thread "mark read": acknowledgements are per inbox.
  await expect(panel(page).getByRole('button', { name: /mark.*read/i })).toHaveCount(0);

  // The ⋯ menu: Details and Delete conversation.
  await thread.getByRole('button', { name: 'Conversation actions' }).click();
  const menu = page.getByRole('menu', { name: 'Conversation actions' });
  await expect(menu.getByRole('menuitem')).toHaveText(['Details', 'Delete conversation']);
  // Arrow keys move through the menu; Tab leaves it and closes it.
  await expect(menu.getByRole('menuitem', { name: 'Details' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Delete conversation' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Details' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem', { name: 'Delete conversation' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(menu).toHaveCount(0);
  await thread.getByRole('button', { name: 'Conversation actions' }).click();
  await menu.getByRole('menuitem', { name: 'Details' }).click();
  const details = thread.locator('.msg3-details');
  await expect(details).toContainText('Started in#planning');
  await expect(details).toContainText('Messages4');

  const box = thread.getByLabel('Message privately');
  await expect(box).toHaveAttribute('placeholder', 'Message privately…');
  // No connected agents in this workspace: New conversation would open a composer with no route.
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toHaveCount(0);
  for (const target of [
    page.getByRole('button', { name: 'Back to inbox' }),
    thread.getByRole('button', { name: 'Send privately' }),
  ])
    expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(workspaceTarget(1440));

  await dark(page);
  await expect(thread.getByRole('form', { name: 'Private message' })).toHaveCSS(
    'background-color',
    'rgb(18, 26, 49)',
  );
  await page.screenshot({ path: 'shots/messages-v2-1440-dark.png' });
  await light(page);
});

test('the floating composer: Enter sends, Shift+Enter adds a line, code and Preview tools', async ({
  page,
}) => {
  await workspace(page);
  await mockInbox(page);
  const sent: Array<Record<string, unknown>> = [];
  await page.route('**/api/rooms/*/direct/messages', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sent.push(body);
    await route.fulfill({
      status: 201,
      json: { message: message('dm-scout', 10 + sent.length, me, scout, String(body.text), 0) },
    });
  });
  await open(page);
  await inbox(page).getByRole('button').filter({ hasText: 'Scout' }).click();
  const composer = page.getByRole('form', { name: 'Private message' });
  const box = composer.getByLabel('Message privately');
  await box.click();
  await box.pressSequentially('First line');
  await box.press('Shift+Enter');
  await box.pressSequentially('second line');
  await expect(box).toHaveValue('First line\nsecond line');
  expect(sent).toHaveLength(0);
  await composer.getByRole('button', { name: 'Preview' }).click();
  await expect(composer.getByRole('region', { name: 'Preview' })).toContainText('second line');
  await composer.getByRole('button', { name: 'Preview' }).click();
  await box.press('Enter');
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]!.text).toBe('First line\nsecond line');
  await expect(box).toHaveValue('');
  await expect(box).toBeFocused();
  // </> wraps a code block around the caret; @ mentions the other side.
  await composer.getByRole('button', { name: 'Insert code block' }).click();
  await expect(box).toHaveValue('```\n\n```');
  await box.pressSequentially('ls');
  await expect(box).toHaveValue('```\nls\n```');
  await box.fill('');
  await composer.getByRole('button', { name: 'Mention Scout' }).click();
  await expect(box).toHaveValue('@Scout ');
});

test('message arrival rises into place, and nothing moves with reduced motion', async ({
  page,
}) => {
  await workspace(page);
  await mockInbox(page);
  await open(page);
  await inbox(page).getByRole('button').filter({ hasText: 'Scout' }).click();
  const thread = panel(page).getByRole('region', { name: 'Conversation' });
  // The opening page does not animate; only messages that arrive while the thread is open.
  await expect(page.getByTestId('message').first()).not.toHaveAttribute('data-arrive', 'true');
  // A new message from Scout: the list and the thread now include it (later routes win).
  const fresh = message('dm-scout', 5, scout, me, 'Fresh news', 0);
  const scoutThread = [...threads['dm-scout']!, fresh];
  await page.route('**/api/messages/conversations', (route) =>
    route.fulfill({
      json: {
        conversations: conversations.map((item) =>
          item.context_id === 'dm-scout'
            ? { ...item, last_message: fresh, message_count: scoutThread.length }
            : item,
        ),
      },
    }),
  );
  await page.route(
    (url) => url.pathname.endsWith('/api/messages/conversations/dm-scout'),
    (route) =>
      route.fulfill({ json: { messages: scoutThread, has_more: false, next_before: null } }),
  );
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const arrived = page.getByTestId('message').filter({ hasText: 'Fresh news' });
  await expect(arrived).toHaveAttribute('data-arrive', 'true');
  await expect(arrived).toHaveCSS('animation-name', 'msg3-rise');
  await expect(arrived).toHaveCSS('animation-duration', '0.22s');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(arrived).toHaveCSS('animation-name', 'none');
  await expect(thread).toHaveCSS('animation-name', 'none');
});
test('1440: opening a thread reads it; system back and a reload keep Back inside Messages', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await workspace(page);
  const reads = await mockInbox(page);
  await open(page);
  const list = inbox(page);
  const scoutRow = list.getByRole('button').filter({ hasText: 'Scout' });
  await expect(scoutRow).toBeVisible();
  // The preloaded chat behind the inbox is not read until it is shown.
  await page.waitForTimeout(500);
  expect(reads()).toBe(0);
  await scoutRow.click();
  await expect.poll(reads).toBeGreaterThanOrEqual(1);
  await expect(list).toBeHidden();
  // System back returns to the inbox, not out of Messages.
  await page.goBack();
  await expect(list).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Messages', exact: true, level: 1 }),
  ).toBeVisible();
  await expect(panel(page).getByRole('region', { name: 'Conversation' })).toBeHidden();
  // A reload while a thread is open: the page opens on the inbox and Back still works.
  await scoutRow.click();
  await expect(list).toBeHidden();
  await page.reload();
  await expect(scoutRow).toBeVisible();
  expect(await page.evaluate(() => (history.state ?? {}).messagesThread)).toBeUndefined();
  await scoutRow.click();
  await page.getByRole('button', { name: 'Back to inbox' }).click();
  await expect(list).toBeVisible();
  await expect(scoutRow).toBeFocused();
  // Within a tab, Back returns focus to the chat in that tab.
  const tabs = panel(page).getByRole('group', { name: 'Show' });
  await tabs.getByRole('button', { name: 'Unread' }).click();
  const relayRow = list.getByRole('button').filter({ hasText: 'Relay' });
  await relayRow.click();
  await page.getByRole('button', { name: 'Back to inbox' }).click();
  await expect(relayRow).toBeFocused();
});

test('390: inbox, then the thread, Back and Escape restore the list item', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await workspace(page);
  const reads = await mockInbox(page);
  await open(page);
  const list = inbox(page);
  const scoutRow = list.getByRole('button').filter({ hasText: 'Scout' });
  await expect(scoutRow).toBeVisible();
  await expect(panel(page).getByLabel('Message privately')).toBeHidden();
  await page.screenshot({ path: 'shots/messages-v2-390-inbox-light.png' });
  await dark(page);
  await page.screenshot({ path: 'shots/messages-v2-390-inbox-dark.png' });
  await light(page);
  // Opening the list does not acknowledge a hidden thread.
  expect(reads()).toBe(0);

  await scoutRow.click();
  await expect(list).toBeHidden();
  await expect.poll(reads).toBeGreaterThanOrEqual(1);
  const back = page.getByRole('button', { name: 'Back to inbox' });
  await expect(back).toBeVisible();
  // One top row: the workspace bar (☰) steps aside while the thread is open, so Back, the
  // pill and ⋯ sit at the top of the screen and nothing covers Back.
  const bar = page.locator('header.cc-app-header');
  await expect(bar).toBeHidden();
  await expect(back).toBeInViewport({ ratio: 1 });
  await expect.poll(async () => (await back.boundingBox())!.y).toBeLessThan(40);
  const pill = panel(page).locator('.msg-v2-head');
  const actions = panel(page).getByRole('button', { name: 'Conversation actions' });
  const [backTop, pillBox, actionsBox] = [
    (await back.boundingBox())!,
    (await pill.boundingBox())!,
    (await actions.boundingBox())!,
  ];
  for (const box of [pillBox, actionsBox])
    expect(Math.abs(box.y + box.height / 2 - (backTop.y + backTop.height / 2))).toBeLessThan(4);
  const backBox = (await back.boundingBox())!;
  expect(backBox.height).toBeGreaterThanOrEqual(44);
  expect(backBox.width).toBeGreaterThanOrEqual(44);
  await expect(panel(page).locator('.msg-v2-head')).toContainText('From #planning');
  const box = panel(page).getByLabel('Message privately');
  await box.fill('Keep this draft');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'shots/messages-v2-390-thread-light.png' });
  await dark(page);
  await page.screenshot({ path: 'shots/messages-v2-390-thread-dark.png' });
  await light(page);

  await box.press('Escape');
  await expect(scoutRow).toBeFocused();
  await scoutRow.click();
  await expect(box).toHaveValue('Keep this draft');
  await back.click();
  await expect(scoutRow).toBeFocused();
  // Back in the inbox, the bar (and its ☰) returns.
  await expect(bar).toBeVisible();
});

test('390: the system back gesture returns from a thread to the inbox', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await workspace(page);
  await mockInbox(page);
  await open(page);
  const list = inbox(page);
  const scoutRow = list.getByRole('button').filter({ hasText: 'Scout' });
  await scoutRow.click();
  await expect(list).toBeHidden();
  await expect(page.getByRole('button', { name: 'Back to inbox' })).toBeVisible();
  await page.goBack();
  await expect(list).toBeVisible();
  await expect(scoutRow).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Messages', exact: true, level: 1 }),
  ).toBeVisible();
  await expect(panel(page).getByLabel('Message privately')).toBeHidden();
  // The in-page Back steps through the same entry: back again leaves the thread's entry behind.
  await scoutRow.click();
  await page.getByRole('button', { name: 'Back to inbox' }).click();
  await expect(list).toBeVisible();
  await expect(scoutRow).toBeFocused();
  expect(await page.evaluate(() => (history.state ?? {}).messagesThread)).toBeUndefined();
});

test('preview keyboard send on real data; ?workspace=v1 still shows the new page', async ({
  page,
}) => {
  await seed(page);
  await open(page);
  await expect(panel(page)).toHaveClass(/messages-v2/);
  // Preview page headings have no full stop (Settings, Activity log, Data & export).
  await expect(
    page.getByRole('heading', { name: 'Messages', exact: true, level: 1 }),
  ).toBeVisible();
  await inbox(page).getByRole('button').first().click();
  await expect(page.getByTestId('message').filter({ hasText: 'Ready for review' })).toBeVisible();
  await expect(panel(page).getByTestId('message').locator('.msg3-tag').first()).toHaveText('AI');
  const box = panel(page).getByLabel('Message text');
  await box.fill('Keyboard reply');
  await box.press('Enter');
  await expect(page.getByTestId('message').filter({ hasText: 'Keyboard reply' })).toBeVisible();
  await expect(box).toHaveValue('');
  // Ctrl/Cmd+Enter still sends.
  await box.fill('Second keyboard reply');
  await box.press('Control+Enter');
  await expect(
    page.getByTestId('message').filter({ hasText: 'Second keyboard reply' }),
  ).toBeVisible();
  await expect(box).toHaveValue('');
  // The new design is the only design: ?workspace=v1 is ignored and Messages stays v2.
  await open(page, false);
  await expect(panel(page)).toHaveClass(/messages-v2/);
  await expect(
    page.getByRole('heading', { name: 'Messages', exact: true, level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Messages.', exact: true })).toHaveCount(0);
});

test('390 empty inbox explains private messages and returns from a new draft', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await workspace(page);
  // Someone to write to (a member of one of your rooms), no conversations yet.
  await page.route('**/api/messages/recipients', (route) =>
    route.fulfill({
      json: {
        recipients: [
          {
            room_id: 'room-planning',
            room_name: 'planning',
            member_id: 'm-jamie',
            name: 'Jamie',
            kind: 'person',
            owner_label: 'Account 9f8e7d6c',
            own: false,
          },
        ],
      },
    }),
  );
  await open(page);
  const status = panel(page).getByRole('status').filter({ hasText: 'No private messages yet' });
  await expect(status).toBeVisible();
  await expect(status).toContainText('Private messages never post to room feeds.');
  await page.getByRole('button', { name: 'Write the first message' }).click();
  // New conversation offers the room member, never an agent → agent route of this workspace.
  const picker = page.getByRole('form', { name: 'Message someone from a room' });
  await expect(picker.getByLabel('To')).toContainText('Jamie · Person');
  await page.getByRole('button', { name: 'Back to inbox' }).click();
  await expect(status).toBeVisible();
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeFocused();
});

test('a read failure is an alert with Retry loading, then recovers', async ({ page }) => {
  await workspace(page);
  let fail = true;
  await page.route('**/api/messages/conversations', (route) =>
    route.fulfill({
      status: fail ? 503 : 200,
      json: fail ? { error: 'Temporarily unavailable' } : { conversations: [] },
    }),
  );
  await open(page);
  await expect(panel(page).getByRole('alert')).toContainText("Messages couldn't be loaded");
  fail = false;
  await panel(page).getByRole('button', { name: 'Retry loading' }).click();
  await expect(panel(page).getByRole('status')).toContainText('No private messages yet');
  await expect(panel(page).getByRole('alert')).toHaveCount(0);
});

test('loading is announced before the list arrives', async ({ page }) => {
  await workspace(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/messages/conversations', async (route) => {
    await pending;
    await route.fulfill({ json: { conversations: [] } });
  });
  await open(page);
  await expect(panel(page).getByRole('status')).toContainText('Loading conversations');
  await expect(panel(page).locator('.msg-v2-skeleton')).toBeVisible();
  release();
  await expect(panel(page).getByRole('status')).toContainText('No private messages yet');
});

test('1440 and 390: the top bar has a backdrop in light and dark, and the thread fades under it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await workspace(page);
  await mockInbox(page);
  await open(page);
  const rows = inbox(page).getByRole('button');
  await expect(rows).toHaveCount(3);
  const backdrop = (selector: string) =>
    page.locator(selector).evaluate((element) => getComputedStyle(element).backgroundImage);
  const page1 = { light: 'rgb(255, 255, 255)', dark: 'rgb(11, 16, 32)' };
  for (const [theme, set] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    await set(page);
    // The inbox pill: the page colour fading to transparent at the bar's lower edge.
    const image = await backdrop('.msg3-inbox .msg3-topbar');
    expect(image, theme).toMatch(/^linear-gradient/);
    expect(image, theme).toContain(page1[theme]);
  }
  await light(page);
  await rows.filter({ hasText: 'Scout' }).click();
  const thread = panel(page).getByRole('region', { name: 'Conversation' });
  await expect(thread).toBeVisible();
  for (const [theme, set] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    await set(page);
    const image = await backdrop('.msg-thread .msg3-topbar');
    expect(image, theme).toMatch(/^linear-gradient/);
    expect(image, theme).toContain(page1[theme]);
  }
  const mask = await page.locator('.msg-thread .msg-viewport').evaluate((element) => {
    const style = getComputedStyle(element);
    return style.maskImage || style.webkitMaskImage;
  });
  expect(mask).toMatch(/linear-gradient/);
  // The same on a phone thread: Back, the pill and ⋯ keep the backdrop.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Back to inbox' })).toBeVisible();
  expect(await backdrop('.msg-thread .msg3-topbar')).toContain(page1.dark);
});
