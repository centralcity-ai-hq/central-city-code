import { expect, test, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { ModelOption, ResponderSettingsView } from '../src/responder/contract';
import { NO_AGENT_DIALOG, openAgentDialog } from './my-agents-open';

// The account, agent and navigation are real. Responder routes use synthetic metadata only;
// these cases neither store a provider credential nor call a model provider.
const agentName = 'Synthetic responder';
const recordedAt = '2026-10-03T12:00:00.000Z';
const refreshError = 'The key was removed, but auto-reply settings could not be refreshed.';
const refreshing = 'Refreshing auto-reply settings…';
const models: ModelOption[] = [
  {
    provider: 'openai',
    id: 'test-model-0001',
    name: 'Synthetic model',
    est_cost_per_reply_usd: 0.01,
    default: true,
  },
];

function activeSettings(agentId: string): ResponderSettingsView {
  return {
    agent_id: agentId,
    enabled: true,
    status: 'active',
    pause_reason: null,
    paused_until: null,
    provider: 'openai',
    model: models[0].id,
    instructions: 'Synthetic responder fixture.',
    daily_reply_cap: 20,
    daily_spend_cap_usd: 1,
    key: {
      provider: 'openai',
      added_at: recordedAt,
      validated_at: recordedAt,
      status: 'active',
    },
    replies_available: true,
  };
}

type HeldResponse = {
  method: 'GET' | 'DELETE';
  entered: boolean;
  delivered: boolean;
  deliveryError?: unknown;
  gate: Promise<void>;
  release: () => void;
};

async function setup(page: Page) {
  const headers = { 'X-City-Request': '1' };
  const registered = await page.request.post('/api/auth/register', {
    headers,
    data: {
      name: `Responder-recovery-${randomUUID().slice(0, 8)}`,
      password: 'Local-test-only-passphrase-2026',
    },
  });
  expect(registered.status()).toBe(201);
  const created = await page.request.post('/api/agents', {
    headers,
    data: {
      name: agentName,
      description: 'Synthetic recovery fixture',
      capability: 'research',
      mode: 'external',
    },
  });
  expect(created.ok()).toBe(true);
  const agentId = ((await created.json()) as { agent: { id: string } }).agent.id;
  const endpoint = `/api/agents/${agentId}/responder`;
  const state = {
    endpoint,
    settings: activeSettings(agentId),
    readFailure: false,
    deleteFailure: false,
    removed: true,
    calls: [] as { method: string; path: string }[],
    held: null as HeldResponse | null,
  };
  await page.route('**/api/events*', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/responder/models', (route) => route.fulfill({ json: { models } }));
  await page.route(`**${endpoint}**`, async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;
    state.calls.push({ method, path });
    const held = state.held?.method === method && !state.held.entered ? state.held : null;
    try {
      if (held) {
        held.entered = true;
        await held.gate;
      }
      if (method === 'GET' && path === endpoint) {
        await route.fulfill(
          state.readFailure
            ? {
                status: 503,
                json: { code: 'responder_unavailable', error: 'Synthetic settings read failure.' },
              }
            : { json: state.settings },
        );
      } else if (method === 'DELETE' && path === `${endpoint}/key`) {
        if (state.deleteFailure) {
          await route.fulfill({
            status: 503,
            json: { code: 'responder_unavailable', error: 'Synthetic key removal failure.' },
          });
        } else {
          // Both removed:true and removed:false disable settings; revoked keys are absent in GET.
          state.settings = {
            ...state.settings,
            enabled: false,
            status: 'off',
            pause_reason: 'key_removed',
            key: null,
          };
          await route.fulfill({ json: { agent_id: agentId, removed: state.removed } });
        }
      } else {
        await route.fulfill({ status: 405, json: { error: 'Unexpected responder mutation.' } });
      }
    } catch (error) {
      if (held) held.deliveryError = error;
      else throw error;
    } finally {
      if (held) held.delivered = true;
    }
  });
  return state;
}

type Fixture = Awaited<ReturnType<typeof setup>>;
const writes = (state: Fixture) => state.calls.filter((call) => call.method !== 'GET');
const reads = (state: Fixture) => state.calls.filter((call) => call.method === 'GET').length;

function holdNext(state: Fixture, method: HeldResponse['method']) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held: HeldResponse = { method, entered: false, delivered: false, gate, release };
  state.held = held;
  return {
    entered: () =>
      expect
        .poll(() => held.entered, { timeout: 5_000, message: `${method} reaches held response` })
        .toBe(true),
    finish: async () => {
      state.held = null;
      release();
      await expect
        .poll(() => !held.entered || held.delivered, {
          timeout: 5_000,
          message: `${method} held response is released`,
        })
        .toBe(true);
      if (held.deliveryError) throw held.deliveryError;
    },
  };
}

