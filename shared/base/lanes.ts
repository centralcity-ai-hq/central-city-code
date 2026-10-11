/*
 * Nonce lanes for owner operations (pay without waiting; behind CITY_BASE_LANES=1). An ERC-4337
 * (EntryPoint v0.6) nonce is `key << 64 | seq`: operations under different keys never wait for each
 * other. Each owner operation gets its own key, derived from its id, so no two operations share a
 * lane and one never holds up the next. A cancel is the no-op at exactly the nonce of the operation
 * it cancels (same key, same seq), so only one of the two can ever land.
 *
 * The browser derives the key itself from the operation's id; a key the server names is never
 * taken on trust.
 */
import { sha256, stringToBytes } from 'viem';

/** Domain of the derivation: the key is the high 192 bits of SHA-256 over this and the id. */
export const LANE_DOMAIN = 'cc.op.v1:';

/**
 * Coinbase Smart Wallet's REPLAYABLE_NONCE_KEY: operations under it are meant to be replayed on
 * every chain the wallet is on. No owner operation may ever use it.
 */
export const REPLAYABLE_NONCE_KEY = 8453n;

/** The wallet's shared, sequential lane (one operation at a time): never a lane of its own. */
export const SEQUENTIAL_NONCE_KEY = 0n;

const SEQ_BITS = 64n;
const SEQ_MASK = (1n << SEQ_BITS) - 1n;
const KEY_MAX = (1n << 192n) - 1n;

/** The key (lane) of a v0.6 nonce: its high 192 bits. */
export const nonceKeyOf = (nonce: bigint): bigint => nonce >> SEQ_BITS;

/** The sequence within its lane: the low 64 bits. */
export const nonceSeqOf = (nonce: bigint): bigint => nonce & SEQ_MASK;

/** A key an operation may have its own lane under: not the shared lane, not the replayable one. */
export function usableLaneKey(key: bigint): boolean {
  return key > SEQUENTIAL_NONCE_KEY && key <= KEY_MAX && key !== REPLAYABLE_NONCE_KEY;
}

/** The operation's lane can't be derived (an empty id, or a key no operation may use). */
export class LaneKeyError extends Error {}

/**
 * The lane key of the owner operation `withdrawalId`:
 * BigInt('0x' + sha256hex(utf8('cc.op.v1:' + withdrawalId))) >> 64n. Throws LaneKeyError rather
 * than ever return 0 or 8453.
 */
export function laneKey(withdrawalId: string): bigint {
  if (typeof withdrawalId !== 'string' || !withdrawalId)
    throw new LaneKeyError('An operation without an id has no lane.');
  const key = BigInt(sha256(stringToBytes(`${LANE_DOMAIN}${withdrawalId}`))) >> SEQ_BITS;
  if (!usableLaneKey(key)) throw new LaneKeyError('This operation’s lane isn’t one it may use.');
  return key;
}

/** The nonce at `seq` in the operation's own lane. */
export const laneNonce = (withdrawalId: string, seq = 0n): bigint =>
  (laneKey(withdrawalId) << SEQ_BITS) | (seq & SEQ_MASK);
