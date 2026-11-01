/*
 * Builds the owner deploy kit for CentralCityFeeRouter (Operation Protocol P0): compiles the
 * contract exactly as deploy-fee-router.ts does and writes contracts/deploy-kit/router.json
 * (abi, creation bytecode, source and bytecode hashes, compiler settings). The kit's deploy.html
 * reads that file and deploys from the owner's own wallet (MetaMask), so no key ever leaves it.
 *   pnpm tsx scripts/protocol/build-deploy-kit.ts            (router 1, router.json)
 *   ROUTER=2 pnpm tsx scripts/protocol/build-deploy-kit.ts   (router 2, 100 USDC cap, router2.json)
 *   ROUTER=3 pnpm tsx scripts/protocol/build-deploy-kit.ts   (router 3, x402 settlement, router3.json)
 *   KIT=arc pnpm tsx scripts/protocol/build-deploy-kit.ts    (Arc mainnet, arc-mainnet.json, reads Base)
 *   node scripts/protocol/serve-deploy-kit.mjs   (then open http://127.0.0.1:8790/deploy.html)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createPublicClient, hashDomain, http, keccak256, toHex, type Hex } from 'viem';
import { REPLAYS, replayAddress } from '../arc/replay-deploys.js';

if (process.env.KIT === 'arc') {
  await buildArcKit();
  process.exit(0);
}

/*
 * What deploy-arc.html sends on Arc mainnet that isn't compiled here: Base's own deploy inputs for
 * PublicERC6492Validator and SpendPermissionManager, and the init code of Base's VerifyingPaymaster
 * up to and including its entryPoint word. Everything is read from Base and checked before writing.
 */
async function buildArcKit(): Promise<void> {
  const MANAGER_CHAIN_WORDS = {
    domain: { name: 'Spend Permission Manager', version: '1' },
    domainSeparatorAt: 8128,
    chainIdAt: 8196,
  };
  const DEPLOYER = '0x4e59b44847b379578588920ca78fbf26c0b4956c';
  const ENTRY_POINT = '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789';
  const BASE_PAYMASTER = '0x8Bf5b18b733a864c17Cd92615cD45D833Fcfe105';
  const BASE_PAYMASTER_DEPLOY =
    '0xc7ba196ddd47ac3d7e982ec1187c183e981513cf2e3f74d03134737f946fb96d';
  const base = createPublicClient({ transport: http('https://mainnet.base.org') });
  const replays = [];
  for (const name of ['PublicERC6492Validator', 'SpendPermissionManager']) {
    const replay = REPLAYS.find((r) => r.name === name)!;
    const tx = await base.getTransaction({ hash: replay.baseTx });
    if (tx.to?.toLowerCase() !== DEPLOYER) throw new Error(`${name}: not the CREATE2 deployer.`);
    if (replayAddress(tx.to, tx.input).toLowerCase() !== replay.address.toLowerCase())
      throw new Error(`${name}: the input does not land on its address.`);
    const baseRuntime = await base.getCode({ address: replay.address });
    if (!baseRuntime || baseRuntime === '0x') throw new Error(`${name}: no code on Base.`);
    // The manager's constructor keeps the chain id and its EIP-712 domain separator as immutables,
    // so its code on Arc differs from Base's in those two words only. Proven below: the same two
    // words give Base's code on Base and the deployed code on Arc testnet, byte for byte.
    const bound = name === 'SpendPermissionManager' ? MANAGER_CHAIN_WORDS : null;
    const onChain = (chainId: number) => {
      if (!bound) return baseRuntime;
      const separator = hashDomain({
        domain: { ...bound.domain, chainId, verifyingContract: replay.address },
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' },
          ],
        },
      });
      const hex = baseRuntime.slice(2);
      const separatorAt = bound.domainSeparatorAt * 2;
      const chainIdAt = bound.chainIdAt * 2;
      return `0x${hex.slice(0, separatorAt)}${separator.slice(2)}${hex.slice(separatorAt + 64, chainIdAt)}${chainId
        .toString(16)
        .padStart(64, '0')}${hex.slice(chainIdAt + 64)}` as Hex;
    };
    if (onChain(8453) !== baseRuntime) throw new Error(`${name}: not Base's code on Base.`);
    const testnet = createPublicClient({ transport: http('https://rpc.testnet.arc.io') });
    if (onChain(5042002) !== (await testnet.getCode({ address: replay.address })))
      throw new Error(`${name}: not the code on Arc testnet.`);
    const runtime = onChain(5042);
    replays.push({
      name,
      address: replay.address,
      baseTx: replay.baseTx,
      inputSha: keccak256(tx.input),
      runtimeSha: keccak256(runtime),
      input: tx.input,
      runtime,
      ...(bound ? { chainWords: bound } : {}),
    });
  }
  const tx = await base.getTransaction({ hash: BASE_PAYMASTER_DEPLOY });
  if (tx.to !== null) throw new Error('The paymaster deploy is not a contract creation.');
  // (entryPoint, verifying signer, owner): only the last two words change on Arc.
  const initCode = tx.input.slice(0, -128) as Hex;
  if (!initCode.endsWith(ENTRY_POINT.slice(2)))
    throw new Error('The constructor words are not where expected.');
  const runtime = await base.getCode({ address: BASE_PAYMASTER });
  if (!runtime || runtime === '0x') throw new Error('The paymaster has no code on Base.');
  const kit = {
    chainId: 5042,
    create2Deployer: '0x4e59b44847b379578588920cA78FbF26c0B4956C',
    entryPoint: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    replays,
    paymaster: {
      basePaymaster: BASE_PAYMASTER,
      baseTx: BASE_PAYMASTER_DEPLOY,
      initSha: keccak256(initCode),
      runtimeSha: keccak256(runtime),
      initCode,
      runtime,
    },
  };
  const target = new URL('../../contracts/deploy-kit/arc-mainnet.json', import.meta.url);
  writeFileSync(target, JSON.stringify(kit, null, 2) + '\n');
  console.log(
    JSON.stringify(
      {
        written: 'contracts/deploy-kit/arc-mainnet.json',
        replays: replays.map(({ name, address, inputSha, runtimeSha }) => ({
          name,
          address,
          inputSha,
          runtimeSha,
        })),
        paymaster: { initSha: kit.paymaster.initSha, runtimeSha: kit.paymaster.runtimeSha },
      },
      null,
      2,
    ),
  );
}

