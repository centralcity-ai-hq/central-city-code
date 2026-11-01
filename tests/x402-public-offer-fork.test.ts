import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import test, { type TestContext } from 'node:test';
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeDeployData,
  getAddress,
  http,
  keccak256,
  numberToHex,
  parseAbi,
  parseEther,
  parseTransaction,
  recoverTypedDataAddress,
  stringToHex,
  type Abi,
  type Hex,
  type PublicClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { BASE_MAINNET_TERMS, buyOffer } from '../examples/x402-buyer/buy-offer.js';
import { createChainRuntime } from '../server/base/chain/runtime.js';
import { createKeystore, parseKeks } from '../server/base/chain/keystore.js';
import { pgSpenderKeyStore } from '../server/base/chain/stores.js';
import type { Database } from '../server/database.js';
import { feedServiceId } from '../server/feed/bazaar.js';
import type { PublicOfferLane, PublicPayment } from '../server/feed/offers/public-pay.js';
import {
  LEG_FEE,
  LEG_SELLER,
  router3Nonce,
  router3OwnTransfers,
  type Router3Settlement,
} from '../server/feed/pay/router3.js';
import { HOSTED_SOURCE } from '../server/feed/types.js';
import { feeEventsOf } from '../server/protocol/fees/fee-call.js';
import { PUBLIC_SETTLE_MAX_L1_FEE_WEI } from '../server/protocol/x402/public-settle.js';
import {
  BroadcastDeferred,
  encodeSettle,
  GAS_PRICE_ORACLE,
} from '../server/protocol/x402/facilitator.js';
import { BASE_MAINNET } from '../shared/base/chains.js';
import { offerInputSummary, offerOutputSummary } from '../shared/feed-offers.js';
import { PROTOCOL_BASE_MAINNET } from '../shared/protocol.js';
import { startAtLowBaseFee } from './anvil-fees.js';
import { CHAIN_ID, CRON, setup, USDC } from './helpers/feed-pay-app.js';
import { newBuyer, paymentHeader, signedPayment } from './helpers/public-offer-lane.js';

/*
 * The offers' public address on a local Anvil fork of Base MAINNET, with the REAL lane
 * (createChainRuntime(...).publicOfferLane in server/base/chain/runtime.ts), the real facilitator,
 * verifyCall and nonce lane in Postgres (PGlite), the real router 3 and FiatToken v2.2 bytecode and
 * the real route (createApp, server/feed/offers/public-route.ts). Only the engine's fake Base stays,
 * as in tests/feed-offers-public-pay.test.ts, for the offer read and screening that move no money.
 *
 * Run it (Foundry's anvil on PATH; the URL is a Base mainnet RPC with state since router 3's deploy
 * block, read only by the Anvil this test starts on a free loopback port; nothing is sent to it):
 *
 *   CITY_X402_LANE_FORK_RPC_URL=<base-mainnet-rpc> npx tsx --test --test-concurrency=1 --no-wasm-code-gc tests/x402-public-offer-fork.test.ts
 *
 * Without the setting or without anvil the fork test skips and only the dry run below runs.
 *
 * Nothing leaves this machine: the runtime's env is written here (never process.env), and every
 * fetch in this process is refused unless it goes to that Anvil (forkGuard). Before anything is sent
 * the client's URL must be loopback, the chain 8453 and the node must answer as Anvil (assertLocalFork).
 * Throwaway keys; USDC granted through anvil storage; no real funds.
 */

const UPSTREAM = process.env.CITY_X402_LANE_FORK_RPC_URL?.trim();
const anvilMissing = () => spawnSync('anvil', ['--version'], { stdio: 'ignore' }).status !== 0;
const SKIP = !UPSTREAM
  ? 'CITY_X402_LANE_FORK_RPC_URL is not set'
  : anvilMissing()
    ? 'anvil is not on PATH'
    : false;

const ROUTER3 = getAddress(PROTOCOL_BASE_MAINNET.feeRouter3) as Hex;
const TREASURY = getAddress(PROTOCOL_BASE_MAINNET.treasury) as Hex;
const USDC_ADDRESS = getAddress(USDC) as Hex;
const CONFIG = { chainId: CHAIN_ID, router: ROUTER3, treasury: TREASURY, usdc: USDC_ADDRESS };
const OFFER = 'off_aaaaaaaaaaaaaaaa';
const OFFER_URL = `/api/public/x402/${OFFER}`;
const INPUT = { text: 'hello' };
const RESULT = createHash('sha256').update('hello').digest('hex');
const GROSS = 100_000n;
const FEE = 10_000n;
const NET = 90_000n;
/** OP stack L1Block predeploy: basefee at slot 1, blobBaseFee at slot 7. */
const L1_BLOCK = '0x4200000000000000000000000000000000000015' as const;
const L1_SLOTS = [numberToHex(1n, { size: 32 }), numberToHex(7n, { size: 32 })];
/** Answers ERC-1271's magic value for anything: a stranger's wallet that passes any signature. */
const ANY_SIGNATURE_WALLET = '0x631626ba7e60e01b60005260206000f3';

const usdcAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function authorizationState(address, bytes32) view returns (bool)',
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
]);
const routerAbi = parseAbi([
  'function treasury() view returns (address)',
  'function nonceFor(address payer, address payee, uint256 gross, bytes32 ref, uint256 validAfter, uint256 validBefore, uint8 leg) view returns (bytes32)',
]);
const oracleAbi = parseAbi(['function getL1Fee(bytes) view returns (uint256)']);

/** FiatToken v2.2 keeps balances in mapping slot 9, as scripts/protocol/router3-fork-check.ts. */
const usdcBalanceSlot = (who: Hex) =>
  keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [who, 9n]));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The only endpoint this test accepts for a chain client: plain http on this machine. */
function loopbackUrl(value: string): string {
  const url = new URL(value);
  assert.equal(url.protocol, 'http:', 'the fork is reached over loopback http');
  assert.ok(['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname), 'not a loopback host');
  return value;
}

/**
 * Every fetch of this process goes through this while the fork test runs: another host is refused,
 * and every raw transaction is seen (and its chain id checked) before it reaches the fork. `lost`,
 * `beforeNextSettle` and `down` are the test's faults: a process dying before its broadcast, a
 * front-run between simulation and send, Base not answering.
 */
function forkGuard(anvilUrl: string, real: typeof fetch) {
  const origin = new URL(loopbackUrl(anvilUrl)).origin;
  const state = {
    /** Raw settlements (target: router 3) that reached the fork. */
    settles: [] as Hex[],
    /** Raw settlements answered as sent that never reached the fork. */
    lost: [] as Hex[],
    loseNextSettle: false,
    beforeNextSettle: null as (() => Promise<unknown>) | null,
    down: new Set<string>(),
  };
  const guarded = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== origin)
      throw new Error(`fork test: a request to another host was refused (${url.hostname})`);
    if (typeof init?.body !== 'string') throw new Error('fork test: unreadable request refused');
    const body = JSON.parse(init.body) as { id?: number; method?: string; params?: unknown[] };
    if (body.method && state.down.has(body.method)) throw new TypeError('fetch failed');
    if (body.method === 'eth_sendRawTransaction') {
      const raw = body.params![0] as Hex;
      const tx = parseTransaction(raw);
      assert.equal(tx.chainId, BASE_MAINNET, 'a transaction for another chain');
      if (tx.to?.toLowerCase() === ROUTER3.toLowerCase()) {
        if (state.loseNextSettle) {
          state.loseNextSettle = false;
          state.lost.push(raw);
          const result = keccak256(raw);
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
        }
        const hook = state.beforeNextSettle;
        state.beforeNextSettle = null;
        await hook?.();
        state.settles.push(raw);
      }
    }
    return real(input, init);
  }) as typeof fetch;
  return { state, guarded };
}

