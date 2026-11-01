import { test, expect, type Page, type Route } from '@playwright/test';
import { encodeAbiParameters, encodeFunctionResult, parseAbi } from 'viem';
import { checkpointHash, checkpointSigningInput } from '../shared/count-log/index';
import { FEE_CHARGED } from '../src/explorer/proofModel';
import { ENTRYPOINT, IDENTITY_REGISTRY, REPUTATION_REGISTRY } from '../src/verify/onBaseVerify';
import type { OnBaseList, OnBaseRow, Passport } from '../src/verify/onBaseData';
import type { ServiceCall, ServiceCallsPage } from '../shared/explorer-calls';
import { gotoMounted } from './mounted';

/*
 * Explorer v2 (/explorer, the five proof pages and /explorer/agents/:baseId; approved design of
 * 24 Oct 2026). Every read is served here by page.route: the public routes in the shapes of
 * src/verify/onBaseData.ts, shared/explorer-calls.ts and src/agentCount.ts, the count log as in
 * e2e/live-log.spec.ts, and Base itself (https://mainnet.base.org, the only other origin the CSP
 * allows) as JSON-RPC. Anything else that leaves the test server is refused, so no test reads the
 * real chain.
 */

const NOW = Date.now();
const ISO = new Date(NOW).toISOString();
const B = 52_431_207; // latest block
const F = 52_430_000; // finalized block
const N = 52_425_223; // the mints' block
const N_HASH = `0x${'b7'.repeat(32)}`;
const ROUTER_3 = '0xe807a76385ec3d76d17ab955091c12329d0a1403';
const TOPIC = {
  transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  userOperationEvent: '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f',
  beforeExecution: '0xbb47ee3e183a558b1a2ff0874b079f3fc5478b7454eacf2bfc5af2ff5878f972',
};
const RATER_1 = '0x1111111111111111111111111111111111111111';
const RATER_2 = '0x2222222222222222222222222222222222222222';
const STRANGER = '0x9999999999999999999999999999999999999999';

const hex = (n: number | bigint) => `0x${n.toString(16)}`;
const word = (value: string | bigint) => `0x${BigInt(value).toString(16).padStart(64, '0')}`;

type Row = OnBaseRow & { account: string };

const PINAKO: Row = {
  baseId: '99268',
  name: 'Pinako',
  colour: '#0f766e',
  owner: '0xD5224E3CD710AC7c069e66A2dFf29C387D162F03',
  short: 'R6IsTd',
  mintTx: `0x${'a1'.repeat(32)}`,
  status: 'final',
  score: { average: '4.5', raters: 2 },
  account: '0x8c7af5c672fc8bc8658450161278126a5d2816ad',
};
const LUMEN: Row = {
  baseId: '99301',
  name: 'Lumen',
  colour: '#7a5af8',
  owner: '0x4b1c000000000000000000000000000000009e03',
  short: 'Lm4Qr8',
  mintTx: `0x${'a2'.repeat(32)}`,
  status: 'final',
  account: '0x3a1b00000000000000000000000000000000c0de',
};
const HARBOR: Row = {
  baseId: '99412',
  name: 'Harbor',
  colour: '#2563eb',
  owner: '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf',
  short: 'Hb7Qx2',
  mintTx: `0x${'a3'.repeat(32)}`,
  status: 'finalizing',
  finalizingSince: NOW - 6 * 60_000,
  account: '0x2b5ad5c4795c026514f8317c7a215e218dccd6cf',
};
const ROWS = [HARBOR, LUMEN, PINAKO];
const publicRow = ({ account: _account, ...row }: Row): OnBaseRow => row;

function list(rows: Row[] = ROWS, totals: Partial<OnBaseList['totals']> = {}): OnBaseList {
  return {
    rows: rows.map(publicRow),
    totals: {
      onBase: 1284,
      new24h: 37,
      finalizingNow: 1,
      ratedAgents: 412,
      readAtBlock: B,
      readAt: NOW,
      servedAt: NOW,
      ...totals,
    },
    registry: IDENTITY_REGISTRY,
    nextBefore: null,
  };
}

function passport(row: Row, overrides: Partial<Passport> = {}): Passport {
  return {
    ...publicRow(row),
    registry: IDENTITY_REGISTRY,
    mintAccount: row.account,
    agentWallet: row.account,
    registrationTx: row.mintTx,
    registeredAt: NOW - 3 * 86_400_000,
    final: row.status === 'final' ? { block: N, at: NOW - 3 * 86_400_000 + 1_800_000 } : null,
    reputation: {
      readAtBlock: B - 200,
      readAt: NOW,
      count: 2,
      entries: [
        {
          client: RATER_1,
          index: 1,
          from: { name: 'Meridian', baseId: '98001' },
          score: '100',
          tags: ['starred'],
        },
        {
          client: RATER_2,
          index: 1,
          from: { name: 'Compass', baseId: '98002' },
          score: '80',
          tags: ['starred'],
        },
      ],
      score: { average: '4.5', raters: 2 },
      scoredBy: [RATER_1, RATER_2],
    },
    ...overrides,
  };
}

const CALL_A: ServiceCall = {
  tx_hash: `0x${'c1'.repeat(32)}`,
  block: B - 30,
  time: NOW - 60_000,
  payer: '0xAbC0000000000000000000000000000000000001',
  provider: PINAKO.account,
  service: 'Translate a page',
  amount: '0.05',
  provider_amount: '0.045',
  fee: { model: 'included', amount: '0.005', tx_hash: `0x${'c1'.repeat(32)}`, block: B - 30 },
  status: 'settled',
  ref: `0x${'e1'.repeat(32)}`,
};
const CALL_B: ServiceCall = {
  ...CALL_A,
  tx_hash: `0x${'c2'.repeat(32)}`,
  time: NOW - 5 * 60_000,
  payer: '0xAbC0000000000000000000000000000000000002',
  service: 'Summarize a thread',
  amount: '0.10',
  provider_amount: '0.09',
  fee: { model: 'included', amount: '0.01', tx_hash: `0x${'c2'.repeat(32)}`, block: B - 90 },
  ref: `0x${'e2'.repeat(32)}`,
};

function callsPage(items: ServiceCall[] = [CALL_A, CALL_B]): ServiceCallsPage {
  return {
    total: 48_213,
    last24h: 1_532,
    perMinute: 2,
    services24h: 41,
    value24hRaw: '812500000',
    fee24hRaw: '81250000',
    day_as_of: ISO,
    as_of: ISO,
    matches: null,
    items,
    next_cursor: null,
  };
}

const STATS = {
  ai_agents_total: 805_272,
  updated_at: ISO,
  paid_calls: {
    total: 48_213,
    as_of: ISO,
    recent_ms: [],
    recent_complete: true,
    value_settled_raw: '812500000',
  },
  base_agents: { total: 1284, as_of: ISO },
};

/* ------------------------------------------------------------------------------------------ */
/* Routing                                                                                    */
/* ------------------------------------------------------------------------------------------ */

const local = (url: URL) => url.hostname === '127.0.0.1' || url.hostname === 'localhost';

/**
 * The page: hard navigations to an Explorer path get the app shell (as e2e/shell.spec.ts does);
 * every other origin is refused unless a later route answers it (Base, the registration files).
 */
async function serveExplorer(page: Page, { asCentralCity = false } = {}) {
  await page.route(
    (url) => !local(url),
    (route) => route.abort(),
  );
  await page.route(
    (url) => local(url) && /^\/explorer(\/.*)?$/.test(url.pathname),
    async (route) => {
      if (route.request().resourceType() !== 'document') return route.fallback();
      const response = await route.fetch({
        url: new URL('/app.html', route.request().url()).toString(),
      });
      if (!asCentralCity) return route.fulfill({ response });
      // Verify reads the registration file at https://centralcity.ai/a/<short>, which the CSP
      // allows only as 'self', i.e. on centralcity.ai itself. Served from 127.0.0.1 the browser
      // refuses that read, so a full pass needs the page treated as if it were on centralcity.ai.
      const headers = response.headers();
      const csp = headers['content-security-policy'] ?? '';
      expect(csp).toContain("connect-src 'self' https://mainnet.base.org");
      headers['content-security-policy'] = csp.replace(
        "connect-src 'self'",
        "connect-src 'self' https://centralcity.ai",
      );
      return route.fulfill({ response, headers });
    },
  );
  await page.route(
    (url) => local(url) && url.pathname === '/api/public/stats',
    (route) => route.fulfill({ json: STATS }),
  );
}

type Answer = ((url: URL) => unknown) | object | number;
const reply = (route: Route, answer: unknown) =>
  typeof answer === 'number'
    ? route.fulfill({ status: answer, json: { error: 'unavailable' } })
    : route.fulfill({ json: answer });

/** The On Base list (answer: a body, a status, or either per URL). Returns the URLs it saw. */
async function mockList(page: Page, answer: Answer = () => list()) {
  const seen: URL[] = [];
  await page.route(
    (url) => local(url) && url.pathname === '/api/public/base/agents',
    (route) => {
      const url = new URL(route.request().url());
      seen.push(url);
      return reply(route, typeof answer === 'function' ? answer(url) : answer);
    },
  );
  // The Rated agents proof page samples the highest rated Base IDs: the list's rows with a score.
  await page.route(
    (url) => local(url) && url.pathname === '/api/public/base/rated',
    (route) => {
      const ids = list()
        .rows.filter((row) => row.score)
        .map((row) => row.baseId);
      return reply(route, { baseIds: ids, asOf: NOW });
    },
  );
  return seen;
}

