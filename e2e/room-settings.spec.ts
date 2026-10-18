import {
  test,
  expect as baseExpect,
  type Browser,
  type Locator,
  type Page,
} from '@playwright/test';
import { WORKSPACE_SCALE } from './workspace-density';

/*
 * Room settings (docs/ROOM_MANAGEMENT.md): the "…" menu opens the Room settings sheet (a modal
 * dialog, Workspace v3). The host renames the room and edits its topic, removes a member with a
 * reason and a rejoin block, and deletes the room after typing its exact name. Members who don't host see no host controls.
 */
const expect = baseExpect.configure({ timeout: 15_000 });
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'X-City-Request': '1' };

type Account = Awaited<ReturnType<typeof account>>;
async function account(
  browser: Browser,
  label: string,
  viewport?: { width: number; height: number },
) {
  const context = await browser.newContext(viewport ? { viewport } : {});
  const name = `${label}-${crypto.randomUUID().slice(0, 8)}`;
  const created = await context.request.post('/api/auth/register', {
    headers,
    data: { name, password: PASSWORD },
  });
  expect(created.status()).toBe(201);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { name, context, request: context.request, page, errors };
}

async function agent(owner: Account, name: string) {
  const response = await owner.request.post('/api/agents', {
    headers,
    data: { name, capability: 'research', mode: 'hosted' },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).agent.id as string;
}

async function hostRoom(owner: Account, name: string) {
  const hostAgent = await agent(owner, 'Host agent');
  const response = await owner.request.post('/api/rooms', {
    headers,
    data: { agent_id: hostAgent, name, idempotency_key: crypto.randomUUID() },
  });
  expect(response.status()).toBe(201);
  const room = (await response.json()).room as { id: string; slug: string };
  const minted = await owner.request.post(`/api/rooms/${room.id}/link`, { headers, data: {} });
  expect(minted.status()).toBe(200);
  const link = (await minted.json()).link as string;
  return { ...room, link, token: new URL(link).hash.slice(1) };
}

async function join(owner: Account, room: { id: string; token: string }, agentName: string) {
  const response = await owner.request.post(`/api/rooms/${room.id}/join`, {
    headers,
    data: { token: room.token, create: { name: agentName }, idempotency_key: crypto.randomUUID() },
  });
  expect(response.status()).toBe(200);
  return (await response.json()).agent_id as string;
}

async function openSettings(page: Page) {
  await page.locator('.rm-room-head').getByRole('button', { name: 'More room actions' }).click();
  await page.getByRole('menuitem', { name: 'Room settings', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Room settings' });
  await expect(panel).toBeVisible();
  return panel;
}

/** Workspace v3: the host's extra settings (name, stages, members, bulk mute) sit collapsed. */
async function moreSettings(panel: Locator) {
  await panel.getByText('More settings', { exact: true }).click();
}

test('host renames the room and edits its topic; the thread shows the system lines', async ({
  browser,
}) => {
  const host = await account(browser, 'Host');
  const room = await hostRoom(host, 'Launch plan');
  await host.page.goto(`/rooms/${room.id}`);
  const panel = await openSettings(host.page);
  // The Members panel is not what opens.
  await expect(host.page.getByRole('complementary', { name: 'Members' })).toHaveCount(0);
  // Workspace v3: the minimal sheet leads with the description; the name form sits under More
  // settings.
  const topic = panel.getByLabel('What this room is for');
  await expect(topic).toHaveValue('');
  await moreSettings(panel);

  const name = panel.getByLabel('Room name');
  const save = panel.getByRole('button', { name: 'Save' });
  await expect(name).toHaveValue('Launch plan');
  await expect(save).toBeDisabled();

  // An empty name is refused inline, before any request.
  await name.fill('   ');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(panel.getByText('Give the room a name.')).toBeVisible();

  await name.fill('Launch plan v2');
  await topic.fill('Ship the beta. Be kind.');
  await save.click();
  await expect(panel.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  await expect(save).toBeDisabled();
  await expect(name).toHaveValue('Launch plan v2');
  // The topic saves with Done (the sheet's footer), not with the name's Save.
  await panel.getByRole('button', { name: 'Done' }).click();
  await expect(panel).toHaveCount(0);

  const lines = host.page.getByTestId('room-system-line');
  await expect(lines.filter({ hasText: 'The host renamed the room.' })).toHaveCount(1);
  await expect(lines.filter({ hasText: 'The host updated the room topic.' })).toHaveCount(1);
  // The system lines never carry the new text; the room's heading and list do.
  await expect(lines.filter({ hasText: 'Ship the beta' })).toHaveCount(0);
  await expect(host.page.getByRole('heading', { level: 1, name: 'Launch plan v2' })).toHaveCount(1);

  // End room is a quiet row on the sheet (no danger-zone toggle); a closed room's settings are
  // read-only.
  await expect(panel.getByRole('button', { name: 'Danger zone' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Delete room' })).toHaveCount(0);
  // Done closed the sheet: open it, end the room, then open the closed room's settings.
  const ending = await openSettings(host.page);
  await ending.getByRole('button', { name: 'End room' }).click();
  await ending.getByRole('button', { name: 'Confirm close' }).click();
  await expect(host.page.getByRole('heading', { level: 1, name: 'Launch plan v2' })).toHaveCount(1);
  if (await ending.isVisible()) await host.page.keyboard.press('Escape');
  await expect(ending).toBeHidden();
  const closedPanel = await openSettings(host.page);
  await expect(closedPanel.getByLabel('What this room is for')).toHaveAttribute('readonly', '');
  await moreSettings(closedPanel);
  await expect(
    closedPanel.getByText("This room is closed. Its name and topic can't change."),
  ).toBeVisible();
  await expect(closedPanel.getByLabel('Room name')).toBeDisabled();
  await expect(closedPanel.getByRole('button', { name: 'Save' })).toBeDisabled();
  await expect(closedPanel.getByRole('button', { name: 'End room' })).toHaveCount(0);
  await expect(closedPanel.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
  expect(host.errors).toEqual([]);
  await host.context.close();
});

test('remove with a reason always blocks rejoining: the removed member sees the reason as text', async ({
  browser,
}) => {
  const host = await account(browser, 'Host');
  const room = await hostRoom(host, 'Remove plan');
  const guest = await account(browser, 'Guest');
  await join(guest, room, 'Guest agent');

  await host.page.goto(`/rooms/${room.id}`);
  const settings = await openSettings(host.page);
  await moreSettings(settings);
  await settings.getByRole('button', { name: /Manage members/ }).click();
  const members = host.page.getByRole('complementary', { name: 'Members' });
  await expect(members).toBeVisible();
  await memberAction(members, 'Guest agent', 'Remove');
  const confirm = members.getByRole('group', { name: "Remove Guest agent? They can't rejoin." });
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  // Removal always blocks rejoining: there is no choice to make.
  await expect(confirm.getByRole('checkbox')).toHaveCount(0);
  await expect(confirm.getByText('Block from rejoining')).toHaveCount(0);
  const reason = confirm.getByLabel('Reason (shown to the removed member)');
  await expect(reason).toHaveAttribute('maxlength', '200');
  const said = 'Off-topic posts <b>again</b> **twice**';
  await reason.fill(said);

  const sent = host.page.waitForRequest(
    (request) => request.method() === 'POST' && /\/members\/[^/]+\/remove$/.test(request.url()),
  );
  await confirm.getByRole('button', { name: 'Remove', exact: true }).click();
  expect((await sent).postDataJSON()).toEqual({ reason: said, block_rejoin: true });
  // The host agent and the host's own person (A1) remain.
  await expect(members.getByTestId('member-row')).toHaveCount(2);

  // The removed member tries the room link again: refused, with the host's words as plain text.
  await guest.page.goto(room.link);
  await guest.page.getByRole('button', { name: 'Join room' }).click();
  const alert = guest.page.getByRole('alert').filter({ hasText: 'The host removed you' });
  await expect(alert).toContainText(`Their reason: “${said}”`);
  await expect(alert).toContainText("You can't rejoin it.");
  await expect(alert.locator('b, strong, em')).toHaveCount(0);
  // The server agrees: the removed member's owner cannot join again, even with a fresh link.
  const fresh = await host.request.post(`/api/rooms/${room.id}/link/rotate`, {
    headers,
    data: { idempotency_key: crypto.randomUUID() },
  });
  expect(fresh.ok()).toBe(true);
  const minted = await host.request.post(`/api/rooms/${room.id}/link`, { headers, data: {} });
  const token = new URL((await minted.json()).link as string).hash.slice(1);
  const again = await guest.request.post(`/api/rooms/${room.id}/join`, {
    headers,
    data: { token, create: { name: 'Guest again' }, idempotency_key: crypto.randomUUID() },
  });
  expect(again.status()).toBe(403);
  expect(host.errors).toEqual([]);
  expect(guest.errors).toEqual([]);
  await host.context.close();
  await guest.context.close();
});

/** The host's row menu in the Members panel: "Actions for <name>", then Mute, Unmute or Remove. */
async function memberAction(members: Locator, name: string, action: 'Mute' | 'Unmute' | 'Remove') {
  await members.getByRole('button', { name: `Actions for ${name}` }).click();
  await members
    .getByRole('menu', { name: `Actions for ${name}` })
    .getByRole('menuitem', { name: action, exact: true })
    .click();
}

/** The actions the host's row menu offers for a member (the menu is closed again after). */
async function memberActions(members: Locator, name: string) {
  await members.getByRole('button', { name: `Actions for ${name}` }).click();
  const menu = members.getByRole('menu', { name: `Actions for ${name}` });
  await expect(menu).toBeVisible();
  const items = await menu.getByRole('menuitem').allTextContents();
  await menu.press('Escape');
  await expect(menu).toHaveCount(0);
  return items;
}

async function openMembers(page: Page) {
  await page.getByRole('button', { name: /^Members of / }).click();
  const panel = page.getByRole('complementary', { name: 'Members' });
  await expect(panel).toBeVisible();
  return panel;
}

test('host mutes a member: "Muted" shows, they read the muted notice instead of a composer; unmute lets them post', async ({
  browser,
}) => {
  const host = await account(browser, 'Host');
  const room = await hostRoom(host, 'Mute plan');
  const guest = await account(browser, 'Guest');
  await join(guest, room, 'Guest agent');

  await host.page.goto(`/rooms/${room.id}`);
  const members = await openMembers(host.page);
  const guestRow = members.getByTestId('member-row').filter({ hasText: 'Guest agent' });
  // Nobody mutes the host (or themselves): the host's row has no actions at all.
  await expect(members.getByRole('button', { name: 'Actions for Host agent' })).toHaveCount(0);
  await expect(guestRow.getByText('Muted', { exact: true })).toHaveCount(0);
  expect(await memberActions(members, 'Guest agent')).toEqual([
    'Message privately',
    'Mute',
    'Remove',
  ]);

  const sent = host.page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith(`/rooms/${room.id}/mute`),
  );
  await memberAction(members, 'Guest agent', 'Mute');
  expect((await sent).postDataJSON()).toMatchObject({ muted: true });
  await expect(guestRow.getByText('Muted', { exact: true })).toBeVisible();
  expect(await memberActions(members, 'Guest agent')).toEqual([
    'Message privately',
    'Unmute',
    'Remove',
  ]);
  // No confirmation opened.
  await expect(members.getByRole('group')).toHaveCount(0);

  // The muted member opens the room: the host's notice stands where the composer was, in plain
  // words (src/rooms/muteView.ts), so there is nothing to type that the server would refuse.
  await guest.page.goto(`/rooms/${room.id}`);
  await expect(guest.page.getByTestId('room-muted')).toHaveText(
    'The host muted you in this room. You can still read, but not post.',
  );
  await expect(guest.page.getByLabel('Message', { exact: true })).toHaveCount(0);
  // No raw code or status. "403" only as a word: a random name on the page (Guest-5a403c1e) may
  // hold those digits.
  await expect(guest.page.getByText(/muted_in_room|\b403\b/)).toHaveCount(0);

  // A member who does not host sees no Mute (and no Remove).
  const guestMembers = await openMembers(guest.page);
  await expect(guestMembers.getByRole('button', { name: /^(Mute|Unmute|Remove) / })).toHaveCount(0);
  await expect(guestMembers.getByRole('button', { name: /^Actions for / })).toHaveCount(0);
  await expect(guestMembers.getByText('Muted', { exact: true })).toHaveCount(0);

  // Unmute: the label goes, and the same message now posts.
  await memberAction(members, 'Guest agent', 'Unmute');
  await expect(guestRow.getByText('Muted', { exact: true })).toHaveCount(0);
  expect(await memberActions(members, 'Guest agent')).toEqual([
    'Message privately',
    'Mute',
    'Remove',
  ]);
  // Unmuted, the guest's room view gets its composer back and the message posts.
  await guest.page.reload();
  await expect(guest.page.getByTestId('room-muted')).toHaveCount(0);
  const box = guest.page.getByLabel('Message', { exact: true });
  await box.fill('Can anyone hear me?');
  await box.press('Enter');
  await expect(guest.page.getByText(/^Not sent\./)).toHaveCount(0);
  await expect(guest.page.getByTestId('room-message-pending')).toHaveCount(0);
  const listed = await host.request.get(`/api/rooms/${room.id}/messages`);
  expect(
    ((await listed.json()).messages as { text: string }[]).filter(
      (message) => message.text === 'Can anyone hear me?',
    ),
  ).toHaveLength(1);
  expect(host.errors).toEqual([]);
  expect(guest.errors).toEqual([]);
  await host.context.close();
  await guest.context.close();
});

const RED_LIGHT = 'rgb(217, 45, 32)';
// Quiet red text on the v3 sheet (End room's confirm, Delete): the sheet's danger token.
const SHEET_RED_LIGHT = 'rgb(220, 38, 38)';
const style = (locator: ReturnType<Page['locator']>) =>
  locator.evaluate((element) => {
    const computed = getComputedStyle(element);
    return {
      background: computed.backgroundColor,
      color: computed.color,
      weight: computed.fontWeight,
      opacity: computed.opacity,
      cursor: computed.cursor,
    };
  });

test('End and Delete use quiet red rows; the typed confirmation keeps the filled red; Cancel stays neutral', async ({
  browser,
}) => {
  const host = await account(browser, 'Host', { width: 1440, height: 900 });
  const room = await hostRoom(host, 'Red plan');
  const guest = await account(browser, 'Guest');
  await join(guest, room, 'Guest agent');
  await host.page.emulateMedia({ colorScheme: 'light' });
  await host.page.goto(`/rooms/${room.id}`);
  const panel = await openSettings(host.page);

  // Workspace v3: End room and Delete are quiet rows on the sheet itself — red text, never a
  // filled block; the sheet's primary action is Done.
  const end = panel.getByRole('button', { name: 'End room' });
  expect((await style(end)).background).not.toBe(RED_LIGHT);
  const done = panel.getByRole('button', { name: 'Done', exact: true });
  const doneHeight = (await done.boundingBox())!.height;
  const endHeight = (await end.boundingBox())!.height;
  expect(endHeight).toBeLessThan(doneHeight);
  const del = panel.getByRole('button', { name: 'Delete', exact: true });
  // Delete's text is the same red as its row's warning line (the sheet's danger token).
  const warning = panel.locator('.rm-settings-danger-text');
  expect((await style(del)).color).toBe((await style(warning)).color);
  expect((await style(del)).background).not.toBe(RED_LIGHT);
  expect((await del.boundingBox())!.height).toBeLessThan(doneHeight);

  // Delete: the typed confirmation keeps the filled red button, disabled until the exact name.
  await del.click();
  const form = panel.getByRole('form', { name: 'Delete this room' });
  const submit = form.getByRole('button', { name: 'Delete room' });
  await expect(submit).toBeDisabled();
  expect(await style(submit)).toMatchObject({
    background: RED_LIGHT,
    opacity: '0.4',
    cursor: 'not-allowed',
  });
  await form.getByLabel('Room name to confirm').fill('Red plan');
  await expect(submit).toBeEnabled();
  expect(await style(submit)).toMatchObject({ background: RED_LIGHT, opacity: '1' });
  const cancel = form.getByRole('button', { name: 'Cancel' });
  expect((await style(cancel)).background).not.toBe(RED_LIGHT);
  await cancel.click();

  // End room keeps its confirm step, back on its quiet row.
  await panel.getByRole('button', { name: 'End room' }).click();
  const confirmClose = panel.getByRole('button', { name: 'Confirm close' });
  expect((await style(confirmClose)).color).toBe(SHEET_RED_LIGHT);
  // The confirm row's Cancel (the sheet's footer has its own Cancel further down).
  await panel.getByRole('button', { name: 'Cancel' }).first().click();
  await expect(panel.getByRole('button', { name: 'End room' })).toBeVisible();

  // The member Remove confirmation uses the filled red.
  await moreSettings(panel);
  await panel.getByRole('button', { name: /Manage members/ }).click();
  const members = host.page.getByRole('complementary', { name: 'Members' });
  await memberAction(members, 'Guest agent', 'Remove');
  const remove = members
    .getByRole('group', { name: "Remove Guest agent? They can't rejoin." })
    .getByRole('button', { name: 'Remove', exact: true });
  expect(await style(remove)).toMatchObject({ background: RED_LIGHT, color: 'rgb(255, 255, 255)' });
  expect(host.errors).toEqual([]);
  await host.context.close();
  await guest.context.close();
});

test('removing a guest offers to reset the invite link (off by default); checked, it rotates', async ({
  browser,
}) => {
  const host = await account(browser, 'Host');
  const room = await hostRoom(host, 'Guest plan');
  const guest = await account(browser, 'Guest');
  await join(guest, room, 'Guest agent');
  const other = await account(browser, 'Other');
  await join(other, room, 'Other agent');
  // Mark one member as a guest without an account, as the server reports it.
  await host.page.route(`**/api/rooms/${room.id}/members*`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    for (const member of body.members as { name: string; guest?: boolean }[])
      if (member.name === 'Guest agent') member.guest = true;
    await route.fulfill({ response, json: body });
  });
  await host.page.goto(`/rooms/${room.id}`);
  const members = await openMembers(host.page);

  // A member with an account: no link option.
  await memberAction(members, 'Other agent', 'Remove');
  const otherConfirm = members.getByRole('group', {
    name: "Remove Other agent? They can't rejoin.",
  });
  await expect(otherConfirm.getByRole('checkbox')).toHaveCount(0);
  await otherConfirm.getByRole('button', { name: 'Cancel' }).click();

  await memberAction(members, 'Guest agent', 'Remove');
  const confirm = members.getByRole('group', { name: "Remove Guest agent? They can't rejoin." });
  const reset = confirm.getByLabel('Also reset the invite link');
  await expect(reset).not.toBeChecked();
  await expect(
    confirm.getByText("Others on the same network can't join this room as guests for 30 days."),
  ).toBeVisible();
  await reset.check();
  const rotated = host.page.waitForRequest(
    (request) =>
      request.method() === 'POST' && request.url().endsWith(`/rooms/${room.id}/link/rotate`),
  );
  await confirm.getByRole('button', { name: 'Remove', exact: true }).click();
  const rotation = await rotated;
  expect(typeof rotation.postDataJSON().idempotency_key).toBe('string');
  expect((await rotation.response())!.ok()).toBe(true);
  // The host agent, the host's own person (A1) and the member who stays.
  await expect(members.getByTestId('member-row')).toHaveCount(3);
  await expect(members.getByRole('alert')).toHaveCount(0);
  // The earlier link no longer admits anyone.
  const late = await account(browser, 'Late');
  const refused = await late.request.post(`/api/rooms/${room.id}/join`, {
    headers,
    data: {
      token: room.token,
      create: { name: 'Late agent' },
      idempotency_key: crypto.randomUUID(),
    },
  });
  expect(refused.ok()).toBe(false);
  expect(host.errors).toEqual([]);
  for (const owner of [host, guest, other, late]) await owner.context.close();
});

test('members who recently left are only listed: no Remove or other action', async ({
  browser,
}) => {
  const host = await account(browser, 'Host');
  const room = await hostRoom(host, 'Left plan');
  const guest = await account(browser, 'Guest');
  await join(guest, room, 'Guest agent');
  const left = await guest.request.post(`/api/rooms/${room.id}/leave`, { headers, data: {} });
  expect(left.ok()).toBe(true);

  await host.page.goto(`/rooms/${room.id}`);
  const members = await openMembers(host.page);
  const recent = members.getByRole('list', { name: 'Recently left' });
  await expect(recent.getByRole('listitem').filter({ hasText: 'Guest agent' })).toBeVisible();
  await expect(recent.getByRole('button')).toHaveCount(0);
  expect(host.errors).toEqual([]);
  await host.context.close();
  await guest.context.close();
});

test('delete needs the exact room name, then leaves for /rooms and the room is gone', async ({
  browser,
}) => {
  const host = await account(browser, 'Host');
  const room = await hostRoom(host, 'Doomed plan');
  await host.page.goto(`/rooms/${room.id}`);
  const panel = await openSettings(host.page);
  await panel.getByRole('button', { name: 'Delete', exact: true }).click();
  const form = panel.getByRole('form', { name: 'Delete this room' });
  await expect(form).toContainText('messages, tasks and files are erased');
  const typed = form.getByLabel('Room name to confirm');
  await expect(typed).toBeFocused();
  const remove = form.getByRole('button', { name: 'Delete room' });
  await expect(remove).toBeDisabled();
  await typed.fill('doomed plan');
  await expect(remove).toBeDisabled();
  await typed.fill('Doomed plan ');
  await expect(remove).toBeDisabled();
  // Cancel keeps the room.
  await form.getByRole('button', { name: 'Cancel' }).click();
  await expect(form).toHaveCount(0);
  await panel.getByRole('button', { name: 'Delete', exact: true }).click();
  await panel.getByLabel('Room name to confirm').fill('Doomed plan');
  await expect(remove).toBeEnabled();
  await remove.click();

  await expect(host.page).toHaveURL(/\/rooms$/);
  await expect(host.page.getByRole('link', { name: /Doomed plan/ })).toHaveCount(0);
  const rooms = await host.request.get('/api/rooms');
  expect(((await rooms.json()).rooms as { id: string }[]).map((item) => item.id)).not.toContain(
    room.id,
  );
  expect(host.errors).toEqual([]);
  await host.context.close();
});

test('the Room settings sheet is a modal dialog; closing it returns focus to More room actions', async ({
  browser,
}) => {
  const host = await account(browser, 'Host', { width: 1440, height: 900 });
  const room = await hostRoom(host, 'Focus plan');
  await host.page.goto(`/rooms/${room.id}`);
  const more = host.page
    .locator('.rm-room-head')
    .getByRole('button', { name: 'More room actions' });
  // Escape closes it; focus lands on the ⋯ button (the menu item that opened it is gone).
  let sheet = await openSettings(host.page);
  await expect(sheet).toHaveAttribute('aria-modal', 'true');
  await expect(sheet.locator(':focus')).toHaveCount(1);
  await host.page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(more).toBeFocused();
  // The round Close button does the same.
  sheet = await openSettings(host.page);
  await sheet.getByRole('button', { name: 'Close settings' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(more).toBeFocused();
  expect(host.errors).toEqual([]);
  await host.context.close();
});

test('a member who does not host sees only Members; Manage members opens the Members panel', async ({
  browser,
}) => {
  const host = await account(browser, 'Host');
  const room = await hostRoom(host, 'Shared plan');
  const guest = await account(browser, 'Guest');
  await join(guest, room, 'Guest agent');
  await guest.page.goto(`/rooms/${room.id}`);
  const panel = await openSettings(guest.page);
  await expect(panel.getByRole('button', { name: /Manage members/ })).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'General' })).toHaveCount(0);
  await expect(panel.getByLabel('Room name')).toHaveCount(0);
  await expect(panel.getByText('More settings', { exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Danger zone' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: /^(Delete|End room)$/ })).toHaveCount(0);
  await expect(panel.getByLabel('What this room is for')).toHaveAttribute('readonly', '');
  await panel.getByRole('button', { name: /Manage members/ }).click();
  await expect(guest.page.getByRole('complementary', { name: 'Members' })).toBeVisible();
  await expect(guest.page.getByRole('dialog', { name: 'Room settings' })).toHaveCount(0);
  expect(guest.errors).toEqual([]);
  await host.context.close();
  await guest.context.close();
});

test('screenshots: settings panel and delete confirmation at 1440 and 390, light', async ({
  browser,
}) => {
  // Evidence only: runs with ROOM_SETTINGS_SHOTS=<directory>.
  const dir = process.env.ROOM_SETTINGS_SHOTS;
  test.skip(!dir, 'screenshots run with ROOM_SETTINGS_SHOTS=<directory>');
  for (const width of [1440, 390]) {
    const host = await account(browser, 'Ana', { width, height: width > 600 ? 900 : 844 });
    const room = await hostRoom(host, 'Launch plan');
    await host.page.emulateMedia({ colorScheme: 'light' });
    await host.page.goto(`/rooms/${room.id}`);
    const panel = await openSettings(host.page);
    await panel.getByLabel('What this room is for').fill('Ship the beta by Friday. Be kind.');
    await host.page.screenshot({ path: `${dir}/settings-${width}.png` });
    await panel.getByRole('button', { name: 'Delete', exact: true }).click();
    await panel.getByLabel('Room name to confirm').fill('Launch');
    await panel.getByRole('form', { name: 'Delete this room' }).scrollIntoViewIfNeeded();
    await host.page.screenshot({ path: `${dir}/delete-confirm-${width}.png` });
    await host.context.close();
  }
});

/**
 * Adds guest_blocks to this room's view (room list and message pages), as the host's console
 * reports it after removing guests without an account; real blocks need the invite-link guest
 * flow. `count()` is read per response, so a test can drop it to 0 after Clear.
 */
async function withGuestBlocks(page: Page, roomId: string, count: () => number) {
  const patch = (value: { id?: string; guest_blocks?: number }) => {
    if (value?.id === roomId) value.guest_blocks = count();
  };
  await page.route(/\/api\/rooms(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    for (const room of (body.rooms ?? []) as { id?: string }[]) patch(room);
    await route.fulfill({ response, json: body });
  });
  await page.route(`**/api/rooms/${roomId}/messages*`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    if (body.room) patch(body.room);
    await route.fulfill({ response, json: body });
  });
}

test('host sees blocked guest networks and clears them; members never see the row', async ({
  browser,
}) => {
  const host = await account(browser, 'Host');
  const room = await hostRoom(host, 'Guest blocks');
  const member = await account(browser, 'Member');
  await join(member, room, 'Member agent');
  let blocks = 2;
  await withGuestBlocks(host.page, room.id, () => blocks);
  await host.page.goto(`/rooms/${room.id}`);
  const panel = await openSettings(host.page);
  await moreSettings(panel);
  await expect(panel.getByText('2 networks blocked', { exact: true })).toBeVisible();
  await expect(
    panel.getByText("Guest AIs you removed can't rejoin from these networks for 30 days."),
  ).toBeVisible();

  // Clear asks once more; Cancel keeps the row.
  await panel.getByRole('button', { name: 'Clear', exact: true }).click();
  const confirm = panel.getByRole('group', { name: 'Clear blocks?' });
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(panel.getByText('2 networks blocked', { exact: true })).toBeVisible();

  // Confirm calls the real endpoint (host only), then the row goes away.
  await panel.getByRole('button', { name: 'Clear', exact: true }).click();
  const cleared = host.page.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' &&
      response.url().endsWith(`/api/rooms/${room.id}/guest-blocks`),
  );
  await panel
    .getByRole('group', { name: 'Clear blocks?' })
    .getByRole('button', { name: 'Confirm' })
    .click();
  const response = await cleared;
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ room_id: room.id, cleared: 0 });
  blocks = 0;
  await expect(panel.getByRole('status').filter({ hasText: 'Blocks cleared' })).toBeVisible();
  await expect(panel.getByText(/networks? blocked/)).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Clear', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('alert')).toHaveCount(0);

  // One block reads in the singular.
  blocks = 1;
  await host.page.reload();
  const again = await openSettings(host.page);
  await moreSettings(again);
  await expect(again.getByText('1 network blocked', { exact: true })).toBeVisible();

  // A member who doesn't host never sees the row, even if the view carried a count.
  await withGuestBlocks(member.page, room.id, () => 2);
  await member.page.goto(`/rooms/${room.id}`);
  const memberPanel = await openSettings(member.page);
  await expect(memberPanel.getByRole('heading', { name: 'Members' })).toBeVisible();
  await expect(memberPanel.getByText(/networks? blocked/)).toHaveCount(0);
  await expect(memberPanel.getByRole('button', { name: 'Clear', exact: true })).toHaveCount(0);
  // The server refuses a member's clear.
  const refused = await member.request.delete(`/api/rooms/${room.id}/guest-blocks`, {
    headers: { ...headers, 'Content-Type': 'application/json' },
    data: {},
  });
  expect(refused.ok()).toBe(false);
  expect(host.errors).toEqual([]);
  expect(member.errors).toEqual([]);
  await host.context.close();
  await member.context.close();
});

test('screenshots: members panel with a muted member, recently left and remove, 1440 and 390', async ({
  browser,
}) => {
  // Evidence only: runs with ROOM_SETTINGS_SHOTS=<directory>.
  const dir = process.env.ROOM_SETTINGS_SHOTS;
  test.skip(!dir, 'screenshots run with ROOM_SETTINGS_SHOTS=<directory>');
  for (const width of [1440, 390]) {
    const host = await account(browser, 'Ana', { width, height: width > 600 ? 900 : 844 });
    const room = await hostRoom(host, 'Launch plan');
    const ben = await account(browser, 'Ben');
    await join(ben, room, 'Research agent');
    const cleo = await account(browser, 'Cleo');
    await join(cleo, room, 'Writer agent');
    const dev = await account(browser, 'Dev');
    await join(dev, room, 'Review agent');
    await dev.request.post(`/api/rooms/${room.id}/leave`, { headers, data: {} });
    await host.page.emulateMedia({ colorScheme: 'light' });
    await host.page.goto(`/rooms/${room.id}`);
    const members = await openMembers(host.page);
    await memberAction(members, 'Writer agent', 'Mute');
    await expect(members.getByText('Muted', { exact: true })).toBeVisible();
    await expect(members.getByText('Recently left')).toBeVisible();
    await host.page.screenshot({ path: `${dir}/members-${width}.png` });
    await memberAction(members, 'Research agent', 'Remove');
    await members.getByLabel('Reason (shown to the removed member)').fill('Off-topic posts');
    await host.page.screenshot({ path: `${dir}/members-remove-confirm-${width}.png` });
    for (const owner of [host, ben, cleo, dev]) await owner.context.close();
  }
});
