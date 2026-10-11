import { test, expect, type Page, type Route } from '@playwright/test';

/*
 * The owner's Elric page in the console (docs/ELRIC.md "Owner console"). The e2e server runs
 * without CITY_ELRIC and has no verified identities, so /api/elric* is served by page.route with
 * the shapes of server/elric (GET /api/elric, GET /api/elric/turns, POST pause/resume/revoke),
 * like e2e/responder.spec.ts. tests/elric-activity.test.ts covers the real routes.
 */
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'x-city-request': '1' };

const ROOM = { id: '0b8f7e43-2c55-4bd3-9a51-3f3c1a0d2e11', name: 'Launch plan' };
function turn(n: number, result: string, extra: Record<string, unknown> = {}) {
  return {
    id: `turn-${n}`,
    agent_id: 'elric-agent',
    room_id: ROOM.id,
    invoker_member_id: 'member-1',
    invoker_kind: 'owner',
    source_seq: n,
    context: null,
    tier: 1,
    model: 'elric-1.0',
    input_tokens: 1200 + n,
    output_tokens: 80,
    cost_units: 3,
    reserved_units: 24,
    tool_calls: [],
    outcome: result === 'posted' ? 'ok' : 'refused_invoker',
    reason: result === 'posted' ? null : 'not_owner',
    posted_seq: result === 'posted' ? n + 1 : null,
    created_at: new Date(Date.UTC(2026, 9, 1, 9, 0, 0) + n * 60_000).toISOString(),
    result,
    reason_code: result === 'posted' ? 'ok' : 'not_owner',
    room: ROOM,
    link: result === 'posted' ? `/rooms/${ROOM.id}` : null,
    ...extra,
  };
}

async function mockElric(page: Page) {
  const state = {
    status: 'active' as 'active' | 'paused' | 'revoked' | null,
    calls: [] as string[],
    decisions: [] as Array<[string, string, unknown]>,
  };
  const all = [
    turn(3, 'posted', {
      tool_calls: [{ name: 'room_read', name_hash: 'x', args_hash: 'y', status: 'ok' }],
      tier: 2,
      model: 'elric-1.0',
    }),
    turn(2, 'refused', { invoker_kind: 'other', tier: null, model: null, input_tokens: 0 }),
    turn(1, 'posted', { room: null, link: null }),
  ];
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/elric', (route) =>
    json(route, {
      agent_id: state.status === 'revoked' ? null : 'elric-agent',
      status: state.status === 'revoked' ? null : state.status,
      host_may_invoke: false,
      eligible: true,
      usage: {
        day: '2026-10-01',
        used: { short: 2, summary: 1, tool: 0 },
        allowance: { short: 20, summary: 4, tool: 5 },
        resets_at: '2026-10-02T00:00:00.000Z',
      },
      limit_notices: [],
    }),
  );
  await page.route('**/api/elric/turns?*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    const result = query.get('result');
    return json(route, {
      turns: all.filter((item) => !result || item.result === result),
      next_cursor: null,
    });
  });
  const pending = [
    {
      id: 'a6f3c1d2-4b5e-4f60-9a71-8b2c3d4e5f60',
      tool: 'room_task_create',
      summary: 'Draft the launch note',
      args_hash: 'a'.repeat(64),
      room: ROOM,
      created_at: '2026-10-01T09:00:00.000Z',
      expires_at: '2026-10-01T09:10:00.000Z',
    },
    {
      id: 'b7e4d2c3-5c6f-4a71-8b82-9c3d4e5f6071',
      tool: 'room_task_create',
      summary: 'Second task',
      args_hash: 'b'.repeat(64),
      room: null,
      created_at: '2026-10-01T09:01:00.000Z',
      expires_at: '2026-10-01T09:11:00.000Z',
    },
  ];
  const decisions = state.decisions;
  await page.route('**/api/elric/pending', (route) =>
    json(route, { pending: pending.filter((item) => !decisions.some(([id]) => id === item.id)) }),
  );
  await page.route('**/api/elric/pending/*/*', (route) => {
    const [, , , , id, decision] = new URL(route.request().url()).pathname.split('/');
    decisions.push([id!, decision!, route.request().postDataJSON()]);
    return json(route, { id, status: decision === 'approve' ? 'approved' : 'rejected' });
  });
  for (const action of ['pause', 'resume', 'revoke'] as const)
    await page.route(`**/api/elric/${action}`, (route) => {
      state.calls.push(action);
      state.status = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'revoked';
      return json(route, { agent_id: 'elric-agent', status: state.status });
    });
  return state;
}

