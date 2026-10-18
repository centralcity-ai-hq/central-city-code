import {
  test,
  expect as baseExpect,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Route,
} from '@playwright/test';
import { ELRIC_AI_NOTICE, ELRIC_MEMBER_BADGE, ELRIC_ROOM_HINT } from '../shared/elric-copy';

/**
 * The real response of an intercepted request as JSON, or null when the page dropped the request
 * meanwhile (the client aborted and re-issued it, so Playwright disposed the response): the route
 * then just continues, instead of failing the test from inside the handler.
 */
async function fetchJson(route: Route): Promise<Awaited<ReturnType<APIResponse['json']>> | null> {
  try {
    const response = await route.fetch();
    return await response.json();
  } catch {
    await route.continue().catch(() => {});
    return null;
  }
}

/*
 * Elric room UI:
 * - One-line 'Add Elric' card (only when eligible & host allows AI replies)
 * - Elric in members panel with AI agent badge and first_party marker
 * - Waking pill when @Elric is mentioned
 * - Per-type limit notice and non-owner ephemeral notice (never a room post)
 */
const expect = baseExpect.configure({ timeout: 15_000 });
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'X-City-Request': '1' };

async function patient(call: () => Promise<APIResponse>): Promise<APIResponse> {
  for (let attempt = 0; ; attempt++) {
    const response = await call();
    if (response.status() !== 429 || attempt >= 6) return response;
    const wait = Number(response.headers()['retry-after'] ?? '5');
    await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(wait, 1), 20) * 1000));
  }
}

function patientRequest(context: BrowserContext) {
  const request = context.request;
  return {
    get: (url: string, options?: Parameters<typeof request.get>[1]) =>
      patient(() => request.get(url, options)),
    post: (url: string, options?: Parameters<typeof request.post>[1]) =>
      patient(() => request.post(url, options)),
  };
}

const opened: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(opened.splice(0).map((context) => context.close()));
});

type Account = Awaited<ReturnType<typeof account>>;
async function account(
  browser: Browser,
  label: string,
  viewport?: { width: number; height: number },
) {
  const context = await browser.newContext(viewport ? { viewport } : {});
  opened.push(context);
  const name = `${label}-${crypto.randomUUID().slice(0, 8)}`;
  const created = await patientRequest(context).post('/api/auth/register', {
    headers,
    data: { name, password: PASSWORD },
  });
  expect(created.status()).toBe(201);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { name, context, request: patientRequest(context), page, errors };
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

test('one-line Add Elric card appears when viewer is eligible and host allows AI replies', async ({
  browser,
}) => {
  const host = await account(browser, 'Host-Eligible');
  const room = await hostRoom(host, 'Elric Card Room');

  // Intercept /api/elric to return eligible: true
  await host.page.route('**/api/elric', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          agent_id: null,
          status: null,
          host_may_invoke: false,
          eligible: true,
          usage: {
            allowance: { short: 20, summary: 4, tool: 5 },
            used: { short: 0, summary: 0, tool: 0 },
            resets_at: '2026-10-01T00:00:00Z',
          },
          limit_notices: [],
        }),
      });
    } else {
      await route.continue();
    }
  });

  await host.page.goto(`/rooms/${room.id}`);

  // The one-line Add Elric card is displayed
  const card = host.page.locator('.rm-elric-card');
  await expect(card).toBeVisible();
  await expect(card.locator('.rm-elric-card-text')).toHaveText('Elric answers you in this room.');
  await expect(card.getByRole('button', { name: 'Add Elric' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Not now' })).toBeVisible();

  // Dismissing with 'Not now' hides the card
  await card.getByRole('button', { name: 'Not now' }).click();
  await expect(card).toHaveCount(0);
});

test('Add Elric card does NOT appear when viewer is ineligible or host disallows AI replies', async ({
  browser,
}) => {
  const host = await account(browser, 'Host-Ineligible');
  const room = await hostRoom(host, 'No Elric Room');

  // Ineligible viewer: eligible: false
  await host.page.route('**/api/elric', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          agent_id: null,
          status: null,
          host_may_invoke: false,
          eligible: false,
          usage: {
            allowance: { short: 20, summary: 4, tool: 5 },
            used: { short: 0, summary: 0, tool: 0 },
            resets_at: '2026-10-01T00:00:00Z',
          },
          limit_notices: [],
        }),
      });
    } else {
      await route.continue();
    }
  });

  await host.page.goto(`/rooms/${room.id}`);
  await expect(host.page.locator('.rm-elric-card')).toHaveCount(0);
});

test('Members panel shows Elric with AI agent badge and server first_party marker', async ({
  browser,
}) => {
  const host = await account(browser, 'Host-Elric-Member');
  const room = await hostRoom(host, 'Elric Member Room');

  // Route members to include Elric marked with auto_reply: { provider: 'elric' }. The v2 panel
  // pages the list (?limit=…), so the route matches with or without a query.
  const membersUrl = (url: URL) => url.pathname === `/api/rooms/${room.id}/members`;
  await host.page.route(membersUrl, async (route) => {
    const json = await fetchJson(route);
    if (!json) return;
    json.members.push({
      id: 'elric-agent-id-1',
      name: 'Elric',
      role: 'member',
      owner_label: 'Central City',
      own: false,
      joined_at: new Date().toISOString(),
      kind: 'agent',
      status: 'active',
      auto_reply: { provider: 'elric' },
    });
    await route.fulfill({ json });
  });

  await host.page.goto(`/rooms/${room.id}`);

  // Open Members panel
  await host.page.getByRole('button', { name: /^Members of / }).click();
  const panel = host.page.getByRole('complementary', { name: 'Members' });
  // Elric is an AI: listed under AIs, never under People.
  const elricRow = panel
    .getByRole('list', { name: 'AIs', exact: true })
    .getByRole('listitem')
    .filter({ hasText: 'Elric' });
  await expect(elricRow).toBeVisible();
  await expect(
    // The host's own person (A1) is a person; its account name may contain "Elric", never is.
    panel.getByRole('list', { name: 'People' }).getByText('Elric', { exact: true }),
  ).toHaveCount(0);

  // Avatar has data-kind="elric"
  const avatar = elricRow.locator('.rm-avatar');
  await expect(avatar).toHaveAttribute('data-kind', 'elric');

  // Its AI badge shows ELRIC_MEMBER_BADGE, and nothing else
  await expect(elricRow.getByTestId('member-badge')).toHaveText([ELRIC_MEMBER_BADGE]);
  await expect(elricRow.getByTestId('member-badge')).toHaveAttribute('data-kind', 'elric');
});

