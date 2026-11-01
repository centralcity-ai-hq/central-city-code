/*
 * The owner's one click: moves the SFP sponsor EOA's surplus ETH to the engine's x402 facilitator
 * EOA (its gas), from inside the server, where the keystore's KEK is.
 *
 *   GET  /api/owner/sponsor-eth-to-facilitator  a dry summary (balance, amount, destination, reserve)
 *   POST /api/owner/sponsor-eth-to-facilitator  sends it: one plain ETH transfer, no data
 *
 * Who: a signed-in person whose own account is a proven sponsor operator
 * (base/chain/sponsor-operators.ts sponsorOperatorAccounts), with the console's X-City-Request
 * header; everyone else gets the same 404. POST at most once a minute per account.
 *
 * What, fixed in code and never from the request:
 *   - from the sponsor (CITY_SFP_SPONSOR_KEY_REF), which must be SPONSOR_ADDRESS;
 *   - to the router-3 facilitator (CITY_X402_FACILITATOR_KEY_REF), which must be FACILITATOR_ADDRESS;
 *   - Base mainnet (8453) only, configured and as the node reports it;
 *   - amount = balance - RESERVE_WEI - worst-case gas; refused below MIN_SEND_WEI.
 *
 * Nonce safety: the sponsor EOA also sends router-3 settlements on its own lane
 * (protocol/x402/facilitator.ts). The transfer is refused while the sponsor has any transaction in
 * flight (pending nonce != latest), and its nonce is taken from that same lane row
 * (x402_facilitator_lanes) under its lock, exactly as the facilitator takes one, so the two never
 * share a nonce. A broadcast that fails before the node saw it gives the nonce back.
 *
 * One at a time: owner_sponsor_eth_sends (migration 306) holds every send; a unique index allows
 * one open ('sent') row, and an open row refuses the next send until it is mined (or its nonce is
 * consumed). The key is never logged or returned; one log line per send (tx hash and amount).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { formatEther, getAddress, keccak256, type Hex } from 'viem';
import type { Address } from '../../../shared/base/chains.js';
import type { Database } from '../../database.js';
import { registerMigration, type Migration } from '../../migrations.js';

export const SPONSOR_ETH_PATH = '/api/owner/sponsor-eth-to-facilitator';
export const SPONSOR_ETH_CHAIN_ID = 8453;
export const SPONSOR_ADDRESS = '0x64e8FFB436a236da487d1c20fF2548A70cf82C13' as Address;
export const FACILITATOR_ADDRESS = '0xc8d6Bac2ff7182d22c4f316BffF9f713261A6cEC' as Address;
/** Left on the sponsor for its own router-3 sends. */
export const RESERVE_WEI = 30_000_000_000_000_000n; // 0.03 ETH
/** Below this, nothing is moved. */
export const MIN_SEND_WEI = 5_000_000_000_000_000n; // 0.005 ETH
/** A plain transfer to an EOA. */
export const TRANSFER_GAS = 21_000n;
/** Base's L1 data fee for a plain transfer, with a wide margin. */
export const L1_FEE_ALLOWANCE_WEI = 20_000_000_000_000n; // 0.00002 ETH
/** A fee above this is a spike: refused, never signed. */
export const MAX_FEE_PER_GAS_CAP = 50_000_000_000n; // 50 gwei
export const SPONSOR_ETH_RATE = { max: 1, windowMs: 60_000 } as const;
export const SPONSOR_ETH_RATE_PREFIX = 'owner-sponsor-eth';

/** The table migration 306 adds, for the backup's recognized list (recognized, never exported). */
export const OWNER_SPONSOR_ETH_TABLES = ['owner_sponsor_eth_sends'] as const;

/** Migration 306: one new table; nothing else read or changed. */
export const OWNER_SPONSOR_ETH_SENDS_SQL = `
CREATE TABLE IF NOT EXISTS owner_sponsor_eth_sends (
  id bigserial PRIMARY KEY,
  account_id text NOT NULL,
  chain_id integer NOT NULL,
  from_address text NOT NULL,
  to_address text NOT NULL,
  value_wei numeric(78,0) NOT NULL,
  nonce numeric(78,0) NOT NULL,
  tx_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('sent', 'mined', 'reverted', 'consumed', 'failed')),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS owner_sponsor_eth_sends_one_open
  ON owner_sponsor_eth_sends ((true)) WHERE state = 'sent';`;

export const ownerSponsorEthSendsMigration: Migration = {
  version: 306,
  name: 'owner_sponsor_eth_sends',
  sql: OWNER_SPONSOR_ETH_SENDS_SQL,
};
export function registerOwnerSponsorEthMigration(): void {
  registerMigration(ownerSponsorEthSendsMigration);
}

