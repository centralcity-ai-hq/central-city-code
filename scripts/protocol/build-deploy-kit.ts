/*
 * Builds the owner deploy kit for CentralCityFeeRouter (Operation Protocol P0): compiles the
 * contract exactly as deploy-fee-router.ts does and writes contracts/deploy-kit/router.json
 * (abi, creation bytecode, source and bytecode hashes, compiler settings). The kit's deploy.html
 * reads that file and deploys from the owner's own wallet (MetaMask), so no key ever leaves it.
 *   pnpm tsx scripts/protocol/build-deploy-kit.ts            (router 1, router.json)
 *   ROUTER=2 pnpm tsx scripts/protocol/build-deploy-kit.ts   (router 2, 100 USDC cap, router2.json)
 *   node scripts/protocol/serve-deploy-kit.mjs   (then open http://localhost:8790/deploy.html)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { keccak256, toHex, type Hex } from 'viem';

const require = createRequire(import.meta.url);
const solc = require('solc');
const SETTINGS = { optimizer: { enabled: true, runs: 10_000 }, evmVersion: 'cancun' } as const;

const ROUTER2 = process.env.ROUTER === '2';
const NAME = ROUTER2 ? 'CentralCityFeeRouter2' : 'CentralCityFeeRouter';
const FILE = `fees/${NAME}.sol`;
const KIT = ROUTER2 ? 'router2.json' : 'router.json';
const content = readFileSync(new URL(`../../contracts/${FILE}`, import.meta.url), 'utf8');
const out = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: 'Solidity',
      sources: { [FILE]: { content } },
      settings: { ...SETTINGS, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
    }),
  ),
);
const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === 'error');
if (errors.length) throw new Error(errors.map((e: { message: string }) => e.message).join('\n'));
const c = out.contracts[FILE][NAME];
const bytecode = `0x${c.evm.bytecode.object}` as Hex;
const kit = {
  contract: NAME,
  chainId: 8453,
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  compiler: `solc ${solc.version()}`,
  settings: SETTINGS,
  sourceSha: keccak256(toHex(content)),
  bytecodeSha: keccak256(bytecode),
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
