import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { createCountLog } from '../server/count-log/service.js';
import {
  SIGNATURE_WORDS,
  checkpointConfirmed,
  load,
  signatureSummary,
  unconfirmedReason,
} from '../src/verify/countLogClient.js';
import {
  checkpointHash,
  checkpointSigningInput,
  consistencyProof,
  hashLeaf,
  hashCheckable,
  merkleRoot,
  subcountsCommitment,
  toHex,
  toPublicCheckpoint,
  verifyChain,
  verifyCheckpointSignature,
  verifyInclusion,
  inclusionProof,
  isWithheld,
  V1_LAST_DATE,
  V2_GENESIS_PREV_HASH,
  type Checkpoint,
  type PublicCheckpointV2,
  type CheckpointBody,
  type PublicCheckpoint,
  type Subcounts,
} from '../shared/count-log/index.js';

/*
 * Checkpoint format v2: the per-category split is never published. v2 signs a salted commitment
 * to it. Past v1 checkpoints are served without their split, hash, signature and link (not
 * checkable), and v2 starts a new chain. All numbers here are synthetic.
 */

const SPLIT_PATTERN =
  /"subcounts"\s*:|in_person_accounts|in_ai_workspaces|"unclaimed"\s*:|"revoked"\s*:/;

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string };
  return { privateKey, jwk };
}
const signWith = (privateKey: ReturnType<typeof keyPair>['privateKey'], hash: string) => ({
  kid: 'synthetic',
  sig: sign(null, checkpointSigningInput(hash), privateKey).toString('base64url'),
});

const synthetic = (n: number): Subcounts => ({
  in_person_accounts: n - 1,
  in_ai_workspaces: 1,
  unclaimed: 0,
  revoked: 0,
});

/**
 * Day 1 and 2 in v1, day 3 and 4 in v2, over one growing tree. The first v2 checkpoint starts a
 * new chain (prev_hash null); day 4 links to day 3.
 */
async function mixedChain() {
  const { privateKey, jwk } = keyPair();
  const leaves = await Promise.all(Array.from({ length: 8 }, (_, i) => hashLeaf(Uint8Array.of(i))));
  const sizes = [2, 4, 6, 8];
  const out: Checkpoint[] = [];
  for (const [i, size] of sizes.entries()) {
    const common = {
      date: `2026-10-0${i + 1}`,
      tree_size: size,
      withdrawn: 0,
      root: toHex(await merkleRoot(leaves.slice(0, size))),
      prev_hash: i === 2 ? null : (out.at(-1)?.hash ?? null),
    };
    const body: CheckpointBody =
      i < 2
        ? { v: 1, ...common, subcounts: synthetic(size) }
        : {
            v: 2,
            ...common,
            subcounts_commitment: await subcountsCommitment(
              synthetic(size),
              new Uint8Array(32).fill(i),
            ),
          };
    const hash = await checkpointHash(body);
    const previous = out.at(-1);
    out.push({
      ...body,
      hash,
      signature: signWith(privateKey, hash),
      consistency: previous
        ? (await consistencyProof(leaves.slice(0, size), previous.tree_size)).map(toHex)
        : [],
    } as Checkpoint);
  }
  return { chain: out, jwk, leaves };
}

