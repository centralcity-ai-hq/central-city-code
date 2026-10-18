import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Agent, Snapshot } from '../shared/types';

/*
 * "Make it a Base agent" for one agent on My agents v4. Every behaviour is checked on the agent's
 * Base screen (its pane's Base row → Base, docs/design/my-agents-v4-mockup.html), which runs on
 * src/base/useBaseRegistration.ts. The agent list and the Base routes are synthetic fixtures
 * served through page.route; nothing reaches a chain.
 *
 * The pane's home reads the status for its Base row as well, so the status answers below follow
 * the registration (before or after the first request), never the count of reads.
 */

const headers = { 'X-City-Request': '1' };
const password = 'Local-test-only-passphrase-2026';
const at = '2026-10-09T08:00:00.000Z';
const OWNER = `0x${'ab'.repeat(20)}`;

const atlas: Agent = {
  id: '99999999-9999-4999-8999-999999999999',
  name: 'Harbor',
  description: 'Synthetic fixture',
  capability: 'research',
  mode: 'hosted',
  isDemo: false,
  status: 'online',
  lastSeenAt: at,
  createdAt: at,
  revokedAt: null,
  visibility: 'public',
};

async function fixture(page: Page) {
  const registered = await page.request.post('/api/auth/register', {
    headers,
    data: { name: `Base-reg-${randomUUID().slice(0, 8)}`, password },
  });
  expect(registered.status()).toBe(201);
  const baseline = (await (await page.request.get('/api/snapshot')).json()) as Snapshot;
  const snapshot: Snapshot = { ...baseline, agents: [atlas] };
  await page.route('**/api/events*', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }));
  await page.route('**/api/rooms', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { rooms: [] } }) : route.fallback(),
  );
  await page.route('**/api/v2/connections/requests**', (route) =>
    route.fulfill({ json: { incoming: [], outgoing: [], next_before: null } }),
  );
  await page.route('**/api/agents/*/totals', (route) =>
    route.fulfill({ json: { tasks_done: 0, messages_sent: 0 } }),
  );
}

async function gotoMyAgents(page: Page) {
  await page.goto('/?workspace=v2&theme=light#connect');
  await expect(page.locator('.app-shell')).toBeVisible();
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole('navigation', { name: 'Workspace', exact: true })
    .getByRole('button', { name: /^My agents/ })
    .first()
    .click();
}

/** Harbor's pane on My agents v4, at the agent's home (Base, Messages, Rooms, …). */
async function openPane(page: Page) {
  await gotoMyAgents(page);
  const region = page.getByRole('region', { name: 'Agents', exact: true });
  await region.getByRole('button', { name: /^Harbor, / }).click();
  return page.getByRole('complementary', { name: 'Harbor details' });
}

/** The Base row on the agent's home: "Base" and where the registration stands. */
const baseRow = (pane: Locator) => pane.getByRole('button', { name: /^Base/ });

/** The agent's Base screen: its home's Base row, pushed inside the same pane. */
async function openBaseScreen(page: Page, pane?: Locator) {
  const home = pane ?? (await openPane(page));
  await baseRow(home).click();
  return home.getByRole('region', { name: 'Harbor · Base', exact: true });
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A row of the Base screen by its label (the left-hand text in the mockup). */
function v4Row(screen: Locator, label: string) {
  return screen.locator('.v4b-row').filter({
    has: screen.page().locator('.v4b-k', { hasText: new RegExp(`^${escapeRe(label)}$`) }),
  });
}
const v4Value = (screen: Locator, label: string) => v4Row(screen, label).locator('.v4b-v');

/** The Base screen's finished, final Base ID: the number with its check mark. */
async function expectV4Final(screen: Locator, id: string, timeout?: number) {
  await expect(v4Value(screen, 'Base ID')).toHaveText(id, { timeout });
  await expect(v4Row(screen, 'Base ID').getByRole('img', { name: 'Confirmed' })).toBeVisible();
}

/** The quiet finalizing line: Base's usual time, and after 30 minutes that it takes longer. */
const USUAL_LINE = 'Finalizing on Base · usually 15–30 min';
const LONGER_LINE = 'Finalizing on Base · taking longer than usual';

/** A hand-over in a block: the Base ID with the quiet finalizing line, never the check mark. */
async function expectV4Finalizing(screen: Locator, id: string) {
  await expect(v4Value(screen, 'Base ID')).toHaveText(id);
  await expect(screen.getByText(USUAL_LINE)).toBeVisible();
  await expect(screen.getByRole('img', { name: 'Confirmed' })).toHaveCount(0);
}

/**
 * Waits until the nth request has its answer and the page has had a moment to apply it. The Base
 * screen draws some answers just like the one before (Registering, say), so for those it can't
 * wait on the screen itself.
 */
async function answered(page: Page, count: () => number, n: number) {
  await expect.poll(count, { intervals: [25] }).toBe(n);
  await page.waitForTimeout(150);
}

/*
 * A request that never answers while the panel still shows nothing yet, or a failed attempt: the
 * server may have moved on without the panel hearing it. The panel reads the status itself.
 */
const agentUri = 'https://centralcity.ai/a/k3P9xQ';
const row = (state: string) => ({
  chainId: 8453,
  txHash: null,
  state,
  erc8004AgentId: null,
  agentUri,
});
const confirmedReply = {
  wallet: { address: `0x${'cd'.repeat(20)}`, state: 'derived' },
  identity: { state: 'confirmed', erc8004AgentId: '99', agentUri },
};

/*
 * Newer servers say which stage the registration is in, when to ask again, whether a new attempt is
 * accepted, and which wallet controls the agent's wallet. The panel shows each answer as a whole.
 */
const AGENT_WALLET = `0x1234${'0'.repeat(32)}abcd`;
const BOUND_OWNER = `0xD522${'0'.repeat(32)}2F03`;
const MINT_TX = `0x${'a1'.repeat(32)}`;
const FINAL_TX = `0x${'f0'.repeat(32)}`;
const boundWallet = { address: AGENT_WALLET, ownerAddress: BOUND_OWNER, state: 'derived' };
const staged = (fields: Record<string, unknown>) => ({
  state: 'submitted',
  erc8004AgentId: null,
  provisionalAgentId: null,
  stage: 'registering',
  finality: null,
  canRetry: false,
  pollAfterMs: 2000,
  mintTxHash: null,
  txHash: null,
  agentUri,
  ...fields,
});
const stagedRow = (fields: Record<string, unknown>) => ({
  chainId: 8453,
  wallet: boundWallet,
  ...staged(fields),
});
const stagedReply = (fields: Record<string, unknown>) => ({
  wallet: boundWallet,
  identity: staged(fields),
});
const confirmedFields = {
  state: 'confirmed',
  stage: 'confirmed',
  erc8004AgentId: '1532',
  provisionalAgentId: '1532',
  finality: 'final',
  pollAfterMs: null,
  mintTxHash: MINT_TX,
  txHash: FINAL_TX,
};

/** Each request gets the next answer (a number is an error status); the last one repeats. */
async function registerReplies(page: Page, replies: unknown[]) {
  const sent: { ownerAddress?: string; retry?: boolean }[] = [];
  await page.route('**/api/base/agents/*/register', (route) => {
    sent.push(route.request().postDataJSON());
    const reply = replies[Math.min(sent.length - 1, replies.length - 1)];
    return typeof reply === 'number'
      ? route.fulfill({ status: reply, json: { error: 'Base registration is not available yet.' } })
      : route.fulfill({ json: reply });
  });
  return sent;
}

async function rememberOwner(page: Page, address: string) {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    `cc.base.owner.${atlas.id}`,
    address,
  ] as const);
}

const FINALIZING_INFO =
  'Live now. Base usually finalizes in 15–30 minutes, sometimes longer. Nothing to do: it finishes by itself and the public Central City passport appears.';

