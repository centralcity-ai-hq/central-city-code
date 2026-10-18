import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  pad,
  parseAbi,
  parseEther,
  toHex,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { BASE_SEPOLIA, baseNetwork, type Address } from '../shared/base/chains.js';
import {
  createAccountCall,
  deriveAddressLocal,
  spenderAccountRecipe,
} from '../server/base/chain/derive.js';
import { createFeedPayChain } from '../server/base/chain/feed-pay-chain.js';
import { createKeystore, parseKeks, type StoredSpenderKey } from '../server/base/chain/keystore.js';
import { signCancelAuthorization, type IssuedAuthorization } from '../server/base/chain/x402.js';
import type { Database } from '../server/database.js';
import { paymentHeader } from '../server/feed/pay/x402-buyer.js';
import { acceptOption } from './helpers/fake-x402-service.js';
import { startAtLowBaseFee } from './anvil-fees.js';

/*
 * Feed pay's real payment path on an Anvil fork of Base Sepolia (skipped without
 * CITY_BASE_ANVIL_URL): the spender smart account signs the EIP-3009 authorization (ERC-1271)
 * through the engine's chain side, the payment header carries exactly what a facilitator submits,
 * a third party settles it on the real USDC (FiatToken v2.2), and the engine reads Base's word:
 * used, cancelled, or unused past validBefore. Throwaway keys, fork-only test funds.
 *   anvil --fork-url https://sepolia.base.org --port 8546 ; CITY_BASE_ANVIL_URL=http://127.0.0.1:8546
 */

const ANVIL_URL = process.env.CITY_BASE_ANVIL_URL;
const network = baseNetwork(BASE_SEPOLIA)!;
const USDC = network.tokens.USDC.address;
const usdcAbi = parseAbi([
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
  'function cancelAuthorization(address authorizer, bytes32 nonce, bytes signature)',
  'function balanceOf(address) view returns (uint256)',
]);

