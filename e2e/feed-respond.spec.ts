import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { FeedResponseSent, PublicFeedRequest } from '../shared/feed';
import { lowContrast } from './contrast';
import {
  mockFeed,
  mockRequestInbox,
  mockRespond,
  requestInvitation,
  sampleRequests,
} from './feed-fixtures';

/*
 * Feed Respond in the browser (docs/FEED_RESPOND.md): the responder's invitation sheet on a
 * signed-in request, the poster's response count, and the poster's card in Messages. The Feed's
 * routes (and Respond's) are mocked (e2e/feed-fixtures.ts) because the test server runs with
 * CITY_FEED=0; the account, its agents (paused ones too), its rooms (closed ones too), the session
 * and the Messages summary are the real test server. "Flag off" leaves Respond's routes to the
 * real server, which answers them 404 with the Feed off. The same client against the real Respond
 * routes with the Feed on: tests/feed-respond-client-app.test.ts.
 */

const headers = { 'x-city-request': '1' };
/** The test accounts' sign-in words (the test server only). */
const LOCAL_WORDS = 'Local-test-only-passphrase-2026';
const ARROWS = /[←-⇿➔-➿⤀-⥿⬀-⯿«»‹›]/;
const MACHINE_TEXT = /city_[a-z]|[{}]|idempoten|_open|_request|_required/i;
/** A request posted signed in, with a reply handle (the invitation, then the handle below). */
const SIGNED_IN_ID = 'req_eeeeeeeeeeeeeeeeeee2';
/** A request posted by an agent of another account, without a reply handle. */
const AGENT_ID = 'req_ccccccccccccccccccc4';

async function signIn(page: Page) {
  const created = await page.request.post('/api/auth/register', {
    headers,
    data: { name: `Respond ${randomUUID().slice(0, 8)}`, password: LOCAL_WORDS },
  });
  expect(created.status()).toBe(201);
}

async function addAgent(page: Page, name: string) {
  const response = await page.request.post('/api/agents', {
    headers,
    data: { name, description: 'Does the work', capability: 'research', mode: 'external' },
  });
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { agent: { id: string; name: string } }).agent;
}

async function hostRoom(page: Page, agentId: string, name: string) {
  const response = await page.request.post('/api/rooms', {
    headers,
    data: { agent_id: agentId, name, idempotency_key: randomUUID() },
  });
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { room: { id: string; name: string } }).room;
}

/** The real server closes the room (its host). */
async function closeRoom(page: Page, roomId: string) {
  const response = await page.request.post(`/api/rooms/${roomId}/close`, { headers, data: {} });
  expect(response.ok()).toBeTruthy();
}

/** The real server pauses the agent (My agents' Pause). */
async function pauseAgent(page: Page, agentId: string) {
  const response = await page.request.post(`/api/agents/${agentId}/pause`, { headers, data: {} });
  expect(response.ok()).toBeTruthy();
}

function requests(now = Date.now()): PublicFeedRequest[] {
  return [
    {
      id: SIGNED_IN_ID,
      title: 'Clean up a CSV of 3,000 contacts',
      description: 'Remove duplicates and fix the country names.',
      capabilities: ['csv'],
      budget: null,
      deadline: null,
      reply: 'https://example.com/csv-contact',
      postedBy: { kind: 'account', displayName: null },
      status: 'open',
      createdAt: now - 3_600_000,
      expiresAt: now + 14 * 86_400_000,
      closedAt: null,
    },
    ...sampleRequests(now),
  ];
}

async function plainText(page: Page, root: string) {
  const text = await page.locator(root).evaluate((node) => (node as HTMLElement).innerText);
  const hit = MACHINE_TEXT.exec(text);
  expect(hit ? text.slice(Math.max(0, hit.index - 60), hit.index + 60) : null).toBeNull();
  expect(ARROWS.exec(text)?.[0] ?? null).toBeNull();
}

const fits = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

async function openRespond(page: Page, id = SIGNED_IN_ID) {
  await page.goto(`/feed/requests/${id}`);
  const sheet = page.locator('.fd-detail');
  await sheet.getByRole('button', { name: 'Respond' }).click();
  return sheet;
}

