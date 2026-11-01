/*
 * Operation Paymaster's spending gate (the numbers are BUDGET_LIMITS below: a protected reserve
 * for withdrawals/revokes/cancels, an ordinary ceiling for deploy, canary and normal work, and an
 * hourly cap on ordinary work). Every sponsorship reserves its WORST-CASE cost before its signature is handed
 * out, atomically under one row lock shared by every server instance, so two requests can never
 * spend the same headroom. The worst case is what EntryPoint v0.6 may charge a sponsored operation
 * (submit.ts maxCostWei with a paymaster: verificationGasLimit counts three times):
 *
 *   worst case = (callGasLimit + 3 × verificationGasLimit + preVerificationGas) × maxFeePerGas
 *
 * An ordinary flow is admitted only if, counting every reservation still outstanding:
 *   overhead + ordinary settled + ordinary outstanding + worst case <= ordinaryCeiling (0.93 ETH)
 *   ordinary in the last hour (settled actual + outstanding worst case) + worst case <= hourly (0.1)
 *   free - worst case >= protected (0.05 ETH)
 * A protected flow (exit) only needs free - worst case >= 0, its own hourly cap (0.02 ETH) and a
 * deployment-wide daily figure (0.05 ETH). That daily figure is NOT a ceiling: every account
 * (operator accounts too; not a reservation with no account) keeps its first 3 exits of the day
 * past it, still held by the hourly exit caps and the deposit (the shared hour always; a
 * non-operator account's own hour, sender hour and own day too). What bounds exits is the shared
 * exit hour: at most 24 × 0.02 = 0.48 ETH of worst-case exits a rolling day, deposit permitting.
 * An exit admitted past the day figure only that way is logged as ALERT, at most once per rolling
 * day per instance. Accounts looping exits up to the figure pause the way out only for themselves
 * and others past their first 3, where
 *   free = deposit@block - outstanding - settled after block
 *
 * Owner handouts. A flow an owner signs in the browser (OWNER_SIGNED_FLOWS: withdrawals, cancels,
 * revokes, payments, ratings) is handed out before anyone signs it, and may never be signed. Those
 * still never sent hold at most handoutShareBps (30%) of each shared hour between them, past each
 * account's first: an account that holds no handout of a class in the share may always take one
 * (only the shared hour and day bound it), so the share itself never refuses an owner's first
 * withdrawal or payment. That is all it promises: the shared hour is checked before the share, and
 * an account's first handout is held to it, so very many accounts each holding one never-signed
 * first handout can fill the shared hour between them, ordinary or exit, and an honest owner's
 * first is then refused for that hour (exit_hourly, hourly) until theirs lapse (a residual; see
 * OWN_PAYMASTER_OPS.md for how many accounts that takes). Operator accounts are not held to the
 * share. The operations the server signs itself and the ones owners did sign keep the rest of the
 * hour unless very many accounts each hold one past the full share.
 *
 * What a never-sent sponsorship still holds. A signature handed out may execute until its
 * validUntil, unless it provably cannot be submitted at all. Our sponsorships are signed with
 * allowAnyBundler = false (own-paymaster.ts): the paymaster's postOp reverts the whole bundle unless
 * tx.origin is an allowlisted bundler, and the only allowlisted bundlers are our submitters, which
 * broadcast an operation only after markSentIn moved its reservation, under the same lock. A budget
 * built with `submitterBound` (the direct bundler: it signs every sponsorship that way and refuses
 * to sponsor while its submitter is not allowlisted) therefore treats a never-sent reservation that
 * was released as unable to execute: it holds nothing of the deposit, the ceiling, the handout
 * share or any shared hour or day from then on. Without `submitterBound` (nothing proves the
 * binding), a released one holds all of that, like an open one, until validUntil + margin. Either
 * way a never-sent one holds nothing once validUntil + margin has passed (no signature can execute
 * then; a foreign execution before it would show in the deposit reading, the truth), release frees
 * its place under the account's never-sent cap at once (the owner's screen slot, distinct from the
 * gas it may still cost), and a late receipt still settles it, once, at its actual cost, which
 * every window then counts.
 *
 * Every reservation records who it is for (migration 270): the operation's sender and the Central
 * City account it was sponsored for (NULL: the platform itself, no account). Within each class
 * (ordinary, exit) one account and one sender each have an hourly cap of their own, one account a
 * daily exit cap too, and one account holds at most a few never-sent owner handouts at a time (10,
 * of them 2 exits), so no single account can take the shared hour from everyone else. These own caps count every
 * reservation made in the window, released or lapsed too (one account's churn stays its own).
 * Operator accounts (sponsor-operators.ts: the accounts proven to hold a fleet owner key listed in
 * CITY_BASE_SPONSOR_OPERATOR_OWNERS) skip the per-account, per-sender and
 * never-sent caps and the handout share, never the deployment-wide hours and days (bar the first 3
 * exits a day every account keeps past the exit day figure, above). An operator account may be a
 * workspace: registrations are sponsored for the agent's workspace, so its exemption here, like
 * the registration rate's (identity/routes.ts, keyed by workspace), is workspace-wide: it covers
 * every person acting in that workspace, a co-owner without the fleet key too, not only the person
 * whose key proved it. A reservation with no account counts against the
 * global and per-sender caps only. A sponsorship meets its caps once, at reserve, before anyone
 * signs.
 *
 * The submitter's exposure (exposeIn). At send, the submitter's own transaction for a sponsorship
 * is recorded for the same account and sender, but admitted against the deposit only, ordinary or
 * exit alike: an operation its owner signed is never refused at send for an hour that others filled
 * meanwhile. It counts in the shared hours and days (it is gas in flight; those caps were sized for
 * it), but not in the deployment's exit day, which counts the sponsorships themselves; never in an
 * account's or sender's own caps (each operation counts once there, at reserve). A
 * self-paid operation (no paymaster: the wallet pays its own gas) is its own class, 'selfPaid': its
 * exposure is checked only against the submitter's float (the balance the caller read, less its
 * reserve) and counts nowhere else, so the owner-funded way out stays open when the sponsored hours
 * are full.
 *
 * `deposit@block` is the paymaster's EntryPoint deposit read from Base at a known block (the truth:
 * what executed up to that block is gone from it), read inside the lock. Outstanding reservations may
 * still execute, so they are subtracted. A reservation settled by a receipt in a LATER block was still
 * in that deposit reading, so it is subtracted too (coherent with the block, never double-spendable);
 * one settled at or before the block is already out of it. An operation that executed but whose
 * receipt is not settled yet is counted twice (outstanding and gone from the deposit): conservative.
 * `overhead` is the envelope's gas spent outside the paymaster (deploy, allowlist, submitter float,
 * failed submitter transactions), entered by the operator (recordOverhead) so the ordinary ceiling
 * counts it once.
 *
 * Lifecycle: 'reserved' when the signature is handed out, 'sent' once the submitter stored a
 * transaction carrying it, 'settled' with its actual cost and block from the receipt, or 'expired'
 * when it was never sent and EXPIRY_MARGIN_S has passed after its validUntil (EntryPoint refuses it
 * after validUntil: AA32; the margin covers clock skew). A late receipt still settles an expired one.
 * A 'sent' reservation is never expired by time. A never-sent one whose owner operation was
 * cancelled or lapsed unsigned, or whose server-side send was refused before any broadcast, is
 * released early (release: 'expired' with released_at); markSentIn never moves it again.
 */
