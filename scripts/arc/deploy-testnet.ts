/*
 * Puts fee router 3 and our VerifyingPaymaster on Arc TESTNET with throwaway keys and free test USDC.
 * It refuses any chain but 5042002, read from the node.
 *
 *   ARC_TESTNET_KEYS_DIR=<folder outside the repo> npx tsx scripts/arc/deploy-testnet.ts
 *
 * Router: the kit's bytecode, checked against the kit's hash before sending and against the kit's
 * masked runtime hash after. Paymaster: the init code of Base's own deploy transaction with only the
 * last two constructor words replaced. The words are (entryPoint, verifying signer, owner): Base's
 * deploy names its signer second and its deployer third. Everything is read back, and a run continues
 * from the state file, so nothing is deployed twice.
 */
import { createRequire } from 'node:module';
import {
  concat,
  createPublicClient,
  encodeAbiParameters,
  getAddress,
  http,
  isAddress,
  keccak256,
  pad,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import {
  assertTestnet,
  client,
  fees,
  network,
  readState,
  record,
  recorded,
  saveState,
  testKey,
  usdc18,
  walletOf,
} from './testnet-common.js';

const require = createRequire(import.meta.url);
const kit = require('../../contracts/deploy-kit/router3.json') as {
  bytecode: Hex;
  bytecodeSha: Hex;
  runtimeSize: number;
  runtimeMaskedSha: Hex;
  immutables: Record<string, { start: number; length: number }[]>;
};

const BASE_PAYMASTER: Address = '0x8Bf5b18b733a864c17Cd92615cD45D833Fcfe105';
const BASE_PAYMASTER_DEPLOY: Hex =
  '0xc7ba196ddd47ac3d7e982ec1187c183e981513cf2e3f74d03134737f946fb96d';
const ENTRY_POINT = network.contracts.entryPointV06;
const USDC = network.usdc.address;

const routerAbi = parseAbi([
  'function token() view returns (address)',
  'function treasury() view returns (address)',
  'function FEE_BPS() view returns (uint256)',
  'function MIN_INCLUDED() view returns (uint256)',
]);
const paymasterAbi = parseAbi([
  'function owner() view returns (address)',
  'function verifyingSigner() view returns (address)',
  'function pendingVerifyingSigner() view returns (address)',
  'function entryPoint() view returns (address)',
  'function isBundlerAllowed(address bundler) view returns (bool)',
  'function updateBundlerAllowlist(address bundler, bool allowed)',
]);
const entryPointAbi = parseAbi([
  'function depositTo(address account) payable',
  'function balanceOf(address account) view returns (uint256)',
]);

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const must = (ok: boolean, what: string) => {
  if (!ok) throw new Error(`Read back failed: ${what}`);
  console.log(`  ok: ${what}`);
};

/** The kit's check (contracts/deploy-kit/guard.js) with viem's keccak. */
function routerRuntimeCheck(code: Hex, treasury: Address): void {
  let hex = code.slice(2).toLowerCase();
  must(hex.length === kit.runtimeSize * 2, `router runtime is ${kit.runtimeSize} bytes`);
  const expected: Record<string, string> = {
    token: pad(USDC.toLowerCase() as Hex, { size: 32 }).slice(2),
    treasury: pad(treasury.toLowerCase() as Hex, { size: 32 }).slice(2),
  };
  for (const [name, ranges] of Object.entries(kit.immutables))
    for (const range of ranges) {
      const at = range.start * 2;
      if (hex.slice(at, at + 64) !== expected[name])
        throw new Error(`Router ${name} at byte ${range.start} is not the expected value.`);
      hex = hex.slice(0, at) + '0'.repeat(64) + hex.slice(at + 64);
    }
  must(keccak256(`0x${hex}`) === kit.runtimeMaskedSha, 'router masked runtime equals the kit hash');
}

function addressArg(flag: string): Address | undefined {
  const at = process.argv.indexOf(flag);
  if (at < 0) return undefined;
  const value = process.argv[at + 1] ?? '';
  if (!isAddress(value, { strict: false })) throw new Error(`${flag} takes an address.`);
  return getAddress(value);
}

async function main() {
  await assertTestnet();
  const deployer = testKey('deployer');
  const owner = testKey('paymaster-owner');
  // A server that made its own keys names them: only their addresses are needed here.
  const signer = { address: addressArg('--signer') ?? testKey('paymaster-signer').address };
  const submitter = { address: addressArg('--submitter') ?? testKey('submitter').address };
  const treasury = testKey('treasury').address;
  const wallet = walletOf(deployer);
  const start = await client.getBalance({ address: deployer.address });
  console.log(`deployer ${deployer.address}, ${usdc18(start)} USDC`);
  saveState({
    deployer: deployer.address,
    owner: owner.address,
    signer: signer.address,
    submitter: submitter.address,
    treasury,
  });

  // Fee router 3.
  if (keccak256(kit.bytecode) !== kit.bytecodeSha) throw new Error('Kit bytecode hash differs.');
  console.log('router: kit bytecode hash matches');
  let router = readState().router as Address | undefined;
  if (!router) {
    const hash = await wallet.sendTransaction({
      data: concat([
        kit.bytecode,
        encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [USDC, treasury]),
      ]),
      gas: 1_500_000n,
      ...(await fees()),
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success' || !receipt.contractAddress)
      throw new Error(`Router deploy ${hash} failed.`);
    router = receipt.contractAddress;
    saveState({ router });
    record('deploy_router', { ...recorded(receipt), address: router });
  }
  routerRuntimeCheck((await client.getCode({ address: router }))!, treasury);
  const readRouter = <F extends 'token' | 'treasury'>(functionName: F) =>
    client.readContract({ address: router!, abi: routerAbi, functionName });
  must(same(await readRouter('token'), USDC), 'router token is ARC_USDC');
  must(same(await readRouter('treasury'), treasury), 'router treasury is the throwaway treasury');

  // The paymaster: Base's init code, only signer and owner replaced.
  let paymaster = readState().paymaster as Address | undefined;
  const base = createPublicClient({ transport: http('https://mainnet.base.org') });
  if (!paymaster) {
    const tx = await base.getTransaction({ hash: BASE_PAYMASTER_DEPLOY });
    if (tx.to !== null) throw new Error('Base paymaster deploy is not a contract creation.');
    const words = tx.input.slice(-192).match(/.{64}/g)!;
    if (!words[0]!.toLowerCase().endsWith(ENTRY_POINT.slice(2).toLowerCase()))
      throw new Error('The constructor words are not where expected.');
    const data = concat([
      tx.input.slice(0, -128) as Hex,
      pad(signer.address, { size: 32 }),
      pad(owner.address, { size: 32 }),
    ]);
    const hash = await wallet.sendTransaction({ data, gas: 2_600_000n, ...(await fees()) });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success' || !receipt.contractAddress)
      throw new Error(`Paymaster deploy ${hash} failed.`);
    paymaster = receipt.contractAddress;
    saveState({ paymaster });
    record('deploy_paymaster', { ...recorded(receipt), address: paymaster });
  }
  const readPm = (
    functionName: 'owner' | 'verifyingSigner' | 'pendingVerifyingSigner' | 'entryPoint',
  ) => client.readContract({ address: paymaster!, abi: paymasterAbi, functionName });
  must(same(await readPm('entryPoint'), ENTRY_POINT), 'paymaster entryPoint is v0.6');
  must(same(await readPm('owner'), owner.address), 'paymaster owner is the throwaway owner');
  must(same(await readPm('verifyingSigner'), signer.address), 'paymaster signer is the throwaway');
  must(
    (await client.getCode({ address: paymaster })) ===
      (await base.getCode({ address: BASE_PAYMASTER })),
    "paymaster runtime equals Base's byte for byte",
  );

  // Owner gas, then the allowlist (docs/base/OWN_PAYMASTER_OPS.md: the submitter is the only bundler).
  if ((await client.getBalance({ address: owner.address })) < 10n ** 16n) {
    const hash = await wallet.sendTransaction({
      to: owner.address,
      value: 5n * 10n ** 16n,
      ...(await fees()),
    });
    record('fund_owner', recorded(await client.waitForTransactionReceipt({ hash })));
  }
  const allowed = () =>
    client.readContract({
      address: paymaster!,
      abi: paymasterAbi,
      functionName: 'isBundlerAllowed',
      args: [submitter.address],
    });
  if (!(await allowed())) {
    const hash = await walletOf(owner).writeContract({
      address: paymaster,
      abi: paymasterAbi,
      functionName: 'updateBundlerAllowlist',
      args: [submitter.address, true],
      ...(await fees()),
    });
    record('allowlist_submitter', recorded(await client.waitForTransactionReceipt({ hash })));
  }
  must(await allowed(), 'submitter is on the bundler allowlist');

  // The deposit at the EntryPoint (OWN_PAYMASTER_OPS.md, Funding), and the submitter's float.
  const deposit = () =>
    client.readContract({
      address: ENTRY_POINT,
      abi: entryPointAbi,
      functionName: 'balanceOf',
      args: [paymaster!],
    });
  if ((await deposit()) < 10n ** 18n) {
    const hash = await wallet.writeContract({
      address: ENTRY_POINT,
      abi: entryPointAbi,
      functionName: 'depositTo',
      args: [paymaster],
      value: 2n * 10n ** 18n,
      ...(await fees()),
    });
    record('deposit', recorded(await client.waitForTransactionReceipt({ hash })));
  }
  if ((await client.getBalance({ address: submitter.address })) < 10n ** 18n) {
    const hash = await wallet.sendTransaction({
      to: submitter.address,
      value: 2n * 10n ** 18n,
      ...(await fees()),
    });
    record('fund_submitter', recorded(await client.waitForTransactionReceipt({ hash })));
  }
  console.log(`deposit at the EntryPoint: ${usdc18(await deposit())} USDC`);
  const end = await client.getBalance({ address: deployer.address });
  console.log(`router ${router}\npaymaster ${paymaster}\ndeployer left ${usdc18(end)} USDC`);
}

await main();