test('Respond on a signed-in request: room, agent and note, then Sent and Already sent', async ({
  page,
}) => {
  await signIn(page);
  const scout = await addAgent(page, 'Scout');
  const room = await hostRoom(page, scout.id, 'Contacts desk');
  await mockFeed(page, { requests: requests() });
  const fake = await mockRespond(page);
  const sheet = await openRespond(page);

  const invite = sheet.getByRole('region', { name: 'Invite them to a room' });
  const form = invite.getByRole('form', { name: 'Invite the poster to a room' });
  await expect(form.getByLabel('Room')).toHaveValue(room.id);
  await expect(form.getByLabel('Room').locator('option')).toHaveText([
    'Contacts desk',
    'New room: Clean up a CSV of 3,000 contacts',
  ]);
  await expect(form.getByLabel('Respond as')).toHaveValue(scout.id);
  await expect(form.getByLabel('Respond as')).toHaveAccessibleDescription(
    'The poster sees this agent’s name, the room’s name and how many are in it.',
  );
  await form.getByLabel(/^Note/).fill('We clean CSVs every day.');
  await expect(form.locator('.fd-count')).toHaveText('24/1000 characters');
  // The reply handle stays below the invitation, as unverified text.
  const direct = sheet.getByRole('region', { name: 'Or reach the poster' });
  await expect(direct).toContainText('https://example.com/csv-contact');
  await expect(direct).toContainText('unverified, given by the poster');
  await expect(direct.locator('a[href^="https://example"]')).toHaveCount(0);
  await plainText(page, '.fd-detail');

  await form.getByRole('button', { name: 'Send' }).click();
  const done = invite.getByRole('status');
  await expect(done).toContainText('Sent. If they accept, their agent joins your room.');
  await expect(done).toBeFocused();
  expect(fake.sends).toHaveLength(1);
  const sent = fake.sends[0]!;
  expect(sent.id).toBe(SIGNED_IN_ID);
  expect(sent.headers['x-city-request']).toBe('1');
  expect(sent.body).toMatchObject({
    roomId: room.id,
    fromAgentId: scout.id,
    note: 'We clean CSVs every day.',
  });
  expect(sent.body.idempotencyKey.length).toBeGreaterThanOrEqual(8);
  expect(sent.body).not.toHaveProperty('newRoom');

  // The same room again: Already sent, with Withdraw instead of Send.
  await invite.getByRole('button', { name: 'Respond from another room' }).click();
  await expect(form.getByText('Already sent')).toBeVisible();
  await expect(form.getByRole('button', { name: 'Send' })).toBeHidden();
  await form.getByRole('button', { name: 'Withdraw' }).click();
  await expect.poll(() => fake.withdraws.length).toBe(1);
  // Withdrawn: said in a status line that takes focus; Send is back for this room.
  const withdrawn = form.getByRole('status').filter({ hasText: 'Withdrawn.' });
  await expect(withdrawn).toHaveText('Withdrawn. It left their Messages.');
  await expect(withdrawn).toBeFocused();
  await expect(form.getByRole('button', { name: 'Send' })).toBeVisible();
  await expect(form.getByText('Already sent')).toHaveCount(0);

  // Back returns to the details.
  await sheet.getByRole('button', { name: 'Back' }).click();
  await expect(sheet.getByRole('button', { name: 'Respond' })).toBeVisible();
});

test('a new room named after the request, from any of your agents that is not paused', async ({
  page,
}) => {
  await signIn(page);
  const scout = await addAgent(page, 'Scout');
  const relay = await addAgent(page, 'Relay');
  const resting = await addAgent(page, 'Resting');
  await pauseAgent(page, resting.id);
  await mockFeed(page, { requests: requests() });
  const fake = await mockRespond(page);
  const sheet = await openRespond(page, AGENT_ID);
  // No rooms hosted: New room is the only choice; no reply handle, so no handle section.
  const form = sheet.getByRole('form', { name: 'Invite the poster to a room' });
  await expect(form.getByLabel('Room')).toHaveValue('new');
  await expect(form.getByLabel('Room').locator('option')).toHaveText([
    'New room: Translate a product page into Italian',
  ]);
  await expect(sheet.getByRole('region', { name: 'Or reach the poster' })).toHaveCount(0);
  // The paused agent can't start a room (the server refuses it), so it is not offered.
  await expect(form.getByLabel('Respond as').locator('option')).toHaveText(['Scout', 'Relay']);
  await form.getByLabel('Respond as').selectOption(relay.id);
  await form.getByRole('button', { name: 'Send' }).click();
  await expect(sheet.getByRole('status')).toContainText('Sent.');
  expect(fake.sends[0]!.body).toMatchObject({ newRoom: true, fromAgentId: relay.id, note: '' });
  expect(fake.sends[0]!.body).not.toHaveProperty('roomId');
  expect(scout.id).not.toBe(relay.id);
});

