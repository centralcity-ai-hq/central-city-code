import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseAbi,
  parseEther,
} from 'viem';
import type { UserOperation } from 'viem/account-abstraction';
import type { Database } from '../server/database.js';
import { BASE_MAINNET, BASE_NETWORKS, type Address } from '../shared/base/chains.js';
import { protocolDeployment } from '../shared/protocol.js';
import { deriveAddressLocal, spenderAccountRecipe } from '../server/base/chain/derive.js';
import { createKeystore, parseKeks, type StoredSpenderKey } from '../server/base/chain/keystore.js';
import {
  DIRECT_BUNDLER_FINALITY_SQL,
  DIRECT_BUNDLER_SQL,
  directBundler,
  lazyBundler,
  NeverBroadcastError,
  registerOwnBundlerMaintainRoute,
  type OwnBundlerUpkeep,
} from '../server/base/chain/direct-bundler.js';
import {
  OWN_PAYMASTER_BUDGET_SQL,
  ownPaymasterBudget,
} from '../server/base/chain/own-paymaster-budget.js';
import { OWN_PAYMASTER_KEYS_SQL } from '../server/base/chain/own-paymaster-keys.js';
import { BundlerError } from '../server/base/chain/rpc-bundler.js';
import { keystoreSigner, prepareOperation, type Bundler } from '../server/base/chain/submit.js';
import { startAtLowBaseFee } from './anvil-fees.js';

/*
 * The drain and recovery rehearsal on an Anvil fork of Base MAINNET (skipped without
 * CITY_BASE_MAINNET_ANVIL_URL), no live spend: the real VerifyingPaymaster bytecode (its signer and
 * bundler allowlist taken over on the fork only), the real EntryPoint v0.6, throwaway keys and
 * fork-only funds. The steps the switch back to CDP takes in production:
 *   1. ours takes new work and holds two sends that are mined but not yet final;
 *   2. the switch (newWork 'cdp'): new work goes to CDP, ours keeps what it holds, and the cron
 *      answers 'drain' with the open count; a draft of ours that was never sent is refused but NOT
 *      as never broadcast (its reservation is still open), and when the older deployment, still
 *      warm and direct, sends it meanwhile, the draining one follows that send;
 *   3. a restart in the middle of the drain (a fresh instance on the same database) still drains;
 *   4. once the sends are final the cron settles them and answers 'off';
 *   5. switched back, ours takes new work again.
 *   anvil --fork-url https://mainnet.base.org --port 8547 ; CITY_BASE_MAINNET_ANVIL_URL=http://127.0.0.1:8547
 */

const ANVIL_URL = process.env.CITY_BASE_MAINNET_ANVIL_URL;
const network = BASE_NETWORKS[BASE_MAINNET];
const ENTRY_POINT = network.contracts.entryPointV06;
const PAYMASTER = '0x2FAEB0760D4230Ef2aC21496Bb4F0b47D634FD4c' as const;
const SECRET = 'rehearsal-cron-secret';
const vpmAbi = parseAbi([
  'function owner() view returns (address)',
  'function setPendingVerifyingSigner(address signer)',
  'function rotateVerifyingSigner()',
  'function updateBundlerAllowlist(address bundler, bool allowed)',
]);
const identityAbi = parseAbi(['function register(string tokenURI)']);
const depositAbi = parseAbi(['function balanceOf(address account) view returns (uint256)']);

async function database(t: { after: (fn: () => Promise<unknown>) => void }) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(OWN_PAYMASTER_KEYS_SQL);
  await pg.exec(OWN_PAYMASTER_BUDGET_SQL);
  await pg.exec(DIRECT_BUNDLER_SQL);
  await pg.exec(DIRECT_BUNDLER_FINALITY_SQL);
  return {
    query: (sql: string, params?: unknown[]) => pg.query(sql, params) as never,
    exec: (sql: string) => pg.exec(sql),
    transaction: (action: (tx: never) => Promise<unknown>) =>
      pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  } as unknown as Database;
}

