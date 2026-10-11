/*
 * The fleet manifest: the ordered list of agents a signed run covers, bound into the run's
 * `manifestHash` (docs/base/ARCHITECTURE.md §11.4). The owner signs the hash; the server recomputes
 * it from stored wallets before creating the job, so a run can never cover other agents, owners or
 * wallets than the ones that were signed.
 *
 *   ManifestEntry = (uint32 ordinal, bytes16 agentId, address owner, address wallet, uint16 derivationVersion)
 *   manifestHash  = keccak256(abi.encode(ManifestEntry[]))
 */
import { encodeAbiParameters, getAddress, keccak256, type Hex } from 'viem';

export interface ManifestEntry {
  ordinal: number;
  /** Agent UUID (lowercase, hyphenated). */
  agentId: string;
  owner: string;
  wallet: string;
  derivationVersion: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class ManifestError extends Error {}

/** Validates order and uniqueness; throws ManifestError on any problem. */
export function checkManifest(entries: readonly ManifestEntry[]): void {
  if (entries.length === 0) throw new ManifestError('A manifest lists at least one agent.');
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    if (entry.ordinal !== index) throw new ManifestError('Ordinals must run 0..n-1 in order.');
    if (!UUID.test(entry.agentId)) throw new ManifestError('Agent ids are lowercase UUIDs.');
    if (seen.has(entry.agentId)) throw new ManifestError('Each agent appears once.');
    seen.add(entry.agentId);
    if (
      !Number.isInteger(entry.derivationVersion) ||
      entry.derivationVersion < 1 ||
      entry.derivationVersion > 0xffff
    )
      throw new ManifestError('Invalid derivation version.');
    getAddress(entry.owner);
    getAddress(entry.wallet);
  });
}

export function manifestHash(entries: readonly ManifestEntry[]): Hex {
  checkManifest(entries);
  return keccak256(
    encodeAbiParameters(
      [
        {
          type: 'tuple[]',
          components: [
            { name: 'ordinal', type: 'uint32' },
            { name: 'agentId', type: 'bytes16' },
            { name: 'owner', type: 'address' },
            { name: 'wallet', type: 'address' },
            { name: 'derivationVersion', type: 'uint16' },
          ],
        },
      ],
      [
        entries.map((entry) => ({
          ordinal: entry.ordinal,
          agentId: `0x${entry.agentId.replaceAll('-', '')}` as Hex,
          owner: getAddress(entry.owner),
          wallet: getAddress(entry.wallet),
          derivationVersion: entry.derivationVersion,
        })),
      ],
    ),
  );
}