const require = createRequire(import.meta.url);
const solc = require('solc');
const SETTINGS = { optimizer: { enabled: true, runs: 10_000 }, evmVersion: 'cancun' } as const;

const N = process.env.ROUTER === '3' ? 3 : process.env.ROUTER === '2' ? 2 : 1;
const NAME = N === 1 ? 'CentralCityFeeRouter' : `CentralCityFeeRouter${N}`;
const FILE = `fees/${NAME}.sol`;
const KIT = N === 1 ? 'router.json' : `router${N}.json`;
const content = readFileSync(new URL(`../../contracts/${FILE}`, import.meta.url), 'utf8');
const out = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: 'Solidity',
      sources: { [FILE]: { content } },
      settings: {
        ...SETTINGS,
        outputSelection: {
          '*': {
            '': ['ast'],
            '*': [
              'abi',
              'evm.bytecode.object',
              'evm.deployedBytecode.object',
              'evm.deployedBytecode.immutableReferences',
            ],
          },
        },
      },
    }),
  ),
);
const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === 'error');
if (errors.length) throw new Error(errors.map((e: { message: string }) => e.message).join('\n'));
const c = out.contracts[FILE][NAME];
const bytecode = `0x${c.evm.bytecode.object}` as Hex;
// The runtime code as compiled, with every immutable (USDC and the treasury) still zero: the deploy
// page reads the deployed code back, zeroes the same ranges and requires this hash (CCA-132).
const runtime = `0x${c.evm.deployedBytecode.object}` as Hex;
// Each immutable by name (its declaration in the source's AST): the byte ranges it fills.
const names = new Map<number, string>();
(function walk(node: unknown): void {
  if (!node || typeof node !== 'object') return;
  const n = node as { nodeType?: string; id?: number; name?: string; mutability?: string };
  if (n.nodeType === 'VariableDeclaration' && n.mutability === 'immutable')
    names.set(n.id!, n.name!);
  for (const value of Object.values(node)) walk(value);
})(out.sources[FILE].ast);
const immutables = Object.fromEntries(
  Object.entries(
    c.evm.deployedBytecode.immutableReferences as Record<
      string,
      { start: number; length: number }[]
    >,
  )
    .map(([id, ranges]) => [names.get(Number(id)) ?? `ast${id}`, ranges] as const)
    .sort(([a], [b]) => a.localeCompare(b)),
);
const kit = {
  contract: NAME,
  chainId: 8453,
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  compiler: `solc ${solc.version()}`,
  // The source unit name is part of the metadata, so the bytecode hash depends on it.
  sourceUnit: FILE,
  settings: SETTINGS,
  sourceSha: keccak256(toHex(content)),
  bytecodeSha: keccak256(bytecode),
  runtimeSize: (runtime.length - 2) / 2,
  runtimeMaskedSha: keccak256(runtime),
  immutables,
  abi: c.abi,
  bytecode,
};
const target = new URL(`../../contracts/deploy-kit/${KIT}`, import.meta.url);
writeFileSync(target, JSON.stringify(kit, null, 2) + '\n');
console.log(
  JSON.stringify(
    {
      written: `contracts/deploy-kit/${KIT}`,
      sourceSha: kit.sourceSha,
      bytecodeSha: kit.bytecodeSha,
      compiler: kit.compiler,
    },
    null,
    2,
  ),
);
