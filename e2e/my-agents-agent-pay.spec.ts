import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { formatUnits, getAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Agent, Snapshot } from '../shared/types';
import type { SpendPermission } from '../shared/base/types';
import { BASE_NETWORKS } from '../shared/base/chains';
import {
  calendarPeriod,
  LIMIT_PERIOD_SECONDS,
  LIMIT_PERMISSION_END,
  nextBerlinMidnight,
  onchainAllowance,
  spendPermissionHash,
} from '../shared/base/spend-limits';
import { WALLET_CHAIN_ID } from '../shared/base/wallet-network';
import { sealKey } from '../src/base/vault/crypto';
import { expectedWallet } from '../src/base/wallet/derive';

/*
 * "Paying on its own" on an agent's Spending limit screen (Base Pay P2b; the client is
 * src/base/wallet/agentPay.ts and src/agents/v4/AgentPayConsent.tsx). The agent-pay routes are a
 * fixture that keeps the rules of server/base/wallet/agent-pay-consent.ts: what a confirm may store
 * follows the Feed pay switch read per request, a PUT naming more than that is 409 scope_changed,
 * another limit is 409 limit_changed, no active limit is 409 no_spending_limit, and the view never
 * says more than is stored. Any answer can be made to fail once, also after a write took effect
 * (`failures`). Every request the page sends is recorded. MY_AGENTS_SHOTS=<dir> saves screenshots
 * there.
 */

const headers = { 'X-City-Request': '1' };
const password = 'Local-test-only-passphrase-2026';
const NOW = Date.now();
const NETWORK = BASE_NETWORKS[WALLET_CHAIN_ID];
const SPENDER = getAddress(`0x${'3c'.repeat(20)}`);
const USDC = getAddress(NETWORK.tokens.USDC.address);
const LIMIT_ID = '0f3c2b1a-9e8d-4c7b-8a6f-5e4d3c2b1a09';
const AGENTS = 'central-city-agents';
const FEED = 'central-city-agents-and-feed-services';
type Recipients = typeof AGENTS | typeof FEED;

const scout: Agent = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Research scout',
  description: 'Synthetic fixture',
  capability: 'research',
  mode: 'external',
  isDemo: false,
  status: 'online',
  lastSeenAt: new Date(NOW - 60_000).toISOString(),
  createdAt: new Date(NOW - 86_400_000).toISOString(),
  revokedAt: null,
};

/** A fixed synthetic owner key, so the agent's wallet is the one it makes. */
const OWNER_KEY = `0x${'4c'.repeat(32)}` as Hex;
const OWNER = privateKeyToAccount(OWNER_KEY).address;
const WALLET = expectedWallet(OWNER, scout.id);

/** 20 USDC a day under the half model, started three days ago. */
const PERMISSION: SpendPermission = {
  account: WALLET,
  spender: SPENDER,
  token: USDC,
  allowance: onchainAllowance(20_000_000n, 'half'),
  period: LIMIT_PERIOD_SECONDS.day,
  start: nextBerlinMidnight(NOW) - 3 * 86_400,
  end: LIMIT_PERMISSION_END,
  salt: 42n,
  extraData: '0x',
};
const LIMIT_HASH = spendPermissionHash(WALLET_CHAIN_ID, PERMISSION);
/** 30 USDC a day, set elsewhere while the screen is open: another limit, another hash. */
const RAISED_ID = '0f3c2b1a-9e8d-4c7b-8a6f-5e4d3c2b1a0a';
const RAISED: SpendPermission = {
  ...PERMISSION,
  allowance: onchainAllowance(30_000_000n, 'half'),
  salt: 43n,
};
const RAISED_HASH = spendPermissionHash(WALLET_CHAIN_ID, RAISED);

const amount = (raw: bigint, decimals: number, display: string) => ({
  raw: raw.toString(),
  decimals,
  display,
});

interface Consent {
  recipients: Recipients;
  permissionHash: string;
  grantedAt: number;
}

/**
 * An answer the agent-pay route fails with, once, for the next request with this method. `stored`:
 * a PUT or DELETE takes effect first and only its answer fails (lost after the commit).
 */
interface Failure {
  method: 'GET' | 'PUT' | 'DELETE';
  status: number;
  error?: string;
  code?: string;
  stored?: boolean;
}