test('a failed status read is an error with retry, never an offer to register', async ({
  page,
}) => {
  await fixture(page);
  // Every status read fails until the person asks again.
  let failing = true;
  await page.route('**/api/base/agents/*/registration', (route) =>
    failing
      ? route.fulfill({ status: 503, json: { error: 'Base registration is not available yet.' } })
      : route.fulfill({ json: { identities: [] } }),
  );
  const screen = await openBaseScreen(page);
  await expect(screen.getByRole('alert')).toContainText('couldn’t be loaded');
  await expect(screen.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(0);
  await expect(screen.getByLabel('Your wallet address')).toHaveCount(0);
  failing = false;
  await screen.getByRole('button', { name: 'Try again' }).click();
  await expect(screen.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
});

test('a registration in progress resumes in a fresh browser after the owner re-enters the wallet', async ({
  page,
}) => {
  await fixture(page);
  const identity = {
    state: 'submitted',
    erc8004AgentId: null as string | null,
    agentUri,
  };
  await page.route('**/api/base/agents/*/registration', (route) =>
    route.fulfill({ json: { identities: [{ chainId: 8453, txHash: null, ...identity }] } }),
  );
  const sent: unknown[] = [];
  await page.route('**/api/base/agents/*/register', (route) => {
    sent.push(route.request().postDataJSON());
    expect(route.request().headers()['x-city-request']).toBe('1');
    return route.fulfill({
      json: {
        wallet: { address: `0x${'cd'.repeat(20)}`, state: 'derived' },
        identity: { ...identity, state: 'confirmed', erc8004AgentId: '1532' },
      },
    });
  });
  const screen = await openBaseScreen(page);
  // No address remembered in this browser: the progress shows, plus a way to continue.
  await expect(screen.getByText('Registering on Base')).toBeVisible();
  await screen.getByLabel('Your wallet address').fill(OWNER);
  await screen.getByRole('button', { name: 'Continue', exact: true }).click();
  await expectV4Final(screen, '1532');
  expect(sent).toEqual([{ ownerAddress: OWNER }]);
});

test('an agent without a profile is told it can’t become a Base agent instead of seeing the button', async ({
  page,
}) => {
  // No profile (no manifest, so no visibility or revision): it can't be made public either.
  await fixture(page);
  // The workspace's snapshot is read once, before routing: a read still on its way when the test
  // ends would fail it.
  const snapshot = (await (await page.request.get('/api/snapshot')).json()) as Snapshot;
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({ json: { ...snapshot, agents: [{ ...atlas, visibility: undefined }] } }),
  );
  await page.route('**/api/base/agents/*/registration', (route) =>
    route.fulfill({ json: { identities: [] } }),
  );
  const pane = await openPane(page);
  await expect(baseRow(pane)).toContainText('Not available');
  const screen = await openBaseScreen(page, pane);
  await expect(screen.getByText('Not available for this agent')).toBeVisible();
  await expect(screen.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(0);
  await expect(screen.getByLabel('Your wallet address')).toHaveCount(0);
});

/*
 * Switching agents in the list: the pane is built afresh for each agent, and its Base row must not
 * blank and pop back. An agent without a profile is "Not available" without a read; an agent seen
 * before shows its last value while a fresh read replaces it; an unknown value keeps its place.
 */

/** A second agent of the same person, public with a profile like Harbor. */
const quay: Agent = { ...atlas, id: '88888888-8888-4888-8888-888888888888', name: 'Quay' };

/**
 * Serves the person's workspace with these agents in it. The snapshot is read once, before routing
 * (as in #133): a read still on its way through route.fetch() when the test ends would fail it.
 */
async function withAgents(page: Page, agents: Agent[]) {
  const snapshot = (await (await page.request.get('/api/snapshot')).json()) as Snapshot;
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: { ...snapshot, agents } }));
}

/** Opens an agent's pane from the list (the pane is rebuilt for each agent). */
async function switchTo(page: Page, name: string) {
  await page
    .getByRole('region', { name: 'Agents', exact: true })
    .getByRole('button', { name: new RegExp(`^${name}, `) })
    .click();
  return page.getByRole('complementary', { name: `${name} details`, exact: true });
}

/**
 * Every value the Base row of `name`'s pane is drawn with from now on: read after each change to
 * the page lands, before it is painted, so even a single blank frame is caught.
 */
async function recordBaseRow(page: Page, name: string) {
  const key = `baseRow${name}`;
  await page.evaluate(
    ([agent, slot]) => {
      const drawn: string[] = [];
      (window as unknown as Record<string, string[]>)[slot] = drawn;
      const read = () => {
        const pane = document.querySelector(`[aria-label="${agent} details"]`);
        if (!pane) return;
        const value = pane.querySelector('[data-k="row-base"] .v4b-v');
        const text = value ? (value.textContent ?? '').trim() : '(no value)';
        if (drawn[drawn.length - 1] !== text) drawn.push(text);
      };
      new MutationObserver(read).observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
      read();
    },
    [name, key] as const,
  );
  return () => page.evaluate((slot) => (window as unknown as Record<string, string[]>)[slot]!, key);
}

test('switching to an agent without a profile shows "Not available" at once and reads nothing for it', async ({
  page,
}) => {
  await fixture(page);
  const plain: Agent = { ...quay, visibility: undefined };
  await withAgents(page, [atlas, plain]);
  // Every status read waits until the test answers it.
  const held: Route[] = [];
  await page.route('**/api/base/agents/*/registration', (route) => void held.push(route));
  const readsFor = (id: string) => held.filter((route) => route.request().url().includes(id));
  const pane = await openPane(page);
  await expect.poll(() => readsFor(atlas.id).length).toBe(1);
  // Harbor's value is unknown: its place is kept, empty and see-through, ready to fade in.
  const value = baseRow(pane).locator('.v4b-v');
  await expect(value).toHaveText('');
  await expect(value).toHaveAttribute('data-pending');
  await expect(value).toHaveCSS('opacity', '0');
  await expect(value).toHaveCSS('transition-duration', '0.15s');
  const unknownHeight = (await baseRow(pane).boundingBox())!.height;

  const drawn = await recordBaseRow(page, 'Quay');
  const quayPane = await switchTo(page, 'Quay');
  await expect(baseRow(quayPane)).toContainText('Not available');
  // Drawn with its value from the first frame: never empty, never another agent's.
  expect(await drawn()).toEqual(['Not available']);
  await expect(baseRow(quayPane).locator('.v4b-v')).not.toHaveAttribute('data-pending');
  await baseRow(quayPane).click();
  await expect(
    quayPane
      .getByRole('region', { name: 'Quay · Base', exact: true })
      .getByText('Not available for this agent'),
  ).toBeVisible();
  // Nothing was read for it, from its row or its screen.
  await page.waitForTimeout(300);
  expect(readsFor(plain.id)).toHaveLength(0);

  // Back to Harbor; once its status answers, the value shows in the place that was kept.
  const harbor = await switchTo(page, 'Harbor');
  await expect.poll(() => readsFor(atlas.id).length).toBe(2);
  for (const route of held.splice(0))
    await route.fulfill({ json: { identities: [] } }).catch(() => undefined);
  await expect(baseRow(harbor)).toContainText('Not yet');
  await expect(baseRow(harbor).locator('.v4b-v')).toHaveCSS('opacity', '1');
  expect((await baseRow(harbor).boundingBox())!.height).toBe(unknownHeight);
  // Reduced motion: no fade.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(baseRow(harbor).locator('.v4b-v')).toHaveCSS('transition-duration', '0s');
});

test('an agent opened again shows its last Base value at once, and the fresh read replaces it', async ({
  page,
}) => {
  await fixture(page);
  await withAgents(page, [atlas, quay]);
  const harborReads: Route[] = [];
  await page.route('**/api/base/agents/*/registration', (route) => {
    if (route.request().url().includes(quay.id)) return route.fulfill({ json: { identities: [] } });
    harborReads.push(route);
    // Harbor's first read answers at once; every later one waits for the test.
    if (harborReads.length === 1)
      return route.fulfill({ json: { identities: [stagedRow(confirmedFields)] } });
  });
  const pane = await openPane(page);
  await expect(baseRow(pane)).toContainText('ID 1532');

  // Quay never shows Harbor's value: its place stays empty until its own answer.
  const quayDrawn = await recordBaseRow(page, 'Quay');
  const quayPane = await switchTo(page, 'Quay');
  await expect(baseRow(quayPane)).toContainText('Not yet');
  expect(await quayDrawn()).toEqual(['', 'Not yet']);

  // Harbor again: ID 1532 from the first frame, while its fresh read is still out.
  const harborDrawn = await recordBaseRow(page, 'Harbor');
  const harbor = await switchTo(page, 'Harbor');
  await expect(baseRow(harbor)).toContainText('ID 1532');
  await expect.poll(() => harborReads.length).toBe(2);
  await page.waitForTimeout(150);
  expect(await harborDrawn()).toEqual(['ID 1532']);
  await expect(baseRow(harbor).getByRole('img', { name: 'Confirmed' })).toBeVisible();

  // The fresh answer replaces it.
  await harborReads[1]!.fulfill({
    json: {
      identities: [stagedRow({ stage: 'rechecking', erc8004AgentId: '1532', mintTxHash: MINT_TX })],
    },
  });
  await expect(baseRow(harbor)).toContainText('Re-checking');
  await expect(baseRow(harbor)).not.toContainText('1532');
  expect(await harborDrawn()).toEqual(['ID 1532', 'Re-checking']);
});

