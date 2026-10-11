import { BASE_MAINNET, BASE_NETWORKS } from '../../shared/base/chains';
import {
  cityScore,
  scoreLine,
  type CityScore,
  type RatingFeedback,
} from '../../shared/base/rating-score';
import { number } from './countLogClient';
import {
  shortWallet,
  type OnBaseRow,
  type ScoreClaim,
  type VerifyResult,
  type VerifyTick,
} from './onBaseData';

/*
 * Verify, read from Base in this browser: plain JSON-RPC reads against Base's public endpoint.
 * No keys, no writes. Owner and tokenURI are read at one block B; the mint is proven from its own
 * receipt (the row's mintTx is only a hint). Any failure to reach Base, a timeout or an answer that
 * isn't JSON-RPC is 'unreachable': nothing is then shown as passed.
 *
 * "Confirmed by Central City" is ERC-8004's two-way binding: Base's tokenURI points to a
 * centralcity.ai passport, and the registration file at that exact address (never the list API)
 * names this Base ID in this registry. Each agent mints from its own account with its own key, so
 * no single Central City address could prove it on chain: this is Central City's endorsement now,
 * not a proof of who minted it, and the evidence says only that. The file lists a Base ID once it is
 * final, so while it finalizes a file without it is 'not yet', never a fail.
 *
 * On a passport with a Central City score, Verify also reads the rater wallets' feedback from the
 * Reputation Registry (readAllFeedback) and recomputes the score with the same shared function as
 * the server (shared/base/rating-score.ts): first at the block the passport was read at, else (a
 * public endpoint may not keep old state) at B. Which wallets are Central City agents comes from
 * the passport (Central City's record); the ratings and the arithmetic come from Base and this
 * browser. Not reading them leaves the score 'pending' and never touches the other checks.
 */

export const BASE_RPC = 'https://mainnet.base.org';
const CHAIN_ID = 8453;
export const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
/** ERC-4337 EntryPoint v0.6, the one Central City's mints go through. */
export const ENTRYPOINT = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';
const CENTRAL_CITY_URI = 'https://centralcity.ai/a/';
const TIMEOUT_MS = 8_000;

/** The ERC-8004 Reputation Registry on Base (shared/base/chains.ts). */
export const REPUTATION_REGISTRY = BASE_NETWORKS[BASE_MAINNET].contracts.reputationRegistry;

const SELECTOR = {
  ownerOf: '0x6352211e',
  tokenURI: '0xc87b56dd',
  /** readAllFeedback(uint256,address[],string,string,bool) */
  readAllFeedback: '0xd9d84224',
};
const TOPIC = {
  transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  userOperationEvent: '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f',
  /** EntryPoint v0.6: emitted once, after every operation's validation and before any runs. */
  beforeExecution: '0xbb47ee3e183a558b1a2ff0874b079f3fc5478b7454eacf2bfc5af2ff5878f972',
};

type Log = { address: string; topics: string[]; data: string; logIndex?: string };
type Receipt = { blockNumber: string; blockHash: string; logs: Log[] };
type Block = { number: string; hash: string };

/** Base answered with a JSON-RPC error. A revert is an answer ("no such token"), not an outage. */
class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
  get reverted() {
    return this.code === 3 || /revert/i.test(this.message);
  }
}

// ABI words, by hand: 32-byte words as 64 hex characters.
const word = (value: bigint) => value.toString(16).padStart(64, '0');
const words = (data: string) => {
  const body = data.slice(2);
  if (!/^0x([0-9a-f]{64})*$/i.test(data)) throw new Error('Not ABI words');
  return Array.from({ length: body.length / 64 }, (_, i) =>
    BigInt(`0x${body.slice(i * 64, i * 64 + 64)}`),
  );
};
const asAddress = (value: bigint) => `0x${value.toString(16).padStart(40, '0')}`;
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function decodeAddress(data: string) {
  const [value] = words(data);
  if (value === undefined || value >> 160n) throw new Error('Not an address');
  return asAddress(value);
}