async function signIn(page: Page) {
  const created = await page.request.post('/api/auth/register', {
    headers,
    data: { name: `Elric-owner-${crypto.randomUUID().slice(0, 8)}`, password: PASSWORD },
  });
  expect(created.status()).toBe(201);
}

/**
 * The workspace's Elric entry opens the chat (/elric); its Manage Elric sheet links to this page
 * in the console (Activity, /#elric). The chat's own routes are not mocked here, so the chat shows
 * its load error, and the top bar with Manage Elric stays.
 */
async function openElric(page: Page, width = 1440) {
  await page.goto('/');
  // On a phone the workspace navigation is a drawer.
  if (width < 900) await page.getByRole('button', { name: 'Open navigation' }).click();
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('button', { name: 'Elric', exact: true })
    .click();
  await expect(page).toHaveURL(/\/elric$/);
  await page.locator('.elx-header').getByRole('button', { name: 'Manage Elric' }).click();
  await page
    .getByRole('dialog', { name: 'Manage Elric' })
    .getByRole('link', { name: 'Activity' })
    .click();
  await expect(page.getByRole('heading', { name: 'Elric', exact: true })).toBeVisible();
}

test('the Elric page lists turns without content, filters them, and links posted replies', async ({
  page,
}) => {
  await mockElric(page);
  await signIn(page);
  await openElric(page);
  const turns = page.getByTestId('elric-turn');
  await expect(turns).toHaveCount(3);
  await expect(turns.nth(0)).toContainText('Posted');
  await expect(turns.nth(0)).toContainText('Launch plan');
  await expect(turns.nth(0)).toContainText('Tier 2 · AI');
  await expect(turns.nth(0)).toContainText('room_read (ok)');
  await expect(turns.nth(0).getByRole('link', { name: 'Open room' })).toHaveAttribute(
    'href',
    `/rooms/${ROOM.id}`,
  );
  await expect(turns.nth(1)).toContainText('Refused');
  await expect(turns.nth(1)).toContainText('Someone else');
  await expect(turns.nth(1)).toContainText('not owner');
  await expect(turns.nth(1).getByRole('link')).toHaveCount(0);
  await expect(turns.nth(2)).toContainText('Room not available');
  // Today's allowance per type.
  const today = page.getByRole('region', { name: 'Elric' });
  await expect(today).toContainText('Answers');
  await expect(today).toContainText('2 / 20');
  await expect(today).toContainText('1 / 4');
  await expect(today).toContainText('00:00 UTC');
  // U3: a meter per kind with its real values.
  const answers = today.getByRole('meter', { name: 'Answers used today' });
  await expect(answers).toHaveAttribute('aria-valuenow', '2');
  await expect(answers).toHaveAttribute('aria-valuemax', '20');
  await expect(today.getByRole('meter')).toHaveCount(3);
  // The result filter asks the server and shows only what it returns.
  await page.getByLabel('Result').selectOption('refused');
  await expect(turns).toHaveCount(1);
  await expect(turns.first()).toContainText('Refused');
});

test('pause, resume and revoke (with confirmation) are reflected on the page', async ({ page }) => {
  const state = await mockElric(page);
  await signIn(page);
  await openElric(page);
  const status = page.getByTestId('elric-status');
  await expect(status).toHaveText('Active');
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(status).toHaveText('Paused');
  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(status).toHaveText('Active');
  // Revoke asks first; Cancel changes nothing.
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Revoke Elric?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.calls).toEqual(['pause', 'resume']);
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke Elric' }).click();
  await expect(status).toHaveText('Not added');
  await expect(page.getByRole('button', { name: 'Pause' })).toHaveCount(0);
  expect(state.calls).toEqual(['pause', 'resume', 'revoke']);
  // The turn log stays readable after a revoke.
  await expect(page.getByTestId('elric-turn')).toHaveCount(3);
});