test('a last Base value is for showing only: the Base screen offers nothing until its own read answers', async ({
  page,
}) => {
  await fixture(page);
  await withAgents(page, [atlas, quay]);
  const harborReads: Route[] = [];
  await page.route('**/api/base/agents/*/registration', (route) => {
    if (route.request().url().includes(quay.id)) return route.fulfill({ json: { identities: [] } });
    harborReads.push(route);
    // The first read: a failed registration the server would retry. Later ones wait for the test.
    if (harborReads.length === 1)
      return route.fulfill({
        json: { identities: [stagedRow({ state: 'failed', stage: 'failed', canRetry: true })] },
      });
  });
  const sent = await registerReplies(page, [stagedReply(confirmedFields)]);
  const pane = await openPane(page);
  await expect(baseRow(pane)).toContainText('Didn’t go through');
  await switchTo(page, 'Quay');
  const harbor = await switchTo(page, 'Harbor');
  // The row shows the last answer at once…
  await expect(baseRow(harbor)).toContainText('Didn’t go through');
  // …and the Base screen, opened before any fresh read answers, offers nothing at all: every
  // button and field drawn from here on is noted, even one replaced in the same task (it shows
  // among the removed nodes then).
  await page.evaluate(() => {
    const seen = new Set<string>();
    (window as unknown as { baseOffers: Set<string> }).baseOffers = seen;
    const note = (element: Element) => {
      if (element.matches('input')) seen.add(`field ${element.getAttribute('aria-label')}`);
      else if (element.matches('button')) seen.add((element.textContent ?? '').trim());
    };
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of [...record.addedNodes, ...record.removedNodes]) {
          if (!(node instanceof Element)) continue;
          note(node);
          node.querySelectorAll('button, input').forEach(note);
        }
    }).observe(document.body, { subtree: true, childList: true });
  });
  await baseRow(harbor).click();
  const screen = harbor.getByRole('region', { name: 'Harbor · Base', exact: true });
  await expect(screen).toBeVisible();
  await expect.poll(() => harborReads.length).toBe(3);
  await page.waitForTimeout(300);
  await expect(screen.locator('.v4b-body').first()).toHaveAttribute('aria-busy', 'true');
  await expect(screen.getByRole('button')).toHaveCount(1); // Back to Harbor only
  await expect(screen.getByLabel('Your wallet address')).toHaveCount(0);
  // The fresh read decides: the registration went through after all, so Try again never shows.
  for (const route of harborReads.slice(1))
    await route
      .fulfill({ json: { identities: [stagedRow(confirmedFields)] } })
      .catch(() => undefined);
  await expectV4Final(screen, '1532');
  const offered = await page.evaluate(() => [
    ...(window as unknown as { baseOffers: Set<string> }).baseOffers,
  ]);
  expect(offered.filter((text) => /Try again|Continue|Make public|wallet/.test(text))).toEqual([]);
  expect(sent).toEqual([]);
});

/** A private agent with a profile; the PATCH that makes it public; the register calls. */
async function privateAgent(page: Page, register: () => Record<string, unknown>) {
  await fixture(page);
  const calls: string[] = [];
  let visibility: 'private' | 'public' = 'private';
  // Read once, before routing (a read still on its way when the test ends would fail it).
  const snapshot = (await (await page.request.get('/api/snapshot')).json()) as Snapshot;
  await page.route('**/api/snapshot', (route) => {
    calls.push('snapshot');
    return route.fulfill({ json: { ...snapshot, agents: [{ ...atlas, visibility }] } });
  });
  await page.route('**/api/base/agents/*/registration', (route) =>
    route.fulfill({ json: { identities: [] } }),
  );
  await page.route(`**/api/agents/${atlas.id}`, (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    calls.push(`patch ${JSON.stringify(route.request().postDataJSON())}`);
    visibility = 'public';
    return route.fulfill({ json: { agent: { ...atlas, visibility }, changed: true } });
  });
  await page.route('**/api/base/agents/*/register', (route) => {
    calls.push(`register ${JSON.stringify(route.request().postDataJSON())}`);
    return route.fulfill({ json: register() });
  });
  return calls;
}

test('a private agent with a profile asks once before making it public; Cancel sends nothing', async ({
  page,
}) => {
  const calls = await privateAgent(page, () => confirmedReply);
  const pane = await openPane(page);
  await expect(baseRow(pane)).toContainText('Not yet');
  const screen = await openBaseScreen(page, pane);
  await screen.getByLabel('Your wallet address').fill(OWNER);
  await screen.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(screen.getByText('This makes the agent’s profile public. Continue?')).toBeVisible();
  await screen.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(screen.getByText('This makes the agent’s profile public. Continue?')).toHaveCount(0);
  await expect(screen.getByLabel('Your wallet address')).toHaveValue(OWNER);
  expect(calls.filter((call) => !call.startsWith('snapshot'))).toEqual([]);
});

test('Make public and continue: the profile goes public, then the registration starts, and the workspace is re-read', async ({
  page,
}) => {
  const calls = await privateAgent(page, () => confirmedReply);
  const screen = await openBaseScreen(page);
  await screen.getByLabel('Your wallet address').fill(OWNER);
  await screen.getByRole('button', { name: 'Continue', exact: true }).click();
  const before = calls.length;
  await screen.getByRole('button', { name: 'Make public and continue', exact: true }).click();
  await expectV4Final(screen, '99');
  const after = calls.slice(before);
  expect(after.filter((call) => !call.startsWith('snapshot'))).toEqual([
    'patch {"visibility":"public"}',
    `register {"ownerAddress":"${OWNER}"}`,
  ]);
  // The pane re-read the workspace after the profile changed.
  expect(after.indexOf('snapshot')).toBeGreaterThan(after.indexOf('patch {"visibility":"public"}'));
});

test('a registration that fails after the profile went public keeps it public: no revert, Try again offered', async ({
  page,
}) => {
  const calls = await privateAgent(page, () => ({
    wallet: { address: `0x${'cd'.repeat(20)}`, state: 'derived' },
    identity: { state: 'failed', erc8004AgentId: null, agentUri },
  }));
  const screen = await openBaseScreen(page);
  await screen.getByLabel('Your wallet address').fill(OWNER);
  await screen.getByRole('button', { name: 'Continue', exact: true }).click();
  await screen.getByRole('button', { name: 'Make public and continue', exact: true }).click();
  await expect(screen.getByRole('alert')).toContainText('Registration didn’t go through');
  await expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  const sent = calls.filter((call) => !call.startsWith('snapshot'));
  expect(sent).toEqual(['patch {"visibility":"public"}', `register {"ownerAddress":"${OWNER}"}`]);
  expect(sent.filter((call) => call.includes('private'))).toEqual([]);
});

test('the Base row reads nothing while a dialog covers the page, then reads afresh', async ({
  page,
}) => {
  await page.clock.install();
  await fixture(page);
  // In progress, so the row keeps re-reading while it is shown.
  let reads = 0;
  await page.route('**/api/base/agents/*/registration', (route) => {
    reads++;
    return route.fulfill({ json: { identities: [row('submitted')] } });
  });
  const pane = await openPane(page);
  await expect.poll(() => reads).toBeGreaterThan(0);
  await page.clock.fastForward(30_000);
  await expect.poll(() => reads).toBeGreaterThan(1);
  // Claim from a link opens as a dialog over the page: the row stops reading meanwhile.
  await page.getByRole('button', { name: 'Claim from a link', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Claim from a link', exact: true });
  await expect(dialog).toBeVisible();
  await expect(pane).toBeVisible();
  await page.waitForTimeout(300);
  const covered = reads;
  await page.clock.fastForward(60_000);
  await page.waitForTimeout(300);
  expect(reads).toBe(covered);
  // Closed again: one fresh read, and the row goes on as before.
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await expect.poll(() => reads).toBe(covered + 1);
  await expect(baseRow(pane)).toBeVisible();
});

test('a submitted registration keeps advancing by itself until it is confirmed', async ({
  page,
}) => {
  await fixture(page);
  await page.route('**/api/base/agents/*/registration', (route) =>
    route.fulfill({ json: { identities: [] } }),
  );
  const states = ['submitted', 'submitted', 'confirmed'];
  let posts = 0;
  await page.route('**/api/base/agents/*/register', (route) => {
    const state = states[Math.min(posts++, states.length - 1)];
    return route.fulfill({
      json: {
        wallet: { address: `0x${'cd'.repeat(20)}`, state: 'derived' },
        identity: {
          state,
          erc8004AgentId: state === 'confirmed' ? '77' : null,
          agentUri,
        },
      },
    });
  });
  const screen = await openBaseScreen(page);
  await screen.getByLabel('Your wallet address').fill(OWNER);
  await screen.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(screen.getByText('Registering on Base')).toBeVisible();
  // No click needed: the screen asks again every few seconds until the identity is confirmed.
  await expectV4Final(screen, '77', 20_000);
  expect(posts).toBe(3);
});

test('a failed registration offers Try again, which asks the server for a new attempt', async ({
  page,
}) => {
  await fixture(page);
  await page.route('**/api/base/agents/*/registration', (route) =>
    route.fulfill({ json: { identities: [row('failed')] } }),
  );
  const sent: unknown[] = [];
  await page.route('**/api/base/agents/*/register', (route) => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        wallet: { address: `0x${'cd'.repeat(20)}`, state: 'derived' },
        identity: { state: 'confirmed', erc8004AgentId: '88', agentUri },
      },
    });
  });
  const screen = await openBaseScreen(page);
  await expect(screen.getByRole('alert')).toContainText('Registration didn’t go through');
  await screen.getByLabel('Your wallet address').fill(OWNER);
  await screen.getByRole('button', { name: 'Try again' }).click();
  await expectV4Final(screen, '88');
  expect(sent).toEqual([{ ownerAddress: OWNER, retry: true }]);
});

