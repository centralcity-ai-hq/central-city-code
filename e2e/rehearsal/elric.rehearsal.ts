import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  test,
  expect,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { elricReplyLabel } from '../../shared/elric-copy';

/*
 * The Elric staging rehearsal (the go-live test of the Elric launch checklist) as one serial run. Every step of C.3:
 * date of birth (18+ passes), add Elric, owner and non-owner mentions, label and member marker,
 * approve and reject a consequential action, the daily limit, the 50% ceiling alert, the kill
 * switch, a turn log without message text, pause / resume / revoke, and the permanent under-18
 * lock.
 *
 * Locally (`pnpm test:rehearsal`) it runs against e2e/rehearsal/server.ts: a fake Google, the mock
 * model, a tiny global ceiling and a fresh operator secret, so every step runs.
 *
 * Against a preview (E2E_BASE_URL), a person provides what a script can't:
 * - E2E_OWNER_STATE: a Playwright storage state of an account signed in with a real Google
 *   account whose date of birth is 18+ (record it with `pnpm exec playwright open
 *   --save-storage=<file> <preview URL>/settings/account`). Without it the run stops.
 * - E2E_OPS_SECRET: the preview's CITY_OPS_SECRET, for the kill switch and usage (else skipped).
 * - E2E_MINOR_STATE: a throwaway Google-linked account for the under-18 lock (else skipped: the
 *   lock is permanent for that Google account).
 * - VERCEL_AUTOMATION_BYPASS_SECRET for a protected preview.
 * The 50% alert runs only locally (the preview's ceiling is USD 500): on staging, check the alert
 * webhook channel by hand. Nothing here is committed or printed.
 */
const remote = Boolean(process.env.E2E_BASE_URL);
const fakePort = Number(process.env.E2E_REHEARSAL_FAKE_PORT);
const opsSecret = process.env.E2E_OPS_SECRET;
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
// A fresh password per run: accounts made on a preview never share one.
const PASSWORD = `Rehearsal-${randomBytes(18).toString('base64url')}`;
const H = { 'x-city-request': '1' };
const run = randomUUID().slice(0, 8);
// Every text posted in the run carries this marker; the turn log must never contain it.
const MARK = `rehearsal-${run}`;
const poll = { timeout: remote ? 600_000 : 30_000, intervals: [500, 1000, 2000] };

type Room = { id: string; slug: string; link: string; token: string };
type Turn = {
  source_seq: number | string;
  result: string;
  reason_code: string;
  outcome: string;
  room_id: string;
};
type Message = {
  seq: number;
  text?: string;
  auto_reply?: { provider: string; model: string; label?: string } | null;
};

test.describe.configure({ mode: 'serial' });

let owner: BrowserContext;
let ownerPage: Page;
let guest: BrowserContext;
let room: Room;
let ownerPerson = '';
let guestPerson = '';
let elricId = '';
// False on a preview without E2E_OWNER_STATE: every step that needs the owner is skipped.
let ownerReady = false;
const needOwner = () =>
  test.skip(!ownerReady, 'E2E_OWNER_STATE is not set (a Google-linked 18+ owner session).');

function contextOptions(storageState?: string) {
  return {
    ...(storageState ? { storageState } : {}),
    baseURL: test.info().project.use.baseURL!,
    ...(bypass
      ? {
          extraHTTPHeaders: {
            'x-vercel-protection-bypass': bypass,
            'x-vercel-set-bypass-cookie': 'true',
          },
        }
      : {}),
  };
}

async function call<T = Record<string, unknown>>(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  data?: unknown,
  expected?: number,
): Promise<{ status: number; body: T; text: string }> {
  const response = await request.fetch(path, {
    method,
    headers: H,
    ...(data !== undefined ? { data } : {}),
  });
  const text = await response.text();
  if (expected !== undefined)
    expect(response.status(), `${method} ${path}: ${text}`).toBe(expected);
  let body = {} as T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    // not JSON
  }
  return { status: response.status(), body, text };
}

