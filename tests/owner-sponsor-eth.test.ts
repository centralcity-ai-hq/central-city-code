import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { parseEther, parseTransaction, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Database } from '../server/database.js';
import { X402_FACILITATOR_SQL } from '../server/protocol/x402/facilitator-schema.js';
import {
  createSponsorEthSweep,
  FACILITATOR_ADDRESS,
  L1_FEE_ALLOWANCE_WEI,
  MIN_SEND_WEI,
  OWNER_SPONSOR_ETH_SENDS_SQL,
  registerSponsorEthRoutes,
  RESERVE_WEI,
  SPONSOR_ADDRESS,
  SPONSOR_ETH_PATH,
  sponsorEthAmount,
  TRANSFER_GAS,
  type SponsorEthChain,
} from '../server/feed/pay/sponsor-eth-sweep.js';

// The owner's one click (server/feed/pay/sponsor-eth-sweep.ts): the sponsor's surplus ETH to the
// facilitator, proven sponsor operators only, fixed chain and destination, one send at a time.

// A throwaway key; the tests check its address in place of the real sponsor's.
const KEY = `0x${'11'.repeat(32)}` as Hex;
const signer = privateKeyToAccount(KEY);
const GWEI = 1_000_000_000n;

function fakeChain(over: Partial<SponsorEthChain> & { balance?: bigint; pending?: number } = {}) {
  const state = {
    balance: over.balance ?? parseEther('0.2'),
    pending: over.pending ?? 7,
    latest: 7,
    sent: [] as Hex[],
    receipt: null as null | 'success' | 'reverted',
    broadcastFails: false,
    nodeChainId: 8453,
  };
  const chain: SponsorEthChain = {
    chainId: 8453,
    sponsor: SPONSOR_ADDRESS,
    facilitator: FACILITATOR_ADDRESS,
    client: {
      getChainId: async () => state.nodeChainId,
      getBalance: async () => state.balance,
      estimateFeesPerGas: async () => ({ maxFeePerGas: GWEI / 100n, maxPriorityFeePerGas: 1000n }),
      getTransactionCount: async ({ blockTag }) =>
        blockTag === 'pending' ? state.pending : state.latest,
      sendRawTransaction: async ({ serializedTransaction }) => {
        if (state.broadcastFails) throw new Error('rpc down');
        state.sent.push(serializedTransaction);
        state.pending += 1;
        return '0x' as Hex;
      },
      getTransactionReceipt: async () => {
        if (!state.receipt) throw new Error('not found');
        return { status: state.receipt };
      },
    },
    withTransferSigner: (use) => use((tx) => signer.signTransaction({ type: 'eip1559', ...tx })),
    ...over,
  };
  return { chain, state };
}

async function setup(
  t: { after: (fn: () => Promise<unknown>) => void },
  chain: SponsorEthChain | null,
  opts: { operators?: string[] } = {},
) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(X402_FACILITATOR_SQL);
  await pg.exec(OWNER_SPONSOR_ETH_SENDS_SQL);
  const db = {
    query: (sql: string, params?: unknown[]) => pg.query(sql, params) as never,
    transaction: (action: (tx: never) => Promise<unknown>) =>
      pg.transaction((tx) => action(tx as never)),
  } as unknown as Database;
  const lines: string[] = [];
  const sweep = createSponsorEthSweep({ db, chain: async () => chain, log: (l) => lines.push(l) });
  const app = Fastify();
  const limits = new Map<string, number>();
  registerSponsorEthRoutes(app, {
    sweep,
    // The test's "session": the x-test-account header names the signed-in person.
    person: async (request) => {
      const id = request.headers['x-test-account'];
      return typeof id === 'string' ? { accountId: id } : null;
    },
    operators: () => new Set(opts.operators ?? ['acct-owner']),
    limit: async (key) => {
      const n = (limits.get(key) ?? 0) + 1;
      limits.set(key, n);
      if (n > 1) {
        const error = Object.assign(new Error('Too many requests.'), { statusCode: 429 });
        throw error;
      }
    },
  });
  t.after(() => app.close());
  return { app, pg, lines, limits };
}

