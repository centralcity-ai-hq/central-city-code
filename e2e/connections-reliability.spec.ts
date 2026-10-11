import { expect, test, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { ConnectionInvite, ConnectionRequest } from '../shared/assistant';
import type { Agent, Snapshot } from '../shared/types';
import { openAdvancedGroup } from './settings-nav';

const base = '/api/v2/connections';
const recordedAt = '2026-10-03T12:00:00.000Z';
const expiresAt = '2026-10-10T12:00:00.000Z';
const requestError = 'The request could not be confirmed. Please try again.';
const recordedNotice = 'Connection request recorded. Check its status in Connections and history.';
const sender = makeAgent('test-sender-0001', 'First sender');
const alternate = makeAgent('test-sender-0002', 'Second sender');

function makeAgent(id: string, name: string): Agent {
  return {
    id,
    name,
    description: 'Synthetic connection recovery fixture',
    capability: 'research',
    mode: 'external',
    isDemo: false,
    status: 'online',
    lastSeenAt: recordedAt,
    createdAt: recordedAt,
    revokedAt: null,
  };
}

function request(overrides: Partial<ConnectionRequest> = {}): ConnectionRequest {
  return {
    id: 'test-request-0001',
    direction: 'incoming',
    status: 'pending',
    from_agent_id: 'test-peer-0001',
    from_agent_name: 'Synthetic peer',
    from_owner_label: 'Other synthetic workspace',
    to_agent_id: sender.id,
    to_agent_name: sender.name,
    note: 'Synthetic connection note',
    requested_at: recordedAt,
    expires_at: expiresAt,
    decided_at: null,
    revoked_at: null,
    ...overrides,
  };
}

function outgoing(): ConnectionRequest {
  return request({
    id: 'test-outgoing-0001',
    direction: 'outgoing',
    from_agent_id: alternate.id,
    from_agent_name: alternate.name,
    from_owner_label: 'Your synthetic workspace',
    to_agent_id: 'test-peer-0002',
    to_agent_name: null,
  });
}

function invite(): ConnectionInvite {
  return {
    id: 'test-invite-0001',
    agent_id: sender.id,
    created_at: recordedAt,
    expires_at: expiresAt,
    status: 'active',
  };
}

type Lists = { incoming: ConnectionRequest[]; outgoing: ConnectionRequest[] };
type ReadState = {
  lists: Lists;
  invites: ConnectionInvite[];
  failure: 'requests' | 'invites' | null;
};
type RequestBody = {
  from_agent_id: string;
  invite_token?: string;
  to_agent_id?: string;
  note?: string;
  idempotency_key: string;
};

async function setup(page: Page, populated = false): Promise<ReadState> {
  const registered = await page.request.post('/api/auth/register', {
    headers: { 'X-City-Request': '1' },
    data: {
      name: `Connection-recovery-${randomUUID().slice(0, 8)}`,
      password: 'Local-test-only-passphrase-2026',
    },
  });
  expect(registered.status()).toBe(201);
  const response = await page.request.get('/api/snapshot');
  expect(response.ok()).toBe(true);
  const snapshot = (await response.json()) as Snapshot;
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({ json: { ...snapshot, agents: [sender, alternate] } }),
  );
  await page.route('**/api/events*', (route) => route.fulfill({ status: 204 }));
  const state: ReadState = {
    lists: { incoming: populated ? [request()] : [], outgoing: populated ? [outgoing()] : [] },
    invites: populated ? [invite()] : [],
    failure: null,
  };
  // Explicit state also applies to the preview navigation's periodic request-count reads.
  for (const endpoint of ['requests', 'invites'] as const) {
    await page.route(`**${base}/${endpoint}`, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      if (state.failure === endpoint) {
        await route.fulfill({
          status: 503,
          json: {
            error: `${endpoint === 'requests' ? 'Requests' : 'Invites'} are temporarily unavailable.`,
          },
        });
      } else {
        await route.fulfill({
          json: endpoint === 'requests' ? state.lists : { invites: state.invites },
        });
      }
    });
  }
  return state;
}