async function consentServer(page: Page, agent: Agent = scout) {
  const envelope = await sealKey(OWNER_KEY, password, { N: 2 ** 17 });
  const registered = await page.request.post('/api/auth/register', {
    headers,
    data: { name: `AgentPay-${randomUUID().slice(0, 8)}`, password },
  });
  expect(registered.status()).toBe(201);
  const person = (
    (await (await page.request.get('/api/session')).json()) as { operator: { id: string } }
  ).operator.id;
  const baseline = (await (await page.request.get('/api/snapshot')).json()) as Snapshot;
  await page.route('**/api/events*', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({ json: { ...baseline, agents: [agent] } }),
  );
  await page.route('**/api/agents/*/answering', (route) =>
    route.fulfill({
      json: {
        agent_id: scout.id,
        can: true,
        by: 'runtime',
        auto_reply: 'none',
        runtime_connected: true,
      },
    }),
  );
  await page.route('**/api/base/vault', (route) =>
    route.fulfill({
      json: {
        accountId: person,
        exists: true,
        ownerAddress: OWNER,
        ...envelope,
        version: 1,
        backupConfirmedAt: NOW,
        challenge: { nonce: `0x${'ab'.repeat(32)}`, expiresAt: NOW + 300_000 },
      },
    }),
  );
  await page.route('**/api/base/agents/*/wallet', (route) =>
    route.fulfill({
      json: {
        chainId: WALLET_CHAIN_ID,
        network: NETWORK.name,
        testnet: WALLET_CHAIN_ID !== 8453,
        address: WALLET,
        ownerAddress: OWNER,
        spenderAddress: SPENDER,
        deployed: false,
        fundingLocked: false,
        usdc: amount(25_000_000n, 6, '25'),
        eth: amount(0n, 18, '0'),
        readAtBlock: 18_402_113,
        readAt: Date.now(),
        stale: false,
        explorerUrl: null,
      },
    }),
  );
  await page.route('**/api/base/agents/*/wallet/history*', (route) =>
    route.fulfill({ status: 404, json: { error: 'Not found.' } }),
  );

  const state = {
    /** The limit on the card, or none. */
    limit: 'approved' as 'approved' | 'revoke_pending' | 'none',
    /** The limit is the 30 USDC one set elsewhere (RAISED), not the 20 USDC one. */
    raised: false,
    /** Reading the limits fails (503) while this is set. */
    limitsDown: false,
    /** Paying Feed services is on (what a confirm may store follows it, read per request). */
    feedOn: false,
    /** The agent-pay routes answer 404, like a server without them. */
    off: false,
    /** Failures to answer with, each once (see Failure). */
    failures: [] as Failure[],
    consent: null as Consent | null,
    requests: [] as Array<{ method: string; body: unknown; status: number }>,
  };

  const display = (raw: bigint) => formatUnits(raw, 6);
  /** The limit as it stands: the 20 USDC one, or the 30 USDC one set elsewhere. */
  const current = () =>
    state.raised
      ? { id: RAISED_ID, permission: RAISED, hash: RAISED_HASH, cap: 30_000_000n }
      : { id: LIMIT_ID, permission: PERMISSION, hash: LIMIT_HASH, cap: 20_000_000n };
  const limitsView = () => {
    const nowMs = Date.now();
    const now = Math.floor(nowMs / 1000);
    const { id, permission: p, hash, cap } = current();
    const periodStart = p.start + Math.floor((now - p.start) / p.period) * p.period;
    const window = calendarPeriod('day', nowMs);
    return {
      chainId: WALLET_CHAIN_ID,
      network: NETWORK.name,
      testnet: WALLET_CHAIN_ID !== 8453,
      onchainModel: 'half',
      stale: false,
      readAtBlock: 18_402_120,
      readAt: nowMs,
      limits:
        state.limit === 'none'
          ? []
          : [
              {
                permissionId: id,
                token: 'USDC',
                capRaw: cap.toString(),
                capDisplay: display(cap),
                onchainModel: 'half',
                allowanceRaw: p.allowance.toString(),
                allowanceDisplay: display(p.allowance),
                boundaryBurstRaw: (p.allowance * 2n).toString(),
                period: 'day',
                periodSeconds: p.period,
                permissionHash: hash,
                state: state.limit,
                createdAt: NOW,
                onchain: {
                  start: p.start,
                  end: p.end,
                  currentPeriodStart: periodStart,
                  currentPeriodEnd: periodStart + p.period,
                  spentRaw: '4000000',
                  leftRaw: '6000000',
                  readAtBlock: 18_402_120,
                  blockTime: now,
                  phase: 'active',
                  approved: state.limit === 'approved',
                  revoked: false,
                },
                calendar: {
                  periodStart: window.start,
                  periodEnd: window.end,
                  spentRaw: '6000000',
                  leftRaw: '14000000',
                  timeZone: 'Europe/Berlin',
                },
                revoke:
                  state.limit === 'revoke_pending'
                    ? {
                        state: 'awaiting_signature',
                        userOpHash: `0x${'5e'.repeat(32)}`,
                        txHash: null,
                        expiresAt: Date.now() + 600_000,
                      }
                    : null,
              },
            ],
    };
  };
  await page.route('**/api/base/agents/*/wallet/limits**', (route) =>
    route.request().method() !== 'GET'
      ? route.fulfill({ status: 404, json: { error: 'Not found.' } })
      : state.limitsDown
        ? route.fulfill({ status: 503, json: { error: 'Base can’t be read right now.' } })
        : route.fulfill({ json: limitsView() }),
  );

  /** As the service: the active limit (signed or on Base) a consent may cover. */
  const activeLimit = () => (state.limit === 'approved' ? current().hash : null);
  const offered = (): Recipients => (state.feedOn ? FEED : AGENTS);
  const narrower = (a: Recipients, b: Recipients): Recipients =>
    a === AGENTS || b === AGENTS ? AGENTS : a;
  const agentPayView = () => {
    const limit = activeLimit();
    const consent = state.consent;
    const covers = !!(limit && consent && consent.permissionHash === limit);
    const offer = offered();
    const allowed = covers && consent ? narrower(consent.recipients, offer) : null;
    return {
      chainId: WALLET_CHAIN_ID,
      token: 'USDC',
      scope: {
        recipients: allowed ?? offer,
        token: 'USDC',
        withinLimit: limit
          ? {
              permissionHash: limit,
              period: 'day',
              capRaw: current().cap.toString(),
              capDisplay: display(current().cap),
            }
          : null,
      },
      consent: consent
        ? {
            permissionHash: consent.permissionHash,
            recipients: consent.recipients,
            grantedAt: consent.grantedAt,
            coversCurrentLimit: covers,
          }
        : null,
      mayPay: covers,
      confirmRecipients: offer,
      reconfirmAddsFeedServices: allowed === AGENTS && offer === FEED,
    };
  };
  await page.route('**/api/base/agents/*/wallet/agent-pay', async (route) => {
    const request = route.request();
    const method = request.method();
    const body = method === 'GET' ? undefined : (request.postDataJSON() as unknown);
    const answer = async (status: number, json: unknown) => {
      state.requests.push({ method, body, status });
      return route.fulfill({ status, json });
    };
    if (state.off) return answer(404, { error: 'Not found.' });
    // Writes come with the console's request guard, as server/app.ts requires.
    if (method !== 'GET' && (await request.headerValue('x-city-request')) !== '1')
      return answer(403, { error: 'Forbidden.' });
    const at = state.failures.findIndex((each) => each.method === method);
    const failure = at < 0 ? undefined : state.failures.splice(at, 1)[0];
    const failed = (each: Failure) =>
      answer(each.status, {
        error: each.error ?? 'Something broke on our side.',
        ...(each.code ? { code: each.code } : {}),
      });
    if (failure && !failure.stored) return failed(failure);
    const [status, json] = respond(method, body);
    return failure ? failed(failure) : answer(status, json);
  });
  /** As the service, for a request that reaches it: the status and the answer. */
  function respond(method: string, body: unknown): [number, unknown] {
    if (method === 'GET') return [200, agentPayView()];
    if (method === 'DELETE') {
      state.consent = null;
      return [200, agentPayView()];
    }
    const sent = body as { permissionHash?: string; recipients?: Recipients };
    const recipients = sent.recipients ?? AGENTS;
    if (narrower(recipients, offered()) !== recipients)
      return [
        409,
        {
          error:
            'Paying services in the Feed is off now. Look at what the agent may pay again before you allow payments.',
          code: 'scope_changed',
        },
      ];
    const limit = activeLimit();
    if (!limit) return [409, { error: 'Set a spending limit first.', code: 'no_spending_limit' }];
    if (sent.permissionHash?.toLowerCase() !== limit)
      return [
        409,
        {
          error: 'The spending limit changed. Look at it again before you allow payments.',
          code: 'limit_changed',
        },
      ];
    if (!(state.consent?.permissionHash === limit && state.consent.recipients === recipients))
      state.consent = { recipients, permissionHash: limit, grantedAt: Date.now() };
    return [200, agentPayView()];
  }

  const writes = () => state.requests.filter((each) => each.method !== 'GET');
  const reads = () => state.requests.filter((each) => each.method === 'GET').length;
  return Object.assign(state, { writes, reads });
}