test('refusals: Already sent from another tab, too many tries, a note too long', async ({
  page,
}) => {
  await signIn(page);
  const scout = await addAgent(page, 'Scout');
  const room = await hostRoom(page, scout.id, 'Contacts desk');
  await mockFeed(page, { requests: requests() });
  const fake = await mockRespond(page, {
    sendFailures: [
      { status: 429, retryAfterSeconds: 120, error: 'Too many.' },
      { status: 409, code: 'response_open' },
    ],
  });
  const sheet = await openRespond(page);
  const form = sheet.getByRole('form', { name: 'Invite the poster to a room' });
  await expect(form.getByLabel('Room')).toHaveValue(room.id);

  // Too long: said before sending, nothing sent.
  await form.getByLabel(/^Note/).fill('a'.repeat(1001));
  await expect(form.getByLabel(/^Note/)).toHaveAttribute('aria-invalid', 'true');
  await form.getByRole('button', { name: 'Send' }).click();
  await expect(form.getByRole('alert')).toHaveText('Keep the note to 1,000 characters.');
  expect(fake.sends).toHaveLength(0);
  await form.getByLabel(/^Note/).fill('Short note.');
  await expect(form.getByRole('alert')).toHaveCount(0);

  await form.getByRole('button', { name: 'Send' }).click();
  await expect(form.getByRole('alert')).toHaveText(
    'Too many responses right now. Try again in about 2 minutes.',
  );
  const firstKey = fake.sends[0]!.body.idempotencyKey;
  await form.getByRole('button', { name: 'Send' }).click();
  await expect(form.getByRole('alert')).toHaveText(
    'Already sent from this room. You can send from another room.',
  );
  // A retry of the same response keeps its key.
  expect(fake.sends[1]!.body.idempotencyKey).toBe(firstKey);
  await plainText(page, '.fd-detail');
});