test('waking pill displays while waiting for Elric response after @Elric mention', async ({
  browser,
}) => {
  const host = await account(browser, 'Host-Waking');
  const room = await hostRoom(host, 'Waking Room');

  await host.page.route('**/api/elric', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          agent_id: 'elric-agent-id',
          status: 'active',
          host_may_invoke: false,
          eligible: true,
          usage: {
            allowance: { short: 20, summary: 4, tool: 5 },
            used: { short: 0, summary: 0, tool: 0 },
            resets_at: '2026-10-01T00:00:00Z',
          },
          limit_notices: [],
        }),
      });
    } else {
      await route.continue();
    }
  });

  // Route members to include Elric as a member of Waking Room
  await host.page.route(`**/api/rooms/${room.id}/members`, async (route) => {
    const json = await fetchJson(route);
    if (!json) return;
    json.members.push({
      id: 'elric-agent-id',
      name: 'Elric',
      role: 'member',
      owner_label: 'Central City',
      own: false,
      joined_at: new Date().toISOString(),
      kind: 'agent',
      status: 'active',
      auto_reply: { provider: 'elric' },
    });
    await route.fulfill({ json });
  });

  // Delay the message POST slightly to verify waking pill presence
  await host.page.route(`**/api/rooms/${room.id}/messages`, async (route) => {
    if (route.request().method() === 'POST') {
      await new Promise((r) => setTimeout(r, 600));
      await route.continue();
    } else {
      await route.continue();
    }
  });

  await host.page.goto(`/rooms/${room.id}`);

  // The room knows Elric is a member (its hint shows) before the post: the composer can draw
  // before the members read answers, and a post sent earlier rightly wakes no one.
  await expect(host.page.locator('.rm-ai-notice')).toBeVisible();

  // Composer: type message mentioning @Elric
  const composer = host.page.locator('textarea[aria-label="Message"]');
  await expect(composer).toBeVisible();
  await composer.fill('@Elric What is the current status?');

  await host.page.getByRole('button', { name: 'Send' }).click();

  // Waking pill should appear
  const waking = host.page.locator('.rm-waking-pill');
  await expect(waking).toBeVisible();
  await expect(waking).toHaveText('Elric is waking up…');
});

test('per-type limit notice and non-owner ephemeral notice render locally (never as room posts)', async ({
  browser,
}) => {
  const host = await account(browser, 'Host-Notices');
  const room = await hostRoom(host, 'Notice Room');

  await host.page.route('**/api/elric', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          agent_id: 'elric-agent-id',
          status: 'active',
          host_may_invoke: false,
          eligible: true,
          usage: {
            allowance: { short: 20, summary: 4, tool: 5 },
            used: { short: 0, summary: 0, tool: 0 },
            resets_at: '2026-10-01T00:00:00Z',
          },
          limit_notices: [],
        }),
      });
    } else {
      await route.continue();
    }
  });

  let noticeToReturn: Record<string, unknown> | null = {
    code: 'elric_limit',
    kind: 'summary',
    text: 'Daily summaries allowance used up for today.',
    resets_at: '2026-10-01T00:00:00.000Z',
  };

  await host.page.route(`**/api/rooms/${room.id}/messages`, async (route) => {
    if (route.request().method() === 'POST') {
      const json = await fetchJson(route);
      if (!json) return;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          ...json,
          ...(noticeToReturn ? { elric_notice: noticeToReturn } : {}),
        }),
      });
    } else {
      await route.continue();
    }
  });

  await host.page.goto(`/rooms/${room.id}`);

  // Turn 1: Post triggering limit notice
  const composer = host.page.locator('textarea[aria-label="Message"]');
  await expect(composer).toBeVisible();
  await composer.fill('@Elric Summarize the room');
  await host.page.getByRole('button', { name: 'Send' }).click();

  // The limit alert is displayed in the viewer session
  const limitAlert = host.page.locator('.rm-limit-alert');
  await expect(limitAlert).toBeVisible();
  await expect(limitAlert).toContainText('Daily summaries allowance used up for today.');
  await expect(limitAlert).toContainText('Resets at 00:00 UTC.');
  await expect(limitAlert.locator('.rm-limit-cta')).toHaveAttribute('href', '/connect');
  await expect(limitAlert.locator('.rm-limit-cta')).toHaveText('Connect your own AI');

  // Verify it is NOT added as a chat message bubble in the room history
  const roomMessages = host.page.locator('.rm-messages .rm-message');
  await expect(
    roomMessages.filter({ hasText: 'Daily summaries allowance used up for today.' }),
  ).toHaveCount(0);

  // Dismiss button closes it
  await limitAlert.locator('.rm-notice-dismiss').click();
  await expect(limitAlert).toHaveCount(0);

  // Turn 2: Non-owner notice
  noticeToReturn = {
    code: 'elric_owner_only',
    text: 'Elric answers only its owner.',
  };

  await composer.fill('@Elric Help me with code');
  await host.page.getByRole('button', { name: 'Send' }).click();

  const ephemNotice = host.page.locator('.rm-ephemeral-notice');
  await expect(ephemNotice).toBeVisible();
  await expect(ephemNotice).toContainText('Elric answers only its owner.');

  // Never posted to room thread
  await expect(roomMessages.filter({ hasText: 'Elric answers only its owner.' })).toHaveCount(0);

  // Dismiss closes it
  await ephemNotice.locator('.rm-notice-dismiss').click();
  await expect(ephemNotice).toHaveCount(0);
});

test('clicking Add Elric joins Elric to the room and dismisses the card', async ({ browser }) => {
  const host = await account(browser, 'Host-Add');
  const room = await hostRoom(host, 'Add Elric Flow Room');

  let elricCreated = false;
  let elricJoined = false;

  await host.page.route('**/api/elric', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          agent_id: elricCreated ? 'elric-agent-1' : null,
          status: elricCreated ? 'active' : null,
          host_may_invoke: false,
          eligible: true,
          over_18: true,
          usage: {
            allowance: { short: 20, summary: 4, tool: 5 },
            used: { short: 0, summary: 0, tool: 0 },
            resets_at: '2026-10-01T00:00:00Z',
          },
          limit_notices: [],
        }),
      });
    } else if (route.request().method() === 'POST') {
      elricCreated = true;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ agent_id: 'elric-agent-1', created: true }),
      });
    } else {
      await route.continue();
    }
  });

  await host.page.route(`**/api/rooms/${room.id}/join`, async (route) => {
    elricJoined = true;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ room: { id: room.id, slug: room.slug, name: 'Add Elric Flow Room' } }),
    });
  });

  await host.page.route(`**/api/rooms/${room.id}/members`, async (route) => {
    const json = await fetchJson(route);
    if (!json) return;
    if (elricJoined) {
      json.members.push({
        id: 'elric-agent-1',
        name: 'Elric',
        role: 'member',
        owner_label: 'Central City',
        own: false,
        joined_at: new Date().toISOString(),
        kind: 'agent',
        status: 'active',
        auto_reply: { provider: 'elric' },
      });
    }
    await route.fulfill({ json });
  });

  await host.page.goto(`/rooms/${room.id}`);

  const card = host.page.locator('.rm-elric-card');
  await expect(card).toBeVisible();

  await card.getByRole('button', { name: 'Add Elric' }).click();

  // Card disappears once Elric is a member
  await expect(card).toHaveCount(0);
});

