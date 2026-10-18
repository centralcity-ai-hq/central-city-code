/*
 * The payment screening gate (docs/protocol/SCREENING-GATE.md): ONE server-side decision for every
 * new payment submission. Live by default; CITY_PROTOCOL_SCREENING=0 is its emergency off (read
 * per call; docs/protocol/LIVE.md). Switched off, nothing calls it.
 *
 *   screen({chainId, token, amountRaw, intentId, parties}) -> {allowed, decisionId, reason, ...}
 *
 * - Fail closed: no provider, an unknown chain, a timeout, an outage, a malformed or stale answer
 *   and an invalid request are all `allowed: false`. A timeout is not clearance.
 * - Decisions (allowed or blocked) are durable (migration 115) and bound to the chain, the token,
 *   the exact amount, the intent id, every party (role + lowercase address), the policy version and
 *   the provider reference. Only an unexpired decision with exactly that binding is reused: another
 *   amount, destination, chain, intent or policy is a new screening.
 * - The static denylist (CITY_PROTOCOL_SCREENING_DENY) is a supplement: a listed party is blocked
 *   whatever the provider says (or whether it answers at all).
 * - Callers never pass a clearance: the request carries no decision, only what is being paid.
 * - Nothing here logs; callers log decision ids and reasons only, never addresses or secrets.
 */
import { createHash, randomBytes } from 'node:crypto';
import { liveUnlessOff } from '../../../shared/protocol.js';
import type { Transaction } from '../../database.js';

export const SCREENING_FLAG = 'CITY_PROTOCOL_SCREENING';
/** The sanctions oracle on a test network; on Base mainnet the address is fixed in code. */
export const SCREENING_ORACLE_FLAG = 'CITY_PROTOCOL_SCREENING_ORACLE';
/** Comma-separated addresses that are always blocked (a supplement, never a substitute). */
export const SCREENING_DENY_FLAG = 'CITY_PROTOCOL_SCREENING_DENY';

/** Bumped when the decision rules change: every earlier decision then stops being reused. */
export const SCREENING_POLICY = 'n3.1';
/** How long a decision may be reused for the same binding. */
export const SCREENING_DECISION_TTL_MS = 10 * 60_000;
/** A provider that does not answer within this is unavailable (never clear). */
export const SCREENING_TIMEOUT_MS = 5_000;
/** A provider answer observed longer ago than this is stale. */
export const SCREENING_MAX_AGE_MS = 5 * 60_000;
/** A provider answer observed this far in the future is malformed. */
const FUTURE_SKEW_MS = 60_000;

type Env = Record<string, string | undefined>;

/** Screening is live unless CITY_PROTOCOL_SCREENING is exactly '0' (read per call). */
export const screeningEnabled = (env: Env) => liveUnlessOff(env, SCREENING_FLAG);

export const SCREENING_ROLES = ['payer', 'spender', 'payee', 'fee_recipient'] as const;
export type ScreeningRole = (typeof SCREENING_ROLES)[number];

export interface ScreeningParty {
  role: ScreeningRole;
  address: string;
}

export interface ScreeningRequest {
  chainId: number;
  token: string;
  amountRaw: string | bigint;
  /** What is being paid, e.g. feed-pay:<callId>. One intent, one binding. */
  intentId: string;
  parties: ScreeningParty[];
}

/** Why: allowed only with 'clear'; blocked with 'sanctioned' or 'denylisted'; the rest unavailable. */
export type ScreeningReason =
  | 'clear'
  | 'sanctioned'
  | 'denylisted'
  | 'not_configured'
  | 'unknown_chain'
  | 'provider_unavailable'
  | 'timeout'
  | 'malformed'
  | 'stale'
  | 'invalid_request';

export interface ScreeningDecision {
  allowed: boolean;
  /** 'unavailable': no decision could be made (nothing stored); never treated as clearance. */
  outcome: 'allowed' | 'blocked' | 'unavailable';
  /** The stored decision; null when nothing could be decided. */
  decisionId: string | null;
  reason: ScreeningReason;
  /** Until when the decision may be reused (ms); for unavailable, the time of the attempt. */
  expiresAt: number;
  /** True when an earlier unexpired decision with the identical binding answered. */
  reused: boolean;
}

/** What a provider answers: per lowercase address, true when listed. */
export interface ScreeningProviderAnswer {
  listed: Record<string, unknown>;
  /** When the provider's data was observed (ms); older than SCREENING_MAX_AGE_MS is stale. */
  observedAt: number;
}

/** A screening source (the sanctions oracle; a fake in tests). Throws on any failure. */
export interface ScreeningProvider {
  /** A stable reference for the evidence: kind, chain and contract, never a credential. */
  readonly ref: string;
  supports(chainId: number): boolean;
  check(input: {
    chainId: number;
    addresses: string[];
    signal: AbortSignal;
  }): Promise<ScreeningProviderAnswer>;
}