test('a request that never answers cannot stop the screen from advancing', async ({ page }) => {
  await page.clock.install();
  await fixture(page);
  await page.route('**/api/base/agents/*/registration', (route) =>
    route.fulfill({ json: { identities: [row('submitted')] } }),
  );
  let posts = 0;
  await page.route('**/api/base/agents/*/register', (route) => {
    posts++;
    // The first request hangs (as a slow server call did live); later ones answer.
    if (posts === 1) return;
    return route.fulfill({ json: confirmedReply });
  });
  const screen = await openBaseScreen(page);
  await screen.getByLabel('Your wallet address').fill(OWNER);
  await screen.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect.poll(() => posts).toBe(1);
  // Long after the hung request: it is given up, the status read finds it still in progress, and
  // the screen asks again by itself on the next tick. Past a minute it says it is taking longer;
  // its Check again is enabled once nothing is in flight.
  await page.clock.fastForward(61_000);
  await expect(screen.getByText('Taking longer than usual')).toBeVisible();
  await expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled();
  await page.clock.fastForward(5_000);
  await expectV4Final(screen, '99');
  expect(posts).toBeGreaterThanOrEqual(2);
  await expect(screen.getByRole('alert')).toHaveCount(0);
});

test('a first request that never answers picks up the registration the server started', async ({
  page,
}) => {
  await page.clock.install();
  await fixture(page);
  let posts = 0;
  let readsAfter = 0;
  await page.route('**/api/base/agents/*/registration', (route) => {
    if (posts > 0) readsAfter++;
    // Nothing yet when the screen opens; by the time the hung request is given up, it is submitted.
    return route.fulfill({ json: { identities: posts === 0 ? [] : [row('submitted')] } });
  });
  await page.route('**/api/base/agents/*/register', (route) => {
    posts++;
    if (posts === 1) return;
    return route.fulfill({ json: confirmedReply });
  });
  const screen = await openBaseScreen(page);
  await screen.getByLabel('Your wallet address').fill(OWNER);
  await screen.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect.poll(() => posts).toBe(1);
  await page.clock.fastForward(31_000);
  // The status read finds the registration in progress, so the screen advances by itself again.
  await answered(page, () => readsAfter, 1);
  await expect(screen.getByText('Registering on Base')).toBeVisible();
  await page.clock.fastForward(5_000);
  await expectV4Final(screen, '99');
  expect(posts).toBe(2);
  await expect(screen.getByRole('alert')).toHaveCount(0);
});

test('a Try again that never answers is never resent, and the screen follows the new attempt', async ({
  page,
}) => {
  await page.clock.install();
  await fixture(page);
  const sent: unknown[] = [];
  await page.route('**/api/base/agents/*/registration', (route) =>
    // Failed when the screen opens; the retry reached the server, which submitted a new attempt.
    route.fulfill({ json: { identities: [row(sent.length === 0 ? 'failed' : 'submitted')] } }),
  );
  await page.route('**/api/base/agents/*/register', (route) => {
    sent.push(route.request().postDataJSON());
    if (sent.length === 1) return;
    return route.fulfill({ json: confirmedReply });
  });
  const screen = await openBaseScreen(page);
  await expect(screen.getByRole('alert')).toContainText('Registration didn’t go through');
  await screen.getByLabel('Your wallet address').fill(OWNER);
  await screen.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => sent.length).toBe(1);
  await page.clock.fastForward(31_000);
  await expect(screen.getByText('Registering on Base')).toBeVisible();
  await expect(screen.getByRole('button', { name: /Try again/ })).toHaveCount(0);
  await page.clock.fastForward(5_000);
  await expectV4Final(screen, '99');
  // Only the person's own click asked for a new attempt; the screen only ever continued it.
  expect(sent).toEqual([{ ownerAddress: OWNER, retry: true }, { ownerAddress: OWNER }]);
  await expect(screen.getByRole('alert')).toHaveCount(0);
});

test('a request and a status read that both fail leave a calm error and a way to continue', async ({
  page,
}) => {
  await page.clock.install();
  await fixture(page);
  let posts = 0;
  await page.route('**/api/base/agents/*/registration', (route) =>
    posts === 0
      ? route.fulfill({ json: { identities: [] } })
      : route.fulfill({
          status: 503,
          json: { error: 'Base registration is not available yet.' },
        }),
  );
  await page.route('**/api/base/agents/*/register', (route) => {
    posts++;
    if (posts === 1) return;
    return route.fulfill({ json: confirmedReply });
  });
  const screen = await openBaseScreen(page);
  await screen.getByLabel('Your wallet address').fill(OWNER);
  await screen.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect.poll(() => posts).toBe(1);
  await page.clock.fastForward(31_000);
  await expect(screen.getByRole('alert')).toContainText('the status couldn’t be checked');
  // Never a dead end: the person can send it again, and it continues from there.
  await screen.getByRole('button', { name: 'Continue', exact: true }).click();
  await expectV4Final(screen, '99');
  expect(posts).toBe(2);
});

test('a status read that never answers is given up too, and Try again stays the person’s', async ({
  page,
}) => {
  await page.clock.install();
  await fixture(page);
  const sent: unknown[] = [];
  let readsAfter = 0;
  await page.route('**/api/base/agents/*/registration', (route) => {
    // The reads before the request answer; the one after the hung request hangs as well.
    if (sent.length === 0) return route.fulfill({ json: { identities: [row('failed')] } });
    readsAfter++;
  });
  await page.route('**/api/base/agents/*/register', (route) => {
    sent.push(route.request().postDataJSON());
  });
  const screen = await openBaseScreen(page);
  await screen.getByLabel('Your wallet address').fill(OWNER);
  await screen.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => sent.length).toBe(1);
  await page.clock.fastForward(31_000);
  await expect.poll(() => readsAfter).toBe(1);
  await page.clock.fastForward(16_000);
  await expect(
    screen.getByRole('alert').filter({ hasText: 'the status couldn’t be checked' }),
  ).toBeVisible();
  await expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  // Long after: nothing was sent again on the person's behalf.
  await page.clock.fastForward(60_000);
  await page.waitForTimeout(300);
  expect(sent).toEqual([{ ownerAddress: OWNER, retry: true }]);
});

test('a provisional Base ID is never shown, so never as a finished Base agent: it says Registering', async ({
  page,
}) => {
  await page.clock.install();
  await fixture(page);
  await page.route('**/api/base/agents/*/registration', (route) =>
    route.fulfill({ json: { identities: [] } }),
  );
  const sent = await registerReplies(page, [
    stagedReply({ stage: 'registering', pollAfterMs: 2000 }),
    stagedReply({
      stage: 'handing_over',
      provisionalAgentId: '1532',
      finality: 'included',
      mintTxHash: MINT_TX,
      pollAfterMs: 3000,
    }),
  ]);
  const screen = await openBaseScreen(page);
  await screen.getByLabel('Your wallet address').fill(BOUND_OWNER);
  await screen.getByRole('button', { name: 'Continue', exact: true }).click();
  await answered(page, () => sent.length, 1);
  await expect(screen.getByText('Registering on Base')).toBeVisible();
  await expect(screen.getByText(/Base ID/)).toHaveCount(0);
  // Within one poll the server has a provisional Base ID; until the hand-over is in a block the
  // screen shows no number, no transaction, no wallets and nothing finished.
  await page.clock.fastForward(2_000);
  await answered(page, () => sent.length, 2);
  await expect(screen.getByText('Registering on Base')).toBeVisible();
  await expect(screen.getByText(/Base ID/)).toHaveCount(0);
  await expect(screen).not.toContainText('1532');
  await expect(screen).not.toContainText('Finalizing on Base');
  await expect(screen.getByRole('img', { name: 'Confirmed' })).toHaveCount(0);
  await expect(screen.getByRole('link', { name: /basescan/i })).toHaveCount(0);
  await expect(v4Row(screen, 'Controlled by')).toHaveCount(0);
  expect(sent).toHaveLength(2);
});