test('message with server auto_reply.label renders Elric badge in post byline', async ({
  browser,
}) => {
  const host = await account(browser, 'Host-Byline');
  const room = await hostRoom(host, 'Byline Room');

  await host.page.route(`**/api/rooms/${room.id}/messages*`, async (route) => {
    if (route.request().method() === 'GET') {
      const json = await fetchJson(route);
      if (!json) return;
      json.messages = [
        ...(json.messages || []),
        {
          id: 'elric-reply-1',
          room_id: room.id,
          seq: 1,
          origin: 'external',
          sender: 'Elric',
          sender_agent_id: 'elric-agent-1',
          sender_owner_label: 'Central City',
          own: false,
          text: 'The discussion reached consensus on the design token proposal.',
          parts: [
            {
              type: 'text',
              text: 'The discussion reached consensus on the design token proposal.',
            },
          ],
          created_at: new Date().toISOString(),
          format: 'markdown',
          sender_kind: 'agent',
          auto_reply: {
            provider: 'elric',
            model: 'gemma-4-12b',
            label: 'Elric · gemma-4-12b',
          },
        },
      ];
      await route.fulfill({ json });
    } else {
      await route.continue();
    }
  });

  await host.page.goto(`/rooms/${room.id}`);

  const msg = host.page.locator('.rm-message', {
    hasText: 'The discussion reached consensus on the design token proposal.',
  });
  await expect(msg).toBeVisible();

  const avatar = msg.locator('.rm-avatar');
  await expect(avatar).toHaveAttribute('data-kind', 'elric');

  const badge = msg.locator('.rm-byline .rm-badge-elric');
  await expect(badge).toBeVisible();
  // One badge, "built-in AI", visible to everyone (EU AI Act Art. 50).
  await expect(badge).toHaveText('built-in AI');
  await expect(badge.locator('.rm-visually-hidden')).toHaveCount(0);
  await expect(msg.locator('.rm-byline .rm3-tag:visible')).toHaveCount(1);
  await expect(badge).toHaveAttribute('title', 'Elric v1.0');

  // Ensure no model name is displayed to users
  await expect(msg.locator('.rm-byline')).not.toContainText('gemma-4-12b');
});

test('when server refuses Add Elric with elric_age_under_18, shows adult-only age dialog', async ({
  browser,
}) => {
  const host = await account(browser, 'Host-Under18');
  const room = await hostRoom(host, 'Under 18 Age Room');

  await host.page.route('**/api/elric', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          agent_id: null,
          status: null,
          host_may_invoke: false,
          eligible: true,
          over_18: true,
          usage: {
            allowance: { short: 20, summary: 4, tool: 5 },
            used: { short: 0, summary: 0, tool: 0 },
            resets_at: '2026-10-01T00:00:00Z',
          },
          limit_notices: [],
        }),
      });
    } else if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Elric is available from age 18.',
          code: 'elric_age_under_18',
        }),
      });
    } else {
      await route.continue();
    }
  });

  await host.page.goto(`/rooms/${room.id}`);

  const card = host.page.locator('.rm-elric-card');
  await expect(card).toBeVisible();

  await card.getByRole('button', { name: 'Add Elric' }).click();

  const dialog = host.page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { level: 2 })).toHaveText('Elric is for adults');
  await expect(dialog.locator('.rm-instruction')).toHaveText('Elric is available from age 18.');

  const okBtn = dialog.getByRole('button', { name: 'OK' });
  await expect(okBtn).toBeVisible();
  await okBtn.click();

  await expect(dialog).toBeHidden();
  await expect(card).toBeVisible();
});

test('when server refuses Add Elric with elric_age_unknown, shows confirm age dialog with Google account link', async ({
  browser,
}) => {
  const host = await account(browser, 'Host-AgeUnknown');
  const room = await hostRoom(host, 'Age Unknown Room');

  await host.page.route('**/api/elric', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          agent_id: null,
          status: null,
          host_may_invoke: false,
          eligible: true,
          over_18: true,
          usage: {
            allowance: { short: 20, summary: 4, tool: 5 },
            used: { short: 0, summary: 0, tool: 0 },
            resets_at: '2026-10-01T00:00:00Z',
          },
          limit_notices: [],
        }),
      });
    } else if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          error: "We couldn't confirm your age.",
          code: 'elric_age_unknown',
        }),
      });
    } else {
      await route.continue();
    }
  });

  await host.page.goto(`/rooms/${room.id}`);

  const card = host.page.locator('.rm-elric-card');
  await expect(card).toBeVisible();

  await card.getByRole('button', { name: 'Add Elric' }).click();

  const dialog = host.page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { level: 2 })).toHaveText(
    "We couldn't confirm your age",
  );
  await expect(dialog.locator('.rm-instruction')).toHaveText(
    'Add your birth date to your Google account, then try again.',
  );

  const link = dialog.getByRole('link', { name: 'Open Google account' });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', 'https://myaccount.google.com/birthday');
  await expect(link).toHaveAttribute('target', '_blank');

  const closeBtn = dialog.locator('.rm-actions').getByRole('button', { name: 'Close' });
  await expect(closeBtn).toBeVisible();
  await closeBtn.click();

  await expect(dialog).toBeHidden();
  await expect(card).toBeVisible();
});

