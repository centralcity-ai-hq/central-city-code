/*
 * Operation Protocol P0-L2: behaviour checks for contracts/fees/CentralCityFeeRouter.sol.
 * Compiles with solc 0.8.28 and runs every case against a local Anvil chain (unlocked dev accounts,
 * no keys). Usage: anvil --port 8547, then
 *   pnpm tsx scripts/protocol/fee-router-check.ts [rpcUrl]
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
  http,
  keccak256,
  maxUint256,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { foundry } from 'viem/chains';

const require = createRequire(import.meta.url);
const solc = require('solc');
const RPC = process.argv.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:8547';
// ROUTER=2 checks fees/CentralCityFeeRouter2.sol (the same code with a 100 USDC cap).
const ROUTER2 = process.env.ROUTER === '2';
const SOURCE = ROUTER2 ? 'fees/CentralCityFeeRouter2.sol' : 'fees/CentralCityFeeRouter.sol';
const NAME = ROUTER2 ? 'CentralCityFeeRouter2' : 'CentralCityFeeRouter';
const MAX_TOTAL = ROUTER2 ? 100_000_000n : 100_000n;
let TOP_MAX = (MAX_TOTAL * 10n) / 11n;
while (TOP_MAX + 1n + (TOP_MAX + 1n) / 10n <= MAX_TOTAL) TOP_MAX += 1n;

function compile() {
  const read = (p: string) =>
    readFileSync(new URL(`../../contracts/${p}`, import.meta.url), 'utf8');
  const input = {
    language: 'Solidity',
    sources: {
      [SOURCE]: { content: read(SOURCE) },
      'test/TestToken.sol': { content: read('test/TestToken.sol') },
    },
    settings: {
      optimizer: { enabled: true, runs: 10_000 },
      evmVersion: 'cancun',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === 'error');
  if (errors.length)
    throw new Error(errors.map((e: { formattedMessage: string }) => e.formattedMessage).join('\n'));
  const pick = (file: string, name: string) => ({
    abi: out.contracts[file][name].abi as Abi,
    bytecode: `0x${out.contracts[file][name].evm.bytecode.object}` as Hex,
  });
  return {
    router: pick(SOURCE, NAME),
    token: pick('test/TestToken.sol', 'TestToken'),
  };
}

async function main() {
  const { router: R, token: T } = compile();
  const pub = createPublicClient({ chain: foundry, transport: http(RPC) });
  const [deployer, payer, seller, treasury, other] = (await pub.request({
    method: 'eth_accounts',
  })) as Address[];
  const wallet = (account: Address) =>
    createWalletClient({ chain: foundry, transport: http(RPC), account });

  const deploy = async (c: { abi: Abi; bytecode: Hex }, args: unknown[] = []) => {
    const hash = await wallet(deployer).deployContract({ abi: c.abi, bytecode: c.bytecode, args });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success' || !r.contractAddress) throw new Error('deploy reverted');
    return r.contractAddress as Address;
  };
  const send = async (
    from: Address,
    address: Address,
    abi: Abi,
    functionName: string,
    args: unknown[],
  ) => {
    const hash = await wallet(from).writeContract({
      address,
      abi,
      functionName,
      args,
      gas: 500_000n,
    });
    return pub.waitForTransactionReceipt({ hash });
  };
  const errorName = async (
    from: Address,
    address: Address,
    abi: Abi,
    functionName: string,
    args: unknown[],
  ) => {
    try {
      await pub.simulateContract({ account: from, address, abi, functionName, args });
      return 'NO_REVERT';
    } catch (e) {
      const err = e as { cause?: { data?: { errorName?: string } }; shortMessage?: string };
      return err.cause?.data?.errorName ?? err.shortMessage ?? 'UNKNOWN';
    }
  };

  const token = await deploy(T);
  const router = await deploy(R, [token, treasury]);
  const bal = (a: Address) =>
    pub.readContract({
      address: token,
      abi: T.abi,
      functionName: 'balanceOf',
      args: [a],
    }) as Promise<bigint>;
  const ref = (s: string) => keccak256(toHex(s));
  const fund = async (who: Address) => {
    await send(deployer, token, T.abi, 'mint', [who, MAX_TOTAL * 10n]);
    await send(who, token, T.abi, 'approve', [router, maxUint256]);
  };
  await fund(payer);
  const results: string[] = [];
  const check = async (name: string, body: () => Promise<void>) => {
    await body();
    results.push(`ok  ${name}`);
  };
  const feeEvent = (logs: { address: Address; data: Hex; topics: [Hex, ...Hex[]] | [] }[]) =>
    logs
      .filter((l) => l.address.toLowerCase() === router.toLowerCase())
      .map((l) =>
        decodeEventLog({ abi: R.abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] }),
      );

  await check('immutables: token, treasury, cap, 10% fee; no owner functions', async () => {
    const read = (functionName: string) =>
      pub.readContract({ address: router, abi: R.abi, functionName });
    assert.equal(((await read('token')) as string).toLowerCase(), token.toLowerCase());
    assert.equal(((await read('treasury')) as string).toLowerCase(), treasury.toLowerCase());
    assert.equal(await read('MAX_TOTAL'), MAX_TOTAL);
    assert.equal(await read('FEE_BPS'), 1_000n);
    const writes = R.abi.filter(
      (x) => x.type === 'function' && x.stateMutability !== 'view' && x.stateMutability !== 'pure',
    );
    assert.deepEqual(writes.map((x) => (x as { name: string }).name).sort(), ['chargeFee', 'pay']);
  });

  await check('chargeFee: 10% of the listed price on top, to the treasury only', async () => {
    const r = await send(payer, router, R.abi, 'chargeFee', [seller, 90_000n, ref('c1')]);
    assert.equal(await bal(treasury), 9_000n);
    assert.equal(await bal(seller), 0n);
    assert.equal(await bal(payer), MAX_TOTAL * 10n - 9_000n);
    const [ev] = feeEvent(r.logs);
    assert.equal(ev.eventName, 'FeeCharged');
    const a = ev.args as unknown as {
      payer: Address;
      payee: Address;
      ref: Hex;
      kind: number;
      gross: bigint;
      fee: bigint;
    };
    assert.equal(a.payer.toLowerCase(), payer.toLowerCase());
    assert.equal(a.payee.toLowerCase(), seller.toLowerCase());
    assert.equal(a.ref, ref('c1'));
    assert.equal(a.kind, 0);
    assert.equal(a.gross, 90_000n);
    assert.equal(a.fee, 9_000n);
  });

  await check('pay: seller 90%, treasury 10%, router keeps nothing', async () => {
    const before = { s: await bal(seller), t: await bal(treasury), p: await bal(payer) };
    const r = await send(payer, router, R.abi, 'pay', [seller, 100_000n, ref('p1')]);
    assert.equal((await bal(seller)) - before.s, 90_000n);
    assert.equal((await bal(treasury)) - before.t, 10_000n);
    assert.equal(before.p - (await bal(payer)), 100_000n);
    assert.equal(await bal(router), 0n);
    const [ev] = feeEvent(r.logs);
    assert.equal((ev.args as unknown as { kind: number }).kind, 1);
  });

  await check('rounding: fee is floor(gross / 10); 19 -> 1, 50009 -> 5000', async () => {
    const t0 = await bal(treasury);
    await send(payer, router, R.abi, 'chargeFee', [seller, 19n, ref('r19')]);
    await send(payer, router, R.abi, 'pay', [seller, 50_009n, ref('r10')]);
    assert.equal((await bal(treasury)) - t0, 5_001n);
  });

  await check(
    'fee included: a price under the $0.05 minimum reverts BadAmount; exactly 50000 passes',
    async () => {
      assert.equal(
        await pub.readContract({ address: router, abi: R.abi, functionName: 'MIN_INCLUDED' }),
        50_000n,
      );
      assert.equal(
        await errorName(payer, router, R.abi, 'pay', [seller, 49_999n, ref('min1')]),
        'BadAmount',
      );
      assert.equal(
        await errorName(payer, router, R.abi, 'pay', [seller, 50_000n, ref('min2')]),
        'NO_REVERT',
      );
      // The fee-on-top path has no minimum (external prices are the seller's).
      assert.equal(
        await errorName(payer, router, R.abi, 'chargeFee', [seller, 10_000n, ref('min3')]),
        'NO_REVERT',
      );
    },
  );

  await check('replay: an identical retry reverts AlreadyCharged', async () => {
    assert.equal(
      await errorName(payer, router, R.abi, 'chargeFee', [seller, 90_000n, ref('c1')]),
      'AlreadyCharged',
    );
    assert.equal(
      await errorName(payer, router, R.abi, 'pay', [seller, 100_000n, ref('p1')]),
      'AlreadyCharged',
    );
  });

  await check(
    'replay: a changed retry (other method, amount or payee) reverts RefMismatch',
    async () => {
      for (const [fn, args] of [
        ['pay', [seller, 90_000n, ref('c1')]],
        ['chargeFee', [seller, 50_000n, ref('c1')]],
        ['chargeFee', [other, 90_000n, ref('c1')]],
        ['chargeFee', [seller, 100n, ref('p1')]],
      ] as const) {
        assert.equal(await errorName(payer, router, R.abi, fn, [...args]), 'RefMismatch');
      }
      const commitment = await pub.readContract({
        address: router,
        abi: R.abi,
        functionName: 'charged',
        args: [payer, ref('c1')],
      });
      assert.equal(
        commitment,
        keccak256(
          encodeAbiParameters(
            [{ type: 'address' }, { type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }],
            [seller, 0, 90_000n, 9_000n],
          ),
        ),
      );
    },
  );

  await check('same ref from another payer is independent', async () => {
    await fund(other);
    await send(other, router, R.abi, 'pay', [seller, 50_000n, ref('p1')]);
  });

  await check(
    `cap: one payment never takes more than ${ROUTER2 ? '$100' : '$0.10'} from the payer, fee included`,
    async () => {
      const cases: [string, bigint, string][] = [
        // the largest fee-on-top price whose total (gross + floor(gross / 10)) stays within the cap
        ['chargeFee', TOP_MAX, 'NO_REVERT'],
        ['chargeFee', TOP_MAX + 1n, 'BadAmount'],
        ['chargeFee', MAX_TOTAL, 'BadAmount'], // 100000 + 10000
        ['pay', MAX_TOTAL, 'NO_REVERT'], // fee included: total 100000
        ['pay', MAX_TOTAL + 1n, 'BadAmount'],
        ['chargeFee', 2n ** 255n, 'BadAmount'], // no overflow path
      ];
      for (const [fn, gross, want] of cases)
        assert.equal(
          await errorName(payer, router, R.abi, fn, [seller, gross, ref(`cap${fn}${gross}`)]),
          want,
          `${fn} ${gross}`,
        );
    },
  );

  await check(
    'dust: a price whose fee rounds to 0 reverts BadAmount (no fee-free payment)',
    async () => {
      assert.equal(
        await errorName(payer, router, R.abi, 'chargeFee', [seller, 9n, ref('d1')]),
        'BadAmount',
      );
      assert.equal(
        await errorName(payer, router, R.abi, 'pay', [seller, 0n, ref('d2')]),
        'BadAmount',
      );
    },
  );

  await check('payee zero or the treasury itself reverts ZeroAddress', async () => {
    assert.equal(
      await errorName(payer, router, R.abi, 'pay', [`0x${'0'.repeat(40)}`, 50_000n, ref('z1')]),
      'ZeroAddress',
    );
    assert.equal(
      await errorName(payer, router, R.abi, 'pay', [treasury, 50_000n, ref('z2')]),
      'ZeroAddress',
    );
  });

  await check(
    'a token transfer returning false reverts the whole payment (TransferFailed), ref stays unused',
    async () => {
      await send(deployer, token, T.abi, 'setFailNext', [true]);
      const r = await wallet(payer)
        .writeContract({
          address: router,
          abi: R.abi,
          functionName: 'pay',
          args: [seller, 50_000n, ref('f1')],
          gas: 500_000n,
        })
        .then((hash) => pub.waitForTransactionReceipt({ hash }));
      assert.equal(r.status, 'reverted');
      await send(deployer, token, T.abi, 'setFailNext', [false]);
      await send(payer, router, R.abi, 'pay', [seller, 50_000n, ref('f1')]);
    },
  );

  await check(
    'second transfer failure rolls back the first transfer and the replay commitment',
    async () => {
      const gross = 50_000n;
      const fee = gross / 10n;
      const paymentRef = ref('second-leg-failure');
      // Enough allowance for the seller leg, but not the treasury leg.
      await send(payer, token, T.abi, 'approve', [router, gross - fee]);
      const before = { s: await bal(seller), t: await bal(treasury), p: await bal(payer) };
      const receipt = await wallet(payer)
        .writeContract({
          address: router,
          abi: R.abi,
          functionName: 'pay',
          args: [seller, gross, paymentRef],
          gas: 500_000n,
        })
        .then((hash) => pub.waitForTransactionReceipt({ hash }));
      assert.equal(receipt.status, 'reverted');
      assert.equal(await bal(seller), before.s);
      assert.equal(await bal(treasury), before.t);
      assert.equal(await bal(payer), before.p);
      assert.equal(feeEvent(receipt.logs).length, 0);
      assert.equal(
        await pub.readContract({
          address: router,
          abi: R.abi,
          functionName: 'charged',
          args: [payer, paymentRef],
        }),
        `0x${'0'.repeat(64)}`,
      );
      await send(payer, token, T.abi, 'approve', [router, gross]);
      const retried = await send(payer, router, R.abi, 'pay', [seller, gross, paymentRef]);
      assert.equal(feeEvent(retried.logs).length, 1);
      assert.equal((await bal(seller)) - before.s, gross - fee);
      assert.equal((await bal(treasury)) - before.t, fee);
      assert.equal(before.p - (await bal(payer)), gross);
      await send(payer, token, T.abi, 'approve', [router, maxUint256]);
    },
  );

  await check(
    'no allowance: a third party cannot charge someone else (pulls only from msg.sender)',
    async () => {
      const [, , , , , stranger] = (await pub.request({ method: 'eth_accounts' })) as Address[];
      const p0 = await bal(payer);
      const r = await wallet(stranger)
        .writeContract({
          address: router,
          abi: R.abi,
          functionName: 'pay',
          args: [seller, 50_000n, ref('x1')],
          gas: 500_000n,
        })
        .then((hash) => pub.waitForTransactionReceipt({ hash }));
      assert.equal(r.status, 'reverted');
      assert.equal(await bal(payer), p0);
    },
  );

  await check(
    'constructor rejects a zero token or zero treasury; the cap is not configurable',
    async () => {
      const zero = `0x${'0'.repeat(40)}`;
      const ctor = R.abi.find((x) => x.type === 'constructor') as { inputs: unknown[] };
      assert.equal(ctor.inputs.length, 2);
      for (const args of [
        [zero, treasury],
        [token, zero],
      ]) {
        await assert.rejects(deploy(R, args));
      }
    },
  );

  await check(
    'conservation over 200 random prices: seller + treasury deltas == payer delta',
    async () => {
      const s0 = await bal(seller),
        t0 = await bal(treasury),
        p0 = await bal(payer);
      await send(deployer, token, T.abi, 'mint', [payer, MAX_TOTAL * 200n]);
      let total = 0n;
      for (let i = 0; i < 200; i++) {
        const gross = 50_000n + (BigInt(keccak256(toHex(`g${i}`))) % (MAX_TOTAL - 49_999n));
        total += gross;
        await send(payer, router, R.abi, 'pay', [seller, gross, ref(`fz${i}`)]);
      }
      const ds = (await bal(seller)) - s0,
        dt = (await bal(treasury)) - t0,
        dp = p0 + MAX_TOTAL * 200n - (await bal(payer));
      assert.equal(ds + dt, dp);
      assert.equal(dp, total);
      assert.equal(await bal(router), 0n);
    },
  );

  const gas = await pub.estimateContractGas({
    account: payer,
    address: router,
    abi: R.abi,
    functionName: 'chargeFee',
    args: [seller, 90_000n, ref('gas1')],
  });
  const gasPay = await pub.estimateContractGas({
    account: payer,
    address: router,
    abi: R.abi,
    functionName: 'pay',
    args: [seller, 90_000n, ref('gas2')],
  });
  console.log(results.join('\n'));
  console.log(
    `gas estimate: chargeFee ${gas}, pay ${gasPay} (TestToken; real USDC transfers cost more)`,
  );
  console.log(`ALL ${results.length} CHECKS PASSED`);
}

main().catch((e) => {
  console.error('CHECK FAILED', e?.message ?? e);
  process.exit(1);
});