/** One passport by Base ID; `gate` holds the answer back until it resolves. */
async function mockPassport(
  page: Page,
  answers: Record<string, Passport | number>,
  gate?: Promise<void>,
) {
  await page.route(
    (url) => local(url) && /^\/api\/public\/base\/agents\/\d+$/.test(url.pathname),
    async (route) => {
      if (gate) await gate;
      const baseId = new URL(route.request().url()).pathname.split('/').pop()!;
      return reply(route, answers[baseId] ?? 404);
    },
  );
}

/** The paid calls route. Returns the URLs it saw. */
async function mockCalls(page: Page, answer: Answer = () => callsPage()) {
  const seen: URL[] = [];
  await page.route(
    (url) => local(url) && url.pathname === '/api/public/explorer/calls',
    (route) => {
      const url = new URL(route.request().url());
      seen.push(url);
      return reply(route, typeof answer === 'function' ? answer(url) : answer);
    },
  );
  return seen;
}

/** A Central City registration file for each row, at the address its tokenURI holds. */
async function mockRegistrationFiles(page: Page) {
  await page.route('https://centralcity.ai/a/*', (route) => {
    const short = new URL(route.request().url()).pathname.split('/').pop();
    const row = ROWS.find((r) => r.short === short);
    return row
      ? route.fulfill({
          headers: { 'access-control-allow-origin': '*' },
          json: {
            type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
            name: row.name,
            registrations: [
              { agentId: Number(row.baseId), agentRegistry: `eip155:8453:${IDENTITY_REGISTRY}` },
            ],
          },
        })
      : route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, json: {} });
  });
}

const feedbackAbi = parseAbi([
  'function readAllFeedback(uint256 agentId, address[] clientAddresses, string tag1, string tag2, bool includeRevoked) view returns (address[] clients, uint64[] feedbackIndexes, int128[] values, uint8[] valueDecimals, string[] tag1s, string[] tag2s, bool[] revokedStatuses)',
]);

type BaseOptions = {
  /** Base does not answer at all (every request refused). */
  down?: boolean;
  /** ownerOf on Base, by Base ID, when it differs from the row's owner. */
  owners?: Record<string, string>;
  /** More receipts by transaction hash (paid calls); null is "no such transaction". */
  receipts?: Record<string, unknown>;
  /** The three heads ProofFinalizing reads in one batch. */
  heads?: { latest: number; safe: number; finalized: number };
  /** Star values (20..100) of RATER_1 and RATER_2 in the Reputation Registry. */
  stars?: [bigint, bigint];
};

/** A mint receipt that proves the row: minted by its own account in its own successful op. */
function mintReceipt(row: Row) {
  return {
    blockNumber: hex(N),
    blockHash: N_HASH,
    status: '0x1',
    logs: [
      { address: ENTRYPOINT, topics: [TOPIC.beforeExecution], data: '0x', logIndex: '0x0' },
      {
        address: IDENTITY_REGISTRY,
        topics: [TOPIC.transfer, word(0n), word(row.account), word(BigInt(row.baseId))],
        data: '0x',
        logIndex: '0x1',
      },
      {
        address: ENTRYPOINT,
        topics: [TOPIC.userOperationEvent, `0x${'0e'.repeat(32)}`, word(row.account), word(0n)],
        data: `0x${[0n, 1n, 1000n, 2000n].map((v) => word(v).slice(2)).join('')}`,
        logIndex: '0x2',
      },
    ],
  };
}

/** A payment receipt with router 3's FeeCharged for the call's payer, payee and ref. */
function paymentReceipt(call: ServiceCall, status = '0x1') {
  return {
    status,
    blockNumber: hex(call.block ?? B),
    blockHash: `0x${'d4'.repeat(32)}`,
    logs: [
      {
        address: ROUTER_3,
        topics: [FEE_CHARGED, word(call.payer), word(call.provider), call.ref],
        data: '0x',
      },
    ],
  };
}

/** Base's public endpoint as JSON-RPC (single and batched). Returns the calls it answered. */
async function mockBase(page: Page, options: BaseOptions = {}) {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const answer = (call: { id: number; method: string; params: unknown[] }) => {
    calls.push(call);
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id: call.id, result });
    switch (call.method) {
      case 'eth_chainId':
        return ok('0x2105');
      case 'eth_blockNumber':
        return ok(hex(B));
      case 'eth_getTransactionReceipt': {
        const tx = String(call.params[0]).toLowerCase();
        if (options.receipts && tx in options.receipts) return ok(options.receipts[tx]);
        const row = ROWS.find((r) => r.mintTx?.toLowerCase() === tx);
        return ok(row ? mintReceipt(row) : null);
      }
      case 'eth_getBlockByNumber': {
        const tag = String(call.params[0]);
        const heads = options.heads ?? { latest: B, safe: B - 100, finalized: F };
        const block = (n: number) => ok({ number: hex(n), hash: `0x${'f1'.repeat(32)}` });
        if (tag === 'latest') return block(heads.latest);
        if (tag === 'safe') return block(heads.safe);
        if (tag === 'finalized') return block(heads.finalized);
        if (tag === hex(N)) return ok({ number: hex(N), hash: N_HASH });
        return ok(null);
      }
      case 'eth_call': {
        const [tx] = call.params as [{ to: string; data: string }];
        if (tx.to.toLowerCase() === REPUTATION_REGISTRY.toLowerCase()) {
          const [one, two] = options.stars ?? [100n, 80n];
          return ok(
            encodeFunctionResult({
              abi: feedbackAbi,
              functionName: 'readAllFeedback',
              result: [
                [RATER_1, RATER_2],
                [1n, 1n],
                [one, two],
                [0, 0],
                ['starred', 'starred'],
                ['', ''],
                [false, false],
              ],
            }),
          );
        }
        const id = BigInt(`0x${tx.data.slice(10, 74)}`).toString();
        const row = ROWS.find((r) => r.baseId === id);
        if (!row)
          return { jsonrpc: '2.0', id: call.id, error: { code: 3, message: 'execution reverted' } };
        return ok(
          tx.data.startsWith('0x6352211e')
            ? encodeAbiParameters(
                [{ type: 'address' }],
                [(options.owners?.[id] ?? row.owner) as `0x${string}`],
              )
            : encodeAbiParameters([{ type: 'string' }], [`https://centralcity.ai/a/${row.short}`]),
        );
      }
      default:
        return { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: 'unexpected' } };
    }
  };
  await page.route('https://mainnet.base.org/**', async (route) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'POST',
    };
    if (route.request().method() === 'OPTIONS')
      return route.fulfill({ status: 204, headers: cors });
    if (options.down) return route.abort('connectionrefused');
    const body = JSON.parse(route.request().postData() ?? '{}');
    return route.fulfill({
      headers: cors,
      json: Array.isArray(body) ? body.map(answer) : answer(body),
    });
  });
  return calls;
}

/** A promise and the function that resolves it: holds a mocked answer back. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

const proofPill = (page: Page) => page.locator('.xp-proofcard-head .xp-pill');
const headline = (page: Page) => page.locator('.xp-numcard .xp-big');
/** One of the agent page's five numbers, by its exact label. */ const kpi = (
  page: Page,
  label: string,
) =>
  page
    .locator('.xp-agent-kpi')
    .filter({ has: page.locator('.xp-stat-label').getByText(label, { exact: true }) });

/* ------------------------------------------------------------------------------------------ */
/* /explorer                                                                                  */
/* ------------------------------------------------------------------------------------------ */