test('Add Elric prompts for date of birth, sends POST /api/elric/age, and rejects under 18', async ({
  browser,
}) => {
  const host = await account(browser, 'Host-DobUnder18');
  const room = await hostRoom(host, 'Dob Under 18 Room');

  let agePayload: unknown = null;
  await host.page.route('**/api/elric/age', async (route) => {
    if (route.request().method() === 'POST') {
      agePayload = route.request().postDataJSON();
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Elric is available from age 18.',
          code: 'elric_age_under_18',
        }),
      });
    } else {
      await route.continue();
    }
  });

  await host.page.route('**/api/elric', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          agent_id: null,
          status: null,
          host_may_invoke: false,
          eligible: true,
          over_18: false,
          usage: {
            allowance: { short: 20, summary: 4, tool: 5 },
            used: { short: 0, summary: 0, tool: 0 },
            resets_at: '2026-10-01T00:00:00Z',
          },
          limit_notices: [],
        }),
      });
    } else {
      await route.continue();
    }
  });

  await host.page.goto(`/rooms/${room.id}`);
  const card = host.page.locator('.rm-elric-card');
  await expect(card).toBeVisible();

  await card.getByRole('button', { name: 'Add Elric' }).click();

  const dobDialog = host.page.getByRole('dialog');
  await expect(dobDialog).toBeVisible();
  await expect(dobDialog.getByRole('heading', { level: 2 })).toHaveText('Date of birth');
  await expect(dobDialog.locator('.rm-dob-note')).toHaveText("Used to confirm you're 18+.");

  // Fill under-18 date
  await dobDialog.locator('input[type="date"]').fill('2012-05-15');
  await dobDialog.getByRole('button', { name: 'Continue' }).click();

  // Assert POST /api/elric/age received { date_of_birth: '2012-05-15' }
  expect(agePayload).toEqual({ date_of_birth: '2012-05-15' });

  // Shows under 18 refusal dialog with approved copy
  const ageDialog = host.page.getByRole('dialog');
  await expect(ageDialog).toBeVisible();
  await expect(ageDialog.getByRole('heading', { level: 2 })).toHaveText('Elric is for adults');
  await expect(ageDialog.locator('.rm-instruction')).toHaveText('Elric is available from age 18.');
  await ageDialog.getByRole('button', { name: 'OK' }).click();
  await expect(ageDialog).toBeHidden();

  // Assert nothing is stored in browser storage
  const inStorage = await host.page.evaluate(() => sessionStorage.getItem('cc_elric_age_verified'));
  expect(inStorage).toBeNull();
});

test('Add Elric displays error when /api/elric/age returns 400 invalid_date_of_birth', async ({
  browser,
}) => {
  const host = await account(browser, 'Host-DobInvalid');
  const room = await hostRoom(host, 'Dob Invalid Room');

  await host.page.route('**/api/elric/age', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Please enter a valid date of birth.',
          code: 'invalid_date_of_birth',
        }),
      });
    } else {
      await route.continue();
    }
  });

  await host.page.route('**/api/elric', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          agent_id: null,
          status: null,
          host_may_invoke: false,
          eligible: true,
          over_18: false,
          usage: {
            allowance: { short: 20, summary: 4, tool: 5 },
            used: { short: 0, summary: 0, tool: 0 },
            resets_at: '2026-10-01T00:00:00Z',
          },
          limit_notices: [],
        }),
      });
    } else {
      await route.continue();
    }
  });

  await host.page.goto(`/rooms/${room.id}`);
  const card = host.page.locator('.rm-elric-card');
  await expect(card).toBeVisible();

  await card.getByRole('button', { name: 'Add Elric' }).click();

  const dobDialog = host.page.getByRole('dialog');
  await expect(dobDialog).toBeVisible();

  await dobDialog.locator('input[type="date"]').fill('1800-01-01');
  await dobDialog.getByRole('button', { name: 'Continue' }).click();

  // Shows error inside dialog
  const errorMsg = dobDialog.locator('.rm-error');
  await expect(errorMsg).toBeVisible();
  await expect(errorMsg).toHaveText('Please enter a valid date of birth.');
});

test('Add Elric prompts for date of birth and completes addition when 18+', async ({ browser }) => {
  const host = await account(browser, 'Host-DobOver18');
  const room = await hostRoom(host, 'Dob Over 18 Room');

  let agePayload: unknown = null;
  let createAgentPayload: unknown = null;

  await host.page.route('**/api/elric/age', async (route) => {
    if (route.request().method() === 'POST') {
      agePayload = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ age_check: 'over_18' }),
      });
    } else {
      await route.continue();
    }
  });

  await host.page.route('**/api/elric', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          agent_id: null,
          status: null,
          host_may_invoke: false,
          eligible: true,
          over_18: false,
          usage: {
            allowance: { short: 20, summary: 4, tool: 5 },
            used: { short: 0, summary: 0, tool: 0 },
            resets_at: '2026-10-01T00:00:00Z',
          },
          limit_notices: [],
        }),
      });
    } else if (route.request().method() === 'POST') {
      createAgentPayload = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          agent_id: 'elric-agent-123',
          created: true,
        }),
      });
    } else {
      await route.continue();
    }
  });

  await host.page.route(`**/api/rooms/${room.id}/join`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ room: { id: room.id, slug: room.slug, name: 'Dob Over 18 Room' } }),
    });
  });

  await host.page.goto(`/rooms/${room.id}`);
  const card = host.page.locator('.rm-elric-card');
  await expect(card).toBeVisible();

  await card.getByRole('button', { name: 'Add Elric' }).click();

  const dobDialog = host.page.getByRole('dialog');
  await expect(dobDialog).toBeVisible();
  await expect(dobDialog.getByRole('heading', { level: 2 })).toHaveText('Date of birth');

  // Fill 18+ date
  await dobDialog.locator('input[type="date"]').fill('2000-01-01');
  await dobDialog.getByRole('button', { name: 'Continue' }).click();

  await expect(dobDialog).toBeHidden();

  // Assert /api/elric/age received { date_of_birth: '2000-01-01' }
  expect(agePayload).toEqual({ date_of_birth: '2000-01-01' });

  // Assert POST /api/elric received only { name: 'Elric' }
  expect(createAgentPayload).toEqual({ name: 'Elric' });

  // Assert no age flag stored in sessionStorage
  const inStorage = await host.page.evaluate(() => sessionStorage.getItem('cc_elric_age_verified'));
  expect(inStorage).toBeNull();
});

