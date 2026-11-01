/*
 * Proves Central City's money path on Arc TESTNET with real transactions, throwaway keys and free
 * test USDC, using the repo's own code wherever it exists: the router-3 nonce and settlement encoding
 * (feed/pay/router3.ts), the EIP-3009 typed data and smart-account signature (chain/x402.ts), the
 * direct bundler, budget and policy on an in-memory PGlite (chain/direct-bundler.ts), account
 * derivation (chain/derive.ts), operation preparing and signing (chain/submit.ts), and spend
 * permissions (chain/permissions.ts).
 *
 *   ARC_TESTNET_KEYS_DIR=<folder outside the repo> npx tsx scripts/arc/testnet-e2e.ts <step>
 *
 * Steps: observe, usdc, router, account, permission, withdraw, smart-settle, facilitator, batch,
 * fees, finality. The node's chain id is checked first; anything but 5042002 stops the script. Run
 * deploy-testnet.ts before.
 */
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import {
  domainSeparator,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  parseEventLogs,
  stringToHex,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import type { UserOperation } from 'viem/account-abstraction';
import type { PrivateKeyAccount } from 'viem/accounts';
import type { Database } from '../../server/database.js';
import { chainNetwork, usdcOf } from '../../shared/chains.js';
import { ARC_TESTNET } from '../../shared/chains.js';
import {
  agentWalletRecipe,
  deriveAddress,
  deriveAddressLocal,
  spenderAccountRecipe,
} from '../../server/base/chain/derive.js';
import {
  DIRECT_BUNDLER_FINALITY_SQL,
  DIRECT_BUNDLER_SQL,
  directBundler,
} from '../../server/base/chain/direct-bundler.js';
import type { Keystore } from '../../server/base/chain/keystore.js';
import {
  OWN_PAYMASTER_ATTRIBUTION_SQL,
  OWN_PAYMASTER_BUDGET_CHAIN_SQL,
  OWN_PAYMASTER_BUDGET_SQL,
  OWN_PAYMASTER_RESERVATIONS_CHAIN_SQL,
  ownPaymasterBudget,
} from '../../server/base/chain/own-paymaster-budget.js';
import { chainParams } from '../../server/base/chain/chain-params.js';
import {
  firstSpendCalls,
  nonRenewing,
  ownerTypedData,
  permissionHash,
  spendPermissionManagerAbi,
  walletSignature,
} from '../../server/base/chain/permissions.js';
import { keystoreSigner, prepareOperation, type Call } from '../../server/base/chain/submit.js';
import {
  signTransferAuthorization,
  transferAuthorizationTypedData,
} from '../../server/base/chain/x402.js';
import {
  LEG_FEE,
  LEG_SELLER,
  ROUTER3_ABI,
  router3Nonce,
  router3SettleData,
  type Router3Settlement,
} from '../../server/feed/pay/router3.js';
import {
  createRouter3Facilitator,
  encodeSettleBatch,
} from '../../server/protocol/x402/facilitator.js';
import {
  X402_FACILITATOR_BATCH_SQL,
  X402_FACILITATOR_SQL,
} from '../../server/protocol/x402/facilitator-schema.js';
import {
  assertTestnet,
  client,
  fees,
  readState,
  record,
  recorded,
  saveState,
  testKey,
  usdc18,
  walletOf,
} from './testnet-common.js';

const net = chainNetwork(ARC_TESTNET, { CITY_ARC: '1' });
if (!net) throw new Error('The Arc testnet network is not complete.');
const network = net;
const USDC = network.tokens.USDC.address;
const ENTRY_POINT = network.contracts.entryPointV06;
const REGISTRY = network.contracts.identityRegistry!;
const SPM = network.contracts.spendPermissionManager;

const usdcAbi = parseAbi([
  'function name() view returns (string)',
  'function version() view returns (string)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function authorizationState(address, bytes32) view returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
]);
const identityAbi = parseAbi([
  'function register(string tokenURI) returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerOf(uint256 id) view returns (address)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
]);
const entryPointAbi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
]);
const withdrawAbi = parseAbi([
  'struct SpendPermission { address account; address spender; address token; uint160 allowance; uint48 period; uint48 start; uint48 end; uint256 salt; bytes extraData; }',
  'struct WithdrawRequest { bytes signature; address asset; uint256 amount; uint256 nonce; uint48 expiry; }',
  'function spendWithWithdraw(SpendPermission spendPermission, uint160 value, WithdrawRequest withdrawRequest)',
  'function MAGIC_SPEND() view returns (address)',
  'function approve(SpendPermission spendPermission) returns (bool)',
]);

const state = () => readState();
const need = (name: string): Address => {
  const value = state()[name] as Address | undefined;
  if (!value) throw new Error(`${name} is not in the state file: run deploy-testnet.ts first.`);
  return value;
};
const usdcBalance = (address: Address) =>
  client.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [address] });