for (const stage of ['finalizing', 'registered'] as const)
  test(`a hand-over in a block (stage ${stage}) shows the finished agent, finalizing quietly`, async ({
    page,
  }) => {
    await page.clock.install();
    await fixture(page);
    const included = {
      stage,
      provisionalAgentId: '1532',
      finality: stage === 'registered' ? 'safe' : 'included',
      mintTxHash: MINT_TX,
      pollAfterMs: 15000,
    };
    await page.route('**/api/base/agents/*/registration', (route) =>
      route.fulfill({ json: { identities: [stagedRow(included)] } }),
    );
    const sent = await registerReplies(page, [stagedReply(included), stagedReply(confirmedFields)]);
    const pane = await openPane(page);
    // The home's Base row: the ID, the quiet line under it, and no check mark yet.
    await expect(baseRow(pane)).toContainText('ID 1532');
    await expect(pane.getByText(USUAL_LINE)).toBeVisible();
    await expect(baseRow(pane).getByRole('img', { name: 'Confirmed' })).toHaveCount(0);
    const screen = await openBaseScreen(page, pane);
    // The agent looks finished, with a quiet line while Base finalizes. No check mark, no word
    // that says it is final, and no passport or transaction before it is.
    await expectV4Finalizing(screen, '1532');
    await expect(screen.getByText('Registering on Base')).toHaveCount(0);
    await expect(screen.locator('.v4b-k')).toHaveText([
      'Base ID',
      'Harbor’s wallet',
      'Controlled by',
    ]);
    await expect(screen.locator(`a[href="${agentUri}"]`)).toHaveCount(0);
    await expect(screen.locator('a[href^="https://basescan.org/"]')).toHaveCount(0);
    await expect(screen).not.toContainText(/\bDone\b|confirmed|\bfinal\b/i);
    // The "i" opens its note on a click (a tap, or Enter) as a line under the text, inside the
    // row's group (a hover tooltip there was cut off by it), and closes it again.
    const line = screen.locator('.v4b-sub');
    const about = line.getByRole('button', { name: 'More', exact: true });
    const note = line.locator('.v4b-more');
    await expect(note).toHaveText(FINALIZING_INFO);
    await expect(note).toBeHidden();
    await about.click();
    await expect(note).toBeVisible();
    const hide = line.getByRole('button', { name: 'Hide note', exact: true });
    await expect(hide).toHaveAttribute('aria-expanded', 'true');
    const group = screen.locator('.v4b-group:has(.v4b-more)');
    const [shown, box] = [await note.boundingBox(), await group.boundingBox()];
    expect(shown!.y).toBeGreaterThanOrEqual(box!.y);
    expect(shown!.y + shown!.height).toBeLessThanOrEqual(box!.y + box!.height + 0.5);
    await hide.click();
    await expect(note).toBeHidden();
    // The owner the server bound continues it in this browser; nothing to type.
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toEqual({ ownerAddress: BOUND_OWNER });
    await expect(screen.getByLabel('Your wallet address')).toHaveCount(0);
    // Polling goes on; once final the quiet line goes and the passport link appears.
    await page.clock.fastForward(15_000);
    await expect(screen.getByText(USUAL_LINE)).toHaveCount(0);
    await expectV4Final(screen, '1532');
    await expect(screen.getByRole('button', { name: 'More', exact: true })).toHaveCount(0);
    await expect(v4Row(screen, 'Passport')).toHaveAttribute('href', agentUri);
    await expect(v4Value(screen, 'Passport')).toHaveText('k3P9xQ');
    await expect(v4Row(screen, 'Transaction')).toHaveAttribute(
      'href',
      `https://basescan.org/tx/${FINAL_TX}`,
    );
    expect(sent).toHaveLength(2);
  });

test('finalizing for longer than Base usually takes says so calmly, with nothing to do', async ({
  page,
}) => {
  const start = Date.now();
  await page.clock.install({ time: start });
  await fixture(page);
  // The Base ID was seen in a block 29 minutes ago: one more minute within the usual time.
  const finalizing = {
    stage: 'finalizing',
    provisionalAgentId: '1532',
    finality: 'included',
    mintTxHash: MINT_TX,
    startedAt: start - 30 * 60_000,
    idSeenAt: start - 29 * 60_000,
    pollAfterMs: 15000,
  };
  await page.route('**/api/base/agents/*/registration', (route) =>
    route.fulfill({ json: { identities: [stagedRow(finalizing)] } }),
  );
  await registerReplies(page, [stagedReply(finalizing)]);
  const pane = await openPane(page);
  await expect(pane.getByText(USUAL_LINE)).toBeVisible();
  const screen = await openBaseScreen(page, pane);
  await expectV4Finalizing(screen, '1532');
  await page.clock.fastForward(61_000);
  await expect(screen.getByText(LONGER_LINE)).toBeVisible();
  await expect(screen.getByText(USUAL_LINE)).toHaveCount(0);
  await expect(screen.locator('.v4b-sub .v4b-more')).toHaveText(FINALIZING_INFO);
  await expect(v4Value(screen, 'Base ID')).toHaveText('1532');
  await expect(screen.getByRole('img', { name: 'Confirmed' })).toHaveCount(0);
  await expect(screen.getByLabel('Your wallet address')).toHaveCount(0);
  // Back on the agent's home, its Base row says the same.
  await pane.getByRole('button', { name: 'Harbor', exact: true }).click();
  await expect(pane.getByText(LONGER_LINE)).toBeVisible();
});

test('a re-check after the final Base ID says it is re-checking, and shows no number until it settles', async ({
  page,
}) => {
  await fixture(page);
  const rechecking = {
    stage: 'rechecking',
    erc8004AgentId: '1532',
    mintTxHash: MINT_TX,
    pollAfterMs: 5000,
  };
  await page.route('**/api/base/agents/*/registration', (route) =>
    route.fulfill({ json: { identities: [stagedRow(rechecking)] } }),
  );
  const sent = await registerReplies(page, [stagedReply(rechecking)]);
  const pane = await openPane(page);
  await expect(baseRow(pane)).toContainText('Re-checking');
  await expect(baseRow(pane)).not.toContainText('1532');
  const screen = await openBaseScreen(page, pane);
  await expect(v4Row(screen, 'Re-checking on Base')).toContainText('nothing to do');
  await expect.poll(() => sent.length).toBe(1);
  await expect(screen).not.toContainText('1532');
  await expect(screen.getByText(USUAL_LINE)).toHaveCount(0);
  await expect(screen.getByRole('img', { name: 'Confirmed' })).toHaveCount(0);
  await expect(screen.locator(`a[href="${agentUri}"]`)).toHaveCount(0);
  await expect(screen).not.toContainText(/\bDone\b|confirmed|\bfinal\b/i);
});

test('while Base re-checks a replaced block the number is hidden, and the next answer decides it', async ({
  page,
}) => {
  await page.clock.install();
  await fixture(page);
  await page.route('**/api/base/agents/*/registration', (route) =>
    route.fulfill({
      json: { identities: [stagedRow({ stage: 'handing_over', provisionalAgentId: '1532' })] },
    }),
  );
  const sent = await registerReplies(page, [
    stagedReply({
      stage: 'handing_over',
      provisionalAgentId: '1532',
      mintTxHash: MINT_TX,
      pollAfterMs: 2000,
    }),
    // The server may still carry the old number while it re-checks; the screen must not show it.
    stagedReply({ stage: 'rechecking', provisionalAgentId: '1532', pollAfterMs: 5000 }),
    stagedReply({ stage: 'handing_over', provisionalAgentId: '1533', pollAfterMs: 3000 }),
  ]);
  const pane = await openPane(page);
  // A provisional number is never on the home's Base row either.
  await expect(baseRow(pane)).toContainText('Registering');
  await expect(baseRow(pane)).not.toContainText('1532');
  const screen = await openBaseScreen(page, pane);
  await answered(page, () => sent.length, 1);
  await expect(screen.getByText('Registering on Base')).toBeVisible();
  await expect(screen).not.toContainText('1532');
  await expect(screen.getByRole('link', { name: /basescan/i })).toHaveCount(0);
  await page.clock.fastForward(2_000);
  await expect(v4Row(screen, 'Re-checking on Base')).toContainText('nothing to do');
  await expect(screen).not.toContainText('1532');
  await expect(screen.getByRole('link', { name: /basescan/i })).toHaveCount(0);
  await page.clock.fastForward(5_000);
  await expect(screen.getByText('Registering on Base')).toBeVisible();
  await expect(screen).not.toContainText('1533');
  await expect(screen).not.toContainText('1532');
  expect(sent).toHaveLength(3);
});