test('Add Elric card in room with 30+ messages is visible above composer, Not now dismisses per-room only, and the Members switch adds Elric', async ({
  browser,
}) => {
  const host = await account(browser, 'Host-30-Messages');
  const room = await hostRoom(host, 'Room With 30 Messages');
  const room2 = await hostRoom(host, 'Room Two');

  // Seed 35 messages into room 1
  const messages35 = Array.from({ length: 35 }, (_, i) => ({
    id: `msg-${i + 1}`,
    seq: i + 1,
    sender: 'Host-30-Messages',
    sender_agent_id: 'host-agent-id',
    sender_owner_label: 'Account Host',
    own: true,
    text: `Message ${i + 1} in long thread`,
    parts: [{ type: 'text', text: `Message ${i + 1} in long thread` }],
    created_at: new Date(Date.now() - (35 - i) * 1000).toISOString(),
    format: 'plain',
    sender_kind: 'person',
    auto_reply: null,
  }));

  await host.page.route(`**/api/rooms/${room.id}/messages*`, async (route) => {
    const json = await fetchJson(route);
    if (!json) return;
    json.messages = messages35;
    await route.fulfill({ json });
  });

  let elricJoined = false;

  await host.page.route('**/api/elric', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          agent_id: elricJoined ? 'elric-agent-1' : null,
          status: elricJoined ? 'active' : null,
          host_may_invoke: false,
          eligible: true,
          over_18: true,
          usage: {
            allowance: { short: 20, summary: 4, tool: 5 },
            used: { short: 0, summary: 0, tool: 0 },
            resets_at: '2026-10-01T00:00:00Z',
          },
          limit_notices: [],
        }),
      });
    } else if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ agent_id: 'elric-agent-1', created: true }),
      });
    } else {
      await route.continue();
    }
  });

  await host.page.route(`**/api/rooms/${room.id}/join`, async (route) => {
    elricJoined = true;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        room: { id: room.id, slug: room.slug, name: 'Room With 30 Messages' },
      }),
    });
  });

  await host.page.route(`**/api/rooms/${room.id}/members`, async (route) => {
    const json = await fetchJson(route);
    if (!json) return;
    if (elricJoined) {
      json.members.push({
        id: 'elric-agent-1',
        name: 'Elric',
        role: 'member',
        owner_label: 'Central City',
        own: false,
        joined_at: new Date().toISOString(),
        kind: 'agent',
        status: 'active',
        auto_reply: { provider: 'elric' },
      });
    }
    await route.fulfill({ json });
  });

  await host.page.goto(`/rooms/${room.id}`);

  // 1. One-line card is visible above the composer even with 30+ messages
  const card = host.page.locator('.rm-elric-card');
  const composer = host.page.locator('.rm-composer');
  await expect(card).toBeVisible();
  await expect(composer).toBeVisible();

  const cardBox = await card.boundingBox();
  const composerBox = await composer.boundingBox();
  expect(cardBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  expect(cardBox!.y).toBeLessThan(composerBox!.y);

  // 2. Dismiss card with "Not now" in room 1
  await card.getByRole('button', { name: 'Not now' }).click();
  await expect(card).toHaveCount(0);

  // 3. In room 2, the card is still visible (dismissal was for room 1 only)
  await host.page.goto(`/rooms/${room2.id}`);
  const cardRoom2 = host.page.locator('.rm-elric-card');
  await expect(cardRoom2).toBeVisible();

  // 4. Return to room 1: the card stays dismissed; the Members panel switch still adds Elric
  // (one-click switch; the "…" menu only links to /elric).
  await host.page.goto(`/rooms/${room.id}`);
  await expect(host.page.locator('.rm-elric-card')).toHaveCount(0);

  await host.page.getByRole('button', { name: /^Members of / }).click();
  const panel = host.page.getByRole('complementary', { name: 'Members' });
  await expect(panel).toBeVisible();
  const toggle = panel.getByRole('switch', { name: 'Elric in this room' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  await host.page.getByRole('button', { name: 'More room actions' }).click();
  const menu = host.page.getByRole('menu', { name: 'More room actions' });
  await expect(menu.getByRole('menuitem', { name: 'Add Elric' })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: 'Manage Elric' })).toHaveCount(0);
});

test('Add Elric card does NOT appear for non-host members', async ({ browser }) => {
  const host = await account(browser, 'Host-Owner');
  const room = await hostRoom(host, 'Host Room for Guest');

  const guest = await account(browser, 'Guest-Member');
  await guest.page.route('**/api/elric', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          agent_id: null,
          status: null,
          host_may_invoke: false,
          eligible: true,
          over_18: true,
          usage: {
            allowance: { short: 20, summary: 4, tool: 5 },
            used: { short: 0, summary: 0, tool: 0 },
            resets_at: '2026-10-01T00:00:00Z',
          },
          limit_notices: [],
        }),
      });
    } else {
      await route.continue();
    }
  });

  // Guest joins the room
  await guest.page.goto(room.link);
  await guest.page.getByRole('button', { name: 'Join room' }).click();

  // Non-host guest never sees Add Elric card
  await expect(guest.page.locator('.rm-elric-card')).toHaveCount(0);
  // Nor the header Elric switch: it is left out of the page, not shown disabled.
  await expect(guest.page.getByRole('button', { name: /^Members of / })).toBeVisible();
  await expect(guest.page.locator('.rm-room-head').getByRole('switch')).toHaveCount(0);

  // Non-host guest never sees Add Elric in MoreMenu
  await guest.page.getByRole('button', { name: 'More room actions' }).click();
  await expect(guest.page.getByRole('menuitem', { name: 'Add Elric' })).toHaveCount(0);
});

test('a host under 18 has no Elric switch in the room header', async ({ browser }) => {
  const host = await account(browser, 'Host-Under18-Header');
  const room = await hostRoom(host, 'Under 18 Header Room');
  await host.page.route('**/api/elric', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        agent_id: null,
        status: null,
        host_may_invoke: false,
        eligible: false,
        eligibility_reason: 'age_under_18',
        over_18: false,
        usage: {
          allowance: { short: 20, summary: 4, tool: 5 },
          used: { short: 0, summary: 0, tool: 0 },
          resets_at: '2026-10-01T00:00:00Z',
        },
        limit_notices: [],
      }),
    });
  });
  await host.page.goto(`/rooms/${room.id}`);
  await expect(host.page.getByRole('button', { name: /^Members of / })).toBeVisible();
  // The status has loaded: the Members panel explains why Elric can't be added.
  await host.page.getByRole('button', { name: /^Members of / }).click();
  await expect(host.page.getByRole('switch', { name: 'Elric in this room' })).toHaveAttribute(
    'title',
    'Elric is available from age 18.',
  );
  await expect(host.page.locator('.rm-room-head').getByRole('switch')).toHaveCount(0);
  await expect(host.page.locator('.rm-head-elric')).toHaveCount(0);
});

test('composer Post as dropdown never includes Elric', async ({ browser }) => {
  const host = await account(browser, 'Host-Post-As');
  const room = await hostRoom(host, 'Post As Room');

  // Create a second agent for the host and join it to the room
  const secondAgentId = await agent(host, 'Second Agent');
  const joinResp = await host.request.post(`/api/rooms/${room.id}/join`, {
    headers,
    data: { agent_id: secondAgentId, idempotency_key: crypto.randomUUID() },
  });
  expect(joinResp.status()).toBe(200);

  // Seed Elric as an own member with auto_reply.provider === 'elric'
  await host.page.route(`**/api/rooms/${room.id}/members`, async (route) => {
    const json = await fetchJson(route);
    if (!json) return;
    json.members.push({
      id: 'elric-agent-id',
      name: 'Elric',
      role: 'member',
      owner_label: 'Central City',
      own: true,
      joined_at: new Date().toISOString(),
      kind: 'agent',
      status: 'active',
      auto_reply: { provider: 'elric' },
    });
    await route.fulfill({ json });
  });

  await host.page.route('**/api/elric', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          agent_id: 'elric-agent-id',
          status: 'active',
          host_may_invoke: false,
          eligible: true,
          over_18: true,
          usage: {
            allowance: { short: 20, summary: 4, tool: 5 },
            used: { short: 0, summary: 0, tool: 0 },
            resets_at: '2026-10-01T00:00:00Z',
          },
          limit_notices: [],
        }),
      });
    } else {
      await route.continue();
    }
  });

  await host.page.goto(`/rooms/${room.id}`);

  // Post as selector is visible because host has 2 postable agents (Host agent + Second Agent)
  const postAs = host.page.locator('.rm-post-as select');
  await expect(postAs).toBeVisible();

  // Elric must NOT be in the Post as dropdown
  const options = await postAs.locator('option').allTextContents();
  expect(options).not.toContain('Elric');
  expect(options.some((opt) => opt.includes('Elric'))).toBe(false);

  // The host as themselves (their own person, A1) and their two posting agents; never Elric.
  expect(options.length).toBe(3);
  expect(options.filter((opt) => opt.endsWith('(you)'))).toHaveLength(1);
});