const call = (
  app: Awaited<ReturnType<typeof setup>>['app'],
  method: 'GET' | 'POST',
  headers: Record<string, string> = { 'x-city-request': '1', 'x-test-account': 'acct-owner' },
) =>
  app.inject({
    method,
    url: SPONSOR_ETH_PATH,
    headers: { ...headers, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    ...(method === 'POST' ? { payload: '{}' } : {}),
  });

test('sponsor eth: amount is balance minus the 0.03 reserve minus worst-case gas', () => {
  const fees = { maxFeePerGas: 10n * GWEI, maxPriorityFeePerGas: GWEI };
  const out = sponsorEthAmount(parseEther('0.1'), fees);
  assert.equal(out.maxFeePerGas, 20n * GWEI);
  assert.equal(out.gasWei, TRANSFER_GAS * 20n * GWEI + L1_FEE_ALLOWANCE_WEI);
  assert.equal(out.amountWei, parseEther('0.1') - RESERVE_WEI - out.gasWei);
  assert.equal(RESERVE_WEI, parseEther('0.03'));
  assert.equal(MIN_SEND_WEI, parseEther('0.005'));
  // Priority never above the fee cap.
  assert.equal(
    sponsorEthAmount(1n, { maxFeePerGas: 1n, maxPriorityFeePerGas: 9n }).maxPriorityFeePerGas,
    2n,
  );
});

test('sponsor eth: 404 for a non-operator, a signed-out caller or a send without X-City-Request', async (t) => {
  const { chain, state } = fakeChain();
  const { app } = await setup(t, chain);
  for (const method of ['GET', 'POST'] as const) {
    assert.equal(
      (await call(app, method, { 'x-city-request': '1', 'x-test-account': 'acct-other' }))
        .statusCode,
      404,
    );
    assert.equal((await call(app, method, { 'x-city-request': '1' })).statusCode, 404);
    // The read-only summary needs no console header; the send does.
    assert.equal(
      (await call(app, method, { 'x-test-account': 'acct-owner' })).statusCode,
      method === 'GET' ? 200 : 404,
    );
  }
  assert.equal(state.sent.length, 0);
});

test('sponsor eth: GET is a dry summary; POST sends one plain transfer to the fixed facilitator', async (t) => {
  const { chain, state } = fakeChain();
  const { app, pg, lines } = await setup(t, chain);
  const dry = await call(app, 'GET');
  assert.equal(dry.statusCode, 200);
  const summary = dry.json();
  assert.equal(summary.to, FACILITATOR_ADDRESS);
  assert.equal(summary.reserveEth, '0.03');
  assert.equal(summary.canSend, true);
  assert.equal(state.sent.length, 0);

  const res = await call(app, 'POST');
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(state.sent.length, 1);
  const tx = parseTransaction(state.sent[0]!);
  assert.equal(tx.to?.toLowerCase(), FACILITATOR_ADDRESS.toLowerCase());
  assert.equal(tx.chainId, 8453);
  assert.equal(tx.nonce, 7);
  assert.equal(tx.gas, TRANSFER_GAS);
  assert.equal(tx.data, undefined);
  assert.equal(tx.value?.toString(), summary.amountWei);
  assert.equal(body.amountWei, summary.amountWei);
  assert.match(body.basescan, /^https:\/\/basescan\.org\/tx\/0x[0-9a-f]{64}$/);
  // The lane moved past the nonce, as the facilitator would have moved it.
  const lane = await pg.query<{ next_nonce: string }>(
    'SELECT next_nonce::text AS next_nonce FROM x402_facilitator_lanes',
  );
  assert.equal(lane.rows[0]!.next_nonce, '8');
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, new RegExp(body.txHash));
  // No secret anywhere in what was answered or logged.
  const secret = KEY.slice(2);
  for (const text of [dry.body, res.body, ...lines]) assert.ok(!text.includes(secret));
});

test(
  'sponsor eth: the key is opened on its own connection before the lane lock is taken',
  { timeout: 15_000 },
  async (t) => {
    // As the key store does: a read outside the transaction. PGlite has one connection, so under
    // the lane lock this would wait forever: this test then hits its timeout.
    let read: () => Promise<unknown> = async () => undefined;
    const { chain, state } = fakeChain({
      withTransferSigner: async (use) => {
        await read();
        return use((tx) => signer.signTransaction({ type: 'eip1559', ...tx }));
      },
    });
    const { app, pg } = await setup(t, chain);
    read = () => pg.query('SELECT 1');
    const res = await call(app, 'POST');
    assert.equal(res.statusCode, 200);
    assert.equal(state.sent.length, 1);
    const lane = await pg.query<{ next_nonce: string }>(
      'SELECT next_nonce::text AS next_nonce FROM x402_facilitator_lanes',
    );
    assert.equal(lane.rows[0]!.next_nonce, '8');
  },
);

test('sponsor eth: a key that cannot be opened answers sign_failed, nothing sent or stored', async (t) => {
  const { chain, state } = fakeChain({
    withTransferSigner: async () => {
      throw new Error('The sponsor key does not match the sponsor address.');
    },
  });
  const { app, pg } = await setup(t, chain);
  const res = await call(app, 'POST');
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().code, 'sign_failed');
  assert.equal(state.sent.length, 0);
  assert.equal((await pg.query('SELECT 1 FROM owner_sponsor_eth_sends')).rows.length, 0);
  assert.equal((await pg.query('SELECT 1 FROM x402_facilitator_lanes')).rows.length, 0);
});