test('the finished view shows both wallets as the server has them, never a remembered address', async ({
  page,
}) => {
  // This browser remembers a different owner address than the one the server bound.
  await rememberOwner(page, OWNER);
  await page.addInitScript(() => {
    const copied: string[] = [];
    (window as unknown as { copied: string[] }).copied = copied;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void copied.push(text) },
    });
  });
  await fixture(page);
  await page.route('**/api/base/agents/*/registration', (route) =>
    route.fulfill({ json: { identities: [stagedRow(confirmedFields)] } }),
  );
  const pane = await openPane(page);
  // The home's Base row: the final ID with its check mark, and no finalizing line.
  await expect(baseRow(pane)).toContainText('ID 1532');
  await expect(baseRow(pane).getByRole('img', { name: 'Confirmed' })).toBeVisible();
  await expect(pane.getByText(USUAL_LINE)).toHaveCount(0);
  const screen = await openBaseScreen(page, pane);
  await expectV4Final(screen, '1532');
  await expect(screen.getByText(USUAL_LINE)).toHaveCount(0);
  await expect(screen.getByRole('button', { name: 'More', exact: true })).toHaveCount(0);
  await expect(screen.locator('.v4b-k')).toHaveText([
    'Base ID',
    'Passport',
    'Transaction',
    'Harbor’s wallet',
    'Controlled by',
  ]);
  const agentWallet = v4Row(screen, 'Harbor’s wallet');
  const ownerWallet = v4Row(screen, 'Controlled by');
  await expect(screen.locator(`span[title="${AGENT_WALLET}"]`)).toHaveText('0x1234…abcd');
  await expect(agentWallet.locator('.v4b-v')).toHaveText('0x1234…abcd');
  await expect(ownerWallet.locator('.v4b-v')).toHaveText('You · 0xD522…2F03');
  await expect(screen.locator(`span[title="${BOUND_OWNER}"]`)).toHaveText('0xD522…2F03');
  await expect(screen).not.toContainText(OWNER.slice(0, 6));
  await expect(
    screen.getByText(
      'Harbor’s wallet has no seed phrase of its own. Network fee covered by Central City.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(v4Row(screen, 'Passport')).toHaveAttribute('href', agentUri);
  await expect(v4Value(screen, 'Passport')).toHaveText('k3P9xQ');
  await expect(v4Row(screen, 'Transaction')).toHaveAttribute(
    'href',
    `https://basescan.org/tx/${FINAL_TX}`,
  );
  // The copy buttons copy the whole addresses.
  await agentWallet.getByRole('button', { name: 'Copy' }).click();
  await ownerWallet.getByRole('button', { name: 'Copy' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { copied: string[] }).copied))
    .toEqual([AGENT_WALLET, BOUND_OWNER]);
});

test('a final agent shows its own Central City score from its passport; none, and nothing shows', async ({
  page,
}) => {
  await fixture(page);
  await page.route('**/api/base/agents/*/registration', (route) =>
    route.fulfill({ json: { identities: [stagedRow(confirmedFields)] } }),
  );
  // The public passport of Base ID 1532 (only its reputation is read here).
  let score: { average: string; raters: number } | null = { average: '4.6', raters: 12 };
  const asked: string[] = [];
  await page.route('**/api/public/base/agents/1532', (route) => {
    asked.push(route.request().url());
    return route.fulfill({
      json: {
        reputation: {
          readAtBlock: 52_431_007,
          readAt: Date.now(),
          count: 12,
          entries: [],
          score,
          scoredBy: [],
        },
      },
    });
  });
  const pane = await openPane(page);
  await expect(baseRow(pane)).toContainText('ID 1532');
  const line = pane.locator('[data-k="row-base"] [data-k="score"]');
  await expect(line).toHaveText('4.6 ★ from 12 Central City agents');
  const screen = await openBaseScreen(page, pane);
  await expectV4Final(screen, '1532');
  await expect(v4Value(screen, 'Rating')).toHaveText('4.6 ★ from 12 Central City agents');
  expect(asked.length).toBeGreaterThan(0);

  // A passport read with no counted rating: no score line anywhere.
  score = null;
  await page.reload();
  const again = await openPane(page);
  await expect(baseRow(again)).toContainText('ID 1532');
  await expect.poll(() => asked.length).toBeGreaterThan(2);
  await expect(again.locator('[data-k="row-base"] [data-k="score"]')).toHaveCount(0);
  const plain = await openBaseScreen(page, again);
  await expectV4Final(plain, '1532');
  await expect(v4Row(plain, 'Rating')).toHaveCount(0);
});

test('a server that names no owner gets no owner line, even for an address typed here', async ({
  page,
}) => {
  await fixture(page);
  await page.route('**/api/base/agents/*/registration', (route) =>
    route.fulfill({ json: { identities: [] } }),
  );
  // An older server: the wallet has its address but no owner, and the identity has no stage.
  await registerReplies(page, [
    {
      wallet: { address: AGENT_WALLET, state: 'derived' },
      identity: { state: 'confirmed', erc8004AgentId: '77', agentUri },
    },
  ]);
  const screen = await openBaseScreen(page);
  await screen.getByLabel('Your wallet address').fill(OWNER);
  await screen.getByRole('button', { name: 'Continue', exact: true }).click();
  await expectV4Final(screen, '77');
  await expect(screen.locator(`span[title="${AGENT_WALLET}"]`)).toBeVisible();
  await expect(screen.getByText('Controlled by')).toHaveCount(0);
  await expect(screen).not.toContainText(OWNER.slice(0, 6));
});

test('a registration in progress offers Try again only once the server accepts a new attempt', async ({
  page,
}) => {
  await page.clock.install();
  await fixture(page);
  await page.route('**/api/base/agents/*/registration', (route) =>
    route.fulfill({ json: { identities: [stagedRow({ stage: 'registering' })] } }),
  );
  const sent = await registerReplies(page, [
    stagedReply({ stage: 'handing_over', provisionalAgentId: '1532', canRetry: false }),
    stagedReply({ stage: 'handing_over', provisionalAgentId: '1532', canRetry: true }),
  ]);
  const screen = await openBaseScreen(page);
  await answered(page, () => sent.length, 1);
  await expect(screen.getByText('Registering on Base')).toBeVisible();
  await expect(v4Value(screen, 'Registering on Base')).toHaveText('a few seconds');
  await expect(screen.getByRole('button', { name: /Try again/ })).toHaveCount(0);
  await page.clock.fastForward(2_000);
  await answered(page, () => sent.length, 2);
  // The server says the hand-over is stuck (canRetry after refusals): Try again retries the same
  // hand-over now, on the same key (server/base/identity/service.ts handoverRefused).
  await expect(v4Value(screen, 'Registering on Base')).toHaveText('taking long');
  await expect(
    screen.getByText('It isn’t moving. Try again retries the same hand-over now.'),
  ).toBeVisible();
  const retry = screen.getByRole('button', { name: 'Try again', exact: true });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect.poll(() => sent.length).toBe(3);
  // Only the click asks for a new attempt; following the registration never does.
  expect(sent).toEqual([
    { ownerAddress: BOUND_OWNER },
    { ownerAddress: BOUND_OWNER },
    { ownerAddress: BOUND_OWNER, retry: true },
  ]);
});

test('a new attempt for a stuck registration that gets a server error says so, and stays offered', async ({
  page,
}) => {
  await page.clock.install();
  await fixture(page);
  const waiting = {
    stage: 'handing_over',
    provisionalAgentId: '1532',
    canRetry: true,
    pollAfterMs: 3000,
  };
  await page.route('**/api/base/agents/*/registration', (route) =>
    route.fulfill({ json: { identities: [stagedRow(waiting)] } }),
  );
  const sent: { ownerAddress?: string; retry?: boolean }[] = [];
  await page.route('**/api/base/agents/*/register', (route) => {
    const body = route.request().postDataJSON() as { ownerAddress?: string; retry?: boolean };
    sent.push(body);
    // Following the registration works; starting a new attempt gets a server error.
    return body.retry
      ? route.fulfill({ status: 503, json: { error: 'Base registration is not available yet.' } })
      : route.fulfill({ json: stagedReply(waiting) });
  });
  const retries = () => sent.filter((body) => body.retry === true).length;
  const screen = await openBaseScreen(page);
  await expect.poll(() => sent.length).toBe(1);
  const retry = screen.getByRole('button', { name: 'Try again', exact: true });
  await retry.click();
  await expect(screen.getByRole('alert')).toHaveText(
    'The new attempt couldn’t be started just now. Try again in a moment.',
  );
  await expect(retry).toBeEnabled();
  const afterRetry = sent.length;
  // The screen keeps following the registration, at the slower pace, without the retry flag.
  await page.clock.fastForward(30_000);
  await expect.poll(() => sent.length).toBeGreaterThan(afterRetry);
  expect(sent.slice(afterRetry).every((body) => body.retry === undefined)).toBe(true);
  expect(retries()).toBe(1);
  // The message stays until the person tries again, which only their click does.
  await expect(screen.getByRole('alert')).toContainText('couldn’t be started');
  await retry.click();
  await expect.poll(retries).toBe(2);
});

test('a stuck registration that is taking longer drops Check again for Try again', async ({
  page,
}) => {
  await page.clock.install();
  await fixture(page);
  const stuck = { stage: 'registering', canRetry: true, pollAfterMs: 120_000 };
  await page.route('**/api/base/agents/*/registration', (route) =>
    route.fulfill({ json: { identities: [stagedRow(stuck)] } }),
  );
  const sent = await registerReplies(page, [stagedReply(stuck)]);
  const screen = await openBaseScreen(page);
  await answered(page, () => sent.length, 1);
  await page.clock.fastForward(61_000);
  await expect(screen.getByText('Taking longer than usual')).toBeVisible();
  // Not "Base is busy, it continues by itself": the server says it is stuck.
  await expect(screen.getByRole('button', { name: 'Check again' })).toHaveCount(0);
  await expect(screen.getByText('Base is busy. It continues by itself.')).toHaveCount(0);
  await expect(screen.getByText('It isn’t moving. Try again starts a new attempt.')).toBeVisible();
  await screen.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect.poll(() => sent.filter((body) => body.retry === true).length).toBe(1);
});