/** Tops an address up from the deployer to `wei` of gas balance (the one USDC balance on Arc). */
async function topUp(to: Address, wei: bigint, step: string) {
  const have = await client.getBalance({ address: to });
  if (have >= wei) return;
  const hash = await walletOf(testKey('deployer')).sendTransaction({
    to,
    value: wei - have,
    ...(await fees()),
  });
  record(step, recorded(await client.waitForTransactionReceipt({ hash })));
}

/** Sends a transaction, whatever it does, and returns its receipt. */
async function sent(account: PrivateKeyAccount, to: Address, data: Hex, gas?: bigint) {
  const hash = await walletOf(account).sendTransaction({
    to,
    data,
    ...(gas ? { gas } : {}),
    ...(await fees()),
  });
  return client.waitForTransactionReceipt({ hash });
}

const window = async () => {
  const now = (await client.getBlock()).timestamp;
  return { validAfter: 0n, validBefore: now + 600n };
};

// ---------------------------------------------------------------- observe
async function observe() {
  const heads = await Promise.all(
    (['latest', 'safe', 'finalized'] as const).map(async (tag) => {
      try {
        return [tag, (await client.getBlock({ blockTag: tag })).number.toString()];
      } catch (error) {
        return [tag, `refused: ${String(error).slice(0, 80)}`];
      }
    }),
  );
  const latest = await client.getBlockNumber();
  const blocks = await Promise.all(
    Array.from({ length: 40 }, (_, i) => client.getBlock({ blockNumber: latest - BigInt(i) })),
  );
  const times = blocks.map((b) => Number(b.timestamp)).reverse();
  const gaps = times.slice(1).map((t, i) => t - times[i]!);
  const history = await client.getFeeHistory({
    blockCount: 20,
    rewardPercentiles: [10, 50, 90],
    blockTag: 'latest',
  });
  const uniq = (list: bigint[]) => [...new Set(list.map(String))];
  let oracleCode: string | undefined;
  try {
    oracleCode = await client.getCode({ address: '0x420000000000000000000000000000000000000F' });
  } catch {
    oracleCode = 'read failed';
  }
  record('observe', {
    clockSkewSeconds: Number((await client.getBlock()).timestamp) - Math.floor(Date.now() / 1000),
    heads: Object.fromEntries(heads),
    sameTimestampPairs: gaps.filter((g) => g === 0).length,
    gapSeconds: { max: Math.max(...gaps), samples: gaps.length },
    gasPrice: (await client.getGasPrice()).toString(),
    maxPriorityFeePerGas: (await client.estimateMaxPriorityFeePerGas()).toString(),
    baseFees: uniq(history.baseFeePerGas),
    rewardsP50: uniq(history.reward!.map((r) => r[1]!)),
    gasUsedRatioMax: Math.max(...history.gasUsedRatio),
    gasLimit: blocks[0]!.gasLimit.toString(),
    l1OracleCode: oracleCode ?? 'none',
  });
}

// ---------------------------------------------------------------- a. USDC's EIP-3009
async function usdcStep() {
  const buyer = testKey('buyer');
  const seller = testKey('seller').address;
  const relayer = testKey('facilitator');
  await topUp(buyer.address, 10n ** 18n, 'fund_buyer');
  await topUp(relayer.address, 5n * 10n ** 17n, 'fund_facilitator');
  const read = (functionName: 'name' | 'version') =>
    client.readContract({ address: USDC, abi: usdcAbi, functionName });
  const [name, version, separator, decimals] = await Promise.all([
    read('name'),
    read('version'),
    client.readContract({ address: USDC, abi: usdcAbi, functionName: 'DOMAIN_SEPARATOR' }),
    client.readContract({ address: USDC, abi: usdcAbi, functionName: 'decimals' }),
  ]);
  const domain = usdcOf(ARC_TESTNET)!.eip712;
  const expected = domainSeparator({
    domain: { ...domain, chainId: ARC_TESTNET, verifyingContract: USDC },
  });
  record('usdc_domain', {
    name,
    version,
    decimals,
    separator,
    registry: domain,
    separatorMatchesRegistry: separator === expected,
  });

  const auth = async (nonceTag: string, value: bigint) => {
    const { validAfter, validBefore } = await window();
    const authorization = {
      from: buyer.address,
      to: seller,
      value,
      validAfter,
      validBefore,
      nonce: keccak256(stringToHex(`${nonceTag}:${Date.now()}`)),
    };
    const signature = await buyer.signTypedData(
      transferAuthorizationTypedData(network, USDC, authorization),
    );
    return { ...authorization, signature };
  };

  // The bytes overload: what router 3 calls. An EOA signature here.
  const one = await auth('bytes', 1_000n);
  const bytesReceipt = await sent(
    relayer,
    USDC,
    encodeFunctionData({
      abi: usdcAbi,
      functionName: 'transferWithAuthorization',
      args: [
        one.from,
        one.to,
        one.value,
        one.validAfter,
        one.validBefore,
        one.nonce,
        one.signature,
      ],
    }),
  );
  record('eip3009_bytes', recorded(bytesReceipt));

  // The v, r, s overload.
  const two = await auth('vrs', 1_000n);
  const r = `0x${two.signature.slice(2, 66)}` as Hex;
  const s = `0x${two.signature.slice(66, 130)}` as Hex;
  const v = Number.parseInt(two.signature.slice(130, 132), 16);
  const vrsReceipt = await sent(
    relayer,
    USDC,
    encodeFunctionData({
      abi: usdcAbi,
      functionName: 'transferWithAuthorization',
      args: [two.from, two.to, two.value, two.validAfter, two.validBefore, two.nonce, v, r, s],
    }),
  );
  record('eip3009_vrs', recorded(vrsReceipt));

  // A signature over Base's signing name must not verify here.
  const wrong = await buyer.signTypedData({
    ...transferAuthorizationTypedData(network, USDC, {
      ...one,
      nonce: keccak256(stringToHex(`wrong:${Date.now()}`)),
    }),
    domain: { name: 'USD Coin', version: '2', chainId: ARC_TESTNET, verifyingContract: USDC },
  });
  const refused = await client
    .simulateContract({
      account: relayer,
      address: USDC,
      abi: usdcAbi,
      functionName: 'transferWithAuthorization',
      args: [
        one.from,
        one.to,
        one.value,
        one.validAfter,
        one.validBefore,
        keccak256(stringToHex(`wrong:${Date.now()}`)),
        wrong,
      ],
    })
    .then(() => 'ACCEPTED')
    .catch((error) => `refused: ${String(error.shortMessage ?? error).slice(0, 120)}`);
  record('eip3009_wrong_name', { result: refused });

  const used = await client.readContract({
    address: USDC,
    abi: usdcAbi,
    functionName: 'authorizationState',
    args: [one.from, one.nonce],
  });
  record('eip3009_state', { nonceMarkedUsed: used });
}