/** The env of the real runtime, in full: nothing of process.env reaches it. */
const laneEnv = (anvilUrl: string, kek: string, keyRef: string) => ({
  CITY_BASE_MAINNET: '1',
  CITY_BASE_CDP_RPC_URL: loopbackUrl(anvilUrl),
  CITY_BASE_SPENDER_KEK: kek,
  CITY_BASE_MAX_FEE_PER_GAS_WEI: '500000000',
  CITY_BASE_IDENTITY_FEE_CAP_WEI: '50000000000000',
  CITY_BASE_WALLET_FEE_CAP_WEI: '20000000000000',
  CITY_X402_PUBLIC_OFFER_KEY_REF: keyRef,
});

async function assertLocalFork(client: PublicClient, anvilUrl: string, upstream: string) {
  loopbackUrl(anvilUrl);
  assert.notEqual(anvilUrl, upstream, 'the upstream RPC is never the client');
  assert.deepEqual(client.chain?.rpcUrls.default.http, [anvilUrl]);
  assert.equal(await client.getChainId(), BASE_MAINNET, 'a fork of Base mainnet');
  const version = await client.request({ method: 'web3_clientVersion' });
  assert.match(String(version), /anvil/i, 'the node answers as Anvil');
  // A real network refuses this method.
  await client.request({ method: 'anvil_nodeInfo' as never, params: [] as never });
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

async function startAnvil(t: TestContext, upstream: string): Promise<string> {
  const port = await freePort();
  // Its output is dropped: the upstream URL may carry a key.
  const anvil: ChildProcess = spawn(
    'anvil',
    ['--fork-url', upstream, '--host', '127.0.0.1', '--port', String(port)],
    { stdio: 'ignore' },
  );
  t.after(() => void anvil.kill());
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 240; i++) {
    if (anvil.exitCode !== null) throw new Error('anvil exited before it answered');
    const up = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    }).catch(() => null);
    if (up?.ok) return url;
    await sleep(250);
  }
  throw new Error('anvil did not answer');
}

const compile1271Wallet = () => {
  const solc = createRequire(import.meta.url)('solc') as { compile(input: string): string };
  const content = readFileSync(new URL('../contracts/test/Test1271Wallet.sol', import.meta.url));
  const out = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: 'Solidity',
        sources: { 'Test1271Wallet.sol': { content: content.toString('utf8') } },
        settings: {
          evmVersion: 'cancun',
          outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
        },
      }),
    ),
  );
  const built = out.contracts['Test1271Wallet.sol'].Test1271Wallet;
  return { abi: built.abi as Abi, bytecode: `0x${built.evm.bytecode.object}` as Hex };
};

const settlementOf = (payment: PublicPayment): Router3Settlement => ({
  payer: getAddress(payment.payload.payer) as Hex,
  payee: getAddress(payment.accepted.payTo) as Hex,
  gross: BigInt(payment.accepted.amount),
  ref: payment.accepted.extra.ref as Hex,
  validAfter: BigInt(payment.accepted.extra.validAfter),
  validBefore: BigInt(payment.accepted.extra.validBefore),
  sellerSignature: payment.payload.seller.signature as Hex,
  feeSignature: payment.payload.fee.signature as Hex,
});

const legNoncesOf = (s: Router3Settlement) =>
  [LEG_SELLER, LEG_FEE].map((leg) =>
    router3Nonce({ ...CONFIG, ...s, leg: leg as typeof LEG_SELLER | typeof LEG_FEE }),
  );

const keyOf = (callId: string) => `x402pub:${callId}`;

test('dry run, no chain: the guards, the runtime wiring and the signed legs this suite relies on', async () => {
  // A chain client only ever on this machine.
  for (const bad of ['https://mainnet.base.org', 'http://10.0.0.1:8545', 'http://base.example'])
    assert.throws(() => loopbackUrl(bad), bad);
  assert.equal(loopbackUrl('http://127.0.0.1:8547'), 'http://127.0.0.1:8547');

  // The guard: another host refused before any byte leaves, faults as asked, order kept.
  const seen: string[] = [];
  const real = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(String(JSON.parse(String(init?.body)).method));
    return new Response('{}');
  }) as typeof fetch;
  const { state, guarded } = forkGuard('http://127.0.0.1:8547', real);
  await assert.rejects(guarded('https://mainnet.base.org', { body: '{}' }), /another host/);
  await assert.rejects(guarded('http://127.0.0.1:8548', { body: '{}' }), /another host/);
  const buyer = newBuyer();
  const raw = (chainId: number, to: Hex) =>
    buyer.signTransaction({
      type: 'eip1559',
      chainId,
      nonce: 0,
      to,
      value: 0n,
      gas: 21_000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
    });
  const send = (signed: Hex) =>
    guarded('http://127.0.0.1:8547', {
      body: JSON.stringify({ id: 7, method: 'eth_sendRawTransaction', params: [signed] }),
    });
  await assert.rejects(send(await raw(1, ROUTER3)), /another chain/);
  const settle = await raw(BASE_MAINNET, ROUTER3);
  state.loseNextSettle = true;
  const lost = await (await send(settle)).json();
  assert.equal(lost.result, keccak256(settle));
  assert.equal(seen.length, 0, 'a lost broadcast never reached the node');
  state.beforeNextSettle = async () => void seen.push('hook');
  await send(settle);
  await send(await raw(BASE_MAINNET, USDC_ADDRESS));
  assert.deepEqual(seen.slice(0, 2), ['hook', 'eth_sendRawTransaction']);
  assert.deepEqual(state.settles, [settle], 'only the sends to router 3 count as settlements');
  state.down.add('eth_estimateGas');
  await assert.rejects(
    guarded('http://127.0.0.1:8547', { body: '{"method":"eth_estimateGas"}' }),
    /fetch failed/,
  );

  // The real runtime builds the lane from this env, reading nothing, on router 3's real address;
  // an endpoint that is not this machine over http is refused by the runtime itself.
  const kek = `v1:${randomBytes(32).toString('base64')}`;
  const keyRef = 'v1:00000000-0000-4000-8000-000000000001';
  const env = laneEnv('http://127.0.0.1:8547', kek, keyRef);
  const runtime = createChainRuntime({ db: {} as Database, env, chainId: BASE_MAINNET });
  assert.ok(runtime.publicOfferLane?.(), 'the lane is built');
  assert.deepEqual(runtime.feedPayReadClient?.().chain?.rpcUrls.default.http, [
    'http://127.0.0.1:8547',
  ]);
  assert.throws(() =>
    createChainRuntime({
      db: {} as Database,
      env: { ...env, CITY_BASE_CDP_RPC_URL: 'http://rpc.example' },
      chainId: BASE_MAINNET,
    }),
  );

  // The legs: both recover to the buyer under USDC's domain, over the nonces router 3 derives.
  const accepted = {
    amount: GROSS.toString(),
    payTo: getAddress(`0x${'5e'.repeat(20)}`),
    extra: {
      ref: `0x${'ab'.repeat(32)}`,
      validAfter: '0',
      validBefore: '4000000000',
      sellerAmount: NET.toString(),
      feeAmount: FEE.toString(),
    },
  } as PublicPayment['accepted'];
  const payment = await signedPayment(buyer, CONFIG, accepted);
  const s = settlementOf(payment);
  const [sellerNonce, feeNonce] = legNoncesOf(s);
  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  } as const;
  for (const [to, value, nonce, signature] of [
    [s.payee, NET, sellerNonce!, s.sellerSignature],
    [TREASURY, FEE, feeNonce!, s.feeSignature],
  ] as const)
    assert.equal(
      await recoverTypedDataAddress({
        domain: {
          name: 'USD Coin',
          version: '2',
          chainId: CHAIN_ID,
          verifyingContract: USDC_ADDRESS,
        },
        types,
        primaryType: 'TransferWithAuthorization',
        message: {
          from: s.payer,
          to,
          value,
          validAfter: s.validAfter,
          validBefore: s.validBefore,
          nonce,
        },
        signature,
      }),
      buyer.address,
    );
  assert.equal(payment.payload.seller.nonce, sellerNonce);
  assert.equal(payment.payload.fee.nonce, feeNonce);
  assert.match(usdcBalanceSlot(buyer.address), /^0x[0-9a-f]{64}$/);
  assert.match(compile1271Wallet().bytecode, /^0x[0-9a-f]+$/);
});

