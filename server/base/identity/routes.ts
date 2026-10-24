/*
 * Owner-only routes that turn an agent into a Base agent: one call creates its wallet (counterfactual,
 * free) and moves its ERC-8004 registration forward; repeating the call continues where it stopped.
 * The chain runtime (keys, bundler, RPC) is injected and refuses to start when a setting is missing.
 *
 * Who owns the wallet that holds the Base ID:
 *   - wallets on (CITY_BASE_WALLET=1): the signed-in person's wallet key, from their own vault and
 *     never from the request, with the backup confirmed. So the Base ID and the money are in ONE
 *     wallet. The browser sends the wallet it derived itself from the key it held
 *     (src/base/wallet/derive.ts); anything else is refused before the Base ID is handed over.
 *   - wallets off: the owner address the request names, as before.
 * Agents registered earlier keep the wallet their owner address controls.
 */
import type { FeedPayChainPort } from '../chain/feed-pay-chain.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getAddress } from 'viem';
import { z } from 'zod';
import { transientDatabaseError, type Database } from '../../database.js';
import { transientChainError } from '../chain/transient.js';
import { BASE_MAINNET, type BaseChainId } from '../../../shared/base/chains.js';
import type { Address } from '../../../shared/base/chains.js';
import { cronAuthorized } from '../../wake/cron.js';
import {
  createWalletService,
  WalletServiceError,
  type WalletChainPort,
} from '../wallet/service.js';
import { createVaultService } from '../wallet/vault.js';
import {
  chainCheckIntervalMs,
  createIdentityService,
  errorCode,
  IDENTITY_COLUMNS,
  identityViewOf,
  IdentityServiceError,
  type IdentityChainPort,
  type IdentityEvent,
  type IdentityRow,
} from './service.js';
import { ensureShortId } from './short-links.js';
import type { OwnerOperationsPort } from '../chain/owner-ops.js';
import type { PaymentChainDeps, PaymentChainPort } from '../chain/payment-chain.js';

export interface ChainRuntime {
  walletPort: WalletChainPort;
  identityPort: IdentityChainPort;
  /** Owner-signed operations from agent wallets (withdrawals, payments); wallet network only. */
  ownerOperations?: OwnerOperationsPort;
  /**
   * An agent's own payments (Base Pay P2c), built per payment around its authority check; wallet
   * network only, and only with the wallet operations' fee budget (as ownerOperations).
   */
  agentPayments?: (authorize: NonNullable<PaymentChainDeps['authorize']>) => PaymentChainPort;
  /**
   * Feed pay's chain side (chain/feed-pay-chain.ts): float top-ups, sweeps, cancels and the x402
   * authorizations of agents' spender accounts; wallet network only, with the same fee budget and
   * pinned sponsor as agent payments.
   */
  feedPay?: () => FeedPayChainPort;
  /** Fee router 3's facilitator (server/protocol/x402/facilitator.ts); null when not configured. */
  router3Facilitator?: () => import('../../feed/pay/router3.js').Router3FacilitatorPort | null;
  /**
   * The sponsored first purchase's payer (server/feed/pay/sponsored.ts): the sponsor's signer and
   * its own facilitator over its own key; null unless CITY_SFP_SPONSOR_KEY_REF and router 3 are set.
   */
  sponsorPay?: () => Promise<import('../../feed/pay/sponsored.js').SponsorPay | null>;
  /**
   * Our own bundler's upkeep (direct-bundler.ts maintain: rebroadcast, replace, cancel, receipts,
   * settlement), for its cron; only while CITY_BASE_BUNDLER=direct is in effect.
   */
  ownBundlerUpkeep?: import('../chain/direct-bundler.js').OwnBundlerUpkeep;
  /** Whether our bundler is in effect or the CDP fallback is (public route). */
  ownBundlerEffective?: () => 'direct' | 'cdp_fallback' | 'unknown';
  /** The network's public read client, for read-only contract calls (payment screening). */
  readClient?: import('viem').PublicClient;
  /**
   * The read client of Feed pay's payment screening: Feed pay's own endpoint when
   * CITY_FEED_PAY_CDP_RPC_URL is set, else `readClient`. Throws (ChainRuntimeError, the setting
   * name only) when that setting is not an https URL.
   */
  feedPayReadClient?: () => import('viem').PublicClient;
}