// ---------------------------------------------------------------- a. router 3 settles
async function settlementFor(
  payer: Address,
  payee: Address,
  gross: bigint,
  sign: (authorization: {
    from: Address;
    to: Address;
    value: bigint;
    validAfter: bigint;
    validBefore: bigint;
    nonce: Hex;
  }) => Promise<Hex>,
): Promise<Router3Settlement> {
  const router = need('router');
  const treasury = need('treasury');
  const ref = keccak256(randomBytes(32));
  const { validAfter, validBefore } = await window();
  const fee = (gross * 1000n) / 10_000n;
  const nonce = (leg: typeof LEG_SELLER | typeof LEG_FEE) =>
    router3Nonce({
      chainId: ARC_TESTNET,
      router,
      treasury,
      payer,
      payee,
      gross,
      ref,
      validAfter,
      validBefore,
      leg,
    });
  const onChain = await client.readContract({
    address: router,
    abi: ROUTER3_ABI,
    functionName: 'nonceFor',
    args: [payer, payee, gross, ref, validAfter, validBefore, LEG_SELLER],
  });
  if (onChain !== nonce(LEG_SELLER)) throw new Error('The router derives another nonce.');
  const leg = (to: Address, value: bigint, n: Hex) =>
    sign({ from: payer, to, value, validAfter, validBefore, nonce: n });
  return {
    payer,
    payee,
    gross,
    ref,
    validAfter,
    validBefore,
    sellerSignature: await leg(payee, gross - fee, nonce(LEG_SELLER)),
    feeSignature: await leg(treasury, fee, nonce(LEG_FEE)),
  };
}

async function settleAndCheck(step: string, settlement: Router3Settlement) {
  const router = need('router');
  const treasury = need('treasury');
  const relayer = testKey('facilitator');
  const before = await Promise.all([settlement.payer, settlement.payee, treasury].map(usdcBalance));
  const data = router3SettleData(settlement);
  const estimate = await client.estimateGas({ account: relayer.address, to: router, data });
  const receipt = await sent(relayer, router, data, (estimate * 13n) / 10n);
  const after = await Promise.all([settlement.payer, settlement.payee, treasury].map(usdcBalance));
  const moved = after.map((value, i) => (value - before[i]!).toString());
  record(step, {
    ...recorded(receipt),
    estimate: estimate.toString(),
    moved: { payer: moved[0], payee: moved[1], treasury: moved[2] },
    logs: receipt.logs.length,
  });
  return receipt;
}