test('v2: the signed body carries a salted commitment, never the split', async () => {
  const { chain, jwk } = await mixedChain();
  const v2 = chain[2]!;
  assert.equal(v2.v, 2);
  assert.ok(!('subcounts' in v2));
  assert.match(v2.v === 2 ? v2.subcounts_commitment : '', /^[0-9a-f]{64}$/);
  assert.equal(await verifyCheckpointSignature(v2.hash, v2.signature!.sig, jwk), true);
  assert.deepEqual(await verifyChain(chain), []);
  // The commitment binds the split and the salt; a different salt or split changes it.
  const salt = new Uint8Array(32).fill(7);
  const c = await subcountsCommitment(synthetic(5), salt);
  assert.equal(c, await subcountsCommitment(synthetic(5), salt));
  assert.notEqual(c, await subcountsCommitment(synthetic(6), salt));
  assert.notEqual(c, await subcountsCommitment(synthetic(5), new Uint8Array(32).fill(8)));
  await assert.rejects(subcountsCommitment(synthetic(5), new Uint8Array(16)), /32 bytes/);
  // An edited commitment breaks the hash.
  const edited = { ...v2, subcounts_commitment: 'ab'.repeat(32), prev_hash: null, consistency: [] };
  assert.ok((await verifyChain([edited])).some((p) => p.problem.includes('hash')));
});

test('the chain stays valid across the v1 → v2 transition, in full and withheld form', async () => {
  const { chain, jwk } = await mixedChain();
  assert.deepEqual(await verifyChain(chain), [], 'full v1 then v2');
  const published = chain.map(toPublicCheckpoint);
  for (const cp of published) assert.doesNotMatch(JSON.stringify(cp), SPLIT_PATTERN);
  assert.equal(isWithheld(published[0]!), true);
  assert.equal(hashCheckable(published[0]!), false);
  assert.equal(hashCheckable(published[2]!), true);
  assert.deepEqual(await verifyChain(published), [], 'withheld v1 then v2');
  // v2 starts a new chain: the first v2 checkpoint links to no v1 hash; the next links to it.
  const [, , firstV2, secondV2] = published as [
    unknown,
    unknown,
    PublicCheckpointV2,
    PublicCheckpointV2,
  ];
  assert.equal(firstV2.prev_hash, V2_GENESIS_PREV_HASH);
  assert.equal(firstV2.prev_hash, null);
  assert.equal(secondV2.prev_hash, firstV2.hash);
  // v2 signatures verify over their body.
  for (const cp of [firstV2, secondV2])
    assert.equal(await verifyCheckpointSignature(cp.hash, cp.signature!.sig, jwk), true);
  // Tampering still shows on a withheld entry: a changed size breaks the consistency proof, and a
  // version may not go back.
  const shrunk = published.map((cp, i) => (i === 1 ? { ...cp, tree_size: 3 } : cp));
  assert.ok((await verifyChain(shrunk)).some((p) => p.problem.includes('append-only')));
  const rerooted = published.map((cp, i) => (i === 0 ? { ...cp, root: 'ee'.repeat(32) } : cp));
  assert.ok((await verifyChain(rerooted)).some((p) => p.problem.includes('append-only')));
  const back = [...published.slice(0, 3), { ...published[1]!, date: '2026-10-04' }];
  assert.ok((await verifyChain(back)).some((p) => p.problem.includes('version')));
  const unknown = [{ ...published[0]!, v: 3 } as unknown as PublicCheckpoint];
  assert.ok((await verifyChain(unknown)).some((p) => p.problem.includes('version')));
});

test('v2 genesis: exactly the first v2 checkpoint has no previous hash', async () => {
  const { chain } = await mixedChain();
  const published = chain.map(toPublicCheckpoint);
  // The first v2 checkpoint may not link to the last v1 hash (the old v1 → v2 link).
  const v1Hash = chain[1]!.hash;
  const linked = { ...(published[2] as PublicCheckpointV2), prev_hash: v1Hash };
  const relinked = [published[0]!, published[1]!, linked];
  assert.ok(
    (await verifyChain(relinked)).some((p) => p.problem.includes('first v2 checkpoint')),
    'a v2 checkpoint after v1 must start a new chain',
  );
  // A later v2 checkpoint may not restart the chain.
  const restarted = published.map((cp, i) => (i === 3 ? { ...cp, prev_hash: null } : cp));
  assert.ok(
    (await verifyChain(restarted)).some((p) => p.problem.includes('previous checkpoint')),
    'a second genesis is rejected',
  );
  // A log that starts at v2 starts with prev_hash null as well.
  assert.deepEqual(await verifyChain(published.slice(2)), []);
  // Full (private) v1 then v2 follows the same rule.
  const fullLinked = [chain[0]!, chain[1]!, { ...chain[2]!, prev_hash: v1Hash }];
  assert.ok((await verifyChain(fullLinked)).some((p) => p.problem.includes('first v2 checkpoint')));
});