async function register(context: BrowserContext, name: string) {
  await call(context.request, 'POST', '/api/auth/register', { name, password: PASSWORD }, 201);
}

/** Locally: send the browser's trip to Google to the fake consent page, as subject `sub`. */
async function fakeGoogle(page: Page, sub: string) {
  await page.route('https://accounts.google.com/**', (route) => {
    const search = new URL(route.request().url()).searchParams;
    search.set('e2e_sub', sub);
    return route.fulfill({
      status: 302,
      headers: { location: `http://127.0.0.1:${fakePort}/authorize?${search}` },
    });
  });
}

async function linkGoogle(page: Page, sub: string) {
  await fakeGoogle(page, sub);
  await page.goto('/settings/account');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('status')).toHaveText('Google account linked.');
}

async function enterBirthDate(page: Page, date: string) {
  await page.goto('/settings/account');
  await page.getByLabel('Date of birth (for Elric, 18 or over)').fill(date);
  await page.getByRole('button', { name: 'Save' }).click();
}

async function say(context: BrowserContext, member: string, text: string) {
  const { body } = await call<{
    message: { seq: number };
    elric_notice?: { code: string; text: string; kind?: string };
  }>(
    context.request,
    'POST',
    `/api/rooms/${room.id}/messages`,
    { text: `${text} (${MARK})`, agent_id: member, idempotency_key: randomUUID() },
    201,
  );
  return body;
}

async function turns(): Promise<Turn[]> {
  return (
    await call<{ turns: Turn[] }>(
      owner.request,
      'GET',
      '/api/elric/turns?limit=100',
      undefined,
      200,
    )
  ).body.turns;
}
async function turnFor(seq: number): Promise<Turn> {
  let found: Turn | undefined;
  await expect
    .poll(async () => {
      found = (await turns()).find((item) => Number(item.source_seq) === seq);
      return found?.result ?? null;
    }, poll)
    .not.toBeNull();
  return found!;
}

async function messages(): Promise<Message[]> {
  const all: Message[] = [];
  let since = 0;
  for (;;) {
    const { body } = await call<{ messages: Message[] }>(
      owner.request,
      'GET',
      `/api/rooms/${room.id}/messages?since=${since}`,
      undefined,
      200,
    );
    if (!body.messages.length) return all;
    all.push(...body.messages);
    since = Math.max(...body.messages.map((item) => Number(item.seq)));
  }
}
const elricPosts = async () => (await messages()).filter((m) => m.auto_reply?.provider === 'elric');

/** The console's Elric page (/#elric): status, the turn log, approvals, Pause / Resume / Revoke. */
async function openConsole(page: Page) {
  await page.goto('/#elric');
  await expect(page.getByTestId('elric-status')).toBeVisible();
}

/**
 * The /elric chat's approvals (Workspace v3): a new chat opens Home, whose accent pill's Review
 * shows the action cards inside Elric's bubble.
 */
async function openApprovals(page: Page) {
  await page.goto('/elric');
  await page.locator('.elx-header').getByRole('button', { name: 'New chat' }).click();
  const review = page.locator('.elx3-approve-pill').getByRole('button', { name: 'Review' });
  await expect(review).toBeVisible({ timeout: poll.timeout });
  await review.click();
}

async function ops(method: 'GET' | 'POST', path: string, data?: unknown) {
  const response = await owner.request.fetch(path, {
    method,
    headers: { ...H, authorization: `Bearer ${opsSecret}` },
    ...(data !== undefined ? { data } : {}),
  });
  expect(response.status(), `${method} ${path}`).toBe(200);
  return response.json();
}

async function newContext(browser: Browser, storageState?: string) {
  return browser.newContext(contextOptions(storageState));
}