/** No browser dialog may ever open on this screen (the confirmation is on the page). */
function noDialogs(page: Page) {
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  return dialogs;
}

async function openWallet(page: Page, theme = 'light', name = scout.name) {
  await page.goto(`/?workspace=v2&theme=${theme}#connect`);
  await expect(page.locator('.app-shell')).toBeVisible();
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole('navigation', { name: 'Workspace', exact: true })
    .getByRole('button', { name: /^My agents/ })
    .first()
    .click();
  await page
    .getByRole('list', { name: 'Agents', exact: true })
    .getByRole('button', { name: new RegExp(`^${name}, `) })
    .click();
  const panel = page.getByRole('complementary', { name: `${name} details` });
  await panel.locator('[data-k="row-wallet"]').click();
  await expect(panel.getByRole('heading', { name: 'Wallet' })).toBeVisible();
  return panel;
}

async function openLimits(page: Page, theme = 'light', name = scout.name) {
  const panel = await openWallet(page, theme, name);
  await panel.locator('[data-k="row-limit"]').click();
  await expect(panel.getByRole('heading', { name: 'Spending limit' })).toBeVisible();
  return panel;
}

async function shot(page: Page, name: string) {
  const dir = process.env.MY_AGENTS_SHOTS;
  if (!dir) return;
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${dir}/agent-pay-${name}.png`, fullPage: true });
}

const STATUS_ALLOWED = /^Allowed since \w{3} \d{1,2} \w{3} \d{4}, \d{2}:\d{2} \(Berlin time\)\.$/;
const NOT_ALLOWED = 'Not allowed. Research scout can’t pay on its own.';
const WITHDRAW = 'Withdraw your permission';

test('no active spending limit: nothing about paying on its own, and nothing is read', async ({
  page,
}) => {
  const server = await consentServer(page);
  const dialogs = noDialogs(page);
  // No limit: the form to set one, and no section.
  server.limit = 'none';
  let panel = await openLimits(page);
  // A signed limit alone doesn't let it pay on its own, and the lead doesn't say it does.
  await expect(panel.locator('[data-k="limit-lead"]')).toHaveText(
    'Set the most Research scout may spend, in a limit you sign. Base holds it to that limit, and you can revoke it any time. Paying on its own needs your separate OK once the limit is set.',
  );
  await expect(panel.getByLabel('Limit in USDC')).toBeVisible();
  await expect(panel.locator('[data-k="agent-pay"]')).toHaveCount(0);
  await expect(panel.getByRole('heading', { name: 'Paying on its own' })).toHaveCount(0);
  // A limit being revoked already blocks every spend: no section either.
  server.limit = 'revoke_pending';
  panel = await openLimits(page);
  await expect(panel.locator('[data-k="limit-card"]')).toContainText('20.00 USDC a day');
  await expect(
    panel
      .getByRole('form', { name: 'Revoke the limit' })
      .getByRole('button', { name: 'Revoke', exact: true }),
  ).toBeVisible();
  await expect(panel.locator('[data-k="agent-pay"]')).toHaveCount(0);
  expect(server.reads()).toBe(0);
  // A server without these routes (404): the card as before, no section.
  server.limit = 'approved';
  server.off = true;
  panel = await openLimits(page);
  await expect(panel.locator('[data-k="limit-card"]')).toContainText('20.00 USDC a day');
  await expect.poll(() => server.reads()).toBe(1);
  await expect(panel.locator('[data-k="agent-pay"]')).toHaveCount(0);
  expect(server.writes()).toEqual([]);
  expect(dialogs).toEqual([]);
});

test('allow it for Central City agents only: the exact limit and recipients go, since when shows', async ({
  page,
}) => {
  const server = await consentServer(page);
  const dialogs = noDialogs(page);
  const panel = await openLimits(page);
  const section = panel.locator('[data-k="agent-pay"]');
  await expect(section.getByRole('heading', { name: 'Paying on its own' })).toBeVisible();
  await expect(section.locator('[data-k="agent-pay-status"]')).toHaveText(NOT_ALLOWED);
  await expect(section).toContainText('If you allow it, Research scout may pay:');
  const recipients = section.locator('[data-k="agent-pay-recipients"] li');
  await expect(recipients).toHaveText(['Other Central City agents.']);
  await expect(section).not.toContainText('Feed');
  await expect(section.locator('[data-k="agent-pay-bounds"]')).toHaveText(
    'Only within the limit you signed: 20.00 USDC a day. Research scout pays without asking you each time, and payments can’t be undone. You can withdraw this at any time.',
  );
  // Plain words only.
  await expect(section).not.toContainText(/consent|recipients|scope|central-city-agents|city_/i);
  // The card is a ceiling, not a permission to pay on its own.
  await expect(panel.locator('[data-k="limit-card"] .w4-eyebrow')).toContainText(
    'The most Research scout may spend',
  );
  await expect(panel.locator('[data-k="limit-card"]')).not.toContainText('can pay');
  // Revoking the whole limit has its own heading, after this section.
  const revoke = panel.getByRole('form', { name: 'Revoke the limit' });
  await expect(revoke.getByRole('heading', { name: 'Revoke the limit' })).toBeVisible();
  expect(
    await panel
      .locator('[data-k="agent-pay"], [data-k="limit-revoke"]')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-k'))),
  ).toEqual(['agent-pay', 'limit-revoke']);
  await shot(page, 'not-allowed-1440-light');

  await section.getByRole('button', { name: 'Allow these payments' }).click();
  const status = section.locator('[data-k="agent-pay-status"]');
  await expect(status).toHaveText(STATUS_ALLOWED);
  await expect(status).toBeFocused();
  await expect(section).toContainText('Research scout may pay:');
  await expect(recipients).toHaveText(['Other Central City agents.']);
  // Exactly the limit on the card and the recipients the screen showed.
  expect(server.writes()).toEqual([
    { method: 'PUT', body: { permissionHash: LIMIT_HASH, recipients: AGENTS }, status: 200 },
  ]);
  await expect(section.getByRole('button', { name: 'Also allow Feed services' })).toHaveCount(0);
  await expect(section.getByRole('button', { name: WITHDRAW, exact: true })).toBeVisible();
  await expect(section.getByRole('button', { name: 'Allow these payments' })).toHaveCount(0);
  await shot(page, 'allowed-1440-light');
  // Read again later, it stays as stored.
  await page.reload();
  const again = await openLimits(page);
  await expect(again.locator('[data-k="agent-pay-status"]')).toHaveText(STATUS_ALLOWED);
  expect(dialogs).toEqual([]);
});

test('allowed for agents only while Feed services are offered: "Also allow Feed services" confirms again with them', async ({
  page,
}) => {
  const server = await consentServer(page);
  server.feedOn = true;
  server.consent = {
    recipients: AGENTS,
    permissionHash: LIMIT_HASH,
    grantedAt: Date.now() - 3_600_000,
  };
  const panel = await openLimits(page);
  const section = panel.locator('[data-k="agent-pay"]');
  await expect(section.locator('[data-k="agent-pay-status"]')).toHaveText(STATUS_ALLOWED);
  const recipients = section.locator('[data-k="agent-pay-recipients"] li');
  // What it allows now: never wider than what was confirmed.
  await expect(recipients).toHaveText(['Other Central City agents.']);
  const offer = section.locator('[data-k="agent-pay-add-feed"]');
  await expect(offer).toContainText(
    'Research scout doesn’t pay services listed in the Feed on its own yet.',
  );
  await expect(offer).toContainText(
    'Central City’s 10% fee comes on top of the price for outside services and is included in the price for services sold by Central City agents.',
  );
  await expect(offer).toContainText('per-call maximum (0.10 USDC unless you set a lower one)');
  await shot(page, 'add-feed-1440-light');

  await offer.getByRole('button', { name: 'Also allow Feed services' }).click();
  await expect(recipients).toHaveCount(2);
  await expect(recipients.nth(0)).toHaveText('Other Central City agents.');
  await expect(recipients.nth(1)).toHaveText(
    'Services listed in the Feed. Central City’s 10% fee comes on top of the price for outside services and is included in the price for services sold by Central City agents. One call never costs more than Research scout’s per-call maximum (0.10 USDC unless you set a lower one), fee included.',
  );
  await expect(offer).toHaveCount(0);
  await expect(section.locator('[data-k="agent-pay-status"]')).toBeFocused();
  expect(server.writes()).toEqual([
    { method: 'PUT', body: { permissionHash: LIMIT_HASH, recipients: FEED }, status: 200 },
  ]);
  expect(server.consent?.recipients).toBe(FEED);

  // Paying Feed services switched off later: the screen says Central City agents only, and why.
  server.feedOn = false;
  await page.reload();
  const again = (await openLimits(page)).locator('[data-k="agent-pay"]');
  await expect(again.locator('[data-k="agent-pay-recipients"] li')).toHaveText([
    'Other Central City agents.',
  ]);
  await expect(again.locator('[data-k="agent-pay-feed-off"]')).toHaveText(
    'Paying services in the Feed is switched off right now.',
  );
  await expect(again.getByRole('button', { name: 'Also allow Feed services' })).toHaveCount(0);
});

test('409 scope_changed: nothing is saved, what it may pay is read again and shown before a new confirm', async ({
  page,
}) => {
  const server = await consentServer(page);
  server.feedOn = true;
  const panel = await openLimits(page);
  const section = panel.locator('[data-k="agent-pay"]');
  const recipients = section.locator('[data-k="agent-pay-recipients"] li');
  await expect(recipients).toHaveCount(2);
  await expect(recipients.nth(1)).toContainText('Services listed in the Feed.');
  const readsBefore = server.reads();
  // Paying Feed services goes off while the page is open.
  server.feedOn = false;
  await section.getByRole('button', { name: 'Allow these payments' }).click();
  const alert = section.locator('[data-k="agent-pay-error"]');
  await expect(alert).toHaveText(
    'What Research scout may pay changed while this page was open, so nothing was saved. Check it again, then confirm.',
  );
  await expect(alert).toBeFocused();
  // Read again: the narrower terms are on screen, and nothing was stored.
  await expect(recipients).toHaveText(['Other Central City agents.']);
  await expect(section.locator('[data-k="agent-pay-status"]')).toHaveText(NOT_ALLOWED);
  expect(server.reads()).toBe(readsBefore + 1);
  expect(server.consent).toBeNull();
  await shot(page, 'scope-changed-1440-light');
  // Confirming now sends what is on screen now.
  await section.getByRole('button', { name: 'Allow these payments' }).click();
  await expect(section.locator('[data-k="agent-pay-status"]')).toHaveText(STATUS_ALLOWED);
  await expect(alert).toHaveCount(0);
  expect(server.writes()).toEqual([
    { method: 'PUT', body: { permissionHash: LIMIT_HASH, recipients: FEED }, status: 409 },
    { method: 'PUT', body: { permissionHash: LIMIT_HASH, recipients: AGENTS }, status: 200 },
  ]);
  expect(server.consent?.recipients).toBe(AGENTS);
});

const LIMIT_CHANGED =
  'The spending limit changed, so nothing was saved. Check it again, then confirm.';

test('409 limit_changed: nothing is saved, the section is read again for the new limit, and the message keeps focus', async ({
  page,
}) => {
  const server = await consentServer(page);
  const panel = await openLimits(page);
  const section = panel.locator('[data-k="agent-pay"]');
  const bounds = section.locator('[data-k="agent-pay-bounds"]');
  await expect(bounds).toContainText('20.00 USDC a day');
  // Another limit is set elsewhere while the page is open.
  server.raised = true;
  await section.getByRole('button', { name: 'Allow these payments' }).click();
  const alert = section.locator('[data-k="agent-pay-error"]');
  await expect(alert).toHaveText(LIMIT_CHANGED);
  await expect(alert).toBeFocused();
  // The card and the section are read again for the new limit; the message still has focus.
  await expect(panel.locator('[data-k="limit-card"]')).toContainText('30.00 USDC a day');
  await expect(bounds).toContainText('30.00 USDC a day');
  await expect(section.locator('[data-k="agent-pay-status"]')).toHaveText(NOT_ALLOWED);
  await expect(alert).toBeFocused();
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
  expect(server.consent).toBeNull();
  await shot(page, 'limit-changed-1440-light');
  // Confirming now sends the new limit.
  await section.getByRole('button', { name: 'Allow these payments' }).click();
  await expect(section.locator('[data-k="agent-pay-status"]')).toHaveText(STATUS_ALLOWED);
  expect(server.writes()).toEqual([
    { method: 'PUT', body: { permissionHash: LIMIT_HASH, recipients: AGENTS }, status: 409 },
    { method: 'PUT', body: { permissionHash: RAISED_HASH, recipients: AGENTS }, status: 200 },
  ]);
});

test('409 limit_changed while the limits can’t be read: the message has focus next to "Check again"', async ({
  page,
}) => {
  const server = await consentServer(page);
  const panel = await openLimits(page);
  const section = panel.locator('[data-k="agent-pay"]');
  // Read first (the card and the section, both for the 20 USDC limit), then the limit changes.
  await expect(section.locator('[data-k="agent-pay-status"]')).toHaveText(NOT_ALLOWED);
  server.raised = true;
  server.limitsDown = true;
  await section.getByRole('button', { name: 'Allow these payments' }).click();
  // The view is for another limit than the card: nothing to confirm, the message has focus.
  const mismatch = section.locator('[data-k="agent-pay-mismatch"]');
  await expect(mismatch).toContainText('The spending limit changed.');
  const alert = section.locator('[data-k="agent-pay-error"]');
  await expect(alert).toHaveText(LIMIT_CHANGED);
  await expect(alert).toBeFocused();
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
  await expect(section.getByRole('button', { name: 'Allow these payments' })).toHaveCount(0);
  await expect(panel.locator('[data-k="limit-card"]')).toContainText('20.00 USDC a day');
  // Read again once the limits answer: the new limit, and its status takes focus.
  server.limitsDown = false;
  await mismatch.getByRole('button', { name: 'Check again' }).click();
  await expect(panel.locator('[data-k="limit-card"]')).toContainText('30.00 USDC a day');
  const status = section.locator('[data-k="agent-pay-status"]');
  await expect(status).toHaveText(NOT_ALLOWED);
  await expect(status).toBeFocused();
  await expect(mismatch).toHaveCount(0);
  await section.getByRole('button', { name: 'Allow these payments' }).click();
  await expect(status).toHaveText(STATUS_ALLOWED);
  expect(server.writes()).toEqual([
    { method: 'PUT', body: { permissionHash: LIMIT_HASH, recipients: AGENTS }, status: 409 },
    { method: 'PUT', body: { permissionHash: RAISED_HASH, recipients: AGENTS }, status: 200 },
  ]);
});

test('withdraw: its own confirmation on the page, Escape keeps it, then one DELETE', async ({
  page,
}) => {
  const server = await consentServer(page);
  const dialogs = noDialogs(page);
  server.feedOn = true;
  server.consent = {
    recipients: FEED,
    permissionHash: LIMIT_HASH,
    grantedAt: Date.now() - 86_400_000,
  };
  const panel = await openLimits(page);
  const section = panel.locator('[data-k="agent-pay"]');
  await expect(section.locator('[data-k="agent-pay-status"]')).toHaveText(STATUS_ALLOWED);
  await expect(section.locator('[data-k="agent-pay-recipients"] li')).toHaveCount(2);
  const withdraw = section.getByRole('button', { name: WITHDRAW, exact: true });
  await withdraw.click();
  // Named by the question on screen, in the same words as the button.
  const confirm = section.getByRole('group', { name: 'Withdraw your permission?', exact: true });
  await expect(confirm).toBeVisible();
  await expect(confirm).toBeFocused();
  await expect(confirm).toHaveAccessibleDescription(
    'Research scout stops paying on its own at once. A payment already sent to Base can’t be stopped.',
  );
  await expect(section.locator('[data-k="agent-pay-withdraw-prompt"]')).toHaveText(
    'Withdraw your permission? Research scout stops paying on its own at once. A payment already sent to Base can’t be stopped.',
  );
  await shot(page, 'withdraw-confirm-1440-light');
  // Escape takes the confirmation back, not the screen; focus returns to Withdraw.
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(panel.getByRole('heading', { name: 'Spending limit' })).toBeVisible();
  await expect(withdraw).toBeFocused();
  // Keep it does the same.
  await withdraw.click();
  await confirm.getByRole('button', { name: 'Keep it' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(withdraw).toBeFocused();
  expect(server.writes()).toEqual([]);

  await withdraw.click();
  await confirm.getByRole('button', { name: 'Yes, withdraw' }).click();
  const status = section.locator('[data-k="agent-pay-status"]');
  await expect(status).toHaveText(NOT_ALLOWED);
  await expect(status).toBeFocused();
  await expect(section.getByRole('button', { name: 'Allow these payments' })).toBeVisible();
  // Not allowed now: what confirming again would allow (Feed services are offered).
  await expect(section.locator('[data-k="agent-pay-recipients"] li')).toHaveCount(2);
  expect(server.writes()).toEqual([{ method: 'DELETE', body: {}, status: 200 }]);
  expect(server.consent).toBeNull();
  expect(dialogs).toEqual([]);
});

test('a permission for an earlier limit: not allowed for this one, and it says when it was given', async ({
  page,
}) => {
  const server = await consentServer(page);
  server.consent = {
    recipients: AGENTS,
    permissionHash: `0x${'77'.repeat(32)}`,
    grantedAt: Date.now() - 2 * 86_400_000,
  };
  const panel = await openLimits(page);
  const status = panel.locator('[data-k="agent-pay-status"]');
  await expect(status).toContainText('Not allowed for this limit. You allowed it on ');
  await expect(status).toContainText('for an earlier limit; a new limit needs your OK again.');
  await expect(panel.getByRole('button', { name: 'Allow these payments' })).toBeVisible();
});

test('at 390 px (dark): the section and the withdraw confirmation fit, no sideways scroll', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const server = await consentServer(page);
  server.feedOn = true;
  server.consent = { recipients: AGENTS, permissionHash: LIMIT_HASH, grantedAt: Date.now() };
  const panel = await openLimits(page, 'dark');
  const section = panel.locator('[data-k="agent-pay"]');
  await section.getByRole('button', { name: 'Also allow Feed services' }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await shot(page, 'add-feed-390-dark');
  await section.getByRole('button', { name: WITHDRAW, exact: true }).click();
  // One decision at a time: the Feed offer steps aside while the withdraw confirmation is open.
  await expect(section.locator('[data-k="agent-pay-add-feed"]')).toHaveCount(0);
  const yes = section.getByRole('button', { name: 'Yes, withdraw' });
  await yes.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  // Dark text on the dark-mode red (white on it is about 2.8:1, below the 4.5:1 text needs).
  expect(await yes.evaluate((element) => getComputedStyle(element).color)).toBe('rgb(11, 13, 18)');
  await shot(page, 'withdraw-390-dark');
  // Kept: the offer is back.
  await section.getByRole('button', { name: 'Keep it' }).click();
  await expect(section.getByRole('button', { name: 'Also allow Feed services' })).toBeVisible();
  expect(server.writes()).toEqual([]);
});

test('at 390 px, a long agent name with no spaces wraps: the section never gets wider than the pane', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const long = 'research_scout_enterprise_knowledge_base_assistant_v2';
  const server = await consentServer(page, { ...scout, name: long });
  server.feedOn = true;
  server.consent = { recipients: AGENTS, permissionHash: LIMIT_HASH, grantedAt: Date.now() };
  const panel = await openLimits(page, 'dark', long);
  const section = panel.locator('[data-k="agent-pay"]');
  await expect(section.locator('[data-k="agent-pay-status"]')).toHaveText(STATUS_ALLOWED);
  await expect(section.locator('[data-k="agent-pay-add-feed"]')).toContainText(long);
  const fits = (box = section) =>
    box.evaluate(
      (element) =>
        element.scrollWidth <= element.clientWidth &&
        element.getBoundingClientRect().right <= window.innerWidth,
    );
  expect(await fits()).toBe(true);
  // The limit card above it, with the name in its first line, too.
  expect(await fits(panel.locator('[data-k="limit-card"]'))).toBe(true);
  await section.getByRole('button', { name: WITHDRAW, exact: true }).click();
  await expect(section.locator('[data-k="agent-pay-withdraw-prompt"]')).toContainText(long);
  expect(await fits()).toBe(true);
  await shot(page, 'long-name-390-dark');
});

test('"Also allow Feed services" refused because they are no longer offered: it says so, nothing changes', async ({
  page,
}) => {
  const server = await consentServer(page);
  server.feedOn = true;
  server.consent = {
    recipients: AGENTS,
    permissionHash: LIMIT_HASH,
    grantedAt: Date.now() - 3_600_000,
  };
  const panel = await openLimits(page);
  const section = panel.locator('[data-k="agent-pay"]');
  const status = section.locator('[data-k="agent-pay-status"]');
  await expect(status).toHaveText(STATUS_ALLOWED);
  const offer = section.locator('[data-k="agent-pay-add-feed"]');
  await expect(offer).toBeVisible();
  // Paying Feed services goes off while the page is open.
  server.feedOn = false;
  await offer.getByRole('button', { name: 'Also allow Feed services' }).click();
  const alert = section.locator('[data-k="agent-pay-error"]');
  // Nothing on screen to check and confirm again: the words say so instead of asking for it.
  await expect(alert).toHaveText('Feed services can’t be added right now, so nothing was changed.');
  await expect(alert).toBeFocused();
  await expect(offer).toHaveCount(0);
  await expect(status).toHaveText(STATUS_ALLOWED);
  await expect(section.locator('[data-k="agent-pay-recipients"] li')).toHaveText([
    'Other Central City agents.',
  ]);
  expect(server.consent?.recipients).toBe(AGENTS);
  expect(server.writes()).toEqual([
    { method: 'PUT', body: { permissionHash: LIMIT_HASH, recipients: FEED }, status: 409 },
  ]);
});

test('409 scope_changed while the limit changed too: the limit message, the card read again, focus kept', async ({
  page,
}) => {
  const server = await consentServer(page);
  server.feedOn = true;
  const panel = await openLimits(page);
  const section = panel.locator('[data-k="agent-pay"]');
  const recipients = section.locator('[data-k="agent-pay-recipients"] li');
  await expect(recipients).toHaveCount(2);
  await expect(section.locator('[data-k="agent-pay-status"]')).toHaveText(NOT_ALLOWED);
  // Both change elsewhere: Feed pay goes off and another limit is set. The server answers
  // scope_changed (it checks that first), and the view read again is for the new limit.
  server.feedOn = false;
  server.raised = true;
  await section.getByRole('button', { name: 'Allow these payments' }).click();
  const alert = section.locator('[data-k="agent-pay-error"]');
  await expect(alert).toHaveText(LIMIT_CHANGED);
  await expect(alert).toBeFocused();
  // The card is read again for it, so the section shows the new limit: no contradicting lines.
  await expect(panel.locator('[data-k="limit-card"]')).toContainText('30.00 USDC a day');
  await expect(section.locator('[data-k="agent-pay-bounds"]')).toContainText('30.00 USDC a day');
  await expect(section.locator('[data-k="agent-pay-mismatch"]')).toHaveCount(0);
  await expect(recipients).toHaveText(['Other Central City agents.']);
  await expect(alert).toBeFocused();
  await section.getByRole('button', { name: 'Allow these payments' }).click();
  await expect(section.locator('[data-k="agent-pay-status"]')).toHaveText(STATUS_ALLOWED);
  expect(server.writes()).toEqual([
    { method: 'PUT', body: { permissionHash: LIMIT_HASH, recipients: FEED }, status: 409 },
    { method: 'PUT', body: { permissionHash: RAISED_HASH, recipients: AGENTS }, status: 200 },
  ]);
});

test('409 no_spending_limit (revoked elsewhere): the message stays until the card shows it, then focus goes to the card', async ({
  page,
}) => {
  const server = await consentServer(page);
  const panel = await openLimits(page);
  const section = panel.locator('[data-k="agent-pay"]');
  await expect(section.locator('[data-k="agent-pay-status"]')).toHaveText(NOT_ALLOWED);
  // Revoked in another tab while the limits can't be read here: the section keeps the message.
  server.limit = 'revoke_pending';
  server.limitsDown = true;
  await section.getByRole('button', { name: 'Allow these payments' }).click();
  const alert = section.locator('[data-k="agent-pay-error"]');
  await expect(alert).toHaveText(LIMIT_CHANGED);
  await expect(alert).toBeFocused();
  const mismatch = section.locator('[data-k="agent-pay-mismatch"]');
  await expect(mismatch).toContainText('The spending limit changed.');
  await expect(section.getByRole('button', { name: 'Allow these payments' })).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
  // The limits answer again: the card says the limit is being revoked, the section goes, and focus
  // goes to the card's state line, not to the page.
  server.limitsDown = false;
  await mismatch.getByRole('button', { name: 'Check again' }).click();
  const state = panel.locator('[data-k="limit-state"]');
  await expect(state).toHaveText(
    'Research scout’s spends are blocked here. Sign the revoke so Base stops it too.',
  );
  await expect(section).toHaveCount(0);
  await expect(state).toBeFocused();
  expect(server.writes()).toEqual([
    { method: 'PUT', body: { permissionHash: LIMIT_HASH, recipients: AGENTS }, status: 409 },
  ]);

  // The same with the limits answering at once: the card is read again right away.
  server.limit = 'approved';
  await page.reload();
  const again = await openLimits(page);
  const fresh = again.locator('[data-k="agent-pay"]');
  await expect(fresh.locator('[data-k="agent-pay-status"]')).toHaveText(NOT_ALLOWED);
  server.limit = 'revoke_pending';
  await fresh.getByRole('button', { name: 'Allow these payments' }).click();
  const card = again.locator('[data-k="limit-state"]');
  await expect(card).toHaveText(
    'Research scout’s spends are blocked here. Sign the revoke so Base stops it too.',
  );
  await expect(fresh).toHaveCount(0);
  await expect(card).toBeFocused();
  expect(server.consent).toBeNull();
});

test('the first read fails: "Try again" keeps focus while it reads, and says it once', async ({
  page,
}) => {
  const server = await consentServer(page);
  server.failures.push({ method: 'GET', status: 503 }, { method: 'GET', status: 503 });
  const panel = await openLimits(page);
  const section = panel.locator('[data-k="agent-pay"]');
  const unread = section.locator('[data-k="agent-pay-unread"]');
  await expect(unread).toHaveText(
    'Couldn’t read whether Research scout may pay on its own. Something broke on our side. Try again',
  );
  await expect(unread).not.toContainText('Try again. Try again');
  await shot(page, 'unread-1440-light');
  // By keyboard: the read fails again, and the message takes focus (not the page).
  const retry = unread.getByRole('button', { name: 'Try again' });
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => server.reads()).toBe(2);
  await expect(unread).toBeFocused();
  // Again: it reads, and the status takes focus.
  await retry.focus();
  await page.keyboard.press('Enter');
  const status = section.locator('[data-k="agent-pay-status"]');
  await expect(status).toHaveText(NOT_ALLOWED);
  await expect(status).toBeFocused();
  expect(server.reads()).toBe(3);
  expect(server.writes()).toEqual([]);
});

test('allow fails: a refusal says why, a lost answer is read again, and an unknown outcome says so', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const server = await consentServer(page);
  const panel = await openLimits(page);
  const section = panel.locator('[data-k="agent-pay"]');
  const status = section.locator('[data-k="agent-pay-status"]');
  const allow = section.getByRole('button', { name: 'Allow these payments' });
  const alert = section.locator('[data-k="agent-pay-error"]');
  await expect(status).toHaveText(NOT_ALLOWED);

  // Refused (409, not a change): why, and that nothing was saved; read again, still not allowed.
  server.failures.push({
    method: 'PUT',
    status: 409,
    code: 'wallet_not_usable',
    error: 'The wallet is paused.',
  });
  let reads = server.reads();
  await allow.click();
  await expect(alert).toHaveText('The wallet is paused. Nothing was saved.');
  await expect(alert).toBeFocused();
  await expect(status).toHaveText(NOT_ALLOWED);
  expect(server.reads()).toBe(reads + 1);

  // No clear answer, and nothing stored: read again, and it says so.
  server.failures.push({ method: 'PUT', status: 500 });
  reads = server.reads();
  await allow.click();
  await expect(alert).toHaveText(
    'No clear answer came back, so this page read it again: nothing was saved.',
  );
  await expect(alert).toBeFocused();
  await expect(status).toHaveText(NOT_ALLOWED);
  expect(server.reads()).toBe(reads + 1);
  expect(server.consent).toBeNull();

  // Stored, but the answer is lost and reading again fails too: no "Not allowed" that may be
  // wrong, only that it isn't known, and a way to check.
  server.failures.push(
    { method: 'PUT', status: 500, stored: true },
    { method: 'GET', status: 503 },
  );
  await allow.click();
  const unsure = section.locator('[data-k="agent-pay-unsure"]');
  await expect(unsure).toHaveText(
    'Not sure it went through. No clear answer came back, so this page can’t tell whether Research scout may now pay on its own. Check again',
  );
  await expect(unsure).toBeFocused();
  await expect(status).toHaveCount(0);
  await expect(allow).toHaveCount(0);
  expect(server.consent).not.toBeNull();
  await shot(page, 'unsure-1440-light');
  await unsure.getByRole('button', { name: 'Check again' }).click();
  await expect(status).toHaveText(STATUS_ALLOWED);
  await expect(status).toBeFocused();

  // Withdrawn, then allowed again with the answer lost after it was stored: read again, allowed.
  await section.getByRole('button', { name: WITHDRAW, exact: true }).click();
  await section.getByRole('button', { name: 'Yes, withdraw' }).click();
  await expect(status).toHaveText(NOT_ALLOWED);
  server.failures.push({ method: 'PUT', status: 502, stored: true });
  await allow.click();
  await expect(status).toHaveText(STATUS_ALLOWED);
  await expect(status).toBeFocused();
  await expect(alert).toHaveCount(0);
  expect(server.writes().map((each) => [each.method, each.status])).toEqual([
    ['PUT', 409],
    ['PUT', 500],
    ['PUT', 500],
    ['DELETE', 200],
    ['PUT', 502],
  ]);
});

test('withdraw fails: the confirmation stays with why, focus stays on it, and it still says allowed', async ({
  page,
}) => {
  const server = await consentServer(page);
  server.consent = { recipients: AGENTS, permissionHash: LIMIT_HASH, grantedAt: Date.now() };
  const panel = await openLimits(page);
  const section = panel.locator('[data-k="agent-pay"]');
  const status = section.locator('[data-k="agent-pay-status"]');
  await expect(status).toHaveText(STATUS_ALLOWED);
  server.failures.push({ method: 'DELETE', status: 500 });
  await section.getByRole('button', { name: WITHDRAW, exact: true }).click();
  const confirm = section.getByRole('group', { name: 'Withdraw your permission?', exact: true });
  const yes = confirm.getByRole('button', { name: 'Yes, withdraw' });
  await yes.click();
  // The owner must not believe payments stopped: the confirmation stays, and so does "Allowed".
  await expect(section.locator('[data-k="agent-pay-error"]')).toHaveText(
    'Something broke on our side.',
  );
  await expect(confirm).toBeVisible();
  await expect(yes).toBeFocused();
  await expect(status).toHaveText(STATUS_ALLOWED);
  expect(server.consent).not.toBeNull();
  // Again: withdrawn.
  await yes.click();
  await expect(status).toHaveText(NOT_ALLOWED);
  await expect(status).toBeFocused();
  await expect(section.locator('[data-k="agent-pay-error"]')).toHaveCount(0);
  expect(server.writes()).toEqual([
    { method: 'DELETE', body: {}, status: 500 },
    { method: 'DELETE', body: {}, status: 200 },
  ]);
  expect(server.consent).toBeNull();
});