export interface SponsorEthTransfer {
  chainId: number;
  to: Address;
  value: bigint;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** The chain side, from the runtime (base/chain/runtime.ts sponsorEth). */
export interface SponsorEthChain {
  chainId: number;
  sponsor: Address;
  facilitator: Address;
  client: {
    getChainId(): Promise<number>;
    getBalance(args: { address: Address }): Promise<bigint>;
    estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
    getTransactionCount(args: {
      address: Address;
      blockTag: 'pending' | 'latest';
    }): Promise<number>;
    sendRawTransaction(args: { serializedTransaction: Hex }): Promise<Hex>;
    getTransactionReceipt(args: { hash: Hex }): Promise<{ status: 'success' | 'reverted' }>;
  };
  /**
   * Opens the sponsor's key for `use`, which signs with it; must refuse when the key is not the
   * sponsor's. Opened BEFORE the lane lock: the key store reads on a connection of its own.
   */
  withTransferSigner<T>(
    use: (sign: (tx: SponsorEthTransfer) => Promise<Hex>) => Promise<T>,
  ): Promise<T>;
}

export class SponsorEthRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface SponsorEthAmount {
  amountWei: bigint;
  gasWei: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** balance - reserve - worst-case gas (21000 x the signed fee cap + the L1 allowance); may be <= 0. */
export function sponsorEthAmount(
  balanceWei: bigint,
  fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
): SponsorEthAmount {
  // Signed with twice the node's fee cap so a base-fee rise never strands it; the worst case counts it.
  const maxFeePerGas = fees.maxFeePerGas * 2n;
  const maxPriorityFeePerGas =
    fees.maxPriorityFeePerGas > maxFeePerGas ? maxFeePerGas : fees.maxPriorityFeePerGas;
  const gasWei = TRANSFER_GAS * maxFeePerGas + L1_FEE_ALLOWANCE_WEI;
  return {
    amountWei: balanceWei - RESERVE_WEI - gasWei,
    gasWei,
    maxFeePerGas,
    maxPriorityFeePerGas,
  };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const eth = (wei: bigint) => formatEther(wei);
export const basescanTx = (hash: string) => `https://basescan.org/tx/${hash}`;

interface OpenRow {
  id: string;
  nonce: string;
  tx_hash: string;
}

export interface SponsorEthSummary {
  chainId: number;
  from: Address;
  to: Address;
  balanceWei: string;
  balanceEth: string;
  reserveWei: string;
  reserveEth: string;
  gasWei: string;
  amountWei: string;
  amountEth: string;
  minWei: string;
  canSend: boolean;
  /** Why not, when canSend is false. */
  reason: string | null;
  pendingTx: string | null;
}

export function createSponsorEthSweep(deps: {
  db: Pick<Database, 'query' | 'transaction'>;
  chain: () => Promise<SponsorEthChain | null>;
  now?: () => number;
  log?: (line: string) => void;
}) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.info(line));

  /** The chain, checked: fixed chain, sponsor and destination. */
  async function checkedChain(): Promise<SponsorEthChain> {
    const chain = await deps.chain();
    if (!chain)
      throw new SponsorEthRefusal(
        503,
        'not_configured',
        'The sponsor or facilitator key is not configured.',
      );
    if (chain.chainId !== SPONSOR_ETH_CHAIN_ID)
      throw new SponsorEthRefusal(409, 'wrong_chain', 'Only Base mainnet (8453).');
    if (!same(chain.sponsor, SPONSOR_ADDRESS))
      throw new SponsorEthRefusal(
        409,
        'wrong_sponsor',
        'The configured sponsor is not the expected one.',
      );
    if (!same(chain.facilitator, FACILITATOR_ADDRESS))
      throw new SponsorEthRefusal(
        409,
        'wrong_destination',
        'The configured facilitator is not the expected one.',
      );
    let reported: number;
    try {
      reported = await chain.client.getChainId();
    } catch {
      throw new SponsorEthRefusal(503, 'rpc_unavailable', 'Base could not be read now.');
    }
    if (reported !== SPONSOR_ETH_CHAIN_ID)
      throw new SponsorEthRefusal(409, 'wrong_chain', 'Only Base mainnet (8453).');
    return chain;
  }

  /** The open send, settled first if it is mined or its nonce is used. Null: none open. */
  async function openSend(chain: SponsorEthChain): Promise<OpenRow | null> {
    const { rows } = await deps.db.query<OpenRow>(
      `SELECT id::text AS id, nonce::text AS nonce, tx_hash FROM owner_sponsor_eth_sends
       WHERE state = 'sent' LIMIT 1`,
    );
    const open = rows[0];
    if (!open) return null;
    let state: string | null = null;
    try {
      const receipt = await chain.client.getTransactionReceipt({ hash: open.tx_hash as Hex });
      state = receipt.status === 'success' ? 'mined' : 'reverted';
    } catch {
      // No receipt (yet): the nonce used by another transaction ends it too.
      try {
        const latest = await chain.client.getTransactionCount({
          address: chain.sponsor,
          blockTag: 'latest',
        });
        if (BigInt(latest) > BigInt(open.nonce)) state = 'consumed';
      } catch {
        // Unknown: stays open.
      }
    }
    if (!state) return open;
    await deps.db.query(
      `UPDATE owner_sponsor_eth_sends SET state = $2, updated_at = $3 WHERE id = $1 AND state = 'sent'`,
      [open.id, state, now()],
    );
    return null;
  }

