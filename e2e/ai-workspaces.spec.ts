import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Snapshot } from '../shared/types.js';
import { openAdvancedGroup, workspaceSwitcher } from './settings-nav';

const password = 'Local-test-only-passphrase-2026';

async function aiWorkspace(request: APIRequestContext, name: string) {
  const created = await request.post('/api/public/workspaces', {
    headers: { 'content-type': 'application/json' },
    data: { name, idempotency_key: randomUUID() },
  });
  expect(created.status()).toBe(201);
  return (await created.json()) as {
    workspace_id: string;
    workspace_key: string;
    claim_token: string;
    claim_url: string;
  };
}
/** A view in the sidebar's "Workspace" navigation. */
function workspaceNav(page: Page, name: string) {
  return page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('button', { name, exact: true });
}
/** Opens a view from the sidebar's "Advanced workspace" menu. */
async function openAdvanced(page: Page, name: string) {
  await (await openAdvancedGroup(page)).getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
}
async function tool(request: APIRequestContext, key: string, name: string, args: unknown) {
  const res = await request.post(`/api/assistant/tools/${name}`, {
    headers: {
      'content-type': 'application/json',
      'x-city-request': '1',
      authorization: `Bearer ${key}`,
    },
    data: args,
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

test('a person claims an AI-owned workspace and approves a cross-owner request', async ({
  page,
}) => {
  // Two AIs, no humans: each creates its own workspace and a hosted agent with its key.
  const lab = await aiWorkspace(page.request, 'Parity Lab');
  const peer = await aiWorkspace(page.request, 'Peer Lab');
  const scout = (
    await tool(page.request, lab.workspace_key, 'city_create_agent', {
      name: 'Scout',
      capability: 'research',
      mode: 'hosted',
      idempotencyKey: randomUUID(),
    })
  ).agent.id as string;
  const bravo = (
    await tool(page.request, peer.workspace_key, 'city_create_agent', {
      name: 'Bravo',
      capability: 'verify',
      mode: 'hosted',
      idempotencyKey: randomUUID(),
    })
  ).agent.id as string;
  // The lab's AI hands the peer a single-use invite for Scout; the peer requests with it.
  const invite = await tool(page.request, lab.workspace_key, 'city_create_invite', {
    agent_id: scout,
  });
  await tool(page.request, peer.workspace_key, 'city_request_connection', {
    from_agent_id: bravo,
    invite_token: invite.invite_token,
    note: 'Synthetic request from another AI workspace.',
    idempotency_key: randomUUID(),
  });
  expect(new URL(lab.claim_url).hash).toBe(`#claim=${lab.claim_token}`);

  // A person signs up and claims the AI workspace from its claim link. A fresh name per run:
  // account names are unique on a server, and a repeated run would hit "unavailable".
  const person = `Parity-Person-${randomUUID().slice(0, 8)}`;
  await page.goto('/#signin');
  // Sign-in mode, or registration on a fresh installation: wait for the form to settle first.
  // An instant isVisible() snapshot taken before the form drew skipped the switch, and the
  // click on "Create account" below then waited for a button that never came (the 45 s timeout).
  const createOne = page.getByRole('button', { name: 'Create an account', exact: true });
  const createAccount = page.getByRole('button', { name: 'Create account', exact: true });
  await expect(createOne.or(createAccount)).toBeVisible();
  if (await createOne.isVisible()) await createOne.click();
  await expect(createAccount).toBeVisible();
  await page.getByLabel('Account name').fill(person);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await createAccount.click();
  // A new account lands on the workspace overview, the Network map.
  await expect(page.getByRole('heading', { name: 'Network map', level: 1 })).toBeVisible();
  // The open workspace follows the claim link at once and removes the secret from the address.
  await page.goto(`/#claim=${lab.claim_token}`);
  const input = page.getByLabel('Claim agents your AI created');
  await expect(input).toHaveValue(lab.claim_token);
  await expect(page).toHaveURL(/\/$/);
  // Before claiming, the person sees which AI keys keep their access.
  await page.getByRole('button', { name: 'Claim', exact: true }).click();
  await expect(page.getByText('These AIs keep their access after you claim it.')).toBeVisible();
  await expect(page.getByText('initial key (main key)')).toBeVisible();
  await page.getByRole('button', { name: 'Confirm claim', exact: true }).click();
  await expect(page.getByText('AI workspace claimed. You now co-own it')).toBeVisible();

  // The AI workspace appears in the switcher; the person acts in it as co-owner.
  await (await workspaceSwitcher(page)).selectOption({ label: 'Parity Lab (AI workspace)' });
  await expect(page.getByText('AI workspace · you co-own it')).toBeVisible();
  // My agents carries the pending request count; the badge never changes the entry's name.
  const agents = page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('button', { name: 'My agents', exact: true });
  await expect(agents).toHaveAccessibleDescription('1 pending connection request');
  await agents.click();
  await expect(page.getByText('Scout').first()).toBeVisible();

  // The incoming request is clearly labelled as from another person (External, with their
  // workspace); the person approves it.
  await openAdvanced(page, 'Agent permissions');
  const requests = page.getByRole('region', { name: 'Waiting for your approval', exact: true });
  const request = requests.getByRole('listitem').filter({ hasText: 'Bravo' });
  await expect(request.getByText('Bravo', { exact: true }).first()).toBeVisible();
  await expect(request.getByText(/^Peer Lab · received /)).toBeVisible();
  await expect(request.getByText('External', { exact: true })).toBeVisible();
  await request.getByRole('button', { name: 'Approve connection request from Bravo' }).click();
  const others = page.getByRole('region', { name: 'With other people', exact: true });
  await expect(others.getByText('Connection approved.')).toBeVisible();
  await expect(
    others
      .getByRole('list', { name: 'Connections with other people' })
      .getByRole('listitem')
      .filter({ hasText: 'Bravo' }),
  ).toContainText('Connected');
  await expect(requests).toHaveCount(0);

  // The peer AI can now message Scout; the co-owner sees it in the AI workspace.
  await tool(page.request, peer.workspace_key, 'city_send_message', {
    from_agent_id: bravo,
    to_agent_id: scout,
    text: 'Synthetic hello across workspaces.',
    idempotency_key: randomUUID(),
  });
  const state = (await (
    await page.request.get('/api/snapshot', { headers: { 'x-city-workspace': lab.workspace_id } })
  ).json()) as Snapshot;
  expect(state.operator.id).toBe(lab.workspace_id);
  expect(state.events.some((item) => item.type === 'connection.cross_approved')).toBe(true);
  // The external message is marked with the sending owner's label in Messages.
  await (await workspaceSwitcher(page)).selectOption({ label: 'Parity Lab (AI workspace)' });
  await workspaceNav(page, 'Messages').click();
  await page
    .getByRole('navigation', { name: 'Conversations', exact: true })
    .getByRole('button')
    .first()
    .click();
  await expect(page.getByText('External · Peer Lab').first()).toBeVisible();

  // The co-owner's own workspace is untouched and still selectable.
  await (await workspaceSwitcher(page)).selectOption({ label: `${person} (yours)` });
  await expect(page.getByText('Private workspace', { exact: true })).toBeVisible();
});