export interface ScreeningGateDeps {
  db: Pick<Transaction, 'query'>;
  env: Env;
  /** Resolved per screening (the configuration is read per call); null = not configured. */
  provider: () => ScreeningProvider | null;
  now?: () => number;
  timeoutMs?: number;
  ttlMs?: number;
  maxAgeMs?: number;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = /^0x0{40}$/i;
const RAW = /^(0|[1-9][0-9]{0,77})$/;
const INTENT = /^[A-Za-z0-9_.:-]{1,200}$/;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** The denylist from the environment: valid addresses only, lowercased, sorted, unique. */
export function screeningDenylist(env: Env): string[] {
  const items = (env[SCREENING_DENY_FLAG] ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => ADDRESS.test(item));
  return [...new Set(items)].sort();
}

/** The policy version: the rules, the provider and the denylist (a change invalidates reuse). */
export function screeningPolicyVersion(env: Env, providerRef: string | null): string {
  const digest = sha256(`${providerRef ?? 'none'}|${screeningDenylist(env).join(',')}`);
  return `${SCREENING_POLICY}:${digest.slice(0, 16)}`;
}

interface Binding {
  chainId: number;
  token: string;
  amountRaw: string;
  intentId: string;
  parties: ScreeningParty[];
}

/** Validates and normalizes a request; null when anything is off (fail closed). */
function bindingOf(request: ScreeningRequest): Binding | null {
  if (!request || typeof request !== 'object') return null;
  const { chainId, token, intentId, parties } = request;
  const amountRaw =
    typeof request.amountRaw === 'bigint' ? request.amountRaw.toString(10) : request.amountRaw;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return null;
  if (typeof token !== 'string' || !ADDRESS.test(token) || ZERO.test(token)) return null;
  if (typeof amountRaw !== 'string' || !RAW.test(amountRaw)) return null;
  if (typeof intentId !== 'string' || !INTENT.test(intentId)) return null;
  if (!Array.isArray(parties) || parties.length === 0 || parties.length > 8) return null;
  const normalized: ScreeningParty[] = [];
  for (const party of parties) {
    if (!party || !(SCREENING_ROLES as readonly string[]).includes(party.role)) return null;
    if (typeof party.address !== 'string' || !ADDRESS.test(party.address)) return null;
    if (ZERO.test(party.address)) return null;
    normalized.push({ role: party.role, address: party.address.toLowerCase() });
  }
  const unique = new Map(normalized.map((p) => [`${p.role}:${p.address}`, p]));
  const sorted = [...unique.values()].sort((a, b) =>
    a.role === b.role ? a.address.localeCompare(b.address) : a.role.localeCompare(b.role),
  );
  return { chainId, token: token.toLowerCase(), amountRaw, intentId, parties: sorted };
}

const canonical = (binding: Binding, policy: string, providerRef: string) =>
  JSON.stringify({
    chainId: binding.chainId,
    token: binding.token,
    amountRaw: binding.amountRaw,
    intentId: binding.intentId,
    parties: binding.parties.map((p) => [p.role, p.address]),
    policy,
    providerRef,
  });

interface StoredDecision {
  decision_id: string;
  chain_id: number;
  token: string;
  amount_raw: string;
  intent_id: string;
  parties: Array<{ role: string; address: string }> | string;
  policy_version: string;
  provider_ref: string;
  outcome: 'allowed' | 'blocked';
  reason: 'clear' | 'sanctioned' | 'denylisted';
  expires_at: string | number;
}

export function createScreeningGate(deps: ScreeningGateDeps) {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? SCREENING_TIMEOUT_MS;
  const ttlMs = deps.ttlMs ?? SCREENING_DECISION_TTL_MS;
  const maxAgeMs = deps.maxAgeMs ?? SCREENING_MAX_AGE_MS;

  const unavailable = (reason: ScreeningReason): ScreeningDecision => ({
    allowed: false,
    outcome: 'unavailable',
    decisionId: null,
    reason,
    expiresAt: now(),
    reused: false,
  });

  /** An unexpired decision with exactly this binding (every bound field compared again). */
  async function reusable(
    hash: string,
    binding: Binding,
    policy: string,
    providerRef: string,
  ): Promise<ScreeningDecision | null> {
    const { rows } = await deps.db.query<StoredDecision>(
      `SELECT decision_id, chain_id, token, amount_raw::text AS amount_raw, intent_id, parties,
         policy_version, provider_ref, outcome, reason, expires_at
       FROM protocol_screening_decisions
       WHERE binding_hash = $1 AND expires_at > $2
       ORDER BY decided_at DESC LIMIT 1`,
      [hash, now()],
    );
    const row = rows[0];
    if (!row) return null;
    const parties = typeof row.parties === 'string' ? JSON.parse(row.parties) : row.parties;
    const same =
      Number(row.chain_id) === binding.chainId &&
      row.token === binding.token &&
      row.amount_raw === binding.amountRaw &&
      row.intent_id === binding.intentId &&
      row.policy_version === policy &&
      row.provider_ref === providerRef &&
      JSON.stringify(parties) === JSON.stringify(binding.parties);
    if (!same) return null;
    return {
      allowed: row.outcome === 'allowed',
      outcome: row.outcome,
      decisionId: row.decision_id,
      reason: row.reason,
      expiresAt: Number(row.expires_at),
      reused: true,
    };
  }

  async function store(
    hash: string,
    binding: Binding,
    policy: string,
    providerRef: string,
    outcome: 'allowed' | 'blocked',
    reason: 'clear' | 'sanctioned' | 'denylisted',
  ): Promise<ScreeningDecision> {
    const decisionId = `sd_${randomBytes(16).toString('hex')}`;
    const at = now();
    const expiresAt = at + ttlMs;
    await deps.db.query(
      `INSERT INTO protocol_screening_decisions (decision_id, binding_hash, chain_id, token,
         amount_raw, intent_id, parties, policy_version, provider_ref, outcome, reason,
         decided_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13)`,
      [
        decisionId,
        hash,
        binding.chainId,
        binding.token,
        binding.amountRaw,
        binding.intentId,
        JSON.stringify(binding.parties),
        policy,
        providerRef,
        outcome,
        reason,
        at,
        expiresAt,
      ],
    );
    return {
      allowed: outcome === 'allowed',
      outcome,
      decisionId,
      reason,
      expiresAt,
      reused: false,
    };
  }

  async function ask(
    provider: ScreeningProvider,
    chainId: number,
    addresses: string[],
  ): Promise<{ listed: boolean } | { failed: ScreeningReason }> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve('timeout');
      }, timeoutMs);
    });
    let answer: ScreeningProviderAnswer | 'timeout';
    try {
      answer = await Promise.race([
        provider.check({ chainId, addresses, signal: controller.signal }),
        timeout,
      ]);
    } catch {
      return { failed: 'provider_unavailable' };
    } finally {
      clearTimeout(timer);
    }
    if (answer === 'timeout') return { failed: 'timeout' };
    if (
      !answer ||
      typeof answer !== 'object' ||
      !answer.listed ||
      typeof answer.listed !== 'object'
    )
      return { failed: 'malformed' };
    const observedAt = answer.observedAt;
    if (typeof observedAt !== 'number' || !Number.isFinite(observedAt))
      return { failed: 'malformed' };
    if (observedAt > now() + FUTURE_SKEW_MS) return { failed: 'malformed' };
    if (now() - observedAt > maxAgeMs) return { failed: 'stale' };
    let listed = false;
    for (const address of addresses) {
      const value = answer.listed[address];
      if (typeof value !== 'boolean') return { failed: 'malformed' };
      if (value) listed = true;
    }
    return { listed };
  }

  /** The one decision interface. Never throws for a provider failure: it answers not allowed. */
  async function screen(request: ScreeningRequest): Promise<ScreeningDecision> {
    const binding = bindingOf(request);
    if (!binding) return unavailable('invalid_request');
    let provider: ScreeningProvider | null;
    try {
      provider = deps.provider();
    } catch {
      provider = null;
    }
    const providerRef = provider?.ref ?? 'none';
    const policy = screeningPolicyVersion(deps.env, provider?.ref ?? null);
    const hash = sha256(canonical(binding, policy, providerRef));
    const reused = await reusable(hash, binding, policy, providerRef);
    if (reused) return reused;
    const addresses = [...new Set(binding.parties.map((p) => p.address))].sort();
    const deny = new Set(screeningDenylist(deps.env));
    if (addresses.some((address) => deny.has(address)))
      return store(hash, binding, policy, providerRef, 'blocked', 'denylisted');
    if (!provider) return unavailable('not_configured');
    if (!provider.supports(binding.chainId)) return unavailable('unknown_chain');
    const answer = await ask(provider, binding.chainId, addresses);
    if ('failed' in answer) return unavailable(answer.failed);
    return answer.listed
      ? store(hash, binding, policy, providerRef, 'blocked', 'sanctioned')
      : store(hash, binding, policy, providerRef, 'allowed', 'clear');
  }

  return { screen };
}

export type ScreeningGate = ReturnType<typeof createScreeningGate>;