test('a failed registration the server won’t retry offers no Try again', async ({ page }) => {
  await fixture(page);
  await page.route('**/api/base/agents/*/registration', (route) =>
    route.fulfill({
      json: {
        identities: [stagedRow({ state: 'failed', stage: 'failed', pollAfterMs: null })],
      },
    }),
  );
  const sent = await registerReplies(page, [stagedReply({})]);
  const pane = await openPane(page);
  await expect(baseRow(pane)).toContainText('Didn’t go through');
  const screen = await openBaseScreen(page, pane);
  await expect(screen.getByRole('alert')).toContainText('Registration didn’t go through');
  await expect(screen.getByRole('link', { name: 'Get help' })).toHaveAttribute('href', '/support');
  await expect(screen.getByRole('button', { name: /Try again/ })).toHaveCount(0);
  await expect(screen.getByLabel('Your wallet address')).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(sent).toHaveLength(0);
});

test('the screen asks again when the server says to, with the owner the server bound', async ({
  page,
}) => {
  await page.clock.install();
  await rememberOwner(page, OWNER);
  await fixture(page);
  await page.route('**/api/base/agents/*/registration', (route) =>
    route.fulfill({ json: { identities: [stagedRow({ stage: 'registering' })] } }),
  );
  const sent = await registerReplies(page, [
    stagedReply({ stage: 'handing_over', provisionalAgentId: '1532', pollAfterMs: 2000 }),
    stagedReply({
      stage: 'finalizing',
      provisionalAgentId: '1532',
      finality: 'safe',
      pollAfterMs: 15000,
    }),
  ]);
  const screen = await openBaseScreen(page);
  await answered(page, () => sent.length, 1);
  await expect(screen.getByText('Registering on Base')).toBeVisible();
  await page.clock.fastForward(800);
  await page.waitForTimeout(300);
  expect(sent).toHaveLength(1);
  await page.clock.fastForward(1_400);
  await expectV4Finalizing(screen, '1532');
  expect(sent).toHaveLength(2);
  // Past the old fixed five seconds, short of the fifteen the server asked for.
  await page.clock.fastForward(6_000);
  await page.waitForTimeout(300);
  expect(sent).toHaveLength(2);
  await page.clock.fastForward(10_000);
  await expect.poll(() => sent.length).toBe(3);
  // Never the address remembered in this browser: the owner the server bound.
  expect(sent.every((body) => body.ownerAddress === BOUND_OWNER)).toBe(true);
});

test('a server error while polling waits 30 seconds and keeps going', async ({ page }) => {
  await page.clock.install();
  await fixture(page);
  await page.route('**/api/base/agents/*/registration', (route) =>
    route.fulfill({ json: { identities: [stagedRow({ stage: 'registering' })] } }),
  );
  const sent = await registerReplies(page, [
    stagedReply({ stage: 'handing_over', provisionalAgentId: '1532', pollAfterMs: 2000 }),
    503,
    stagedReply({
      stage: 'finalizing',
      provisionalAgentId: '1532',
      finality: 'safe',
      pollAfterMs: 15000,
    }),
  ]);
  const screen = await openBaseScreen(page);
  await answered(page, () => sent.length, 1);
  await expect(screen.getByText('Registering on Base')).toBeVisible();
  await page.clock.fastForward(2_000);
  await answered(page, () => sent.length, 2);
  // The error is waited out quietly: no alert, and the screen still shows where it stands.
  await expect(screen.getByRole('alert')).toHaveCount(0);
  await expect(screen.getByText('Registering on Base')).toBeVisible();
  // Not at the usual pace: the screen waits out the 30 seconds.
  await page.clock.fastForward(10_000);
  await page.waitForTimeout(300);
  expect(sent).toHaveLength(2);
  await page.clock.fastForward(20_000);
  await expectV4Finalizing(screen, '1532');
  await expect(screen.getByRole('alert')).toHaveCount(0);
  expect(sent).toHaveLength(3);
});

test('a new attempt from the failed screen that gets a server error says so, is never resent by itself, and stays offered', async ({
  page,
}) => {
  // The Base screen starts a new attempt only from its failed screen (none while one is in
  // progress); the owner is the one the server bound.
  await page.clock.install();
  await fixture(page);
  await page.route('**/api/base/agents/*/registration', (route) =>
    route.fulfill({
      json: {
        identities: [
          stagedRow({ state: 'failed', stage: 'failed', canRetry: true, pollAfterMs: null }),
        ],
      },
    }),
  );
  const sent = await registerReplies(page, [503]);
  const screen = await openBaseScreen(page);
  await expect(screen.getByRole('alert')).toContainText('Registration didn’t go through');
  await expect(screen.getByLabel('Your wallet address')).toHaveCount(0);
  await screen.getByRole('button', { name: 'Try again' }).click();
  const said = screen
    .getByRole('alert')
    .filter({ hasText: 'Base registration isn’t available right now.' });
  await expect(said).toHaveText('Base registration isn’t available right now.');
  await expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  // Long after: nothing was sent again by itself, and the message stays.
  await page.clock.fastForward(60_000);
  await page.waitForTimeout(300);
  expect(sent).toEqual([{ ownerAddress: BOUND_OWNER, retry: true }]);
  await expect(said).toBeVisible();
  // Only the person's click tries again.
  await screen.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent).toEqual([
    { ownerAddress: BOUND_OWNER, retry: true },
    { ownerAddress: BOUND_OWNER, retry: true },
  ]);
});

test('an owner an older server refuses with a server error can be corrected, not polled forever', async ({
  page,
}) => {
  await page.clock.install();
  await fixture(page);
  // An older server: the row names no wallet, and a wrong owner for the agent's existing wallet is
  // answered with a plain 500 rather than a conflict.
  await page.route('**/api/base/agents/*/registration', (route) =>
    route.fulfill({ json: { identities: [row('submitted')] } }),
  );
  const WRONG = `0x${'ef'.repeat(20)}`;
  const submitted = {
    wallet: { address: AGENT_WALLET, state: 'derived' },
    identity: { state: 'submitted', erc8004AgentId: null, agentUri },
  };
  // What the right owner gets, request by request: in progress, a passing outage, then confirmed.
  const replies: unknown[] = [submitted, 500, confirmedReply];
  let answeredRight = 0;
  const sent: { ownerAddress?: string }[] = [];
  await page.route('**/api/base/agents/*/register', (route) => {
    const body = route.request().postDataJSON() as { ownerAddress?: string };
    sent.push(body);
    const reply = body.ownerAddress === OWNER ? replies[Math.min(answeredRight++, 2)] : 500;
    return typeof reply === 'number'
      ? route.fulfill({ status: reply, json: { error: 'The operation could not be completed.' } })
      : route.fulfill({ json: reply });
  });
  let screen = await openBaseScreen(page);
  await screen.getByLabel('Your wallet address').fill(WRONG);
  await screen.getByRole('button', { name: 'Continue', exact: true }).click();
  // The error is shown and the form stays, so the person can correct the address.
  await expect(screen.getByRole('alert')).toContainText('could not be completed');
  await expect(screen.getByLabel('Your wallet address')).toHaveValue(WRONG);
  await expect(screen.getByRole('button', { name: /Try again/ })).toHaveCount(0);
  await page.clock.fastForward(60_000);
  await page.waitForTimeout(300);
  expect(sent).toEqual([{ ownerAddress: WRONG }]);

  // After a reload, the remembered wrong address is tried once and the form comes back again.
  await page.goto('about:blank');
  screen = await openBaseScreen(page);
  await expect(screen.getByRole('alert')).toContainText('could not be completed');
  await expect(screen.getByLabel('Your wallet address')).toHaveValue(WRONG);
  await page.clock.fastForward(60_000);
  await page.waitForTimeout(300);
  expect(sent).toEqual([{ ownerAddress: WRONG }, { ownerAddress: WRONG }]);

  // The right address continues; once the server has accepted it, a server error is waited out.
  await screen.getByLabel('Your wallet address').fill(OWNER);
  await screen.getByRole('button', { name: 'Continue', exact: true }).click();
  // Its answer must be applied before the clock moves, or the next call's timer starts after it.
  await answered(page, () => sent.length, 3);
  await expect(screen.getByRole('alert')).toHaveCount(0);
  await page.clock.fastForward(5_000);
  await answered(page, () => sent.length, 4);
  await expect(screen.getByLabel('Your wallet address')).toHaveCount(0);
  await expect(screen.getByRole('alert')).toHaveCount(0);
  await page.clock.fastForward(30_000);
  await expectV4Final(screen, '99');
  expect(sent.slice(2)).toEqual([
    { ownerAddress: OWNER },
    { ownerAddress: OWNER },
    { ownerAddress: OWNER },
  ]);
});