function decodeString(data: string) {
  const body = data.slice(2);
  const all = words(data);
  const offset = Number(all[0] ?? -1);
  const length = Number(all[offset / 32] ?? -1);
  const start = (offset + 32) * 2;
  if (offset % 32 || length < 0 || start + length * 2 > body.length)
    throw new Error('Not a string');
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++)
    bytes[i] = parseInt(body.slice(start + i * 2, start + i * 2 + 2), 16);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

const hex = (value: number | bigint) => `0x${value.toString(16)}`;
const at = (block: number) => number.format(block);

/** readAllFeedback(id, clients, '', '', false): every tag, revoked entries left out. */
export function feedbackCall(baseId: string, clients: readonly string[]) {
  if (!/^[0-9]{1,78}$/.test(baseId) || clients.some((c) => !/^0x[0-9a-fA-F]{40}$/.test(c)))
    throw new Error('Not a Base ID and addresses');
  const head = 5 * 32;
  const clientsAt = BigInt(head);
  const tag1At = clientsAt + BigInt(32 * (clients.length + 1));
  const tag2At = tag1At + 32n;
  return [
    SELECTOR.readAllFeedback,
    word(BigInt(baseId)),
    word(clientsAt),
    word(tag1At),
    word(tag2At),
    word(0n),
    word(BigInt(clients.length)),
    ...clients.map((client) => word(BigInt(client))),
    word(0n),
    word(0n),
  ].join('');
}

/** One dynamic array of an answer: the word its elements start at, and how many there are. */
type Run = { start: number; length: number };

/**
 * readAllFeedback's answer, by hand: seven arrays of equal length (clients, indexes, values,
 * value decimals, tag1s, tag2s, revoked). Anything that doesn't decode throws.
 */
export function decodeFeedback(data: string): RatingFeedback[] {
  const all = words(data);
  const body = data.slice(2);
  const get = (i: number) => {
    const value = all[i];
    if (value === undefined) throw new Error('Out of range');
    return value;
  };
  /** The word index of a byte offset (a multiple of 32 inside the answer). */
  const wordAt = (offset: bigint, base = 0) => {
    if (offset % 32n || offset / 32n + BigInt(base) >= BigInt(all.length))
      throw new Error('Bad offset');
    return base + Number(offset / 32n);
  };
  /** The array the k-th head word points to: its elements' first word and its length. */
  const array = (k: number) => {
    const at = wordAt(get(k));
    const length = Number(get(at));
    if (at + 1 + length > all.length) throw new Error('Bad length');
    return { start: at + 1, length };
  };
  const [clients, indexes, values, decimals, tag1s, tag2s, revoked] = [0, 1, 2, 3, 4, 5, 6].map(
    array,
  ) as [Run, Run, Run, Run, Run, Run, Run];
  const n = clients.length;
  if ([indexes, values, decimals, tag1s, tag2s, revoked].some((list) => list.length !== n))
    throw new Error('Malformed feedback answer');
  const text = (list: { start: number }, i: number) => {
    // A string[] element is an offset from the first element word to its length word.
    const at = wordAt(get(list.start + i), list.start);
    const length = Number(get(at));
    const from = (at + 1) * 64;
    if (from + length * 2 > body.length) throw new Error('Not a string');
    const bytes = new Uint8Array(length);
    for (let j = 0; j < length; j++)
      bytes[j] = parseInt(body.slice(from + j * 2, from + j * 2 + 2), 16);
    return new TextDecoder().decode(bytes);
  };
  const entries: RatingFeedback[] = [];
  for (let i = 0; i < n; i++) {
    const client = get(clients.start + i);
    const decimal = get(decimals.start + i);
    const flag = get(revoked.start + i);
    if (client >> 160n || decimal > 255n || flag > 1n) throw new Error('Not feedback');
    const raw = get(values.start + i);
    entries.push({
      client: asAddress(client),
      // uint64: kept as a bigint, so indexes above 2^53 still compare exactly.
      index: get(indexes.start + i),
      // int128 as a signed 256-bit word.
      value: raw >> 255n ? raw - (1n << 256n) : raw,
      decimals: Number(decimal),
      tag1: text(tag1s, i),
      revoked: flag === 1n,
    });
  }
  return entries;
}

