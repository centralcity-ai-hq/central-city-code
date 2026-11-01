/*
 * The server's own reads of Base for the On Base list: the latest block (totals.readAtBlock) and
 * ownerOf of the listed ids at that block (row.owner), and a passport's feedback in the Reputation
 * Registry. Read only: eth_chainId once per endpoint, then eth_blockNumber, one eth_call per page
 * (Multicall3 aggregate3 over the canonical registry's ownerOf) and a bounded few per passport
 * (getClients, getLastIndex through aggregate3, then readAllFeedback of at most FEEDBACK_READ_MAX
 * entries, or past that bound each rater wallet's newest entries one by one with readFeedback).
 * The URL may carry a key (the CDP endpoint), so it is never logged or returned.
 */
import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  fallback,
  getAddress,
  http,
  multicall3Abi,
  parseAbi,
  type Address,
  type EIP1193RequestFn,
  type Hex,
  type Transport,
} from 'viem';
import { identityRegistryAbi } from '../chain/identity-chain.js';
import { secureEndpoint } from '../chain/read-transport.js';
import { BASE_MAINNET, BASE_NETWORKS, MULTICALL3 } from '../../../shared/base/chains.js';
import { PUBLIC_BASE_RPC } from '../../../shared/base/on-base.js';
import { starsOf } from '../../../shared/base/rating-score.js';

export { MULTICALL3 };

/** The ERC-8004 Reputation Registry feedback read (erc-8004-contracts v1 ABI). */
export const reputationReadAbi = parseAbi([
  'function readAllFeedback(uint256 agentId, address[] clientAddresses, string tag1, string tag2, bool includeRevoked) view returns (address[] clients, uint64[] feedbackIndexes, int128[] values, uint8[] valueDecimals, string[] tag1s, string[] tag2s, bool[] revokedStatuses)',
]);
/** One client's feedback entry by its index (erc-8004-contracts v1 ABI). */
export const reputationEntryAbi = parseAbi([
  'function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex) view returns (int128 value, uint8 valueDecimals, string tag1, string tag2, bool isRevoked)',
]);
/** The registry's client list and per-client counts, read first to bound the feedback read. */
export const reputationClientsAbi = parseAbi([
  'function getClients(uint256 agentId) view returns (address[])',
  'function getLastIndex(uint256 agentId, address clientAddress) view returns (uint64)',
]);

/**
 * The most feedback entries one passport read asks Base for in one readAllFeedback. Anyone but
 * the owner can give feedback and each entry is cheap to add, so one unbounded readAllFeedback
 * could grow past an RPC's gas, size or time limit and leave the passport unread. Above this the
 * read takes each rater wallet's newest entries on their own (RATER_ENTRIES_MAX each), then the
 * newest other clients that fit, each with all of its entries or none.
 */
export const FEEDBACK_READ_MAX = 200;
/** The most clients whose entry count one read asks for (getLastIndex, in calls of 500). */
export const FEEDBACK_CLIENTS_MAX = 1_000;
const FEEDBACK_CLIENTS_CHUNK = 500;
/**
 * Past FEEDBACK_READ_MAX: how many of a rater wallet's newest entries are read, newest first,
 * until one is a rating that counts (shared/base/rating-score.ts starsOf). Each rater gets the
 * same few reads, so no rater's number of entries can push another rater out of the score.
 */
export const RATER_ENTRIES_MAX = 3;
/** readFeedback calls per aggregate3 call. */
const RATER_CALLS_CHUNK = 100;
/**
 * How long getClients may take. The list grows with every address that ever gave the agent
 * feedback and never shrinks; past this (or when it fails) the read goes on with the rater
 * wallets Central City's records know for the id, and says so (bounded).
 */
export const CLIENTS_READ_MS = 1_500;

/** One feedback entry as the Reputation Registry stores it. */
export interface FeedbackRead {
  client: string;
  /** The client's feedback index (uint64): a bigint, exact above 2^53. */
  index: bigint;
  value: bigint;
  decimals: number;
  tag1: string;
  tag2: string;
}

