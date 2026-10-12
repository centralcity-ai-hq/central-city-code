import { test, expect, type Page, type Route } from '@playwright/test';

/*
 * Auto-reply settings UI against a mocked responder API: the #93 routes are not on main
 * yet, so /api/responder/* and /api/agents/:id/responder* are served by page.route with #93's
 * contract. The account, agent and console are real.
 */
const PASSWORD = 'Local-test-only-passphrase-2026';
const KEY = 'sk-ant-api03-e2e-test-value-not-a-real-key-000000';
const shotsDir = process.env.RESPONDER_SHOTS_DIR;

const MODELS = [
  {
    provider: 'anthropic',
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5 (retiring)',
    est_cost_per_reply_usd: 0.01,
    default: false,
  },
  {
    provider: 'anthropic',
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    est_cost_per_reply_usd: 0.02,
    default: true,
  },
  {
    provider: 'anthropic',
    id: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    est_cost_per_reply_usd: 0.04,
    default: false,
  },
  {
    provider: 'openai',
    id: 'gpt-6-luna',
    name: 'GPT-6 Luna',
    est_cost_per_reply_usd: 0.01,
    default: false,
  },
  {
    provider: 'openai',
    id: 'gpt-6-sol',
    name: 'GPT-6 Sol',
    est_cost_per_reply_usd: 0.02,
    default: true,
  },
];

type Settings = Record<string, unknown> & { key: Record<string, unknown> | null };
function unset(agentId: string): Settings {
  return {
    agent_id: agentId,
    enabled: false,
    status: 'off',
    pause_reason: null,
    paused_until: null,
    provider: null,
    model: null,
    instructions: '',
    daily_reply_cap: 100,
    daily_spend_cap_usd: 2,
    key: null,
    replies_available: false,
  };
}