export interface RegisterRouteDeps {
  db: Database;
  env: Record<string, string | undefined>;
  /** The signed-in owner, or null. */
  currentOperator(request: FastifyRequest): Promise<{ id: string } | null>;
  /** Builds the chain runtime for a network; throws when it is not configured. */
  runtime(chainId: BaseChainId): Promise<ChainRuntime>;
  /** Enables the finalize cron (Vercel Cron's bearer secret); without it the route is absent. */
  cronSecret?: string;
  /**
   * The signed-in person (their own account, whichever workspace is selected), whose wallet key
   * owns a new registration's wallet while wallets are on. Without it that registration answers
   * 404.
   */
  currentPerson?(request: FastifyRequest): Promise<{ id: string } | null>;
  now?: () => number;
  /** One JSON line per event (default: console.info). */
  log?: (event: IdentityEvent) => void;
  /**
   * Polls of one registration ask the chain at most once per chainCheckIntervalMs (default on).
   * Off only for tests that drive every advance through the route themselves.
   */
  throttleChainChecks?: boolean;
}

export const IDENTITY_FINALIZE_PATH = '/api/cron/base-identity-finalize';
/** Rows already registered or in flight claimed per cron run, advanced at most this many at a time, within this deadline. */
export const FINALIZE_BATCH = 100;
/**
 * Rows not yet registered on chain (no mint operation, no id) one run may take on top of the
 * batch, so a run claims at most FINALIZE_BATCH + this many rows: new registrations at most this
 * many per run (a per-run bound; with the one-minute cron about 1,200 per hour while the 23 Oct backlog clears). Rows already minted
 * (hand-over, finalizing) are advanced first, then registrations in flight, then these, so a
 * backlog of unregistered rows never starves the hand-overs of identities already minted.
 */
export const FINALIZE_REGISTER_PER_RUN = 20;
export const FINALIZE_CONCURRENCY = 20;
export const FINALIZE_DEADLINE_MS = 45_000;
/** A row claimed by a run is not claimed again for this long. */
export const FINALIZE_RECLAIM_MS = 50_000;
/**
 * A row that moved this recently (updated_at moves only on a real change, service.ts) was just
 * advanced by its owner's poll: the cron leaves it to that poll and takes it on a later run, still
 * unclaimed and first in line. The cron has no deadline of its own (it only calls the same
 * advance, never a retry), so nothing waits on it but the next run.
 */
export const FINALIZE_FRESH_MS = 30_000;

/** Seconds a register call that met a transient database failure asks the caller to wait. */
export const TRANSIENT_RETRY_AFTER_S = 5;

const params = z.object({ agentId: z.string().uuid() });
const body = z.object({
  ownerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  chainId: z.literal(BASE_MAINNET).default(BASE_MAINNET),
  /** The owner's explicit "Try again" after a failed step. */
  retry: z.boolean().optional(),
});
/** With wallets on: no owner address (the wallet key is the owner), only the browser's wallet. */
const keyBody = z.strictObject({
  /** The wallet this browser derived from the wallet key it held (src/base/wallet/derive.ts). */
  expectedWallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  chainId: z.literal(BASE_MAINNET).default(BASE_MAINNET),
  retry: z.boolean().optional(),
});

