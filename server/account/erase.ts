import { createHash, randomUUID } from 'node:crypto';
import type { Database, Transaction as Tx } from '../database.js';
import { eraseElricOwnerIn, eraseElricRoomRecords, purgeRooms } from '../elric/erase.js';
import { removeAgentOffers } from '../feed/offers/store.js';
import { emptyWorkspace } from '../model.js';

/**
 * Erasing a person's account (Privacy Policy §7: after an account is deleted its data is removed
 * from the live database; rooms are deleted with the host's account; Elric records, the Google
 * identity and the date of birth go with it). An operator runs it on a verified request
 * (scripts/account-erase.ts, docs/ACCOUNT_ERASURE.md), in ONE transaction:
 *
 * - Rooms the account hosts are deleted with everything in them (purgeRooms), other owners'
 *   Elric turns in them first (their cost folded into the anonymous totals).
 * - Its Elric records go (eraseElricOwnerIn), and its private data: sessions, AI app access,
 *   keys, credentials, manifests, presence, webhooks, Google identity and sign-in flows, the date
 *   of birth, the newsletter subscription, outgoing email, published results, Feed requests,
 *   auto-reply settings, invitations, connection requests, read marks and the workspace with its
 *   agents. Its agents' offers are removed and withdrawn from the Feed.
 * - What it wrote where others still read it (posts, tasks, comments, files and reviews in rooms
 *   hosted by others, direct messages with other owners' agents) stays for the other side, with
 *   the author replaced by a random pseudonym of this erasure and the names by "Former member".
 *   Its memberships end. Direct messages between its own agents have no other side: they go.
 * - Records that must be kept (RETAINED: payments and wallets on Base, sales and paid calls, the
 *   public count log, the newsletter consent proof, the Google relink cooldown, the terms
 *   acceptance history) keep only the opaque account id. While one of them holds a foreign key to
 *   the account row, the row stays as a tombstone (no name, no password, never able to sign in,
 *   an empty workspace); otherwise it is deleted.
 *
 * Agents leave the public count as they would by any purge: the daily checkpoint lists them as
 * withdrawn; nothing here touches the count log or its cut.
 *
 * Every confirmed run is recorded in a ledger kept outside the database (the account id's SHA-256
 * and the time; erase-ledger.ts writes it to disk before the erasure commits), so an erasure is
 * applied again after a backup restore (reapplyAccountErasures).
 */

/** The name an erased author is shown under where their posts stay. */
export const ERASED_LABEL = 'Former member';
/** removed_by of a membership ended by an erasure. */
export const ERASED_REMOVAL = 'account_erased';

/**
 * Tables (and columns) where an erased account's id stays: records kept by law or by design, each
 * holding the opaque id only. Everything else is deleted or anonymised.
 */
export const RETAINED: Readonly<Record<string, readonly string[]>> = {
  // The tombstone row itself, while any record below needs it.
  operators: ['id'],
  // Payments, wallets, withdrawals, identities and receipts on Base (financial records).
  base_agent_pay_consents: ['granted_by', 'revoked_by'],
  base_audit_events: ['operator_id'],
  base_chain_ops: ['operator_id'],
  base_fleet_jobs: ['operator_id'],
  base_identities: ['operator_id'],
  base_master_workspaces: ['operator_id', 'added_by'],
  base_owner_vaults: ['operator_id'],
  base_pay_lookups: ['account_id'],
  base_payments: ['operator_id', 'actor_id'],
  base_rate_lookups: ['account_id'],
  base_spend_permissions: ['owner_account_id'],
  base_wallet_payments: ['owner_account_id'],
  base_wallet_withdrawals: ['owner_account_id'],
  base_wallets: ['operator_id', 'owner_account_id'],
  base_x402_receipts: ['operator_id'],
  // Sales and paid calls (financial records).
  city_offer_batches: ['operator_id'],
  city_offers: ['operator_id'],
  feed_pay_agent_settings: ['changed_by'],
  feed_pay_calls: ['operator_id', 'owner_account_id', 'actor', 'caller_id'],
  feed_pay_quotes: ['account_id'],
  feed_pay_sponsor_credits: ['owner_account_id'],
  feed_pay_sponsored_calls: ['operator_id', 'owner_account_id'],
  // operator_id is the seller's: an outside buyer has no account here.
  feed_pay_public_calls: ['operator_id'],
  // The public count log is append-only; its agents are withdrawn by the next checkpoint.
  count_log_pending: ['operator_id'],
  // Proof of newsletter consent, 2 years at most (purged by its own retention).
  newsletter_consent_events: ['operator_id'],
  // The Google relink cooldown, 30 days (swept by its own expiry).
  google_link_cooldowns: ['operator_id'],
  // Which terms version the account accepted, and when (append-only).
  account_terms_acceptance_history: ['operator_id'],
};