test('withheld v1: no hash, signature or link is published, so nothing is left to test a guess against', async () => {
  const { chain } = await mixedChain();
  for (const [i, full] of chain.slice(0, 2).entries()) {
    const cp = toPublicCheckpoint(full);
    assert.deepEqual(Object.keys(cp), [
      'v',
      'date',
      'tree_size',
      'withdrawn',
      'root',
      'subcounts_withheld',
      'signature_withheld',
      'consistency',
    ]);
    assert.ok(!('hash' in cp) && !('signature' in cp) && !('prev_hash' in cp), `day ${i + 1}`);
    const text = JSON.stringify(cp);
    // The only digests left are tree nodes (root, consistency proof), which do not depend on the
    // private fields.
    for (const hex of text.match(/[0-9a-f]{64}/g) ?? [])
      assert.ok(hex === cp.root || cp.consistency.includes(hex), hex);
    // Every possible split for this size (a full search) hashes to something not published here,
    // and no signature is published to check a candidate against.
    const counted = full.tree_size - full.withdrawn;
    let tried = 0;
    for (let ai = 0; ai <= counted; ai++)
      for (let unclaimed = 0; ai + unclaimed <= counted; unclaimed++)
        for (let revoked = 0; revoked <= 2; revoked++) {
          const guess = await checkpointHash({
            v: 1,
            date: full.date,
            tree_size: full.tree_size,
            withdrawn: full.withdrawn,
            root: full.root,
            prev_hash: full.prev_hash,
            subcounts: {
              in_person_accounts: counted - ai - unclaimed,
              in_ai_workspaces: ai,
              unclaimed,
              revoked,
            },
          });
          tried++;
          assert.ok(!text.includes(guess));
        }
    assert.ok(tried > 0);
    // The real hash is in the private copy only.
    assert.ok(!text.includes(full.hash));
    assert.ok(!text.includes(full.signature!.sig));
  }
});

test(`a v1 checkpoint dated after ${V1_LAST_DATE} is rejected; only v2 is valid from then on`, async () => {
  const { chain } = await mixedChain();
  const published = chain.map(toPublicCheckpoint);
  const onCutoff = { ...published[1]!, date: V1_LAST_DATE };
  assert.deepEqual(await verifyChain([published[0]!, onCutoff]), [], 'the last v1 day is valid');
  // A withheld v1 day after the cutoff, appended after the last v1 day.
  const late = { ...published[1]!, date: '2026-10-05' };
  const problems = await verifyChain([published[0]!, late]);
  assert.ok(
    problems.some((p) => p.date === '2026-10-05' && p.problem.includes('v1 checkpoint after')),
  );
  // The same for a full v1 body (an older private copy): the date alone decides.
  const fullLate = { ...chain[0]!, date: '2026-12-31' };
  const { hash: _h, signature: _s, consistency: _c, ...body } = fullLate;
  const resealed = { ...fullLate, hash: await checkpointHash(body) };
  assert.ok((await verifyChain([resealed])).some((p) => p.problem.includes('v1 checkpoint after')));
  // v2 after the cutoff is fine.
  const v2Late = published.slice(2).map((cp, i) => ({ ...cp, date: `2026-11-0${i + 1}` }));
  const resigned: PublicCheckpoint[] = [];
  for (const cp of v2Late) {
    const v2 = cp as PublicCheckpointV2;
    const prev_hash = resigned.length ? (resigned.at(-1) as PublicCheckpointV2).hash : null;
    const b = {
      v: 2 as const,
      date: v2.date,
      tree_size: v2.tree_size,
      withdrawn: v2.withdrawn,
      root: v2.root,
      prev_hash,
      subcounts_commitment: v2.subcounts_commitment,
    };
    resigned.push({
      ...b,
      hash: await checkpointHash(b),
      signature: null,
      consistency: resigned.length ? v2.consistency : [],
    });
  }
  assert.deepEqual(await verifyChain(resigned), []);
});