import type { UserOperation } from 'viem/account-abstraction';
import { BASE_MAINNET, BASE_SEPOLIA } from '../../../shared/base/chains.js';
import { ARC_MAINNET, ARC_TESTNET } from '../../../shared/chains.js';
import type { Database, Transaction } from '../../database.js';
import { registerMigration, type Migration } from '../../migrations.js';
import { chainParams, PRIOR_ORDINARY_FEES_WEI } from './chain-params.js';
import { OWNER_SIGNED_FLOWS, PROTECTED_FLOWS, type SponsorFlow } from './own-paymaster-policy.js';
import { maxCostWei } from './submit.js';

/** Every table Operation Paymaster adds (migrations 256-257), for the backup's recognized list. */
export const OWN_PAYMASTER_TABLES = [
  'own_paymaster_keys',
  'own_paymaster_budget',
  'own_paymaster_reservations',
] as const;

export const OWN_PAYMASTER_BUDGET_SQL = `
CREATE TABLE IF NOT EXISTS own_paymaster_budget (
  id integer PRIMARY KEY CHECK (id = 1),
  overhead_wei numeric(78,0) NOT NULL DEFAULT 0 CHECK (overhead_wei >= 0),
  updated_at bigint NOT NULL
);
INSERT INTO own_paymaster_budget (id, overhead_wei, updated_at) VALUES (1, 0, 0) ON CONFLICT (id) DO NOTHING;
CREATE TABLE IF NOT EXISTS own_paymaster_reservations (
  user_op_hash text PRIMARY KEY CHECK (user_op_hash ~ '^0x[0-9a-f]{64}$'),
  flow text NOT NULL,
  protected boolean NOT NULL,
  max_cost_wei numeric(78,0) NOT NULL CHECK (max_cost_wei > 0),
  actual_cost_wei numeric(78,0) CHECK (actual_cost_wei IS NULL OR actual_cost_wei >= 0),
  settled_block numeric(78,0),
  status text NOT NULL CHECK (status IN ('reserved','sent','settled','expired')),
  valid_until bigint NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  CHECK ((status = 'settled') = (actual_cost_wei IS NOT NULL AND settled_block IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS own_paymaster_reservations_open ON own_paymaster_reservations (status)
  WHERE status IN ('reserved','sent');
CREATE INDEX IF NOT EXISTS own_paymaster_reservations_recent ON own_paymaster_reservations (created_at);
CREATE INDEX IF NOT EXISTS own_paymaster_reservations_settled ON own_paymaster_reservations (settled_block)
  WHERE status = 'settled';
`;

/** Migration 257: two new tables (the gate's lock row and its reservations); nothing else touched. */
export const ownPaymasterBudgetMigration: Migration = {
  version: 257,
  name: 'own_paymaster_budget',
  sql: OWN_PAYMASTER_BUDGET_SQL,
};

/**
 * Migration 270: who a reservation is for. `sender` is the UserOperation's sender (lowercase),
 * `account_id` the Central City account it was sponsored for (NULL: the platform itself, and every
 * row from before); `released_at` marks a never-sent reservation released early. Nullable columns
 * and two indexes for the per-account and per-sender hourly sums; nothing else touched.
 */
export const OWN_PAYMASTER_ATTRIBUTION_SQL = `
ALTER TABLE own_paymaster_reservations ADD COLUMN IF NOT EXISTS sender text
  CHECK (sender IS NULL OR sender ~ '^0x[0-9a-f]{40}$');
ALTER TABLE own_paymaster_reservations ADD COLUMN IF NOT EXISTS account_id text;
ALTER TABLE own_paymaster_reservations ADD COLUMN IF NOT EXISTS released_at bigint;
CREATE INDEX IF NOT EXISTS own_paymaster_reservations_account
  ON own_paymaster_reservations (account_id, created_at);
CREATE INDEX IF NOT EXISTS own_paymaster_reservations_sender
  ON own_paymaster_reservations (sender, created_at);
`;

export const ownPaymasterAttributionMigration: Migration = {
  version: 270,
  name: 'own_paymaster_attribution',
  sql: OWN_PAYMASTER_ATTRIBUTION_SQL,
};
/**
 * Migrations 349 and 350: a budget per chain, because wei on two chains must never add up. The live
 * row keeps id 1 and is Base's; every other chain the wallet tables allow gets its row here, so the
 * lock below always has a row to lock (a missing one would silently lock nothing). Reservations keep
 * their key: a UserOperation hash already includes the chain. Old instances keep working during a
 * rollout: id 1 still answers, and what they insert is Base's. lock_timeout 2 s: if the lock is not
 * had, the migration rolls back and the next cold start tries again.
 */