async function routerStep() {
  const buyer = testKey('buyer');
  const seller = testKey('seller').address;
  const sign = (a: Parameters<Parameters<typeof settlementFor>[3]>[0]) =>
    buyer.signTypedData(transferAuthorizationTypedData(network, USDC, a));
  // First (the treasury's balance slot is new), then warm: what a settle costs at the 0.05 floor.
  for (const n of [1, 2, 3, 4])
    await settleAndCheck(
      `router_settle_${n}`,
      await settlementFor(buyer.address, seller, 50_000n, sign),
    );
  // A brand-new seller: both balance slots start empty, the most a settle costs.
  await settleAndCheck(
    'router_settle_new_seller',
    await settlementFor(buyer.address, testKey(`seller-${Date.now()}`).address, 50_000n, sign),
  );
  // The router's cap, one payment twice: the second must revert.
  const again = await settlementFor(buyer.address, seller, 50_000n, sign);
  await settleAndCheck('router_settle_once', again);
  const replay = await client
    .simulateContract({
      account: testKey('facilitator'),
      address: need('router'),
      abi: ROUTER3_ABI,
      functionName: 'settle',
      args: [again],
    })
    .then(() => 'ACCEPTED')
    .catch((error) => `refused: ${String(error.shortMessage ?? error).slice(0, 120)}`);
  record('router_settle_replay', { result: replay });
}

// ---------------------------------------------------------------- b, c. account through our bundler
async function database() {
  const pg = await PGlite.create('memory://');
  for (const sql of [
    OWN_PAYMASTER_BUDGET_SQL,
    OWN_PAYMASTER_ATTRIBUTION_SQL,
    OWN_PAYMASTER_BUDGET_CHAIN_SQL,
    OWN_PAYMASTER_RESERVATIONS_CHAIN_SQL,
    DIRECT_BUNDLER_SQL,
    DIRECT_BUNDLER_FINALITY_SQL,
  ])
    await pg.exec(sql);
  return {
    query: (sql: string, params?: unknown[]) => pg.query(sql, params) as never,
    exec: (sql: string) => pg.exec(sql),
    transaction: (action: (tx: never) => Promise<unknown>) =>
      pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  } as unknown as Database;
}

/** The test keys, behind the one keystore call the bundler and signers use. */
const testKeystore = {
  withSigner: async <T>(ref: string, use: (account: PrivateKeyAccount) => Promise<T>) =>
    use(testKey(ref)),
} as unknown as Keystore;

const ownBundler = async (lines: string[]) => (await ownBundlerWithDb(lines)).bundler;

async function ownBundlerWithDb(lines: string[]) {
  const db = await database();
  const paymaster = need('paymaster');
  const budget = ownPaymasterBudget({
    db,
    chainId: ARC_TESTNET,
    // Arc's default protected reserve is 10 USDC, more than this test deposit: with it, every
    // ordinary flow is refused (protected_reserve). Testnet money only changes this one limit.
    limits: { ...chainParams(ARC_TESTNET).budget, protectedWei: 10n ** 17n },
    submitterBound: true,
    log: (line) => lines.push(line),
    deposit: async () => {
      const block = await client.getBlockNumber();
      const wei = await client.readContract({
        address: ENTRY_POINT,
        abi: entryPointAbi,
        functionName: 'balanceOf',
        args: [paymaster],
        blockNumber: block,
      });
      return { wei, block };
    },
  });
  const bundler = directBundler({
    db,
    client: client as never,
    chainId: ARC_TESTNET,
    entryPoint: ENTRY_POINT,
    mode: 'on',
    paymaster,
    keystore: testKeystore,
    signer: { keyRef: 'paymaster-signer', address: testKey('paymaster-signer').address },
    submitter: { keyRef: 'submitter', address: testKey('submitter').address },
    budget,
    policy: {
      addresses: {
        usdc: USDC,
        spendPermissionManager: SPM,
        identityRegistry: REGISTRY,
        reputationRegistry: network.contracts.reputationRegistry,
        smartWalletFactory: network.contracts.smartWalletFactory,
        feeRouters: [need('router')],
      },
    },
    log: (line) => lines.push(line),
    autoMaintain: false,
  });
  return { bundler, db };
}

type Bundler = Awaited<ReturnType<typeof ownBundler>>;

/** One sponsored operation, through prepareOperation and the bundler's send, followed to its receipt. */
async function operation(
  bundler: Bundler,
  lines: string[],
  step: string,
  keyRef: string,
  recipe: ReturnType<typeof spenderAccountRecipe>,
  calls: Call[],
  flow: 'registration' | 'agentPay' | 'feedPay',
) {
  const key = testKey(keyRef);
  const sender = deriveAddressLocal(recipe);
  const { operation: unsigned } = await prepareOperation(
    { network, client: client as never, bundler },
    { account: { address: sender, recipe }, calls, nonceKey: 0n, sponsorFlow: flow },
  );
  const signer = keystoreSigner(client as never, testKeystore, keyRef, key.address, ARC_TESTNET);
  const signed = {
    ...unsigned,
    signature: await signer.signUserOperation(unsigned, sender),
  } as UserOperation<'0.6'>;
  const started = Date.now();
  const opHash = await bundler.send(signed);
  let found = await bundler.receipt(opHash);
  for (let i = 0; !found && i < 120; i++) {
    await new Promise((done) => setTimeout(done, 1000));
    found = await bundler.receipt(opHash);
  }
  if (!found) throw new Error(`${step}: no receipt.\n${lines.join('\n')}`);
  const receipt = await client.getTransactionReceipt({ hash: found.txHash as Hex });
  const event = parseEventLogs({
    abi: entryPointAbi,
    logs: receipt.logs,
    eventName: 'UserOperationEvent',
  })[0];
  record(step, {
    ...recorded(receipt),
    userOpHash: opHash,
    opSuccess: event?.args.success,
    actualGasUsed: event?.args.actualGasUsed.toString(),
    actualGasCostUsdc: event ? usdc18(event.args.actualGasCost) : null,
    limits: {
      call: unsigned.callGasLimit.toString(),
      verification: unsigned.verificationGasLimit.toString(),
      preVerification: unsigned.preVerificationGas.toString(),
      maxFee: unsigned.maxFeePerGas.toString(),
      maxPriority: unsigned.maxPriorityFeePerGas.toString(),
    },
    seconds: (Date.now() - started) / 1000,
  });
  if (!event?.args.success) throw new Error(`${step}: the operation failed.\n${lines.join('\n')}`);
  return { receipt, opHash };
}