async function openConnections(page: Page) {
  await page.goto('/#connect');
  await expect(page.locator('.app-shell')).toBeVisible();
  await (
    await openAdvancedGroup(page)
  )
    .getByRole('button', { name: 'Agent permissions', exact: true })
    .click();
  const panel = page.getByRole('region', { name: 'Connections with other people', exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

async function fillDraft(
  panel: Locator,
  target = 'https://example.test/connect#cci_test_invite_0001',
) {
  await panel
    .getByRole('combobox', { name: 'From your agent', exact: true })
    .selectOption(alternate.id);
  await panel.getByLabel('Their invite', { exact: true }).fill(target);
  await panel
    .getByLabel('Note for them (optional)', { exact: true })
    .fill('  Synthetic connection note  ');
}

async function refresh(page: Page, panel: Locator) {
  // Invites is read only by this panel, unlike the request count in preview navigation.
  const loaded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `${base}/invites` &&
      response.request().method() === 'GET',
  );
  await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
  await (await loaded).finished();
  await expect(panel.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
}

async function expectLists(panel: Locator) {
  await expect(panel.getByRole('list', { name: 'Requests from other people' })).toContainText(
    'Synthetic peer',
  );
  await expect(panel.getByRole('list', { name: 'Connections with other people' })).toContainText(
    alternate.name,
  );
  await expect(panel.getByRole('list', { name: 'Your invites' })).toContainText('Not used yet');
}

{
  test('request failure retains the draft and reuses its key on a successful retry', async ({
    page,
  }) => {
    const state = await setup(page);
    const bodies: RequestBody[] = [];
    let recover = false;
    let freshSubmission = false;
    let entered!: () => void;
    const requestEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**${base}/requests`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      bodies.push(route.request().postDataJSON() as RequestBody);
      if (!recover) {
        entered();
        await held;
        await route.fulfill({ status: 503, json: { error: requestError } });
      } else if (freshSubmission) {
        // This tests client key retirement, not permission to create another pending pair.
        await route.fulfill({
          status: 409,
          json: { error: 'The agents already have a pending connection request.' },
        });
      } else {
        state.lists.outgoing = [outgoing()];
        // Model a recorded request whose first response was lost: replay creates nothing new.
        await route.fulfill({ status: 201, json: { request: outgoing(), replayed: true } });
      }
    });
    const panel = await openConnections(page);
    await fillDraft(panel);
    const submit = panel.getByRole('button', { name: 'Request connection', exact: true });
    await submit.click();
    await requestEntered;
    try {
      await expect(submit).toBeDisabled();
      await expect(
        panel.getByRole('combobox', { name: 'From your agent', exact: true }),
      ).toBeDisabled();
      await expect(panel.getByLabel('Their invite', { exact: true })).toBeDisabled();
      await expect(panel.getByLabel('Note for them (optional)', { exact: true })).toBeDisabled();
      expect(bodies).toHaveLength(1);
    } finally {
      release();
    }
    await expect(panel.getByRole('alert')).toContainText(requestError);
    await expect(panel.getByRole('combobox', { name: 'From your agent', exact: true })).toHaveValue(
      alternate.id,
    );
    await expect(panel.getByLabel('Their invite', { exact: true })).toHaveValue(
      'https://example.test/connect#cci_test_invite_0001',
    );
    await expect(panel.getByLabel('Note for them (optional)', { exact: true })).toHaveValue(
      '  Synthetic connection note  ',
    );
    await expect(panel.getByRole('status').filter({ hasText: recordedNotice })).toHaveCount(0);
    expect(bodies[0]).toMatchObject({
      from_agent_id: alternate.id,
      invite_token: 'cci_test_invite_0001',
      note: 'Synthetic connection note',
    });
    expect(bodies[0].idempotency_key.length).toBeGreaterThan(0);
    // Pasting just the code and removing outer whitespace keeps the logical request unchanged.
    await panel.getByLabel('Their invite', { exact: true }).fill('cci_test_invite_0001');
    await panel
      .getByLabel('Note for them (optional)', { exact: true })
      .fill('Synthetic connection note');
    recover = true;
    await submit.click();
    await expect(panel.getByRole('status')).toContainText(recordedNotice);
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await expect(panel.getByLabel('Their invite', { exact: true })).toHaveValue('');
    await expect(panel.getByLabel('Note for them (optional)', { exact: true })).toHaveValue('');
    await expect(panel.getByRole('combobox', { name: 'From your agent', exact: true })).toHaveValue(
      alternate.id,
    );
    await expect(
      panel.getByRole('list', { name: 'Connections with other people' }).getByRole('listitem'),
    ).toHaveCount(1);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    await expect(panel.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
    await fillDraft(panel);
    freshSubmission = true;
    const freshResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `${base}/requests` &&
        response.request().method() === 'POST',
    );
    await submit.click();
    await (await freshResponse).finished();
    await expect(panel.getByRole('alert')).toContainText(
      'The agents already have a pending connection request.',
    );
    expect(bodies).toHaveLength(3);
    const { idempotency_key: retiredKey, ...confirmedFields } = bodies[1];
    const { idempotency_key: freshKey, ...freshFields } = bodies[2];
    expect(freshKey).not.toBe(retiredKey);
    expect(freshFields).toEqual(confirmedFields);
    await expect(panel.getByLabel('Their invite', { exact: true })).toHaveValue(
      'https://example.test/connect#cci_test_invite_0001',
    );
    await expect(panel.getByLabel('Note for them (optional)', { exact: true })).toHaveValue(
      '  Synthetic connection note  ',
    );
  });
}

for (const edited of ['sender', 'target', 'note'] as const) {
  test(`editing the ${edited} creates a new logical request key while its retry remains stable`, async ({
    page,
  }) => {
    await setup(page);
    const bodies: RequestBody[] = [];
    await page.route(`**${base}/requests`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      bodies.push(route.request().postDataJSON() as RequestBody);
      await route.fulfill({ status: 503, json: { error: requestError } });
    });
    const panel = await openConnections(page);
    await fillDraft(panel, 'test-target-agent-0001');
    const submit = panel.getByRole('button', { name: 'Request connection', exact: true });
    async function failSubmission() {
      const settled = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `${base}/requests` &&
          response.request().method() === 'POST',
      );
      await submit.click();
      await (await settled).finished();
      await expect(panel.getByRole('alert')).toContainText(requestError);
      await expect(submit).toBeEnabled();
    }
    await failSubmission();
    if (edited === 'sender')
      await panel
        .getByRole('combobox', { name: 'From your agent', exact: true })
        .selectOption(sender.id);
    if (edited === 'target')
      await panel.getByLabel('Their invite', { exact: true }).fill('cci_test_invite_0002');
    if (edited === 'note')
      await panel
        .getByLabel('Note for them (optional)', { exact: true })
        .fill('A different synthetic note');
    await failSubmission();
    expect(bodies).toHaveLength(2);
    expect(bodies[1].idempotency_key).not.toBe(bodies[0].idempotency_key);
    if (edited === 'sender') expect(bodies[1].from_agent_id).toBe(sender.id);
    if (edited === 'target') {
      expect(bodies[1].invite_token).toBe('cci_test_invite_0002');
      expect(bodies[1].to_agent_id).toBeUndefined();
    }
    if (edited === 'note') expect(bodies[1].note).toBe('A different synthetic note');
    await failSubmission();
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).toEqual(bodies[1]);
  });
}

for (const failed of ['requests', 'invites'] as const) {
  test(`initial ${failed} read failure settles loading and Refresh recovers the actual lists`, async ({
    page,
  }) => {
    const state = await setup(page, true);
    state.failure = failed;
    const panel = await openConnections(page);
    await expect(panel.getByRole('alert')).toContainText('Connections could not be loaded.');
    await expect(panel.getByRole('alert')).toContainText('Use Refresh to try again.');
    await expect(panel.getByRole('status').filter({ hasText: /Loading/ })).toHaveCount(0);
    await expect(panel.getByText('No requests are waiting.', { exact: true })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
    state.failure = null;
    await refresh(page, panel);
    await expectLists(panel);
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await expect(
      panel.getByRole('button', { name: 'Request connection', exact: true }),
    ).toBeDisabled();
  });
}

test('a later failed refresh preserves both request lists and invites until recovery', async ({
  page,
}) => {
  const state = await setup(page, true);
  const panel = await openConnections(page);
  await expectLists(panel);
  state.failure = 'invites';
  await refresh(page, panel);
  await expect(panel.getByRole('alert')).toContainText(
    'Connections could not be refreshed. Showing the previous list.',
  );
  await expectLists(panel);
  await expect(panel.getByRole('status').filter({ hasText: /Loading/ })).toHaveCount(0);
  state.failure = null;
  state.lists.incoming = [request({ from_agent_name: 'Recovered peer' })];
  state.invites = [{ ...invite(), status: 'used' }];
  await refresh(page, panel);
  await expect(panel.getByRole('alert')).toHaveCount(0);
  const incoming = panel.getByRole('list', { name: 'Requests from other people' });
  await expect(incoming).toContainText('Recovered peer');
  await expect(incoming).not.toContainText('Synthetic peer');
  await expect(panel.getByRole('list', { name: 'Your invites' })).toContainText('Used');
  await expect(panel.getByRole('list', { name: 'Connections with other people' })).toContainText(
    alternate.name,
  );
});

test('confirmed submission followed by a failed reload clears the draft and retries only reads', async ({
  page,
}) => {
  const state = await setup(page);
  const bodies: RequestBody[] = [];
  await page.route(`**${base}/requests`, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    bodies.push(route.request().postDataJSON() as RequestBody);
    state.lists.outgoing = [outgoing()];
    state.failure = 'requests';
    await route.fulfill({ status: 201, json: { request: outgoing(), replayed: false } });
  });
  const panel = await openConnections(page);
  await fillDraft(panel);
  await panel.getByRole('button', { name: 'Request connection', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText(recordedNotice);
  await expect(panel.getByRole('alert')).toContainText(
    'Connections could not be refreshed. Showing the previous list.',
  );
  await expect(panel.getByLabel('Their invite', { exact: true })).toHaveValue('');
  await expect(panel.getByLabel('Note for them (optional)', { exact: true })).toHaveValue('');
  await expect(
    panel.getByRole('button', { name: 'Request connection', exact: true }),
  ).toBeDisabled();
  expect(bodies).toHaveLength(1);
  await refresh(page, panel);
  await expect(panel.getByRole('alert')).toContainText('Connections could not be refreshed.');
  await expect(panel.getByRole('status')).toContainText(recordedNotice);
  expect(bodies).toHaveLength(1);
  state.failure = null;
  await refresh(page, panel);
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(
    panel.getByRole('list', { name: 'Connections with other people' }).getByRole('listitem'),
  ).toHaveCount(1);
  await expect(panel.getByRole('status')).toContainText(recordedNotice);
  expect(bodies).toHaveLength(1);
});