export const OWN_PAYMASTER_BUDGET_CHAIN_SQL = `
SET LOCAL lock_timeout = '2s';
ALTER TABLE own_paymaster_budget DROP CONSTRAINT IF EXISTS own_paymaster_budget_id_check;
ALTER TABLE own_paymaster_budget ADD COLUMN IF NOT EXISTS chain_id integer NOT NULL DEFAULT ${BASE_MAINNET};
ALTER TABLE own_paymaster_budget DROP CONSTRAINT IF EXISTS own_paymaster_budget_chain_key;
ALTER TABLE own_paymaster_budget ADD CONSTRAINT own_paymaster_budget_chain_key UNIQUE (chain_id);
INSERT INTO own_paymaster_budget (id, chain_id, overhead_wei, updated_at)
  VALUES ${[BASE_SEPOLIA, 31337, ARC_MAINNET, ARC_TESTNET].map((chain) => `(${chain}, ${chain}, 0, 0)`).join(', ')}
  ON CONFLICT DO NOTHING;
`;
export const OWN_PAYMASTER_RESERVATIONS_CHAIN_SQL = `
SET LOCAL lock_timeout = '2s';
ALTER TABLE own_paymaster_reservations ADD COLUMN IF NOT EXISTS chain_id integer NOT NULL DEFAULT ${BASE_MAINNET};
`;

export function registerOwnPaymasterBudgetMigration(): void {
  registerMigration(ownPaymasterBudgetMigration);
  registerMigration(ownPaymasterAttributionMigration);
  registerMigration({
    version: 349,
    name: 'own_paymaster_budget_chain',
    sql: OWN_PAYMASTER_BUDGET_CHAIN_SQL,
  });
  registerMigration({
    version: 350,
    name: 'own_paymaster_reservations_chain',
    sql: OWN_PAYMASTER_RESERVATIONS_CHAIN_SQL,
  });
}

export interface BudgetLimits {
  /** Ordinary work (everything but exits) plus overhead, in total. */
  ordinaryCeilingWei: bigint;
  /** Ordinary work per rolling hour. */
  hourlyOrdinaryWei: bigint;
  /** Deposit kept for exits only. */
  protectedWei: bigint;
  /** Exits per rolling hour, deployment-wide. */
  hourlyExitWei: bigint;
  /**
   * Exits per rolling day, deployment-wide: a figure, not a ceiling. Past it an exit is refused
   * (exit_daily, ALERT) unless it is one of its account's first freeDailyExitsPerAccount of the
   * day, which is admitted and reported (ALERT, once a rolling day per instance).
   */
  dailyExitWei: bigint;
  /**
   * Of each shared hour (ordinary, exit), the part never-sent owner handouts may hold between
   * them, in basis points.
   */
  handoutShareBps: number;
  /** Ordinary work of one account / one sender per rolling hour. */
  accountHourlyOrdinaryWei: bigint;
  senderHourlyOrdinaryWei: bigint;
  /** Exits of one account / one sender per rolling hour. */
  accountHourlyExitWei: bigint;
  senderHourlyExitWei: bigint;
  /** Exits of one account per rolling day. */
  accountDailyExitWei: bigint;
  /**
   * An account's first exits of a rolling day (those that still count in the shared day) are not
   * held to the deployment-wide day (dailyExitWei): accounts that used theirs up can pause exits
   * for others only down to this many each.
   */
  freeDailyExitsPerAccount: number;
  /** Never-sent owner handouts ('reserved', OWNER_SIGNED_FLOWS) one account may hold at a time. */
  unsignedOpenPerAccount: number;
  /** Of those, never-sent exits (withdrawals, cancels, revokes). */
  unsignedOpenExitPerAccount: number;
}
export { PRIOR_ORDINARY_FEES_WEI };
/** Base's limits (chain-params.ts holds every chain's, and the reasons for each number). */
export const BUDGET_LIMITS: BudgetLimits = chainParams(BASE_MAINNET).budget;
/** Seconds after validUntil before a never-sent reservation lapses (clock skew between us and Base). */
export const EXPIRY_MARGIN_S = 120;

export type BudgetRefusal =
  | 'ordinary_ceiling'
  | 'hourly'
  | 'protected_reserve'
  | 'deposit'
  | 'account_hourly'
  | 'sender_hourly'
  | 'exit_hourly'
  | 'exit_daily'
  | 'account_daily'
  | 'handout_share'
  | 'unsigned_open'
  | 'submitter_float';
export class BudgetError extends Error {
  constructor(readonly reason: BudgetRefusal) {
    super(`Sponsorship refused by the budget (${reason}).`);
  }
}

/** Whether a refusal is a cap that frees up later (retry later), never a policy denial. */
export const budgetTransient = (reason: BudgetRefusal) => reason !== 'deposit';

/** Refusals the operator must hear about at once (the bundler logs them as ALERT). */
export const budgetAlert = (reason: BudgetRefusal) =>
  reason === 'deposit' || reason === 'exit_daily' || reason === 'protected_reserve';

/** The class of a self-paid operation's submitter exposure (no paymaster, no reservation). */
export const SELF_PAID = 'selfPaid' as const;
/** What a reservation row records as its flow: a sponsorship's, or SELF_PAID. */
export type ExposureFlow = SponsorFlow | typeof SELF_PAID;

/** Who a sponsorship is for: the operation's sender, and its account (null: the platform). */
export interface Sponsee {
  sender: string;
  accountId: string | null;
}

/** What EntryPoint v0.6 may charge for the operation once it carries our paymaster (× 3 verification). */
export function worstCaseWei(
  op: Pick<
    UserOperation<'0.6'>,
    'callGasLimit' | 'verificationGasLimit' | 'preVerificationGas' | 'maxFeePerGas'
  >,
): bigint {
  return maxCostWei({ ...(op as UserOperation<'0.6'>), paymasterAndData: '0x01' });
}

/** The paymaster's EntryPoint deposit at a block (EntryPoint.balanceOf(paymaster), blockTag). */
export interface DepositReading {
  wei: bigint;
  block: bigint;
}

interface Sums {
  overhead: bigint;
  ordinaryDone: bigint;
  ordinaryOpen: bigint;
  hourOrdinary: bigint;
  hourExit: bigint;
  dayExit: bigint;
  handoutOrdinary: bigint;
  handoutExit: bigint;
  allOpen: bigint;
  settledAfter: bigint;
  selfPaidOpen: bigint;
}

