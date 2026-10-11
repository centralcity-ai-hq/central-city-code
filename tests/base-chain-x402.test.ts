import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  pad,
  parseAbi,
  parseEther,
  toHex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { BASE_SEPOLIA, baseNetwork, type Address } from '../shared/base/chains.js';
import {
  createAccountCall,
  deriveAddressLocal,
  spenderAccountRecipe,
} from '../server/base/chain/derive.js';
import { createKeystore, parseKeks, type StoredSpenderKey } from '../server/base/chain/keystore.js';
import {
  AuthorizationError,
  authorizationNonce,
  signTransferAuthorization,
} from '../server/base/chain/x402.js';
import { startAtLowBaseFee } from './anvil-fees.js';

const network = baseNetwork(BASE_SEPOLIA)!;
const USDC = network.tokens.USDC.address;

test('authorization nonce: deterministic per intent, separated by chain, token, payer and intent', () => {
  const base = {
    chainId: BASE_SEPOLIA,
    token: USDC,
    payer: '0x1111111111111111111111111111111111111111' as Address,
    paymentIntentId: 'p-1',
  };
  assert.equal(authorizationNonce(base), authorizationNonce(base));
  for (const change of [
    { chainId: 8453 },
    { payer: '0x2222222222222222222222222222222222222222' as Address },
    { paymentIntentId: 'p-2' },
  ])
    assert.notEqual(authorizationNonce({ ...base, ...change }), authorizationNonce(base));
});

// On an Anvil fork of Base Sepolia, against the real USDC (FiatToken v2.2) contract; test USDC is
// written into the fork's storage (balances mapping, slot 9). Throwaway keys only.
//   anvil --fork-url https://sepolia.base.org --port 8546 ; CITY_BASE_ANVIL_URL=http://127.0.0.1:8546
const ANVIL_URL = process.env.CITY_BASE_ANVIL_URL;
test(
  'x402 leg B: the spender smart account authorizes, a third party settles, replay refused',
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
    const setBalance = (address: string) =>
      client.request({
        method: 'anvil_setBalance' as never,
        params: [address, `0x${parseEther('1').toString(16)}`] as never,
      });

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
    const payer = deriveAddressLocal(recipe);

    // Undeployed payer: refused before anything is signed (ERC-1271 needs code).
    const now = Number((await client.getBlock()).timestamp);
    const authorization = {
      from: payer,
      to: privateKeyToAccount(generatePrivateKey()).address,
      value: 1_500_000n, // 1.5 USDC
      validAfter: 0n,
      validBefore: BigInt(now + 600),
      nonce: authorizationNonce({
        chainId: BASE_SEPOLIA,
        token: USDC,
        payer,
        paymentIntentId: 'intent-1',
      }),
    };
    await assert.rejects(
      signTransferAuthorization({
        network,
        client,
        keystore,
        keyRef,
        token: USDC,
        authorization,
        now,
      }),
      (e: unknown) => e instanceof AuthorizationError && e.code === 'PAYER_NOT_DEPLOYED',
    );

    // Deploy the spender account and give it 10 test USDC on the fork.
    const deployer = privateKeyToAccount(generatePrivateKey());
    await setBalance(deployer.address);
    const wallet = createWalletClient({ account: deployer, chain, transport: http(ANVIL_URL) });
    const { abi, functionName, args } = createAccountCall(recipe);
    await client.waitForTransactionReceipt({
      hash: await wallet.writeContract({ address: recipe.factory, abi, functionName, args }),
    });
    const slot = keccak256(
      encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [payer, 9n]),
    );
    await client.request({
      method: 'anvil_setStorageAt' as never,
      params: [USDC, slot, pad(toHex(10_000_000n), { size: 32 })] as never,
    });

    const signature = await signTransferAuthorization({
      network,
      client,
      keystore,
      keyRef,
      token: USDC,
      authorization,
      now,
    });

    // A third party (the facilitator in x402) submits it; USDC verifies via ERC-1271.
    const usdc = parseAbi([
      'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
      'function balanceOf(address) view returns (uint256)',
      'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
    ]);
    const settle = () =>
      wallet.writeContract({
        address: USDC,
        abi: usdc,
        functionName: 'transferWithAuthorization',
        args: [
          authorization.from,
          authorization.to,
          authorization.value,
          authorization.validAfter,
          authorization.validBefore,
          authorization.nonce,
          signature,
        ],
      });
    await client.waitForTransactionReceipt({ hash: await settle() });
    assert.equal(
      await client.readContract({
        address: USDC,
        abi: usdc,
        functionName: 'balanceOf',
        args: [authorization.to],
      }),
      1_500_000n,
    );
    assert.equal(
      await client.readContract({
        address: USDC,
        abi: usdc,
        functionName: 'authorizationState',
        args: [payer, authorization.nonce],
      }),
      true,
    );

    // Replay of the same authorization is refused by the token.
    await assert.rejects(settle());

    // A tampered amount does not verify.
    await assert.rejects(
      wallet.writeContract({
        address: USDC,
        abi: usdc,
        functionName: 'transferWithAuthorization',
        args: [
          authorization.from,
          authorization.to,
          2_000_000n,
          authorization.validAfter,
          authorization.validBefore,
          authorizationNonce({
            chainId: BASE_SEPOLIA,
            token: USDC,
            payer,
            paymentIntentId: 'intent-2',
          }),
          signature,
        ],
      }),
    );
  },
);

