/*
 * Operation Protocol: CentralCityFeeRouter against the REAL Base USDC on a local fork of Base
 * mainnet (no real funds: Anvil dev accounts, balances set locally). Deploys the router exactly as
 * scripts/protocol/deploy-fee-router.ts compiles it, then runs both fee paths and the refusals.
 *   anvil --fork-url https://mainnet.base.org --port 8548
 *   pnpm tsx scripts/protocol/router-fork-check.ts [rpcUrl]
 *   ROUTER=2 pnpm tsx scripts/protocol/router-fork-check.ts [rpcUrl]   (router 2: also 1, 10 and 100 USDC)
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
  http,
  keccak256,
  pad,
  parseAbi,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { base } from 'viem/chains';

const require = createRequire(import.meta.url);
const solc = require('solc');
const RPC = process.argv.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:8548';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
const usdcAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function name() view returns (string)',
]);

const ROUTER2 = process.env.ROUTER === '2';
const NAME = ROUTER2 ? 'CentralCityFeeRouter2' : 'CentralCityFeeRouter';
const FILE = `fees/${NAME}.sol`;
const FUND = ROUTER2 ? 300_000_000n : 1_000_000n;

function compile() {
  const content = readFileSync(new URL(`../../contracts/${FILE}`, import.meta.url), 'utf8');
  const out = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: 'Solidity',
        sources: { [FILE]: { content } },
        settings: {
          optimizer: { enabled: true, runs: 10_000 },
          evmVersion: 'cancun',
          outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
        },
      }),
    ),
  );
  const c = out.contracts[FILE][NAME];
  return { abi: c.abi as Abi, bytecode: `0x${c.evm.bytecode.object}` as Hex };
}

async function main() {
  const { abi, bytecode } = compile();
  const pub = createPublicClient({ chain: base, transport: http(RPC) });
  assert.equal(await pub.getChainId(), 8453, 'a fork of Base mainnet');
  const test = createTestClient({ chain: base, transport: http(RPC), mode: 'anvil' });
  const [deployer, payer, seller, treasury] = (await pub.request({
    method: 'eth_accounts',
  })) as Address[];
  const wallet = (account: Address) =>
    createWalletClient({ chain: base, transport: http(RPC), account });
  // FUND for the payer: FiatToken v2.2 balances live in mapping slot 9.
  const slot = keccak256(
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [payer, 9n]),
  );
  await test.setStorageAt({ address: USDC, index: slot, value: pad(toHex(FUND)) });
  const bal = (a: Address) =>
    pub.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [a] });
  assert.equal(await bal(payer), FUND);
  assert.equal(
    await pub.readContract({ address: USDC, abi: usdcAbi, functionName: 'name' }),
    'USD Coin',
  );

  const hash = await wallet(deployer).deployContract({ abi, bytecode, args: [USDC, treasury] });
  const router = (await pub.waitForTransactionReceipt({ hash })).contractAddress as Address;
  const send = async (fn: string, args: unknown[]) =>
    pub.waitForTransactionReceipt({
      hash: await wallet(payer).writeContract({
        address: router,
        abi,
        functionName: fn,
        args,
        gas: 300_000n,
      }),
    });
  await pub.waitForTransactionReceipt({
    hash: await wallet(payer).writeContract({
      address: USDC,
      abi: usdcAbi,
      functionName: 'approve',
      args: [router, FUND],
    }),
  });
  const ref = (s: string) => keccak256(toHex(s));
  const results: Record<string, unknown> = {};

  // Fee on top: a $0.09 external service already paid; 10% to the treasury.
  const t0 = await bal(treasury);
  const r1 = await send('chargeFee', [seller, 90_000n, ref('a')]);
  const ev = r1.logs
    .filter((l) => l.address.toLowerCase() === router.toLowerCase())
    .map((l) => decodeEventLog({ abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] }))[0];
  results.chargeFee = {
    status: r1.status,
    treasuryGot: String((await bal(treasury)) - t0),
    event: ev?.eventName,
    gas: String(r1.gasUsed),
  };
  assert.equal((await bal(treasury)) - t0, 9_000n);

  // Fee included: $0.05 Central City service, seller 90%, treasury 10%, one call.
  const s0 = await bal(seller);
  const t1 = await bal(treasury);
  const r2 = await send('pay', [seller, 50_000n, ref('b')]);
  results.pay = {
    status: r2.status,
    sellerGot: String((await bal(seller)) - s0),
    treasuryGot: String((await bal(treasury)) - t1),
    gas: String(r2.gasUsed),
  };
  assert.equal((await bal(seller)) - s0, 45_000n);
  assert.equal((await bal(treasury)) - t1, 5_000n);

  if (ROUTER2) {
    // Router 2 prices with real USDC: 1, 10 and 100 USDC fee included; the top fee-on-top price.
    const big: Record<string, unknown> = {};
    for (const gross of [1_000_000n, 10_000_000n, 100_000_000n]) {
      const s = await bal(seller);
      const t = await bal(treasury);
      const r = await send('pay', [seller, gross, ref(`big${gross}`)]);
      assert.equal((await bal(seller)) - s, gross - gross / 10n);
      assert.equal((await bal(treasury)) - t, gross / 10n);
      big[String(gross)] = { status: r.status, gas: String(r.gasUsed) };
    }
    const t = await bal(treasury);
    await send('chargeFee', [seller, 90_909_091n, ref('topExternal')]);
    assert.equal((await bal(treasury)) - t, 9_090_909n);
    results.router2 = big;
  }

  // Refusals against real USDC.
  const reverts = async (fn: string, args: unknown[]) => {
    try {
      await pub.simulateContract({ account: payer, address: router, abi, functionName: fn, args });
      return false;
    } catch {
      return true;
    }
  };
  results.refused = {
    replay: await reverts('chargeFee', [seller, 90_000n, ref('a')]),
    overCapExternal: await reverts('chargeFee', [
      seller,
      ROUTER2 ? 90_909_092n : 90_910n,
      ref('c'),
    ]),
    overCapIncluded: await reverts('pay', [seller, ROUTER2 ? 100_000_001n : 100_001n, ref('f')]),
    belowMinimumIncluded: await reverts('pay', [seller, 49_999n, ref('d')]),
    payeeIsTreasury: await reverts('pay', [treasury, 50_000n, ref('e')]),
  };
  assert.ok(Object.values(results.refused as Record<string, boolean>).every(Boolean));
  assert.equal(await bal(router), 0n, 'the router never holds USDC');
  console.log(
    JSON.stringify(
      {
        result: 'PASS',
        forkBlock: String(await pub.getBlockNumber()),
        usdcName: 'USD Coin',
        ...results,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error('FORK CHECK FAILED', e?.shortMessage ?? e?.message ?? e);
  process.exitCode = 1;
});