test.afterAll(async () => {
  // Never leave the kill switch on, whatever failed.
  if (owner && opsSecret)
    await owner.request
      .post('/api/ops/elric/kill', {
        headers: { ...H, authorization: `Bearer ${opsSecret}` },
        data: { enabled: false },
      })
      .then((response) => {
        if (!response.ok()) throw new Error(`status ${response.status()}`);
      })
      .catch((error: unknown) =>
        console.error(
          `Elric kill switch may still be ON: turning it off failed (${String(error)}).`,
        ),
      );
  await owner?.close();
  await guest?.close();
});

test('1. owner: verified Google account, date of birth 18+ passes', async ({ browser }) => {
  if (remote) {
    const state = process.env.E2E_OWNER_STATE;
    test.skip(!state, 'E2E_OWNER_STATE is not set (a Google-linked 18+ owner session).');
    JSON.parse(readFileSync(state!, 'utf8')); // readable
    owner = await newContext(browser, state);
    ownerPage = await owner.newPage();
  } else {
    owner = await newContext(browser);
    ownerPage = await owner.newPage();
    await register(owner, `Owner ${run}`);
    await linkGoogle(ownerPage, '200000000000000000001');
    await enterBirthDate(ownerPage, '1990-05-17');
    await expect(ownerPage.getByText('Saved.')).toBeVisible();
  }
  const age = await call<{ age_check: string; locked: boolean }>(
    owner.request,
    'GET',
    '/api/elric/age',
    undefined,
    200,
  );
  expect(age.body).toMatchObject({ age_check: 'over_18', locked: false });
  const status = await call<{ eligible: boolean }>(
    owner.request,
    'GET',
    '/api/elric',
    undefined,
    200,
  );
  expect(status.body.eligible).toBe(true);
  ownerReady = true;
});

test('2. add Elric to a room', async () => {
  needOwner();
  const added = await call<{ agent_id: string }>(owner.request, 'POST', '/api/elric', {});
  expect([200, 201]).toContain(added.status);
  elricId = added.body.agent_id;
  expect(elricId).toBeTruthy();
  // A room hosted by one of the owner's own agents; the owner joins as a person, then Elric.
  const host = await call<{ agent: { id: string } }>(
    owner.request,
    'POST',
    '/api/agents',
    { name: `Rehearsal host ${run}`, capability: 'research', mode: 'hosted' },
    201,
  );
  const created = await call<{ room: { id: string; slug: string }; link: { link: string } }>(
    owner.request,
    'POST',
    '/api/rooms',
    {
      agent_id: host.body.agent.id,
      name: `Rehearsal ${run}`,
      history: 'full',
      idempotency_key: randomUUID(),
    },
    201,
  );
  const link = created.body.link.link;
  room = {
    id: created.body.room.id,
    slug: created.body.room.slug,
    link,
    token: link.split('#')[1]!,
  };
  await call(
    owner.request,
    'POST',
    '/api/rooms/join',
    { link, name: `Owner ${run}`, idempotency_key: randomUUID() },
    200,
  );
  await call(
    owner.request,
    'POST',
    `/api/rooms/${room.slug}/join`,
    { token: room.token, agent_id: elricId, idempotency_key: randomUUID() },
    200,
  );
  const members = await call<{
    members: Array<{ id: string; kind: string; own: boolean; name: string; auto_reply: unknown }>;
  }>(owner.request, 'GET', `/api/rooms/${room.id}/members`, undefined, 200);
  ownerPerson = members.body.members.find((m) => m.own && m.kind === 'person')!.id;
  // The first-party marker on Elric in the member list (server-set).
  const marked = members.body.members.find((m) => m.name === 'Elric');
  expect(marked?.auto_reply).toEqual({ provider: 'elric' });
});

test('3. owner mention: Elric replies with the AI label', async () => {
  needOwner();
  const before = (await elricPosts()).length;
  const posted = await say(owner, ownerPerson, '@Elric say hello');
  expect(posted.elric_notice).toBeUndefined();
  const turn = await turnFor(posted.message.seq);
  expect(turn.result).toBe('posted');
  await expect.poll(async () => (await elricPosts()).length, poll).toBe(before + 1);
  const reply = (await elricPosts()).at(-1)!;
  expect(reply.auto_reply!.label).toBe(elricReplyLabel(reply.auto_reply!.model));
  expect(reply.auto_reply!.label).toMatch(/^Elric · (AI|automated)$/);
});