const registerCall = (uri: string): Call => ({
  target: REGISTRY,
  value: 0n,
  data: encodeFunctionData({ abi: identityAbi, functionName: 'register', args: [uri] }),
});

async function accountStep() {
  const lines: string[] = [];
  const bundler = await ownBundler(lines);
  const ready = await bundler.readiness();
  record('bundler_readiness', { ready });
  const spender = testKey('spender');
  const recipe = spenderAccountRecipe(network, spender.address);
  const sender = deriveAddressLocal(recipe);
  const fromFactory = await deriveAddress(client as never, recipe);
  if (fromFactory !== sender) throw new Error('The factory derives another address.');
  saveState({ account: sender });
  const depositBefore = await client.readContract({
    address: ENTRY_POINT,
    abi: entryPointAbi,
    functionName: 'balanceOf',
    args: [need('paymaster')],
  });
  const submitterBefore = await client.getBalance({ address: need('submitter') });
  const accountBefore = await client.getBalance({ address: sender });
  const { receipt } = await operation(
    bundler,
    lines,
    'account_deploy_and_register',
    'spender',
    recipe,
    [registerCall('https://example.invalid/arc-testnet/agent-1')],
    'registration',
  );
  const minted = parseEventLogs({ abi: identityAbi, logs: receipt.logs, eventName: 'Transfer' });
  const tokenId = minted[0]?.args.tokenId;
  const owner =
    tokenId === undefined
      ? null
      : await client.readContract({
          address: REGISTRY,
          abi: identityAbi,
          functionName: 'ownerOf',
          args: [tokenId],
        });
  record('account_readback', {
    account: sender,
    code: ((await client.getCode({ address: sender })) ?? '0x').length,
    agentId: tokenId?.toString(),
    agentOwnerIsAccount: owner !== null && getAddress(owner) === sender,
    depositDebitedUsdc: usdc18(
      depositBefore -
        (await client.readContract({
          address: ENTRY_POINT,
          abi: entryPointAbi,
          functionName: 'balanceOf',
          args: [need('paymaster')],
        })),
    ),
    submitterChangeUsdc: usdc18(
      submitterBefore - (await client.getBalance({ address: need('submitter') })),
    ),
    accountPaidNothing: (await client.getBalance({ address: sender })) === accountBefore,
  });
  // The account exists now: the path without initCode, with its calls simulated.
  await operation(
    bundler,
    lines,
    'account_second_register',
    'spender',
    recipe,
    [registerCall('https://example.invalid/arc-testnet/agent-2')],
    'registration',
  );
  await bundler.maintain();
  record('bundler_log', { lines });
}

