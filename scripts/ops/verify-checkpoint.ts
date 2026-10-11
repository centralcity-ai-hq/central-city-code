// Read-only check of a published count-log checkpoint: npx tsx scripts/ops/verify-checkpoint.ts YYYY-MM-DD [expected-prev-hash] [minimum-tree-size]
// Fetches only public endpoints (checkpoints, JWKS); verifies the chain, consistency proofs and the signature.
import { verifyChain, verifyCheckpointSignature } from '../../shared/count-log/index.js';
const date = process.argv[2];
const expectedPrev = process.argv[3];
const minimumSize = process.argv[4] === undefined ? undefined : Number(process.argv[4]);
if (expectedPrev !== undefined && !/^[0-9a-f]{64}$/.test(expectedPrev))
  throw new Error('Invalid expected previous hash');
if (minimumSize !== undefined && (!Number.isSafeInteger(minimumSize) || minimumSize < 0))
  throw new Error('Invalid minimum size');
if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) throw new Error('Supply checkpoint date');
async function json(path: string) {
  const response = await fetch(`https://centralcity.ai${path}`, {
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}
const [history, keys] = await Promise.all([
  json(`/api/public/count-log/checkpoints?after=${date}`),
  json('/.well-known/jwks.json'),
]);
const checkpoints = [...history.checkpoints].sort((a, b) => a.date.localeCompare(b.date));
if (new Set(checkpoints.map((c) => c.date)).size !== checkpoints.length)
  throw new Error('Duplicate checkpoint dates');
const cp = checkpoints.find((c) => c.date === date);
if (!cp) throw new Error(`Checkpoint ${date} not published`);
if (expectedPrev !== undefined && cp.prev_hash !== expectedPrev)
  throw new Error('Unexpected previous hash');
if (
  !Number.isSafeInteger(cp.tree_size) ||
  !Number.isSafeInteger(cp.withdrawn) ||
  cp.withdrawn < 0 ||
  cp.withdrawn > cp.tree_size
)
  throw new Error('Invalid checkpoint counts');
if (minimumSize !== undefined && cp.tree_size < minimumSize)
  throw new Error('Tree size regressed below expected minimum');
const problems = await verifyChain(checkpoints);
if (problems.length) throw new Error(JSON.stringify(problems));
const key = keys.keys.find((k: any) => k.kid === cp.signature?.kid);
if (!key || !cp.signature || !(await verifyCheckpointSignature(cp.hash, cp.signature.sig, key)))
  throw new Error('Signature missing or invalid against published key');
console.log(
  JSON.stringify(
    {
      date,
      tree_size: cp.tree_size,
      hash: cp.hash,
      prev_hash: cp.prev_hash,
      withdrawn: cp.withdrawn,
      netCount: cp.tree_size - cp.withdrawn,
      chainVerified: true,
      signatureVerified: true,
      checkedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