/** A CDP bundler that records what reaches it (it must never see an operation of ours). */
const recordingCdp = () => {
  const calls: { method: string; paymasterAndData: string }[] = [];
  const bundler: Bundler = {
    prepare: async (op) => {
      calls.push({ method: 'prepare', paymasterAndData: op.paymasterAndData ?? '0x' });
      return op;
    },
    send: async (op) => {
      calls.push({ method: 'send', paymasterAndData: op.paymasterAndData ?? '0x' });
      return `0x${'1'.repeat(64)}`;
    },
    receipt: async () => null,
  } as Bundler;
  return { calls, bundler };
};

test(
  'fork rehearsal: switch to CDP drains ours to final, survives a restart, then ours resumes',
  { skip: !ANVIL_URL, timeout: 240_000 },
  async (t) => {
    const chain = {
      id: BASE_MAINNET,
      name: 'anvil-mainnet-fork',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [ANVIL_URL!] } },
    } as const;
    const client = createPublicClient({ chain, transport: http(ANVIL_URL) });
    await startAtLowBaseFee(client as never);
    const rpc = (method: string, params: unknown[]) =>
      client.request({ method: method as never, params: params as never });
    const fund = (address: Address, eth: string) =>
      rpc('anvil_setBalance', [address, `0x${parseEther(eth).toString(16)}`]);

    const rows = new Map<string, StoredSpenderKey>();
    const keystore = createKeystore({
      store: {
        insert: async (row) => void rows.set(row.keyId, row),
        get: async (id) => rows.get(id) ?? null,
      },
      keks: parseKeks(`v1:${randomBytes(32).toString('base64')}`),
    });
    const signerKey = await keystore.createSpenderKey();
    const submitterKey = await keystore.createSpenderKey();
    const spenderKey = await keystore.createSpenderKey();

    // Fork only: the live paymaster's owner rotates its signer to ours and allowlists our submitter.
    const owner = await client.readContract({
      address: PAYMASTER,
      abi: vpmAbi,
      functionName: 'owner',
    });
    await rpc('anvil_impersonateAccount', [owner]);
    await fund(owner, '1');
    const ownerWallet = createWalletClient({ account: owner, chain, transport: http(ANVIL_URL) });
    for (const [functionName, args] of [
      ['setPendingVerifyingSigner', [signerKey.signer]],
      ['rotateVerifyingSigner', []],
      ['updateBundlerAllowlist', [submitterKey.signer, true]],
    ] as const)
      await client.waitForTransactionReceipt({
        hash: await ownerWallet.writeContract({
          address: PAYMASTER,
          abi: vpmAbi,
          functionName: functionName as never,
          args: args as never,
        }),
      });
    await fund(submitterKey.signer, '0.003'); // the approved float for one submitter

    const db = await database(t);
    await db.query(
      'INSERT INTO own_paymaster_keys (purpose, key_ref, address, created_at) VALUES ($1, $2, $3, 0), ($4, $5, $6, 0)',
      [
        'paymaster_signer',
        signerKey.keyRef,
        signerKey.signer.toLowerCase(),
        'paymaster_submitter_1',
        submitterKey.keyRef,
        submitterKey.signer.toLowerCase(),
      ],
    );
    const offset = Number((await client.getBlock()).timestamp) * 1000 - Date.now();
    const now = () => Date.now() + offset;
    const deposit = () =>
      client.readContract({
        address: ENTRY_POINT,
        abi: depositAbi,
        functionName: 'balanceOf',
        args: [PAYMASTER],
      });
    const budget = ownPaymasterBudget({
      now,
      db,
      deposit: async () => {
        const block = await client.getBlockNumber({ cacheTime: 0 });
        const wei = await client.readContract({
          address: ENTRY_POINT,
          abi: depositAbi,
          functionName: 'balanceOf',
          args: [PAYMASTER],
          blockNumber: block,
        });
        return { wei, block };
      },
    });
    const lines: string[] = [];
    const make = async () =>
      directBundler({
        db,
        client: client as never,
        chainId: BASE_MAINNET,
        entryPoint: ENTRY_POINT,
        mode: 'on',
        paymaster: PAYMASTER,
        keystore,
        signer: { keyRef: signerKey.keyRef, address: signerKey.signer },
        submitter: { keyRef: submitterKey.keyRef, address: submitterKey.signer },
        budget,
        policy: {
          addresses: {
            usdc: network.tokens.USDC.address,
            spendPermissionManager: network.contracts.spendPermissionManager,
            identityRegistry: network.contracts.identityRegistry!,
            reputationRegistry: network.contracts.reputationRegistry,
            smartWalletFactory: network.contracts.smartWalletFactory,
            feeRouters: [protocolDeployment(BASE_MAINNET)!.feeRouter as Address],
          },
        },
        log: (line) => lines.push(line),
        now,
      });
    const route = { db, chainId: BASE_MAINNET, entryPoint: ENTRY_POINT, paymaster: PAYMASTER };
    const cdp = recordingCdp();
    // One deployment's wiring, as runtime.ts builds it: in drain the flows' bundler is routes(cdp).
    const deployment = (newWork: 'direct' | 'cdp') => {
      const own = lazyBundler({
        make,
        fallback: cdp.bundler,
        route,
        newWork,
        now,
        log: (l) => lines.push(l),
      });
      const upkeep: OwnBundlerUpkeep = {
        mode: newWork === 'direct' ? 'direct' : 'drain',
        maintain: (limit) => own.maintain(limit),
        open: () => own.open(),
      };
      return { own, flows: newWork === 'direct' ? own : own.routes(cdp.bundler), upkeep };
    };
    const cron = async (upkeep: OwnBundlerUpkeep) => {
      const app = Fastify();
      registerOwnBundlerMaintainRoute(app, { cronSecret: SECRET, upkeep: async () => upkeep });
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/cron/own-paymaster-maintain',
          headers: { authorization: `Bearer ${SECRET}` },
        });
        return { status: res.statusCode, body: res.json() as Record<string, unknown> };
      } finally {
        await app.close();
      }
    };

    const recipe = spenderAccountRecipe(network, spenderKey.signer);
    const sender = deriveAddressLocal(recipe);
    const accountSigner = keystoreSigner(
      client as never,
      keystore,
      spenderKey.keyRef,
      spenderKey.signer,
      BASE_MAINNET,
    );
    const prepared = async (bundler: Bundler, uri: string, nonceKey: bigint) => {
      const calls = [
        {
          target: network.contracts.identityRegistry!,
          value: 0n,
          data: encodeFunctionData({ abi: identityAbi, functionName: 'register', args: [uri] }),
        },
      ];
      const { operation } = await prepareOperation(
        { network, client: client as never, bundler },
        { account: { address: sender, recipe }, calls, nonceKey, sponsorFlow: 'registration' },
      );
      return {
        ...operation,
        signature: await accountSigner.signUserOperation(operation, sender),
      } as UserOperation<'0.6'>;
    };
    const status = async (hash: string) =>
      (
        await db.query<{ status: string }>(
          'SELECT status FROM own_paymaster_reservations WHERE user_op_hash = $1',
          [hash.toLowerCase()],
        )
      ).rows[0]?.status;
    const sentCount = async () =>
      (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM own_paymaster_sends')).rows[0]!
        .n;

    // 1. Ours in effect: two sends (the first deploys the account), mined but not yet final, and a
    //    third operation prepared and sponsored by ours that is never sent before the switch.
    const before = deposit();
    const live = deployment('direct');
    const first = await prepared(live.flows, 'https://centralcity.ai/a/drain-1', 0n);
    const firstHash = await live.flows.send(first);
    await rpc('anvil_mine', ['0x1']);
    const second = await prepared(live.flows, 'https://centralcity.ai/a/drain-2', 1n);
    const secondHash = await live.flows.send(second);
    const draft = await prepared(live.flows, 'https://centralcity.ai/a/drain-draft', 2n);
    await rpc('anvil_mine', ['0x1']);
    assert.ok((await live.own.receipt(firstHash))?.success, lines.join('\n'));
    assert.ok((await live.own.receipt(secondHash))?.success, lines.join('\n'));
    assert.equal(await live.own.open(), 2);
    assert.deepEqual((await cron(live.upkeep)).body.state, 'on');
    assert.equal(await live.own.open(), 2, 'not final yet: still open');

    // 2. The switch: new work to CDP, ours keeps and follows what it holds.
    const drain = deployment('cdp');
    assert.deepEqual((await cron(drain.upkeep)).body, { state: 'drain', open: 2, looked: 2 });
    const newWork = await prepared(drain.flows, 'https://centralcity.ai/a/drain-new', 3n);
    assert.equal(newWork.paymasterAndData ?? '0x', '0x', 'not sponsored by ours');
    assert.deepEqual(
      cdp.calls.map((c) => c.method),
      ['prepare'],
    );
    // A rebroadcast of ours stays with ours (the stored send, no second transaction).
    assert.equal(await drain.flows.send(first), firstHash);
    assert.equal(await sentCount(), 2);
    // Our draft that was never sent is never first-sent while draining, and not declared never
    // broadcast either: its reservation is still open, and the older deployment may yet send it.
    const refused = await drain.flows.send(draft).catch((e: unknown) => e);
    assert.ok(
      refused instanceof BundlerError && !(refused instanceof NeverBroadcastError),
      String(refused),
    );
    assert.match((refused as Error).message, /still open/);
    assert.equal(await sentCount(), 2);
    // The older deployment (still warm, still direct) sends it during the switch...
    const draftHash = await live.flows.send(draft);
    await rpc('anvil_mine', ['0x1']);
    // ...and the draining one follows that send: same hash, no second transaction.
    assert.equal(await drain.flows.send(draft), draftHash);
    assert.equal(await sentCount(), 3);
    assert.ok((await drain.own.receipt(draftHash))?.success, lines.join('\n'));
    assert.ok(
      cdp.calls.every((c) => !c.paymasterAndData.toLowerCase().startsWith(PAYMASTER.toLowerCase())),
      'nothing of ours ever reached CDP',
    );

    // 3. A restart mid-drain: a fresh instance on the same database still drains all three.
    const restarted = deployment('cdp');
    assert.deepEqual((await cron(restarted.upkeep)).body, { state: 'drain', open: 3, looked: 3 });

    // 4. Final: past the fork's finalized depth the cron settles all three, then answers 'off'.
    await rpc('anvil_mine', ['0x50']);
    const settle = await cron(restarted.upkeep);
    assert.equal(settle.status, 200);
    assert.deepEqual(settle.body, { state: 'drain', open: 0, looked: 3 });
    assert.deepEqual((await cron(restarted.upkeep)).body, { state: 'off' });
    assert.equal(await status(firstHash), 'settled');
    assert.equal(await status(secondHash), 'settled');
    assert.equal(await status(draftHash), 'settled');
    const paid = (await before) - (await deposit());
    const settledCost = (
      await db.query<{ wei: string }>(
        'SELECT COALESCE(SUM(actual_cost_wei), 0)::text AS wei FROM own_paymaster_reservations WHERE user_op_hash = ANY($1::text[])',
        [[firstHash, secondHash, draftHash].map((h) => h.toLowerCase())],
      )
    ).rows[0]!.wei;
    assert.equal(paid, BigInt(settledCost), 'the deposit paid exactly what the three settled at');

    // 5. Switched back: ours takes new work again and finishes it.
    const back = deployment('direct');
    const resumed = await prepared(back.flows, 'https://centralcity.ai/a/drain-back', 4n);
    assert.ok((resumed.paymasterAndData ?? '0x').toLowerCase().startsWith(PAYMASTER.toLowerCase()));
    const resumedHash = await back.flows.send(resumed);
    await rpc('anvil_mine', ['0x1']);
    assert.ok((await back.own.receipt(resumedHash))?.success, lines.join('\n'));
    assert.equal(await back.own.open(), 1);
    console.log(
      `rehearsal: drained 3 sends to final (deposit paid ${paid} wei = settled), restart mid-drain OK, ` +
        `draft refused as still open then followed after the older deployment sent it, CDP saw ${cdp.calls.length} call(s) and none of ours, resumed ${resumedHash}`,
    );
  },
);