// ---------------------------------------------------------------- d. spend permission
async function permissionStep() {
  const lines: string[] = [];
  const bundler = await ownBundler(lines);
  const owner = testKey('wallet-owner');
  const recipe = agentWalletRecipe(network, owner.address, 0n);
  const wallet = deriveAddressLocal(recipe);
  const spender = testKey('spender');
  const spenderRecipe = spenderAccountRecipe(network, spender.address);
  const account = deriveAddressLocal(spenderRecipe);
  const seller = testKey('seller').address;
  saveState({ wallet });
  // The wallet is not deployed: approveWithSignature deploys it through ERC-6492, as on Base.
  const hasCode = (await client.getCode({ address: wallet })) !== undefined;
  await topUp(wallet, 10n ** 18n, 'fund_agent_wallet');
  const now = Number((await client.getBlock()).timestamp);
  const permission = nonRenewing({
    account: wallet,
    spender: account,
    token: USDC,
    allowance: 200_000n,
    start: now - 60,
    end: now + 3600,
    salt: BigInt(keccak256(randomBytes(32))),
    extraData: '0x',
  });
  const hash = await permissionHash(client as never, network, permission);
  const ownerSig = await owner.signTypedData(ownerTypedData(ARC_TESTNET, wallet, hash));
  const signature = walletSignature(ownerSig, {
    ownerIndex: 0,
    ...(hasCode ? {} : { undeployedRecipe: recipe }),
  });
  const before = await Promise.all([wallet, account, seller].map(usdcBalance));
  const spendCalls = firstSpendCalls(network, permission, signature, 100_000n);
  const forward: Call = {
    target: USDC,
    value: 0n,
    data: encodeFunctionData({
      abi: usdcAbi,
      functionName: 'transfer',
      args: [seller, 100_000n],
    }),
  };
  await operation(
    bundler,
    lines,
    'permission_first_spend',
    'spender',
    spenderRecipe,
    [...spendCalls.map((c) => c as Call), forward],
    'agentPay',
  );
  const after = await Promise.all([wallet, account, seller].map(usdcBalance));
  const read = (functionName: 'isApproved' | 'isValid' | 'isRevoked') =>
    client.readContract({
      address: SPM,
      abi: spendPermissionManagerAbi,
      functionName,
      args: [permission],
    });
  const period = await client.readContract({
    address: SPM,
    abi: spendPermissionManagerAbi,
    functionName: 'getCurrentPeriod',
    args: [permission],
  });
  record('permission_readback', {
    walletDeployed: (await client.getCode({ address: wallet })) !== undefined,
    deployedByThisOp: !hasCode,
    approved: await read('isApproved'),
    spentInPeriod: period.spend.toString(),
    moved: {
      wallet: (after[0]! - before[0]!).toString(),
      account: (after[1]! - before[1]!).toString(),
      seller: (after[2]! - before[2]!).toString(),
    },
  });
  // A second spend, approval already on chain.
  const second: Call[] = [
    {
      target: SPM,
      value: 0n,
      data: encodeFunctionData({
        abi: spendPermissionManagerAbi,
        functionName: 'spend',
        args: [permission, 50_000n],
      }),
    },
    {
      target: USDC,
      value: 0n,
      data: encodeFunctionData({ abi: usdcAbi, functionName: 'transfer', args: [seller, 50_000n] }),
    },
  ];
  await operation(
    bundler,
    lines,
    'permission_second_spend',
    'spender',
    spenderRecipe,
    second,
    'agentPay',
  );
  // Over the allowance: 150k of 200k is spent, so 100k more must not pass, and is never sponsored.
  const over = encodeFunctionData({
    abi: spendPermissionManagerAbi,
    functionName: 'spend',
    args: [permission, 100_000n],
  });
  const refused = await prepareOperation(
    { network, client: client as never, bundler },
    {
      account: { address: account, recipe: spenderRecipe },
      calls: [{ target: SPM, value: 0n, data: over }],
      nonceKey: 0n,
      sponsorFlow: 'agentPay',
    },
  )
    .then(() => 'PREPARED')
    .catch((error) => `refused: ${String(error.message ?? error).slice(0, 140)}`);
  record('permission_over_allowance', { result: refused });
  await bundler.maintain();
  record('permission_log', { lines });
}

// ---------------------------------------------------------------- d. spendWithWithdraw
async function withdrawStep() {
  const owner = testKey('wallet-owner');
  const wallet = deriveAddressLocal(agentWalletRecipe(network, owner.address, 0n));
  const spender = testKey('withdraw-spender');
  await topUp(spender.address, 2n * 10n ** 17n, 'fund_withdraw_spender');
  const magicSpend = await client.readContract({
    address: SPM,
    abi: withdrawAbi,
    functionName: 'MAGIC_SPEND',
  });
  const magicCode = await client.getCode({ address: magicSpend });
  const now = Number((await client.getBlock()).timestamp);
  const permission = nonRenewing({
    account: wallet,
    spender: spender.address,
    token: USDC,
    allowance: 100_000n,
    start: now - 60,
    end: now + 3600,
    salt: BigInt(keccak256(randomBytes(32))),
    extraData: '0x',
  });
  const hash = await permissionHash(client as never, network, permission);
  const signature = walletSignature(
    await owner.signTypedData(ownerTypedData(ARC_TESTNET, wallet, hash)),
    { ownerIndex: 0 },
  );
  // A spender with a key of its own approves, and then spends with the empty MagicSpend.
  const approved = await sent(
    spender,
    SPM,
    encodeFunctionData({
      abi: spendPermissionManagerAbi,
      functionName: 'approveWithSignature',
      args: [permission, signature],
    }),
  );
  record('withdraw_approve', recorded(approved));
  const request = {
    signature: '0x' as Hex,
    asset: USDC,
    amount: 10_000n,
    nonce: BigInt(hash) & ((1n << 128n) - 1n),
    expiry: now + 600,
  };
  const before = await Promise.all([wallet, spender.address].map(usdcBalance));
  const data = encodeFunctionData({
    abi: withdrawAbi,
    functionName: 'spendWithWithdraw',
    args: [permission, 10_000n, request],
  });
  const simulated = await client
    .call({ account: spender.address, to: SPM, data })
    .then(() => 'simulation passes')
    .catch((error) => `simulation reverts: ${String(error.shortMessage ?? error).slice(0, 200)}`);
  const receipt = await sent(spender, SPM, data, 400_000n);
  const after = await Promise.all([wallet, spender.address].map(usdcBalance));
  record('spend_with_withdraw', {
    ...recorded(receipt),
    magicSpend,
    magicSpendHasCode: magicCode !== undefined,
    simulated,
    moved: {
      wallet: (after[0]! - before[0]!).toString(),
      spender: (after[1]! - before[1]!).toString(),
    },
  });
}