export interface AccountErasureResult {
  account_sha256: string;
  erased_at: string;
  /** False on a dry run: the counts are what the erasure would do, and nothing was written. */
  applied: boolean;
  /** 'deleted', or 'tombstone' while retained records need the row. */
  account: 'deleted' | 'tombstone';
  agents: number;
  hosted_rooms: number;
  /** Rows deleted per table (cascades not included). */
  deleted: Record<string, number>;
  /** Rows anonymised per table. */
  anonymised: Record<string, number>;
  /** Rows kept per RETAINED table. */
  retained: Record<string, number>;
}

export class AccountErasureError extends Error {
  constructor(
    readonly code: 'not_found' | 'not_a_person' | 'already_erased',
    message: string,
  ) {
    super(message);
  }
}

export type ErasureCommand =
  | { command: 'erase'; account: string; confirm: boolean; ledger: string | null }
  | { command: 'reapply'; ledger: string; confirm: boolean };

export const ERASURE_USAGE = `Usage:
  pnpm account:erase -- erase --account <account id> [--ledger <file> --confirm]
  pnpm account:erase -- reapply --ledger <file> [--confirm]
Dry run unless --confirm. A confirmed erase needs --ledger: its intent line is written to disk
before the erasure commits, and its done line after.`;

/** The operator script's arguments (scripts/account-erase.ts). */
export function parseErasureArgs(argv: readonly string[]): ErasureCommand {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  const [command, ...rest] = args;
  const flags = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index]!;
    if (!flag.startsWith('--')) throw new Error(`Unexpected argument ${flag}.\n${ERASURE_USAGE}`);
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(flag, next);
      index++;
    } else flags.set(flag, true);
  }
  for (const flag of flags.keys())
    if (!['--account', '--ledger', '--confirm'].includes(flag))
      throw new Error(`Unknown flag ${flag}.\n${ERASURE_USAGE}`);
  const confirm = flags.get('--confirm') === true;
  const ledger = flags.get('--ledger');
  if (ledger === true) throw new Error(`--ledger needs a file.\n${ERASURE_USAGE}`);
  if (command === 'erase') {
    const account = flags.get('--account');
    if (typeof account !== 'string' || !/^[0-9a-f-]{36}$/.test(account))
      throw new Error(`erase needs --account <account id>.\n${ERASURE_USAGE}`);
    if (confirm && typeof ledger !== 'string')
      throw new Error(`A confirmed erase needs --ledger <file>.\n${ERASURE_USAGE}`);
    return { command, account, confirm, ledger: ledger ?? null };
  }
  if (command === 'reapply') {
    if (typeof ledger !== 'string') throw new Error(`reapply needs --ledger.\n${ERASURE_USAGE}`);
    return { command, ledger, confirm };
  }
  throw new Error(ERASURE_USAGE);
}

/**
 * A ledger line's state: `intent` is written (and flushed) before the erasure commits, `done`
 * after it, `aborted` when the erasure was refused and nothing committed. Every line of one run
 * carries that run's random operation id (`op`). Lines without a state (older ledgers) are done
 * lines and need no id.
 */
export type LedgerState = 'intent' | 'done' | 'aborted';
const LEDGER_STATES: readonly unknown[] = ['intent', 'done', 'aborted'];

/** One ledger line: what a restore needs to erase the account again, and nothing else. */
export const ledgerLine = (
  entry: Pick<AccountErasureResult, 'account_sha256' | 'erased_at'>,
  state: LedgerState,
  op: string,
) =>
  JSON.stringify({ account_sha256: entry.account_sha256, erased_at: entry.erased_at, state, op });