/** The owner-signed flows, as a SQL array literal (constants only). */
const OWNER_SIGNED_SQL = `ARRAY[${[...OWNER_SIGNED_FLOWS].map((flow) => `'${flow}'`).join(',')}]::text[]`;
/** Settled: what it actually cost; otherwise its worst case. */
const COST = `CASE WHEN status = 'settled' THEN actual_cost_wei ELSE max_cost_wei END`;
/** A sponsorship's own reservation (an exposure row has valid_until 0). */
const RESERVATION = 'valid_until > 0';
const SPONSORED = `flow <> '${SELF_PAID}'`;
/** A signature not yet past validUntil + margin (`at`: the parameter holding now): it may still execute. */
const live = (at: string) => `(valid_until + ${EXPIRY_MARGIN_S}) * 1000 >= ${at}`;
/** Released while never sent, with a signature that may still execute. */
const releasedLive = (at: string) =>
  `(status = 'expired' AND released_at IS NOT NULL AND ${live(at)})`;

/**
 * The SQL of what a never-sent reservation still holds (see the header). With `bound`, a released
 * one holds nothing at once; without, it holds what an open one does until validUntil + margin.
 * Either way a never-sent one holds nothing once its signature can no longer execute.
 */
function windows(bound: boolean, at = '$3') {
  const RELEASED_LIVE = releasedLive(at);
  return {
    /** Still able to execute: counted against the deposit and the ordinary ceiling. */
    outstanding: bound
      ? `status IN ('reserved','sent')`
      : `(status IN ('reserved','sent') OR ${RELEASED_LIVE})`,
    /** Counted in the shared hours and days (created inside the window). */
    shared: bound ? `status <> 'expired'` : `(status <> 'expired' OR ${RELEASED_LIVE})`,
    /** A never-sent owner handout, counted in the handout share. */
    handout: `${RESERVATION} AND flow = ANY(${OWNER_SIGNED_SQL}) AND ${
      bound ? `status = 'reserved'` : `(status = 'reserved' OR ${RELEASED_LIVE})`
    }`,
  };
}