export function registerBaseRegistrationRoutes(app: FastifyInstance, deps: RegisterRouteDeps) {
  async function ownedAgent(request: FastifyRequest) {
    const operator = await deps.currentOperator(request);
    if (!operator) return { ok: false as const, code: 401 };
    const parsed = params.safeParse(request.params);
    if (!parsed.success) return { ok: false as const, code: 404 };
    const { rows } = await deps.db.query<{ operator_id: string }>(
      'SELECT operator_id FROM agent_manifests WHERE agent_id = $1 LIMIT 1',
      [parsed.data.agentId],
    );
    // Someone else's agent answers 404, so its existence is not disclosed.
    if (rows[0]?.operator_id !== operator.id) return { ok: false as const, code: 404 };
    return { ok: true as const, agentId: parsed.data.agentId, workspaceId: operator.id };
  }

  const logEvent = deps.log ?? ((event: IdentityEvent) => console.info(JSON.stringify(event)));
  /** An address the request body names in `field`, when it is a well-formed one. */
  const named = (raw: unknown, field: 'expectedWallet' | 'ownerAddress'): Address | null => {
    const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[field] : null;
    return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
      ? getAddress(value)
      : null;
  };

  const vaults = createVaultService({ db: deps.db, ...(deps.now ? { now: deps.now } : {}) });
  /** Wallets are on: a new registration's wallet is the person's wallet key's (read per request). */
  const walletsOn = () => deps.env.CITY_BASE_WALLET === '1';

  /**
   * The signed-in person's wallet key, as the owner of a new registration's wallet: a person
   * account (never an AI workspace or another principal) with a vault whose backup is confirmed,
   * so no Base ID lands in a wallet whose key could still be lost.
   */
  async function walletKey(request: FastifyRequest) {
    const notFound = { ok: false as const, code: 404, body: { error: 'Not found.' } };
    const person = deps.currentPerson ? await deps.currentPerson(request) : null;
    if (!person) return notFound;
    const { rows } = await deps.db.query<{ kind: string }>(
      'SELECT kind FROM operators WHERE id = $1',
      [person.id],
    );
    if (rows[0]?.kind !== 'owner') return notFound;
    const vault = await vaults.owner(person.id);
    if (!vault)
      return {
        ok: false as const,
        code: 409,
        body: { error: 'Set up your wallet key first.', code: 'wallet_key_required' },
      };
    if (vault.backupConfirmedAt === null)
      return {
        ok: false as const,
        code: 409,
        body: { error: 'Confirm your backup first.', code: 'backup_required' },
      };
    return { ok: true as const, accountId: person.id, ownerAddress: vault.ownerAddress };
  }

  /**
   * Before this request's first chain step: the stored wallet is this person's vault wallet (their
   * account, their key, backup confirmed) and the one the browser derived. Anything else refuses.
   *
   * Later steps (the hand-over, also from the finalize cron) are not checked again here. They send
   * to the same base_wallets row (identity/service.ts reads its address), and that binding cannot
   * change after this check: a row's address and owner are written once and never updated (only its
   * owner account, while still empty, and its state are), ensureWallet refuses to rebind it, the
   * vault's owner never changes (a rewrap must keep the same key) and its backup confirmation is
   * never undone. tests/base-register-wallet-key.test.ts holds a delayed hand-over to that.
   */
  async function stillTheKeyWallet(
    agentId: string,
    chainId: number,
    owner: { address: Address; accountId: string; expectedWallet: Address },
  ) {
    const vault = await vaults.owner(owner.accountId);
    const { rows } = await deps.db.query<{
      address: string;
      owner_address: string;
      owner_account_id: string | null;
    }>(
      'SELECT address, owner_address, owner_account_id FROM base_wallets WHERE agent_id = $1 AND chain_id = $2',
      [agentId, chainId],
    );
    const row = rows[0];
    return (
      vault !== null &&
      vault.backupConfirmedAt !== null &&
      vault.ownerAddress.toLowerCase() === owner.address.toLowerCase() &&
      row !== undefined &&
      row.owner_account_id === owner.accountId &&
      row.owner_address.toLowerCase() === owner.address.toLowerCase() &&
      getAddress(row.address) === owner.expectedWallet
    );
  }

  /**
   * Base reads the agent's public card (the `/a/<id>` file), so only a public profile registers.
   * Under the workspace row lock that every workspace change takes (My agents' Make private
   * included), the current manifest's visibility is checked and the short id assigned: once it
   * exists, Make private is refused, so the two cannot interleave.
   */
  async function claimPublicProfile(workspaceId: string, agentId: string): Promise<boolean> {
    const visibility = async (tx: Pick<Database, 'query'>) => {
      const { rows } = await tx.query<{ visibility: string | null }>(
        `SELECT m.manifest->'spec'->>'visibility' AS visibility
         FROM workspaces w
         CROSS JOIN LATERAL jsonb_array_elements(w.data->'agents') a
         JOIN agent_manifests m ON m.agent_id = a->>'id' AND m.revision = (a->>'revision')::int
         WHERE w.operator_id = $1 AND a->>'id' = $2 AND a->>'revokedAt' IS NULL`,
        [workspaceId, agentId],
      );
      return rows[0]?.visibility ?? null;
    };
    // Every later call of a registration (each poll of the owner's panel or script) finds the short
    // id assigned. From then on Make private and a manifest update to private are refused
    // (baseRegistrationStarted, under this same lock), so the profile can only still be public and
    // the check needs no lock: the workspace row lock, contended by every workspace write of that
    // owner, is taken once per agent, never on every poll (a lock timeout there was a 500).
    const { rows: claimed } = await deps.db.query(
      'SELECT 1 FROM base_short_ids WHERE agent_id = $1',
      [agentId],
    );
    if (claimed[0]) return (await visibility(deps.db)) === 'public';
    return deps.db.transaction(async (tx) => {
      await tx.query('SELECT 1 FROM workspaces WHERE operator_id = $1 FOR UPDATE', [workspaceId]);
      if ((await visibility(tx)) !== 'public') return false;
      await ensureShortId(tx, agentId, deps.now?.() ?? Date.now());
      return true;
    });
  }

  /**
   * The stored registration of an agent, with its wallet: DB only, never a chain call. The status
   * route reads every network; a register call that could not finish reads its own.
   */
  async function storedRegistrations(agentId: string, chainId?: number) {
    const { rows } = await deps.db.query<
      IdentityRow & {
        wallet_address: string | null;
        wallet_owner_address: string | null;
        wallet_state: string | null;
      }
    >(
      `SELECT i.*, w.address AS wallet_address, w.owner_address AS wallet_owner_address,
              w.state AS wallet_state
       FROM (SELECT ${IDENTITY_COLUMNS} FROM base_identities
             WHERE agent_id = $1 AND ($2::int IS NULL OR chain_id = $2::int)) i
       LEFT JOIN base_wallets w ON w.agent_id = i.agent_id AND w.chain_id = i.chain_id
       ORDER BY i.chain_id`,
      [agentId, chainId ?? null],
    );
    return rows;
  }

  /**
   * A register call that met a transient database failure (a lock or statement timeout, a
   * serialization conflict, no free connection) answers where the registration stands, exactly
   * as stored: nothing is concluded and nothing is written here, and the next call (or the finalize
   * cron) moves it on. The wallet the browser derived (or the owner address it named) must be the
   * stored one, or the stored state is not this request's answer. Without a stored registration,
   * or when even this read fails, the answer is 503 with Retry-After, which the panel treats as
   * "ask again later".
   */
  async function answerStored(
    reply: FastifyReply,
    agentId: string,
    chainId: number,
    error: unknown,
    asked: { wallet: Address | null; owner: Address | null },
  ) {
    logEvent({ event: 'identity.register_transient', agentId, chainId, code: errorCode(error) });
    const unavailable = () =>
      reply
        .code(503)
        .header('Retry-After', String(TRANSIENT_RETRY_AFTER_S))
        .send({ error: 'Base registration is busy. Try again in a moment.', code: 'busy' });
    let row: Awaited<ReturnType<typeof storedRegistrations>>[number] | undefined;
    try {
      row = (await storedRegistrations(agentId, chainId))[0];
    } catch {
      return unavailable();
    }
    if (!row?.wallet_address || !row.wallet_owner_address) return unavailable();
    if (asked.wallet && getAddress(row.wallet_address) !== asked.wallet) return unavailable();
    if (asked.owner && getAddress(row.wallet_owner_address) !== asked.owner) return unavailable();
    return {
      wallet: {
        address: row.wallet_address,
        ownerAddress: row.wallet_owner_address,
        state: row.wallet_state,
      },
      identity: identityViewOf(row, (deps.now ?? Date.now)()),
    };
  }

  /**
   * Whether this call may ask the chain for an open registration now, claimed when it may: the
   * row's last chain advance (`swept_at`, shared with the finalize cron's claim) is at least
   * chainCheckIntervalMs old, and this call moves it forward with a compare-and-set, so of
   * concurrent polls one advances and the others answer the stored state. A row not started yet
   * (no attempt), a closed one or none at all: always (advance creates or only reads it).
   */
  async function chainCheckDue(agentId: string, chainId: number): Promise<boolean> {
    const now = (deps.now ?? Date.now)();
    const { rows } = await deps.db.query<IdentityRow & { swept_at: string | null }>(
      `SELECT ${IDENTITY_COLUMNS}, swept_at::text AS swept_at FROM base_identities
       WHERE agent_id = $1 AND chain_id = $2`,
      [agentId, chainId],
    );
    const row = rows[0];
    if (!row || row.op_id === null || (row.state !== 'pending' && row.state !== 'submitted'))
      return true;
    const last = row.swept_at === null ? null : Number(row.swept_at);
    if (last !== null && now - last < chainCheckIntervalMs(row, now)) return false;
    const claimed = await deps.db.query(
      `UPDATE base_identities SET swept_at = $3::bigint
       WHERE agent_id = $1 AND chain_id = $2 AND swept_at IS NOT DISTINCT FROM $4::bigint
       RETURNING 1`,
      [agentId, chainId, now, row.swept_at],
    );
    return claimed.rows.length > 0;
  }

  app.post('/api/base/agents/:agentId/register', async (request, reply) => {
    let owned: Awaited<ReturnType<typeof ownedAgent>>;
    try {
      owned = await ownedAgent(request);
    } catch (error) {
      // Not known yet whose agent this is, so there is no state to answer: ask again later.
      if (!transientDatabaseError(error)) throw error;
      return reply
        .code(503)
        .header('Retry-After', String(TRANSIENT_RETRY_AFTER_S))
        .send({ error: 'Base registration is busy. Try again in a moment.', code: 'busy' });
    }
    if (!owned.ok) return reply.code(owned.code).send({ error: 'Not found.' });
    try {
      return await registerOwned(request, reply, owned);
    } catch (error) {
      // A transient database failure (above all a lock or statement timeout while the owner's
      // call and the finalize cron advance the same registration), or Base's endpoint saying
      // "not now" (a 429 rate limit, a timeout, a 5xx), is never a 500: the answer is where the
      // registration stands. Anything else is a real error and still throws.
      if (!transientDatabaseError(error) && !transientChainError(error)) throw error;
      return answerStored(reply, owned.agentId, BASE_MAINNET, error, {
        wallet: named(request.body, 'expectedWallet'),
        owner: named(request.body, 'ownerAddress'),
      });
    }
  });

  async function registerOwned(
    request: FastifyRequest,
    reply: FastifyReply,
    owned: { agentId: string; workspaceId: string },
  ) {
    let input: { chainId: typeof BASE_MAINNET; retry?: boolean };
    let owner: { address: Address; accountId?: string; expectedWallet?: Address };
    if (walletsOn()) {
      const parsed = keyBody.safeParse(request.body ?? {});
      if (!parsed.success)
        return reply.code(400).send({
          error:
            'Your wallet key owns the agent: send the wallet this browser derived, never an owner address.',
          code: 'invalid_body',
        });
      const key = await walletKey(request);
      if (!key.ok) return reply.code(key.code).send(key.body);
      input = parsed.data;
      owner = {
        address: key.ownerAddress,
        accountId: key.accountId,
        expectedWallet: getAddress(parsed.data.expectedWallet),
      };
    } else {
      // A request meant for the wallet-key flow is refused, never read as an owner-address one.
      const raw = request.body;
      if (raw && typeof raw === 'object' && 'expectedWallet' in raw)
        return reply.code(400).send({
          error: 'Wallets are not on yet: registration takes an owner address.',
          code: 'wallets_off',
        });
      const parsed = body.safeParse(request.body ?? {});
      if (!parsed.success)
        return reply.code(400).send({ error: 'ownerAddress must be an address.' });
      input = parsed.data;
      owner = { address: parsed.data.ownerAddress as Address };
    }
    let runtime: ChainRuntime;
    try {
      runtime = await deps.runtime(input.chainId);
    } catch {
      return reply.code(503).send({ error: 'Base registration is not available yet.' });
    }
    if (!(await claimPublicProfile(owned.workspaceId, owned.agentId)))
      return reply
        .code(409)
        .send({ error: "Make the agent's profile public first.", code: 'profile_private' });
    const wallets = createWalletService({ db: deps.db, chain: runtime.walletPort, env: deps.env });
    const identities = createIdentityService({
      db: deps.db,
      chain: runtime.identityPort,
      env: deps.env,
      log: logEvent,
    });
    try {
      const wallet = await wallets.ensureWallet({
        workspaceId: owned.workspaceId,
        agentId: owned.agentId,
        chainId: input.chainId,
        ownerAddress: owner.address,
        ...(owner.accountId ? { ownerAccountId: owner.accountId } : {}),
      });
      // The Base ID goes only to the wallet the browser derived itself from the key it held,
      // checked again against the stored wallet and the vault before the first chain step.
      if (
        owner.accountId &&
        owner.expectedWallet &&
        (getAddress(wallet.address) !== owner.expectedWallet ||
          !(await stillTheKeyWallet(owned.agentId, input.chainId, {
            address: owner.address,
            accountId: owner.accountId,
            expectedWallet: owner.expectedWallet,
          })))
      )
        return reply.code(409).send({
          error: 'This is not the wallet your wallet key makes. Nothing was registered.',
          code: 'wallet_mismatch',
        });
      // A frozen or closed wallet is refused on every call, as the advance below refuses it, also
      // when the throttle answers the stored state instead.
      if (wallet.state === 'frozen' || wallet.state === 'closed')
        throw new IdentityServiceError('wallet_frozen', 'The wallet is frozen or closed.');
      // "Try again" counts only while the stored registration offers it (canRetry); any other
      // retry is a normal poll, so the throttle, the backoffs and the settling gate still apply.
      if (input.retry === true) {
        const stored = (await storedRegistrations(owned.agentId, input.chainId))[0];
        input.retry =
          stored !== undefined && identityViewOf(stored, (deps.now ?? Date.now)()).canRetry;
      }
      // A registration whose chain was asked a moment ago (by another poll of this owner, another
      // tab or script, or the finalize cron) answers its stored state; only "Try again" always
      // advances. See chainCheckIntervalMs.
      if (
        deps.throttleChainChecks !== false &&
        input.retry !== true &&
        !(await chainCheckDue(owned.agentId, input.chainId))
      ) {
        const stored = (await storedRegistrations(owned.agentId, input.chainId))[0];
        if (stored)
          return {
            wallet: {
              address: wallet.address,
              ownerAddress: wallet.ownerAddress,
              state: wallet.state,
            },
            identity: identityViewOf(stored, (deps.now ?? Date.now)()),
          };
      }
      const identity = await identities.advance(owned.agentId, input.chainId, {
        retry: input.retry === true,
      });
      return {
        wallet: { address: wallet.address, ownerAddress: wallet.ownerAddress, state: wallet.state },
        identity,
      };
    } catch (error) {
      if (error instanceof IdentityServiceError)
        return reply.code(409).send({ error: error.message, code: error.code });
      if (error instanceof WalletServiceError && error.code === 'wallet_conflict') {
        // The wallet is already bound to another owner address; say which one instead of a 500.
        const { rows } = await deps.db.query<{ owner_address: string }>(
          'SELECT owner_address FROM base_wallets WHERE agent_id = $1 AND chain_id = $2',
          [owned.agentId, input.chainId],
        );
        return reply.code(409).send({
          error: "This agent's wallet is already controlled by another wallet address.",
          code: 'wallet_conflict',
          ownerAddress: rows[0]?.owner_address ?? null,
        });
      }
      if (error instanceof WalletServiceError && error.code === 'network_unavailable')
        return reply.code(503).send({ error: 'Base registration is not available yet.' });
      throw error;
    }
  }

  app.get('/api/base/agents/:agentId/registration', async (request, reply) => {
    const owned = await ownedAgent(request);
    if (!owned.ok) return reply.code(owned.code).send({ error: 'Not found.' });
    // DB only, never a chain call: the same identity view the POST returns. Each identity also
    // carries the agent's wallet on that chain and the owner wallet that controls it, as stored
    // server-side. Public addresses only: never the spender account or its key reference.
    const rows = await storedRegistrations(owned.agentId);
    const at = (deps.now ?? Date.now)();
    return {
      identities: rows.map((row) => ({
        ...identityViewOf(row, at),
        txHash: row.tx_hash,
        wallet: row.wallet_address
          ? {
              address: row.wallet_address,
              ownerAddress: row.wallet_owner_address,
              state: row.wallet_state,
            }
          : null,
      })),
    };
  });

  /*
   * Finalize cron (every minute): moves open registrations on until both operations are final,
   * also when nobody has the panel open. Only rows the owner started (op_id set) are touched; no
   * retry is ever made here. Rows a poll moved within FINALIZE_FRESH_MS are left for a later run,
   * and so are rows whose refused hand-over or register attempt is still backing off, and rows
   * whose chain a poll asked within FINALIZE_RECLAIM_MS (the poll's claim of swept_at,
   * chainCheckDue). Fails closed: without the bearer secret the route answers 404.
   */
  const cronSecret = deps.cronSecret;
  if (cronSecret !== undefined)
    app.get(IDENTITY_FINALIZE_PATH, async (request, reply) => {
      if (!cronAuthorized(request.headers.authorization, cronSecret))
        return reply.code(404).send({ error: 'Not found.' });
      const clock = deps.now ?? Date.now;
      const started = clock();
      const due = `state IN ('pending','submitted') AND op_id IS NOT NULL
             AND (swept_at IS NULL OR swept_at <= $2::bigint)
             AND updated_at <= $3::bigint
             AND (handover_retry_at IS NULL OR handover_retry_at <= $1::bigint)
             AND (register_retry_at IS NULL OR register_retry_at <= $1::bigint)`;
      const unregistered =
        'mint_op_id IS NULL AND erc8004_agent_id IS NULL AND provisional_agent_id IS NULL';
      const { rows: claimed } = await deps.db.query<{
        agent_id: string;
        chain_id: number;
        tier: number;
      }>(
        `WITH started AS (
           SELECT agent_id, chain_id FROM base_identities
           WHERE ${due} AND NOT (${unregistered})
           ORDER BY (erc8004_agent_id IS NULL AND provisional_agent_id IS NULL),
                    swept_at NULLS FIRST, updated_at
           LIMIT ${FINALIZE_BATCH} FOR UPDATE SKIP LOCKED),
         fresh AS (
           SELECT agent_id, chain_id FROM base_identities
           WHERE ${due} AND ${unregistered}
           ORDER BY swept_at NULLS FIRST, updated_at
           LIMIT ${FINALIZE_REGISTER_PER_RUN} FOR UPDATE SKIP LOCKED)
         UPDATE base_identities SET swept_at = $1::bigint
         WHERE (agent_id, chain_id) IN (SELECT * FROM started UNION ALL SELECT * FROM fresh)
         RETURNING agent_id, chain_id,
           CASE WHEN erc8004_agent_id IS NOT NULL OR provisional_agent_id IS NOT NULL THEN 0
                WHEN mint_op_id IS NOT NULL THEN 1 ELSE 2 END AS tier`,
        [started, started - FINALIZE_RECLAIM_MS, started - FINALIZE_FRESH_MS],
      );
      // RETURNING has no order: the workers take minted rows first, then in flight, then new ones.
      const rows = [...claimed].sort((a, b) => Number(a.tier) - Number(b.tier));
      const services = new Map<number, Promise<ReturnType<typeof createIdentityService>>>();
      const serviceFor = (chainId: number) => {
        let service = services.get(chainId);
        if (!service) {
          service = deps.runtime(chainId as BaseChainId).then((runtime) =>
            createIdentityService({
              db: deps.db,
              chain: runtime.identityPort,
              env: deps.env,
              log: logEvent,
            }),
          );
          services.set(chainId, service);
        }
        return service;
      };
      let advanced = 0;
      let confirmed = 0;
      let errors = 0;
      let next = 0;
      const worker = async () => {
        while (next < rows.length && clock() - started < FINALIZE_DEADLINE_MS) {
          const row = rows[next++];
          try {
            const service = await serviceFor(row.chain_id);
            const view = await service.advance(row.agent_id, row.chain_id as BaseChainId);
            advanced++;
            if (view.state === 'confirmed') confirmed++;
          } catch (error) {
            errors++;
            const code = (error as { code?: unknown } | null)?.code;
            console.info(
              JSON.stringify({
                event: 'identity.finalize_error',
                agentId: row.agent_id,
                chainId: row.chain_id,
                code: typeof code === 'string' ? code : 'error',
              }),
            );
          }
        }
      };
      await Promise.all(Array.from({ length: FINALIZE_CONCURRENCY }, worker));
      return { advanced, confirmed, errors };
    });
}
