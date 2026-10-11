import { test, expect, request, type Browser, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ASSISTANT_SCOPES } from '../shared/assistant';
import { JOIN_AS_SELF_ROUTE } from '../src/rooms/api';

/*
 * Operation Agency A: "Join as yourself". The owner who hosts a room through one of their agents,
 * but is not in it as a person, gets one button above the composer that adds them as themselves
 * (the owner-only server route, A2, mocked here so this runs before it lands). After the join the
 * members refresh: the button goes and "Post as" writes as the person by default. A member who
 * doesn't own the host, and an owner already in the room as a person, never see the button.
 */
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'x-city-request': '1' };
const BUTTON = 'Join as yourself';
/**
 * A read the page still had in flight when its test ended: its route has nothing left to answer.
 * Dropped, so it never fails the run outside any test; every other error still throws.
 */
const ended = (error: unknown) => /Test ended|has been closed/.test(String(error));

async function account(browser: Browser, name: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  const created = await page.request.post('/api/auth/register', {
    headers,
    data: { name: `${name}-${randomUUID().slice(0, 6)}`, password: PASSWORD },
  });
  expect(created.status()).toBe(201);
  return page;
}

/**
 * A room hosted by the page's new agent "Hostbot" that its owner is not in as a person: one the
 * owner's AI created (an assistant grant on MCP). A room created in the app has its creator in it
 * from the start (#149), so only rooms like this one, or ones from before, offer the join.
 */
async function hostedRoom(page: Page, name: string): Promise<string> {
  const agent = await page.request.post('/api/agents', {
    headers,
    data: { name: 'Hostbot', capability: 'research', mode: 'hosted' },
  });
  expect(agent.ok()).toBe(true);
  const granted = await page.request.post('/api/assistant-access', {
    headers,
    data: { label: 'Synthetic assistant', scopes: ASSISTANT_SCOPES, expiresInDays: 1 },
  });
  expect(granted.status()).toBe(201);
  // The AI calls without the person's session: only its bearer grant.
  const ai = await request.newContext({ baseURL: test.info().project.use.baseURL });
  const room = await ai.post('/api/assistant/tools/city_create_room', {
    headers: { ...headers, authorization: `Bearer ${(await granted.json()).token}` },
    data: { agent_id: (await agent.json()).agent.id, name, idempotency_key: randomUUID() },
  });
  expect(room.status(), await room.text()).toBe(200);
  const id = (await room.json()).room.id as string;
  await ai.dispose();
  return id;
}

const joinSelfPath = (roomId: string) =>
  JOIN_AS_SELF_ROUTE.replace(':room', encodeURIComponent(roomId));

type Person = { id: string; name: string } | null;
/**
 * The server's room.person (#149) on every room read this page makes: the local server here
 * predates it, so the test says what it would answer (null: the viewer could join as themselves).
 */
async function serverPerson(page: Page, roomId: string, person: () => Person) {
  const patch = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(patch);
    if (!value || typeof value !== 'object') return value;
    const entry = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, patch(item)]),
    ) as Record<string, unknown>;
    return entry.id === roomId && 'slug' in entry ? { ...entry, person: person() } : entry;
  };
  await page.route(
    (url) =>
      url.pathname === '/api/rooms' || url.pathname.startsWith(`/api/rooms/${roomId}/messages`),
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      try {
        const response = await route.fetch();
        await route.fulfill({ response, json: patch(await response.json()) });
      } catch (error) {
        if (!ended(error)) throw error;
      }
    },
  );
}