test('owner sees Elric reply with avatar, Elric name, and AI badge even when message has own: true', async ({
  browser,
}) => {
  const host = await account(browser, 'Host-Elric-Own');
  const room = await hostRoom(host, 'Elric Own Reply Room');

  // Server marks the reply with own: true because Elric belongs to the owner
  await host.page.route(`**/api/rooms/${room.id}/messages*`, async (route) => {
    if (route.request().method() === 'GET') {
      const json = await fetchJson(route);
      if (!json) return;
      json.messages = [
        ...(json.messages || []),
        {
          id: 'elric-reply-own-1',
          room_id: room.id,
          seq: 1,
          origin: 'external',
          sender: 'Elric',
          sender_agent_id: 'elric-agent-1',
          sender_owner_label: 'Central City',
          own: true,
          text: 'I am Elric, here to help.',
          parts: [{ type: 'text', text: 'I am Elric, here to help.' }],
          created_at: new Date().toISOString(),
          format: 'plain',
          sender_kind: 'agent',
          auto_reply: {
            provider: 'elric',
            model: 'elric-1.0',
            label: 'Elric · AI',
          },
        },
      ];
      await route.fulfill({ json });
    } else {
      await route.continue();
    }
  });

  await host.page.goto(`/rooms/${room.id}`);

  // Message should NOT be rendered as an own message bubble
  const ownMsg = host.page.locator('.rm-message.own', { hasText: 'I am Elric, here to help.' });
  await expect(ownMsg).toHaveCount(0);

  // Message should be rendered as a standard Elric message
  const msg = host.page.locator('.rm-message', { hasText: 'I am Elric, here to help.' });
  await expect(msg).toBeVisible();

  // Avatar has data-kind="elric" and letter "E"
  const avatar = msg.locator('.rm-avatar');
  await expect(avatar).toBeVisible();
  await expect(avatar).toHaveAttribute('data-kind', 'elric');
  await expect(avatar).toHaveText('E');

  // Byline displays "Elric", not "(you)"
  await expect(msg.locator('.rm-byline strong')).toHaveText('Elric');
  await expect(msg.locator('.rm-byline')).not.toContainText('(you)');

  // Byline displays AI badge with tooltip "Elric v1.0"
  const badge = msg.locator('.rm-byline .rm-badge-elric');
  await expect(badge).toBeVisible();
  // One badge, "built-in AI", visible to everyone (EU AI Act Art. 50).
  await expect(badge).toHaveText('built-in AI');
  await expect(badge.locator('.rm-visually-hidden')).toHaveCount(0);
  await expect(msg.locator('.rm-byline .rm3-tag:visible')).toHaveCount(1);
  await expect(badge).toHaveAttribute('title', 'Elric v1.0');
});

test('inline approval card renders under Elric waiting for approval message and handles approve', async ({
  browser,
}) => {
  const host = await account(browser, 'Host-Approval-Test');
  const room = await hostRoom(host, 'Approval Room');

  const pendingId = 'pending-action-123';
  const argsHash = 'a'.repeat(64);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  // Mock GET /api/elric/pending
  await host.page.route('**/api/elric/pending', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          pending: [
            {
              id: pendingId,
              tool: 'room_task_create',
              summary: 'Draft release notes',
              args_hash: argsHash,
              room: { id: room.id, name: 'Approval Room' },
              created_at: new Date().toISOString(),
              expires_at: expiresAt,
            },
          ],
        }),
      });
    } else {
      await route.continue();
    }
  });

  // Mock POST /api/elric/pending/:id/approve with a gate so we can assert disabled buttons while in flight
  let approvedWithHash: string | null = null;
  let resolveApprove: (() => void) | null = null;
  const approveGate = new Promise<void>((resolve) => {
    resolveApprove = resolve;
  });
  await host.page.route(`**/api/elric/pending/${pendingId}/approve`, async (route) => {
    const postData = route.request().postDataJSON() as { args_hash: string };
    approvedWithHash = postData.args_hash;
    await approveGate;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: pendingId, status: 'approved' }),
    });
  });

  // Inject a message with auto_reply.pending_id in the room
  await host.page.route(`**/api/rooms/${room.id}/messages*`, async (route) => {
    if (route.request().method() === 'GET') {
      const json = await fetchJson(route);
      if (!json) return;
      json.messages = [
        ...(json.messages || []),
        {
          id: 'msg-waiting-for-approval',
          room_id: room.id,
          seq: 1,
          origin: 'external',
          sender: 'Elric',
          sender_agent_id: 'elric-agent-1',
          sender_owner_label: 'Central City',
          own: true,
          text: 'Waiting for your approval.',
          parts: [{ type: 'text', text: 'Waiting for your approval.' }],
          created_at: new Date().toISOString(),
          format: 'plain',
          sender_kind: 'agent',
          auto_reply: {
            provider: 'elric',
            model: 'elric-1.0',
            label: 'Elric · AI',
            pending_id: pendingId,
          },
        },
      ];
      await route.fulfill({ json });
    } else {
      await route.continue();
    }
  });

  await host.page.goto(`/rooms/${room.id}`);

  // The inline approval card is visible under Elric's message
  const card = host.page.locator('.rm-approval-card');
  await expect(card).toBeVisible();

  // Shows tool name ('Create a task'), title, room name, and countdown
  await expect(card.locator('.rm-approval-tool')).toHaveText('Create a task');
  await expect(card.locator('.rm-approval-title')).toHaveText('Draft release notes');
  await expect(card.locator('.rm-approval-room')).toContainText('Approval Room');
  await expect(card.locator('.rm-approval-countdown')).toContainText('remaining');

  // Approve and Reject buttons are visible
  const approveBtn = card.getByTestId('approval-approve');
  const rejectBtn = card.getByTestId('approval-reject');
  await expect(approveBtn).toBeVisible();
  await expect(rejectBtn).toBeVisible();

  // Click Approve: buttons are disabled during request
  void approveBtn.click();
  await expect(approveBtn).toBeDisabled();
  await expect(rejectBtn).toBeDisabled();

  // Release the request gate
  resolveApprove!();

  // Updates to Approved
  await expect(card.locator('.rm-approval-status.approved')).toHaveText('Approved');
  expect(approvedWithHash).toBe(argsHash);
});