test(
  'issued authorizations are frozen; cancellation blocks a later settle',
  { skip: !ANVIL_URL },
  async () => {
    const { issueTransferAuthorization, signCancelAuthorization } =
      await import('../server/base/chain/x402.js');
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
    const payer = deriveAddressLocal(recipe);
    const deployer = privateKeyToAccount(generatePrivateKey());
    await client.request({
      method: 'anvil_setBalance' as never,
      params: [deployer.address, `0x${parseEther('1').toString(16)}`] as never,
    });
    const wallet = createWalletClient({ account: deployer, chain, transport: http(ANVIL_URL) });
    const { abi, functionName, args } = createAccountCall(recipe);
    await client.waitForTransactionReceipt({
      hash: await wallet.writeContract({ address: recipe.factory, abi, functionName, args }),
    });
    const slot = keccak256(
      encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [payer, 9n]),
    );
    await client.request({
      method: 'anvil_setStorageAt' as never,
      params: [USDC, slot, pad(toHex(10_000_000n), { size: 32 })] as never,
    });

    const issued = new Map<string, import('../server/base/chain/x402.js').IssuedAuthorization>();
    const store = {
      get: async (id: string) => issued.get(id) ?? null,
      insert: async (row: import('../server/base/chain/x402.js').IssuedAuthorization) => {
        if (!issued.has(row.paymentIntentId)) issued.set(row.paymentIntentId, row);
        return issued.get(row.paymentIntentId)!;
      },
    };
    const now = Number((await client.getBlock()).timestamp);
    const recipient = privateKeyToAccount(generatePrivateKey()).address;
    const request = (validBefore: number) => ({
      network,
      client,
      keystore,
      keyRef,
      token: USDC,
      store,
      paymentIntentId: 'intent-9',
      now,
      authorization: {
        from: payer,
        to: recipient,
        value: 1_000_000n,
        validAfter: 0n,
        validBefore: BigInt(validBefore),
        nonce: '0x00' as `0x${string}`,
      },
    });
    const first = await issueTransferAuthorization(request(now + 600));
    // A retry, even with a different window asked for, returns the stored authorization unchanged.
    const again = await issueTransferAuthorization(request(now + 9_999));
    assert.deepEqual(again, first);
    // A different amount for the same intent is refused.
    await assert.rejects(
      issueTransferAuthorization({
        ...request(now + 600),
        authorization: { ...request(now + 600).authorization, value: 2n },
      }),
    );

    // Cancel the unused nonce on-chain, then the stored authorization can no longer settle.
    const usdc = parseAbi([
      'function cancelAuthorization(address authorizer, bytes32 nonce, bytes signature)',
      'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
      'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
    ]);
    const cancelSig = await signCancelAuthorization({
      network,
      keystore,
      keyRef,
      token: USDC,
      authorizer: payer,
      nonce: first.authorization.nonce,
    });
    await client.waitForTransactionReceipt({
      hash: await wallet.writeContract({
        address: USDC,
        abi: usdc,
        functionName: 'cancelAuthorization',
        args: [payer, first.authorization.nonce, cancelSig],
      }),
    });
    assert.equal(
      await client.readContract({
        address: USDC,
        abi: usdc,
        functionName: 'authorizationState',
        args: [payer, first.authorization.nonce],
      }),
      true,
    );
    const a = first.authorization;
    await assert.rejects(
      wallet.writeContract({
        address: USDC,
        abi: usdc,
        functionName: 'transferWithAuthorization',
        args: [a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, first.signature],
      }),
    );
  },
);