// ---------------------------------------------------------------- a, again: a smart account pays
async function smartSettleStep() {
  const spender = testKey('spender');
  const recipe = spenderAccountRecipe(network, spender.address);
  const account = deriveAddressLocal(recipe);
  await topUp(account, 5n * 10n ** 17n, 'fund_account');
  const sign = (authorization: Parameters<Parameters<typeof settlementFor>[3]>[0]) =>
    signTransferAuthorization({
      network,
      client: client as never,
      keystore: testKeystore,
      keyRef: 'spender',
      token: USDC,
      authorization,
    });
  const seller = testKey('seller').address;
  for (const n of [1, 2, 3])
    await settleAndCheck(
      `router_settle_erc1271_${n}`,
      await settlementFor(account, seller, 50_000n, sign),
    );
}

// ---------------------------------------------------------------- the repo's own facilitator
async function facilitatorStep() {
  const pg = await PGlite.create('memory://');
  await pg.exec(X402_FACILITATOR_SQL);
  await pg.exec(X402_FACILITATOR_BATCH_SQL);
  const db = {
    query: (sql: string, params?: unknown[]) => pg.query(sql, params) as never,
    exec: (sql: string) => pg.exec(sql),
    transaction: (action: (tx: never) => Promise<unknown>) =>
      pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  } as unknown as Database;
  const relayer = testKey('facilitator');
  await topUp(relayer.address, 12n * 10n ** 17n, 'fund_facilitator_to_min');
  const lines: string[] = [];
  const facilitator = createRouter3Facilitator({
    db,
    client: client as never,
    keystore: testKeystore as never,
    keyRef: 'facilitator',
    router: need('router'),
    chainId: ARC_TESTNET,
    usdcPerEth: chainParams(ARC_TESTNET).usdcPerNative!,
    log: (line) => lines.push(line),
  });
  const spender = testKey('spender');
  const account = deriveAddressLocal(spenderAccountRecipe(network, spender.address));
  const sign = (authorization: Parameters<Parameters<typeof settlementFor>[3]>[0]) =>
    signTransferAuthorization({
      network,
      client: client as never,
      keystore: testKeystore,
      keyRef: 'spender',
      token: USDC,
      authorization,
    });
  const follow = async (step: string, payee: Address) => {
    const settlement = await settlementFor(account, payee, 50_000n, sign);
    const key = `arc-testnet-${step}-${Date.now()}`;
    let op = await facilitator.submit({
      key,
      intentHash: keccak256(stringToHex(key)),
      settlement,
      beforeBroadcast: async () => {},
    });
    const included = Date.now();
    let finalMs: number | null = null;
    for (let i = 0; i < 60 && op.status !== 'final' && op.status !== 'failed'; i++) {
      await new Promise((done) => setTimeout(done, 1000));
      op = (await facilitator.status(key)) ?? op;
    }
    if (op.status === 'final') finalMs = Date.now() - included;
    const receipt = op.txHash
      ? await client.getTransactionReceipt({ hash: op.txHash as Hex })
      : null;
    record(step, {
      ...(receipt ? recorded(receipt) : {}),
      opStatus: op.status,
      errorCode: op.errorCode,
      finalAfterMs: finalMs,
    });
  };
  // The most a payment costs: a smart-account buyer and a seller with no balance yet.
  await follow('facilitator_settle_new_seller', testKey(`seller-${Date.now()}`).address);
  await follow('facilitator_settle_warm', testKey('seller').address);
  record('facilitator_log', { lines });
}

// ---------------------------------------------------------------- what the batch saves
async function batchStep() {
  const buyer = testKey('buyer');
  const seller = testKey('seller').address;
  const sign = (a: Parameters<Parameters<typeof settlementFor>[3]>[0]) =>
    buyer.signTypedData(transferAuthorizationTypedData(network, USDC, a));
  const batch: Router3Settlement[] = [];
  for (let i = 0; i < 5; i++) batch.push(await settlementFor(buyer.address, seller, 50_000n, sign));
  const receipt = await sent(testKey('facilitator'), need('router'), encodeSettleBatch(batch));
  record('router_settle_batch_5', {
    ...recorded(receipt),
    gasPerSettle: (receipt.gasUsed / 5n).toString(),
    costPerSettleUsdc: usdc18((receipt.gasUsed * receipt.effectiveGasPrice) / 5n),
  });
}