test('4. non-owner mention: only a notice to the sender, never a reply', async ({ browser }) => {
  needOwner();
  guest = await newContext(browser);
  await register(guest, `Guest ${run}`);
  await call(
    guest.request,
    'POST',
    '/api/rooms/join',
    { link: room.link, name: `Guest ${run}`, idempotency_key: randomUUID() },
    200,
  );
  const members = await call<{ members: Array<{ id: string; kind: string; own: boolean }> }>(
    guest.request,
    'GET',
    `/api/rooms/${room.id}/members`,
    undefined,
    200,
  );
  guestPerson = members.body.members.find((m) => m.own && m.kind === 'person')!.id;
  const before = (await elricPosts()).length;
  const posted = await say(guest, guestPerson, '@Elric please answer me');
  expect(posted.elric_notice?.code).toBe('elric_owner_only');
  expect(posted.elric_notice?.text).toContain('Elric answers only its owner');
  // The refusal is in the owner's turn log; nothing is posted to the room.
  const turn = await turnFor(posted.message.seq);
  expect(turn.result).toBe('refused');
  expect((await elricPosts()).length).toBe(before);
  const roomText = JSON.stringify(await messages());
  expect(roomText).not.toContain('Elric answers only its owner');
});

async function requestTask(title: string) {
  const posted = await say(owner, ownerPerson, `@Elric create a task: ${title}`);
  await turnFor(posted.message.seq);
  await openApprovals(ownerPage);
  const item = ownerPage.getByTestId('elric-pending').filter({ hasText: title });
  await expect(item).toHaveCount(1, { timeout: poll.timeout });
  return item;
}
async function taskTitles(): Promise<string[]> {
  const { body } = await call<{ tasks: Array<{ title: string }> }>(
    owner.request,
    'GET',
    `/api/rooms/${room.id}/tasks`,
    undefined,
    200,
  );
  return body.tasks.map((task) => task.title);
}

test('5. a consequential action waits for the owner: approve creates it, reject does not', async () => {
  needOwner();
  const approveTitle = `Approved task ${run}`;
  expect(await taskTitles()).not.toContainEqual(expect.stringContaining(approveTitle));
  const approve = await requestTask(approveTitle);
  // Nothing is created before the approval.
  expect((await taskTitles()).some((title) => title.includes(approveTitle))).toBe(false);
  await approve.getByRole('button', { name: 'Approve' }).click();
  await expect(approve).toHaveCount(0);
  await expect
    .poll(async () => (await taskTitles()).some((title) => title.includes(approveTitle)), poll)
    .toBe(true);

  const rejectTitle = `Rejected task ${run}`;
  const reject = await requestTask(rejectTitle);
  await reject.getByRole('button', { name: /^Decline/ }).click();
  await expect(reject).toHaveCount(0);
  expect((await taskTitles()).some((title) => title.includes(rejectTitle))).toBe(false);
});

test('6. the daily limit: summaries run out with a notice to the owner', async () => {
  needOwner();
  const usage = await call<{
    usage: { used: { summary: number }; allowance: { summary: number } };
  }>(owner.request, 'GET', '/api/elric', undefined, 200);
  const left = usage.body.usage.allowance.summary - usage.body.usage.used.summary;
  for (let i = 0; i < left; i++) {
    const posted = await say(owner, ownerPerson, `@Elric summarize the room, ${i + 1}`);
    expect(posted.elric_notice).toBeUndefined();
    expect((await turnFor(posted.message.seq)).result).toBe('posted');
  }
  const over = await say(owner, ownerPerson, '@Elric summarize the room, once more');
  expect(over.elric_notice).toMatchObject({ code: 'elric_limit', kind: 'summary' });
  expect(over.elric_notice!.text).toContain('Resets at 00:00 UTC');
  expect((await turnFor(over.message.seq)).result).toBe('limit');
  const status = await call<{ limit_notices: unknown[] }>(
    owner.request,
    'GET',
    '/api/elric',
    undefined,
    200,
  );
  expect(status.body.limit_notices.length).toBeGreaterThan(0);
});