// The owner, 25 Oct: the v2 home is retired (/explorer is the Agent Explorer again); its tests are kept, skipped.
test.describe.skip('/explorer', () => {
  test('the five counters render from the stats and the On Base list', async ({ page }) => {
    await serveExplorer(page);
    await mockList(page);
    await mockCalls(page);
    await mockBase(page, { down: true });
    await page.clock.install({ time: NOW });
    await gotoMounted(page, '/explorer');
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: 'Every AI agent on Central City, live and verifiable.',
      }),
    ).toBeVisible();
    const counts = page.getByRole('region', { name: 'Counts' });
    const value = (label: string) =>
      counts.locator('.xp-stat').filter({ hasText: label }).locator('.xp-stat-value');
    await expect(counts.locator('.xp-stat')).toHaveCount(5);
    // Live: a counter with a known rate (paid calls: 1,532 in 24 h) first stands a little behind
    // its answer and moves up to it, never past it.
    await page.clock.runFor(4_000);
    const early = Number((await value('Paid service calls').textContent())!.replace(/,/g, ''));
    expect(early).toBeGreaterThan(48_000);
    expect(early).toBeLessThan(48_213);
    await page.clock.runFor(45_000);
    await expect(value('AI agents')).toHaveText('805,272');
    await expect(value('On Base now')).toHaveText('1,284');
    await expect(value('Finalizing now')).toHaveText('1');
    await expect(value('Paid service calls')).toHaveText('48,213');
    await expect(value('Rated agents')).toHaveText('412');
    await expect(counts).toContainText('+37 in 24 h');
    await expect(counts).toContainText('1,532 in 24 h');
    // Each counter links to its own proof page.
    for (const [label, href] of [
      ['AI agents', '/explorer/proof/agents'],
      ['On Base now', '/explorer/proof/base'],
      ['Finalizing now', '/explorer/proof/finalizing'],
      ['Paid service calls', '/explorer/proof/calls'],
      ['Rated agents', '/explorer/proof/ratings'],
    ])
      await expect(
        counts.locator('.xp-stat').filter({ hasText: label }).getByRole('link', { name: 'Verify' }),
      ).toHaveAttribute('href', href);
    await expect(page.getByText(`Agents on Base read at Base block 52,431,207`)).toBeVisible();
  });

  test('the in-row Verify opens under the row and closes again', async ({ page }) => {
    await serveExplorer(page);
    await mockList(page);
    await mockCalls(page);
    await mockBase(page, { down: true });
    await gotoMounted(page, '/explorer');
    const table = page.getByRole('region', { name: 'Agents on Base' });
    const row = table.getByRole('row').filter({ hasText: 'Pinako' });
    const button = row.getByRole('button', { name: 'Verify' });
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await button.click();
    const panel = page.getByRole('region', { name: 'Verify Base ID 99268' });
    await expect(panel).toContainText("Couldn't reach Base from your browser");
    await expect(panel).toContainText('nothing is marked as passed');
    const hide = row.getByRole('button', { name: 'Hide' });
    await expect(hide).toHaveAttribute('aria-expanded', 'true');
    await hide.click();
    await expect(panel).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Verify' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  test('a failed search keeps the earlier results and says it got no answer', async ({ page }) => {
    await serveExplorer(page);
    await mockList(page, (url) => {
      const q = url.searchParams.get('q');
      if (q === 'Pinako') return list([PINAKO]);
      if (q) return 503;
      return list();
    });
    await mockCalls(page);
    await mockBase(page, { down: true });
    await gotoMounted(page, '/explorer');
    const table = page.getByRole('region', { name: 'Agents on Base' });
    await expect(table.locator('tbody tr')).toHaveCount(3);

    const search = page.getByRole('searchbox', { name: 'Search the Explorer' });
    await search.fill('Pinako');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByText('Results for')).toContainText('Pinako');
    await expect(table.locator('tbody tr')).toHaveCount(1);
    await expect(table.locator('tbody tr')).toContainText('Pinako');

    await search.fill('Harbor');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'did not get an answer' });
    await expect(alert).toHaveText(/The search for Harbor did not get an answer\./);
    await expect(alert.getByRole('button', { name: 'Try again' })).toBeVisible();
    // The earlier results stay, never replaced by an empty list.
    await expect(page.getByText('Results for')).toContainText('Pinako');
    await expect(table.locator('tbody tr')).toHaveCount(1);
    await expect(table.locator('tbody tr')).toContainText('Pinako');
    await expect(table).not.toContainText('Nothing found.');
  });
});

/* ------------------------------------------------------------------------------------------ */
/* Proof pages                                                                                */
/* ------------------------------------------------------------------------------------------ */

const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

/**
 * The count log: one v2 checkpoint, signed with a key made here. `signature` 'valid' publishes
 * that key; 'invalid' publishes another key under the same kid; a status refuses the log.
 */
async function mockCountLog(page: Page, signature: 'valid' | 'invalid' | number) {
  if (typeof signature === 'number') {
    await page.route(
      (url) => local(url) && url.pathname === '/api/public/count-log/checkpoints',
      (route) => route.fulfill({ status: signature, json: { error: 'unavailable' } }),
    );
    return;
  }
  const body = {
    v: 2 as const,
    date: '2026-10-23',
    tree_size: 804_120,
    withdrawn: 120,
    root: 'cd'.repeat(32),
    prev_hash: null,
    subcounts_commitment: 'ab'.repeat(32),
  };
  const hash = await checkpointHash(body);
  const generate = () =>
    crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ]) as Promise<CryptoKeyPair>;
  const signer = await generate();
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'Ed25519' },
      signer.privateKey,
      checkpointSigningInput(hash) as BufferSource,
    ),
  );
  const published = signature === 'valid' ? signer : await generate();
  const jwk = await crypto.subtle.exportKey('jwk', published.publicKey);
  await page.route(
    (url) => local(url) && url.pathname === '/.well-known/jwks.json',
    (route) =>
      route.fulfill(json({ keys: [{ kid: 'e2e-key', kty: jwk.kty, crv: jwk.crv, x: jwk.x }] })),
  );
  await page.route(
    (url) => local(url) && url.pathname === '/api/public/count-log/checkpoints',
    (route) =>
      route.fulfill(
        json({
          checkpoints: [
            {
              ...body,
              hash,
              signature: { kid: 'e2e-key', sig: Buffer.from(sig).toString('base64url') },
              consistency: [],
            },
          ],
        }),
      ),
  );
}

test.describe('/explorer/proof/agents', () => {
  test('the signed count and "Signature valid"', async ({ page }) => {
    await serveExplorer(page);
    await mockCountLog(page, 'valid');
    await gotoMounted(page, '/explorer/proof/agents');
    await expect(page.getByRole('heading', { level: 1, name: 'AI agents' })).toBeVisible();
    await expect(page.getByText('In the signed count of 2026-10-23')).toBeVisible();
    await expect(headline(page)).toHaveText('804,000');
    await expect(page.locator('.xp-facts')).toContainText('Live now 805,272');
    await expect(proofPill(page)).toHaveText('Signature valid');
    await expect(proofPill(page)).toHaveClass(/xp-pill-ok/);
  });

  test('a signature that does not verify: "Not confirmed"', async ({ page }) => {
    await serveExplorer(page);
    await mockCountLog(page, 'invalid');
    await gotoMounted(page, '/explorer/proof/agents');
    await expect(headline(page)).toHaveText('804,000');
    await expect(proofPill(page)).toHaveText('Not confirmed');
    await expect(proofPill(page)).toHaveClass(/xp-pill-bad/);
    await expect(page.locator('.xp-proofcard')).toContainText('signature does not verify');
  });

  test('no log: "Could not load the log", no number', async ({ page }) => {
    await serveExplorer(page);
    await mockCountLog(page, 503);
    await gotoMounted(page, '/explorer/proof/agents');
    await expect(proofPill(page)).toHaveText('Could not load the log');
    await expect(proofPill(page)).toHaveClass(/xp-pill-muted/);
    await expect(headline(page)).toHaveText('–');
    await expect(
      page.getByText('The log could not be loaded. Try again in a moment.'),
    ).toBeVisible();
  });
});

test.describe('/explorer/proof/base', () => {
  test('the number, and the newest final Base IDs all pass on Base', async ({ page }) => {
    await serveExplorer(page, { asCentralCity: true });
    await mockList(page);
    await mockRegistrationFiles(page);
    await mockBase(page);
    await gotoMounted(page, '/explorer/proof/base');
    await expect(page.getByRole('heading', { level: 1, name: 'On Base' })).toBeVisible();
    await expect(page).toHaveTitle('On Base · Verify · Central City Explorer');
    await expect(headline(page)).toHaveText('1,284');
    await expect(proofPill(page)).toHaveText('Newest 2 checked on Base');
    await expect(proofPill(page)).toHaveClass(/xp-pill-ok/);
    await expect(page.locator('.xp-proofcard')).toContainText('2 of 2 newest pass all checks');
  });

  test('an owner Base does not confirm: "1 of 2 not confirmed"', async ({ page }) => {
    await serveExplorer(page, { asCentralCity: true });
    await mockList(page);
    await mockRegistrationFiles(page);
    await mockBase(page, { owners: { [LUMEN.baseId]: STRANGER } });
    await gotoMounted(page, '/explorer/proof/base');
    await expect(headline(page)).toHaveText('1,284');
    await expect(proofPill(page)).toHaveText('1 of 2 not confirmed');
    await expect(proofPill(page)).toHaveClass(/xp-pill-bad/);
  });

  test('a registration file the browser cannot read is no answer, never red', async ({ page }) => {
    // Served from 127.0.0.1 the CSP refuses https://centralcity.ai/a/<short>: Base answers every
    // check, only the file stays unread (pending).
    await serveExplorer(page);
    await mockList(page);
    await mockBase(page);
    await gotoMounted(page, '/explorer/proof/base');
    await expect(headline(page)).toHaveText('1,284');
    await expect(proofPill(page)).toHaveText('0 of 2 checked, no answer for 2');
    await expect(proofPill(page)).toHaveClass(/xp-pill-muted/);
  });

  test('Base does not answer: "no answer", never a pass or a fail', async ({ page }) => {
    await serveExplorer(page);
    await mockList(page);
    await mockBase(page, { down: true });
    await gotoMounted(page, '/explorer/proof/base');
    await expect(headline(page)).toHaveText('1,284');
    await expect(proofPill(page)).toHaveText('0 of 2 checked, no answer for 2');
    await expect(proofPill(page)).toHaveClass(/xp-pill-muted/);
    await expect(page.locator('.xp-proofcard')).toContainText('2 without an answer from Base');
  });
});