const scoreText = (score: CityScore | null) => (score ? scoreLine(score) : 'no rating');

export async function verify(
  row: Pick<OnBaseRow, 'baseId' | 'owner' | 'short' | 'mintTx' | 'status'>,
  options: { fetch?: typeof fetch; timeoutMs?: number; score?: ScoreClaim | null } = {},
): Promise<VerifyResult> {
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

  /** The registration file at the address Base holds: 'missing' on 404, null if unreadable. */
  async function registrationFile(uri: string) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Never this browser's own copy: a file read before the confirmation would still name nothing.
      const response = await send(uri, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
        signal: controller.signal,
      });
      if (response.status === 404) return 'missing' as const;
      if (!response.ok) return null;
      const file = (await response.json()) as { registrations?: unknown } | null;
      return file && typeof file === 'object' ? file : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await send(BASE_RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
      const body = (await response.json()) as {
        result?: T;
        error?: { code?: number; message?: string };
      } | null;
      if (!body || typeof body !== 'object') throw new Error(`${method}: not JSON-RPC`);
      if (body.error) throw new RpcError(body.error.code ?? 0, body.error.message ?? '');
      if (!('result' in body)) throw new Error(`${method}: no result`);
      return body.result as T;
    } finally {
      clearTimeout(timer);
    }
  }
  const call = (to: string, data: string, block: number) =>
    rpc<string>('eth_call', [{ to, data }, hex(block)]);
  // A revert is Base's answer (no such Base ID, not a smart account): a fail, never an outage.
  const unlessReverted = (read: Promise<string>) =>
    read.catch((error: unknown) => {
      if (error instanceof RpcError && error.reverted) return null;
      throw error;
    });

  /**
   * The passport's score against Base: the claimed rater wallets' feedback, read at the passport's
   * block and else at B, recomputed here. Never rejects: not read is 'pending'.
   */
  async function scoreTick(claim: ScoreClaim, B: number): Promise<VerifyTick> {
    // No rater wallets named: cityScore(entries, []) is null whatever Base holds, so the score
    // fails without a read (an empty list would make readAllFeedback return everyone's feedback).
    if (claim.scoredBy.length === 0)
      return {
        state: 'fail',
        evidence: `The passport names no rater wallets, so nothing on Base backs it; the passport says ${scoreLine(claim.score)}`,
      };
    let data: string;
    try {
      data = feedbackCall(row.baseId, claim.scoredBy);
    } catch {
      return { state: 'fail', evidence: "The passport's rater wallets aren't addresses" };
    }
    const blocks = [claim.readAtBlock, B].filter(
      (block, i, all): block is number => block !== null && block <= B && all.indexOf(block) === i,
    );
    for (const block of blocks) {
      let entries: RatingFeedback[];
      try {
        entries = decodeFeedback(await call(REPUTATION_REGISTRY, data, block));
      } catch {
        continue;
      }
      const found = cityScore(entries, claim.scoredBy, claim.agentWallet);
      const match =
        found !== null &&
        found.average === claim.score.average &&
        found.raters === claim.score.raters;
      const read = `on Base at block ${at(block)}`;
      const since =
        claim.readAtBlock !== null && block !== claim.readAtBlock
          ? ` (the passport read block ${at(claim.readAtBlock)})`
          : '';
      return match
        ? {
            state: 'pass',
            evidence: `${scoreLine(found)}: the latest rating of each wallet the passport names, recomputed ${read}`,
          }
        : {
            state: 'fail',
            evidence: `${scoreText(found)} ${read} from the wallets the passport names; the passport says ${scoreLine(claim.score)}${since}`,
          };
    }
    return { state: 'pending', evidence: "Couldn't read the ratings from Base just now" };
  }

  try {
    const id = BigInt(row.baseId);
    const [chainId, latest] = await Promise.all([
      rpc<string>('eth_chainId', []),
      rpc<string>('eth_blockNumber', []),
    ]);
    if (Number(chainId) !== CHAIN_ID) return { kind: 'unreachable' };
    const B = Number(latest);
    const idWord = word(id);
    // The mint hint may be absent (no record of it): then there is no receipt to read.
    const mintTx = row.mintTx ?? '';
    const validHash = /^0x[0-9a-f]{64}$/i.test(mintTx);

    const [ownerHex, uriHex, receipt, finalized, score] = await Promise.all([
      unlessReverted(call(IDENTITY_REGISTRY, `${SELECTOR.ownerOf}${idWord}`, B)),
      unlessReverted(call(IDENTITY_REGISTRY, `${SELECTOR.tokenURI}${idWord}`, B)),
      validHash
        ? rpc<Receipt | null>('eth_getTransactionReceipt', [mintTx])
        : Promise.resolve(null),
      rpc<Block>('eth_getBlockByNumber', ['finalized', false]),
      options.score ? scoreTick(options.score, B) : Promise.resolve(undefined),
    ]);
    const scored = score ? { score } : {};

    // 1. Owner at B.
    let owner: VerifyTick;
    if (ownerHex === null)
      owner = {
        state: 'fail',
        evidence: `ownerOf(${row.baseId}) reverted on Base at block ${at(B)}: no such Base ID`,
      };
    else {
      const holder = decodeAddress(ownerHex);
      const match = sameAddress(holder, row.owner);
      owner = {
        state: match ? 'pass' : 'fail',
        evidence: `ownerOf(${row.baseId}) on Base = ${shortWallet(match ? row.owner : holder)} at block ${at(B)}`,
      };
    }

    // 2. tokenURI at B.
    let uri: VerifyTick;
    if (uriHex === null)
      uri = {
        state: 'fail',
        evidence: `tokenURI(${row.baseId}) reverted on Base at block ${at(B)}`,
      };
    else {
      const found = decodeString(uriHex);
      uri = {
        state: found === `${CENTRAL_CITY_URI}${row.short}` ? 'pass' : 'fail',
        evidence: `tokenURI(${row.baseId}) on Base = ${found || '(empty)'} at block ${at(B)}`,
      };
    }

    if (!receipt) {
      const missing: VerifyTick = {
        state: 'fail',
        evidence: mintTx
          ? 'No such mint transaction on Base'
          : "Central City didn't give its mint transaction",
      };
      return {
        kind: 'checked',
        owner,
        uri,
        registeredBy: missing,
        final: missing,
        ...scored,
        block: B,
        rpc: BASE_RPC,
      };
    }
    const N = Number(receipt.blockNumber);

    // 3. Confirmed by Central City: the mint of this id (Transfer from 0 to account A, from the
    // registry) ran inside A's own successful UserOperation, and the passport file at the address
    // Base holds names this Base ID in this registry.
    // EntryPoint v0.6 runs a bundle's operations one after another, each followed by its own
    // UserOperationEvent, all after one BeforeExecution: the first UserOperationEvent after the
    // mint is the operation the mint ran in.
    const logs = [...receipt.logs].sort((a, b) =>
      a.logIndex && b.logIndex ? Number(a.logIndex) - Number(b.logIndex) : 0,
    );
    const fromEntryPoint = (log: Log, topic: string) =>
      sameAddress(log.address, ENTRYPOINT) && log.topics[0]?.toLowerCase() === topic;
    const mintAt = logs.findIndex(
      (log) =>
        sameAddress(log.address, IDENTITY_REGISTRY) &&
        log.topics.length === 4 &&
        log.topics[0]?.toLowerCase() === TOPIC.transfer &&
        BigInt(log.topics[1]!) === 0n &&
        BigInt(log.topics[3]!) === id,
    );
    const mint = mintAt === -1 ? undefined : logs[mintAt];
    const account = mint ? asAddress(BigInt(mint.topics[2]!)) : null;
    const executionAt = logs.findIndex((log) => fromEntryPoint(log, TOPIC.beforeExecution));
    const op =
      mint && executionAt !== -1 && executionAt < mintAt
        ? logs.slice(mintAt + 1).find((log) => fromEntryPoint(log, TOPIC.userOperationEvent))
        : undefined;
    const sentByAccount =
      account !== null &&
      op?.topics[2] !== undefined &&
      sameAddress(asAddress(BigInt(op.topics[2])), account) &&
      words(op.data)[1] === 1n;
    const passportUri = uri.state === 'pass' ? `${CENTRAL_CITY_URI}${row.short}` : null;
    const [canonical, file] = await Promise.all([
      rpc<Block | null>('eth_getBlockByNumber', [hex(N), false]),
      account && sentByAccount && passportUri
        ? registrationFile(passportUri)
        : Promise.resolve(null),
    ]);

    // The file lists confirmed ids only: while finalizing (on Base, or in the list), wait for it.
    const finalizing = row.status === 'finalizing' || Number(finalized.number) < N;
    const shown = passportUri?.replace(/^https:\/\//, '');
    let registeredBy: VerifyTick;
    if (!account)
      registeredBy = {
        state: 'fail',
        evidence: `Transaction ${shortWallet(mintTx)} didn't mint Base ID ${row.baseId} on Base`,
      };
    else if (!sentByAccount)
      registeredBy = {
        state: 'fail',
        evidence: `Minted to ${shortWallet(account)}, but not in its own successful operation`,
      };
    else if (!passportUri)
      registeredBy = {
        state: 'fail',
        evidence: `Its address on Base isn't a centralcity.ai passport`,
      };
    else if (file === null)
      registeredBy = {
        state: 'pending',
        evidence: `Minted to account ${shortWallet(account)} in its own operation; couldn't read ${shown} from your browser`,
      };
    else if (file === 'missing') registeredBy = { state: 'fail', evidence: `${shown} isn't there` };
    else {
      const registry = `eip155:${CHAIN_ID}:${IDENTITY_REGISTRY}`.toLowerCase();
      const named =
        Array.isArray(file.registrations) &&
        file.registrations.some(
          (entry: { agentId?: unknown; agentRegistry?: unknown } | null) =>
            entry !== null &&
            typeof entry === 'object' &&
            String(entry.agentId) === row.baseId &&
            String(entry.agentRegistry).toLowerCase() === registry,
        );
      registeredBy = named
        ? {
            state: 'pass',
            evidence: `${shown} names Base ID ${row.baseId} now; minted to account ${shortWallet(account)} in its own operation, block ${at(N)}`,
          }
        : finalizing
          ? {
              state: 'pending',
              evidence: `Minted to account ${shortWallet(account)} in its own operation, block ${at(N)}; ${shown} lists it once final`,
            }
          : { state: 'fail', evidence: `${shown} doesn't name Base ID ${row.baseId}` };
    }

    // 4. Final: this transaction minted this Base ID (the row's mintTx is only a hint), and its
    // block is still canonical and at or below Base's finalized block.
    const F = Number(finalized.number);
    let final: VerifyTick;
    if (!mint)
      final = {
        state: 'fail',
        evidence: `Transaction ${shortWallet(mintTx)} didn't mint Base ID ${row.baseId} on Base`,
      };
    else if (!canonical || canonical.hash.toLowerCase() !== receipt.blockHash.toLowerCase())
      final = {
        state: 'fail',
        evidence: `Block ${at(N)} on Base no longer holds the mint (its hash changed)`,
      };
    else if (F >= N)
      final = {
        state: 'pass',
        evidence: `Block ${at(N)} is canonical and at or below finalized block ${at(F)}`,
      };
    else
      final = {
        state: 'pending',
        evidence: `Included in block ${at(N)}; Base finalizes it in about 15–30 min`,
      };

    return { kind: 'checked', owner, uri, registeredBy, final, ...scored, block: B, rpc: BASE_RPC };
  } catch {
    return { kind: 'unreachable' };
  }
}