test('7. the 50% ceiling alert arrives once', async () => {
  // Local only: the alert needs 50% of the global ceiling. The local server sets the ceiling to
  // 200 units, so one Tier 2 reservation crosses it; a preview has the real USD 500 ceiling, which
  // a rehearsal never reaches. On staging, check the alert webhook channel by hand.
  test.skip(remote, 'Staging ceiling is USD 500: check the alert webhook channel by hand.');
  needOwner();
  const response = await owner.request.get(`http://127.0.0.1:${fakePort}/alerts`);
  const alerts = (await response.json()) as Array<{ percent: number; ceiling_units: number }>;
  const fifty = alerts.filter((alert) => alert.percent === 50);
  expect(fifty).toHaveLength(1);
  expect(fifty[0]!.ceiling_units).toBe(200);
  const usage = await ops('GET', '/api/ops/elric/usage');
  expect(usage.today.ceiling_units).toBe(200);
  expect(usage.today.invocations).toBeGreaterThan(0);
  // Aggregates only: no owner, room or turn.
  expect(JSON.stringify(usage)).not.toContain(room.id);
});

test('8. the kill switch refuses every request at once, then turns off', async () => {
  test.skip(!opsSecret, 'E2E_OPS_SECRET is not set (the preview’s CITY_OPS_SECRET).');
  needOwner();
  const on = await ops('POST', '/api/ops/elric/kill', { enabled: true });
  expect(on.kill.killed).toBe(true);
  const before = (await elricPosts()).length;
  // Tier 0 (no model) is refused too.
  const posted = await say(owner, ownerPerson, '@Elric who is here');
  const turn = await turnFor(posted.message.seq);
  expect(turn.result).toBe('refused');
  expect(turn.reason_code).toBe('kill_switch');
  expect((await elricPosts()).length).toBe(before);
  const off = await ops('POST', '/api/ops/elric/kill', { enabled: false });
  expect(off.kill.database).toBe(false);
  const again = await say(owner, ownerPerson, '@Elric who is here');
  expect((await turnFor(again.message.seq)).result).toBe('posted');
});

test('9. the turn log holds no message text', async () => {
  needOwner();
  const all: Turn[] = [];
  let cursor: string | null = null;
  do {
    const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const { body, text } = await call<{ turns: Turn[]; next_cursor: string | null }>(
      owner.request,
      'GET',
      `/api/elric/turns?limit=100${query}`,
      undefined,
      200,
    );
    expect(text).not.toContain(MARK);
    expect(text).not.toContain('summarize the room');
    expect(text).not.toContain('Mock reply');
    all.push(...body.turns);
    cursor = body.next_cursor;
  } while (cursor);
  expect(all.filter((turn) => turn.room_id === room.id).length).toBeGreaterThanOrEqual(8);
  // The console shows the log, without content either.
  await openConsole(ownerPage);
  await expect(ownerPage.getByTestId('elric-turn').first()).toBeVisible();
  await expect(ownerPage.getByText(MARK)).toHaveCount(0);
});