  async function plan(chain: SponsorEthChain) {
    let balance: bigint, fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
    let pending: number, latest: number;
    try {
      [balance, fees, pending, latest] = await Promise.all([
        chain.client.getBalance({ address: chain.sponsor }),
        chain.client.estimateFeesPerGas(),
        chain.client.getTransactionCount({ address: chain.sponsor, blockTag: 'pending' }),
        chain.client.getTransactionCount({ address: chain.sponsor, blockTag: 'latest' }),
      ]);
    } catch {
      throw new SponsorEthRefusal(503, 'rpc_unavailable', 'Base could not be read now.');
    }
    const amount = sponsorEthAmount(balance, fees);
    const open = await openSend(chain);
    let reason: string | null = null;
    if (open) reason = 'pending';
    else if (pending !== latest) reason = 'sponsor_busy';
    else if (amount.maxFeePerGas > MAX_FEE_PER_GAS_CAP * 2n) reason = 'gas_too_high';
    else if (amount.amountWei < MIN_SEND_WEI) reason = 'below_minimum';
    const summary: SponsorEthSummary = {
      chainId: chain.chainId,
      from: getAddress(chain.sponsor) as Address,
      to: getAddress(chain.facilitator) as Address,
      balanceWei: balance.toString(),
      balanceEth: eth(balance),
      reserveWei: RESERVE_WEI.toString(),
      reserveEth: eth(RESERVE_WEI),
      gasWei: amount.gasWei.toString(),
      amountWei: (amount.amountWei > 0n ? amount.amountWei : 0n).toString(),
      amountEth: eth(amount.amountWei > 0n ? amount.amountWei : 0n),
      minWei: MIN_SEND_WEI.toString(),
      canSend: reason === null,
      reason,
      pendingTx: open?.tx_hash ?? null,
    };
    return { summary, amount, pending };
  }

  const REFUSALS: Record<string, [number, string]> = {
    pending: [409, 'A send from this tool is still pending.'],
    sponsor_busy: [409, 'The sponsor has transactions in flight; try again in a minute.'],
    gas_too_high: [409, 'Gas is unusually high now; try again later.'],
    below_minimum: [409, 'Less than 0.005 ETH would move.'],
  };

