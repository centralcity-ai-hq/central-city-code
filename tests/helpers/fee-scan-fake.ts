import { PGlite } from '@electric-sql/pglite';
import { encodeAbiParameters, encodeEventTopics, keccak256, toHex, type Hex } from 'viem';
import { arcChainIdsMigrations } from '../../server/base/arc-chain-ids-schema.js';
import type { Database } from '../../server/database.js';
import {
  FEE_EVENTS_ABI,
  PROTOCOL_FEE_LEDGER_SQL,
  type ChainLog,
  type FeeChain,
  type FeeLedgerConfig,
} from '../../server/protocol/fees/ledger.js';
import { bloomReads } from '../fee-chain-bloom.js';

/* A fee chain that writes down every request it gets, for the tests that count a scan's requests. */
export const ROUTER = '0x0000000000000000000000000000000000000a33' as Hex;
export const USDC = '0x0000000000000000000000000000000000000c01' as Hex;
export const TREASURY = '0x00000000000000000000000000000000000007e5' as Hex;
const PAYER = '0x00000000000000000000000000000000000000a1' as Hex;
const PAYEE = '0x00000000000000000000000000000000000005e1' as Hex;

export const feeConfig = (chainId: number, startBlock = 1000n): FeeLedgerConfig => ({
  chainId,
  usdc: USDC,
  treasury: TREASURY,
  router: ROUTER,
  escrow: null,
  startBlock,
});

/** A treasury transfer in `block`, alone (not a fee). */
export function treasuryTransfer(block: bigint, tag = 'fee'): ChainLog {
  return {
    address: USDC,
    topics: encodeEventTopics({
      abi: FEE_EVENTS_ABI,
      eventName: 'Transfer',
      args: { from: PAYER, to: TREASURY },
    }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }], [10_000n]),
    transactionHash: keccak256(toHex(`tx-${tag}-${block}`)),
    logIndex: 0,
    blockNumber: block,
    blockHash: keccak256(toHex(`block-${block}`)),
  };
}

/** A router fee in `block`: its FeeCharged event and the treasury transfer that backs it. */
export function feeAt(block: bigint): ChainLog[] {
  const transfer = treasuryTransfer(block);
  return [
    transfer,
    {
      ...transfer,
      address: ROUTER,
      logIndex: 1,
      topics: encodeEventTopics({
        abi: FEE_EVENTS_ABI,
        eventName: 'FeeCharged',
        args: { payer: PAYER, payee: PAYEE, ref: keccak256(toHex(`ref-${block}`)) },
      }) as Hex[],
      data: encodeAbiParameters(
        [{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }],
        [1, 100_000n, 10_000n],
      ),
    },
  ];
}

export function countingChain(state: {
  logs: ChainLog[];
  latest: bigint;
  finalized: bigint;
  /** Throw this for a request: return an error to refuse it (the request is still written down). */
  refuse?: (request: string) => unknown;
}) {
  const requests: string[] = [];
  const asked = (request: string) => {
    requests.push(request);
    const error = state.refuse?.(request);
    if (error) throw error;
  };
  const hashOf = (n: bigint) => keccak256(toHex(`block-${n}`));
  const bloom = bloomReads(() => state.logs, hashOf);
  const chain: FeeChain = {
    latestBlock: async () => (asked('latest'), state.latest),
    finalizedBlock: async () => (asked('finalized'), state.finalized),
    block: async (n) => (asked(`block ${n}`), { timestamp: 1_791_936_000n + n, hash: hashOf(n) }),
    header: async (n) => (asked(`header ${n}`), bloom.header(n)),
    logsAtHash: async (hash, addresses) => (
      asked(`hash ${hash}`),
      bloom.logsAtHash(hash, addresses)
    ),
    getLogs: async ({ address, fromBlock, toBlock }) => {
      asked(`logs ${address.toLowerCase()} ${fromBlock}-${toBlock}`);
      return state.logs.filter(
        (l) =>
          l.address.toLowerCase() === address.toLowerCase() &&
          l.blockNumber >= fromBlock &&
          l.blockNumber <= toBlock,
      );
    },
  };
  return { chain, requests };
}

export async function feeDb(t: { after: (fn: () => Promise<unknown>) => void }) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(PROTOCOL_FEE_LEDGER_SQL);
  for (const m of arcChainIdsMigrations)
    if (/protocol_fee_(events|scan_state)_chain/.test(m.sql))
      await pg.exec(m.sql.replace(/SET LOCAL[^;]*;/, ''));
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  return { db, pg };
}
