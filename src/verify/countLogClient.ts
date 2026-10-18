import {
  isWithheld,
  verifyChain,
  verifyCheckpointSignature,
  type ChainProblem,
  type PublicCheckpoint as Checkpoint,
} from '../../shared/count-log/index';

/*
 * The public count log as the browser reads it (/downtown/verify and /downtown/log): fetch,
 * checkpoints with their chain and signature checks, and the small formatters both pages share.
 */

export type Jwk = { kid: string; kty: string; crv: string; x: string };
/**
 * withheld: a v1 checkpoint whose signature is withheld for privacy. It is never shown as signed;
 * the pages show no signature status for it, only what is checkable (size, root, consistency and
 * inclusion).
 */
export type SignatureState =
  'valid' | 'invalid' | 'unsigned' | 'unsupported' | 'unknown-key' | 'withheld';
export type Loaded = {
  checkpoints: Checkpoint[];
  problems: ChainProblem[];
  signatures: Record<string, SignatureState>;
  live: number | null;
};

export const count = (cp: Pick<Checkpoint, 'tree_size' | 'withdrawn'>) =>
  cp.tree_size - cp.withdrawn;
export const number = new Intl.NumberFormat('en-US');
export const short = (hex: string) => `${hex.slice(0, 12)}…${hex.slice(-6)}`;
export const plural = (n: number, one: string, many: string) =>
  `${number.format(n)} ${n === 1 ? one : many}`;

export async function json<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${path} ${response.status}`);
  return (await response.json()) as T;
}

/** The server's page cap for /api/public/count-log/leaves (LEAVES_PAGE_MAX). */
export const LEAVES_PAGE = 10_000;

/**
 * Leaves `from` up to (not including) `to`, in order, fetched in pages the server answers in
 * full: one request past the cap would come back short and leave a gap the list never fills.
 */
export async function leavesBetween<L>(
  from: number,
  to: number,
  get: (path: string) => Promise<{ leaves: L[] }> = json,
): Promise<L[]> {
  const leaves: L[] = [];
  for (let at = from; at < to;) {
    const end = Math.min(to, at + LEAVES_PAGE);
    const page = await get(`/api/public/count-log/leaves?from=${at}&to=${end}`);
    if (!page.leaves.length) break;
    leaves.push(...page.leaves);
    at += page.leaves.length;
  }
  return leaves;
}

async function ed25519Available(): Promise<boolean> {
  try {
    await crypto.subtle.importKey(
      'jwk',
      { kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' },
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return true;
  } catch {
    return false;
  }
}

export async function load(): Promise<Loaded> {
  const [{ checkpoints }, jwks, stats] = await Promise.all([
    json<{ checkpoints: Checkpoint[] }>('/api/public/count-log/checkpoints'),
    json<{ keys: Jwk[] }>('/.well-known/jwks.json').catch(() => ({ keys: [] as Jwk[] })),
    json<{ ai_agents_total: number }>('/api/public/stats').catch(() => null),
  ]);
  const problems = await verifyChain(checkpoints);
  const signatures: Record<string, SignatureState> = {};
  const canVerify = await ed25519Available();
  for (const cp of checkpoints) {
    if (isWithheld(cp)) signatures[cp.date] = 'withheld';
    else if (!cp.signature) signatures[cp.date] = 'unsigned';
    else if (!canVerify) signatures[cp.date] = 'unsupported';
    else {
      const key = jwks.keys.find((k) => k.kid === cp.signature!.kid);
      signatures[cp.date] = !key
        ? 'unknown-key'
        : (await verifyCheckpointSignature(cp.hash, cp.signature.sig, key))
          ? 'valid'
          : 'invalid';
    }
  }
  return { checkpoints, problems, signatures, live: stats?.ai_agents_total ?? null };
}

/** The words for a checkpoint's signature; withheld v1 signatures have none (null). */
export const SIGNATURE_WORDS: Record<SignatureState, string | null> = {
  valid: 'signed ✓',
  invalid: 'signature does not verify',
  unsigned: 'unsigned',
  unsupported: 'signature not checked (this browser has no Ed25519)',
  'unknown-key': 'signing key not published',
  withheld: null,
};

/**
 * The signatures as a whole: every checkpoint signed (all), signed from the first v2 checkpoint on
 * after earlier withheld v1 ones (partial), only withheld v1 checkpoints so far
 * (latest-withheld), or not confirmed. A withheld v1 signature is never counted as signed.
 */
export function signatureSummary(data: Pick<Loaded, 'checkpoints' | 'signatures'>): {
  state: 'all' | 'partial' | 'latest-withheld' | 'not-confirmed' | 'none';
  withheld: number;
  firstSigned: string | null;
} {
  const states = data.checkpoints.map((cp) => data.signatures[cp.date]);
  const withheld = states.filter((s) => s === 'withheld').length;
  const firstSigned = data.checkpoints.find((cp) => data.signatures[cp.date] === 'valid')?.date;
  const latest = states.at(-1);
  const state = !states.length
    ? 'none'
    : states.some((s) => s !== 'valid' && s !== 'withheld')
      ? 'not-confirmed'
      : latest === 'withheld'
        ? 'latest-withheld'
        : withheld
          ? 'partial'
          : 'all';
  return { state, withheld, firstSigned: firstSigned ?? null };
}

/**
 * Whether a check against a checkpoint is confirmed: its chain checks and its signature verifies,
 * or, for a withheld v1 checkpoint, its chain (size, root, consistency) checks. A withheld v1
 * checkpoint is confirmed without ever being called signed.
 */
export function checkpointConfirmed(chainOk: boolean, signature: SignatureState | undefined) {
  return chainOk && (signature === 'valid' || signature === 'withheld');
}

/** Why a check against a checkpoint is not confirmed: its chain check, then its signature. */
export function unconfirmedReason(chainOk: boolean): string {
  if (!chainOk) return 'that checkpoint failed its chain check (see History)';
  return 'that checkpoint failed its signature check (see History)';
}
