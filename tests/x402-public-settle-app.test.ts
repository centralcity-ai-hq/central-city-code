import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { getAddress } from 'viem';
import { createApp, publicSettleScreenFor } from '../server/app.js';
import { FACILITATOR_NETWORK, type ExactPayment } from '../server/protocol/x402/public-facilitator';
import type { OracleReader } from '../server/protocol/screening/sanctions-oracle.js';
import { PROTOCOL_BASE_MAINNET } from '../shared/protocol.js';

/*
 * CCA-755: the production app wires sanctions screening into the public x402 facilitator's SETTLE
 * path (payer and payee, fail closed, nothing settles while CITY_PROTOCOL_SCREENING=0), while
 * VERIFY stays unscreened (accepted risk: it sends nothing). The composition below is the one
 * createApp hands to createPublicSettle; the source checks pin that createApp actually uses it.
 * Fake oracle reader and synthetic addresses only: nothing reaches a network.
 */

const NOW = 1_792_900_000_000;
const PAYER = '0x1111111111111111111111111111111111111111';
const PAYEE = '0x2222222222222222222222222222222222222222';
const payment = (): ExactPayment => ({
  requirements: {
    scheme: 'exact',
    network: FACILITATOR_NETWORK,
    amount: 50_000n,
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    payTo: PAYEE,
    maxTimeoutSeconds: 60,
  },
  authorization: {
    from: PAYER,
    to: PAYEE,
    value: 50_000n,
    validAfter: 0n,
    validBefore: BigInt(NOW / 1000 + 600),
    nonce: `0x${'ab'.repeat(32)}`,
  },
  signature: `0x${'cd'.repeat(65)}`,
});

/** A fake Base read client answering isSanctioned for the listed addresses. */
function fakeOracle(listed: string[] = []) {
  const asked: { oracle: string; address: string }[] = [];
  const reader = {
    readContract: async (input: { address: string; functionName: string; args: unknown[] }) => {
      assert.equal(input.functionName, 'isSanctioned');
      const address = String(input.args[0]);
      asked.push({ oracle: input.address, address });
      return listed.some((entry) => entry.toLowerCase() === address.toLowerCase());
    },
  } as unknown as OracleReader;
  return { reader, asked };
}

async function appDb(t: test.TestContext) {
  const app = await createApp({ dataDir: 'memory://', startWorkers: false });
  t.after(() => app.close());
  return app.city.db;
}

test('CCA-755: the app screens payer and payee through Base mainnet sanctions oracle before a settle', async (t) => {
  const db = await appDb(t);
  const oracle = fakeOracle();
  const lines: string[] = [];
  const screen = publicSettleScreenFor({
    db,
    env: {},
    now: Date.now,
    readClient: async () => oracle.reader,
    log: (line) => lines.push(line),
  });
  assert.equal(await screen(payment()), true);
  // Both parties, at the oracle fixed in code for Base mainnet (no setting can replace it).
  assert.deepEqual(
    oracle.asked.map((entry) => [entry.oracle.toLowerCase(), entry.address.toLowerCase()]).sort(),
    [
      [PROTOCOL_BASE_MAINNET.sanctionsOracle.toLowerCase(), PAYER],
      [PROTOCOL_BASE_MAINNET.sanctionsOracle.toLowerCase(), PAYEE],
    ].sort(),
  );
  // The decision is stored like the payment engine's (the gate's own table).
  const { rows } = await db.query<{ intent_id: string; outcome: string }>(
    'SELECT intent_id, outcome FROM protocol_screening_decisions',
  );
  assert.deepEqual(rows, [
    { intent_id: `x402-settle:${PAYER}:${'0x' + 'ab'.repeat(32)}`, outcome: 'allowed' },
  ]);
  assert.match(lines.join('\n'), /"event":"x402_settle_screening","outcome":"allowed"/);
});