test('waiting for your approval: approve names the shown hash, reject removes the item', async ({
  page,
}) => {
  const state = await mockElric(page);
  await signIn(page);
  await openElric(page);
  const list = page.getByRole('list', { name: 'Waiting for your approval' });
  const items = page.getByTestId('elric-pending');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText('Create a task');
  await expect(items.nth(0)).toContainText('Draft the launch note');
  await expect(items.nth(0)).toContainText('Launch plan');
  await expect(items.nth(1)).toContainText('Room not available');
  await items.nth(0).getByRole('button', { name: 'Approve' }).click();
  await expect(items).toHaveCount(1);
  await items.nth(0).getByRole('button', { name: 'Reject' }).click();
  await expect(list).toHaveCount(0);
  expect(state.decisions).toEqual([
    ['a6f3c1d2-4b5e-4f60-9a71-8b2c3d4e5f60', 'approve', { args_hash: 'a'.repeat(64) }],
    ['b7e4d2c3-5c6f-4a71-8b82-9c3d4e5f6071', 'reject', {}],
  ]);
});

test('without Elric on the server, the console shows no Elric entry', async ({ page }) => {
  await signIn(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Elric', exact: true })).toHaveCount(0);
});

for (const [width, height] of [
  [1440, 1000],
  [390, 844],
] as const)
  for (const theme of ['light', 'dark'] as const)
    test(`Elric page at ${width} px, ${theme}: no sideways scroll, readable`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: theme });
      await mockElric(page);
      await signIn(page);
      await openElric(page, width);
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await expect(page.getByTestId('elric-turn')).toHaveCount(3);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      const chip = page.getByTestId('elric-status');
      const colors = await chip.evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.color, style.backgroundColor];
      });
      expect(colors[0]).not.toBe(colors[1]);
    });

test('usage meters: under 80% normal, from 80% amber, at the limit red', async ({ page }) => {
  await mockElric(page);
  // Registered last, so it answers GET /api/elric instead of the shared mock.
  await page.route('**/api/elric', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        agent_id: 'elric-agent',
        status: 'active',
        host_may_invoke: false,
        eligible: true,
        usage: {
          day: '2026-10-01',
          used: { short: 17, summary: 4, tool: 1 },
          allowance: { short: 20, summary: 4, tool: 5 },
          resets_at: '2026-10-02T00:00:00.000Z',
        },
        limit_notices: [],
      }),
    }),
  );
  await signIn(page);
  await openElric(page);
  const today = page.getByRole('region', { name: 'Elric' });
  await expect(today.getByRole('meter', { name: 'Answers used today' })).toHaveAttribute(
    'data-level',
    'high',
  );
  await expect(today.getByRole('meter', { name: 'Summaries used today' })).toHaveAttribute(
    'data-level',
    'full',
  );
  await expect(today.getByRole('meter', { name: 'Tasks used today' })).toHaveAttribute(
    'data-level',
    'ok',
  );
  // The colours come from the theme tokens (amber = --warning, red = --error).
  const colours = await today
    .getByRole('meter')
    .evaluateAll((meters) =>
      meters.map((meter) => getComputedStyle(meter.firstElementChild!).backgroundColor),
    );
  // Read in the meters' own scope: the workspace sets its tokens on .app-shell.
  const tokens = await today.evaluate((scope) => {
    const probe = document.createElement('span');
    scope.append(probe);
    const read = (name: string) => {
      probe.style.backgroundColor = `var(${name})`;
      return getComputedStyle(probe).backgroundColor;
    };
    const value = { warning: read('--warning'), error: read('--error') };
    probe.remove();
    return value;
  });
  expect(colours[0]).toBe(tokens.warning);
  expect(colours[1]).toBe(tokens.error);
});