// ---------------------------------------------------------------- the fee floor and the tip
async function feesStep() {
  const key = testKey('fee-test');
  await topUp(key.address, 10n ** 17n, 'fund_fee_test');
  const wallet = walletOf(key);
  const attempt = async (step: string, maxFeePerGas: bigint, maxPriorityFeePerGas: bigint) => {
    const next = await client.getTransactionCount({ address: key.address });
    const started = Date.now();
    const result = await wallet
      .sendTransaction({
        to: key.address,
        value: 0n,
        nonce: next,
        gas: 21_000n,
        maxFeePerGas,
        maxPriorityFeePerGas,
      })
      .then((hash) =>
        client.waitForTransactionReceipt({ hash, timeout: 45_000 }).then(
          (receipt) => ({ ...recorded(receipt), seconds: (Date.now() - started) / 1000 }),
          () => ({ hash, landed: 'no receipt after 45 s' }),
        ),
      )
      .catch((error) => ({
        error: String(error.details ?? error.cause?.details ?? error.shortMessage).slice(0, 200),
      }));
    record(step, result);
  };
  // Exactly the floor, on a clean nonce.
  await attempt('fee_exactly_floor_no_tip', 20_000_000_000n, 0n);
  const nonce = await client.getTransactionCount({ address: key.address, blockTag: 'pending' });
  // Under the floor: the claim is that it disappears without an error.
  const low = await wallet
    .sendTransaction({
      to: key.address,
      value: 0n,
      nonce,
      gas: 21_000n,
      maxFeePerGas: 19_000_000_000n,
      maxPriorityFeePerGas: 0n,
    })
    .then((hash) => ({ hash, error: null as string | null }))
    .catch((error) => ({ hash: null, error: String(error.shortMessage ?? error).slice(0, 200) }));
  let landed = 'no receipt after 45 s';
  if (low.hash)
    for (let i = 0; i < 45; i++) {
      const found = await client.getTransactionReceipt({ hash: low.hash }).catch(() => null);
      if (found) {
        landed = `included in block ${found.blockNumber}`;
        break;
      }
      await new Promise((done) => setTimeout(done, 1000));
    }
  const known = low.hash
    ? await client.getTransaction({ hash: low.hash }).then(
        () => 'still known to the node',
        () => 'unknown to the node',
      )
    : 'never accepted';
  record('fee_under_floor', { ...low, landed, known });
  // Does it hold its nonce? At the same nonce: the floor, then real fees.
  await attempt('fee_same_nonce_at_floor', 20_000_000_000n, 0n);
  await attempt('fee_tip_0', 25_000_000_000n, 0n);
  await attempt('fee_tip_1_gwei', 26_000_000_000n, 1_000_000_000n);
}

// ---------------------------------------------------------------- settlement after inclusion
async function finalityStep() {
  const lines: string[] = [];
  const { bundler, db } = await ownBundlerWithDb(lines);
  const spender = testKey('spender');
  const { receipt, opHash } = await operation(
    bundler,
    lines,
    'finality_register',
    'spender',
    spenderAccountRecipe(network, spender.address),
    [registerCall('https://example.invalid/arc-testnet/agent-3')],
    'registration',
  );
  const started = Date.now();
  const read = async () => ({
    send: (
      await db.query<{ status: string }>(
        'SELECT status FROM own_paymaster_sends WHERE user_op_hash = $1',
        [opHash.toLowerCase()],
      )
    ).rows[0]?.status,
    reservation: (
      await db.query<{ status: string; max: string; actual: string | null }>(
        `SELECT status, max_cost_wei::text AS max, actual_cost_wei::text AS actual
         FROM own_paymaster_reservations WHERE user_op_hash = $1`,
        [opHash.toLowerCase()],
      )
    ).rows[0],
  });
  let seen = await read();
  for (let i = 0; i < 30 && seen.reservation?.status !== 'settled'; i++) {
    await bundler.maintain();
    seen = await read();
    if (seen.reservation?.status !== 'settled') await new Promise((done) => setTimeout(done, 1000));
  }
  record('finality_settled', {
    ...seen,
    block: receipt.blockNumber.toString(),
    settledAfterMs: Date.now() - started,
    worstCaseUsdc: seen.reservation ? usdc18(BigInt(seen.reservation.max)) : null,
    actualUsdc: seen.reservation?.actual ? usdc18(BigInt(seen.reservation.actual)) : null,
    log: lines,
  });
}

const steps: Record<string, () => Promise<void>> = {
  observe,
  facilitator: facilitatorStep,
  batch: batchStep,
  fees: feesStep,
  finality: finalityStep,
  usdc: usdcStep,
  router: routerStep,
  account: accountStep,
  permission: permissionStep,
  withdraw: withdrawStep,
  'smart-settle': smartSettleStep,
};

const name = process.argv[2] ?? '';
const step = steps[name];
if (!step) throw new Error(`A step: ${Object.keys(steps).join(', ')}.`);
await assertTestnet();
await step();
process.exit(0);