test('CCA-755: a listed payer or payee is refused; the oracle setting cannot override Base mainnet', async (t) => {
  const db = await appDb(t);
  for (const listed of [PAYER, PAYEE]) {
    const oracle = fakeOracle([getAddress(listed)]);
    const screen = publicSettleScreenFor({
      db,
      // A different oracle named in the setting is ignored on Base mainnet.
      env: { CITY_PROTOCOL_SCREENING_ORACLE: '0x4444444444444444444444444444444444444444' },
      now: Date.now,
      readClient: async () => oracle.reader,
      log: () => {},
    });
    assert.equal(await screen(payment()), false, `listed ${listed}`);
    assert.ok(
      oracle.asked.every(
        (entry) =>
          entry.oracle.toLowerCase() === PROTOCOL_BASE_MAINNET.sanctionsOracle.toLowerCase(),
      ),
    );
  }
});

test('CCA-755: fail closed: screening off, no read client, or a failing oracle never settles', async (t) => {
  const db = await appDb(t);
  const off = fakeOracle();
  const switchedOff = publicSettleScreenFor({
    db,
    env: { CITY_PROTOCOL_SCREENING: '0' },
    now: Date.now,
    readClient: async () => off.reader,
    log: () => {},
  });
  assert.equal(await switchedOff(payment()), false);
  assert.equal(off.asked.length, 0, 'switched off: nothing asked, nothing settles');
  const noClient = publicSettleScreenFor({
    db,
    env: {},
    now: Date.now,
    readClient: async () => null,
    log: () => {},
  });
  assert.equal(await noClient(payment()), false);
  const failing = publicSettleScreenFor({
    db,
    env: {},
    now: Date.now,
    readClient: async () =>
      ({
        readContract: async () => {
          throw new Error('synthetic outage');
        },
      }) as unknown as OracleReader,
    log: () => {},
  });
  assert.equal(await failing(payment()), false);
  const notConfigured = publicSettleScreenFor({
    db,
    env: {},
    now: Date.now,
    provider: () => null,
    readClient: async () => null,
    log: () => {},
  });
  assert.equal(await notConfigured(payment()), false);
});

test('CCA-755: createApp hands exactly this screening to the public sender, and only there', () => {
  const source = readFileSync(new URL('../server/app.ts', import.meta.url), 'utf8');
  const create = source.slice(source.indexOf('export async function createApp('));
  // Built once with the app's database, environment, clock, test provider and Base mainnet reader.
  const built = create.slice(create.indexOf('const publicSettleScreen = publicSettleScreenFor({'));
  assert.ok(built.length < create.length, 'createApp builds the public settle screening');
  const args = built.slice(0, built.indexOf('});'));
  assert.match(args, /db,/);
  assert.match(args, /env: process\.env,/);
  assert.match(args, /provider: options\.feedPay\.screeningProvider/);
  assert.match(args, /readClient: async \(\) => \(await baseRuntimes\(8453\)\)\.readClient/);
  // The public sender takes it as its screen, and the settle route only reaches that sender.
  const sender = create.slice(create.indexOf('const sender = createPublicSettle({'));
  const senderArgs = sender.slice(0, sender.indexOf('\n    });'));
  assert.match(senderArgs, /\n\s+screen: publicSettleScreen,/);
  assert.doesNotMatch(senderArgs, /maxWindowSeconds/, 'the 15-minute validity cap stays default');
  // One settle hook reaches that sender; the facilitator routes and the offers' exact lane share it.
  const hook = create.slice(create.indexOf('const publicSettleRoute: PublicSettle | null ='));
  const hookArgs = hook.slice(0, hook.indexOf(': null;'));
  assert.match(hookArgs, /\(await publicSender\(\)\)\.settle\(payment, verify, context\)/);
  const routes = create.slice(create.indexOf('registerPublicFacilitatorRoutes(app, {'));
  const routeArgs = routes.slice(0, routes.indexOf('\n  });'));
  assert.match(routeArgs, /settle: publicSettleRoute,/);
  // Verify stays unscreened (accepted risk): the route gets no screening dependency.
  assert.doesNotMatch(routeArgs, /screen/i);
});
