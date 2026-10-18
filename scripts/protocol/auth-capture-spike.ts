/*
 * Operation Protocol P0-L1 spike: can a Central City spender smart account (Coinbase Smart Wallet,
 * ERC-1271) pay through the x402 auth-capture escrow, with the treasury taking exactly 10% in the
 * same transaction?
 *
 * Runs against a local Anvil fork of Base Sepolia (no real funds, throwaway keys made here and never
 * printed). Usage: anvil --fork-url https://sepolia.base.org --port 8546, then
 *   pnpm tsx scripts/protocol/auth-capture-spike.ts [rpcUrl] [--undeployed]
 * With --undeployed the payer account is not created first and signs with an ERC-6492 wrapper.
 */
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  getAddress,
  hashTypedData,
  http,
  keccak256,
  pad,
  parseAbi,
  toHex,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { BASE_NETWORKS } from '../../shared/base/chains.js';
import {
  deriveAddress,
  encodeOwners,
  spenderAccountRecipe,
} from '../../server/base/chain/derive.js';
import { ownerTypedData, walletSignature } from '../../server/base/chain/permissions.js';
import {
  paymentInfoHash,
  receiveAuthorization,
} from '../../server/protocol/fees/escrow-operator.js';

const RPC = process.argv.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:8546';
const UNDEPLOYED = process.argv.includes('--undeployed');

const ESCROW = '0xf96815976523E00e65Be8f34cA5e64b4f41EB19c' as const;
const COLLECTOR = '0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88' as const;
// --mainnet runs against a fork of Base mainnet (real "USD Coin" USDC and the deployed escrow);
// the default is a fork of Base Sepolia. Neither moves real funds: Anvil balances are set locally.
const MAINNET = process.argv.includes('--mainnet');
const CHAIN = MAINNET ? base : baseSepolia;
const CHAIN_ID = CHAIN.id;
const USDC = (
  MAINNET
    ? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    : '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
) as `0x${string}`;
const PRICE = 100_000n; // $0.10 in USDC units
const FEE = PRICE / 10n; // 10%

const escrowAbi = parseAbi([
  'struct PaymentInfo { address operator; address payer; address receiver; address token; uint120 maxAmount; uint48 preApprovalExpiry; uint48 authorizationExpiry; uint48 refundExpiry; uint16 minFeeBps; uint16 maxFeeBps; address feeReceiver; uint256 salt; }',
  'function charge(PaymentInfo paymentInfo, uint256 amount, address tokenCollector, bytes collectorData, uint256 feeAmount, address feeReceiver)',
  'function getHash(PaymentInfo paymentInfo) view returns (bytes32)',
  'event PaymentCharged(bytes32 indexed paymentInfoHash, PaymentInfo paymentInfo, uint256 amount, address tokenCollector, uint256 feeAmount, address feeReceiver)',
]);
const usdcAbi = parseAbi(['function balanceOf(address) view returns (uint256)']);
const factoryAbi = parseAbi([
  'function createAccount(bytes[] owners, uint256 nonce) payable returns (address)',
]);

