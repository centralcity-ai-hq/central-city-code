/*
 * Puts the contracts Arc lacks at their Base addresses by replaying Base's own deploy transactions:
 * each went through a keyless deterministic deployer, so the same input gives the same address from
 * any sender, with nothing compiled and no constructor argument of ours (docs/arc/STRATEGY.md).
 *
 *   npx tsx scripts/arc/replay-deploys.ts --chain 5042002            what is missing; sends nothing
 *   ARC_TESTNET_DEPLOYER_KEY=<throwaway, never printed> \
 *     npx tsx scripts/arc/replay-deploys.ts --chain 5042002 --send   testnet only
 *   npx tsx scripts/arc/replay-deploys.ts --chain 5042               the owner's list for mainnet
 *
 * Mainnet is never sent from here: it prints each transaction for the owner to send. Every step is
 * proven first (the input's own CREATE2 address, then a dry run on the target chain) and read back
 * after: the deployed code must equal Base's, byte for byte, except where a contract keeps its own
 * chain id and EIP-712 domain separator as immutables, and those must be this chain's.
 */
import { pathToFileURL } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  getContractAddress,
  http,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { BASE_MAINNET } from '../../shared/base/chains.js';
import { ARC_MAINNET, ARC_NETWORKS, ARC_TESTNET, type ArcChainId } from '../../shared/chains.js';

export interface Replay {
  name: string;
  address: Address;
  /** Its deploy transaction on Base mainnet. */
  baseTx: Hex;
  /** A contract that keeps its chain id and EIP-712 domain separator in its code. */
  eip712?: { name: string; version: string };
}

/** In dependency order: the factory names its implementation, the manager its validator. */
export const REPLAYS: readonly Replay[] = [
  {
    name: 'CoinbaseSmartWallet implementation',
    address: '0x000100abaad02f1cfC8Bbe32bD5a564817339E72',
    baseTx: '0x9494912bec8868fb623313c208d42fa427e4c2bd20babc555ab0ba5a6a56b11f',
  },
  {
    name: 'CoinbaseSmartWalletFactory',
    address: '0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a',
    baseTx: '0x5a9387581d2b47ca24d92a923da31d054b1b204629a582d00fab575f3cb2a62c',
  },
  {
    name: 'PublicERC6492Validator',
    address: '0xcfCE48B757601F3f351CB6f434CB0517aEEE293D',
    baseTx: '0x0f0598a34625885a55ae213c041f36c45f58804e112c2e71e9348cc7a8602db7',
  },
  {
    name: 'SpendPermissionManager',
    address: '0xf85210B21cC50302F477BA56686d2019dC9b67Ad',
    baseTx: '0x51375eaecaa66bea983ee52ccc8f8011a75fd191e5ab004baa3e3b9835b04b0c',
    eip712: { name: 'Spend Permission Manager', version: '1' },
  },
];

/** Where a deploy input lands: both deployers take a 32-byte salt, then the init code, no selector. */
export function replayAddress(deployer: Address, input: Hex): Address {
  return getContractAddress({
    opcode: 'CREATE2',
    from: deployer,
    salt: `0x${input.slice(2, 66)}`,
    bytecode: `0x${input.slice(66)}`,
  });
}

const DOMAIN_TYPE = keccak256(
  toBytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
);

function domainSeparator(replay: Replay, chainId: number): string {
  const { name, version } = replay.eip712!;
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      [
        DOMAIN_TYPE,
        keccak256(toBytes(name)),
        keccak256(toBytes(version)),
        BigInt(chainId),
        replay.address,
      ],
    ),
  ).slice(2);
}

/**
 * Base's code as it must read on `chainId`. Each immutable must be found exactly once in Base's
 * code, or the contract isn't what this script knows, and it says so instead of guessing.
 */
export function expectedCode(replay: Replay, baseCode: Hex, chainId: number): Hex {
  if (!replay.eip712) return baseCode;
  const word = (id: number) => id.toString(16).padStart(64, '0');
  let code: string = baseCode;
  for (const [from, to] of [
    [domainSeparator(replay, BASE_MAINNET), domainSeparator(replay, chainId)],
    [word(BASE_MAINNET), word(chainId)],
  ] as const) {
    if (code.split(from).length !== 2)
      throw new Error(`${replay.name}: ${from} not once in Base's code.`);
    code = code.replace(from, to);
  }
  return code as Hex;
}

async function main() {
  const args = process.argv.slice(2);
  const chainId = Number(args[args.indexOf('--chain') + 1]);
  if (chainId !== ARC_MAINNET && chainId !== ARC_TESTNET)
    throw new Error('--chain 5042 or 5042002');
  const send = args.includes('--send');
  if (send && chainId !== ARC_TESTNET) throw new Error('Mainnet is sent by the owner, never here.');
  const network = ARC_NETWORKS[chainId as ArcChainId];
  const base = createPublicClient({ transport: http('https://mainnet.base.org') });
  const arc = createPublicClient({ transport: http(network.publicRpcUrl) });
  const key = process.env.ARC_TESTNET_DEPLOYER_KEY as Hex | undefined;
  if (send && !key) throw new Error('ARC_TESTNET_DEPLOYER_KEY is not set.');
  const account = send ? privateKeyToAccount(key!) : null;
  const wallet = account
    ? createWalletClient({
        account,
        transport: http(network.publicRpcUrl),
        chain: {
          id: chainId,
          name: network.name,
          nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
          rpcUrls: { default: { http: [network.publicRpcUrl] } },
        },
      })
    : null;

  for (const replay of REPLAYS) {
    const baseCode = await base.getCode({ address: replay.address });
    if (!baseCode) throw new Error(`${replay.name}: no code on Base.`);
    const expected = expectedCode(replay, baseCode, chainId);
    const present = await arc.getCode({ address: replay.address });
    if (present && present !== '0x') {
      if (present !== expected) throw new Error(`${replay.name}: other code at its address.`);
      console.log(`${replay.name}: already there, the code Base's deploy gives here.`);
      continue;
    }
    const tx = await base.getTransaction({ hash: replay.baseTx });
    if (!tx.to) throw new Error(`${replay.name}: not a deployer call.`);
    if (replayAddress(tx.to, tx.input).toLowerCase() !== replay.address.toLowerCase())
      throw new Error(`${replay.name}: the input does not land on its address.`);
    const deployerCode = await arc.getCode({ address: tx.to });
    if (!deployerCode || deployerCode === '0x')
      throw new Error(`${replay.name}: no deployer here.`);
    const gas = await arc.estimateGas({
      account: account?.address ?? '0x00000000000000000000000000000000000000a1',
      to: tx.to,
      data: tx.input,
    });
    console.log(`${replay.name}: missing. Sends to ${tx.to}, estimated gas ${gas}.`);
    if (!wallet) {
      if (chainId === ARC_MAINNET) console.log(`  to: ${tx.to}\n  data: ${tx.input}`);
      continue;
    }
    const hash = await wallet.sendTransaction({
      to: tx.to,
      data: tx.input,
      gas: (gas * 12n) / 10n,
      maxFeePerGas: network.minMaxFeePerGasWei * 3n,
      maxPriorityFeePerGas: network.minMaxFeePerGasWei / 10n,
    });
    const receipt = await arc.waitForTransactionReceipt({ hash });
    const landed = await arc.getCode({ address: replay.address });
    if (receipt.status !== 'success' || landed !== expected)
      throw new Error(`${replay.name}: ${hash} did not leave the expected code.`);
    console.log(`  deployed in ${hash}, gas ${receipt.gasUsed}, code as expected.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
