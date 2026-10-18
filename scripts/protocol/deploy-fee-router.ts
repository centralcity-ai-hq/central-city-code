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
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e: { message: string }) => e.message).join('\n'));
  const c = out.contracts['fees/CentralCityFeeRouter.sol'].CentralCityFeeRouter;
  return {
    abi: c.abi as Abi,
    bytecode: `0x${c.evm.bytecode.object}` as Hex,
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
  const { abi, bytecode, sourceHash } = compile();
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
  console.log(
    JSON.stringify(
      {
        ...report,
        deployer: account.address,
        address,
        txHash: hash,
        block: receipt.blockNumber.toString(),
        runtimeCodeHash: keccak256((await pub.getCode({ address })) ?? '0x'),
        maxTotal: String(maxTotal),
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error('DEPLOY FAILED', String(e?.shortMessage ?? e?.message ?? e).slice(0, 400));
  process.exitCode = 1;
});