test('10. pause, resume and revoke from the console', async () => {
  needOwner();
  await openConsole(ownerPage);
  const status = ownerPage.getByTestId('elric-status');
  await expect(status).toHaveText('Active');
  await ownerPage.getByRole('button', { name: 'Pause' }).click();
  await expect(status).toHaveText('Paused');
  // Paused: a mention gets no reply.
  const before = (await elricPosts()).length;
  const paused = await say(owner, ownerPerson, '@Elric are you there');
  expect((await turnFor(paused.message.seq)).result).toBe('refused');
  expect((await elricPosts()).length).toBe(before);
  await ownerPage.getByRole('button', { name: 'Resume' }).click();
  await expect(status).toHaveText('Active');
  await ownerPage.getByRole('button', { name: 'Revoke', exact: true }).click();
  await ownerPage.getByRole('dialog').getByRole('button', { name: 'Revoke Elric' }).click();
  await expect(status).toHaveText('Not added');
  const after = await call<{ agent_id: string | null }>(
    owner.request,
    'GET',
    '/api/elric',
    undefined,
    200,
  );
  expect(after.body.agent_id).toBeNull();
});

test('11. under 18: refused, and the lock is permanent', async ({ browser }) => {
  const minorState = process.env.E2E_MINOR_STATE;
  test.skip(remote && !minorState, 'E2E_MINOR_STATE is not set (a throwaway Google account).');
  const minor = await newContext(browser, remote ? minorState : undefined);
  const page = await minor.newPage();
  const sub = '300000000000000000001';
  if (!remote) {
    await register(minor, `Minor ${run}`);
    await linkGoogle(page, sub);
  }
  const year = new Date().getUTCFullYear() - 15;
  await enterBirthDate(page, `${year}-03-01`);
  // The form is replaced by the locked state at once.
  await expect(page.getByText('Elric is only for people aged 18 or over.')).toBeVisible();
  await expect(page.getByLabel('Date of birth (for Elric, 18 or over)')).toHaveCount(0);
  const refused = await call<{ code: string }>(minor.request, 'POST', '/api/elric', {});
  expect(refused.status).toBe(403);
  expect(refused.body.code).toBe('elric_age_under_18');
  // A correction never lifts the lock.
  const corrected = await call<{ code: string }>(minor.request, 'POST', '/api/elric/age', {
    date_of_birth: '1990-05-17',
  });
  expect(corrected.status).toBe(403);
  expect(
    (await call<{ locked: boolean }>(minor.request, 'GET', '/api/elric/age')).body.locked,
  ).toBe(true);
  await page.goto('/settings/account');
  await expect(page.getByText('Elric is only for people aged 18 or over.')).toBeVisible();
  if (!remote) {
    // Unlinking shreds the date of birth, but the lock stays: link the same Google account again.
    await call(minor.request, 'POST', '/api/auth/google/unlink', {}, 200);
    await page.goto('/settings/account');
    await page.getByRole('button', { name: 'Continue with Google' }).click();
    // The link answers with the lock (and the date of birth form stays locked).
    await expect(page.getByRole('alert')).toContainText('18 or over');
    await expect(page.getByLabel('Date of birth (for Elric, 18 or over)')).toHaveCount(0);
    const age = await call<{ locked: boolean }>(
      minor.request,
      'GET',
      '/api/elric/age',
      undefined,
      200,
    );
    expect(age.body.locked).toBe(true);
    expect((await call(minor.request, 'POST', '/api/elric', {})).status).toBe(403);
  }
  await minor.close();
});

test('0. preview without an owner session: Elric is on, and refuses an unverified account', async ({
  browser,
}) => {
  const plain = await newContext(browser);
  await register(plain, `Plain ${run}`);
  const status = await call<{ eligible: boolean; agent_id: string | null }>(
    plain.request,
    'GET',
    '/api/elric',
    undefined,
    200,
  );
  expect(status.body).toMatchObject({ eligible: false, agent_id: null });
  const add = await call<{ code: string }>(plain.request, 'POST', '/api/elric', {});
  expect(add.status).toBe(403);
  expect(add.body.code).toBe('elric_not_eligible');
  // The operator routes fail closed without the secret: the uniform 404.
  const usage = await plain.request.get('/api/ops/elric/usage', {
    headers: { ...H, authorization: 'Bearer wrong' },
  });
  expect(usage.status()).toBe(404);
  await plain.close();
});