async function navigateToResponder(page: Page) {
  await page.goto('/#connect');
  await expect(page.locator('.app-shell')).toBeVisible();
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole('navigation', { name: 'Workspace', exact: true })
    .getByRole('button', { name: 'My agents', exact: true })
    .click();
  const agents = page.getByRole('region', { name: 'Agents', exact: true });
  await agents.getByRole('button', { name: 'Search agents', exact: true }).click();
  await agents.getByRole('textbox', { name: 'Search agents', exact: true }).fill(agentName);
  await openAgentDialog(page, agentName, agents);
  const section = page
    .getByRole('dialog', { name: agentName, exact: true })
    .getByRole('region', { name: 'Auto-reply', exact: true });
  await expect(section).toBeVisible();
  return section;
}

async function expectActive(section: Locator) {
  await expect(section.getByRole('switch', { name: 'Auto-reply', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(section.getByText(/^Key saved/)).toBeVisible();
}

async function openResponder(page: Page) {
  const section = await navigateToResponder(page);
  await expectActive(section);
  return section;
}

async function removalConfirmation(section: Locator) {
  await section.getByRole('button', { name: 'Remove', exact: true }).click();
  const confirmation = section.getByRole('group', { name: 'Remove the key?', exact: true });
  await expect(confirmation).toContainText('also delete it at OpenAI');
  return confirmation;
}

async function expectRemoved(section: Locator) {
  await expect(
    section.getByRole('status').filter({ hasText: 'Off: the key was removed.' }),
  ).toBeVisible();
  await expect(section.getByRole('switch', { name: 'Auto-reply', exact: true })).toHaveCount(0);
  await expect(section.getByText(/^Key saved/)).toHaveCount(0);
  await expect(section.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);
  await expect(section.getByRole('group', { name: 'Remove the key?', exact: true })).toHaveCount(0);
  await expect(section.getByRole('button', { name: 'Add a key', exact: true })).toBeVisible();
}

async function retryRead(section: Locator, state: Fixture) {
  const before = reads(state);
  const retry = section.getByRole('button', { name: 'Retry', exact: true });
  const held = holdNext(state, 'GET');
  try {
    await retry.press('Enter');
    await held.entered();
    await expect(retry).toHaveAttribute('aria-disabled', 'true');
    await expect(retry).toBeFocused();
    await retry.press('Enter');
    await expectRemoved(section);
    await expect(section.getByRole('status').filter({ hasText: refreshing })).toBeVisible();
    expect(reads(state)).toBe(before + 1);
  } finally {
    await held.finish();
  }
  await expect(section.getByRole('button', { name: 'Add a key', exact: true })).toBeEnabled();
  await expect(section.getByRole('status').filter({ hasText: refreshing })).toHaveCount(0);
  await expect(
    state.readFailure ? retry : section.getByRole('heading', { name: 'Auto-reply', exact: true }),
  ).toBeFocused();
  expect(reads(state)).toBe(before + 1);
}

test('initial settings failure settles loading and one keyboard retry restores actual active settings', async ({
  page,
}) => {
  test.skip(true, NO_AGENT_DIALOG);
  const state = await setup(page);
  state.readFailure = true;
  const section = await navigateToResponder(page);
  const loading = section.getByRole('status').filter({ hasText: /^Loading…$/ });
  const retry = section.getByRole('button', { name: 'Retry', exact: true });
  await expect(section.getByRole('alert')).toContainText("Couldn't load auto-reply.");
  await expect(loading).toHaveCount(0);
  await expect(retry).toBeEnabled();
  await expect(section.getByRole('switch', { name: 'Auto-reply', exact: true })).toHaveCount(0);
  await expect(section.getByText(/^Key saved/)).toHaveCount(0);
  await expect(section.getByText('Off: the key was removed.', { exact: true })).toHaveCount(0);
  await expect(section.getByRole('button', { name: 'Add a key', exact: true })).toHaveCount(0);
  expect(reads(state)).toBe(1);
  state.readFailure = false;
  const held = holdNext(state, 'GET');
  try {
    await retry.press('Enter');
    await held.entered();
    await expect(loading).toBeVisible();
    await expect(retry).toHaveAttribute('aria-disabled', 'true');
    await expect(retry).toBeFocused();
    await retry.press('Enter');
    await expect(section.getByRole('switch', { name: 'Auto-reply', exact: true })).toHaveCount(0);
    await expect(section.getByText(/^Key saved/)).toHaveCount(0);
    await expect(section.getByText('Off: the key was removed.', { exact: true })).toHaveCount(0);
    expect(reads(state)).toBe(2);
    expect(writes(state)).toEqual([]);
  } finally {
    await held.finish();
  }
  await expectActive(section);
  await expect(section.getByRole('alert')).toHaveCount(0);
  await expect(loading).toHaveCount(0);
  await expect(section.getByRole('heading', { name: 'Auto-reply', exact: true })).toBeFocused();
  expect(reads(state)).toBe(2);
  expect(writes(state)).toEqual([]);
});

{
  test('confirmed key removal stays truthful through failed GET-only retries', async ({ page }) => {
    test.skip(true, NO_AGENT_DIALOG);
    const state = await setup(page);
    const section = await openResponder(page);
    const confirmation = await removalConfirmation(section);
    state.readFailure = true;
    const held = holdNext(state, 'GET');
    try {
      await confirmation.getByRole('button', { name: 'Remove key', exact: true }).click();
      await held.entered();
      await expectRemoved(section);
      await expect(section.getByRole('heading', { name: 'Auto-reply', exact: true })).toBeFocused();
      await expect(section.getByRole('status').filter({ hasText: refreshing })).toBeVisible();
      await expect(section.getByRole('button', { name: 'Add a key', exact: true })).toBeDisabled();
      expect(writes(state)).toEqual([{ method: 'DELETE', path: `${state.endpoint}/key` }]);
    } finally {
      await held.finish();
    }
    await expect(section.getByRole('alert')).toContainText(refreshError);
    await expectRemoved(section);
    await expect(section.getByRole('button', { name: 'Add a key', exact: true })).toBeEnabled();
    await retryRead(section, state);
    await expect(section.getByRole('alert')).toContainText(refreshError);
    await expectRemoved(section);
    expect(writes(state)).toEqual([{ method: 'DELETE', path: `${state.endpoint}/key` }]);
    state.readFailure = false;
    await retryRead(section, state);
    await expect(section.getByRole('alert')).toHaveCount(0);
    await expectRemoved(section);
    expect(reads(state)).toBe(4); // Initial read, post-removal read, failed retry, recovered retry.
    expect(writes(state)).toEqual([{ method: 'DELETE', path: `${state.endpoint}/key` }]);
  });
}

test('failed DELETE retains the key and confirmation until an explicit retry confirms it is absent', async ({
  page,
}) => {
  test.skip(true, NO_AGENT_DIALOG);
  const state = await setup(page);
  const section = await openResponder(page);
  const confirmation = await removalConfirmation(section);
  const remove = confirmation.getByRole('button', { name: 'Remove key', exact: true });
  state.deleteFailure = true;
  const held = holdNext(state, 'DELETE');
  try {
    await remove.focus();
    await page.keyboard.press('Enter');
    await held.entered();
    await expect(remove).toHaveAttribute('aria-disabled', 'true');
    await expect(remove).toBeFocused();
    // A second activation while the request is pending must not send another mutation.
    await page.keyboard.press('Enter');
    await expect(section.getByRole('switch', { name: 'Auto-reply', exact: true })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(section.getByText(/^Key saved/)).toBeVisible();
    await expect(
      section.getByRole('status').filter({ hasText: 'Off: the key was removed.' }),
    ).toHaveCount(0);
    expect(writes(state)).toEqual([{ method: 'DELETE', path: `${state.endpoint}/key` }]);
    expect(reads(state)).toBe(1);
  } finally {
    await held.finish();
  }
  await expect(section.getByRole('alert')).toHaveText(
    'Auto-reply isn’t available right now. Try again later.',
  );
  await expect(confirmation).toBeVisible();
  await expect(remove).toBeEnabled();
  await expect(remove).toBeFocused();
  await expect(section.getByRole('switch', { name: 'Auto-reply', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(section.getByText(/^Key saved/)).toBeVisible();
  await expect(section.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
  expect(reads(state)).toBe(1);
  state.deleteFailure = false;
  state.removed = false; // Successful already-absent response still confirms auto-reply is off.
  await remove.click();
  await expectRemoved(section);
  await expect(section.getByRole('heading', { name: 'Auto-reply', exact: true })).toBeFocused();
  await expect(section.getByRole('button', { name: 'Add a key', exact: true })).toBeEnabled();
  await expect(section.getByRole('alert')).toHaveCount(0);
  expect(reads(state)).toBe(2);
  expect(writes(state)).toEqual([
    { method: 'DELETE', path: `${state.endpoint}/key` },
    { method: 'DELETE', path: `${state.endpoint}/key` },
  ]);
});