test('inline approval card handles rejection', async ({ browser }) => {
  const host = await account(browser, 'Host-Reject-Test');
  const room = await hostRoom(host, 'Reject Room');

  const pendingId = 'pending-action-reject-123';
  const argsHash = 'b'.repeat(64);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  // Mock GET /api/elric/pending
  await host.page.route('**/api/elric/pending', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          pending: [
            {
              id: pendingId,
              tool: 'room_task_create',
              summary: 'Unwanted task',
              args_hash: argsHash,
              room: { id: room.id, name: 'Reject Room' },
              created_at: new Date().toISOString(),
              expires_at: expiresAt,
            },
          ],
        }),
      });
    } else {
      await route.continue();
    }
  });

  let rejected = false;
  await host.page.route(`**/api/elric/pending/${pendingId}/reject`, async (route) => {
    rejected = true;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: pendingId, status: 'rejected' }),
    });
  });

  await host.page.route(`**/api/rooms/${room.id}/messages*`, async (route) => {
    if (route.request().method() === 'GET') {
      const json = await fetchJson(route);
      if (!json) return;
      json.messages = [
        ...(json.messages || []),
        {
          id: 'msg-reject-approval',
          room_id: room.id,
          seq: 1,
          origin: 'external',
          sender: 'Elric',
          sender_agent_id: 'elric-agent-1',
          sender_owner_label: 'Central City',
          own: true,
          text: 'Waiting for your approval.',
          parts: [{ type: 'text', text: 'Waiting for your approval.' }],
          created_at: new Date().toISOString(),
          format: 'plain',
          sender_kind: 'agent',
          auto_reply: {
            provider: 'elric',
            model: 'elric-1.0',
            label: 'Elric · AI',
            pending_id: pendingId,
          },
        },
      ];
      await route.fulfill({ json });
    } else {
      await route.continue();
    }
  });

  await host.page.goto(`/rooms/${room.id}`);

  const card = host.page.locator('.rm-approval-card');
  await expect(card).toBeVisible();
  await expect(card.locator('.rm-approval-title')).toHaveText('Unwanted task');

  const rejectBtn = card.getByRole('button', { name: 'Reject' });
  await rejectBtn.click();

  await expect(card.locator('.rm-approval-status.rejected')).toHaveText('Rejected');
  expect(rejected).toBe(true);
});

test('inline approval card shows expired state when expires_at is in the past', async ({
  browser,
}) => {
  const host = await account(browser, 'Host-Expired-Test');
  const room = await hostRoom(host, 'Expired Room');

  const pendingId = 'pending-action-expired-123';
  const argsHash = 'c'.repeat(64);
  const expiresAt = new Date(Date.now() - 5000).toISOString();

  await host.page.route('**/api/elric/pending', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          pending: [
            {
              id: pendingId,
              tool: 'room_task_create',
              summary: 'Expired task',
              args_hash: argsHash,
              room: { id: room.id, name: 'Expired Room' },
              created_at: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
              expires_at: expiresAt,
            },
          ],
        }),
      });
    } else {
      await route.continue();
    }
  });

  await host.page.route(`**/api/rooms/${room.id}/messages*`, async (route) => {
    if (route.request().method() === 'GET') {
      const json = await fetchJson(route);
      if (!json) return;
      json.messages = [
        ...(json.messages || []),
        {
          id: 'msg-expired-approval',
          room_id: room.id,
          seq: 1,
          origin: 'external',
          sender: 'Elric',
          sender_agent_id: 'elric-agent-1',
          sender_owner_label: 'Central City',
          own: true,
          text: 'Waiting for your approval.',
          parts: [{ type: 'text', text: 'Waiting for your approval.' }],
          created_at: new Date().toISOString(),
          format: 'plain',
          sender_kind: 'agent',
          auto_reply: {
            provider: 'elric',
            model: 'elric-1.0',
            label: 'Elric · AI',
            pending_id: pendingId,
          },
        },
      ];
      await route.fulfill({ json });
    } else {
      await route.continue();
    }
  });

  await host.page.goto(`/rooms/${room.id}`);

  const card = host.page.locator('.rm-approval-card');
  await expect(card).toBeVisible();
  await expect(card.locator('.rm-approval-countdown')).toHaveText('Expired');
  await expect(card.getByRole('button', { name: 'Approve' })).toHaveCount(0);
});

test('inline approval card displays error and re-enables buttons on failure, and hides unknown tool labels', async ({
  browser,
}) => {
  const host = await account(browser, 'Host-Approval-Error');
  const room = await hostRoom(host, 'Approval Error Room');

  const pendingId = 'pending-action-error-123';
  const argsHash = 'd'.repeat(64);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  // Mock GET /api/elric/pending with an unknown tool name to verify unknown tools show no label
  await host.page.route('**/api/elric/pending', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          pending: [
            {
              id: pendingId,
              tool: 'unknown_internal_tool_xyz',
              summary: 'Task that will fail',
              args_hash: argsHash,
              room: { id: room.id, name: 'Approval Error Room' },
              created_at: new Date().toISOString(),
              expires_at: expiresAt,
            },
          ],
        }),
      });
    } else {
      await route.continue();
    }
  });

  // Mock POST /api/elric/pending/:id/approve with a gate and error response
  let resolveError: (() => void) | null = null;
  const errorGate = new Promise<void>((resolve) => {
    resolveError = resolve;
  });
  await host.page.route(`**/api/elric/pending/${pendingId}/approve`, async (route) => {
    await errorGate;
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Action revoked by host.' }),
    });
  });

  await host.page.route(`**/api/rooms/${room.id}/messages*`, async (route) => {
    if (route.request().method() === 'GET') {
      const json = await fetchJson(route);
      if (!json) return;
      json.messages = [
        ...(json.messages || []),
        {
          id: 'msg-error-approval',
          room_id: room.id,
          seq: 1,
          origin: 'external',
          sender: 'Elric',
          sender_agent_id: 'elric-agent-1',
          sender_owner_label: 'Central City',
          own: true,
          text: 'Waiting for your approval.',
          parts: [{ type: 'text', text: 'Waiting for your approval.' }],
          created_at: new Date().toISOString(),
          format: 'plain',
          sender_kind: 'agent',
          auto_reply: {
            provider: 'elric',
            model: 'elric-1.0',
            label: 'Elric · AI',
            pending_id: pendingId,
          },
        },
      ];
      await route.fulfill({ json });
    } else {
      await route.continue();
    }
  });

  await host.page.goto(`/rooms/${room.id}`);

  const card = host.page.locator('.rm-approval-card');
  await expect(card).toBeVisible();

  // Unknown tool must NOT show tool id or label (shows nothing)
  await expect(card.locator('.rm-approval-tool')).toHaveCount(0);

  const approveBtn = card.getByTestId('approval-approve');
  const rejectBtn = card.getByTestId('approval-reject');

  // Click Approve: buttons disabled during request
  void approveBtn.click();
  await expect(approveBtn).toBeDisabled();
  await expect(rejectBtn).toBeDisabled();

  // Release error gate
  resolveError!();

  // Error message displayed
  const errorMsg = card.locator('.rm-approval-error');
  await expect(errorMsg).toBeVisible();
  await expect(errorMsg).toHaveText('Action revoked by host.');

  // Buttons are re-enabled after failure
  await expect(approveBtn).not.toBeDisabled();
  await expect(rejectBtn).not.toBeDisabled();
});

