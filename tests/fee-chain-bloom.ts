/*
 * The header and by-hash reads of a fake fee chain (server/protocol/fees/ledger.ts FeeChain), built
 * from the logs the fake holds: each block's logsBloom is computed from its logs exactly as a node
 * does (address and every topic, three bits each), and a read by hash returns that block's logs.
 */
import { bytesToHex, hexToBytes, keccak256, type Hex } from 'viem';
import type { ChainLog, FeeChain } from '../server/protocol/fees/ledger.js';

/** The Ethereum logsBloom of `logs` (2048 bits). */
export function bloomOf(logs: readonly Pick<ChainLog, 'address' | 'topics'>[]): Hex {
  const filter = new Uint8Array(256);
  for (const log of logs)
    for (const value of [log.address, ...log.topics]) {
      const h = hexToBytes(keccak256(value));
      for (let i = 0; i < 6; i += 2) {
        const bit = ((h[i]! << 8) | h[i + 1]!) & 0x7ff;
        filter[255 - (bit >> 3)]! |= 1 << (bit & 7);
      }
    }
  return bytesToHex(filter);
}

/** header and logsAtHash over the fake's logs; `hashOf` is the fake's canonical hash at a height. */
export function bloomReads(
  logs: () => readonly ChainLog[],
  hashOf: (blockNumber: bigint) => Hex | Promise<Hex>,
): Pick<FeeChain, 'header' | 'logsAtHash'> {
  return {
    header: async (blockNumber) => ({
      hash: await hashOf(blockNumber),
      logsBloom: bloomOf(logs().filter((l) => l.blockNumber === blockNumber)),
    }),
    logsAtHash: async (blockHash, addresses) =>
      logs().filter(
        (l) =>
          l.blockHash.toLowerCase() === blockHash.toLowerCase() &&
          addresses.some((a) => a.toLowerCase() === l.address.toLowerCase()),
      ),
  };
}
