import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseAbi,
  parseEther,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
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
  exposureKey,
} from '../server/base/chain/direct-bundler.js';
import {
  OWN_PAYMASTER_BUDGET_SQL,
  ownPaymasterBudget,
} from '../server/base/chain/own-paymaster-budget.js';
import {
  encodeAccountCalls,
  keystoreSigner,
  prepareOperation,
} from '../server/base/chain/submit.js';
import { startAtLowBaseFee } from './anvil-fees.js';

/*
 * Operation Paymaster end to end on an Anvil fork of Base MAINNET (skipped without
 * CITY_BASE_MAINNET_ANVIL_URL): the REAL VerifyingPaymaster bytecode (Coinbase's live instance,
 * whose signer and bundler allowlist this fork-only test takes over by impersonating its owner),
 * the real EntryPoint v0.6, Coinbase Smart Wallet factory and ERC-8004 identity registry. A
 * spender account is created and registers an agent in ONE sponsored operation through our
 * direct bundler; then the security negative cases. Throwaway keys, fork-only test funds.
 *   anvil --fork-url https://mainnet.base.org --port 8547 ; CITY_BASE_MAINNET_ANVIL_URL=http://127.0.0.1:8547
 */

const ANVIL_URL = process.env.CITY_BASE_MAINNET_ANVIL_URL;
const network = BASE_NETWORKS[BASE_MAINNET];
const ENTRY_POINT = network.contracts.entryPointV06;
const PAYMASTER = '0x2FAEB0760D4230Ef2aC21496Bb4F0b47D634FD4c' as const;
const vpmAbi = parseAbi([
  'function owner() view returns (address)',
  'function setPendingVerifyingSigner(address signer)',
  'function rotateVerifyingSigner()',
  'function updateBundlerAllowlist(address bundler, bool allowed)',
  'function verifyingSigner() view returns (address)',
]);
const identityAbi = parseAbi([
  'function register(string tokenURI)',
  'function balanceOf(address owner) view returns (uint256)',
]);
const entryPointAbi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'struct UserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; uint256 callGasLimit; uint256 verificationGasLimit; uint256 preVerificationGas; uint256 maxFeePerGas; uint256 maxPriorityFeePerGas; bytes paymasterAndData; bytes signature; }',
  'function handleOps(UserOperation[] ops, address beneficiary)',
]);
const toRpcHandleOps = (op: UserOperation<'0.6'>, beneficiary: Address) =>
  encodeFunctionData({
    abi: entryPointAbi,
    functionName: 'handleOps',
    args: [
      [{ ...op, initCode: op.initCode ?? '0x', paymasterAndData: op.paymasterAndData ?? '0x' }],
      beneficiary,
    ],
  });

async function database(t: { after: (fn: () => Promise<unknown>) => void }) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
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