test(
  'fork: the real public offer lane settles on router 3, and refuses, reverts, caps and resumes',
  { skip: SKIP, timeout: 900_000, concurrency: false },
  async (t) => {
    const anvilUrl = await startAnvil(t, UPSTREAM!);
    const { state: guard, guarded } = forkGuard(anvilUrl, globalThis.fetch);
    const realFetch = globalThis.fetch;
    globalThis.fetch = guarded;
    t.after(() => {
      globalThis.fetch = realFetch;
    });

    const chain = {
      id: BASE_MAINNET,
      name: 'anvil-mainnet-fork',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [anvilUrl] } },
    } as const;
    const client = createPublicClient({ chain, transport: http(anvilUrl) }) as PublicClient;
    await assertLocalFork(client, anvilUrl, UPSTREAM!);
    const rpc = (method: string, params: unknown[]) =>
      client.request({ method: method as never, params: params as never });
    await startAtLowBaseFee(client);
    // Past the 'safe' and 'finalized' tags' distance, so both read blocks of the fork itself.
    await rpc('anvil_mine', ['0x50']);

    const fundEth = (who: Hex, eth: string) =>
      rpc('anvil_setBalance', [who, `0x${parseEther(eth).toString(16)}`]);
    const setUsdc = (who: Hex, raw: bigint) =>
      rpc('anvil_setStorageAt', [
        USDC_ADDRESS,
        usdcBalanceSlot(who),
        numberToHex(raw, { size: 32 }),
      ]);
    const bal = (who: Hex) =>
      client.readContract({
        address: USDC_ADDRESS,
        abi: usdcAbi,
        functionName: 'balanceOf',
        args: [who],
      });
    const nonceUsed = (who: Hex, nonce: Hex) =>
      client.readContract({
        address: USDC_ADDRESS,
        abi: usdcAbi,
        functionName: 'authorizationState',
        args: [who, nonce],
      });
    const forkMs = async () => Number((await client.getBlock()).timestamp) * 1000;
    /** Blocks past 'safe' and 'finalized', and past the runtime's head cache (rpc-budget.ts). */
    const pastFinality = async () => {
      await rpc('anvil_mine', ['0x50']);
      await sleep(2_200);
    };

    // The real app and route; the lane behind a holder so a "crash" can take it away and a new
    // runtime can take over. The wrapper only closes the door, every call is the real lane's.
    const SELLER = getAddress(privateKeyToAccount(generatePrivateKey()).address) as Hex;
    const holder = {
      lane: null as PublicOfferLane | null,
      closed: false,
      closeAfterSubmit: false,
      closeAfterSimulate: false,
    };
    const held = (lane: PublicOfferLane): PublicOfferLane => ({
      ...lane,
      simulate: async (data) => {
        const answer = await lane.simulate(data);
        if (holder.closeAfterSimulate) holder.closed = true;
        return answer;
      },
      submit: async (input) => {
        const op = await lane.submit(input);
        if (holder.closeAfterSubmit) holder.closed = true;
        return op;
      },
    });
    const logLines: string[] = [];
    const f = await setup(t, {
      now: await forkMs(),
      env: {
        CITY_PROTOCOL_FEES: '1',
        CITY_PROTOCOL_FEE_ROUTER3_ENABLED: '1',
        CITY_PROTOCOL_SCREENING: '1',
        CITY_X402_PUBLIC_OFFERS: '1',
        CITY_X402_PUBLIC_OFFERS_ALLOW: OFFER,
        CITY_X402_PUBLIC_OFFERS_SETTLE: '1',
        CITY_RATE_LIMIT_KEY: 'synthetic-rate-limit-key-0123456789abcdef',
      },
      publicOfferLane: async () => (holder.closed ? null : holder.lane),
      logLine: (line) => void logLines.push(line),
      screeningProvider: () => ({
        ref: 'test:screening',
        supports: () => true,
        check: async ({ addresses }) => ({
          listed: Object.fromEntries(addresses.map((address) => [address, false])),
          observedAt: Date.now(),
        }),
      }),
    });
    f.base.state.feeRouter3 = { router: ROUTER3, treasury: TREASURY };
    f.base.state.code.add(ROUTER3.toLowerCase());
    const url = `https://centralcity.ai${OFFER_URL}`;
    const at = f.clock();
    await f.sql(
      `INSERT INTO city_offers (offer_id, operator_id, agent_id, wallet_id, pay_to, kind, title,
         description, tags, price_raw, discoverable, version, state, idem_key, risky,
         price_changed_at, created_at, updated_at, preset)
       VALUES ($1, 'op-seller', 'agent-seller', 'wallet-seller', $2, 'hash', 'Text hash',
         'The SHA-256 of a text.', '{}', $3, true, 1, 'active', $1, NULL, $4, $4, $4, NULL)`,
      [OFFER, SELLER, GROSS.toString(), at],
    );
    await f.sql(
      `INSERT INTO feed_services (id, source, record_id, host, url, title, description, capabilities,
         provider_name, method, x402_version, scheme, price_raw, pay_to, input, output,
         paid_calls_30d, payers_30d, last_called_at, source_updated_at, fetched_at, first_seen_at,
         last_seen_at, last_seen_sweep, missed_sweeps, withdrawn_at, risky, hidden, search_text,
         seller_key)
       VALUES ($1, $2, $3, 'centralcity.ai', $4, 'Text hash', 'The SHA-256 of a text.', '{}',
         'Synthetic seller', 'POST', 2, 'exact', $10, $5, $6::jsonb, $7::jsonb, NULL, NULL, NULL,
         $8, $8, $8, $8, 0, 0, NULL, NULL, false, 'text hash', $9)`,
      [
        feedServiceId(url),
        HOSTED_SOURCE,
        `cc:${OFFER}`,
        url,
        SELLER,
        JSON.stringify(offerInputSummary('hash', null)),
        JSON.stringify(offerOutputSummary('hash')),
        at,
        SELLER.toLowerCase(),
        GROSS.toString(),
      ],
    );

    // The real lane: its own key in the real keystore tables, fed ETH on the fork only.
    const kek = `v1:${randomBytes(32).toString('base64')}`;
    const keystore = createKeystore({ store: pgSpenderKeyStore(f.db), keks: parseKeks(kek) });
    const laneKey = await keystore.createSpenderKey();
    const env = laneEnv(anvilUrl, kek, laneKey.keyRef);
    // The facilitator signs inside its lane transaction, and the keystore reads the key row on the
    // plain handle: a second pool connection on Postgres, a deadlock on PGlite's only connection.
    // So the key row alone is read once, up front. Everything else is the app's own database.
    const keyRead = 'FROM base_spender_keys';
    const keyRow = await f.db.query(
      `SELECT key_id, kek_version, wrapped_dek, ciphertext, signer_address, created_at, committed_at
       ${keyRead} WHERE key_id = $1`,
      [laneKey.keyRef.split(':')[1]],
    );
    const laneDb = new Proxy(f.db, {
      get: (db, name) => {
        if (name === 'query')
          return (sql: string, params?: unknown[]) =>
            sql.includes(keyRead) ? Promise.resolve(keyRow) : db.query(sql, params);
        const value = Reflect.get(db, name);
        return typeof value === 'function' ? value.bind(db) : value;
      },
    });
    const newLane = () => {
      const runtime = createChainRuntime({
        db: laneDb,
        env,
        chainId: BASE_MAINNET,
        log: (line) => void logLines.push(line),
      });
      assert.deepEqual(runtime.feedPayReadClient?.().chain?.rpcUrls.default.http, [anvilUrl]);
      const lane = runtime.publicOfferLane?.();
      assert.ok(lane, 'the runtime built the lane');
      return lane;
    };
    await fundEth(laneKey.signer, '0.05');
    const lane = newLane();
    holder.lane = held(lane);
    const laneNonce = () =>
      client.getTransactionCount({ address: laneKey.signer, blockTag: 'latest' });

    let ip = 1;
    const post = (headers: Record<string, string> = {}) =>
      f.app.inject({
        method: 'POST',
        url: OFFER_URL,
        headers: { 'content-type': 'application/json', ...headers },
        payload: JSON.stringify(INPUT),
        remoteAddress: `203.0.113.${ip++}`,
      });
    /** The app's clock never behind the fork's: terms are judged by block time. */
    const syncClock = async () => {
      const ahead = (await forkMs()) - f.clock();
      if (ahead > 0) f.advance(ahead);
    };
    const challenge = async () => {
      await syncClock();
      const res = await post();
      assert.equal(res.statusCode, 402, res.body);
      return res.json().accepts[0] as PublicPayment['accepted'];
    };
    const fundedBuyer = async () => {
      const buyer = newBuyer();
      await setUsdc(buyer.address, 10_000_000n);
      assert.equal(await bal(buyer.address), 10_000_000n, 'the storage slot is the balance');
      return buyer;
    };
    const row = async (callId: string) =>
      (
        await f.sql<{
          state: string;
          failure_code: string | null;
          tx_hash: string | null;
          result_text: string | null;
        }>(
          'SELECT state, failure_code, tx_hash, result_text FROM feed_pay_public_calls WHERE call_id = $1',
          [callId],
        )
      )[0];
    const opRow = async (key: string) =>
      (
        await f.sql<{
          status: string;
          never_sent: boolean;
          error_code: string | null;
          error_name: string | null;
          intent_hash: Hex;
          raw_tx: Hex | null;
          tx_hash: Hex | null;
          tx_hashes: string[];
        }>(
          `SELECT status, never_sent, error_code, error_name, intent_hash, raw_tx, tx_hash, tx_hashes
           FROM x402_facilitator_ops WHERE op_key = $1`,
          [key],
        )
      )[0];
    const work = async () => {
      const res = await f.app.inject({
        url: '/api/cron/x402-offer-work',
        headers: { authorization: `Bearer ${CRON}` },
      });
      assert.equal(res.statusCode, 200, res.body);
    };
    const workUntil = async (callId: string, state: string) => {
      for (let i = 0; i < 10; i++) {
        if ((await row(callId))?.state === state) return;
        await work();
      }
      assert.equal((await row(callId))?.state, state, logLines.join('\n'));
    };
    const balances = async (payer: Hex) => ({
      payer: await bal(payer),
      seller: await bal(SELLER),
      treasury: await bal(TREASURY),
      router: await bal(ROUTER3),
    });
    /** Seller, treasury and buyer to the unit; exactly one real FeeCharged, this call's. */
    const assertPaid = async (
      callId: string,
      s: Router3Settlement,
      before: Awaited<ReturnType<typeof balances>>,
    ) => {
      const after = await balances(s.payer);
      assert.equal(before.payer - after.payer, GROSS, 'the buyer paid the price, no more');
      assert.equal(after.seller - before.seller, NET, 'the seller got its 90%');
      assert.equal(after.treasury - before.treasury, FEE, 'the treasury got its 10%');
      assert.equal(after.router, before.router, 'the router keeps nothing');
      const op = await lane.status(keyOf(callId));
      assert.ok(op?.txHash, 'the settlement has a transaction');
      const logs = await lane.receiptLogs(op.txHash);
      assert.ok(logs, 'a successful receipt');
      const events = feeEventsOf(BASE_MAINNET, ROUTER3, logs);
      assert.equal(events.length, 1, 'exactly one FeeCharged');
      assert.equal(getAddress(events[0]!.payer), getAddress(s.payer));
      assert.equal(getAddress(events[0]!.payee), SELLER);
      assert.equal(events[0]!.ref.toLowerCase(), s.ref.toLowerCase());
      assert.equal(events[0]!.gross, GROSS);
      assert.equal(events[0]!.fee, FEE);
      assert.deepEqual(
        router3OwnTransfers(logs, { ...CONFIG, payer: s.payer, ref: s.ref })?.map((x) => [
          getAddress(x.to),
          x.value,
        ]),
        [
          [SELLER, NET],
          [TREASURY, FEE],
        ],
        'exactly the two legs, both from the buyer',
      );
      for (const nonce of legNoncesOf(s)) assert.equal(await nonceUsed(s.payer, nonce), true);
      return op;
    };
    const directSubmit = (key: string, settlement: Router3Settlement) =>
      lane.submit({
        key,
        intentHash: keccak256(stringToHex(key)),
        settlement,
        beforeBroadcast: async () => {},
      });
    const newKey = () => keyOf(`fork-${randomUUID()}`);

    await t.test('the fork is what the lane expects', async () => {
      assert.equal(await lane.address(), laneKey.signer);
      assert.equal(await lane.canPay(), true);
      assert.equal(await lane.ethBalance(), parseEther('0.05'));
      const lag = await lane.finalityLagSeconds();
      assert.ok(lag >= 0 && lag <= 3_600, `finality lag ${lag}`);
      assert.ok(await client.getCode({ address: ROUTER3 }), 'router 3 is deployed at this block');
      assert.equal(
        await client.readContract({ address: ROUTER3, abi: routerAbi, functionName: 'treasury' }),
        TREASURY,
      );
      // The nonces the code derives are the ones the deployed router derives.
      const input = {
        payer: getAddress(`0x${'11'.repeat(20)}`) as Hex,
        payee: SELLER,
        gross: GROSS,
        ref: `0x${'22'.repeat(32)}` as Hex,
        validAfter: 1n,
        validBefore: 2n,
      };
      for (const leg of [LEG_SELLER, LEG_FEE] as const)
        assert.equal(
          await client.readContract({
            address: ROUTER3,
            abi: routerAbi,
            functionName: 'nonceFor',
            args: [
              input.payer,
              input.payee,
              input.gross,
              input.ref,
              input.validAfter,
              input.validBefore,
              leg,
            ],
          }),
          router3Nonce({ ...CONFIG, ...input, leg }),
        );
    });

    let paidCallId = '';
    let paidHeader = '';
    await t.test('through the route: a fresh EOA pays, exactly once, to the unit', async () => {
      const buyer = await fundedBuyer();
      const accepted = await challenge();
      assert.equal(BigInt(accepted.amount), GROSS);
      const payment = await signedPayment(buyer, CONFIG, accepted);
      const s = settlementOf(payment);
      const before = await balances(buyer.address);
      const nonceBefore = await laneNonce();
      const sendsBefore = guard.settles.length;
      const res = await post({ 'payment-signature': paymentHeader(payment) });
      assert.equal(res.statusCode, 200, `${res.body}\n${logLines.join('\n')}`);
      assert.match(res.body, new RegExp(RESULT));
      const callId = accepted.extra.callId;
      assert.equal((await row(callId))?.state, 'delivered');
      assert.equal(guard.settles.length, sendsBefore + 1, 'one settlement sent');
      assert.equal(await laneNonce(), nonceBefore + 1, 'one nonce used');
      const op = await assertPaid(callId, s, before);
      assert.equal((await row(callId))?.tx_hash, op.txHash);
      const receipt = JSON.parse(
        Buffer.from(res.headers['payment-response'] as string, 'base64').toString(),
      );
      assert.equal(receipt.transaction, op.txHash);
      paidCallId = callId;
      paidHeader = paymentHeader(payment);

      // legsState reads the safe block: the legs are used at the head, not yet there.
      const nonces = legNoncesOf(s);
      assert.equal(await lane.legsState(s.payer, nonces, Number(s.validBefore)), 'wait');
      await pastFinality();
      assert.equal(await lane.legsState(s.payer, nonces, Number(s.validBefore)), 'used');
      assert.equal((await lane.status(keyOf(callId)))?.status, 'final');
      assert.equal(
        await lane.endUnsent(keyOf(callId), (await opRow(keyOf(callId)))!.intent_hash),
        false,
        'a settlement that went out is never fenced',
      );
    });

    await t.test('replay: refused by the route, the lane and the chain', async () => {
      const callId = paidCallId;
      const payment = JSON.parse(Buffer.from(paidHeader, 'base64').toString()) as PublicPayment;
      const s = settlementOf(payment);
      const sendsBefore = guard.settles.length;
      const nonceBefore = await laneNonce();
      const before = await balances(s.payer);

      // The same header answers the stored call.
      const again = await post({ 'payment-signature': paidHeader });
      assert.equal(again.statusCode, 200, again.body);
      // Another payer on the same terms gets no call and no result.
      const other = await signedPayment(newBuyer(), CONFIG, payment.accepted);
      const stolen = await post({ 'payment-signature': paymentHeader(other) });
      assert.equal(stolen.statusCode, 409, stolen.body);
      assert.doesNotMatch(stolen.body, new RegExp(RESULT));
      // The same key is the stored settlement, however it is asked.
      const op = await opRow(keyOf(callId));
      const same = await lane.submit({
        key: keyOf(callId),
        intentHash: op!.intent_hash,
        settlement: s,
        beforeBroadcast: async () => assert.fail('no first send for a stored key'),
      });
      assert.equal(same.txHash, op!.tx_hash);
      // Another key on the same legs: the real router refuses at the simulation, nothing is sent.
      assert.deepEqual(await lane.simulate(encodeSettle(s)), { ok: false, retryable: false });
      const key = newKey();
      const refused = await directSubmit(key, s);
      assert.equal(refused.status, 'failed');
      assert.equal(refused.neverSent, true);
      assert.equal(refused.errorCode, 'SIMULATION_REVERTED');
      console.log(`fork: replay refused as ${(await opRow(key))?.error_name}`);

      assert.equal(guard.settles.length, sendsBefore, 'nothing was sent');
      assert.equal(await laneNonce(), nonceBefore, 'no nonce was taken');
      assert.deepEqual(await balances(s.payer), before);
    });

    await t.test('swapped legs: USDC refuses at the simulation; no row, nothing sent', async () => {
      const buyer = await fundedBuyer();
      const accepted = await challenge();
      const payment = await signedPayment(buyer, CONFIG, accepted, { swapLegs: true });
      const sendsBefore = guard.settles.length;
      const res = await post({ 'payment-signature': paymentHeader(payment) });
      assert.equal(res.statusCode, 402, res.body);
      assert.equal(res.json().code, 'payment_invalid');
      assert.equal(await row(accepted.extra.callId), undefined);
      assert.equal(guard.settles.length, sendsBefore);
    });

    await t.test(
      'an ERC-1271 buyer (contracts/test/Test1271Wallet.sol) pays the same',
      async () => {
        const owner = newBuyer();
        const deployer = privateKeyToAccount(generatePrivateKey());
        await fundEth(deployer.address, '0.01');
        const { abi, bytecode } = compile1271Wallet();
        const hash = await createWalletClient({
          account: deployer,
          chain,
          transport: http(anvilUrl),
        }).sendTransaction({
          data: encodeDeployData({ abi, bytecode, args: [owner.address] }),
          maxFeePerGas: 500_000_000n,
          maxPriorityFeePerGas: 1_000_000n,
        });
        const deployed = await client.waitForTransactionReceipt({ hash });
        assert.equal(deployed.status, 'success');
        const wallet = deployed.contractAddress as Hex;
        await setUsdc(wallet, 10_000_000n);

        const accepted = await challenge();
        // The wallet is the payer; its owner key signs.
        const asWallet = { ...owner, address: wallet } as PrivateKeyAccount;
        const payment = await signedPayment(asWallet, CONFIG, accepted);
        const s = settlementOf(payment);
        const before = await balances(wallet);
        const res = await post({ 'payment-signature': paymentHeader(payment) });
        assert.equal(res.statusCode, 200, `${res.body}\n${logLines.join('\n')}`);
        assert.match(res.body, new RegExp(RESULT));
        await assertPaid(accepted.extra.callId, s, before);
      },
    );

    await t.test('the L1 fee cap: a stranger signature above it is never signed', async () => {
      // A stranger's contract wallet that passes any signature: its calldata is the stranger's
      // choice, within the route's bound. Small enough for the gas cap, which is checked first.
      const stranger = privateKeyToAccount(generatePrivateKey()).address;
      await rpc('anvil_setCode', [stranger, ANY_SIGNATURE_WALLET]);
      await setUsdc(stranger, 10_000_000n);
      const payAsStranger = async () => {
        const accepted = await challenge();
        const payment = await signedPayment(
          { ...newBuyer(), address: stranger } as PrivateKeyAccount,
          CONFIG,
          accepted,
        );
        const long = `0x${randomBytes(600).toString('hex')}`;
        payment.payload.seller.signature = long;
        payment.payload.fee.signature = `0x${randomBytes(600).toString('hex')}`;
        return { accepted, payment };
      };

      const saved = [] as Hex[];
      for (const slot of L1_SLOTS)
        saved.push((await rpc('eth_getStorageAt', [L1_BLOCK, slot, 'latest'])) as Hex);
      const high = numberToHex(10n ** 15n, { size: 32 });
      for (const slot of L1_SLOTS) await rpc('anvil_setStorageAt', [L1_BLOCK, slot, high]);
      const l1Fee = (data: Hex) =>
        client.readContract({
          address: GAS_PRICE_ORACLE,
          abi: oracleAbi,
          functionName: 'getL1Fee',
          args: [data],
        });
      const sample = `0x${'ab'.repeat(1_600)}` as Hex;
      assert.ok(
        (await l1Fee(sample)) * 2n > PUBLIC_SETTLE_MAX_L1_FEE_WEI,
        'the L1 price on the fork is above the cap',
      );
      try {
        const { accepted, payment } = await payAsStranger();
        const before = await balances(stranger);
        const sendsBefore = guard.settles.length;
        const nonceBefore = await laneNonce();
        const res = await post({ 'payment-signature': paymentHeader(payment) });
        assert.equal(res.statusCode, 402, `${res.body}\n${logLines.join('\n')}`);
        // The route refuses before the kind runs; the facilitator's own cap still holds behind it.
        assert.equal(res.json().code, 'payment_too_costly');
        assert.doesNotMatch(res.body, new RegExp(RESULT));
        assert.equal(await opRow(keyOf(accepted.extra.callId)), undefined, 'no settlement stored');
        const key = newKey();
        const capped = await directSubmit(key, settlementOf(payment));
        assert.equal(capped.neverSent, true);
        assert.equal(capped.errorCode, 'L1_FEE_CAP');
        assert.equal((await opRow(key))?.raw_tx, null, 'nothing was signed');
        assert.equal(guard.settles.length, sendsBefore, 'nothing was sent');
        assert.equal(await laneNonce(), nonceBefore, 'no nonce was taken');
        assert.deepEqual(await balances(stranger), before);
        assert.ok(logLines.some((line) => /L1 fee above its cap/.test(line)));
      } finally {
        for (const [i, slot] of L1_SLOTS.entries())
          await rpc('anvil_setStorageAt', [L1_BLOCK, slot, saved[i]]);
      }

      // The same size at the fork's own L1 price is under the cap and settles.
      assert.ok((await l1Fee(sample)) * 2n <= PUBLIC_SETTLE_MAX_L1_FEE_WEI, 'the price is back');
      const { accepted, payment } = await payAsStranger();
      const before = await balances(stranger);
      const res = await post({ 'payment-signature': paymentHeader(payment) });
      assert.equal(res.statusCode, 200, `${res.body}\n${logLines.join('\n')}`);
      await assertPaid(accepted.extra.callId, settlementOf(payment), before);
    });

    await t.test('legsState and endUnsent on the real lane', async () => {
      const unused = [`0x${randomBytes(32).toString('hex')}`] as Hex[];
      const payer = newBuyer().address;
      const safe = await client.getBlock({ blockTag: 'safe' });
      const past = Math.min(Math.floor(Date.now() / 1000), Number(safe.timestamp)) - 10;
      await sleep(2_200);
      assert.equal(await lane.legsState(payer, unused, past), 'unused');
      assert.equal(await lane.legsState(payer, unused, past + 86_400), 'wait', 'window open');
      // Base not answering decides nothing.
      guard.down.add('eth_call');
      assert.equal(await lane.legsState(payer, unused, past), 'wait');
      guard.down.delete('eth_call');

      const buyer = await fundedBuyer();
      const s = settlementOf(await signedPayment(buyer, CONFIG, await challenge()));
      const sendsBefore = guard.settles.length;
      guard.down.add('eth_estimateGas');
      assert.deepEqual(await lane.simulate(encodeSettle(s)), { ok: false, retryable: true });

      // Base down at the first send: stored, unsigned, still queued; fenced, it can never go out.
      const queued = newKey();
      await assert.rejects(directSubmit(queued, s), { code: 'RPC_UNAVAILABLE' });
      guard.down.delete('eth_estimateGas');
      assert.equal((await lane.status(queued))?.status, 'queued');
      const intent = keccak256(stringToHex(queued));
      await assert.rejects(lane.endUnsent(queued, keccak256(stringToHex('another'))), {
        code: 'IDEMPOTENCY_CONFLICT',
      });
      assert.equal(await lane.endUnsent(queued, intent), true);
      const fenced = await directSubmit(queued, s);
      assert.equal(fenced.status, 'failed');
      assert.equal(fenced.neverSent, true);
      assert.equal(fenced.errorCode, 'ABANDONED_BEFORE_BROADCAST');

      // A key nobody stored: the tombstone holds it, the same legs under it never go out.
      const unknown = newKey();
      assert.equal(await lane.endUnsent(unknown, keccak256(stringToHex(unknown))), true);
      const op = await directSubmit(unknown, s);
      assert.equal(op.neverSent, true);
      assert.equal(guard.settles.length, sendsBefore, 'nothing was sent');
      assert.equal(await bal(buyer.address), 10_000_000n);
    });

    await t.test('a first send put off: nothing signed, then the same key pays once', async () => {
      const buyer = await fundedBuyer();
      const s = settlementOf(await signedPayment(buyer, CONFIG, await challenge()));
      const key = newKey();
      const intent = keccak256(stringToHex(key));
      const sendsBefore = guard.settles.length;
      const nonceBefore = await laneNonce();
      await assert.rejects(
        lane.submit({
          key,
          intentHash: intent,
          settlement: s,
          beforeBroadcast: async () => {
            throw new BroadcastDeferred('paused');
          },
        }),
        { code: 'DEFERRED' },
      );
      assert.equal((await lane.status(key))?.status, 'queued');
      assert.equal(guard.settles.length, sendsBefore);
      assert.equal(await laneNonce(), nonceBefore);
      assert.equal(await bal(buyer.address), 10_000_000n);
      const op = await lane.submit({
        key,
        intentHash: intent,
        settlement: s,
        beforeBroadcast: async () => {},
      });
      assert.equal(op.neverSent, false);
      assert.ok(op.txHash);
      assert.equal(guard.settles.length, sendsBefore + 1, 'one settlement sent');
      await rpc('anvil_mine', ['0x1']);
      assert.equal(await laneNonce(), nonceBefore + 1, 'one nonce used');
      const again = await lane.submit({
        key,
        intentHash: intent,
        settlement: s,
        beforeBroadcast: async () => assert.fail('not asked after the first send'),
      });
      assert.equal(again.txHash, op.txHash);
      assert.equal(guard.settles.length, sendsBefore + 1);
    });

    await t.test('reverted, a leg used outside: legs_used_elsewhere, the fee unpaid', async () => {
      const buyer = await fundedBuyer();
      const accepted = await challenge();
      const payment = await signedPayment(buyer, CONFIG, accepted);
      const s = settlementOf(payment);
      const [sellerNonce, feeNonce] = legNoncesOf(s);
      const relayer = privateKeyToAccount(generatePrivateKey());
      await fundEth(relayer.address, '0.01');
      // Between the last simulation and the send, someone holding the leg sends it on USDC.
      guard.beforeNextSettle = async () => {
        const hash = await createWalletClient({
          account: relayer,
          chain,
          transport: http(anvilUrl),
        }).writeContract({
          address: USDC_ADDRESS,
          abi: usdcAbi,
          functionName: 'transferWithAuthorization',
          args: [
            s.payer,
            s.payee,
            NET,
            s.validAfter,
            s.validBefore,
            sellerNonce!,
            s.sellerSignature,
          ],
          maxFeePerGas: 500_000_000n,
          maxPriorityFeePerGas: 1_000_000n,
        });
        const outside = await client.waitForTransactionReceipt({ hash });
        assert.equal(outside.status, 'success');
      };
      const before = await balances(buyer.address);
      const sendsBefore = guard.settles.length;
      const first = await post({ 'payment-signature': paymentHeader(payment) });
      assert.equal(first.statusCode, 202, `${first.body}\n${logLines.join('\n')}`);
      assert.doesNotMatch(first.body, new RegExp(RESULT));
      assert.equal(guard.settles.length, sendsBefore + 1, 'the settlement did go out');
      const key = keyOf(accepted.extra.callId);
      const included = await lane.status(key);
      assert.equal(included?.status, 'included');
      assert.equal(included?.errorCode, 'REVERTED');
      assert.equal(await lane.receiptLogs(included!.txHash!), null, 'a reverted receipt has none');
      assert.equal((await row(accepted.extra.callId))?.state, 'sent', 'not ended before finality');

      await pastFinality();
      await workUntil(accepted.extra.callId, 'failed');
      assert.equal((await row(accepted.extra.callId))?.failure_code, 'legs_used_elsewhere');
      assert.ok(logLines.some((line) => /x402_offer\.legs_used/.test(line)));
      const after = await post({ 'payment-signature': paymentHeader(payment) });
      assert.equal(after.statusCode, 409, after.body);
      assert.equal(after.json().code, 'legs_used_elsewhere');
      const end = await balances(buyer.address);
      assert.equal(before.payer - end.payer, NET, 'only the leg used outside moved');
      assert.equal(end.seller - before.seller, NET);
      assert.equal(end.treasury, before.treasury, 'no fee, and no FeeCharged to claim one');
      assert.equal(await nonceUsed(s.payer, feeNonce!), false, 'the fee leg rolled back');
    });

    await t.test(
      'reverted, both legs settled by someone else: paid, with their transaction',
      async () => {
        const buyer = await fundedBuyer();
        const accepted = await challenge();
        const payment = await signedPayment(buyer, CONFIG, accepted);
        const s = settlementOf(payment);
        const relayer = privateKeyToAccount(generatePrivateKey());
        await fundEth(relayer.address, '0.01');
        let outsideHash: Hex | undefined;
        guard.beforeNextSettle = async () => {
          outsideHash = await createWalletClient({
            account: relayer,
            chain,
            transport: http(anvilUrl),
          }).sendTransaction({
            to: ROUTER3,
            data: encodeSettle(s),
            maxFeePerGas: 500_000_000n,
            maxPriorityFeePerGas: 1_000_000n,
          });
          const outside = await client.waitForTransactionReceipt({ hash: outsideHash });
          assert.equal(outside.status, 'success');
        };
        const before = await balances(buyer.address);
        const first = await post({ 'payment-signature': paymentHeader(payment) });
        assert.equal(first.statusCode, 202, `${first.body}\n${logLines.join('\n')}`);
        assert.equal((await lane.status(keyOf(accepted.extra.callId)))?.errorCode, 'REVERTED');

        await pastFinality();
        await workUntil(accepted.extra.callId, 'delivered');
        assert.equal((await row(accepted.extra.callId))?.tx_hash, outsideHash);
        assert.ok(logLines.some((line) => /x402_offer.settled_elsewhere/.test(line)));
        const end = await balances(buyer.address);
        assert.equal(before.payer - end.payer, GROSS, 'the buyer paid once');
        assert.equal(end.seller - before.seller, NET);
        assert.equal(end.treasury - before.treasury, FEE);
      },
    );

    await t.test('the lane reads the public checks use', async () => {
      assert.equal(await lane.hasCode(ROUTER3), true);
      assert.equal(await lane.hasCode(newBuyer().address), false);
      const buyer = await fundedBuyer();
      const data = encodeSettle(
        settlementOf(await signedPayment(buyer, CONFIG, await challenge())),
      );
      const answer = await lane.simulate(data);
      assert.ok(answer.ok && answer.gas, 'a simulation answers the gas it used');
      assert.equal(await lane.withinCaps(data, answer.gas), true, 'a normal settlement fits');
      assert.equal(await lane.withinCaps(data, 100_000_000n), false, 'gas above the cap');
    });

    await t.test(
      'crash at sent, the broadcast lost: a new runtime sends the same bytes',
      async () => {
        const buyer = await fundedBuyer();
        const accepted = await challenge();
        const payment = await signedPayment(buyer, CONFIG, accepted);
        const s = settlementOf(payment);
        const before = await balances(buyer.address);
        const callId = accepted.extra.callId;
        const nonceBefore = await laneNonce();
        guard.loseNextSettle = true;
        holder.closeAfterSubmit = true;
        const first = await post({ 'payment-signature': paymentHeader(payment) });
        holder.closeAfterSubmit = false;
        assert.equal(first.statusCode, 202, first.body);
        assert.equal((await row(callId))?.state, 'sent');
        const stored = (await opRow(keyOf(callId)))!;
        assert.equal(guard.lost.at(-1), stored.raw_tx, 'signed, stored, and lost');
        assert.equal(await laneNonce(), nonceBefore, 'nothing reached the fork');
        assert.deepEqual(await balances(buyer.address), before);

        // The process is gone. A new runtime over the same database and key takes over.
        const sendsBefore = guard.settles.length;
        holder.lane = held(newLane());
        holder.closed = false;
        await workUntil(callId, 'delivered');
        const after = (await opRow(keyOf(callId)))!;
        assert.equal(after.raw_tx, stored.raw_tx, 'never re-signed');
        assert.deepEqual(after.tx_hashes, [keccak256(stored.raw_tx!)]);
        assert.equal(guard.settles.length, sendsBefore + 1, 'sent once');
        assert.equal(guard.settles.at(-1), stored.raw_tx);
        assert.equal(await laneNonce(), nonceBefore + 1);
        await assertPaid(callId, s, before);
        const done = await post({ 'payment-signature': paymentHeader(payment) });
        assert.equal(done.statusCode, 200, done.body);
        assert.match(done.body, new RegExp(RESULT));
      },
    );

    await t.test(
      'crash at sent, no settlement stored: the worker hands the legs over',
      async () => {
        const buyer = await fundedBuyer();
        const accepted = await challenge();
        const payment = await signedPayment(buyer, CONFIG, accepted);
        const s = settlementOf(payment);
        const before = await balances(buyer.address);
        const callId = accepted.extra.callId;
        holder.closeAfterSimulate = true;
        const first = await post({ 'payment-signature': paymentHeader(payment) });
        holder.closeAfterSimulate = false;
        assert.equal(first.statusCode, 202, first.body);
        assert.equal((await row(callId))?.state, 'ran');
        assert.equal(await opRow(keyOf(callId)), undefined, 'nothing stored at the facilitator');
        // Recorded as handed over, while the facilitator holds nothing (public-pay.ts follow).
        await f.sql(`UPDATE feed_pay_public_calls SET state = 'sent' WHERE call_id = $1`, [callId]);

        const sendsBefore = guard.settles.length;
        holder.lane = held(newLane());
        holder.closed = false;
        await workUntil(callId, 'delivered');
        assert.equal(guard.settles.length, sendsBefore + 1, 'sent once');
        await assertPaid(callId, s, before);
      },
    );

    await t.test(
      'the outside buyer module pays on the fork: real router, real USDC, real nonces',
      async () => {
        const buyer = await fundedBuyer();
        await syncClock();
        const before = await balances(buyer.address);
        const callIds: string[] = [];
        const signatures = new Set<string>();
        const appFetch = (async (input: string | URL | Request, init?: RequestInit) => {
          const headers = init?.headers as Record<string, string>;
          const res = await post(
            headers['PAYMENT-SIGNATURE']
              ? { 'payment-signature': headers['PAYMENT-SIGNATURE'] }
              : {},
          );
          assert.equal(new URL(String(input)).pathname, OFFER_URL);
          const out = new Headers();
          for (const [k, v] of Object.entries(res.headers))
            if (v !== undefined) out.set(k, String(v));
          return new Response(res.body, { status: res.statusCode, headers: out });
        }) as typeof globalThis.fetch;
        const bought = await buyOffer({
          account: buyer,
          url: url,
          input: INPUT,
          maxPriceRaw: GROSS,
          payTo: SELLER,
          terms: { ...BASE_MAINNET_TERMS, reservedPayees: [ROUTER3, TREASURY, USDC_ADDRESS] },
          fetch: appFetch,
          now: f.clock,
          onSigned: (pending) => {
            callIds.push(pending.callId);
            signatures.add(pending.paymentHeader);
          },
          // The worker runs between two resends, as the cron does in production.
          sleep: async () => {
            await sleep(100);
            await work();
          },
        });
        assert.equal(callIds.length, 1);
        assert.equal(signatures.size, 1);
        assert.equal(bought.result.includes(RESULT), true, bought.result);
        const after = await balances(buyer.address);
        assert.equal(before.payer - after.payer, GROSS, 'the buyer paid the price, no more');
        assert.equal(after.seller - before.seller, NET);
        assert.equal(after.treasury - before.treasury, FEE);
        assert.equal(after.router, before.router);
        const receipt = await client.getTransactionReceipt({ hash: bought.transaction });
        assert.equal(receipt.status, 'success');
        const events = feeEventsOf(
          BASE_MAINNET,
          ROUTER3,
          receipt.logs.map((log) => ({ address: log.address, topics: log.topics, data: log.data })),
        );
        assert.equal(events.length, 1, 'exactly one FeeCharged');
        assert.equal(getAddress(events[0]!.payer), buyer.address);
        assert.equal(events[0]!.gross, GROSS);
      },
    );

    // Last: it moves the fork's clock past a window.
    await t.test(
      'reverted, legs unused: failed only at a safe block past the window',
      async (st) => {
        const buyer = await fundedBuyer();
        const accepted = await challenge();
        const payment = await signedPayment(buyer, CONFIG, accepted);
        const s = settlementOf(payment);
        const nonces = legNoncesOf(s);
        const callId = accepted.extra.callId;
        guard.beforeNextSettle = () => setUsdc(buyer.address, 0n);
        const before = await balances(buyer.address);
        const first = await post({ 'payment-signature': paymentHeader(payment) });
        assert.equal(first.statusCode, 202, `${first.body}\n${logLines.join('\n')}`);
        const key = keyOf(callId);
        const included = await lane.status(key);
        assert.equal(included?.errorCode, 'REVERTED');

        // Final and failed, but anyone holding the legs could still send them: the row waits.
        await pastFinality();
        assert.equal((await lane.status(key))?.status, 'failed');
        assert.equal(await lane.legsState(s.payer, nonces, Number(s.validBefore)), 'wait');
        await work();
        assert.equal((await row(callId))?.state, 'sent');

        // Past the window at a safe block; legsState's wall clock moved with it, for this call only.
        await rpc('evm_setNextBlockTimestamp', [Number(s.validBefore) + 1]);
        await pastFinality();
        const wall = st.mock.method(Date, 'now', () => (Number(s.validBefore) + 5) * 1000);
        try {
          assert.equal(await lane.legsState(s.payer, nonces, Number(s.validBefore)), 'unused');
          await workUntil(callId, 'failed');
        } finally {
          wall.mock.restore();
        }
        assert.equal((await row(callId))?.failure_code, 'REVERTED');
        assert.equal((await row(callId))?.result_text, null, 'the result is dropped');
        const after = await post({ 'payment-signature': paymentHeader(payment) });
        assert.equal(after.statusCode, 402, after.body);
        assert.equal(after.json().code, 'payment_failed');
        const end = await balances(buyer.address);
        assert.equal(end.seller, before.seller, 'nothing moved');
        assert.equal(end.treasury, before.treasury);
        for (const nonce of nonces) assert.equal(await nonceUsed(s.payer, nonce), false);
      },
    );
  },
);