/** A stateful mock of #93's console API. `requests` records every call (bodies included). */
async function mockResponder(page: Page, agentId: string, initial?: Partial<Settings>) {
  let settings: Settings = { ...unset(agentId), ...initial };
  const requests: { method: string; path: string; body: unknown }[] = [];
  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/responder/models**', (route) => json(route, 200, { models: MODELS }));
  await page.route(`**/api/agents/${agentId}/responder**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postData() ? JSON.parse(request.postData()!) : undefined;
    requests.push({ method: request.method(), path, body });
    const now = '2026-09-28T09:00:00.000Z';
    if (path.endsWith('/responder/key')) {
      if (request.method() === 'DELETE') {
        settings = {
          ...settings,
          enabled: false,
          status: 'paused',
          pause_reason: 'key_removed',
          key: null,
        };
        return json(route, 200, { agent_id: agentId, removed: true });
      }
      if (body.key !== KEY)
        return json(route, 400, { error: 'server text is never shown', code: 'invalid_key' });
      const key = { provider: body.provider, added_at: now, validated_at: now, status: 'active' };
      settings = {
        ...settings,
        provider: body.provider,
        model: body.model,
        key,
        ...(['invalid_key', 'forbidden', 'key_removed'].includes(String(settings.pause_reason))
          ? { status: settings.enabled ? 'active' : 'off', pause_reason: null }
          : {}),
      };
      return json(route, 200, { key });
    }
    if (request.method() === 'PUT') {
      if (body.enabled && !settings.key)
        return json(route, 409, { error: 'x', code: 'key_required' });
      settings = { ...settings, ...body };
      if (body.enabled === true)
        settings = { ...settings, status: 'active', pause_reason: null, paused_until: null };
      if (body.enabled === false) settings = { ...settings, status: 'off' };
      return json(route, 200, settings);
    }
    return json(route, 200, settings);
  });
  return { requests };
}

async function openAgent(page: Page) {
  const headers = { 'x-city-request': '1' };
  const name = `ar-${crypto.randomUUID().slice(0, 8)}`;
  expect(
    (
      await page.request.post('/api/auth/register', { headers, data: { name, password: PASSWORD } })
    ).status(),
  ).toBe(201);
  const agent = await page.request.post('/api/agents', {
    headers,
    data: {
      name: 'Hazel',
      description: 'Research partner',
      capability: 'research',
      mode: 'external',
    },
  });
  expect(agent.ok()).toBeTruthy();
  return (await agent.json()).agent.id as string;
}

/** My agents v4: the agent pane's own Auto-reply screen. */
async function showAutoReplyScreen(page: Page) {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Workspace' });
  const menu = page.getByRole('button', { name: 'Open navigation' });
  const agents = nav.getByRole('button', { name: /^My agents/ });
  await expect(menu.or(agents).first()).toBeVisible();
  if (await menu.isVisible()) await menu.click();
  await agents.click();
  await page
    .getByRole('region', { name: 'Agents', exact: true })
    .getByRole('button', { name: /^Hazel, / })
    .click();
  const pane = page.getByRole('complementary', { name: 'Hazel details' });
  await pane.getByRole('button', { name: /^Auto-reply/ }).click();
  await expect(pane.getByRole('heading', { name: 'Auto-reply', exact: true })).toBeVisible();
  return pane;
}

test('v4 screen: no key, Set up auto-reply, Turn on, and the switch works', async ({ page }) => {
  const agentId = await openAgent(page);
  const mock = await mockResponder(page, agentId);
  const pane = await showAutoReplyScreen(page);
  const toggle = pane.getByRole('switch', { name: 'Reply automatically' });
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  // No dead end: the key is set up right here, not in the agent's settings.
  await expect(pane).not.toContainText('Add a key in the agent’s settings first.');
  await expect(pane.getByRole('button', { name: /^(Change|Remove) key$/ })).toHaveCount(0);
  if (shotsDir) await pane.screenshot({ path: `${shotsDir}/v4-needs-key-1440-light.png` });
  await pane.getByRole('button', { name: 'Set up auto-reply', exact: true }).click();

  // The agent settings' own sheet, over the pane: provider, model, key, limits, consent.
  const sheet = page.getByRole('dialog', { name: 'Set up auto-reply for Hazel' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('radio', { name: 'Anthropic' })).toBeChecked();
  await expect(sheet.getByLabel('Model')).toHaveValue('claude-sonnet-5');
  await expect(sheet.getByText(/Anthropic bills you\./)).toBeVisible();
  if (shotsDir) await page.screenshot({ path: `${shotsDir}/v4-setup-sheet-1440-light.png` });
  // Switching provider switches the models and the notice.
  await sheet.getByText('OpenAI', { exact: true }).click();
  await expect(sheet.getByLabel('Model')).toHaveValue('gpt-6-sol');
  await expect(sheet.getByText(/OpenAI bills you\./)).toBeVisible();
  await sheet.getByText('Anthropic', { exact: true }).click();
  await expect(sheet.getByLabel('Model')).toHaveValue('claude-sonnet-5');
  // An empty key and a cap out of range are caught before any request.
  await sheet.getByText('Limits').click();
  await sheet.getByLabel('Replies a day, at most').fill('5000');
  await sheet.getByRole('button', { name: 'Turn on' }).click();
  await expect(sheet.getByText('Paste your Anthropic API key.')).toBeVisible();
  await expect(sheet.getByText('Enter a whole number from 1 to 1,000.')).toBeVisible();
  expect(mock.requests.filter((r) => r.method !== 'GET')).toEqual([]);
  await sheet.getByLabel('Replies a day, at most').fill('100');
  const key = sheet.getByLabel('Anthropic API key');
  await expect(key).toHaveAttribute('type', 'password');
  // A rejected key: the sheet's plain words, the key cleared, nothing turned on.
  await key.fill('sk-ant-api03-wrong-key-wrong-key-00000');
  await sheet.getByRole('button', { name: 'Turn on' }).click();
  await expect(
    sheet.getByText("Anthropic didn't accept this key. Check that you copied all of it."),
  ).toBeVisible();
  await expect(key).toHaveValue('');
  await expect(sheet.getByText('server text is never shown')).toHaveCount(0);
  expect(mock.requests.filter((r) => r.method === 'PUT')).toEqual([]);

  await key.fill(KEY);
  await sheet.getByRole('button', { name: 'Turn on' }).click();
  await expect(sheet).toBeHidden();
  const writes = mock.requests.filter((r) => r.method !== 'GET');
  expect(writes.slice(-2)).toEqual([
    {
      method: 'POST',
      path: `/api/agents/${agentId}/responder/key`,
      body: { provider: 'anthropic', model: 'claude-sonnet-5', key: KEY },
    },
    {
      method: 'PUT',
      path: `/api/agents/${agentId}/responder`,
      body: {
        model: 'claude-sonnet-5',
        instructions: '',
        daily_reply_cap: 100,
        daily_spend_cap_usd: 2,
        enabled: true,
      },
    },
  ]);
  // The screen read its settings again after the save.
  expect(mock.requests.at(-1)).toMatchObject({
    method: 'GET',
    path: `/api/agents/${agentId}/responder`,
  });
  // On: the switch is usable and has focus; the key is managed from here now.
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(toggle).toBeFocused();
  await expect(pane).toContainText('Replies when mentioned in a room.');
  await expect(pane.getByRole('button', { name: 'Set up auto-reply' })).toHaveCount(0);
  await expect(pane.getByRole('button', { name: 'Change key', exact: true })).toBeVisible();
  await expect(pane.getByRole('button', { name: 'Remove key', exact: true })).toBeVisible();
  expect(await page.content()).not.toContain(KEY);
  if (shotsDir) await pane.screenshot({ path: `${shotsDir}/v4-on-1440-light.png` });

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  expect(mock.requests.at(-1)).toMatchObject({ method: 'PUT', body: { enabled: false } });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
});

test('v4 screen: Change key and Remove key; removing disables the switch', async ({ page }) => {
  const agentId = await openAgent(page);
  const mock = await mockResponder(page, agentId, {
    enabled: true,
    status: 'active',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    key: {
      provider: 'anthropic',
      added_at: '2026-09-27T09:00:00.000Z',
      validated_at: '2026-09-27T09:00:00.000Z',
      status: 'active',
    },
  });
  const pane = await showAutoReplyScreen(page);
  const toggle = pane.getByRole('switch', { name: 'Reply automatically' });
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  // Change key: the replace sheet; Escape closes only the sheet, focus comes back.
  const change = pane.getByRole('button', { name: 'Change key', exact: true });
  await change.click();
  const sheet = page.getByRole('dialog', { name: 'Replace the key' });
  await expect(sheet.getByLabel('Anthropic API key')).toBeVisible();
  await expect(sheet.getByText('Limits')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(pane.getByRole('heading', { name: 'Auto-reply', exact: true })).toBeVisible();
  await expect(change).toBeFocused();
  await change.click();
  await sheet.getByLabel('Anthropic API key').fill(KEY);
  await sheet.getByRole('button', { name: 'Save key' }).click();
  await expect(sheet).toBeHidden();
  expect(mock.requests.filter((r) => r.method !== 'GET').slice(-2)).toEqual([
    {
      method: 'POST',
      path: `/api/agents/${agentId}/responder/key`,
      body: { provider: 'anthropic', model: 'claude-sonnet-5', key: KEY },
    },
    { method: 'PUT', path: `/api/agents/${agentId}/responder`, body: {} },
  ]);
  await expect(change).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  // Remove key asks first; Escape keeps the key.
  const remove = pane.getByRole('button', { name: 'Remove key', exact: true });
  await remove.click();
  const confirm = pane.getByRole('group', { name: 'Remove the key?' });
  await expect(pane).toContainText(
    "Remove the key? Auto-reply turns off. To be certain the key can't be used anywhere, also delete it at Anthropic.",
  );
  await expect(confirm).toBeFocused();
  if (shotsDir) await pane.screenshot({ path: `${shotsDir}/v4-remove-confirm-1440-light.png` });
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(remove).toBeFocused();
  await expect(pane.getByRole('heading', { name: 'Auto-reply', exact: true })).toBeVisible();
  expect(mock.requests.filter((r) => r.method === 'DELETE')).toEqual([]);

  await remove.click();
  await confirm.getByRole('button', { name: 'Remove key', exact: true }).click();
  // Off, the switch disabled, and Set up auto-reply offered again (with focus).
  const setup = pane.getByRole('button', { name: 'Set up auto-reply', exact: true });
  await expect(setup).toBeVisible();
  await expect(setup).toBeFocused();
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(pane.getByRole('button', { name: /^(Change|Remove) key$/ })).toHaveCount(0);
  expect(mock.requests.filter((r) => r.method === 'DELETE')).toEqual([
    { method: 'DELETE', path: `/api/agents/${agentId}/responder/key`, body: {} },
  ]);
  expect(mock.requests.at(-1)).toMatchObject({
    method: 'GET',
    path: `/api/agents/${agentId}/responder`,
  });
});

const openaiKey = {
  provider: 'openai',
  added_at: '2026-09-27T09:00:00.000Z',
  validated_at: '2026-09-27T09:00:00.000Z',
  status: 'active',
};
/** Paused for `reason`, on OpenAI's GPT-6 Luna with a working key unless `key` says otherwise. */
const pausedFor = (reason: string, more: Partial<Settings> = {}): Partial<Settings> => ({
  enabled: true,
  status: 'paused',
  pause_reason: reason,
  provider: 'openai',
  model: 'gpt-6-luna',
  key: openaiKey,
  ...more,
});

test('v4 screen: a quota pause says why, and Resume turns auto-reply back on', async ({ page }) => {
  const agentId = await openAgent(page);
  const mock = await mockResponder(page, agentId, pausedFor('quota'));
  const pane = await showAutoReplyScreen(page);
  const toggle = pane.getByRole('switch', { name: 'Reply automatically' });
  const paused = pane.getByRole('status').filter({ hasText: 'Paused' });
  // Never just "Paused.": a quota pause doesn't end by itself, so the reason and its fix show.
  await expect(paused).toHaveText(/^Paused: your OpenAI quota is used up\.\s*Resume$/);
  if (shotsDir) await pane.screenshot({ path: `${shotsDir}/v4-paused-quota-1440-light.png` });
  await paused.getByRole('button', { name: 'Resume' }).click();
  await expect(paused).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(toggle).toBeFocused();
  expect(mock.requests.filter((r) => r.method !== 'GET')).toEqual([
    { method: 'PUT', path: `/api/agents/${agentId}/responder`, body: { enabled: true } },
  ]);
});

test('v4 screen: repeated errors and a rate limit read in plain words', async ({ page }) => {
  const agentId = await openAgent(page);
  await mockResponder(page, agentId, pausedFor('repeated_failures'));
  let pane = await showAutoReplyScreen(page);
  const paused = () => pane.getByRole('status').filter({ hasText: 'Paused' });
  await expect(paused()).toContainText('Paused after repeated errors from OpenAI.');
  await expect(paused().getByRole('button', { name: 'Resume' })).toBeVisible();

  // A rate limit resumes by itself: the minutes, and no button.
  await page.unrouteAll({ behavior: 'wait' });
  const until = new Date(Date.now() + 9.5 * 60_000).toISOString();
  await mockResponder(page, agentId, pausedFor('rate_limited', { paused_until: until }));
  pane = await showAutoReplyScreen(page);
  await expect(paused()).toHaveText('Paused for 10 min: OpenAI rate limit. It resumes by itself.');
  await expect(paused().getByRole('button')).toHaveCount(0);
});

test('v4 screen: a model the key can’t use: Pick a model saves it and clears the pause', async ({
  page,
}) => {
  const agentId = await openAgent(page);
  const mock = await mockResponder(page, agentId, pausedFor('model_unavailable'));
  const pane = await showAutoReplyScreen(page);
  const paused = pane.getByRole('status').filter({ hasText: 'Paused' });
  await expect(paused).toContainText("Paused: this key can't use the chosen model.");
  await paused.getByRole('button', { name: 'Pick a model' }).click();
  // The settings sheet: no key asked for.
  const sheet = page.getByRole('dialog', { name: 'Auto-reply settings' });
  await expect(sheet.getByLabel('Model')).toHaveValue('gpt-6-luna');
  await expect(sheet.locator('input[type="password"]')).toHaveCount(0);
  await sheet.getByLabel('Model').selectOption('gpt-6-sol');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sheet).toBeHidden();
  // One request saves the model and turns auto-reply back on, which ends the pause.
  expect(mock.requests.filter((r) => r.method !== 'GET')).toEqual([
    {
      method: 'PUT',
      path: `/api/agents/${agentId}/responder`,
      body: {
        model: 'gpt-6-sol',
        instructions: '',
        daily_reply_cap: 100,
        daily_spend_cap_usd: 2,
        enabled: true,
      },
    },
  ]);
  await expect(paused).toHaveCount(0);
  await expect(pane.getByRole('switch', { name: 'Reply automatically' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  const row = pane.getByRole('button', { name: /^Model and limits/ });
  await expect(row).toContainText('OpenAI · GPT-6 Sol');
  await expect(row).toBeFocused();
});

test('v4 screen: a rejected key offers a new one; a forbidden one Change key', async ({ page }) => {
  const agentId = await openAgent(page);
  await mockResponder(
    page,
    agentId,
    pausedFor('invalid_key', { key: { ...openaiKey, status: 'invalid' } }),
  );
  let pane = await showAutoReplyScreen(page);
  const paused = () => pane.getByRole('status').filter({ hasText: 'Paused' });
  await expect(paused()).toContainText('Paused: OpenAI rejected the key.');
  // The rejected key can't be managed, only replaced: the setup sheet, which turns it back on.
  await expect(pane.getByRole('button', { name: /^Model and limits/ })).toHaveCount(0);
  await paused().getByRole('button', { name: 'Add a key' }).click();
  const setup = page.getByRole('dialog', { name: 'Set up auto-reply for Hazel' });
  await expect(setup.getByRole('radio', { name: 'OpenAI' })).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(setup).toBeHidden();

  await page.unrouteAll({ behavior: 'wait' });
  await mockResponder(page, agentId, pausedFor('forbidden'));
  pane = await showAutoReplyScreen(page);
  await expect(paused()).toContainText("Paused: OpenAI doesn't allow this key to reply.");
  await paused().getByRole('button', { name: 'Change key' }).click();
  await expect(page.getByRole('dialog', { name: 'Replace the key' })).toBeVisible();
});

test('v4 screen: Model and limits changes the model, instructions and caps without a key', async ({
  page,
}) => {
  const agentId = await openAgent(page);
  const mock = await mockResponder(page, agentId, {
    enabled: true,
    status: 'active',
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    key: { ...openaiKey, provider: 'anthropic' },
  });
  const pane = await showAutoReplyScreen(page);
  const row = pane.getByRole('button', { name: /^Model and limits/ });
  await expect(row).toContainText(
    'Anthropic · Claude Haiku 4.5 (retiring) · up to 100 replies a day · stops after about $2.00 a day',
  );
  if (shotsDir) await pane.screenshot({ path: `${shotsDir}/v4-model-limits-1440-light.png` });
  // Escape closes only the sheet; focus comes back to the row.
  await row.click();
  const sheet = page.getByRole('dialog', { name: 'Auto-reply settings' });
  await expect(sheet.locator('input[type="password"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(row).toBeFocused();

  await row.click();
  await sheet.getByLabel('Model').selectOption('claude-sonnet-5');
  await sheet.getByLabel('Instructions').fill('Answer briefly.');
  await sheet.getByLabel('Replies a day, at most').fill('40');
  await sheet.getByLabel('Stop after about this much a day (US$, estimated)').fill('1.25');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sheet).toBeHidden();
  // Settings only: no key sent, nothing turned on or off.
  expect(mock.requests.filter((r) => r.method !== 'GET')).toEqual([
    {
      method: 'PUT',
      path: `/api/agents/${agentId}/responder`,
      body: {
        model: 'claude-sonnet-5',
        instructions: 'Answer briefly.',
        daily_reply_cap: 40,
        daily_spend_cap_usd: 1.25,
      },
    },
  ]);
  await expect(row).toContainText(
    'Anthropic · Claude Sonnet 5 · up to 40 replies a day · stops after about $1.25 a day',
  );
  await expect(row).toBeFocused();
  await expect(pane.getByRole('switch', { name: 'Reply automatically' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
});

/**
 * The same UI against #93's real routes (run with CITY_RESPONDER=1). No provider is called: only
 * paths the server decides before any network request (format checks, key_required) are used.
 */
test('against the real responder API: models, settings, format errors, key required', async ({
  page,
}) => {
  test.skip(process.env.CITY_RESPONDER !== '1', 'Run with CITY_RESPONDER=1 for the real API.');
  const agentId = await openAgent(page);
  const models = await page.request.get('/api/responder/models');
  expect(models.ok()).toBeTruthy();
  const list = (await models.json()).models as { provider: string; id: string; default: boolean }[];
  expect(list.find((m) => m.provider === 'anthropic' && m.default)?.id).toBe('claude-sonnet-5');
  const settings = await page.request.get(`/api/agents/${agentId}/responder`);
  expect(Object.keys(await settings.json()).sort()).toEqual(
    [
      'agent_id',
      'daily_reply_cap',
      'daily_spend_cap_usd',
      'enabled',
      'instructions',
      'key',
      'model',
      'pause_reason',
      'paused_until',
      'provider',
      'replies_available',
      'status',
    ].sort(),
  );

  const pane = await showAutoReplyScreen(page);
  await pane.getByRole('button', { name: 'Set up auto-reply', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Set up auto-reply for Hazel' });
  await expect(sheet.getByLabel('Model')).toHaveValue('claude-sonnet-5');
  const key = sheet.getByLabel('Anthropic API key');
  // An admin key and a malformed key are refused by the server before any provider call.
  await key.fill('sk-ant-admin01-not-a-real-key-000000000000');
  await sheet.getByRole('button', { name: 'Turn on' }).click();
  await expect(sheet.getByText('Use a standard API key, not an admin key.')).toBeVisible();
  await key.fill('not-an-anthropic-key-0000000000000');
  await sheet.getByRole('button', { name: 'Turn on' }).click();
  await expect(sheet.getByText(/doesn’t look like an Anthropic API key/)).toBeVisible();
  await page.keyboard.press('Escape');
  // Turning on without a key: the server's key_required becomes plain words.
  const put = await page.request.put(`/api/agents/${agentId}/responder`, {
    headers: { 'x-city-request': '1' },
    data: { enabled: true },
  });
  expect(put.status()).toBe(409);
  expect((await put.json()).code).toBe('key_required');
});
