/*
 * Deploys contracts/fees/CentralCityFeeRouter.sol (Operation Protocol P0-L2).
 *
 *   PROTOCOL_DEPLOYER_KEY=<hex key, never printed> pnpm tsx scripts/protocol/deploy-fee-router.ts \
 *     --network base-sepolia --treasury 0x... [--rpc https://...] [--dry-run]
 *
 * Base Sepolia only. Mainnet is refused here on purpose: it needs the signed Phase 0 gate and its
 * own reviewed run. The token is always the network's USDC from shared/base/chains.ts. Prints the
 * address, tx hash, block, compiler settings and the runtime code hash, and reads back token and
 * treasury from the deployed contract before reporting success.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  isAddress,
  keccak256,
  type Abi,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const require = createRequire(import.meta.url);
const solc = require('solc');

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;
const SETTINGS = { optimizer: { enabled: true, runs: 10_000 }, evmVersion: 'cancun' } as const;

/**
 * Whether deployed runtime code is the compiled runtime with exactly `words` (USDC, then the
 * treasury, in any order) in its immutable ranges: every range holds one of them, and the code with
 * those ranges zeroed equals the compiled runtime byte for byte (the deploy page does the same).
 */
export function maskedRuntimeMatches(
  deployed: Hex,
  runtime: Hex,
  ranges: readonly { start: number; length: number }[],
  words: readonly string[],
): { ok: boolean; reason: string } {
  const hex = deployed.toLowerCase().replace(/^0x/, '');
  const expected = runtime.toLowerCase().replace(/^0x/, '');
  if (hex.length !== expected.length) return { ok: false, reason: 'code size differs' };
  const allowed = new Set(words.map((w) => w.toLowerCase().replace(/^0x/, '').padStart(64, '0')));
  let masked = hex;
  for (const { start, length } of ranges) {
    const value = hex.slice(start * 2, (start + length) * 2);
    if (length !== 32 || !allowed.has(value))
      return { ok: false, reason: `immutable at byte ${start} is not USDC or the treasury` };
    masked = masked.slice(0, start * 2) + '0'.repeat(64) + masked.slice((start + length) * 2);
  }
  return masked === expected
    ? { ok: true, reason: 'matches the compiled runtime' }
    : { ok: false, reason: 'runtime code differs from the compiled source' };
}

function compile() {
  const content = readFileSync(
    new URL('../../contracts/fees/CentralCityFeeRouter.sol', import.meta.url),
    'utf8',
  );
  const input = {
    language: 'Solidity',
    sources: { 'fees/CentralCityFeeRouter.sol': { content } },
    settings: {
      ...SETTINGS,
      outputSelection: {
        '*': {
          '*': [
            'abi',
            'evm.bytecode.object',
            'evm.deployedBytecode.object',
            'evm.deployedBytecode.immutableReferences',
          ],
        },
      },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e: { message: string }) => e.message).join('\n'));
  const c = out.contracts['fees/CentralCityFeeRouter.sol'].CentralCityFeeRouter;
  return {
    abi: c.abi as Abi,
    bytecode: `0x${c.evm.bytecode.object}` as Hex,
    // The runtime code with its immutables still zero, and where they go (CCA-132).
    runtime: `0x${c.evm.deployedBytecode.object}` as Hex,
    immutableRanges: Object.values(
      c.evm.deployedBytecode.immutableReferences as Record<
        string,
        { start: number; length: number }[]
      >,
    ).flat(),
    sourceHash: keccak256(new TextEncoder().encode(content)),
  };
}

async function main() {
  const network = arg('network');
  if (network !== 'base-sepolia')
    throw new Error('Only --network base-sepolia is allowed; mainnet needs the signed gate.');
  const treasury = arg('treasury');
  if (!treasury || !isAddress(treasury) || /^0x0{40}$/i.test(treasury))
    throw new Error('--treasury must be a non-zero address.');
  const rpc = arg('rpc') ?? 'https://sepolia.base.org';
  const compiled = compile();
  const { abi, bytecode, sourceHash } = compiled;
  const report: Record<string, unknown> = {
    network,
    chainId: baseSepolia.id,
    compiler: `solc ${solc.version()}`,
    settings: SETTINGS,
    sourceSha: sourceHash,
    constructorArgs: { token: SEPOLIA_USDC, treasury: getAddress(treasury) },
  };
  if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify({ ...report, dryRun: true }, null, 2));
    return;
  }
  const key = process.env.PROTOCOL_DEPLOYER_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key))
    throw new Error('PROTOCOL_DEPLOYER_KEY is missing.');
  const account = privateKeyToAccount(key as Hex);
  const pub = createPublicClient({ chain: baseSepolia, transport: http(rpc) });
  if ((await pub.getChainId()) !== baseSepolia.id) throw new Error('RPC is not Base Sepolia.');
  const wallet = createWalletClient({ chain: baseSepolia, transport: http(rpc), account });
  const hash = await wallet.deployContract({
    abi,
    bytecode,
    args: [SEPOLIA_USDC, getAddress(treasury)],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress)
    throw new Error('Deployment reverted.');
  const address = receipt.contractAddress;
  const read = (functionName: string) => pub.readContract({ address, abi, functionName });
  const [token, readTreasury, maxTotal] = await Promise.all([
    read('token'),
    read('treasury'),
    read('MAX_TOTAL'),
  ]);
  if (
    getAddress(token as string) !== SEPOLIA_USDC ||
    getAddress(readTreasury as string) !== getAddress(treasury)
  )
    throw new Error('Deployed constructor values do not match.');
  const deployed = (await pub.getCode({ address })) ?? '0x';
  const runtimeCheck = maskedRuntimeMatches(deployed, compiled.runtime, compiled.immutableRanges, [
    SEPOLIA_USDC,
    getAddress(treasury),
  ]);
  if (!runtimeCheck.ok)
    throw new Error(`Deployed runtime code does not match: ${runtimeCheck.reason}`);
  console.log(
    JSON.stringify(
      {
        ...report,
        deployer: account.address,
        address,
        txHash: hash,
        block: receipt.blockNumber.toString(),
        runtimeCodeHash: keccak256(deployed),
        runtimeCheck: runtimeCheck.reason,
        maxTotal: String(maxTotal),
      },
      null,
      2,
    ),
  );
}

// Runs only as a script; tests import maskedRuntimeMatches without deploying anything.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  main().catch((e) => {
    console.error('DEPLOY FAILED', String(e?.shortMessage ?? e?.message ?? e).slice(0, 400));
    process.exitCode = 1;
  });