test('an owner other than the bound one is told which wallet controls the agent’s wallet', async ({
  page,
}) => {
  await fixture(page);
  await page.route('**/api/base/agents/*/registration', (route) =>
    route.fulfill({ json: { identities: [] } }),
  );
  const sent: unknown[] = [];
  await page.route('**/api/base/agents/*/register', (route) => {
    const body = route.request().postDataJSON() as { ownerAddress: string };
    sent.push(body);
    return body.ownerAddress === BOUND_OWNER
      ? route.fulfill({ json: stagedReply(confirmedFields) })
      : route.fulfill({
          status: 409,
          json: {
            error: 'This agent already has another wallet.',
            code: 'wallet_conflict',
            ownerAddress: BOUND_OWNER,
          },
        });
  });
  const screen = await openBaseScreen(page);
  await screen.getByLabel('Your wallet address').fill(OWNER);
  await screen.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(screen.getByRole('alert')).toHaveText(
    'Harbor’s wallet is already controlled by 0xD522…2F03. Use that wallet.',
  );
  await expect(screen.getByTitle(BOUND_OWNER, { exact: true })).toBeVisible();
  await screen.getByRole('button', { name: 'Continue with that wallet', exact: true }).click();
  await expectV4Final(screen, '1532');
  expect(sent).toEqual([{ ownerAddress: OWNER }, { ownerAddress: BOUND_OWNER }]);
});

test('a final agent: Room invitations Ask or Don\u2019t accept, saved on the server; no directory switch', async ({
  page,
}) => {
  await fixture(page);
  await page.route('**/api/base/agents/*/registration', (route) =>
    route.fulfill({ json: { identities: [stagedRow(confirmedFields)] } }),
  );
  let settings = { listed: false, invitations: 'ask' };
  const patches: unknown[] = [];
  await page.route(`**/api/agents/${atlas.id}/directory`, async (route) => {
    if (route.request().method() === 'PATCH') {
      const patch = route.request().postDataJSON() as Record<string, unknown>;
      patches.push(patch);
      settings = { ...settings, ...patch };
    }
    return route.fulfill({ json: settings });
  });
  const pane = await openPane(page);
  const screen = await openBaseScreen(page, pane);
  await expectV4Final(screen, '1532');
  // There is no directory any more: no listing switch.
  await expect(screen.getByRole('switch', { name: /in Base Agents/ })).toHaveCount(0);
  await expect(screen.getByText(/A room can invite Harbor by its passport number/)).toBeVisible();
  await screen.getByRole('combobox', { name: 'Room invitations' }).selectOption('never');
  await expect.poll(() => patches.at(-1)).toEqual({ invitations: 'never' });
  await expect(screen.getByText("Rooms can't invite Harbor.", { exact: false })).toBeVisible();
});

test('a server without the directory shows no directory settings on the Base screen', async ({
  page,
}) => {
  await fixture(page);
  await page.route('**/api/base/agents/*/registration', (route) =>
    route.fulfill({ json: { identities: [stagedRow(confirmedFields)] } }),
  );
  await page.route(`**/api/agents/${atlas.id}/directory`, (route) =>
    route.fulfill({ status: 404, json: { error: 'Not found' } }),
  );
  const pane = await openPane(page);
  const screen = await openBaseScreen(page, pane);
  await expectV4Final(screen, '1532');
  await expect(screen.getByRole('switch', { name: /in Base Agents/ })).toHaveCount(0);
});

test('room invitations: requests in the agent’s Messages, counted on its row; Accept opens the way to the room', async ({
  page,
}) => {
  await fixture(page);
  const created = Date.now() - 12 * 60_000;
  let open = [
    {
      id: 'inv-1',
      room: { name: 'Launch week', members: 6 },
      from: { name: 'Juna', baseId: '1400', short: 'Ju1400' },
      note: 'Can you check the sources in our launch post?',
      state: 'open',
      createdAt: created,
      expiresAt: created + 7 * 86_400_000,
      roomId: null,
    },
    {
      id: 'inv-2',
      room: { name: 'Data desk', members: 1 },
      from: { name: 'Orbit', baseId: null, short: null },
      note: '',
      state: 'open',
      createdAt: created,
      expiresAt: created + 7 * 86_400_000,
      roomId: null,
    },
  ];
  const decisions: Array<{ id: string; decision: string }> = [];
  const blocks: unknown[] = [];
  await page.route(`**/api/agents/${atlas.id}/invitation-blocks`, (route) => {
    blocks.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true } });
  });
  await page.route(`**/api/agents/${atlas.id}/invitations`, (route) =>
    route.fulfill({ json: { invitations: open } }),
  );
  await page.route(`**/api/agents/${atlas.id}/invitations/*/decide`, (route) => {
    const id = route.request().url().split('/invitations/')[1]!.split('/')[0]!;
    const { decision } = route.request().postDataJSON() as { decision: string };
    decisions.push({ id, decision });
    const item = open.find((invitation) => invitation.id === id)!;
    open = open.filter((invitation) => invitation.id !== id);
    return route.fulfill({
      json: {
        ...item,
        state: decision === 'accept' ? 'accepted' : 'declined',
        roomId: decision === 'accept' ? 'room-launch' : null,
      },
    });
  });
  const pane = await openPane(page);
  // The Messages row counts the requests (no separate Invitations row).
  const row = pane.getByRole('button', { name: /^Messages/ });
  await expect(row).toContainText('2');
  await expect(pane.getByRole('button', { name: /^Invitations/ })).toHaveCount(0);
  await row.click();
  const requests = pane.getByRole('region', { name: 'Invitation requests' });
  await expect(requests.getByText('Launch week')).toBeVisible();
  await expect(pane.getByText(/From Juna · CC-Ju1400 · 6 members/)).toBeVisible();
  await expect(pane.getByText('Can you check the sources in our launch post?')).toBeVisible();
  await expect(pane.getByText(/From Orbit · 1 member/)).toBeVisible();

  // Block this owner: sends the invitation's id (never an inviter id it doesn't have).
  await pane.getByRole('button', { name: 'Block this owner' }).nth(1).click();
  expect(blocks).toEqual([{ invitationId: 'inv-2' }]);
  await pane.getByRole('button', { name: 'Decline' }).nth(1).click();
  await expect(pane.getByText('Data desk')).toHaveCount(0);
  await pane.getByRole('button', { name: 'Accept' }).click();
  await expect(pane.getByRole('button', { name: /Harbor joined “Launch week”/ })).toBeVisible();
  expect(decisions).toEqual([
    { id: 'inv-2', decision: 'decline' },
    { id: 'inv-1', decision: 'accept' },
  ]);
  // Back home: nothing left to count on Messages.
  await pane.getByRole('button', { name: 'Harbor', exact: true }).first().click();
  await expect(pane.getByRole('button', { name: /^Messages/ })).not.toContainText('2');
});

test('a server without invitations shows no invitation requests', async ({ page }) => {
  await fixture(page);
  await page.route(`**/api/agents/${atlas.id}/invitations`, (route) =>
    route.fulfill({ status: 404, json: { error: 'Not found' } }),
  );
  const pane = await openPane(page);
  await expect(pane.getByRole('button', { name: /^Messages/ })).toBeVisible();
  await expect(pane.getByRole('button', { name: /^Invitations/ })).toHaveCount(0);
});

test('Blocked owners: listed under Room invitations with Unblock; none, nothing shows', async ({
  page,
}) => {
  await fixture(page);
  await page.route('**/api/base/agents/*/registration', (route) =>
    route.fulfill({ json: { identities: [stagedRow(confirmedFields)] } }),
  );
  await page.route(`**/api/agents/${atlas.id}/directory`, (route) =>
    route.fulfill({ json: { listed: false, invitations: 'ask' } }),
  );
  let blocks = [
    {
      invitationId: '11111111-1111-4111-8111-111111111111',
      from: { name: 'Juna', baseId: '1400', short: 'Ju1400' },
      blockedAt: Date.UTC(2026, 9, 12, 9, 0),
    },
  ];
  const deleted: unknown[] = [];
  await page.route(`**/api/agents/${atlas.id}/invitation-blocks`, (route) => {
    if (route.request().method() === 'DELETE') {
      deleted.push(route.request().postDataJSON());
      blocks = [];
      return route.fulfill({ json: { blocked: false } });
    }
    return route.fulfill({ json: { blocks } });
  });
  const pane = await openPane(page);
  const screen = await openBaseScreen(page, pane);
  await expectV4Final(screen, '1532');
  const group = screen.getByRole('group', { name: 'Blocked owners' });
  await expect(group).toContainText('Juna');
  await expect(group).toContainText('CC-Ju1400');
  await group.getByRole('button', { name: "Unblock Juna's owner" }).click();
  await expect(screen.getByRole('group', { name: 'Blocked owners' })).toHaveCount(0);
  expect(deleted).toEqual([{ invitationId: '11111111-1111-4111-8111-111111111111' }]);
});