test(
  'feed pay on a fork: issue, header, settle by a third party, then used, cancelled or expired',
  { skip: !ANVIL_URL },
  async () => {
    const chain = {
      id: BASE_SEPOLIA,
      name: 'anvil-fork',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [ANVIL_URL!] } },
    } as const;
    const client = createPublicClient({ chain, transport: http(ANVIL_URL) });
    await startAtLowBaseFee(client);
    const rows = new Map<string, StoredSpenderKey>();
    const keystore = createKeystore({
      store: {
        insert: async (row) => void rows.set(row.keyId, row),
        get: async (id) => rows.get(id) ?? null,
      },
      keks: parseKeks(`v1:${randomBytes(32).toString('base64')}`),
    });
    const { signer, keyRef } = await keystore.createSpenderKey();
    const recipe = spenderAccountRecipe(network, signer);
    const spender = deriveAddressLocal(recipe);

    // Deploy the spender account (a float top-up does this in production) and fund it.
    const facilitator = privateKeyToAccount(generatePrivateKey());
    await client.request({
      method: 'anvil_setBalance' as never,
      params: [facilitator.address, `0x${parseEther('1').toString(16)}`] as never,
    });
    const wallet = createWalletClient({ account: facilitator, chain, transport: http(ANVIL_URL) });
    const { abi, functionName, args } = createAccountCall(recipe);
    await client.waitForTransactionReceipt({
      hash: await wallet.writeContract({ address: recipe.factory, abi, functionName, args }),
    });
    const slot = keccak256(
      encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [spender, 9n]),
    );
    await client.request({
      method: 'anvil_setStorageAt' as never,
      params: [USDC, slot, pad(toHex(1_000_000n), { size: 32 })] as never,
    });

    let clock = Number((await client.getBlock()).timestamp) * 1000;
    const issued = new Map<string, IssuedAuthorization>();
    const port = createFeedPayChain({
      network,
      client,
      db: {} as Database,
      operations: {} as never,
      bundler: {} as never,
      keystore,
      signerOf: async () => signer,
      ledger: {} as never,
      usdcBalance: async (address: Address) => ({
        balance: await client.readContract({
          address: USDC,
          abi: usdcAbi,
          functionName: 'balanceOf',
          args: [address],
        }),
        blockNumber: await client.getBlockNumber({ cacheTime: 0 }),
      }),
      authorizations: {
        get: async (id) => issued.get(id) ?? null,
        insert: async (row) => {
          if (!issued.has(row.paymentIntentId)) issued.set(row.paymentIntentId, row);
          return issued.get(row.paymentIntentId)!;
        },
      },
      now: () => clock,
    });
    const ref = { walletId: 'w', address: spender, spender, spenderKeyRef: keyRef };
    const payee = privateKeyToAccount(generatePrivateKey()).address;
    const fromBlock = await client.getBlockNumber({ cacheTime: 0 });
    const nowS = Math.floor(clock / 1000);
    const issue = (paymentId: string) =>
      port.issue({
        paymentId,
        wallet: ref,
        to: payee,
        value: 20_000n,
        validAfter: BigInt(nowS - 60),
        validBefore: BigInt(nowS + 120),
      });

    // 1. Issued once (a retry is the same authorization), carried in the v2 header, settled.
    const first = await issue('payment-1');
    assert.deepEqual(await issue('payment-1'), first);
    const header = paymentHeader({
      x402Version: 2,
      option: acceptOption({
        payTo: payee,
        amount: '20000',
        network: `eip155:${BASE_SEPOLIA}`,
        asset: USDC,
      }),
      resource: { url: 'https://service.example/' },
      payload: {
        signature: first.signature,
        authorization: {
          from: getAddress(first.authorization.from) as Address,
          to: getAddress(first.authorization.to) as Address,
          value: first.authorization.value.toString(10),
          validAfter: first.authorization.validAfter.toString(10),
          validBefore: first.authorization.validBefore.toString(10),
          nonce: first.authorization.nonce,
        },
      },
    });
    const sent = JSON.parse(Buffer.from(header.value, 'base64').toString()) as {
      payload: { signature: Hex; authorization: Record<string, string> };
    };
    const a = sent.payload.authorization;
    const settleTx = await wallet.writeContract({
      address: USDC,
      abi: usdcAbi,
      functionName: 'transferWithAuthorization',
      args: [
        a.from as Address,
        a.to as Address,
        BigInt(a.value!),
        BigInt(a.validAfter!),
        BigInt(a.validBefore!),
        a.nonce as Hex,
        sent.payload.signature,
      ],
    });
    await client.waitForTransactionReceipt({ hash: settleTx });
    assert.equal(
      await client.readContract({
        address: USDC,
        abi: usdcAbi,
        functionName: 'balanceOf',
        args: [payee],
      }),
      20_000n,
    );
    const used = await port.outcome({
      payer: spender,
      nonce: first.authorization.nonce,
      fromBlock,
      validBefore: Number(first.authorization.validBefore),
      claimedTx: settleTx,
    });
    assert.equal(used.kind, 'used');
    if (used.kind === 'used') assert.equal(used.txHash.toLowerCase(), settleTx.toLowerCase());
    // Found by the event search alone too (a service that names no transaction).
    const searched = await port.outcome({
      payer: spender,
      nonce: first.authorization.nonce,
      fromBlock,
      validBefore: Number(first.authorization.validBefore),
      claimedTx: null,
    });
    assert.equal(searched.kind, 'used');

    // 2. Cancelled before the service used it: Base says canceled, a late settle reverts.
    const second = await issue('payment-2');
    const cancelSig = await signCancelAuthorization({
      network,
      keystore,
      keyRef,
      token: USDC,
      authorizer: spender,
      nonce: second.authorization.nonce,
    });
    await client.waitForTransactionReceipt({
      hash: await wallet.writeContract({
        address: USDC,
        abi: usdcAbi,
        functionName: 'cancelAuthorization',
        args: [spender, second.authorization.nonce, cancelSig],
      }),
    });
    const canceled = await port.outcome({
      payer: spender,
      nonce: second.authorization.nonce,
      fromBlock,
      validBefore: Number(second.authorization.validBefore),
      claimedTx: null,
    });
    assert.equal(canceled.kind, 'canceled');

    // 3. Never used: pending until a settled block is past validBefore, then expired.
    const third = await issue('payment-3');
    const pending = await port.outcome({
      payer: spender,
      nonce: third.authorization.nonce,
      fromBlock,
      validBefore: Number(third.authorization.validBefore),
      claimedTx: null,
    });
    assert.equal(pending.kind, 'pending');
    await client.request({ method: 'evm_increaseTime' as never, params: [300] as never });
    await client.request({ method: 'evm_mine' as never, params: [] as never });
    clock += 300_000;
    const expired = await port.outcome({
      payer: spender,
      nonce: third.authorization.nonce,
      fromBlock,
      validBefore: Number(third.authorization.validBefore),
      claimedTx: null,
    });
    assert.equal(expired.kind, 'expired');
  },
);