/**
 * Central City's own heads and waiting list (#621). Each answer is a body, a status, or either per
 * URL; 404 (the default) is "not deployed", so the page reads Base here and uses the list rows.
 * Returns the URLs each route saw.
 */
async function mockFinalizing(
  page: Page,
  { heads = 404, waiting = 404 }: { heads?: Answer; waiting?: Answer } = {},
) {
  const seen = { heads: [] as URL[], waiting: [] as URL[] };
  for (const [key, path, answer] of [
    ['heads', '/api/public/base/heads', heads],
    ['waiting', '/api/public/base/finalizing', waiting],
  ] as const) {
    await page.route(
      (url) => local(url) && url.pathname === path,
      (route) => {
        const url = new URL(route.request().url());
        seen[key].push(url);
        return reply(route, typeof answer === 'function' ? answer(url) : answer);
      },
    );
  }
  return seen;
}

const nodeHeads = (over: Record<string, unknown> = {}) => ({
  chainId: 8453,
  latest: String(B),
  safe: String(B - 100),
  finalized: String(B - 1207),
  asOf: NOW,
  stale: false,
  ...over,
});
const CURSOR = `1130401~${'a'.repeat(32)}`;
/** A waiting registration that is not among the newest list rows. */
const OLD_WAITING = {
  ...ROWS.find((row) => row.status === 'finalizing')!,
  baseId: '1130390',
  name: 'Lantern',
  short: 'Ln4t9P',
};