/**
 * The account hashes a ledger file erases again (blank lines skipped, each hash once): every
 * account with a done line, and every account with an intent line whose run (operation id) has
 * no aborted line. An aborted line cancels only its own run's intent, never a done line or
 * another run, whatever their times. An intent without a done line is kept: the erasure may
 * have committed.
 */
export function parseLedger(text: string): string[] {
  const lines = text
    .split('\n')
    .filter((line) => line.trim())
    .map((line, index) => {
      const parsed = JSON.parse(line) as {
        account_sha256?: unknown;
        state?: unknown;
        op?: unknown;
      };
      const hash = parsed.account_sha256;
      if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash))
        throw new Error(`Ledger line ${index + 1} has no account_sha256.`);
      if (parsed.state === undefined) return { hash, state: 'done', op: null };
      if (!LEDGER_STATES.includes(parsed.state))
        throw new Error(`Ledger line ${index + 1} has an unknown state.`);
      if (typeof parsed.op !== 'string' || !/^[0-9a-f-]{36}$/.test(parsed.op))
        throw new Error(`Ledger line ${index + 1} has no operation id.`);
      return { hash, state: parsed.state as LedgerState, op: parsed.op };
    });
  const run = (l: { hash: string; op: string | null }) => `${l.hash} ${l.op}`;
  const aborted = new Set(lines.filter((l) => l.state === 'aborted').map(run));
  return [
    ...new Set(
      lines
        .filter((l) => l.state === 'done' || (l.state === 'intent' && !aborted.has(run(l))))
        .map((l) => l.hash),
    ),
  ];
}

/** The ledger key of an account: the SHA-256 of its id (ids are random UUIDs). */
export const accountHash = (id: string) => createHash('sha256').update(id).digest('hex');

class DryRun extends Error {
  constructor(readonly result: AccountErasureResult) {
    super('dry run');
  }
}

/**
 * Erases one person account (kind 'owner') in one transaction. Without `confirm` it runs the same
 * statements and rolls them back, so the counts it answers are exactly what a confirmed run does.
 */
export async function eraseAccount(
  db: Pick<Database, 'transaction'>,
  accountId: string,
  options: { now: number; confirm: boolean },
): Promise<AccountErasureResult> {
  try {
    return await db.transaction(async (tx) => {
      const result = await eraseAccountIn(tx, accountId, options.now);
      if (!options.confirm) throw new DryRun(result);
      return result;
    });
  } catch (error) {
    if (error instanceof DryRun) return { ...error.result, applied: false };
    throw error;
  }
}

/**
 * After a restore from a backup taken before some erasures: erases again every account whose id
 * hashes to a ledger line. Accounts already erased or not in the database are skipped.
 */
export async function reapplyAccountErasures(
  db: Pick<Database, 'transaction' | 'query'>,
  hashes: readonly string[],
  options: { now: number; confirm: boolean },
): Promise<AccountErasureResult[]> {
  const wanted = new Set(hashes);
  const ids = (
    await db.query<{ id: string }>(
      "SELECT id FROM operators WHERE kind='owner' AND name_key NOT LIKE 'erased:%' ORDER BY id",
    )
  ).rows
    .map((row) => row.id)
    .filter((id) => wanted.has(accountHash(id)));
  const results: AccountErasureResult[] = [];
  for (const id of ids) results.push(await eraseAccount(db, id, options));
  return results;
}