test(
  'fork: real VerifyingPaymaster sponsors a new account registering an agent; negative cases refused',
  { skip: !ANVIL_URL, timeout: 180_000 },
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

    // Keys: our verifying signer, submitter 1, and the agent's spender, in a real keystore.
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
    assert.equal(
      await client.readContract({
        address: PAYMASTER,
        abi: vpmAbi,
        functionName: 'verifyingSigner',
      }),
      signerKey.signer,
    );
    await fund(submitterKey.signer, '0.003'); // the approved float for one submitter

    const db = await database(t);
    // The fork's own clock (a shared fork may have been moved ahead by an earlier run).
    const offset = Number((await client.getBlock()).timestamp) * 1000 - Date.now();
    const now = () => Date.now() + offset;
    const budget = ownPaymasterBudget({
      now,
      db,
      deposit: async () => {
        const block = await client.getBlockNumber({ cacheTime: 0 });
        const wei = await client.readContract({
          address: ENTRY_POINT,
          abi: entryPointAbi,
          functionName: 'balanceOf',
          args: [PAYMASTER],
          blockNumber: block,
        });
        return { wei, block };
      },
    });
    const lines: string[] = [];
    const bundler = directBundler({
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
    assert.equal(await bundler.readiness(), 'ready');

    const recipe = spenderAccountRecipe(network, spenderKey.signer);
    const sender = deriveAddressLocal(recipe);
    const register = (uri: string) => ({
      target: network.contracts.identityRegistry!,
      value: 0n,
      data: encodeFunctionData({ abi: identityAbi, functionName: 'register', args: [uri] }),
    });
    const accountSigner = keystoreSigner(
      client as never,
      keystore,
      spenderKey.keyRef,
      spenderKey.signer,
      BASE_MAINNET,
    );
    const prepared = async (uri: string, nonceKey: bigint) => {
      const calls = [register(uri)];
      const { operation } = await prepareOperation(
        { network, client: client as never, bundler },
        { account: { address: sender, recipe }, calls, nonceKey, sponsorFlow: 'registration' },
      );
      return {
        ...operation,
        signature: await accountSigner.signUserOperation(operation, sender),
      } as UserOperation<'0.6'>;
    };

    // 1. A new account (initCode) registers an agent in one sponsored operation.
    const depositBefore = await client.readContract({
      address: ENTRY_POINT,
      abi: entryPointAbi,
      functionName: 'balanceOf',
      args: [PAYMASTER],
    });
    const submitterBefore = await client.getBalance({ address: submitterKey.signer });
    const first = await prepared('https://centralcity.ai/a/fork-1', 0n);
    assert.notEqual(first.initCode, '0x');
    const hash = await bundler.send(first);
    // Polled, as the submit module's reconciliation does.
    let receipt = await bundler.receipt(hash);
    for (let i = 0; !receipt && i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      receipt = await bundler.receipt(hash);
    }
    assert.equal(receipt?.success, true, lines.join('\n'));
    assert.equal(
      await client.readContract({
        address: network.contracts.identityRegistry!,
        abi: identityAbi,
        functionName: 'balanceOf',
        args: [sender],
      }),
      1n,
    );
    // Settled only once its receipt is final: until then the worst case stays
    // reserved. The fork's finalized tag trails latest by 64 blocks: mine past it, then maintain.
    const pendingRow = await db.query<{ status: string }>(
      'SELECT status FROM own_paymaster_reservations WHERE user_op_hash = $1',
      [hash.toLowerCase()],
    );
    assert.equal(pendingRow.rows[0]!.status, 'sent');
    await rpc('anvil_mine', ['0x50']);
    await bundler.maintain();
    const depositAfter = await client.readContract({
      address: ENTRY_POINT,
      abi: entryPointAbi,
      functionName: 'balanceOf',
      args: [PAYMASTER],
    });
    // The deposit paid exactly the operation's actualGasCost; the reservation settled at it.
    assert.equal(depositBefore - depositAfter, receipt!.actualGasCost);
    const settled = await db.query<{ status: string; actual: string; max: string }>(
      `SELECT status, actual_cost_wei::text AS actual, max_cost_wei::text AS max
       FROM own_paymaster_reservations WHERE user_op_hash = $1`,
      [hash.toLowerCase()],
    );
    assert.equal(settled.rows[0]!.status, 'settled');
    assert.equal(BigInt(settled.rows[0]!.actual), receipt!.actualGasCost);
    assert.ok(BigInt(settled.rows[0]!.max) >= receipt!.actualGasCost);
    // The submitter was paid back by the EntryPoint (beneficiary): its loss (if any) is what its
    // exposure reservation settled at (measured overhead), never more.
    const submitterAfter = await client.getBalance({ address: submitterKey.signer });
    const overhead = await db.query<{ wei: string }>(
      "SELECT actual_cost_wei::text AS wei FROM own_paymaster_reservations WHERE user_op_hash = $1 AND status = 'settled'",
      [exposureKey(hash)],
    );
    const loss = submitterBefore - submitterAfter;
    assert.ok(
      loss <= BigInt(overhead.rows[0]!.wei) + 1n,
      `loss ${loss} vs overhead ${overhead.rows[0]!.wei}`,
    );
    console.log(
      `fork: actualGasCost=${receipt!.actualGasCost} wei, submitter net=${-loss} wei, overhead=${overhead.rows[0]!.wei} wei, tx=${receipt!.txHash}, submitter=${submitterKey.signer}`,
    );

    // 2. Replay: the same operation again is the stored one, never a second transaction.
    assert.equal(await bundler.send(first), hash);
    const sends = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM own_paymaster_sends',
    );
    assert.equal(sends.rows[0]!.n, 1);

    // 3. Tampered after the paymaster signed (other calls, re-signed by the account): AA34.
    const second = await prepared('https://centralcity.ai/a/fork-2', 1n);
    const tampered = {
      ...second,
      callData: await encodeAccountCalls(client as never, [register('https://evil.example/x')]),
    };
    tampered.signature = await accountSigner.signUserOperation(tampered, sender);
    await assert.rejects(bundler.send(tampered), /AA34/);

    // 4. A foreign bundler cannot spend our deposit with a valid sponsorship (allowlist, postOp).
    const stranger = privateKeyToAccount(generatePrivateKey());
    await fund(stranger.address, '0.01');
    await assert.rejects(
      client.estimateGas({
        account: stranger.address,
        to: ENTRY_POINT,
        data: toRpcHandleOps(second, stranger.address),
      }),
    );

    // Fixture for the canary report, no live spend: TWO of our sponsored
    // operations in ONE handleOps, whose beneficiary is NOT the submitter, sent by hand from the
    // allowlisted submitter (not through our bundler) at the operations' own fees.
    const multiA = await prepared('https://centralcity.ai/a/fork-multi-a', 2n);
    const multiB = await prepared('https://centralcity.ai/a/fork-multi-b', 3n);
    const thirdParty = privateKeyToAccount(generatePrivateKey()).address;
    const multiData = encodeFunctionData({
      abi: entryPointAbi,
      functionName: 'handleOps',
      args: [
        [multiA, multiB].map((op) => ({
          ...op,
          initCode: op.initCode ?? '0x',
          paymasterAndData: op.paymasterAndData ?? '0x',
        })),
        thirdParty,
      ],
    });
    const multiGas = await client.estimateGas({
      account: submitterKey.signer,
      to: ENTRY_POINT,
      data: multiData,
    });
    const multiHash = await keystore.withSigner(submitterKey.keyRef, async (account) =>
      client.sendRawTransaction({
        serializedTransaction: await account.signTransaction({
          type: 'eip1559',
          chainId: BASE_MAINNET,
          nonce: await client.getTransactionCount({
            address: account.address,
            blockTag: 'pending',
          }),
          to: ENTRY_POINT,
          value: 0n,
          data: multiData,
          gas: (multiGas * 13n) / 10n,
          maxFeePerGas: multiA.maxFeePerGas,
          maxPriorityFeePerGas: multiA.maxPriorityFeePerGas,
        }),
      }),
    );
    const multiReceipt = await client.waitForTransactionReceipt({ hash: multiHash });
    assert.equal(multiReceipt.status, 'success');
    const userOpEvents = multiReceipt.logs.filter(
      (log) =>
        log.address.toLowerCase() === ENTRY_POINT.toLowerCase() &&
        log.topics[0] === '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f',
    );
    assert.equal(userOpEvents.length, 2);
    console.log(
      `fixture-multi: tx=${multiHash}, beneficiary=${thirdParty}, submitter=${submitterKey.signer}`,
    );

    // 5. Expired: past validUntil the EntryPoint refuses it (AA32), nothing is sent.
    await rpc('evm_increaseTime', [60 * 60]);
    await rpc('evm_mine', []);
    await assert.rejects(bundler.send(second), /AA32/);
    const after = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM own_paymaster_sends',
    );
    assert.equal(after.rows[0]!.n, 1);
  },
);