async function main() {
  const network = BASE_NETWORKS[CHAIN_ID];
  if (!network) throw new Error('Base Sepolia network config missing.');
  const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) });
  const forkBlock = await pub.getBlockNumber();
  const test = createTestClient({ chain: CHAIN, transport: http(RPC), mode: 'anvil' });

  // Throwaway keys: the spender signer (owns the payer account) and the operator (submits the tx).
  const spender = privateKeyToAccount(generatePrivateKey());
  const operator = privateKeyToAccount(generatePrivateKey());
  const seller = privateKeyToAccount(generatePrivateKey()).address;
  const treasury = privateKeyToAccount(generatePrivateKey()).address;
  await test.setBalance({ address: operator.address, value: 10n ** 18n });
  const opWallet = createWalletClient({
    chain: CHAIN,
    transport: http(RPC),
    account: operator,
  });

  const recipe = spenderAccountRecipe(network, spender.address);
  const payer = await deriveAddress(pub, recipe);
  if (!UNDEPLOYED) {
    await pub.waitForTransactionReceipt({
      hash: await opWallet.writeContract({
        address: recipe.factory,
        abi: factoryAbi,
        functionName: 'createAccount',
        args: [encodeOwners(recipe.owners), recipe.index],
      }),
    });
  }
  const deployed = (await pub.getCode({ address: payer })) !== undefined;

  // Give the payer 1 USDC: FiatToken v2.2 keeps balances in mapping slot 9 (top bit = blacklist).
  const slot = keccak256(
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [payer, 9n]),
  );
  await test.setStorageAt({ address: USDC, index: slot, value: pad(toHex(1_000_000n)) });
  const usdcBefore = await pub.readContract({
    address: USDC,
    abi: usdcAbi,
    functionName: 'balanceOf',
    args: [payer],
  });
  if (usdcBefore !== 1_000_000n) throw new Error(`USDC balance slot guess wrong: ${usdcBefore}`);

  const now = BigInt((await pub.getBlock()).timestamp);
  const paymentInfo = {
    operator: operator.address,
    payer,
    receiver: seller,
    token: USDC,
    maxAmount: PRICE,
    preApprovalExpiry: Number(now + 600n),
    authorizationExpiry: Number(now + 3_600n),
    refundExpiry: Number(now + 7_200n),
    minFeeBps: 1_000,
    maxFeeBps: 1_000,
    feeReceiver: treasury,
    salt: BigInt(keccak256(toHex('cc.protocol.spike.' + now))),
  } as const;
  const escrowHash = await pub.readContract({
    address: ESCROW,
    abi: escrowAbi,
    functionName: 'getHash',
    args: [paymentInfo],
  });
  const localHashMatchesEscrow =
    escrowHash ===
    paymentInfoHash(CHAIN_ID, ESCROW, { ...paymentInfo, maxAmount: paymentInfo.maxAmount });
  const nonce = await pub.readContract({
    address: ESCROW,
    abi: escrowAbi,
    functionName: 'getHash',
    args: [{ ...paymentInfo, payer: '0x0000000000000000000000000000000000000000' }],
  });

  // The buyer's only signature: USDC ReceiveWithAuthorization to the collector, nonce = payer-agnostic hash.
  const hash = hashTypedData({
    // The production helper's domain for this chain ("USD Coin" on Base, "USDC" on Base Sepolia).
    domain: receiveAuthorization(CHAIN_ID, { ...paymentInfo, token: USDC }).domain,
    types: {
      ReceiveWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'ReceiveWithAuthorization',
    message: {
      from: payer,
      to: COLLECTOR,
      value: PRICE,
      validAfter: 0n,
      validBefore: BigInt(paymentInfo.preApprovalExpiry),
      nonce,
    },
  });
  const ownerSig = await spender.signTypedData(ownerTypedData(CHAIN_ID, payer, hash));
  const signature: Hex = walletSignature(ownerSig, {
    ownerIndex: 0,
    ...(deployed ? {} : { undeployedRecipe: recipe }),
  });

  // Negative cases first: each must revert and move nothing.
  const reverts = async (args: readonly unknown[], from: `0x${string}` = operator.address) => {
    try {
      await pub.simulateContract({
        account: from,
        address: ESCROW,
        abi: escrowAbi,
        functionName: 'charge',
        args: args as never,
      });
      return false;
    } catch {
      return true;
    }
  };
  const other = privateKeyToAccount(generatePrivateKey());
  const wrongSig = walletSignature(
    await other.signTypedData(ownerTypedData(CHAIN_ID, payer, hash)),
    {
      ownerIndex: 0,
      ...(deployed ? {} : { undeployedRecipe: recipe }),
    },
  );
  const negative: Record<string, boolean> = {
    feeBelowTenPercent: await reverts([
      paymentInfo,
      PRICE,
      COLLECTOR,
      signature,
      FEE - 1n,
      treasury,
    ]),
    feeAboveTenPercent: await reverts([
      paymentInfo,
      PRICE,
      COLLECTOR,
      signature,
      FEE + 1n,
      treasury,
    ]),
    feeToAnotherReceiver: await reverts([
      paymentInfo,
      PRICE,
      COLLECTOR,
      signature,
      FEE,
      other.address,
    ]),
    sellerSwappedAfterSigning: await reverts([
      { ...paymentInfo, receiver: other.address },
      PRICE,
      COLLECTOR,
      signature,
      FEE,
      treasury,
    ]),
    feeReceiverSwappedAfterSigning: await reverts([
      { ...paymentInfo, feeReceiver: other.address },
      PRICE,
      COLLECTOR,
      signature,
      FEE,
      other.address,
    ]),
    feeBoundsLoweredAfterSigning: await reverts([
      { ...paymentInfo, minFeeBps: 0, maxFeeBps: 0 },
      PRICE,
      COLLECTOR,
      signature,
      0n,
      treasury,
    ]),
    signedByAnotherKey: await reverts([paymentInfo, PRICE, COLLECTOR, wrongSig, FEE, treasury]),
    notTheOperator: await reverts(
      [paymentInfo, PRICE, COLLECTOR, signature, FEE, treasury],
      other.address,
    ),
  };

  const txHash = await opWallet.writeContract({
    address: ESCROW,
    abi: escrowAbi,
    functionName: 'charge',
    args: [paymentInfo, PRICE, COLLECTOR, signature, FEE, treasury],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
  const bal = (a: `0x${string}`) =>
    pub.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [a] });
  const [sellerBal, treasuryBal, payerBal] = await Promise.all([
    bal(seller),
    bal(treasury),
    bal(payer),
  ]);
  const charged = receipt.logs.some(
    (l) =>
      getAddress(l.address) === getAddress(ESCROW) &&
      l.topics[0] ===
        keccak256(
          toHex(
            'PaymentCharged(bytes32,(address,address,address,address,uint120,uint48,uint48,uint48,uint16,uint16,address,uint256),uint256,address,uint256,address)',
          ),
        ),
  );
  negative.replayAfterCharge = await reverts([
    paymentInfo,
    PRICE,
    COLLECTOR,
    signature,
    FEE,
    treasury,
  ]);
  const allNegativeReverted = Object.values(negative).every(Boolean);
  const codeHash = async (address: `0x${string}`) =>
    keccak256((await pub.getCode({ address })) ?? '0x');
  const ok =
    localHashMatchesEscrow &&
    allNegativeReverted &&
    charged &&
    receipt.status === 'success' &&
    sellerBal === PRICE - FEE &&
    treasuryBal === FEE &&
    payerBal === 1_000_000n - PRICE;
  console.log(
    JSON.stringify(
      {
        result: ok ? 'PASS' : 'FAIL',
        forkBlock: forkBlock.toString(),
        codeHashes: {
          escrow: await codeHash(ESCROW),
          erc3009Collector: await codeHash(COLLECTOR),
          usdc: await codeHash(USDC),
          smartWalletFactory: await codeHash(recipe.factory),
        },
        localHashMatchesEscrow,
        negativeCasesReverted: negative,
        payerDeployedBeforePay: deployed,
        status: receipt.status,
        gasUsed: receipt.gasUsed.toString(),
        paymentChargedEvent: charged,
        seller: sellerBal.toString(),
        treasury: treasuryBal.toString(),
        payerLeft: payerBal.toString(),
      },
      null,
      2,
    ),
  );
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error('SPIKE ERROR', String(e?.shortMessage ?? e?.message ?? e).slice(0, 600));
  process.exit(1);
});
