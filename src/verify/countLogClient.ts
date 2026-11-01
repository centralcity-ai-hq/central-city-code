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

/** A 429: the server asks to wait `waitMs` (its Retry-After, bounded) before asking again. */
export class RetryLater extends Error {
  constructor(
    path: string,
    readonly waitMs: number,
  ) {
    super(`${path} 429`);
  }
}
/** The longest Retry-After a client waits for at once (the server's windows are a minute). */
export const RETRY_WAIT_MAX_MS = 60_000;

export async function json<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (response.status === 429) {
    const seconds = Number(response.headers.get('retry-after'));
    const wait = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 5_000;
    throw new RetryLater(path, Math.min(wait, RETRY_WAIT_MAX_MS));
  }
  if (!response.ok) throw new Error(`${path} ${response.status}`);
  return (await response.json()) as T;
}

/** The server's page size for /api/public/count-log/leaves (LEAVES_PAGE_MAX). */
export const LEAVES_PAGE = 10_000;
/** The route's small block (LEAVES_BLOCKS), for the few rows the live list shows at a time. */
export const LEAVES_BLOCK = 100;

/** How many times one block is asked again after a 429 before the read gives up. */
export const LEAVES_RETRIES = 10;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Leaves `from` up to (not including) `to`, in order. The route serves aligned blocks only (each
 * block one edge-cached URL), so this asks for the blocks that cover the range and keeps the part
 * inside it: small blocks for a short range, full pages for a long one. A whole-log read of a large
 * log can reach the route's per-address limit on edge misses: it then waits for Retry-After and
 * goes on with the same block, so the read is slower, never wrong.
 */
export async function leavesBetween<L extends { idx: number }>(
  from: number,
  to: number,
  get: (path: string) => Promise<{ leaves: L[] }> = json,
  onProgress?: (n: number) => void,
  sleep: (ms: number) => Promise<void> = pause,
): Promise<L[]> {
  const block = to - from <= 10 * LEAVES_BLOCK ? LEAVES_BLOCK : LEAVES_PAGE;
  const leaves: L[] = [];
  const read = async (path: string) => {
    for (let retry = 0; ; retry++) {
      try {
        return await get(path);
      } catch (error) {
        if (!(error instanceof RetryLater) || retry >= LEAVES_RETRIES) throw error;
        await sleep(error.waitMs);
      }
    }
  };
  for (let at = from - (from % block); at < to; at += block) {
    const page = await read(`/api/public/count-log/leaves?from=${at}&to=${at + block}`);
    for (const leaf of page.leaves) if (leaf.idx >= from && leaf.idx < to) leaves.push(leaf);
    onProgress?.(leaves.length);
    // A short block is the end of the signed log: nothing after it yet.
    if (page.leaves.length < block) break;
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