async function eraseAccountIn(tx: Tx, id: string, now: number): Promise<AccountErasureResult> {
  const account = (
    await tx.query<{ kind: string; name_key: string }>(
      'SELECT kind, name_key FROM operators WHERE id=$1 FOR UPDATE',
      [id],
    )
  ).rows[0];
  if (!account) throw new AccountErasureError('not_found', 'No account with that id.');
  if (account.kind !== 'owner')
    throw new AccountErasureError(
      'not_a_person',
      'Only person accounts are erased this way (AI workspaces and unclaimed partitions are not).',
    );
  if (account.name_key.startsWith('erased:'))
    throw new AccountErasureError('already_erased', 'This account was erased already.');
  const tables = new Set(
    (
      await tx.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
      )
    ).rows.map((row) => row.table_name),
  );
  const deleted: Record<string, number> = {};
  const anonymised: Record<string, number> = {};
  const count = (into: Record<string, number>, table: string, n: number) => {
    if (n) into[table] = (into[table] ?? 0) + n;
  };
  /** Runs `sql` (one of the table's statements) when the table exists; answers the row count. */
  const run = async (table: string, sql: string, params: unknown[]) =>
    tables.has(table) ? (await tx.query(`${sql} RETURNING 1`, params)).rows.length : 0;
  const del = async (table: string, where: string, params: unknown[] = [id]) =>
    count(deleted, table, await run(table, `DELETE FROM ${table} WHERE ${where}`, params));
  const anon = async (table: string, set: string, where: string, params: unknown[]) =>
    count(anonymised, table, await run(table, `UPDATE ${table} SET ${set} WHERE ${where}`, params));

  // The workspace row first: every other write of this account waits behind it from here on.
  const workspace = (
    await tx.query<{ ids: string[] | null }>(
      `SELECT ARRAY(SELECT w.agent->>'id' FROM workspace_agents(operator_id, data) w)
         AS ids FROM workspaces WHERE operator_id=$1 FOR UPDATE`,
      [id],
    )
  ).rows[0];
  const agents = [
    ...new Set([
      ...(workspace?.ids ?? []),
      ...(tables.has('agents')
        ? (
            await tx.query<{ agent_id: string }>(
              'SELECT agent_id FROM agents WHERE operator_id=$1',
              [id],
            )
          ).rows.map((row) => row.agent_id)
        : []),
      ...(
        await tx.query<{ agent_id: string }>(
          'SELECT agent_id FROM credentials WHERE operator_id=$1',
          [id],
        )
      ).rows.map((row) => row.agent_id),
    ]),
  ].filter((agent): agent is string => typeof agent === 'string');
  // A fresh pseudonym per erasure: the author of what stays, never linkable to the account.
  const pseudonym = `erased:${randomUUID()}`;

  // 1. Rooms it hosts, with everything in them (private Elric chats go with its Elric records).
  const hosted = (
    await tx.query<{ id: string }>(
      'SELECT id FROM rooms WHERE host_owner_id=$1 AND elric_private IS NOT TRUE ORDER BY id',
      [id],
    )
  ).rows.map((row) => row.id);
  await eraseElricRoomRecords(tx, hosted);
  await purgeRooms(tx, hosted);
  count(deleted, 'rooms', hosted.length);
  const elric = await eraseElricOwnerIn(tx, id);
  count(deleted, 'rooms', elric.private_rooms);
  count(deleted, 'elric_turns', elric.turns);

  // 2. Its agents' traces outside its rooms: inboxes, cursors, presence, offers.
  if (agents.length) {
    const byAgent = [agents];
    // Mentions addressed to its agents go with their unread cursors (wake_cursors, below).
    for (const table of [
      'mentions',
      'replay_nonces',
      'inbox_cursors',
      'wake_cursors',
      'wake_outbox',
      'agent_directory',
      'agent_message_counts',
      'room_briefs',
      'cross_agent_settings',
    ])
      await del(table, 'agent_id = ANY($1)', byAgent);
    await del('message_receipts', 'sender_id = ANY($1)', byAgent);
    await anon('mentions', 'from_owner_label=$2, from_name=$2', 'from_agent_id = ANY($1)', [
      agents,
      ERASED_LABEL,
    ]);
    if (tables.has('city_offers'))
      count(deleted, 'city_offers', await removeAgentOffers(tx, id, agents, now));
  }

  // 3. Its private data.
  for (const [table, where] of [
    ['sessions', 'operator_id=$1'],
    ['assistant_grants', 'operator_id=$1'],
    ['workspace_keys', 'operator_id=$1'],
    ['credentials', 'operator_id=$1'],
    ['agent_presence', 'operator_id=$1'],
    ['agent_manifests', 'operator_id=$1'],
    ['runtime_enrollments', 'operator_id=$1'],
    ['wake_webhooks', 'owner_id=$1'],
    ['conversation_hidden', 'owner_id=$1'],
    ['conversation_reads', 'owner_id=$1'],
    ['conversation_summaries', 'owner_id=$1'],
    ['needs_you_dismissed', 'owner_id=$1'],
    ['cross_connections', 'from_owner_id=$1 OR to_owner_id=$1'],
    ['cross_invites', 'owner_id=$1'],
    ['operator_links', 'human_operator_id=$1'],
    // Repository bindings through its GitHub installations, in rooms hosted by others too.
    [
      'room_repo_bindings',
      'installation_id IN (SELECT installation_id FROM github_installations WHERE owner_id=$1)',
    ],
    ['github_installations', 'owner_id=$1'],
    ['join_links', 'owner_id=$1'],
    ['room_invitation_blocks', 'blocker_owner_id=$1 OR blocked_owner_id=$1'],
    ['room_invitations', 'invited_owner_id=$1 OR inviting_operator_id=$1'],
    ['room_invite_credentials', 'operator_id=$1 OR host_owner_id=$1'],
    ['room_join_receipts', 'owner_id=$1'],
    ['room_receipts', 'owner_id=$1'],
    [
      'reuse_events',
      'owner_id=$1 OR result_id IN (SELECT id FROM published_results WHERE owner_id=$1)',
    ],
    ['result_receipts', 'owner_id=$1'],
    ['result_asks', 'owner_id=$1'],
    ['published_results', 'owner_id=$1'],
    ['feed_request_invitations', 'poster_owner_id=$1 OR inviting_operator_id=$1'],
    ['feed_requests', 'owner_id=$1'],
    ['responder_replies', 'owner_id=$1'],
    ['responder_usage', 'owner_id=$1'],
    ['responder_settings', 'owner_id=$1'],
    ['responder_credentials', 'owner_id=$1'],
    ['elric_age_checks', 'operator_id=$1'],
    ['elric_verified_identities', 'operator_id=$1'],
    ['google_signin_flows', 'operator_id=$1'],
    ['oauth_pending', 'operator_id=$1'],
    ['email_outbox', 'operator_id=$1'],
    ['newsletter_consents', 'operator_id=$1'],
    ['account_terms_acceptances', 'operator_id=$1'],
    ['base_vault_challenges', 'operator_id=$1'],
  ] as const)
    await del(table, where);
  if (tables.has('claim_tokens'))
    await anon('claim_tokens', 'claimed_by=NULL', 'claimed_by=$1', [id]);

  // 4. Direct messages between its own agents, and their pairs' conversations: no one else
  // reads them, so they go before the rest is anonymised.
  await del('messages', 'sender_owner_id=$1 AND recipient_owner_id=$1');
  if (agents.length) await del('pair_contexts', 'low_id = ANY($1) AND high_id = ANY($1)', [agents]);

  // What it wrote where others read it: the author becomes the pseudonym, names a label.
  // Its memberships in rooms hosted by others end, as a removal does.
  await run(
    'room_members',
    'UPDATE room_members SET removed_at=$2, removed_by=$3 WHERE owner_id=$1 AND removed_at IS NULL',
    [id, now, ERASED_REMOVAL],
  );
  await anon(
    'room_members',
    `owner_id=$2, owner_label=$3, display_name=NULL, removal_reason=NULL, mute_reason=NULL,
     says_text=NULL`,
    'owner_id=$1',
    [id, pseudonym, ERASED_LABEL],
  );
  // Its pending approvals (asked by its members, or waiting for its answer) can never be answered
  // now: they end as withdrawn before the owner ids become the pseudonym.
  await anon(
    'room_cards',
    "status='withdrawn', updated_at=$2",
    "kind='approval' AND status='pending' AND (addressed_owner_id=$1 OR created_by_owner_id=$1)",
    [id, now],
  );
  for (const [table, column] of [
    ['room_members', 'joined_by'],
    ['room_members', 'removed_by'],
    ['room_comments', 'author_owner_id'],
    ['room_comments', 'resolved_by'],
    ['room_events', 'actor_owner_id'],
    ['room_file_versions', 'author_owner_id'],
    ['room_files', 'deleted_by'],
    ['room_pins', 'pinned_by_owner_id'],
    ['room_cards', 'created_by_owner_id'],
    ['room_artifacts', 'created_by_owner_id'],
    ['room_artifacts', 'deleted_by'],
    ['room_artifact_versions', 'uploaded_by_owner_id'],
    ['room_cards', 'addressed_owner_id'],
    ['room_cards', 'answered_by_owner_id'],
    ['room_proposal_revisions', 'author_owner_id'],
    ['room_proposals', 'author_owner_id'],
    ['room_reviews', 'author_owner_id'],
    ['room_task_comments', 'author_owner_id'],
    ['room_task_reviews', 'requested_by_owner_id'],
    ['room_task_reviews', 'reviewer_owner_id'],
    ['room_tasks', 'created_by_owner_id'],
    ['room_tasks', 'claim_owner_id'],
    ['room_tasks', 'submitted_by'],
    ['rooms', 'closed_by'],
    ['rooms', 'deleted_by'],
    ['room_links', 'created_by'],
    ['room_repo_bindings', 'bound_by'],
    ['room_repo_bindings', 'unbound_by'],
    ['messages', 'recipient_owner_id'],
    ['elric_agents', 'updated_by'],
    ['elric_agents', 'revoked_by'],
    ['elric_pending_actions', 'decided_by'],
    ['elric_flags', 'updated_by'],
    ['feed_flags', 'updated_by'],
    ['responder_credentials', 'created_by'],
    ['responder_credentials', 'revoked_by'],
    ['responder_settings', 'updated_by'],
    ['responder_replies', 'trigger_owner_id'],
    ['cross_connections', 'decided_by'],
    ['cross_connections', 'revoked_by'],
    ['published_results', 'revoked_by'],
  ] as const)
    await anon(table, `${column}=$2`, `${column}=$1`, [id, pseudonym]);
  await anon(
    'room_messages',
    'sender_owner_id=$2, sender_owner_label=$3, sender_name=$3',
    'sender_owner_id=$1',
    [id, pseudonym, ERASED_LABEL],
  );
  await anon('messages', 'sender_owner_id=$2, sender_owner_label=$3', 'sender_owner_id=$1', [
    id,
    pseudonym,
    ERASED_LABEL,
  ]);
  // Moving those messages to the pseudonym gave it conversation summaries (migration 302's
  // trigger); no one reads as the pseudonym, so they go too.
  await del('conversation_summaries', 'owner_id=$1', [pseudonym]);

  // 5. The workspace and its agents (the count triggers drop them from the public count).
  for (const table of ['agents', 'agent_rows_precopy', 'workspace_storage'])
    await del(table, 'operator_id=$1');

  // 6. The account row: a tombstone while a retained record holds a foreign key to it (deleting
  // the row would be refused, or would cascade into that record), else deleted with the rest
  // (the terms acceptance history goes with it, as its trigger allows only then).
  const bound = new Set(
    (
      await tx.query<{ table_name: string }>(
        `SELECT DISTINCT tc.table_name FROM information_schema.table_constraints tc
           JOIN information_schema.constraint_column_usage ccu
             ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
          WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = current_schema()
            AND ccu.table_name = 'operators'`,
      )
    ).rows.map((row) => row.table_name),
  );
  bound.delete('account_terms_acceptance_history');
  const retained: Record<string, number> = {};
  for (const [table, columns] of Object.entries(RETAINED)) {
    if (table === 'operators' || !tables.has(table)) continue;
    const n = Number(
      (
        await tx.query<{ n: string | number }>(
          `SELECT count(*) AS n FROM ${table} WHERE ${columns.map((c) => `${c}=$1`).join(' OR ')}`,
          [id],
        )
      ).rows[0]?.n ?? 0,
    );
    if (n) retained[table] = n;
  }
  const keep = Object.keys(retained).some((table) => bound.has(table));
  if (keep) {
    // An empty workspace keeps every invariant of an owner row; nothing can sign in to it.
    await tx.query('UPDATE workspaces SET data=$2 WHERE operator_id=$1', [
      id,
      JSON.stringify(emptyWorkspace()),
    ]);
    await tx.query(
      "UPDATE operators SET name='Deleted account', name_key=$2, password_hash='!', salt='!' WHERE id=$1",
      [id, `erased:${accountHash(id)}`],
    );
    retained.operators = 1;
  } else {
    await del('workspaces', 'operator_id=$1');
    await del('operators', 'id=$1');
  }
  // The workspace triggers keep this in step; a workspace stored as rows is covered here too.
  await del('counted_agent_ids', 'operator_id=$1');
  return {
    account_sha256: accountHash(id),
    erased_at: new Date(now).toISOString(),
    applied: true,
    account: keep ? 'tombstone' : 'deleted',
    agents: agents.length,
    hosted_rooms: hosted.length,
    deleted,
    anonymised,
    retained,
  };
}