test('inclusion proofs verify against withheld v1 and v2 roots alike', async () => {
  const { chain, leaves } = await mixedChain();
  for (const cp of chain.map(toPublicCheckpoint)) {
    const proof = await inclusionProof(leaves.slice(0, cp.tree_size), 1);
    assert.equal(
      await verifyInclusion(leaves[1]!, 1, cp.tree_size, proof, Buffer.from(cp.root, 'hex')),
      true,
    );
  }
});

test('no public endpoint or public file reveals the split, for v1 or v2 checkpoints', async (t) => {
  const saved = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'wired-cron-secret-0123456789';
  t.after(() => {
    if (saved === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = saved;
  });
  // The cron only runs in the Berlin-noon hour: pin its clock so the run is not skipped.
  const app = await createApp({
    dataDir: ':memory:',
    startWorkers: false,
    countLogCronNow: () => Date.parse('2026-10-01T10:00:00Z'),
  });
  t.after(() => app.close());
  // A historical v1 checkpoint (empty tree), stored with its split as before.
  const { privateKey } = keyPair();
  const v1: CheckpointBody = {
    v: 1,
    date: '2026-01-01',
    tree_size: 0,
    withdrawn: 0,
    root: toHex(await merkleRoot([])),
    prev_hash: null,
    subcounts: { in_person_accounts: 0, in_ai_workspaces: 0, unclaimed: 0, revoked: 0 },
  };
  const v1hash = await checkpointHash(v1);
  const v1sig = signWith(privateKey, v1hash);
  await app.city.db.query(
    `INSERT INTO count_log_checkpoints(date,tree_size,withdrawn,root,prev_hash,hash,subcounts,consistency,signature,created_at)
     VALUES($1,0,0,$2,NULL,$3,$4::jsonb,'[]'::jsonb,$5::jsonb,0)`,
    [v1.date, v1.root, v1hash, JSON.stringify(v1.subcounts), JSON.stringify(v1sig)],
  );
  const cron = await app.inject({
    url: '/api/cron/count-checkpoint',
    headers: { authorization: 'Bearer wired-cron-secret-0123456789' },
  });
  assert.equal(cron.statusCode, 200, cron.body);
  assert.doesNotMatch(cron.body, SPLIT_PATTERN);
  assert.ok(!cron.body.includes(v1hash));

  const list = await app.inject({ url: '/api/public/count-log/checkpoints' });
  const { checkpoints } = list.json() as { checkpoints: PublicCheckpoint[] };
  assert.deepEqual(
    checkpoints.map((cp) => cp.v),
    [1, 2],
  );
  assert.equal(isWithheld(checkpoints[0]!), true);
  assert.equal(
    (checkpoints[1] as PublicCheckpointV2).prev_hash,
    null,
    'the first v2 checkpoint starts a new chain',
  );
  assert.deepEqual(await verifyChain(checkpoints), []);
  // The next day's v2 checkpoint links to the first v2 hash.
  const tomorrow = createCountLog({ db: app.city.db, clock: () => Date.now() + 86_400_000 });
  const next = (await tomorrow.checkpoint()).checkpoint;
  assert.equal(next.v, 2);
  assert.equal(next.prev_hash, (checkpoints[1] as PublicCheckpointV2).hash);
  assert.deepEqual(await verifyChain(await tomorrow.checkpoints()), []);

  const urls = [
    '/api/public/count-log/checkpoints',
    '/api/public/count-log/checkpoints?after=2026-01-01',
    `/api/public/count-log/checkpoints/${checkpoints[0]!.date}`,
    `/api/public/count-log/checkpoints/${checkpoints[1]!.date}`,
    '/api/public/count-log/feed',
    '/api/public/count-log/leaves',
    '/api/public/count-log/withdrawn',
    '/api/public/stats',
    '/.well-known/jwks.json',
  ];
  for (const url of urls) {
    const res = await app.inject({ url });
    assert.equal(res.statusCode, 200, `${url}: ${res.body}`);
    assert.doesNotMatch(res.body, SPLIT_PATTERN, url);
    assert.doesNotMatch(res.body, /subcounts"/, url);
    // Nor the v1 hash or signature, which cover the private fields.
    assert.ok(!res.body.includes(v1hash), url);
    assert.ok(!res.body.includes(v1sig.sig), url);
  }
});

test('public static files do not describe the split as published', () => {
  const root = fileURLToPath(new URL('../public/', import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(txt|md|json|html)$/.test(name)) files.push(path);
    }
  };
  walk(root);
  for (const file of files)
    assert.doesNotMatch(
      readFileSync(file, 'utf8'),
      /subcounts|in_person_accounts|in_ai_workspaces/,
      file,
    );
});

test('the verify page client shows no signature status for withheld v1 checkpoints, never signed', async (t) => {
  const { chain, jwk } = await mixedChain();
  const published = chain.map(toPublicCheckpoint);
  const saved = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = saved;
  });
  const respond = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const serve = (list: PublicCheckpoint[]) => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = String(input);
      if (path.startsWith('/api/public/count-log/checkpoints'))
        return respond({ checkpoints: list });
      if (path === '/.well-known/jwks.json')
        return respond({ keys: [{ ...jwk, kid: 'synthetic' }] });
      return respond({ ai_agents_total: 8 });
    }) as typeof fetch;
  };
  serve(published);
  const data = await load();
  assert.deepEqual(data.problems, []);
  assert.deepEqual(
    published.map((cp) => data.signatures[cp.date]),
    ['withheld', 'withheld', 'valid', 'valid'],
  );
  // No signature words at all for a withheld v1 checkpoint (no ✓, no warning); v2 is signed ✓.
  assert.equal(SIGNATURE_WORDS.withheld, null);
  assert.equal(SIGNATURE_WORDS.valid, 'signed ✓');
  for (const words of Object.values(SIGNATURE_WORDS))
    assert.doesNotMatch(words ?? '', /not checkable/);
  assert.deepEqual(signatureSummary(data), {
    state: 'partial',
    withheld: 2,
    firstSigned: published[2]!.date,
  });
  // Inclusion against a withheld v1 checkpoint is confirmed on its chain alone; a v2 one needs
  // its signature too.
  assert.equal(checkpointConfirmed(true, 'withheld'), true);
  assert.equal(checkpointConfirmed(false, 'withheld'), false);
  assert.equal(checkpointConfirmed(true, 'valid'), true);
  assert.equal(checkpointConfirmed(true, 'invalid'), false);
  assert.equal(checkpointConfirmed(true, 'unsigned'), false);
  assert.match(unconfirmedReason(true), /signature check/);
  assert.match(unconfirmedReason(false), /chain check/);
  // Before the first v2 checkpoint, the latest checkpoint is a withheld v1 one.
  serve(published.slice(0, 2));
  const early = await load();
  assert.equal(signatureSummary(early).state, 'latest-withheld');
  // A withheld v1 entry with a hash and signature left over from an older copy is still not
  // checked (and so never shown as signed).
  serve([
    { ...chain[0]!, subcounts: undefined, subcounts_withheld: true } as unknown as PublicCheckpoint,
  ]);
  assert.equal((await load()).signatures[chain[0]!.date], 'withheld');
});