test('the owner hosting through an agent joins as yourself and then writes as the person', async ({
  browser,
}) => {
  const host = await account(browser, 'self-host');
  const roomId = await hostedRoom(host, 'Join self');

  // A2, mocked: the first press fails, the second one holds until released, then answers the new
  // person member. From then on the members read lists that person too (joined last).
  const person = {
    id: `person-${randomUUID()}`,
    name: 'Hana',
    kind: 'person',
    role: 'member',
    owner_label: '',
    own: true,
    joined_at: new Date().toISOString(),
    status: 'active',
  };
  const bodies: unknown[] = [];
  let joined = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await host.route(
    (url) => url.pathname === joinSelfPath(roomId),
    async (route) => {
      expect(route.request().method()).toBe('POST');
      bodies.push(route.request().postDataJSON());
      if (bodies.length === 1) return route.fulfill({ status: 500, json: { error: 'internal' } });
      await held;
      joined = true;
      await route.fulfill({ status: 200, json: { member: person, joined: true } });
    },
  );
  await host.route(
    (url) => url.pathname === `/api/rooms/${roomId}/members`,
    async (route) => {
      try {
        const response = await route.fetch();
        const body = (await response.json()) as { members: Array<Record<string, unknown>> };
        if (joined) {
          const label = body.members.find((member) => member.role === 'host')?.owner_label;
          body.members.push({ ...person, owner_label: label ?? '' });
        }
        await route.fulfill({ response, json: body });
      } catch (error) {
        if (!ended(error)) throw error;
      }
    },
  );

  await serverPerson(host, roomId, () => (joined ? { id: person.id, name: person.name } : null));
  await host.goto(`/rooms/${roomId}`);
  const button = host.getByRole('button', { name: BUTTON, exact: true });
  await expect(button).toBeVisible();
  // One identity here (Hostbot): no "Post as" choice yet.
  await expect(host.locator('.rm3-postas')).toHaveCount(0);

  // A failed join: one alert line, the button stays to press again.
  await button.click();
  const alert = host.locator('.rm3-join-self').getByRole('alert');
  await expect(alert).toHaveText("Couldn't join as yourself. Try again.");
  await expect(button).toBeEnabled();

  // Pressing again retries (the server keeps a join idempotent: it sends no key and no name, so the
  // account's own name is used); the button is disabled while the join is on its way.
  await button.click();
  await expect(button).toBeDisabled();
  release();
  await expect(button).toHaveCount(0);
  expect(bodies).toEqual([{}, {}]);
  await expect(alert).toHaveCount(0);

  // The composer now writes as the person by default; Hostbot stays a choice.
  const postAs = host.locator('.rm3-postas select');
  await expect(postAs).toHaveValue(person.id);
  await expect(postAs.locator('option')).toHaveCount(2);
});

test('a member who does not own the host, and an owner already in as a person, never see it', async ({
  browser,
}) => {
  const host = await account(browser, 'self-owner');
  const roomId = await hostedRoom(host, 'Already in');
  const mint = async () =>
    (await (await host.request.post(`/api/rooms/${roomId}/link`, { headers, data: {} })).json())
      .link as string;

  // The owner is in the room as a person too (Hana); Bea joins with an agent only.
  const hana = await host.request.post('/api/rooms/join', {
    headers,
    data: { link: await mint(), name: 'Hana', idempotency_key: randomUUID() },
  });
  expect(hana.ok(), await hana.text()).toBe(true);
  const bea = await account(browser, 'self-bea');
  const token = new URL(await mint()).hash.slice(1);
  const scout = await bea.request.post(`/api/rooms/${roomId}/join`, {
    headers,
    data: { token, create: { name: 'Scout' }, idempotency_key: randomUUID() },
  });
  expect(scout.ok(), await scout.text()).toBe(true);

  // Neither ever calls the join route.
  let called = 0;
  for (const page of [host, bea])
    await page.route(
      (url) => url.pathname === joinSelfPath(roomId),
      (route) => {
        called += 1;
        return route.abort();
      },
    );

  // The server's word: the owner is in as Hana; Bea (a member, not the host) is not in as herself.
  await serverPerson(host, roomId, () => ({ id: 'hana', name: 'Hana' }));
  await serverPerson(bea, roomId, () => null);

  // The owner: once the members are in ("Post as" offers Hana and Hostbot), no button.
  await host.goto(`/rooms/${roomId}`);
  await expect(host.locator('.rm3-postas select option')).toHaveCount(2);
  await expect(host.getByRole('textbox', { name: 'Message' })).toBeVisible();
  await expect(host.getByRole('button', { name: BUTTON })).toHaveCount(0);

  // Bea: her members are in (the panel lists Hostbot and Scout), no button.
  await bea.goto(`/rooms/${roomId}`);
  await expect(bea.getByRole('textbox', { name: 'Message' })).toBeVisible();
  await bea.getByRole('button', { name: /^Members of / }).click();
  const ais = bea
    .getByRole('complementary', { name: 'Members' })
    .getByRole('list', { name: 'AIs', exact: true })
    .getByRole('listitem');
  await expect(ais.filter({ hasText: 'Hostbot' })).toHaveCount(1);
  await expect(ais.filter({ hasText: 'Scout' })).toHaveCount(1);
  await expect(bea.getByRole('button', { name: BUTTON })).toHaveCount(0);
  expect(called).toBe(0);
});

