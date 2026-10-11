import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicClient, createWalletClient, http, parseAbi, parseEther, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { BASE_SEPOLIA, NATIVE_ETH, baseNetwork } from '../shared/base/chains.js';
import {
  agentWalletRecipe,
  deriveAddress,
  deriveAgentWallets,
  spenderAccountRecipe,
  createAccountCall,
} from '../server/base/chain/derive.js';
import {
  checkPermission,
  firstSpendCalls,
  nonRenewing,
  ownerTypedData,
  permissionHash,
  spendPermissionManagerAbi,
  walletSignature,
} from '../server/base/chain/permissions.js';
import { startAtLowBaseFee } from './anvil-fees.js';

const network = baseNetwork(BASE_SEPOLIA)!;
const owner = '0x1111111111111111111111111111111111111111';

test('agent wallet recipe: owner key first, then SpendPermissionManager', () => {
  const recipe = agentWalletRecipe(network, owner, 7n);
  assert.deepEqual(recipe.owners, [owner, network.contracts.spendPermissionManager]);
  assert.equal(recipe.factory, network.contracts.smartWalletFactory);
  assert.equal(recipe.index, 7n);
  assert.throws(() => agentWalletRecipe(network, owner, -1n));
});

test('spender account recipe has the spender signer as its only owner', () => {
  assert.deepEqual(spenderAccountRecipe(network, owner).owners, [owner]);
});

test('permission checks refuse out-of-range and inverted windows', () => {
  const base = {
    account: owner,
    spender: owner,
    token: NATIVE_ETH,
    allowance: 1n,
    start: 100,
    end: 200,
    salt: 0n,
    extraData: '0x' as Hex,
  } as const;
  const ok = nonRenewing(base);
  assert.equal(ok.period, 100);
  checkPermission(ok);
  assert.throws(() => checkPermission({ ...ok, allowance: 0n }));
  assert.throws(() => checkPermission({ ...ok, end: 100 }));
  assert.throws(() => checkPermission({ ...ok, period: 0 }));
  assert.throws(() => checkPermission({ ...ok, start: 2 ** 48 }));
  assert.throws(() => firstSpendCalls(network, ok, '0x', 2n), /out of range/);
});

test('ERC-6492 wrapping only for undeployed wallets', () => {
  const recipe = agentWalletRecipe(network, owner, 0n);
  const plain = walletSignature('0x1234', { ownerIndex: 0 });
  const wrapped = walletSignature('0x1234', { ownerIndex: 0, undeployedRecipe: recipe });
  assert.ok(!plain.endsWith('6492649264926492649264926492649264926492649264926492649264926492'));
  assert.ok(wrapped.endsWith('6492649264926492649264926492649264926492649264926492649264926492'));
});

// Full lazy-approval flow against a local Anvil fork of Base Sepolia:
//   anvil --fork-url https://sepolia.base.org --port 8546 ; CITY_BASE_ANVIL_URL=http://127.0.0.1:8546
// Throwaway keys and Anvil-only test ETH; never runs against a public network.
const ANVIL_URL = process.env.CITY_BASE_ANVIL_URL;
test(
  'lazy approval on Anvil: sign off-chain, deploy + approve + spend at first spend',
  { skip: !ANVIL_URL },
  async () => {
    const chain = {
      id: BASE_SEPOLIA,
      name: 'anvil-fork',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [ANVIL_URL!] } },
    } as const;
    const client = createPublicClient({ chain, transport: http(ANVIL_URL) });
    assert.equal(await client.getChainId(), BASE_SEPOLIA, 'expects a fork of Base Sepolia');
    await startAtLowBaseFee(client);
    const ownerAccount = privateKeyToAccount(generatePrivateKey());
    const spenderSigner = privateKeyToAccount(generatePrivateKey());

    const [agent] = deriveAgentWallets(network, ownerAccount.address, [0n]);
    const spenderRecipe = spenderAccountRecipe(network, spenderSigner.address);
    const spenderAccount = await deriveAddress(client, spenderRecipe);
    assert.equal(
      await client.getCode({ address: agent.address }),
      undefined,
      'wallet is counterfactual',
    );

    const setBalance = (address: string) =>
      client.request({
        method: 'anvil_setBalance' as never,
        params: [address, `0x${parseEther('1').toString(16)}`] as never,
      });
    await setBalance(agent.address);
    await setBalance(spenderSigner.address);

    const now = Number((await client.getBlock()).timestamp);
    const permission = nonRenewing({
      account: agent.address,
      spender: spenderAccount,
      token: NATIVE_ETH,
      allowance: parseEther('0.02'),
      start: now,
      end: now + 3600,
      salt: 1n,
      extraData: '0x',
    });
    const hash = await permissionHash(client, network, permission);
    const raw = await ownerAccount.signTypedData(ownerTypedData(BASE_SEPOLIA, agent.address, hash));
    const signature = walletSignature(raw, { ownerIndex: 0, undeployedRecipe: agent.recipe });

    const wallet = createWalletClient({
      account: spenderSigner,
      chain,
      transport: http(ANVIL_URL),
    });
    const { abi, functionName, args } = createAccountCall(spenderRecipe);
    await client.waitForTransactionReceipt({
      hash: await wallet.writeContract({ address: spenderRecipe.factory, abi, functionName, args }),
    });
    // Direct owner calls one by one; in production both calls go in one sponsored UserOp.
    const executeAbi = parseAbi([
      'function execute(address target, uint256 value, bytes data) payable',
    ]);
    for (const call of firstSpendCalls(network, permission, signature, parseEther('0.005'))) {
      const receipt = await client.waitForTransactionReceipt({
        hash: await wallet.writeContract({
          address: spenderAccount,
          abi: executeAbi,
          functionName: 'execute',
          args: [call.target, call.value, call.data],
        }),
      });
      assert.equal(receipt.status, 'success');
    }
    assert.notEqual(
      await client.getCode({ address: agent.address }),
      undefined,
      'deployed at first spend',
    );
    assert.equal(
      await client.readContract({
        address: network.contracts.spendPermissionManager,
        abi: spendPermissionManagerAbi,
        functionName: 'isApproved',
        args: [permission],
      }),
      true,
    );
    assert.equal(await client.getBalance({ address: spenderAccount }), parseEther('0.005'));

    // Over the allowance: refused on-chain.
    const over = firstSpendCalls(network, permission, signature, parseEther('0.02'))[1];
    await assert.rejects(
      wallet.writeContract({
        address: spenderAccount,
        abi: executeAbi,
        functionName: 'execute',
        args: [over.target, over.value, over.data],
      }),
    );
  },
);