  return {
    async summary(): Promise<SponsorEthSummary> {
      return (await plan(await checkedChain())).summary;
    },

    async send(accountId: string) {
      const chain = await checkedChain();
      const { summary, amount, pending } = await plan(chain);
      if (summary.reason) {
        const [status, message] = REFUSALS[summary.reason]!;
        throw new SponsorEthRefusal(status, summary.reason, message);
      }
      const to = getAddress(FACILITATOR_ADDRESS) as Address;
      const from = chain.sponsor.toLowerCase();
      let signed: { raw: Hex; hash: Hex; nonce: bigint; id: string };
      try {
        signed = await chain.withTransferSigner((signTransfer) =>
          deps.db.transaction(async (tx) => {
            const at = now();
            // The sponsor's lane row, as the facilitator takes it (facilitator.ts lockLane).
            await tx.query(
              `INSERT INTO x402_facilitator_lanes (chain_id, facilitator, next_nonce, updated_at)
             VALUES ($1, $2, 0, $3) ON CONFLICT DO NOTHING`,
              [chain.chainId, from, at],
            );
            const lane = (
              await tx.query<{ next_nonce: string }>(
                `SELECT next_nonce::text AS next_nonce FROM x402_facilitator_lanes
               WHERE chain_id = $1 AND facilitator = $2 FOR UPDATE`,
                [chain.chainId, from],
              )
            ).rows[0]!;
            const laneNext = BigInt(lane.next_nonce);
            // The lane already gave out a nonce Base has not seen: something is in flight.
            if (laneNext > BigInt(pending))
              throw new SponsorEthRefusal(409, 'sponsor_busy', REFUSALS.sponsor_busy![1]);
            const nonce = BigInt(pending);
            const raw = await signTransfer({
              chainId: chain.chainId,
              to,
              value: amount.amountWei,
              nonce: Number(nonce),
              gas: TRANSFER_GAS,
              maxFeePerGas: amount.maxFeePerGas,
              maxPriorityFeePerGas: amount.maxPriorityFeePerGas,
            });
            const hash = keccak256(raw);
            await tx.query(
              'UPDATE x402_facilitator_lanes SET next_nonce = $3, updated_at = $4 WHERE chain_id = $1 AND facilitator = $2',
              [chain.chainId, from, (nonce + 1n).toString(10), at],
            );
            const row = await tx.query<{ id: string }>(
              `INSERT INTO owner_sponsor_eth_sends
               (account_id, chain_id, from_address, to_address, value_wei, nonce, tx_hash, state, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'sent', $8, $8) RETURNING id::text AS id`,
              [
                accountId,
                chain.chainId,
                from,
                to.toLowerCase(),
                amount.amountWei.toString(10),
                nonce.toString(10),
                hash,
                at,
              ],
            );
            return { raw, hash, nonce, id: row.rows[0]!.id };
          }),
        );
      } catch (error) {
        if (error instanceof SponsorEthRefusal) throw error;
        // The one-open index: another send won the race.
        if ((error as { code?: string }).code === '23505')
          throw new SponsorEthRefusal(409, 'pending', REFUSALS.pending![1]);
        throw new SponsorEthRefusal(500, 'sign_failed', 'The transfer could not be signed.');
      }
      try {
        await chain.client.sendRawTransaction({ serializedTransaction: signed.raw });
      } catch {
        // Did the node take it anyway? Then it stands; otherwise the nonce goes back to the lane.
        let seen = false;
        try {
          seen =
            BigInt(
              await chain.client.getTransactionCount({
                address: chain.sponsor,
                blockTag: 'pending',
              }),
            ) > signed.nonce;
        } catch {
          seen = true; // Unknown: keep the lane where it is (a gap heals; a reused nonce does not).
        }
        if (!seen) {
          await deps.db.transaction(async (tx) => {
            await tx.query(
              `UPDATE x402_facilitator_lanes SET next_nonce = $3, updated_at = $4
               WHERE chain_id = $1 AND facilitator = $2 AND next_nonce = $5`,
              [
                chain.chainId,
                from,
                signed.nonce.toString(10),
                now(),
                (signed.nonce + 1n).toString(10),
              ],
            );
            await tx.query(
              `UPDATE owner_sponsor_eth_sends SET state = 'failed', updated_at = $2 WHERE id = $1`,
              [signed.id, now()],
            );
          });
          throw new SponsorEthRefusal(502, 'broadcast_failed', 'Base did not take the transfer.');
        }
      }
      log(`owner sponsor-eth: sent ${eth(amount.amountWei)} ETH to facilitator tx ${signed.hash}`);
      return {
        txHash: signed.hash,
        amountWei: amount.amountWei.toString(),
        amountEth: eth(amount.amountWei),
        to,
        basescan: basescanTx(signed.hash),
      };
    },
  };
}

export type SponsorEthSweep = ReturnType<typeof createSponsorEthSweep>;

export function registerSponsorEthRoutes(
  app: FastifyInstance,
  deps: {
    sweep: Pick<SponsorEthSweep, 'summary' | 'send'>;
    /** The signed-in person's own account, only with the console's header; else null. */
    person: (request: FastifyRequest) => Promise<{ accountId: string } | null>;
    /** The proven sponsor operator accounts (sponsorOperatorAccounts). */
    operators: () => ReadonlySet<string>;
    limit: (key: string, max: number, windowMs: number) => Promise<void>;
  },
): void {
  // The read-only summary (GET) needs no console header; the send (POST) does.
  const authorized = async (request: FastifyRequest, write = false) => {
    if (write && request.headers['x-city-request'] !== '1') return null;
    const person = await deps.person(request);
    if (!person || !deps.operators().has(person.accountId)) return null;
    return person;
  };
  const notFound = { error: 'Not found.', code: 'not_found' };
  const refused = (error: unknown) => {
    if (error instanceof SponsorEthRefusal)
      return { status: error.status, body: { error: error.message, code: error.code } };
    return { status: 500, body: { error: 'Something went wrong.', code: 'internal' } };
  };

  app.get(SPONSOR_ETH_PATH, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    if (!(await authorized(request))) return reply.code(404).send(notFound);
    try {
      return await deps.sweep.summary();
    } catch (error) {
      const { status, body } = refused(error);
      return reply.code(status).send(body);
    }
  });

  app.post(SPONSOR_ETH_PATH, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    const person = await authorized(request, true);
    if (!person) return reply.code(404).send(notFound);
    await deps.limit(
      `${SPONSOR_ETH_RATE_PREFIX}:${person.accountId}`,
      SPONSOR_ETH_RATE.max,
      SPONSOR_ETH_RATE.windowMs,
    );
    try {
      return await deps.sweep.send(person.accountId);
    } catch (error) {
      const { status, body } = refused(error);
      return reply.code(status).send(body);
    }
  });
}