/** A passport's feedback read: the entries read and how many there are on Base. */
export interface FeedbackReads {
  entries: FeedbackRead[];
  /**
   * The entries on Base. entries.length when every client was read (revoked ones left out);
   * otherwise the registry's count for every client asked (revoked ones included) plus one for
   * each client not asked.
   */
  total: number;
  /**
   * True when not every entry was read: past the FEEDBACK_READ_MAX bound, an answer too large to
   * read whole, or a client list that could not be read (the rater wallets in the records only).
   */
  bounded: boolean;
  /**
   * Rater wallets (`prefer`) with entries whose rating could not be read: none of their newest
   * RATER_ENTRIES_MAX entries counts and older ones are left, or an entry was too large to answer
   * (or left unread once the read's FEEDBACK_SPLIT_CALLS_MAX was spent).
   */
  ratersSkipped: number;
}

export interface OnBaseChainReader {
  head(): Promise<{ block: bigint }>;
  /**
   * ownerOf(id) for every id at `block`: the owner, or null only when ownerOf itself reverted for
   * that id (the registry has no such token). Rejects on anything else: a transport, HTTP or RPC
   * error, or an answer that does not decode. Never a partial map.
   */
  owners(ids: readonly string[], block: bigint): Promise<Map<string, string | null>>;
  /**
   * The feedback entries for the id at `block`, revoked ones left out, in the registry's order
   * (per client, in the order the clients first gave feedback; each client's oldest first): every
   * entry when at most FEEDBACK_READ_MAX of them fit in one answer, else for each client `prefer`
   * names (lower case: the rater wallets) its newest entries up to its latest rating
   * (RATER_ENTRIES_MAX at most), then the newest other clients that fit, each with all of its
   * entries or none. `known` names the clients to read when the registry's client list does not
   * answer within CLIENTS_READ_MS (the rater wallets in Central City's records). An id without
   * feedback has none. Absent without a reputation registry. Rejects like owners().
   */
  feedback?(
    baseId: string,
    block: bigint,
    prefer?: (clients: readonly string[]) => Promise<ReadonlySet<string>>,
    known?: () => Promise<readonly string[]>,
  ): Promise<FeedbackReads>;
}

/** An endpoint reported another network: every read of this reader rejects from then on. */
class WrongNetworkError extends Error {
  constructor() {
    super('Not the expected network.');
  }
}

/** An answer that does not fit what was asked: the read rejects, never reads it as less. */
class MalformedAnswer extends Error {}

/** A read that took longer than the time it was given. */
class SlowRead extends Error {}

/**
 * Base answered that the read is too large to answer whole: HTTP 413, or a JSON-RPC error whose
 * message names a gas or size limit (out of gas, gas required exceeds, a response too large).
 * Only these are asked again in smaller parts. Any other error (a timeout, an HTTP or transport
 * failure, a rate limit, an internal or lagging-node error, an answer that does not decode, a
 * wrong network) is an outage: the read rejects, so an outage never multiplies the reads and the
 * earlier read stands.
 */
export function tooLargeError(error: unknown): boolean {
  for (
    let e = error as {
        name?: unknown;
        status?: unknown;
        code?: unknown;
        message?: unknown;
        details?: unknown;
        cause?: unknown;
      } | null,
      depth = 0;
    e && depth < 8;
    e = e.cause as typeof e, depth++
  ) {
    if (e instanceof WrongNetworkError || e instanceof MalformedAnswer) return false;
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return false;
    if (e.name === 'HttpRequestError') return e.status === 413;
    if (typeof e.code === 'number') {
      if (e.code === -32005 || e.code === 429) return false;
      return TOO_LARGE.test(`${String(e.details ?? '')} ${String(e.message ?? '')}`);
    }
  }
  return false;
}

/** The node's own words for an answer past a gas or size limit (rate limits never match). */
const TOO_LARGE =
  /out of gas|gas required exceeds|exceeds (the )?(block )?gas limit|gas limit (reached|exceeded)|(response|result|return ?data|output) (size |is )?(too (large|big)|exceeds)|too large|size limit/i;

/**
 * The extra calls one passport read may spend asking a too-large answer again in smaller parts,
 * beyond its first calls. Past it the parts not yet read are left unread (their raters skipped).
 */