test.describe('/explorer/proof/finalizing', () => {
  test('the number waiting, and the three heads read from Base', async ({ page }) => {
    await serveExplorer(page);
    await mockList(page);
    await mockFinalizing(page);
    const calls = await mockBase(page);
    await gotoMounted(page, '/explorer/proof/finalizing');
    await expect(page.getByRole('heading', { level: 1, name: 'Finalizing' })).toBeVisible();
    await expect(headline(page)).toHaveText('1');
    await expect(proofPill(page)).toHaveText('Read from Base');
    await expect(proofPill(page)).toHaveClass(/xp-pill-ok/);
    const card = page.locator('.xp-proofcard');
    await expect(card).toContainText('Final52,430,000');
    await expect(card).toContainText('Safe52,431,107');
    await expect(card).toContainText('Latest52,431,207');
    await expect(page.locator('.xp-numcard')).toContainText('Blocks not yet final 1,207');
    expect(calls.map((c) => c.params[0])).toEqual(
      expect.arrayContaining(['latest', 'safe', 'finalized']),
    );
    await expect(page.getByRole('row').filter({ hasText: 'Harbor' })).toContainText('6 min');
  });

  test('heads out of order are a failed check, never shown as read', async ({ page }) => {
    await serveExplorer(page);
    await mockList(page);
    await mockFinalizing(page);
    await mockBase(page, { heads: { latest: B, safe: B - 100, finalized: B + 5 } });
    await gotoMounted(page, '/explorer/proof/finalizing');
    await expect(headline(page)).toHaveText('1');
    // Base answered, inconsistently: a failed check (red), not silence.
    await expect(proofPill(page)).toHaveText('Base answered heads out of order');
    await expect(proofPill(page)).toHaveClass(/xp-pill-bad/);
    await expect(page.locator('.xp-proofcard')).toContainText('Final–');
  });

  test('Base does not answer: "Base did not answer"', async ({ page }) => {
    await serveExplorer(page);
    await mockList(page);
    await mockFinalizing(page);
    await mockBase(page, { down: true });
    await gotoMounted(page, '/explorer/proof/finalizing');
    await expect(headline(page)).toHaveText('1');
    await expect(proofPill(page)).toHaveText('Base did not answer');
    await expect(proofPill(page)).toHaveClass(/xp-pill-muted/);
  });

  test("deployed: Central City's heads and waiting list, and this browser does not read Base", async ({
    page,
  }) => {
    await serveExplorer(page);
    await mockList(page);
    await mockFinalizing(page, {
      heads: nodeHeads(),
      waiting: { rows: [OLD_WAITING], nextBefore: null, asOf: NOW },
    });
    const calls = await mockBase(page);
    await gotoMounted(page, '/explorer/proof/finalizing');
    await expect(proofPill(page)).toHaveText("Central City's Base read");
    await expect(proofPill(page)).toHaveClass(/xp-pill-ok/);
    const card = page.locator('.xp-proofcard');
    await expect(card).toContainText('Final52,430,000');
    await expect(card).toContainText('Latest52,431,207');
    await expect(card).toContainText("Central City's Base node (node observations)");
    await expect(page.locator('.xp-numcard')).toContainText('Blocks not yet final 1,207');
    // The waiting list's row, not the newest list rows; no "Show older" at the end of the scan.
    await expect(page.getByRole('row').filter({ hasText: 'Lantern' })).toContainText('6 min');
    await expect(page.getByRole('row').filter({ hasText: 'Harbor' })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Show older waiting registrations' }),
    ).toHaveCount(0);
    expect(calls).toHaveLength(0);
  });

  test('a stale heads answer says "not refreshed", never plain read', async ({ page }) => {
    await serveExplorer(page);
    await mockList(page);
    await mockFinalizing(page, { heads: nodeHeads({ stale: true }) });
    await mockBase(page);
    await gotoMounted(page, '/explorer/proof/finalizing');
    await expect(proofPill(page)).toHaveText("Central City's Base read, not refreshed");
    await expect(proofPill(page)).toHaveClass(/xp-pill-muted/);
  });

  test('503s are said as such: no Base read and no list rows stand in for them', async ({
    page,
  }) => {
    await serveExplorer(page);
    await mockList(page);
    await mockFinalizing(page, { heads: 503, waiting: 503 });
    const calls = await mockBase(page);
    await gotoMounted(page, '/explorer/proof/finalizing');
    await expect(proofPill(page)).toHaveText("Central City's Base read is not available right now");
    await expect(page.locator('.xp-proofcard')).toContainText('Final–');
    await expect(page.locator('.xp-empty')).toHaveText(
      'The waiting list is not available right now. Retrying every 20 s.',
    );
    await expect(page.getByRole('row').filter({ hasText: 'Harbor' })).toHaveCount(0);
    expect(calls).toHaveLength(0);
  });

  test('an empty page with a cursor offers older ones, and the next page is read with before=', async ({
    page,
  }) => {
    await serveExplorer(page);
    await mockList(page);
    const seen = await mockFinalizing(page, {
      heads: nodeHeads(),
      waiting: (url: URL) =>
        url.searchParams.get('before') === CURSOR
          ? { rows: [OLD_WAITING], nextBefore: null, asOf: NOW }
          : { rows: [], nextBefore: CURSOR, asOf: NOW },
    });
    await mockBase(page);
    await gotoMounted(page, '/explorer/proof/finalizing');
    await expect(page.locator('.xp-empty')).toHaveText(
      'None of these is public and waiting. Older waiting registrations may follow.',
    );
    await page.getByRole('button', { name: 'Show older waiting registrations' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Lantern' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Show older waiting registrations' }),
    ).toHaveCount(0);
    expect(seen.waiting.some((url) => url.searchParams.get('before') === CURSOR)).toBe(true);
  });

  test('an older page that fails keeps the rows shown and offers it again; a stale one says so', async ({
    page,
  }) => {
    await serveExplorer(page);
    await mockList(page);
    let olderAnswers = 0;
    await mockFinalizing(page, {
      heads: nodeHeads(),
      waiting: (url: URL) => {
        if (url.searchParams.get('before') !== CURSOR)
          return { rows: [OLD_WAITING], nextBefore: CURSOR, asOf: NOW };
        olderAnswers += 1;
        // The first try at the older page fails; the retry answers, from a stale cache.
        return olderAnswers === 1
          ? 503
          : {
              rows: [{ ...OLD_WAITING, baseId: '1130380', name: 'Quarry', short: 'Qr8m2Z' }],
              nextBefore: null,
              asOf: NOW,
              stale: true,
            };
      },
    });
    await mockBase(page);
    await gotoMounted(page, '/explorer/proof/finalizing');
    await expect(page.getByRole('row').filter({ hasText: 'Lantern' })).toBeVisible();
    await page.getByRole('button', { name: 'Show older waiting registrations' }).click();
    const panel = page.getByRole('region', { name: 'Waiting to be final' });
    await expect(panel.getByRole('status')).toHaveText('Older waiting registrations did not load.');
    await expect(page.getByRole('row').filter({ hasText: 'Lantern' })).toBeVisible();
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Quarry' })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'Lantern' })).toBeVisible();
    await expect(panel).toContainText('not refreshed, showing the last answer');
  });

  test('deployed but failing after the 404 cooldown: "not available", the list rows stop standing in', async ({
    page,
  }) => {
    await page.clock.install();
    await serveExplorer(page);
    await mockList(page);
    let deployed: 'no' | 'failing' | 'yes' = 'no';
    await mockFinalizing(page, {
      waiting: () =>
        deployed === 'no'
          ? 404
          : deployed === 'failing'
            ? 503
            : { rows: [OLD_WAITING], nextBefore: null, asOf: NOW },
    });
    await mockBase(page);
    await gotoMounted(page, '/explorer/proof/finalizing');
    // Not deployed: the waiting rows among the newest list rows stand in.
    await expect(page.getByRole('row').filter({ hasText: 'Harbor' })).toBeVisible();
    deployed = 'failing';
    // Past the 10-minute 404 cooldown, the next poll asks again and gets a 503.
    await page.clock.fastForward('10:01');
    await page.clock.fastForward(20_000);
    await expect(page.locator('.xp-empty')).toHaveText(
      'The waiting list is not available right now. Retrying every 20 s.',
    );
    await expect(page.getByRole('row').filter({ hasText: 'Harbor' })).toHaveCount(0);
    deployed = 'yes';
    await page.clock.fastForward(20_000);
    await expect(page.getByRole('row').filter({ hasText: 'Lantern' })).toBeVisible();
  });

  test('older pages are a dated snapshot that is not polled; "Back to live" drops them and reads again', async ({
    page,
  }) => {
    await page.clock.install();
    await serveExplorer(page);
    await mockList(page);
    const seen = await mockFinalizing(page, {
      heads: nodeHeads(),
      waiting: (url: URL) =>
        url.searchParams.get('before') === CURSOR
          ? {
              rows: [{ ...OLD_WAITING, baseId: '1130380', name: 'Quarry', short: 'Qr8m2Z' }],
              nextBefore: null,
              asOf: NOW,
            }
          : { rows: [OLD_WAITING], nextBefore: CURSOR, asOf: NOW },
    });
    await mockBase(page);
    await gotoMounted(page, '/explorer/proof/finalizing');
    const firstPages = () => seen.waiting.filter((url) => !url.searchParams.has('before')).length;
    await page.getByRole('button', { name: 'Show older waiting registrations' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Quarry' })).toBeVisible();
    const panel = page.getByRole('region', { name: 'Waiting to be final' });
    await expect(panel).toContainText(
      `a snapshot as of ${new Date(NOW).toISOString().slice(11, 19)} UTC, not refreshed while older pages are open`,
    );
    // An older registration may finalize meanwhile: the snapshot is not refreshed underneath it.
    const asked = firstPages();
    await page.clock.fastForward(60_000);
    expect(firstPages()).toBe(asked);
    await page.getByRole('button', { name: 'Back to live' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Quarry' })).toHaveCount(0);
    await expect(page.getByRole('row').filter({ hasText: 'Lantern' })).toBeVisible();
    await expect.poll(firstPages).toBeGreaterThan(asked);
    await expect(panel).not.toContainText('a snapshot as of');
  });
});

test.describe('/explorer/proof/finalizing: late older pages', () => {
  const QUARRY = { ...OLD_WAITING, baseId: '1130380', name: 'Quarry', short: 'Qr8m2Z' };
  const STONE = { ...OLD_WAITING, baseId: '1130370', name: 'Stone', short: 'St5n1W' };
  const CURSOR2 = `1130375~${'b'.repeat(32)}`;
  /** The waiting list, with the page for `held` answered only once the gate opens. */
  async function heldWaiting(page: Page, held: string, open: Promise<void>) {
    const firstPages: URL[] = [];
    await page.route(
      (url) => local(url) && url.pathname === '/api/public/base/finalizing',
      async (route) => {
        const url = new URL(route.request().url());
        const before = url.searchParams.get('before');
        if (before === held) await open;
        if (before === CURSOR)
          return reply(route, { rows: [QUARRY], nextBefore: CURSOR2, asOf: NOW });
        if (before === CURSOR2) return reply(route, { rows: [STONE], nextBefore: null, asOf: NOW });
        firstPages.push(url);
        return reply(route, { rows: [OLD_WAITING], nextBefore: CURSOR, asOf: NOW });
      },
    );
    return firstPages;
  }

  test('an older page answered after a new first page is dropped whole; polling goes on', async ({
    page,
  }) => {
    await page.clock.install();
    await serveExplorer(page);
    await mockList(page);
    await mockFinalizing(page, { heads: nodeHeads() });
    const hold = gate();
    const firstPages = await heldWaiting(page, CURSOR, hold.promise);
    await mockBase(page);
    await gotoMounted(page, '/explorer/proof/finalizing');
    await expect(page.getByRole('row').filter({ hasText: 'Lantern' })).toBeVisible();
    await page.getByRole('button', { name: 'Show older waiting registrations' }).click();
    await expect(page.getByRole('button', { name: 'Loading…' })).toBeVisible();
    // A poll replaces the first page while the older page is still out.
    const asked = firstPages.length;
    await page.clock.fastForward(20_000);
    await expect.poll(() => firstPages.length).toBeGreaterThan(asked);
    // The new first page ends that pagination: the button is offered again, not stuck loading.
    await expect(
      page.getByRole('button', { name: 'Show older waiting registrations' }),
    ).toBeVisible();
    hold.open();
    const panel = page.getByRole('region', { name: 'Waiting to be final' });
    await expect(panel).not.toContainText('a snapshot as of');
    await expect(page.getByRole('row').filter({ hasText: 'Quarry' })).toHaveCount(0);
    await expect(panel.getByRole('status')).toHaveCount(0);
    // Not frozen: the first page is still polled.
    const later = firstPages.length;
    await page.clock.fastForward(20_000);
    await expect.poll(() => firstPages.length).toBeGreaterThan(later);
  });

  test('"Back to live" while an older page is out: its late answer never reopens the snapshot', async ({
    page,
  }) => {
    await page.clock.install();
    await serveExplorer(page);
    await mockList(page);
    await mockFinalizing(page, { heads: nodeHeads() });
    const hold = gate();
    await heldWaiting(page, CURSOR2, hold.promise);
    await mockBase(page);
    await gotoMounted(page, '/explorer/proof/finalizing');
    await page.getByRole('button', { name: 'Show older waiting registrations' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Quarry' })).toBeVisible();
    await page.getByRole('button', { name: 'Show older waiting registrations' }).click();
    await expect(page.getByRole('button', { name: 'Loading…' })).toBeVisible();
    await page.getByRole('button', { name: 'Back to live' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Quarry' })).toHaveCount(0);
    hold.open();
    const panel = page.getByRole('region', { name: 'Waiting to be final' });
    await expect(page.getByRole('row').filter({ hasText: 'Lantern' })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'Stone' })).toHaveCount(0);
    await expect(panel).not.toContainText('a snapshot as of');
    await expect(page.getByRole('button', { name: 'Back to live' })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Show older waiting registrations' }),
    ).toBeVisible();
  });
});

test.describe('/explorer/proof/calls', () => {
  test('the number, and every sampled receipt matches', async ({ page }) => {
    await serveExplorer(page);
    await mockCalls(page);
    await mockBase(page, {
      receipts: {
        [CALL_A.tx_hash]: paymentReceipt(CALL_A),
        [CALL_B.tx_hash]: paymentReceipt(CALL_B),
      },
    });
    await gotoMounted(page, '/explorer/proof/calls');
    await expect(page.getByRole('heading', { level: 1, name: 'Paid service calls' })).toBeVisible();
    await expect(headline(page)).toHaveText('48,213');
    await expect(proofPill(page)).toHaveText('2 of 2 receipts match');
    await expect(proofPill(page)).toHaveClass(/xp-pill-ok/);
  });

  test('a failed transaction: "1 of 2 not confirmed"', async ({ page }) => {
    await serveExplorer(page);
    await mockCalls(page);
    await mockBase(page, {
      receipts: {
        [CALL_A.tx_hash]: paymentReceipt(CALL_A),
        [CALL_B.tx_hash]: paymentReceipt(CALL_B, '0x0'),
      },
    });
    await gotoMounted(page, '/explorer/proof/calls');
    await expect(headline(page)).toHaveText('48,213');
    await expect(proofPill(page)).toHaveText('1 of 2 not confirmed');
    await expect(proofPill(page)).toHaveClass(/xp-pill-bad/);
  });

  test('no receipt from Base: "no answer"', async ({ page }) => {
    await serveExplorer(page);
    await mockCalls(page);
    await mockBase(page, {
      receipts: { [CALL_A.tx_hash]: paymentReceipt(CALL_A), [CALL_B.tx_hash]: null },
    });
    await gotoMounted(page, '/explorer/proof/calls');
    await expect(headline(page)).toHaveText('48,213');
    await expect(proofPill(page)).toHaveText('1 of 2 checked, no answer for 1');
    await expect(proofPill(page)).toHaveClass(/xp-pill-muted/);
  });
});

test.describe('/explorer/proof/ratings', () => {
  test('the number, and the sampled score recomputed on Base', async ({ page }) => {
    await serveExplorer(page, { asCentralCity: true });
    await mockList(page);
    await mockPassport(page, { [PINAKO.baseId]: passport(PINAKO) });
    await mockRegistrationFiles(page);
    await mockBase(page);
    await gotoMounted(page, '/explorer/proof/ratings');
    await expect(page.getByRole('heading', { level: 1, name: 'Rated agents' })).toBeVisible();
    await expect(headline(page)).toHaveText('412');
    await expect(proofPill(page)).toHaveText('1 of 1 scores recomputed on Base');
    await expect(proofPill(page)).toHaveClass(/xp-pill-ok/);
  });

  test('a score Base does not give: "1 of 1 not confirmed"', async ({ page }) => {
    await serveExplorer(page, { asCentralCity: true });
    await mockList(page);
    await mockPassport(page, { [PINAKO.baseId]: passport(PINAKO) });
    await mockRegistrationFiles(page);
    await mockBase(page, { stars: [40n, 40n] });
    await gotoMounted(page, '/explorer/proof/ratings');
    await expect(headline(page)).toHaveText('412');
    await expect(proofPill(page)).toHaveText('1 of 1 not confirmed');
    await expect(proofPill(page)).toHaveClass(/xp-pill-bad/);
  });

  test('Base does not answer: the score is not confirmed, and not a fail', async ({ page }) => {
    await serveExplorer(page);
    await mockList(page);
    await mockPassport(page, { [PINAKO.baseId]: passport(PINAKO) });
    await mockBase(page, { down: true });
    await gotoMounted(page, '/explorer/proof/ratings');
    await expect(headline(page)).toHaveText('412');
    await expect(proofPill(page)).toHaveText('0 of 1 scores recomputed, no answer for 1');
    await expect(proofPill(page)).toHaveClass(/xp-pill-muted/);
  });
});

/* ------------------------------------------------------------------------------------------ */
/* /explorer/agents/:baseId                                                                   */
/* ------------------------------------------------------------------------------------------ */

test.describe('/explorer/agents/:baseId', () => {
  test('no passport and no row: not found', async ({ page }) => {
    await serveExplorer(page);
    await mockList(page, () => list([]));
    await mockPassport(page, {});
    await mockCalls(page);
    await mockBase(page, { down: true });
    await gotoMounted(page, '/explorer/agents/424242');
    await expect(page.getByText('No Central City agent has Base ID 424242.')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('424242');
    await expect(page.getByRole('button', { name: 'Verify on Base' })).toHaveCount(0);
  });

  test('a passport that arrives after Verify drops the answer shown for the row', async ({
    page,
  }) => {
    const held = gate();
    await serveExplorer(page);
    await mockList(page, (url) =>
      url.searchParams.get('q') === PINAKO.baseId ? list([PINAKO]) : list(),
    );
    await mockPassport(page, { [PINAKO.baseId]: passport(PINAKO) }, held.promise);
    await mockCalls(page, () => callsPage([]));
    await mockBase(page, { down: true });
    await gotoMounted(page, `/explorer/agents/${PINAKO.baseId}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Pinako' })).toBeVisible();
    // Still reading the passport.
    await expect(page.getByText('Reading the ratings from Base.')).toBeVisible();
    const button = page.getByRole('button', { name: 'Verify on Base' });
    await button.click();
    const panel = page.getByRole('region', { name: 'Verify Base ID 99268' });
    await expect(panel).toContainText("Couldn't reach Base from your browser");
    await expect(page.getByRole('button', { name: 'Hide the check' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    // The passport replaces the list row: the answer for the row is no longer shown.
    held.open();
    await expect(kpi(page, 'Rating')).toContainText('4.5 ★');
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Verify on Base' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  test('a Verify still in flight when the passport arrives never shows its answer', async ({
    page,
  }) => {
    const passportGate = gate();
    // Verify's Base reads (their own chunk, src/verify/onBaseVerify.ts) answer only when the test
    // releases them, and say when they have answered.
    await page.route(/\/assets\/onBaseVerify-[\w-]+\.js$/, (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: `export async function verify() {
          await new Promise((resolve) => { window.__releaseVerify = resolve; });
          setTimeout(() => { window.__verifyAnswered = true; }, 0);
          return { kind: 'unreachable' };
        }`,
      }),
    );
    await serveExplorer(page);
    await mockList(page, () => list([PINAKO]));
    await mockPassport(page, { [PINAKO.baseId]: passport(PINAKO) }, passportGate.promise);
    await mockCalls(page, () => callsPage([]));
    await mockBase(page, { down: true });
    await gotoMounted(page, `/explorer/agents/${PINAKO.baseId}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Pinako' })).toBeVisible();
    await page.getByRole('button', { name: 'Verify on Base' }).click();
    const panel = page.getByRole('region', { name: 'Verify Base ID 99268' });
    await expect(panel).toContainText('Reading from Base in your browser');
    await expect
      .poll(() =>
        page.evaluate(() => typeof (window as { __releaseVerify?: unknown }).__releaseVerify),
      )
      .toBe('function');
    passportGate.open();
    await expect(kpi(page, 'Rating')).toContainText('4.5 ★');
    await expect(panel).toHaveCount(0);
    // The old Verify answers now: it is dropped, nothing reappears.
    await page.evaluate(() =>
      (window as unknown as { __releaseVerify: () => void }).__releaseVerify(),
    );
    await expect
      .poll(() => page.evaluate(() => (window as { __verifyAnswered?: boolean }).__verifyAnswered))
      .toBe(true);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))),
    );
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Verify on Base' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  test('the calls search answering 503 says the paid calls did not load', async ({ page }) => {
    await page.clock.install();
    await serveExplorer(page);
    await mockList(page, () => list([PINAKO]));
    // Agent wallet and owner the same, so the calls are read for one wallet only.
    await mockPassport(page, { [PINAKO.baseId]: passport(PINAKO, { agentWallet: PINAKO.owner }) });
    const seen = await mockCalls(page, 503);
    await mockBase(page, { down: true });
    await gotoMounted(page, `/explorer/agents/${PINAKO.baseId}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Pinako' })).toBeVisible();
    // Each page is tried three times, 3 s and then 6 s apart.
    await expect.poll(() => seen.length).toBe(1);
    await page.clock.runFor(3_000);
    await expect.poll(() => seen.length).toBe(2);
    await page.clock.runFor(6_000);
    await expect.poll(() => seen.length).toBe(3);
    expect(seen[0]!.searchParams.get('q')).toBe(PINAKO.owner.toLowerCase());
    await expect(page.getByText('Paid calls did not load. Try again in a moment.')).toBeVisible();
    await expect(page.getByText('Paid calls did not load.', { exact: true })).toBeVisible();
    await expect(
      page.getByText('Paid calls did not load, so services sold are not known right now.'),
    ).toBeVisible();
    await expect(kpi(page, 'Earned')).toContainText('paid calls did not load');
    await expect(kpi(page, 'Paid calls')).toContainText('–');
  });
});

/* ------------------------------------------------------------------------------------------ */
/* 390 px: no horizontal page scroll                                                          */
/* ------------------------------------------------------------------------------------------ */

test.describe('390 px wide', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  for (const theme of ['light', 'dark'] as const)
    for (const path of ['/explorer/proof/base'])
      test(`${path} has no horizontal scroll (${theme})`, async ({ page }) => {
        // Dark as asked (cc-theme); light set explicitly too, so the device setting never decides.
        await page.addInitScript((value) => localStorage.setItem('cc-theme', value), theme);
        await serveExplorer(page);
        await mockList(page);
        await mockCalls(page);
        await mockRegistrationFiles(page);
        await mockBase(page);
        await gotoMounted(page, path);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        // The data has arrived: the widest content is on screen.
        await expect(page.getByText('Pinako').first()).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
      });
});

/** The X3 reads (#635, #636, #637): a status (404 absent, 503 unavailable) or a body. */
async function mockX3(
  page: Page,
  answers: { ratings?: unknown; metrics?: unknown; history?: unknown },
) {
  const at = (path: string, answer: unknown) =>
    page.route(
      (url) => local(url) && url.pathname === path,
      (route) => reply(route, answer ?? 404),
    );
  await at('/api/public/base/rating-events', answers.ratings);
  await at('/api/public/base/agent-metrics', answers.metrics);
  await at('/api/public/base/history', answers.history);
}

// The owner, 25 Oct: the v2 home is retired (/explorer is the Agent Explorer again); its tests are kept, skipped.
test.skip('a feed whose request stalls recovers after 30 s instead of staying "not refreshed"', async ({
  page,
}) => {
  await serveExplorer(page);
  await mockCalls(page);
  await mockBase(page, { down: true });
  let reads = 0;
  await page.route(
    (url) => local(url) && url.pathname === '/api/public/base/agents',
    async (route) => {
      reads += 1;
      // The first request stalls forever (a laptop that slept, a dropped socket).
      if (reads === 1) return new Promise(() => {});
      return route.fulfill({ json: list() });
    },
  );
  await page.clock.install({ time: NOW });
  await gotoMounted(page, '/explorer');
  const agents = page.getByRole('region', { name: 'Agents on Base' });
  await expect(agents.locator('.xp-live')).toContainText('Loading');
  await page.clock.runFor(31_000);
  await page.clock.runFor(15_000);
  await expect.poll(() => reads).toBeGreaterThan(1);
  await expect(agents.getByRole('row').filter({ hasText: LUMEN.baseId })).toBeVisible();
  await expect(agents.locator('.xp-live')).toHaveText('Live');
});

for (const late of ['ok', 'error'] as const) {
  test.skip(`a stalled read (${late} if it ever answers) times out and the newer rows stay, never marked failed`, async ({
    page,
  }) => {
    await serveExplorer(page);
    await mockCalls(page);
    await mockBase(page, { down: true });
    let reads = 0;
    let releaseA: () => void = () => {};
    const heldA = new Promise<void>((resolve) => (releaseA = resolve));
    await page.route(
      (url) => local(url) && url.pathname === '/api/public/base/agents',
      async (route) => {
        reads += 1;
        if (reads === 1) {
          // Read A stalls, then settles late: old rows, or an error.
          await heldA;
          return late === 'ok'
            ? route.fulfill({ json: list([PINAKO]) })
            : route.fulfill({ status: 503, json: { error: 'x' } });
        }
        return route.fulfill({ json: list([LUMEN]) });
      },
    );
    await page.clock.install({ time: NOW });
    await gotoMounted(page, '/explorer');
    await page.clock.runFor(46_000);
    const agents = page.getByRole('region', { name: 'Agents on Base' });
    const first = agents.locator('tbody tr').first();
    await expect(first).toContainText(LUMEN.baseId);
    releaseA();
    await page.clock.runFor(1_000);
    await expect.poll(() => reads).toBeGreaterThan(1);
    await expect(first).toContainText(LUMEN.baseId);
    await expect(agents.locator('.xp-live')).toHaveText('Live');
  });
}

// The owner, 25 Oct: the v2 home is retired (/explorer is the Agent Explorer again); its tests are kept, skipped.
test.describe.skip('/explorer X3 pieces', () => {
  const H = 3_600_000;
  const hourNow = Math.floor(NOW / H) * H;

  test('before the endpoints are deployed (404) nothing of them shows', async ({ page }) => {
    await serveExplorer(page);
    await mockList(page);
    await mockCalls(page);
    await mockBase(page, { down: true });
    await mockX3(page, {});
    await gotoMounted(page, '/explorer');
    await expect(page.getByRole('region', { name: 'Counts' }).locator('.xp-stat')).toHaveCount(5);
    await expect(page.getByRole('tab', { name: 'Ratings' })).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: 'Services' })).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: 'Paid calls' })).toHaveCount(0);
    await expect(page.locator('.xp-bars')).toHaveCount(0);
  });

  test('deployed: the Services and Paid calls columns, and no bars on the counters', async ({
    page,
  }) => {
    await serveExplorer(page);
    await mockList(page);
    await mockCalls(page);
    await mockBase(page, { down: true });
    await mockX3(page, {
      ratings: {
        rows: [
          {
            eventId: 'e1',
            block: '52431200',
            transactionHash: `0x${'cd'.repeat(32)}`,
            recordedAt: new Date(NOW - 60_000).toISOString(),
            raterBaseId: PINAKO.baseId,
            ratedBaseId: LUMEN.baseId,
            raterName: 'Pinako',
            ratedName: '',
            stars: 4,
          },
        ],
        nextBefore: null,
        asOf: NOW,
      },
      metrics: {
        rows: [
          {
            baseId: LUMEN.baseId,
            offeredServices: {
              count: 11,
              exact: true,
              priceRangeRaw: { min: '50000', max: '20000000', asset: 'USDC', decimals: 6 },
            },
            paidCallsSold: { count: 10001, exact: false, window: 'all_time_recorded' },
          },
          {
            baseId: PINAKO.baseId,
            offeredServices: null,
            paidCallsSold: { count: 0, exact: true, window: 'all_time_recorded' },
          },
        ],
        asOf: NOW,
      },
      history: {
        kind: 'observed_counter_snapshots',
        bucketMs: H,
        asOf: NOW,
        series: ['agents', 'base', 'finalizing', 'calls', 'ratings'].map((metric) => ({
          metric,
          observedHours: 18,
          collectionStart: hourNow - 18 * H,
          points: Array.from({ length: 24 }, (_, i) => {
            const hour = hourNow - (23 - i) * H;
            // Hour 12 has no reading: a gap that must stay a gap.
            const value = i >= 6 && i !== 12 ? 100 + i * 10 : null;
            return { hour, value, observedAt: value === null ? null : hour + 5 };
          }),
        })),
      },
    });
    await gotoMounted(page, '/explorer');
    // The owner (25 Oct): the counters show no bars.
    await expect(page.locator('.xp-bars')).toHaveCount(0);
    // Columns: offered services and paid calls sold; unknown is "–", a lower bound keeps its +.
    await expect(page.getByRole('columnheader', { name: 'Services' })).toBeVisible();
    const lumen = page.getByRole('row').filter({ hasText: LUMEN.baseId });
    await expect(lumen).toContainText('11');
    await expect(lumen).toContainText('10,001+');
    const pinako = page.getByRole('row').filter({ hasText: PINAKO.baseId }).first();
    await expect(pinako.locator('td.xp-num').first()).toHaveText('–');
  });

  test('metrics that fail are read again on the next refresh', async ({ page }) => {
    await serveExplorer(page);
    await mockList(page);
    await mockCalls(page);
    await mockBase(page, { down: true });
    let metricsCalls = 0;
    await page.route(
      (url) => local(url) && url.pathname === '/api/public/base/agent-metrics',
      (route) => {
        metricsCalls += 1;
        return route.fulfill({ status: 503, json: { error: 'x' } });
      },
    );
    await page.route(
      (url) => local(url) && url.pathname === '/api/public/base/history',
      (route) => route.fulfill({ status: 404, json: { error: 'x' } }),
    );
    await page.clock.install({ time: NOW });
    await gotoMounted(page, '/explorer');
    await expect.poll(() => metricsCalls).toBeGreaterThan(0);
    const before = metricsCalls;
    await page.clock.runFor(61_000);
    await expect.poll(() => metricsCalls).toBeGreaterThan(before);
  });

  test('a 200 marked stale is shown as not refreshed on the cells', async ({ page }) => {
    await serveExplorer(page);
    await mockList(page);
    await mockCalls(page);
    await mockBase(page, { down: true });
    await mockX3(page, {
      ratings: { rows: [], nextBefore: null, asOf: NOW, stale: true },
      metrics: {
        rows: [
          {
            baseId: LUMEN.baseId,
            offeredServices: { count: 2, exact: true, priceRangeRaw: null },
            paidCallsSold: { count: 5, exact: true, window: 'all_time_recorded' },
          },
        ],
        asOf: NOW,
        stale: true,
      },
    });
    await gotoMounted(page, '/explorer');
    const lumen = page.getByRole('row').filter({ hasText: LUMEN.baseId });
    await expect(lumen.locator('td.xp-num').first()).toHaveAttribute(
      'title',
      'Not refreshed, showing the last answer',
    );
    await expect(lumen.locator('td.xp-num').nth(1)).toHaveAttribute(
      'title',
      'Not refreshed, showing the last answer',
    );
  });

  test('the contract addresses copy whole, and the logo keeps the site look on hover', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await serveExplorer(page);
    await mockList(page);
    await mockCalls(page);
    await mockBase(page, { down: true });
    await gotoMounted(page, '/explorer');
    await expect(page.locator('.xp-note')).toHaveCount(0);
    const fee = page.locator('.xp-dark-cell').filter({ hasText: 'Fee router 3' });
    await fee.getByRole('button', { name: /^Copy 0x/ }).click();
    await expect(fee.getByRole('button', { name: /^Copy 0x/ })).toContainText('Copied');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toMatch(/^0x[0-9a-fA-F]{40}$/);
    await expect(
      page.locator('.xp-proofbar').getByRole('button', { name: /^Copy 0x/ }),
    ).toHaveCount(3);
    const logo = page.locator('header a[href="/"]').first();
    await logo.hover();
    await expect(logo).toHaveCSS('text-decoration-line', 'none');
  });

  test('deployed but failing (503): "not available", never zero', async ({ page }) => {
    await serveExplorer(page);
    await mockList(page);
    await mockCalls(page);
    await mockBase(page, { down: true });
    await mockX3(page, { ratings: 503, metrics: 503, history: 503 });
    await gotoMounted(page, '/explorer');
    await expect(page.getByRole('columnheader', { name: 'Services' })).toBeVisible();
    const lumen = page.getByRole('row').filter({ hasText: LUMEN.baseId });
    await expect(lumen.locator('td.xp-num').first()).toHaveText('–');
    await expect(lumen.locator('td.xp-num').first()).toHaveAttribute(
      'title',
      'Not available right now',
    );
    await expect(page.locator('.xp-bars')).toHaveCount(0);
  });
});

// The owner, 25 Oct: the v2 home is retired (/explorer is the Agent Explorer again); its tests are kept, skipped.
test.describe.skip('/explorer typed search (#630)', () => {
  const TIE = 'b'.repeat(32);
  const asRow = (row: Row) => ({
    baseId: row.baseId,
    name: row.name,
    owner: row.owner,
    short: row.short,
    status: row.status,
  });
  const search = async (page: Page, text: string) => {
    await page.getByRole('searchbox', { name: 'Search the Explorer' }).fill(text);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
  };
  const setup = async (page: Page, answer: (url: URL) => unknown) => {
    await serveExplorer(page);
    await mockList(page);
    await mockCalls(page);
    await mockBase(page, { down: true });
    const seen: URL[] = [];
    await page.route(
      (url) => local(url) && url.pathname === '/api/public/base/search',
      (route) => {
        const url = new URL(route.request().url());
        seen.push(url);
        // An answer may be a promise, to hold a reply back (out-of-order and Clear cases).
        return Promise.resolve(answer(url)).then((body) => reply(route, body));
      },
    );
    await gotoMounted(page, '/explorer');
    return seen;
  };

  test('a wallet is searched as the agent wallet, and labelled so', async ({ page }) => {
    const seen = await setup(page, () => ({ rows: [asRow(LUMEN)], nextBefore: null, asOf: NOW }));
    await search(page, LUMEN.owner);
    await expect(page.getByText('(agent wallet)')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: LUMEN.baseId })).toBeVisible();
    expect(seen.at(-1)!.searchParams.get('kind')).toBe('address');
  });

  test('a number can be searched as a name instead, and more pages load on request', async ({
    page,
  }) => {
    const seen = await setup(page, (url) =>
      url.searchParams.get('kind') === 'baseId'
        ? { rows: [], nextBefore: null, asOf: NOW }
        : url.searchParams.get('before')
          ? { rows: [asRow(PINAKO)], nextBefore: null, asOf: NOW }
          : { rows: [asRow(LUMEN)], nextBefore: `99000~${TIE}`, asOf: NOW },
    );
    await search(page, '1777');
    await expect(page.getByText('(Base ID)')).toBeVisible();
    await page.getByRole('button', { name: 'Search names instead' }).click();
    await expect(page.getByText('(name)')).toBeVisible();
    expect(seen.at(-1)!.searchParams.get('kind')).toBe('name');
    await expect(page.getByRole('row').filter({ hasText: LUMEN.baseId })).toBeVisible();
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(page.getByRole('row').filter({ hasText: PINAKO.baseId })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: LUMEN.baseId })).toBeVisible();
    expect(seen.at(-1)!.searchParams.get('before')).toBe(`99000~${TIE}`);
    await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
  });

  test('a search the endpoint cannot answer (503) says so, never "nothing found"', async ({
    page,
  }) => {
    await setup(page, () => 503);
    await search(page, 'Harbor');
    await expect(page.getByText('The search for Harbor did not get an answer.')).toBeVisible();
  });
  test('three empty name pages with more behind them offer Load more, never "nothing found"', async ({
    page,
  }) => {
    const seen = await setup(page, (url) => {
      const before = url.searchParams.get('before');
      const n = before ? Number(before.split('~')[0]) : 99_999;
      return { rows: [], nextBefore: `${n - 1000}~${TIE}`, asOf: NOW };
    });
    await search(page, 'Harbor');
    await expect(
      page.getByText('No match in this part yet. Use Load more to keep looking.'),
    ).toBeVisible();
    await expect(page.getByText('Nothing found.')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Load more' })).toBeVisible();
    expect(seen.length).toBe(3);
  });

  test('Load more that answers 503 keeps the rows shown and offers a retry next to them', async ({
    page,
  }) => {
    let failNext = true;
    await setup(page, (url) => {
      if (!url.searchParams.get('before'))
        return { rows: [asRow(LUMEN)], nextBefore: `99000~${TIE}`, asOf: NOW };
      if (failNext) {
        failNext = false;
        return 503;
      }
      return { rows: [asRow(PINAKO)], nextBefore: null, asOf: NOW };
    });
    await search(page, 'Lumen');
    await expect(page.getByRole('row').filter({ hasText: LUMEN.baseId })).toBeVisible();
    await page.getByRole('button', { name: 'Load more' }).click();
    const retry = page.getByRole('button', { name: 'Load more did not get an answer · Try again' });
    await expect(retry).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: LUMEN.baseId })).toBeVisible();
    await expect(page.getByText('The search for Lumen did not get an answer.')).toHaveCount(0);
    await retry.click();
    await expect(page.getByRole('row').filter({ hasText: PINAKO.baseId })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: LUMEN.baseId })).toBeVisible();
  });

  test('an answer marked stale says not refreshed, and keeps saying so after Load more', async ({
    page,
  }) => {
    await setup(page, (url) =>
      url.searchParams.get('before')
        ? { rows: [asRow(PINAKO)], nextBefore: null, asOf: NOW }
        : { rows: [asRow(LUMEN)], nextBefore: `99000~${TIE}`, asOf: NOW, stale: true },
    );
    await search(page, 'Lumen');
    const note = page.getByText('not refreshed, showing the last answer');
    await expect(note).toBeVisible();
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(page.getByRole('row').filter({ hasText: PINAKO.baseId })).toBeVisible();
    await expect(note).toBeVisible();
    await expect(page.getByText(/as of \d\d:\d\d:\d\d UTC/)).toBeVisible();
  });

  test('a slower earlier search never overwrites a newer one, and Clear drops what is in flight', async ({
    page,
  }) => {
    const later = (ms: number, body: unknown) =>
      new Promise((done) => setTimeout(() => done(body), ms));
    await setup(page, (url) =>
      url.searchParams.get('q') === 'Harbor'
        ? later(1500, { rows: [asRow(PINAKO)], nextBefore: null, asOf: NOW })
        : { rows: [asRow(LUMEN)], nextBefore: null, asOf: NOW },
    );
    await search(page, 'Harbor');
    await search(page, 'Lumen');
    await expect(page.getByText('Results for Lumen')).toBeVisible();
    await page.waitForTimeout(2000);
    await expect(page.getByText('Results for Lumen')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: PINAKO.baseId })).toHaveCount(0);

    await search(page, 'Harbor');
    await page.getByRole('button', { name: 'Clear' }).click();
    await page.waitForTimeout(2000);
    await expect(page.getByText('Results for')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeEnabled();
  });

  test('a transaction hash finds paid calls, and can be searched as a registration instead', async ({
    page,
  }) => {
    const hash = `0x${'c'.repeat(64)}`;
    const seen = await setup(page, () => ({ rows: [asRow(LUMEN)], nextBefore: null, asOf: NOW }));
    await search(page, hash);
    await page.getByRole('button', { name: 'Search registrations instead' }).click();
    await expect(page.getByText('(registration transaction)')).toBeVisible();
    expect(seen.at(-1)!.searchParams.get('kind')).toBe('txHash');
    await expect(page.getByRole('row').filter({ hasText: LUMEN.baseId })).toBeVisible();
    await page.getByRole('button', { name: 'Search paid calls instead' }).click();
    await expect(page.getByText('(registration transaction)')).toHaveCount(0);
  });
  test('Try again after a failed forced name search searches names again, not the Base ID', async ({
    page,
  }) => {
    let failName = true;
    const seen = await setup(page, (url) => {
      if (url.searchParams.get('kind') === 'baseId')
        return { rows: [], nextBefore: null, asOf: NOW };
      if (failName) {
        failName = false;
        return 503;
      }
      return { rows: [asRow(LUMEN)], nextBefore: null, asOf: NOW };
    });
    await search(page, '1777');
    await page.getByRole('button', { name: 'Search names instead' }).click();
    await expect(page.getByText('The search for 1777 (name) did not get an answer.')).toBeVisible();
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByText('(name)')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: LUMEN.baseId })).toBeVisible();
    expect(seen.at(-1)!.searchParams.get('kind')).toBe('name');
  });
  test('before the typed search is deployed (404), a registration search says it is not available', async ({
    page,
  }) => {
    const seen = await setup(page, () => 404);
    await search(page, `0x${'c'.repeat(64)}`);
    await page.getByRole('button', { name: 'Search registrations instead' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Registration search is not available yet.' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Search registrations instead' })).toHaveCount(0);
    await expect(page.getByText('Nothing found.')).toHaveCount(0);
    await expect(
      page.getByText(
        'A transaction hash searches paid calls; registration search is not available yet.',
      ),
    ).toBeVisible();
    expect(seen.at(-1)!.searchParams.get('kind')).toBe('txHash');
  });
  test('a six-letter name that is no passport id is searched as a name by itself', async ({
    page,
  }) => {
    const seen = await setup(page, (url) =>
      url.searchParams.get('kind') === 'shortId'
        ? { rows: [], nextBefore: null, asOf: NOW }
        : { rows: [asRow(LUMEN)], nextBefore: null, asOf: NOW },
    );
    await search(page, 'Vemino');
    await expect(page.getByText('(name; no passport id matched)')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: LUMEN.baseId })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Search names instead' })).toHaveCount(0);
    expect(seen.map((u) => u.searchParams.get('kind'))).toEqual(['shortId', 'name']);
  });

  test('a passport id that matches stays a passport id search', async ({ page }) => {
    const seen = await setup(page, () => ({ rows: [asRow(LUMEN)], nextBefore: null, asOf: NOW }));
    await search(page, LUMEN.short);
    await expect(page.getByText('(passport id)')).toBeVisible();
    expect(seen.map((u) => u.searchParams.get('kind'))).toEqual(['shortId']);
  });
});