test('ELRIC_AI_NOTICE is shown on Add Elric card and in DOB dialog', async ({ browser }) => {
  const host = await account(browser, 'Host-Ai-Notice-Add');
  const room = await hostRoom(host, 'AI Notice Add Room');

  // Eligible viewer without over_18 flag
  await host.page.route('**/api/elric', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          agent_id: null,
          status: null,
          host_may_invoke: false,
          eligible: true,
          over_18: false,
          usage: {
            allowance: { short: 20, summary: 4, tool: 5 },
            used: { short: 0, summary: 0, tool: 0 },
            resets_at: '2026-10-01T00:00:00Z',
          },
          limit_notices: [],
        }),
      });
    } else {
      await route.continue();
    }
  });

  await host.page.goto(`/rooms/${room.id}`);

  // Add Elric card displays ELRIC_AI_NOTICE
  const card = host.page.locator('.rm-elric-card');
  await expect(card).toBeVisible();
  const cardDisclosure = card.locator('.rm-elric-card-disclosure');
  await expect(cardDisclosure).toBeVisible();
  await expect(cardDisclosure).toHaveText(ELRIC_AI_NOTICE);

  // Clicking "Add Elric" opens DOB dialog which also displays ELRIC_AI_NOTICE
  await card.getByRole('button', { name: 'Add Elric' }).click();
  const dialog = host.page.getByRole('dialog', { name: 'Date of birth' });
  await expect(dialog).toBeVisible();
  const dialogDisclosure = dialog.locator('.rm-dob-disclosure');
  await expect(dialogDisclosure).toBeVisible();
  await expect(dialogDisclosure).toHaveText(ELRIC_AI_NOTICE);

  // Close the dialog
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
});

test('the Elric hint (the room AI notice) is shown once per room when Elric is in the room and can be dismissed', async ({
  browser,
}) => {
  const host = await account(browser, 'Host-Ai-Notice-Room');
  const room1 = await hostRoom(host, 'AI Notice Room 1');
  const room2 = await hostRoom(host, 'AI Notice Room 2');

  // Route members for room1 and room2 to include Elric
  const elricMember = {
    id: 'elric-member-agent',
    name: 'Elric',
    role: 'member',
    owner_label: 'Central City',
    own: false,
    joined_at: new Date().toISOString(),
    kind: 'agent',
    status: 'active',
    auto_reply: { provider: 'elric' },
  };

  const setupElricMembers = async (rId: string) => {
    await host.page.route(`**/api/rooms/${rId}/members`, async (route) => {
      const json = await fetchJson(route);
      if (!json) return;
      json.members.push(elricMember);
      await route.fulfill({ json });
    });
  };

  await setupElricMembers(room1.id);
  await setupElricMembers(room2.id);

  // 1. Visit Room 1: notice should be visible
  await host.page.goto(`/rooms/${room1.id}`);
  const notice1 = host.page.locator('.rm-ai-notice');
  await expect(notice1).toBeVisible();
  await expect(notice1.locator('.rm-ai-notice-text')).toHaveText(ELRIC_ROOM_HINT);
  // Workspace v3 §4.3: a small centred pill above the composer; "Ask Elric" starts a message.
  // Measured together once the room has settled (the composer mounts after the thread loads).
  await expect
    .poll(() =>
      host.page.evaluate(() => {
        const pill = document.querySelector('.rm-ai-notice')!.getBoundingClientRect();
        const card = document.querySelector('.rm-compose-card')?.getBoundingClientRect();
        if (!card) return 'no composer';
        const centred = Math.abs(pill.x + pill.width / 2 - (card.x + card.width / 2)) < 2;
        return pill.bottom <= card.top && centred ? 'above and centred' : 'misplaced';
      }),
    )
    .toBe('above and centred');
  await notice1.getByRole('button', { name: 'Ask Elric' }).click();
  const box = host.page.getByRole('textbox', { name: 'Message' });
  await expect(box).toHaveValue('@Elric ');
  await expect(box).toBeFocused();
  await box.fill('');

  // Minimal: extra info icon is dropped
  await expect(notice1.locator('svg')).toHaveCount(1); // Only the X dismiss icon
  await expect(notice1.locator('svg.rm-limit-icon')).toHaveCount(0);

  // 2. Dismiss the notice in Room 1
  await notice1.locator('.rm-notice-dismiss').click();
  await expect(notice1).toHaveCount(0);

  // 3. Reload Room 1: notice should remain dismissed (persisted in localStorage for host)
  await host.page.reload();
  await expect(host.page.locator('.rm-ai-notice')).toHaveCount(0);

  // 4. Visit Room 2: notice should still appear in Room 2 (per-room transparency)
  await host.page.goto(`/rooms/${room2.id}`);
  const notice2 = host.page.locator('.rm-ai-notice');
  await expect(notice2).toBeVisible();
  await expect(notice2.locator('.rm-ai-notice-text')).toHaveText(ELRIC_ROOM_HINT);

  // 5. Dismiss in Room 2: now dismissed in Room 2 as well
  await notice2.locator('.rm-notice-dismiss').click();
  await expect(notice2).toHaveCount(0);

  // 6. Another user in Room 1 still sees the notice (per-person transparency)
  const guest = await account(browser, 'Guest-Ai-Notice-Room');
  const joinResp = await guest.request.post('/api/rooms/join', {
    headers,
    data: { link: room1.link, name: 'Guest User', idempotency_key: crypto.randomUUID() },
  });
  expect(joinResp.status()).toBe(200);
  await guest.page.route(`**/api/rooms/${room1.id}/members`, async (route) => {
    const json = await fetchJson(route);
    if (!json) return;
    json.members = json.members || [];
    json.members.push(elricMember);
    await route.fulfill({ json });
  });
  await guest.page.goto(`/rooms/${room1.id}`);
  const guestNotice = guest.page.locator('.rm-ai-notice');
  await expect(guestNotice).toBeVisible();
  await expect(guestNotice.locator('.rm-ai-notice-text')).toHaveText(ELRIC_ROOM_HINT);
});