export const FEEDBACK_SPLIT_CALLS_MAX = 16;

function within<T>(read: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    read,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SlowRead('slow')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * `url` may be a list: the first endpoint answers, and a read that fails there (a timeout, an
 * HTTP or RPC transport error, a rate limit) is asked once of the next. Production passes the CDP
 * endpoint first and Base's public RPC second, so the public explorer keeps reading Base while the
 * CDP endpoint is busy (it also carries the paymaster). Read only. Each endpoint must report the
 * expected chain id before it answers anything (once per endpoint), and once any endpoint reports
 * another network every read rejects. A revert or an answer that does not decode still rejects
 * (never read as "no owner").
 */
/**
 * An endpoint of its own for the explorer's anonymous reads (a read-only key, CCA-104). Set, the
 * explorer never reads through the configured Base endpoint, which also carries the bundler, the
 * paymaster and every wallet read: it asks this one, then the keyless second endpoint.
 */
export const EXPLORER_READ_SETTING = 'CITY_BASE_EXPLORER_RPC_URL';

/**
 * The explorer's Base endpoints, in order: its own (EXPLORER_READ_SETTING) when set, else the
 * configured Base endpoint, else (hosted only) the public one; then a second, keyless one
 * (CITY_BASE_READ_FALLBACK_RPC_URL, else the public RPC when hosted), never the same URL twice. A
 * setting that is not https is never used (CCA-140; plain http only to this machine). Empty: the
 * explorer reads no chain (stored evidence only).
 */
export function explorerReadUrls(
  env: Record<string, string | undefined>,
  hosted: boolean,
): string[] {
  const usable = (value: string | undefined) => {
    const url = value?.trim();
    return url && secureEndpoint(url, BASE_MAINNET) ? url : undefined;
  };
  const own = env[EXPLORER_READ_SETTING]?.trim();
  const configured = own || env[BASE_NETWORKS[BASE_MAINNET].bundlerEnv]?.trim();
  // A configured endpoint that is not https is refused, never replaced by another.
  if (configured && !usable(configured)) return [];
  const first = configured || (hosted ? PUBLIC_BASE_RPC : undefined);
  if (!first) return [];
  const second =
    usable(env.CITY_BASE_READ_FALLBACK_RPC_URL) || (hosted ? PUBLIC_BASE_RPC : undefined);
  return second && second !== first ? [first, second] : [first];
}

export function baseChainReader(
  url: string | readonly string[],
  chainId: number,
  registry: Address,
  timeoutMs = 3_000,
  reputation?: Address,
): OnBaseChainReader {
  const urls = (typeof url === 'string' ? [url] : [...url]).filter(Boolean);
  // A URL for another network must never report its blocks or owners as Base's. The check is the
  // endpoint's own, before its first answer: whichever endpoint serves a read has been checked.
  let wrongNetwork = false;
  const one = (u: string): Transport => {
    const inner = http(u, { timeout: timeoutMs, retryCount: 0 });
    let checked = false;
    let checking: Promise<void> | null = null;
    return (params) => {
      const transport = inner(params);
      // One check at a time; one that does not answer is asked again with the next read.
      const check = () =>
        checked
          ? Promise.resolve()
          : (checking ??= (async () => {
              const id = await transport.request({ method: 'eth_chainId' } as never);
              if (Number(id) !== chainId) {
                wrongNetwork = true;
                throw new WrongNetworkError();
              }
              checked = true;
            })().finally(() => {
              checking = null;
            }));
      const request = (async (args: unknown, options?: unknown) => {
        if (wrongNetwork) throw new WrongNetworkError();
        await check();
        return transport.request(args as never, options as never);
      }) as EIP1193RequestFn;
      return { ...transport, request };
    };
  };
  const client = createPublicClient({
    transport: urls.length > 1 ? fallback(urls.map(one), { retryCount: 0 }) : one(urls[0]!),
  });
  /** getLastIndex (each client's feedback count) of every client at `block`, via aggregate3. */
  const lastIndexes = async (
    registryAddress: Address,
    agentId: bigint,
    clients: readonly Address[],
    block: bigint,
  ): Promise<bigint[]> => {
    const chunks: Address[][] = [];
    for (let i = 0; i < clients.length; i += FEEDBACK_CLIENTS_CHUNK)
      chunks.push(clients.slice(i, i + FEEDBACK_CLIENTS_CHUNK));
    const answers = await Promise.all(
      chunks.map((chunk) =>
        client.readContract({
          address: MULTICALL3,
          abi: multicall3Abi,
          functionName: 'aggregate3',
          blockNumber: block,
          args: [
            chunk.map((address) => ({
              target: registryAddress,
              allowFailure: false,
              callData: encodeFunctionData({
                abi: reputationClientsAbi,
                functionName: 'getLastIndex',
                args: [agentId, address],
              }),
            })),
          ],
        }),
      ),
    );
    return answers.flatMap((results, c) => {
      if (results.length !== chunks[c]!.length)
        throw new MalformedAnswer('Malformed multicall answer.');
      return results.map(({ success, returnData }) => {
        if (!success) throw new MalformedAnswer('Feedback count not read.');
        return decodeFunctionResult({
          abi: reputationClientsAbi,
          functionName: 'getLastIndex',
          data: returnData,
        });
      });
    });
  };
  /** readAllFeedback of `chosen` (never empty here: that would ask for every client). */
  const readAll = async (
    registryAddress: Address,
    agentId: bigint,
    chosen: readonly Address[],
    block: bigint,
  ): Promise<FeedbackRead[]> => {
    const [clients, indexes, values, decimals, tag1s, tag2s, revoked] = await client.readContract({
      address: registryAddress,
      abi: reputationReadAbi,
      functionName: 'readAllFeedback',
      blockNumber: block,
      args: [agentId, chosen, '', '', false],
    });
    const n = clients.length;
    if (n > FEEDBACK_READ_MAX) throw new MalformedAnswer('Feedback answer over the bound.');
    if ([indexes, values, decimals, tag1s, tag2s, revoked].some((list) => list.length !== n))
      throw new MalformedAnswer('Malformed feedback answer.');
    const entries: FeedbackRead[] = [];
    for (let i = 0; i < n; i += 1) {
      if (revoked[i]) continue;
      entries.push({
        client: getAddress(clients[i]),
        index: indexes[i],
        value: values[i],
        decimals: decimals[i],
        tag1: tag1s[i],
        tag2: tag2s[i],
      });
    }
    return entries;
  };
  type Wanted = { client: Address; index: bigint };
  type Entry = { entry: FeedbackRead; revoked: boolean } | null;
  /** The split calls one feedback read has left (FEEDBACK_SPLIT_CALLS_MAX). */
  type Budget = { left: number };
  /**
   * readFeedback of each (client, index) through aggregate3, in order; null for an entry Base
   * could not answer (too large, or no such entry). A call too large to answer as a whole is asked
   * again in halves, down to the single entry that is: one wallet's oversized entries can only
   * ever cost that wallet's own rating. Halves are asked while `budget` lasts; past it a part too
   * large stays unread (null).
   */
  const entriesAt = async (
    registryAddress: Address,
    agentId: bigint,
    wanted: readonly Wanted[],
    block: bigint,
    budget: Budget,
  ): Promise<Entry[]> => {
    const part = async (chunk: readonly Wanted[]): Promise<Entry[]> => {
      let results: readonly { success: boolean; returnData: Hex }[];
      try {
        results = await client.readContract({
          address: MULTICALL3,
          abi: multicall3Abi,
          functionName: 'aggregate3',
          blockNumber: block,
          args: [
            chunk.map(({ client: address, index }) => ({
              target: registryAddress,
              allowFailure: true,
              callData: encodeFunctionData({
                abi: reputationEntryAbi,
                functionName: 'readFeedback',
                args: [agentId, address, index],
              }),
            })),
          ],
        });
      } catch (error) {
        if (!tooLargeError(error)) throw error;
        if (chunk.length === 1 || budget.left < 2) return chunk.map(() => null);
        budget.left -= 2;
        const half = Math.ceil(chunk.length / 2);
        return (await Promise.all([part(chunk.slice(0, half)), part(chunk.slice(half))])).flat();
      }
      if (results.length !== chunk.length) throw new MalformedAnswer('Malformed multicall answer.');
      return results.map(({ success, returnData }, i) => {
        if (!success) return null;
        const [value, decimals, tag1, tag2, revoked] = decodeFunctionResult({
          abi: reputationEntryAbi,
          functionName: 'readFeedback',
          data: returnData,
        });
        const { client: address, index } = chunk[i]!;
        return { entry: { client: address, index, value, decimals, tag1, tag2 }, revoked };
      });
    };
    const chunks: Wanted[][] = [];
    for (let i = 0; i < wanted.length; i += RATER_CALLS_CHUNK)
      chunks.push(wanted.slice(i, i + RATER_CALLS_CHUNK));
    return (await Promise.all(chunks.map(part))).flat();
  };
  /**
   * Each rater's newest entries, newest first, until one is a rating that counts or
   * RATER_ENTRIES_MAX were read: every rater gets the same few reads, whatever its count. An
   * entry Base cannot answer ends that rater's walk (skipped): its latest rating is then unknown,
   * and an older one must never stand in for it. When not one rater's newest entry can be read,
   * the read itself is broken (a registry without this readFeedback, say) and rejects: a score
   * from nobody is never published in place of the earlier read.
   */
  const raterReads = async (
    registryAddress: Address,
    agentId: bigint,
    raters: readonly { client: Address; count: bigint }[],
    block: bigint,
    budget: Budget,
  ) => {
    const walks = raters.map((rater) => ({
      client: rater.client,
      next: rater.count,
      found: false,
      failed: false,
      entries: [] as FeedbackRead[],
    }));
    for (let round = 0; round < RATER_ENTRIES_MAX; round += 1) {
      const due = walks.filter((walk) => !walk.found && !walk.failed && walk.next >= 1n);
      if (due.length === 0) break;
      const answers = await entriesAt(
        registryAddress,
        agentId,
        due.map((walk) => ({ client: walk.client, index: walk.next })),
        block,
        budget,
      );
      if (round === 0 && answers.every((answer) => answer === null))
        throw new MalformedAnswer('No rater entry read.');
      due.forEach((walk, i) => {
        const answer = answers[i];
        walk.next -= 1n;
        if (!answer) {
          walk.failed = true;
          return;
        }
        if (answer.revoked) return;
        // Read newest first; kept oldest first, as the registry lists them.
        walk.entries.unshift(answer.entry);
        if (starsOf(answer.entry) !== null) walk.found = true;
      });
    }
    return {
      byClient: new Map(walks.map((walk) => [walk.client, walk.entries])),
      skipped: walks.filter((walk) => !walk.found && (walk.next >= 1n || walk.failed)).length,
    };
  };
  return {
    async head() {
      return { block: await client.getBlockNumber({ cacheTime: 0 }) };
    },
    async owners(ids, block) {
      const owners = new Map<string, string | null>();
      if (ids.length === 0) return owners;
      // aggregate3 itself is called directly, not through viem's multicall(): that action turns a
      // failed eth_call (an outage, an HTTP or RPC error) into per-contract "failure" entries,
      // which must never read as "no owner". Any error of this one call rejects.
      const results = await client.readContract({
        address: MULTICALL3,
        abi: multicall3Abi,
        functionName: 'aggregate3',
        blockNumber: block,
        args: [
          ids.map((id) => ({
            target: registry,
            allowFailure: true,
            callData: encodeFunctionData({
              abi: identityRegistryAbi,
              functionName: 'ownerOf',
              args: [BigInt(id)],
            }),
          })),
        ],
      });
      if (results.length !== ids.length) throw new Error('Malformed multicall answer.');
      ids.forEach((id, index) => {
        const { success, returnData } = results[index];
        // success=false: ownerOf reverted inside aggregate3 for this id (no such token), the one
        // case that means "no owner". A success that does not decode rejects the whole read.
        owners.set(
          id,
          success
            ? getAddress(
                decodeFunctionResult({
                  abi: identityRegistryAbi,
                  functionName: 'ownerOf',
                  data: returnData,
                }),
              )
            : null,
        );
      });
      return owners;
    },
    ...(reputation
      ? {
          async feedback(
            baseId: string,
            block: bigint,
            prefer?: (clients: readonly string[]) => Promise<ReadonlySet<string>>,
            known?: () => Promise<readonly string[]>,
          ): Promise<FeedbackReads> {
            const agentId = BigInt(baseId);
            const clientList = client
              .readContract({
                address: reputation,
                abi: reputationClientsAbi,
                functionName: 'getClients',
                blockNumber: block,
                args: [agentId],
              })
              .then((list) => list.map((address) => getAddress(address)));
            // The client list grows with every address that ever gave feedback. When it does not
            // answer in time, or Base cannot answer it, the rater wallets in the records stand in.
            let all: Address[];
            let listed = true;
            try {
              all = known ? await within(clientList, CLIENTS_READ_MS) : await clientList;
            } catch (error) {
              if (!known || !(error instanceof SlowRead || tooLargeError(error))) throw error;
              clientList.catch(() => undefined);
              all = [...new Set((await known()).map((address) => getAddress(address)))];
              listed = false;
            }
            if (all.length === 0)
              return { entries: [], total: 0, bounded: !listed, ratersSkipped: 0 };
            const preferred = prefer ? await prefer(all) : new Set<string>();
            const isPreferred = (address: string) => preferred.has(address.toLowerCase());
            // The clients asked for their counts: every one up to FEEDBACK_CLIENTS_MAX, else the
            // preferred ones and the newest. Registry order is kept throughout.
            const asked =
              all.length <= FEEDBACK_CLIENTS_MAX
                ? all
                : all.filter(
                    (address, i) => isPreferred(address) || i >= all.length - FEEDBACK_CLIENTS_MAX,
                  );
            const counts = await lastIndexes(reputation, agentId, asked, block);
            const sum = counts.reduce((total, count) => total + count, 0n);
            const onBase = Number(sum) + (all.length - asked.length);
            if (listed && asked.length === all.length && sum <= BigInt(FEEDBACK_READ_MAX)) {
              try {
                const entries = await readAll(reputation, agentId, [], block);
                return { entries, total: entries.length, bounded: false, ratersSkipped: 0 };
              } catch (error) {
                // Too large to answer in one call (oversized tags): read bounded, as below.
                if (!tooLargeError(error)) throw error;
              }
            }
            // Bounded. Each rater wallet on its own: its newest entries up to its latest rating.
            const budget: Budget = { left: FEEDBACK_SPLIT_CALLS_MAX };
            const raters = await raterReads(
              reputation,
              agentId,
              asked.flatMap((address, i) =>
                isPreferred(address) && counts[i]! > 0n
                  ? [{ client: address, count: counts[i]! }]
                  : [],
              ),
              block,
              budget,
            );
            // Then the other clients from the newest back, each read whole or not at all, while
            // they fit. An answer too large for one call is asked again for the newer half.
            let room = BigInt(FEEDBACK_READ_MAX);
            const take = new Set<number>();
            for (let i = asked.length - 1; i >= 0; i -= 1) {
              const count = counts[i]!;
              if (!isPreferred(asked[i]!) && count > 0n && count <= room) {
                take.add(i);
                room -= count;
              }
            }
            let others = asked.filter((_, i) => take.has(i));
            let read: FeedbackRead[] = [];
            while (others.length) {
              try {
                read = await readAll(reputation, agentId, others, block);
                break;
              } catch (error) {
                if (!tooLargeError(error)) throw error;
                if (budget.left < 1) break;
                budget.left -= 1;
                others = others.slice(Math.ceil(others.length / 2));
              }
            }
            const byClient = new Map<string, FeedbackRead[]>();
            for (const entry of read)
              byClient.set(entry.client, [...(byClient.get(entry.client) ?? []), entry]);
            const entries = asked.flatMap((address) =>
              isPreferred(address)
                ? (raters.byClient.get(address) ?? [])
                : (byClient.get(address) ?? []),
            );
            return { entries, total: onBase, bounded: true, ratersSkipped: raters.skipped };
          },
        }
      : {}),
  };
}