async function sums(
  tx: Transaction,
  w: ReturnType<typeof windows>,
  now: number,
  afterBlock: bigint,
  chainId: number,
): Promise<Sums> {
  const { rows } = await tx.query<Record<keyof Sums | 'at', string>>(
    `SELECT
       $3::bigint AS "at",
       (SELECT overhead_wei FROM own_paymaster_budget WHERE chain_id = $5)::text AS "overhead",
       COALESCE(SUM(actual_cost_wei) FILTER (WHERE NOT protected AND status = 'settled' AND ${SPONSORED}), 0)::text AS "ordinaryDone",
       COALESCE(SUM(max_cost_wei) FILTER (WHERE NOT protected AND ${w.outstanding} AND ${SPONSORED}), 0)::text AS "ordinaryOpen",
       COALESCE(SUM(${COST}) FILTER (WHERE NOT protected AND ${SPONSORED} AND created_at > $1 AND ${w.shared}), 0)::text AS "hourOrdinary",
       COALESCE(SUM(${COST}) FILTER (WHERE protected AND created_at > $1 AND ${w.shared}), 0)::text AS "hourExit",
       COALESCE(SUM(${COST}) FILTER (WHERE protected AND created_at > $4 AND ${RESERVATION} AND ${w.shared}), 0)::text AS "dayExit",
       COALESCE(SUM(max_cost_wei) FILTER (WHERE NOT protected AND ${w.handout}), 0)::text AS "handoutOrdinary",
       COALESCE(SUM(max_cost_wei) FILTER (WHERE protected AND ${w.handout}), 0)::text AS "handoutExit",
       COALESCE(SUM(max_cost_wei) FILTER (WHERE ${w.outstanding} AND ${SPONSORED}), 0)::text AS "allOpen",
       COALESCE(SUM(actual_cost_wei) FILTER (WHERE status = 'settled' AND settled_block > $2 AND ${SPONSORED}), 0)::text AS "settledAfter",
       COALESCE(SUM(max_cost_wei) FILTER (WHERE flow = '${SELF_PAID}' AND status = 'sent'), 0)::text AS "selfPaidOpen"
     FROM own_paymaster_reservations
     WHERE chain_id = $5`,
    [now - HOUR_MS, afterBlock.toString(), now, now - DAY_MS, chainId],
  );
  const r = rows[0]!;
  return {
    overhead: BigInt(r.overhead ?? '0'),
    ordinaryDone: BigInt(r.ordinaryDone),
    ordinaryOpen: BigInt(r.ordinaryOpen),
    hourOrdinary: BigInt(r.hourOrdinary),
    hourExit: BigInt(r.hourExit),
    dayExit: BigInt(r.dayExit),
    handoutOrdinary: BigInt(r.handoutOrdinary),
    handoutExit: BigInt(r.handoutExit),
    allOpen: BigInt(r.allOpen),
    settledAfter: BigInt(r.settledAfter),
    selfPaidOpen: BigInt(r.selfPaidOpen),
  };
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * One account's and one sender's own windows in a class: the reservations made in them (settled
 * actual, else worst case; released and lapsed ones count too), never an exposure; the account's
 * never-sent owner handouts (all classes, and this class's), the ones of this class it holds in
 * the handout share, and, for exits, how many of its exits of the day still count in the shared day.
 */
async function sponseeSums(
  tx: Transaction,
  bound: boolean,
  now: number,
  isProtected: boolean,
  who: { sender: string | null; accountId: string | null },
  chainId: number,
) {
  const w = windows(bound, '$6');
  const { rows } = await tx.query<{
    account: string;
    sender: string;
    accountDay: string;
    unsigned: number;
    unsignedClass: number;
    heldClass: number;
    dayExits: number;
  }>(
    `SELECT
       $6::bigint AS "at",
       COALESCE(SUM(${COST}) FILTER (WHERE protected = $4 AND created_at > $1 AND account_id = $2), 0)::text AS account,
       COALESCE(SUM(${COST}) FILTER (WHERE protected = $4 AND created_at > $1 AND sender = $3), 0)::text AS sender,
       COALESCE(SUM(${COST}) FILTER (WHERE protected = $4 AND account_id = $2), 0)::text AS "accountDay",
       count(*) FILTER (WHERE status = 'reserved' AND account_id = $2
         AND flow = ANY(${OWNER_SIGNED_SQL}))::int AS unsigned,
       count(*) FILTER (WHERE status = 'reserved' AND account_id = $2 AND protected = $4
         AND flow = ANY(${OWNER_SIGNED_SQL}))::int AS "unsignedClass",
       count(*) FILTER (WHERE account_id = $2 AND protected = $4 AND ${w.handout})::int AS "heldClass",
       count(*) FILTER (WHERE account_id = $2 AND protected AND $4 AND ${w.shared})::int AS "dayExits"
     FROM own_paymaster_reservations
     WHERE chain_id = $7 AND created_at > $5 AND (account_id = $2 OR sender = $3) AND ${RESERVATION} AND ${SPONSORED}
       AND (protected = $4 OR status = 'reserved')`,
    [
      now - HOUR_MS,
      who.accountId,
      who.sender,
      isProtected,
      now - (isProtected ? DAY_MS : HOUR_MS),
      now,
      chainId,
    ],
  );
  const r = rows[0]!;
  return {
    account: BigInt(r.account),
    sender: BigInt(r.sender),
    accountDay: BigInt(r.accountDay),
    unsigned: Number(r.unsigned),
    unsignedClass: Number(r.unsignedClass),
    heldClass: Number(r.heldClass),
    dayExits: Number(r.dayExits),
  };
}

const ADDRESS = /^0x[0-9a-f]{40}$/;

/** An exit admitted past the deployment's exit day (first of its account's day): the day's sum with it. */
interface PastExitDay {
  dayExitWei: bigint;
}

/** markSent on a reservation that is no longer open: the operation must not be broadcast. */
export class ReservationGone extends Error {
  constructor() {
    super('The reservation is no longer open; do not send this operation.');
  }
}

export class ReservationConflict extends Error {
  constructor() {
    super('This operation was reserved with another flow or cost.');
  }
}

export function ownPaymasterBudget(deps: {
  db: Database;
  /** The chain this budget is for: its own lock row, sums and overhead. Default Base mainnet. */
  chainId?: number;
  /** A FRESH read of the deposit at a known block (no cache): it is taken while holding the lock. */
  deposit: () => Promise<DepositReading>;
  /** Read at every admission; a limit left out is BUDGET_LIMITS'. */
  limits?: Partial<BudgetLimits>;
  /**
   * Operator accounts (sponsor-operators.ts), read at every admission: no per-account, per-sender
   * or never-sent caps and no handout share. The deployment-wide caps and the deposit still bind.
   */
  operatorAccounts?: () => ReadonlySet<string>;
  /**
   * Every sponsorship admitted here is signed with allowAnyBundler = false for a paymaster whose
   * only allowlisted bundlers are our submitters, and is broadcast only after markSentIn: a
   * never-sent reservation that was released or lapsed then provably cannot execute (see the
   * header). Default false: it is held as if it could, until validUntil + margin and for its windows.
   */
  submitterBound?: boolean;
  now?: () => number;
  /** Where an ALERT line goes (the bundler's log); default nowhere. */
  log?: (line: string) => void;
}) {
  const limit = <K extends keyof BudgetLimits>(key: K): BudgetLimits[K] =>
    deps.limits?.[key] ?? BUDGET_LIMITS[key];
  const limitsNow = (): BudgetLimits => ({ ...BUDGET_LIMITS, ...deps.limits });
  const operators = deps.operatorAccounts ?? (() => new Set<string>());
  const now = deps.now ?? Date.now;
  const chainId = deps.chainId ?? BASE_MAINNET;
  /** One admission at a time on this chain; another chain's budget is not held up. */
  const lockBudget = (tx: Transaction) =>
    tx.query('SELECT id FROM own_paymaster_budget WHERE chain_id = $1 FOR UPDATE', [chainId]);
  const bound = deps.submitterBound === true;
  const w = windows(bound);
  /** The handout share of a shared hourly cap. */
  const share = (cap: bigint) => (cap * BigInt(limit('handoutShareBps'))) / 10_000n;
  const log = deps.log ?? (() => {});
  /** When this instance last reported an exit admitted past the exit day (noticePastExitDay). */
  let pastExitDayNoticeAt = -Infinity;
  /**
   * An exit was admitted (committed) past the deployment's exit day only as one of its account's
   * first exits of the day: logged as ALERT at most once per rolling day per instance, since the
   * day figure is not a ceiling (each account's first exits pass it; the exit hour binds them).
   */
  const noticePastExitDay = (past: PastExitDay) => {
    const at = now();
    if (at - pastExitDayNoticeAt < DAY_MS) return;
    pastExitDayNoticeAt = at;
    log(
      `own paymaster: ALERT exits past the deployment exit day (${past.dayExitWei} wei in the last 24 h, day figure ${limit('dailyExitWei')} wei), admitted as accounts' first ${limit('freeDailyExitsPerAccount')} exits of the day; the exit hour still bounds them; next notice at most in 24 h`,
    );
  };

  /** Lapses reservations that were never sent and can no longer execute (validUntil + margin). */
  const expire = (tx: Transaction, at: number) =>
    tx.query(
      `UPDATE own_paymaster_reservations SET status = 'expired', updated_at = $1
       WHERE status = 'reserved' AND (valid_until + $2) * 1000 < $1`,
      [at, EXPIRY_MARGIN_S],
    );

  async function markSentIn(tx: Transaction, userOpHash: string): Promise<void> {
    const at = now();
    await lockBudget(tx);
    await expire(tx, at);
    const moved = await tx.query(
      `UPDATE own_paymaster_reservations SET status = 'sent', updated_at = $2
       WHERE user_op_hash = $1 AND status IN ('reserved','sent') RETURNING user_op_hash`,
      [userOpHash.toLowerCase(), at],
    );
    if (moved.rows.length !== 1) throw new ReservationGone();
  }

  async function settleIn(
    tx: Transaction,
    userOpHash: string,
    actualCostWei: bigint,
    block: bigint,
  ): Promise<void> {
    if (actualCostWei < 0n) throw new Error('A cost is never negative.');
    await lockBudget(tx);
    await tx.query(
      `UPDATE own_paymaster_reservations
         SET status = 'settled', actual_cost_wei = $2, settled_block = $3, updated_at = $4
       WHERE user_op_hash = $1 AND status IN ('reserved','sent','expired')`,
      [userOpHash.toLowerCase(), actualCostWei.toString(), block.toString(), now()],
    );
  }

  type Admission =
    /** A new sponsorship (reserve): every cap; `handout` an owner-signed one. */
    | { kind: 'reserve'; handout: boolean }
    /** The submitter's exposure for a sponsorship, or a raise of one: the deposit only. */
    | { kind: 'exposure' }
    /** A self-paid operation's exposure: the submitter's float only (none given: unchecked). */
    | { kind: 'selfPaid'; floatWei?: bigint };

  /**
   * The admission rules for `cost` more, under the lock, against a deposit read inside it: no
   * settlement can land between this reading and the decision. Throws BudgetError.
   */
  async function admit(
    tx: Transaction,
    at: number,
    isProtected: boolean,
    cost: bigint,
    who: { sender: string | null; accountId: string | null },
    admission: Admission,
  ): Promise<PastExitDay | null> {
    if (admission.kind === 'selfPaid') {
      if (admission.floatWei === undefined) return null;
      const open = (
        await tx.query<{ open: string }>(
          `SELECT COALESCE(SUM(max_cost_wei), 0)::text AS open FROM own_paymaster_reservations
           WHERE chain_id = $1 AND flow = '${SELF_PAID}' AND status = 'sent'`,
          [chainId],
        )
      ).rows[0]!.open;
      if (BigInt(open) + cost > admission.floatWei) throw new BudgetError('submitter_float');
      return null;
    }
    const deposit = await deps.deposit();
    const s = await sums(tx, w, at, deposit.block, chainId);
    const free = deposit.wei - s.allOpen - s.settledAfter - cost;
    if (free < 0n) throw new BudgetError('deposit');
    if (admission.kind === 'exposure') return null;
    const operator = who.accountId !== null && operators().has(who.accountId);
    const own =
      who.accountId === null && who.sender === null
        ? null
        : await sponseeSums(tx, bound, at, isProtected, who, chainId);
    let pastDay: PastExitDay | null = null;
    if (!isProtected) {
      if (s.overhead + s.ordinaryDone + s.ordinaryOpen + cost > limit('ordinaryCeilingWei'))
        throw new BudgetError('ordinary_ceiling');
      if (s.hourOrdinary + cost > limit('hourlyOrdinaryWei')) throw new BudgetError('hourly');
      if (free < limit('protectedWei')) throw new BudgetError('protected_reserve');
    } else {
      if (s.hourExit + cost > limit('hourlyExitWei')) throw new BudgetError('exit_hourly');
      // An account's first exits of the day are not held to the shared day: accounts that loop
      // exits up to it never pause everyone else's way out. One admitted past the day only that way
      // is reported (noticePastExitDay): the day figure is not a ceiling, the exit hour is.
      if (s.dayExit + cost > limit('dailyExitWei')) {
        const firstOfDay =
          who.accountId !== null && own!.dayExits < limit('freeDailyExitsPerAccount');
        if (!firstOfDay) throw new BudgetError('exit_daily');
        pastDay = { dayExitWei: s.dayExit + cost };
      }
    }
    // The handout share is fair per account: one that holds no handout of this class in it may
    // always take one (only the shared hour and day above bound it), so the share never refuses
    // an owner's first. The shared hour above still does once enough accounts each hold a first
    // (the header's residual). Operator accounts sign theirs at once.
    if (admission.handout && !operator && !(who.accountId !== null && own!.heldClass === 0)) {
      const held = isProtected ? s.handoutExit : s.handoutOrdinary;
      const cap = isProtected ? limit('hourlyExitWei') : limit('hourlyOrdinaryWei');
      if (held + cost > share(cap)) throw new BudgetError('handout_share');
    }
    if (operator || own === null) return pastDay;
    if (who.accountId !== null) {
      if (
        admission.handout &&
        (own.unsigned >= limit('unsignedOpenPerAccount') ||
          (isProtected && own.unsignedClass >= limit('unsignedOpenExitPerAccount')))
      )
        throw new BudgetError('unsigned_open');
      const cap = isProtected ? limit('accountHourlyExitWei') : limit('accountHourlyOrdinaryWei');
      if (own.account + cost > cap) throw new BudgetError('account_hourly');
      if (isProtected && own.accountDay + cost > limit('accountDailyExitWei'))
        throw new BudgetError('account_daily');
    }
    if (who.sender !== null) {
      const cap = isProtected ? limit('senderHourlyExitWei') : limit('senderHourlyOrdinaryWei');
      if (own.sender + cost > cap) throw new BudgetError('sender_hourly');
    }
    return pastDay;
  }

  /**
   * The submitter's own exposure for one operation: what its handleOps transaction may
   * cost beyond the EntryPoint's repayment (gas limit x max fee + L1 data fee, the conservative
   * side). Reserved under `key` BEFORE the first broadcast and raised BEFORE a replacement is
   * signed: alternatives at one nonce count once, at their largest (only one can be mined), and
   * only the increase is admitted. Settled once, at the measured overhead (settleIn). A
   * sponsorship's counts against the deposit and the shared windows too, which only makes the gate
   * more careful; a self-paid one only against the submitter's float. Takes the budget lock; the
   * caller takes its lane lock after it.
   */
  async function exposeIn(
    tx: Transaction,
    input: {
      key: string;
      flow: ExposureFlow;
      maxCostWei: bigint;
      /** The sponsorship's sender and account (its own record), or a self-paid op's sender. */
      sender: string | null;
      accountId: string | null;
      /**
       * A sponsorship's exposure: its reserve() already admitted it against every cap, so only the
       * deposit applies here, ordinary or exit. False: a self-paid op, its own class (SELF_PAID),
       * checked only against `floatWei`.
       */
      sponsored: boolean;
      /**
       * The submitter's balance less the reserve it keeps, read just before: what self-paid
       * exposures may hold in all (unset: not checked here).
       */
      floatWei?: bigint;
    },
  ): Promise<void> {
    const key = input.key.toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(key)) throw new Error('An exposure key is 32 bytes.');
    if (input.maxCostWei <= 0n) throw new Error('An exposure costs more than 0.');
    const sender = input.sender === null ? null : input.sender.toLowerCase();
    if (sender !== null && !ADDRESS.test(sender)) throw new Error('A sender is an address.');
    const at = now();
    await lockBudget(tx);
    await expire(tx, at);
    const known = await tx.query<{
      max_cost_wei: string;
      status: string;
      protected: boolean;
      flow: string;
    }>(
      `SELECT max_cost_wei::text AS max_cost_wei, status, protected, flow
       FROM own_paymaster_reservations WHERE user_op_hash = $1`,
      [key],
    );
    const row = known.rows[0];
    const selfPaid: Admission = { kind: 'selfPaid', floatWei: input.floatWei };
    if (row) {
      if (row.status !== 'sent') throw new ReservationConflict();
      const old = BigInt(row.max_cost_wei);
      if (input.maxCostWei <= old) return;
      // A replacement of a transaction already out: its own class's check only (a sponsorship's:
      // the deposit), so that one busy account or a full hour never leaves an operation already
      // out stuck (the raise still counts against them).
      await admit(
        tx,
        at,
        row.protected,
        input.maxCostWei - old,
        { sender: null, accountId: null },
        row.flow === SELF_PAID ? selfPaid : { kind: 'exposure' },
      );
      await tx.query(
        'UPDATE own_paymaster_reservations SET max_cost_wei = $2, updated_at = $3 WHERE user_op_hash = $1',
        [key, input.maxCostWei.toString(), at],
      );
      return;
    }
    const flow: ExposureFlow = input.sponsored ? input.flow : SELF_PAID;
    const isProtected = flow !== SELF_PAID && PROTECTED_FLOWS.has(flow);
    await admit(
      tx,
      at,
      isProtected,
      input.maxCostWei,
      { sender: null, accountId: null },
      input.sponsored ? { kind: 'exposure' } : selfPaid,
    );
    await tx.query(
      `INSERT INTO own_paymaster_reservations
         (user_op_hash, flow, protected, max_cost_wei, status, valid_until, created_at, updated_at,
          sender, account_id, chain_id)
       VALUES ($1, $2, $3, $4, 'sent', 0, $5, $5, $6, $7, $8)`,
      [key, flow, isProtected, input.maxCostWei.toString(), at, sender, input.accountId, chainId],
    );
  }

  /**
   * Settles at the reservation's own worst case (max_cost_wei): an outcome nobody can measure (a
   * nonce consumed without any of our receipts) is never counted as free.
   */
  async function settleWorstIn(tx: Transaction, key: string, block: bigint): Promise<void> {
    await lockBudget(tx);
    await tx.query(
      `UPDATE own_paymaster_reservations
         SET status = 'settled', actual_cost_wei = max_cost_wei, settled_block = $2, updated_at = $3
       WHERE user_op_hash = $1 AND status IN ('reserved','sent','expired')`,
      [key.toLowerCase(), block.toString(), now()],
    );
  }

  async function recordOverheadIn(tx: Transaction, wei: bigint): Promise<void> {
    if (wei < 0n) throw new Error('Overhead is never negative.');
    await tx.query(
      'UPDATE own_paymaster_budget SET overhead_wei = overhead_wei + $1, updated_at = $2 WHERE chain_id = $3',
      [wei.toString(), now(), chainId],
    );
  }

  return {
    /**
     * Reserves the worst case of one sponsorship, or throws BudgetError. Call it BEFORE the
     * signature leaves the server. Idempotent per userOpHash (the same op asked again keeps its one
     * reservation); the same hash with another flow or cost is a ReservationConflict.
     */
    async reserve(input: {
      userOpHash: string;
      flow: SponsorFlow;
      maxCostWei: bigint;
      validUntil: number;
      /** The operation's sender. */
      sender: string;
      /** The account it is sponsored for; null when the platform itself sponsors it. */
      accountId: string | null;
    }): Promise<void> {
      const hash = input.userOpHash.toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error('userOpHash must be 32 bytes.');
      const sender = input.sender.toLowerCase();
      if (!ADDRESS.test(sender)) throw new Error('sender must be an address.');
      if (input.accountId !== null && !input.accountId)
        throw new Error('accountId is an id or null.');
      if (!Number.isSafeInteger(input.validUntil) || input.validUntil <= 0)
        throw new Error('validUntil must be whole seconds.');
      if (input.maxCostWei <= 0n) throw new Error('A reservation costs more than 0.');
      const isProtected = PROTECTED_FLOWS.has(input.flow);
      const admitted: { pastDay: PastExitDay | null } = { pastDay: null };
      await deps.db.transaction(async (tx) => {
        const at = now();
        await lockBudget(tx);
        await expire(tx, at);
        const known = await tx.query<{
          flow: string;
          max_cost_wei: string;
          valid_until: string;
          status: string;
        }>(
          `SELECT flow, max_cost_wei::text AS max_cost_wei, valid_until::text AS valid_until, status
           FROM own_paymaster_reservations WHERE user_op_hash = $1`,
          [hash],
        );
        if (known.rows.length) {
          // The same operation asked again: only an exact, still-open reservation is its own;
          // an expired or settled one is never revived (its headroom may be someone else's now).
          const row = known.rows[0]!;
          if (
            row.flow !== input.flow ||
            BigInt(row.max_cost_wei) !== input.maxCostWei ||
            Number(row.valid_until) !== input.validUntil ||
            !(row.status === 'reserved' || row.status === 'sent')
          )
            throw new ReservationConflict();
          return;
        }
        const cost = input.maxCostWei;
        admitted.pastDay = await admit(
          tx,
          at,
          isProtected,
          cost,
          { sender, accountId: input.accountId },
          { kind: 'reserve', handout: OWNER_SIGNED_FLOWS.has(input.flow) },
        );
        await tx.query(
          `INSERT INTO own_paymaster_reservations
             (user_op_hash, flow, protected, max_cost_wei, status, valid_until, created_at, updated_at,
              sender, account_id, chain_id)
           VALUES ($1, $2, $3, $4, 'reserved', $5, $6, $6, $7, $8, $9)`,
          [
            hash,
            input.flow,
            isProtected,
            cost.toString(),
            input.validUntil,
            at,
            sender,
            input.accountId,
            chainId,
          ],
        );
      });
      if (admitted.pastDay) noticePastExitDay(admitted.pastDay);
    },

    /**
     * The operation it was handed out for will never be sent (its owner operation was cancelled or
     * lapsed unsigned, or the server's own send was refused before any broadcast): a reservation
     * still 'reserved' is released now instead of at validUntil + margin. A sent, settled or
     * unknown one is left as it is; asking twice is the same. Under the lock, so it cannot
     * interleave with markSent, which never moves it again. What it still holds afterwards is the
     * header's: nothing with `submitterBound`, else its windows until they pass.
     */
    async release(userOpHash: string): Promise<void> {
      const hash = userOpHash.toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error('userOpHash must be 32 bytes.');
      await deps.db.transaction(async (tx) => {
        const at = now();
        await lockBudget(tx);
        await expire(tx, at);
        await tx.query(
          `UPDATE own_paymaster_reservations SET status = 'expired', released_at = $2, updated_at = $2
           WHERE user_op_hash = $1 AND status = 'reserved'`,
          [hash, at],
        );
      });
    },

    /**
     * The submitter is about to store and broadcast a transaction carrying it: from now on it is
     * never expired by time. Call it BEFORE the broadcast; it throws ReservationGone when the
     * reservation is no longer open (expired: its headroom may already be someone else's), and
     * then the operation must NOT be sent (re-sponsor it instead). Under the lock, so it cannot
     * interleave with an expiry or an admission.
     */
    async markSent(userOpHash: string): Promise<void> {
      await deps.db.transaction((tx) => markSentIn(tx, userOpHash));
    },

    /**
     * A reservation's status, read under the lock after the expiry sweep (undefined: none). Every
     * markSentIn commits under the same lock and only moves 'reserved' or 'sent', so 'expired' (or
     * no reservation) here proves no transaction carrying it was ever stored or ever can be.
     */
    async lapsedState(userOpHash: string): Promise<string | undefined> {
      return deps.db.transaction(async (tx) => {
        await lockBudget(tx);
        await expire(tx, now());
        const row = await tx.query<{ status: string }>(
          'SELECT status FROM own_paymaster_reservations WHERE user_op_hash = $1',
          [userOpHash.toLowerCase()],
        );
        return row.rows[0]?.status;
      });
    },

    /**
     * markSent inside the caller's transaction: the submitter commits this move and
     * the signed transaction that carries the operation together, or neither. Takes the budget
     * lock first; callers take any lock of their own after it (one lock order, no deadlock).
     */
    markSentIn,

    /** settle inside the caller's transaction (the submitter's receipt bookkeeping). */
    settleIn,

    /** The submitter's exposure inside the caller's transaction (see exposeIn). */
    exposeIn,

    /** settle at the worst case, inside the caller's transaction (see settleWorstIn). */
    settleWorstIn,

    /**
     * Moves a still-open reservation to another key: the service reserves under the
     * paymaster digest BEFORE it signs, then re-keys to the userOpHash the signature produced.
     * Idempotent (already moved: nothing to do); a reservation that lapsed in between is
     * ReservationGone, and the signed operation must not be handed out. The same operation
     * prepared twice in one second reserves its digest twice: the target already holds the open
     * reservation, so the duplicate digest row is expired here, in the same transaction (never a
     * key collision, never budget held until it lapses).
     */
    async rekey(from: string, to: string): Promise<void> {
      const source = from.toLowerCase();
      const target = to.toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(source) || !/^0x[0-9a-f]{64}$/.test(target))
        throw new Error('Reservation keys are 32 bytes.');
      let gone = false;
      await deps.db.transaction(async (tx) => {
        await lockBudget(tx);
        await expire(tx, now());
        if (source !== target) {
          const held = await tx.query<{ status: string }>(
            'SELECT status FROM own_paymaster_reservations WHERE user_op_hash = $1',
            [target],
          );
          const status = held.rows[0]?.status;
          if (status !== undefined) {
            // The target is already reserved: release the duplicate digest row, never move it.
            await tx.query(
              `UPDATE own_paymaster_reservations SET status = 'expired', updated_at = $2
               WHERE user_op_hash = $1 AND status = 'reserved'`,
              [source, now()],
            );
            // Not open any more: the release commits, then the operation is refused below.
            gone = status !== 'reserved' && status !== 'sent';
            return;
          }
        }
        const moved = await tx.query(
          `UPDATE own_paymaster_reservations SET user_op_hash = $2, updated_at = $3
           WHERE user_op_hash = $1 AND status = 'reserved' RETURNING user_op_hash`,
          [source, target, now()],
        );
        if (moved.rows.length) return;
        const there = await tx.query<{ status: string }>(
          'SELECT status FROM own_paymaster_reservations WHERE user_op_hash = $1',
          [target],
        );
        const status = there.rows[0]?.status;
        if (status !== 'reserved' && status !== 'sent') throw new ReservationGone();
      });
      if (gone) throw new ReservationGone();
    },

    /** recordOverhead inside the caller's transaction (a reverted submitter transaction's gas). */
    recordOverheadIn,

    /**
     * The receipt: actualGasCost and its block (a conclusively failed transaction that never
     * included the operation settles at 0 in the block that proves it). Under the lock, so a
     * reservation never leaves "outstanding" while a reserve() decides. Settles expired ones too.
     */
    async settle(userOpHash: string, actualCostWei: bigint, block: bigint): Promise<void> {
      await deps.db.transaction((tx) => settleIn(tx, userOpHash, actualCostWei, block));
    },

    /** Envelope gas spent outside the paymaster (deploy, allowlist, failed submitter txs). */
    async recordOverhead(wei: bigint): Promise<void> {
      await deps.db.transaction((tx) => recordOverheadIn(tx, wei));
    },

    /** For the monitor: where the envelope stands right now. */
    async snapshot() {
      return deps.db.transaction(async (tx) => {
        await lockBudget(tx);
        await expire(tx, now());
        const deposit = await deps.deposit();
        const s = await sums(tx, w, now(), deposit.block, chainId);
        return {
          depositWei: deposit.wei,
          depositBlock: deposit.block,
          freeWei: deposit.wei - s.allOpen - s.settledAfter,
          openWei: s.allOpen,
          ordinarySpentWei: s.overhead + s.ordinaryDone,
          ordinaryOpenWei: s.ordinaryOpen,
          lastHourOrdinaryWei: s.hourOrdinary,
          lastHourExitWei: s.hourExit,
          lastDayExitWei: s.dayExit,
          unsignedHandoutOrdinaryWei: s.handoutOrdinary,
          unsignedHandoutExitWei: s.handoutExit,
          selfPaidOpenWei: s.selfPaidOpen,
          limits: limitsNow(),
        };
      });
    },
  };
}