test('sponsor eth: refused below 0.005 ETH after the reserve', async (t) => {
  const { chain, state } = fakeChain({ balance: parseEther('0.034') });
  const { app } = await setup(t, chain);
  assert.equal((await call(app, 'GET')).json().reason, 'below_minimum');
  const res = await call(app, 'POST');
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, 'below_minimum');
  assert.equal(state.sent.length, 0);
});

test('sponsor eth: wrong chain refused (configured or as the node reports it)', async (t) => {
  const a = fakeChain({ chainId: 84532 });
  const { app } = await setup(t, a.chain);
  assert.equal((await call(app, 'POST')).json().code, 'wrong_chain');
  const b = fakeChain();
  b.state.nodeChainId = 1;
  const second = await setup(t, b.chain);
  const res = await call(second.app, 'POST');
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, 'wrong_chain');
  assert.equal(a.state.sent.length + b.state.sent.length, 0);
});

test('sponsor eth: destination and sponsor are fixed; the request cannot change them', async (t) => {
  const other = fakeChain({ facilitator: '0x000000000000000000000000000000000000dEaD' });
  const { app } = await setup(t, other.chain);
  assert.equal((await call(app, 'POST')).json().code, 'wrong_destination');
  const sponsor = fakeChain({ sponsor: '0x000000000000000000000000000000000000dEaD' });
  const second = await setup(t, sponsor.chain);
  assert.equal((await call(second.app, 'POST')).json().code, 'wrong_sponsor');
  // A body naming another destination is ignored.
  const ok = fakeChain();
  const third = await setup(t, ok.chain);
  const res = await third.app.inject({
    method: 'POST',
    url: SPONSOR_ETH_PATH,
    headers: {
      'x-city-request': '1',
      'x-test-account': 'acct-owner',
      'content-type': 'application/json',
    },
    payload: JSON.stringify({ to: '0x000000000000000000000000000000000000dEaD', amount: '1' }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(
    parseTransaction(ok.state.sent[0]!).to?.toLowerCase(),
    FACILITATOR_ADDRESS.toLowerCase(),
  );
});

test('sponsor eth: a pending send refuses the next until it is mined', async (t) => {
  const { chain, state } = fakeChain();
  const { app, limits } = await setup(t, chain);
  assert.equal((await call(app, 'POST')).statusCode, 200);
  state.latest = state.pending - 1; // still in the mempool
  limits.clear();
  const again = await call(app, 'POST');
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().code, 'pending');
  const dry = (await call(app, 'GET')).json();
  assert.equal(dry.reason, 'pending');
  assert.match(dry.pendingTx, /^0x[0-9a-f]{64}$/);
  // Mined: the next one may go (balance permitting).
  state.receipt = 'success';
  state.latest = state.pending;
  limits.clear();
  assert.equal((await call(app, 'POST')).statusCode, 200);
  assert.equal(state.sent.length, 2);
});

test('sponsor eth: refused while the sponsor has transactions in flight', async (t) => {
  const { chain, state } = fakeChain({ pending: 9 });
  const { app } = await setup(t, chain);
  const res = await call(app, 'POST');
  assert.equal(res.json().code, 'sponsor_busy');
  assert.equal(state.sent.length, 0);
});

test('sponsor eth: refused when the lane already gave out a nonce Base has not seen', async (t) => {
  const { chain, state } = fakeChain();
  const { app, pg } = await setup(t, chain);
  await pg.query(
    `INSERT INTO x402_facilitator_lanes (chain_id, facilitator, next_nonce, updated_at) VALUES (8453, $1, 8, 0)`,
    [SPONSOR_ADDRESS.toLowerCase()],
  );
  assert.equal((await call(app, 'POST')).json().code, 'sponsor_busy');
  assert.equal(state.sent.length, 0);
});

test('sponsor eth: a failed broadcast gives the nonce back and frees the lock', async (t) => {
  const { chain, state } = fakeChain();
  const { app, pg, limits } = await setup(t, chain);
  state.broadcastFails = true;
  const res = await call(app, 'POST');
  assert.equal(res.statusCode, 502);
  const lane = await pg.query<{ next_nonce: string }>(
    'SELECT next_nonce::text AS next_nonce FROM x402_facilitator_lanes',
  );
  assert.equal(lane.rows[0]!.next_nonce, '7');
  state.broadcastFails = false;
  limits.clear();
  assert.equal((await call(app, 'POST')).statusCode, 200);
});

test('sponsor eth: POST is rate limited per account', async (t) => {
  const { chain } = fakeChain();
  const { app } = await setup(t, chain);
  assert.equal((await call(app, 'POST')).statusCode, 200);
  assert.equal((await call(app, 'POST')).statusCode, 429);
});

test('sponsor eth: unconfigured keys answer 503, nothing sent', async (t) => {
  const { app } = await setup(t, null);
  const res = await call(app, 'GET');
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().code, 'not_configured');
});