test("the server's refusal is said in plain words: a full room, a name in use", async ({
  browser,
}) => {
  const host = await account(browser, 'self-host-full');
  const roomId = await hostedRoom(host, 'Full room');
  const answers = [
    { status: 409, json: { error: 'Room is full.', code: 'room_full' } },
    { status: 409, json: { error: 'Name reserved.', code: 'name_reserved' } },
  ];
  await host.route(
    (url) => url.pathname === joinSelfPath(roomId),
    (route) => route.fulfill(answers.shift()!),
  );
  await serverPerson(host, roomId, () => null);
  await host.goto(`/rooms/${roomId}`);
  const button = host.getByRole('button', { name: BUTTON, exact: true });
  const alert = host.locator('.rm3-join-self').getByRole('alert');
  await button.click();
  await expect(alert).toHaveText(
    'The room is full. Raise its member limit in Room settings first.',
  );
  await button.click();
  await expect(alert).toHaveText('Someone in this room already uses your name.');
});

test("the server's room.person decides: null offers it, a person hides it", async ({ browser }) => {
  const host = await account(browser, 'self-host-flag');
  const roomId = await hostedRoom(host, 'Flagged room');
  let person: Person = null;
  await serverPerson(host, roomId, () => person);
  await host.goto(`/rooms/${roomId}`);
  await expect(host.getByRole('button', { name: BUTTON, exact: true })).toBeVisible();

  person = { id: `person-${randomUUID()}`, name: 'Hana' };
  await host.reload();
  // The room has loaded (its composer is there), and the server says you are in as yourself.
  await expect(host.getByRole('textbox', { name: 'Message' })).toBeVisible();
  await expect(host.getByRole('button', { name: BUTTON, exact: true })).toHaveCount(0);
});

test('without room.person (an AI workspace, an older server) the button never shows', async ({
  browser,
}) => {
  const host = await account(browser, 'self-host-none');
  const roomId = await hostedRoom(host, 'No person field');
  // An older server (or an AI workspace) sends no person field at all on its room reads.
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'person')
        .map(([key, item]) => [key, strip(item)]),
    );
  };
  await host.route(
    (url) => url.pathname === '/api/rooms' || url.pathname.startsWith(`/api/rooms/${roomId}`),
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      try {
        const response = await route.fetch();
        const type = response.headers()['content-type'] ?? '';
        if (!type.includes('json')) return await route.fulfill({ response });
        await route.fulfill({ response, json: strip(await response.json()) });
      } catch (error) {
        if (!ended(error)) throw error;
      }
    },
  );
  await host.goto(`/rooms/${roomId}`);
  await expect(host.getByRole('textbox', { name: 'Message' })).toBeVisible();
  await expect(host.getByRole('button', { name: BUTTON, exact: true })).toHaveCount(0);
});