test('a session that ended: Sign in to respond (the Feed’s own button), nothing else', async ({
  page,
}) => {
  await signIn(page);
  await mockFeed(page, { requests: requests() });
  await mockRespond(page, { signedOut: true });
  const sheet = await openRespond(page);
  await expect(sheet.getByText('Your session ended. Sign in again to respond.')).toBeVisible();
  const button = sheet.getByRole('button', { name: 'Sign in to respond' });
  await expect(button).toBeVisible();
  await expect(sheet.getByRole('link', { name: 'Sign in to respond' })).toHaveCount(0);
  await expect(sheet.getByRole('button', { name: 'Send' })).toHaveCount(0);
  // The session is really gone now: the button asks for sign-in at the same address.
  await page.context().clearCookies();
  await button.click();
  await expect(
    page.getByText('Sign in to respond to this request.', { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/feed/requests/${SIGNED_IN_ID}$`));
});

test('signed out, every request posted signed in offers Sign in to respond; nobody responds signed out', async ({
  page,
}) => {
  await mockFeed(page, { requests: requests() });
  const fake = await mockRespond(page);
  // With a reply handle, and without one (posted by an agent): both can be answered.
  for (const id of [SIGNED_IN_ID, AGENT_ID]) {
    await page.goto(`/feed/requests/${id}`);
    const details = page.locator('.fd-detail');
    await expect(details.getByRole('button', { name: 'Sign in to respond' })).toBeVisible();
    await expect(details.getByRole('button', { name: 'Sign in to report' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Respond', exact: true })).toHaveCount(0);
  }
  await page.locator('.fd-detail').getByRole('button', { name: 'Sign in to respond' }).click();
  await expect(
    page.getByText('Sign in to respond to this request.', { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/feed/requests/${AGENT_ID}$`));
  expect(fake.countReads).toEqual([]);
  expect(fake.sends).toEqual([]);
});

test('an anonymous request keeps the reply-handle guide, with no invitation', async ({ page }) => {
  await signIn(page);
  await mockFeed(page, { requests: requests() });
  const fake = await mockRespond(page);
  const sheet = await openRespond(page, 'req_aaaaaaaaaaaaaaaaaaa2');
  await expect(sheet.getByRole('region', { name: 'Reach the poster' })).toContainText(
    'Start a room',
  );
  await expect(sheet.getByRole('form', { name: 'Invite the poster to a room' })).toHaveCount(0);
  // An anonymous request has no poster count to ask for.
  expect(fake.countReads).not.toContain('req_aaaaaaaaaaaaaaaaaaa2');
});

test('the poster alone sees “N responses”, on Yours and in the details', async ({ page }) => {
  await signIn(page);
  await mockFeed(page, { requests: requests() });
  const fake = await mockRespond(page, {
    counts: {
      req_ddddddddddddddddddd5: { open: 2, accepted: 1 },
      // Posted from this account in an earlier visit: the count says it is theirs.
      [SIGNED_IN_ID]: { open: 1, accepted: 0 },
    },
  });
  await page.goto('/feed/requests');
  await page.getByRole('button', { name: 'Post a request' }).click();
  const form = page.getByRole('form', { name: 'Post a request' });
  await form.getByLabel('What do you need?').fill('Check 200 links on our docs site');
  await form.getByLabel(/^Details/).fill('Report every broken link with the page it is on.');
  await form.getByRole('button', { name: 'Post request' }).click();
  await page.getByRole('button', { name: 'See your request' }).click();
  const cards = page.getByRole('list', { name: 'Requests' }).locator('> li');
  const yours = cards.filter({ hasText: 'Yours' });
  await expect(yours.locator('.fd-resp')).toHaveText('3 responses');
  // Nobody else's card has a count.
  await expect(page.locator('.fd-resp')).toHaveCount(1);
  await yours.getByRole('button').click();
  const details = page.getByRole('dialog');
  await expect(details.locator('.fd-resp-count')).toContainText('3 responses');
  await expect(details.locator('.fd-resp-count')).toContainText('1 accepted.');
  await expect(details.getByRole('link', { name: 'Answer in Messages' })).toHaveAttribute(
    'href',
    '/messages',
  );
  await expect(details.getByRole('button', { name: 'Respond' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Someone else's request: asked once, answered 404, so no count and Respond as usual.
  await cards.filter({ hasText: 'Translate a product page' }).getByRole('button').click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Respond' })).toBeVisible();
  await expect(page.getByRole('dialog').locator('.fd-resp-count')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Posted in an earlier visit: the details show the count, and Respond is not offered.
  await page.goto(`/feed/requests/${SIGNED_IN_ID}`);
  await expect(page.locator('.fd-resp-count')).toContainText('1 response');
  await expect(page.getByRole('button', { name: 'Respond', exact: true })).toHaveCount(0);
  expect(fake.countReads).toContain(SIGNED_IN_ID);
  await page.getByRole('link', { name: 'Answer in Messages' }).click();
  // Messages opens in the workspace (its address is the workspace's own, so the heading says it).
  await expect(page.getByRole('heading', { level: 1, name: 'Messages' })).toBeVisible();
});

// -------------------------------------------------------------------------------------------
// Messages: the poster's cards

async function openMessages(page: Page) {
  await page.goto('/messages');
  await expect(page.getByRole('heading', { level: 1, name: 'Messages' })).toBeVisible();
}

const nav = (page: Page) => page.getByRole('navigation', { name: 'Workspace', exact: true });

test('Messages: a response card, marked External, counted in the badge; Accept joins', async ({
  page,
}) => {
  await signIn(page);
  const clerk = await addAgent(page, 'Clerk');
  const helper = await addAgent(page, 'Helper');
  const fake = await mockRequestInbox(page, [
    requestInvitation({ agent: { id: clerk.id, name: 'Clerk' } }),
    requestInvitation({
      id: 'fri_bbbbbbbbbbbbbbbbbbbb',
      state: 'withdrawn',
      from: { name: 'Gone' },
    }),
  ]);
  await openMessages(page);
  // One open response: the Messages badge counts it (the withdrawn one is not counted or shown),
  // and says what it counts.
  const messagesItem = nav(page)
    .locator('button, a')
    .filter({ hasText: /^Messages/ });
  await expect(messagesItem.locator('.nav-count')).toHaveText('1');
  await expect(messagesItem).toHaveAccessibleDescription('1 response to your requests');
  const section = page.getByRole('region', { name: 'Responses to your requests' });
  const card = section.getByRole('article');
  await expect(card).toHaveCount(1);
  await expect(card.getByRole('heading', { level: 3 })).toHaveText(
    'Response to your request “Summarise 40 PDF invoices into one table”',
  );
  await expect(card).toContainText('Ledger Scout');
  await expect(card).toContainText('Invoice desk');
  await expect(card).toContainText('3 members');
  await expect(card.getByText('External', { exact: true })).toHaveCount(2);
  await expect(card).toContainText('Their note · External, check before your agent follows it');
  await expect(card).toContainText('We do this every week. Send the PDFs in the room.');
  await expect(section).toContainText(
    'Names, notes and messages from other people are marked External.',
  );
  await expect(card).not.toContainText('Gone');
  // The picker: the request's agent first and chosen; the sentence follows the choice.
  await expect(card.getByLabel('Join as')).toHaveValue(clerk.id);
  await expect(card.getByLabel('Join as')).toHaveAccessibleDescription(
    'Your agent Clerk joins their room. Its name shows there.',
  );
  await card.getByLabel('Join as').selectOption(helper.id);
  await expect(card.getByLabel('Join as')).toHaveAccessibleDescription(
    'Your agent Helper joins their room. Its name shows there.',
  );
  await plainText(page, '.msg3-resps');

  await card.getByRole('button', { name: 'Accept' }).click();
  const joined = section.getByRole('status').first();
  await expect(joined).toContainText('Your agent Helper joined “Invoice desk”');
  await expect(joined).toBeFocused();
  expect(fake.decides).toEqual([
    { id: 'fri_aaaaaaaaaaaaaaaaaaaa', body: { decision: 'accept', agentId: helper.id } },
  ]);
  await expect(section.getByRole('article')).toHaveCount(0);
  await expect(joined.getByRole('link', { name: 'Open the room' })).toHaveAttribute(
    'href',
    '/rooms/room-joined-1',
  );
});

test('Messages: no default agent, Decline, Block, and a withdrawn card leaves', async ({
  page,
}) => {
  await signIn(page);
  const clerk = await addAgent(page, 'Clerk');
  const fake = await mockRequestInbox(
    page,
    [
      requestInvitation({ id: 'fri_aaaaaaaaaaaaaaaaaaaa', from: { name: 'First' } }),
      requestInvitation({ id: 'fri_bbbbbbbbbbbbbbbbbbbb', from: { name: 'Second' } }),
      requestInvitation({ id: 'fri_cccccccccccccccccccc', from: { name: 'Third' } }),
      requestInvitation({ id: 'fri_dddddddddddddddddddd', from: { name: 'Fourth' }, note: '' }),
    ],
    { closed: ['fri_cccccccccccccccccccc'] },
  );
  await openMessages(page);
  const section = page.getByRole('region', { name: 'Responses to your requests' });
  const card = (name: string) => section.getByRole('article').filter({ hasText: name });
  await expect(section.getByRole('article')).toHaveCount(4);

  // No default agent: Accept asks to choose one first and sends nothing.
  await expect(card('First').getByLabel('Join as')).toHaveValue('');
  await card('First').getByRole('button', { name: 'Accept' }).click();
  await expect(card('First').getByRole('alert')).toHaveText('Choose which of your agents joins.');
  await expect(card('First').getByLabel('Join as')).toBeFocused();
  expect(fake.decides).toHaveLength(0);
  // A response without a note shows no note block.
  await expect(card('Fourth')).not.toContainText('Their note');

  await card('Second').getByRole('button', { name: 'Decline' }).click();
  await expect(section.getByText('Declined. They aren’t told.')).toBeVisible();
  await expect(card('Second')).toHaveCount(0);
  expect(fake.decides.at(-1)).toEqual({
    id: 'fri_bbbbbbbbbbbbbbbbbbbb',
    body: { decision: 'decline' },
  });

  // Withdrawn meanwhile: the card leaves instead of staying a dead button.
  await card('Third').getByLabel('Join as').selectOption(clerk.id);
  await card('Third').getByRole('button', { name: 'Accept' }).click();
  await expect(section.getByText('That response is no longer open.')).toBeVisible();
  await expect(card('Third')).toHaveCount(0);

  // Block this owner asks first; Cancel changes nothing.
  await card('Fourth').getByRole('button', { name: 'Block this owner' }).click();
  const confirm = page.getByRole('dialog', { name: 'Block this owner?' });
  await expect(confirm).toContainText('They aren’t told.');
  await expect(confirm).toContainText('Blocked owners');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  expect(fake.blocks).toEqual([]);
  await card('Fourth').getByRole('button', { name: 'Block this owner' }).click();
  await page
    .getByRole('dialog', { name: 'Block this owner?' })
    .getByRole('button', { name: 'Block', exact: true })
    .click();
  const blocked = section.getByRole('status').filter({ hasText: 'Blocked.' });
  await expect(blocked).toContainText(
    'Blocked. That owner can’t invite your agents or respond to your requests.',
  );
  await expect(blocked).toContainText('Blocked owners');
  await expect(card('Fourth')).toHaveCount(0);
  expect(fake.blocks).toEqual([
    { agentId: clerk.id, body: { invitationId: 'fri_dddddddddddddddddddd' } },
  ]);
  await expect(section.getByRole('article')).toHaveCount(1);
  // Unblock, right there.
  await blocked.getByRole('button', { name: 'Unblock' }).click();
  await expect(section.getByRole('status').filter({ hasText: 'Unblocked.' })).toBeVisible();
  expect(fake.unblocks).toEqual([
    { agentId: clerk.id, body: { invitationId: 'fri_dddddddddddddddddddd' } },
  ]);
  await plainText(page, '.msg3-resps');
});

// -------------------------------------------------------------------------------------------
// Audit follow-ups: a closed room, the Feed off, a New room retried, Withdraw failing, a request
// in review, paused agents, cards that change while the count stays the same

test('a closed room is never offered: the real room list marks it with closed_at', async ({
  page,
}) => {
  await signIn(page);
  const scout = await addAgent(page, 'Scout');
  const open = await hostRoom(page, scout.id, 'Open desk');
  const closed = await hostRoom(page, scout.id, 'Closed desk');
  await closeRoom(page, closed.id);
  // The real server's list still has it, closed (the shape the sheet reads).
  const listed = (await (await page.request.get('/api/rooms')).json()) as {
    rooms: Array<{ id: string; closed_at: string | null }>;
  };
  expect(listed.rooms.find((room) => room.id === closed.id)?.closed_at).toEqual(expect.any(String));
  expect(listed.rooms.find((room) => room.id === open.id)?.closed_at).toBeNull();
  await mockFeed(page, { requests: requests() });
  const fake = await mockRespond(page);
  const sheet = await openRespond(page);
  const form = sheet.getByRole('form', { name: 'Invite the poster to a room' });
  await expect(form.getByLabel('Room')).toHaveValue(open.id);
  await expect(form.getByLabel('Room').locator('option')).toHaveText([
    'Open desk',
    'New room: Clean up a CSV of 3,000 contacts',
  ]);
  await form.getByRole('button', { name: 'Send' }).click();
  await expect(
    sheet.getByRole('region', { name: 'Invite them to a room' }).getByRole('status'),
  ).toContainText('Sent.');
  expect(fake.sends.map((sent) => sent.body.roomId)).toEqual([open.id]);
});

test('flag off: Respond says it isn’t available and Messages shows no responses (the real server)', async ({
  page,
}) => {
  await signIn(page);
  const scout = await addAgent(page, 'Scout');
  await hostRoom(page, scout.id, 'Contacts desk');
  await mockFeed(page, { requests: requests() });
  // No mockRespond: the test server runs with CITY_FEED=0, so Respond's routes answer 404.
  const sheet = await openRespond(page);
  const alert = sheet.getByRole('alert');
  await expect(alert).toContainText('Responding isn’t available right now. Try again later.');
  await expect(alert.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(sheet.getByRole('form', { name: 'Invite the poster to a room' })).toHaveCount(0);
  // The reply handle still reaches the poster.
  await expect(sheet.getByRole('region', { name: 'Or reach the poster' })).toContainText(
    'https://example.com/csv-contact',
  );
  await plainText(page, '.fd-detail');
  // Messages: the real summary has no requestResponses, so no section and no count for them.
  await openMessages(page);
  await expect(page.getByRole('region', { name: 'Responses to your requests' })).toHaveCount(0);
  await expect(
    nav(page)
      .locator('button, a')
      .filter({ hasText: /^Messages/ })
      .locator('.nav-count'),
  ).toHaveCount(0);
});

test('a New room retried after a failure keeps its key, so the server finds the same room', async ({
  page,
}) => {
  await signIn(page);
  const scout = await addAgent(page, 'Scout');
  await mockFeed(page, { requests: requests() });
  const fake = await mockRespond(page, {
    sendFailures: [{ status: 503, code: 'busy', retryAfterSeconds: 2 }],
  });
  const sheet = await openRespond(page);
  const form = sheet.getByRole('form', { name: 'Invite the poster to a room' });
  await expect(form.getByLabel('Room')).toHaveValue('new');
  await expect(form.getByLabel('Respond as')).toHaveValue(scout.id);
  await form.getByLabel(/^Note/).fill('  We can   start today.  ');
  // Counted as the server counts it: cleaned (spaces collapsed, trimmed).
  await expect(form.locator('.fd-count')).toHaveText('19/1000 characters');
  await form.getByRole('button', { name: 'Send' }).click();
  await expect(form.getByRole('alert')).toHaveText(
    'Central City is busy right now. Try again in a moment.',
  );
  await form.getByRole('button', { name: 'Send' }).click();
  await expect(
    sheet.getByRole('region', { name: 'Invite them to a room' }).getByRole('status'),
  ).toContainText('Sent.');
  expect(fake.sends).toHaveLength(2);
  // The same response again: the same key, so a room the first try made is found, not doubled.
  expect(fake.sends[1]!.body).toEqual(fake.sends[0]!.body);
  expect(fake.sends[1]!.body).toMatchObject({
    newRoom: true,
    fromAgentId: scout.id,
    note: 'We can start today.',
  });
});

test('Withdraw that fails keeps Already sent and says why; one accepted meanwhile reads as such', async ({
  page,
}) => {
  await signIn(page);
  const scout = await addAgent(page, 'Scout');
  const room = await hostRoom(page, scout.id, 'Contacts desk');
  const open: FeedResponseSent = {
    id: 'fri_aaaaaaaaaaaaaaaaaaab',
    requestId: SIGNED_IN_ID,
    roomId: room.id,
    from: { agentId: scout.id, name: 'Scout' },
    note: '',
    state: 'open',
    createdAt: Date.now() - 60_000,
    expiresAt: Date.now() + 7 * 86_400_000,
    answeredAt: null,
  };
  await mockFeed(page, { requests: requests() });
  const fake = await mockRespond(page, {
    mine: { [SIGNED_IN_ID]: [open] },
    withdrawFailures: [
      { status: 503, code: 'busy' },
      { status: 409, code: 'invitation_closed' },
    ],
  });
  const sheet = await openRespond(page);
  const form = sheet.getByRole('form', { name: 'Invite the poster to a room' });
  await expect(form.getByText('Already sent')).toBeVisible();
  await form.getByRole('button', { name: 'Withdraw' }).click();
  await expect(form.getByRole('alert')).toHaveText(
    'Central City is busy right now. Try again in a moment.',
  );
  await expect(form.getByText('Already sent')).toBeVisible();
  // Accepted meanwhile: no longer open, and the sheet reads what it is now (Send is back).
  await form.getByRole('button', { name: 'Withdraw' }).click();
  await expect(form.getByRole('alert')).toHaveText('This response is no longer open.');
  await expect(form.getByText('Already sent')).toHaveCount(0);
  await expect(form.getByRole('button', { name: 'Send' })).toBeVisible();
  await expect(form.getByRole('status').filter({ hasText: 'Withdrawn.' })).toHaveCount(0);
  expect(fake.withdraws).toEqual([open.id, open.id]);
  await plainText(page, '.fd-detail');
});

test('Messages: a request in review keeps its card and says so in plain words', async ({
  page,
}) => {
  await signIn(page);
  const clerk = await addAgent(page, 'Clerk');
  const fake = await mockRequestInbox(
    page,
    [requestInvitation({ agent: { id: clerk.id, name: 'Clerk' } })],
    { review: ['fri_aaaaaaaaaaaaaaaaaaaa'] },
  );
  await openMessages(page);
  const card = page
    .getByRole('region', { name: 'Responses to your requests' })
    .getByRole('article');
  await card.getByRole('button', { name: 'Accept' }).click();
  await expect(card.getByRole('alert')).toHaveText(
    'This request is being reviewed after reports. Try again later.',
  );
  await expect(card).toHaveCount(1);
  expect(fake.decides).toEqual([
    { id: 'fri_aaaaaaaaaaaaaaaaaaaa', body: { decision: 'accept', agentId: clerk.id } },
  ]);
  await plainText(page, '.msg3-resps');
});

test('Messages: a paused agent is never offered to join (paused by the real server)', async ({
  page,
}) => {
  await signIn(page);
  const clerk = await addAgent(page, 'Clerk');
  await addAgent(page, 'Helper');
  await pauseAgent(page, clerk.id);
  await mockRequestInbox(page, [requestInvitation({ agent: { id: clerk.id, name: 'Clerk' } })]);
  await openMessages(page);
  const card = page
    .getByRole('region', { name: 'Responses to your requests' })
    .getByRole('article');
  const picker = card.getByLabel('Join as');
  await expect(picker).toHaveValue('');
  await expect(picker.locator('option')).toHaveText(['Choose an agent', 'Helper']);
  await expect(picker).toHaveAccessibleDescription(
    'Clerk is paused. Choose another agent to join their room.',
  );
});

test('Messages: the cards follow the inbox when the count stays the same', async ({ page }) => {
  await signIn(page);
  const clerk = await addAgent(page, 'Clerk');
  const agent = { id: clerk.id, name: 'Clerk' };
  const fake = await mockRequestInbox(page, [
    requestInvitation({ from: { name: 'First' }, agent }),
  ]);
  await openMessages(page);
  const section = page.getByRole('region', { name: 'Responses to your requests' });
  await expect(section.getByRole('article')).toContainText('First');
  const reads = fake.inboxReads;
  // The first was withdrawn and another arrived: still one open response.
  fake.set([
    requestInvitation({ id: 'fri_bbbbbbbbbbbbbbbbbbbb', from: { name: 'Second' }, agent }),
  ]);
  // Showing the tab again re-reads the cards (otherwise at most every 2 minutes).
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(section.getByRole('article')).toContainText('Second');
  await expect(section.getByRole('article')).toHaveCount(1);
  await expect(section).not.toContainText('First');
  expect(fake.inboxReads).toBeGreaterThan(reads);
});

for (const width of [390, 1440])
  for (const theme of ['light', 'dark'] as const)
    test(`Respond and the Messages card at ${width} px, ${theme}: fits, readable`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      await signIn(page);
      const scout = await addAgent(page, 'Scout');
      await hostRoom(page, scout.id, 'Contacts desk');
      await mockFeed(page, { requests: requests() });
      await mockRespond(page);
      await mockRequestInbox(page, [requestInvitation({ agent: { id: scout.id, name: 'Scout' } })]);
      const sheet = await openRespond(page);
      const form = sheet.getByRole('form', { name: 'Invite the poster to a room' });
      await expect(form.getByLabel('Respond as')).toHaveValue(scout.id);
      expect(await fits(page)).toBe(true);
      expect((await lowContrast(page, '.fd-detail')).low).toEqual([]);
      for (const control of [form.getByLabel('Room'), form.getByRole('button', { name: 'Send' })])
        expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(
          width < 768 ? 43.5 : 32,
        );
      if (process.env.SHOTS)
        await page.screenshot({
          path: `${process.env.SHOTS}/feed-respond-${width}-${theme}.png`,
          fullPage: true,
        });

      await openMessages(page);
      const card = page
        .getByRole('region', { name: 'Responses to your requests' })
        .getByRole('article');
      await expect(card).toHaveCount(1);
      expect(await fits(page)).toBe(true);
      expect((await lowContrast(page, '.msg3-resps')).low).toEqual([]);
      if (process.env.SHOTS)
        await page.screenshot({
          path: `${process.env.SHOTS}/messages-response-${width}-${theme}.png`,
          fullPage: true,
        });
    });
