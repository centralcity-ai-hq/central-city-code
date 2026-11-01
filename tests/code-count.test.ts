import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import Fastify from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../server/database.js';
import { publicStatsMigration } from '../server/stats/schema.js';
import {
  blobId,
  codeCountsMigration,
  countFiles,
  headUrl,
  registerCodeCountRoutes,
  runCodeCount,
  tarFiles,
  tarballUrl,
  type Fetch,
} from '../server/stats/code-count.js';
import { CODE_COUNT_REPOS, classifyPath, countLines, withAppCount } from '../shared/code-count.js';

// --- a minimal tar writer, so the tests feed the parser real archives ---
function header(name: string, size: number, type = '0', prefix = ''): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  if (prefix) h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
function pax(records: Record<string, string>): Buffer {
  let body = '';
  for (const [k, v] of Object.entries(records)) {
    const rec = ` ${k}=${v}\n`;
    let len = rec.length + 1;
    while (String(len).length + rec.length !== len) len = String(len).length + rec.length;
    body += len + rec;
  }
  const b = Buffer.from(body, 'utf8');
  return Buffer.concat([header('PaxHeader', b.length, 'x'), pad(b)]);
}
function tar(
  entries: Array<{ path: string; body?: string; type?: string; longPax?: boolean }>,
  top = 'org-repo-abc',
): Buffer {
  const parts: Buffer[] = [
    pax({ comment: 'abc' }).subarray(0, 0),
    header('pax_global_header', 0, 'g'),
  ];
  for (const e of entries) {
    const body = Buffer.from(e.body ?? '', 'utf8');
    const full = `${top}/${e.path}`;
    if (e.longPax) parts.push(pax({ path: full }), header('short', body.length, e.type ?? '0'));
    else parts.push(header(full, body.length, e.type ?? '0'));
    if (body.length) parts.push(pad(body));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
async function* chunked(buf: Buffer, size = 700): AsyncGenerator<Buffer> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}
async function collect(buf: Buffer, limits = { maxTarBytes: 1 << 30, maxFileBytes: 1 << 20 }) {
  const out: Array<{ path: string; text: string }> = [];
  for await (const f of tarFiles(chunked(buf), limits))
    out.push({ path: f.path, text: f.bytes.toString('utf8') });
  return out;
}

test('classifyPath: code, tests and what is never counted', () => {
  assert.equal(classifyPath('server/app.ts'), 'code');
  assert.equal(classifyPath('src/Downtown.tsx'), 'code');
  assert.equal(classifyPath('contracts/fees/Router.sol'), 'code');
  assert.equal(classifyPath('tests/code-count.test.ts'), 'tests');
  assert.equal(classifyPath('e2e/downtown.spec.ts'), 'tests');
  assert.equal(classifyPath('src/a.test.tsx'), 'tests');
  for (const p of [
    'README.md',
    'package.json',
    'pnpm-lock.yaml',
    'node_modules/x/a.js',
    'dist/a.js',
    'public/app.min.js',
    'Makefile',
    '.eslintrc',
  ])
    assert.equal(classifyPath(p), null, p);
});

test('countLines: non-blank lines; binary content is not counted', () => {
  assert.equal(countLines('a\n\n  \nb\n'), 2);
  assert.equal(countLines(''), 0);
  assert.equal(countLines('a\u0000b'), null);
});

test('blobId equals git hash-object', () => {
  // `printf 'hello\n' | git hash-object --stdin`
  assert.equal(blobId(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
});

test('tarFiles: strips the top folder, reads pax and ustar prefix paths, skips other entries', async () => {
  const long = 'deep/'.repeat(30) + 'file.ts';
  const files = await collect(
    Buffer.concat([
      tar([
        { path: 'src/a.ts', body: 'x\ny\n' },
        { path: 'dir/', type: '5' },
        { path: 'link.ts', type: '2' },
        { path: long, body: 'z\n', longPax: true },
      ]).subarray(0, -1024),
      header('a.ts', 2, '0', 'org-repo-abc/pre'),
      pad(Buffer.from('q\n')),
      Buffer.alloc(1024),
    ]),
  );
  assert.deepEqual(files, [
    { path: 'src/a.ts', text: 'x\ny\n' },
    { path: long, text: 'z\n' },
    { path: 'pre/a.ts', text: 'q\n' },
  ]);
});

test('tarFiles: a file over the per-file limit is skipped; a stream over the total limit fails', async () => {
  const big = 'a\n'.repeat(3000);
  const files = await collect(
    tar([
      { path: 'big.ts', body: big },
      { path: 'ok.ts', body: 'b\n' },
    ]),
    {
      maxTarBytes: 1 << 30,
      maxFileBytes: 1000,
    },
  );
  assert.deepEqual(
    files.map((f) => f.path),
    ['ok.ts'],
  );
  await assert.rejects(
    collect(tar([{ path: 'big.ts', body: big }]), { maxTarBytes: 2048, maxFileBytes: 1 << 20 }),
    /tar_too_large/,
  );
});

test('countFiles: identical files count once across repositories', async () => {
  const seen = new Set<string>();
  const a = await countFiles(
    tarFiles(
      chunked(
        tar([
          { path: 'x.ts', body: 'one\ntwo\n' },
          { path: 'tests/x.test.ts', body: 't\n' },
        ]),
      ),
      { maxTarBytes: 1 << 30, maxFileBytes: 1 << 20 },
    ),
    seen,
  );
  const b = await countFiles(
    tarFiles(
      chunked(
        tar([
          { path: 'copy/x.ts', body: 'one\ntwo\n' },
          { path: 'y.md', body: 'doc\n' },
        ]),
      ),
      { maxTarBytes: 1 << 30, maxFileBytes: 1 << 20 },
    ),
    seen,
  );
  assert.deepEqual(a, { code: 2, tests: 1, files: 2 });
  assert.deepEqual(b, { code: 0, tests: 0, files: 0 });
});

test('URLs are fixed: only api.github.com and codeload.github.com, only our repositories', () => {
  assert.equal(
    headUrl('protocol'),
    'https://api.github.com/repos/centralcity-ai-hq/protocol/commits/HEAD',
  );
  assert.equal(
    tarballUrl('toolkit', 'a'.repeat(40)),
    `https://codeload.github.com/centralcity-ai-hq/toolkit/tar.gz/${'a'.repeat(40)}`,
  );
  assert.throws(() => tarballUrl('toolkit', 'main'), /Invalid commit/);
  assert.throws(() => tarballUrl('toolkit', '../evil'), /Invalid commit/);
});

// --- the cron and the public route, on a real (in-memory) Postgres ---
async function database(): Promise<Database> {
  const pg = new PGlite();
  await pg.exec(publicStatsMigration.sql);
  await pg.exec(codeCountsMigration.sql);
  return pg as unknown as Database;
}

function fakeGitHub(heads: Record<string, string>, archives: Record<string, Buffer>) {
  const calls: string[] = [];
  const fetcher: Fetch = async (url, init) => {
    calls.push(url);
    assert.equal(init.redirect, 'error');
    const host = new URL(url).host;
    assert.ok(host === 'api.github.com' || host === 'codeload.github.com', url);
    const repo = url.split('/')[host === 'api.github.com' ? 5 : 4];
    if (host === 'api.github.com') return new Response(heads[repo] + '\n');
    return new Response(gzipSync(archives[repo] ?? tar([])));
  };
  return { fetcher, calls };
}

const commit = (c: string) => c.repeat(40);

test('runCodeCount: counts once, skips while heads are unchanged, recounts after a new commit', async () => {
  const db = await database();
  const heads = Object.fromEntries(CODE_COUNT_REPOS.map((r) => [r, commit('a')]));
  const archives = {
    'central-city-code': tar([
      { path: 'server/a.ts', body: 'a\nb\nc\n' },
      { path: 'tests/a.test.ts', body: 't\n' },
    ]),
    toolkit: tar([
      { path: 'mcp/a.ts', body: 'a\nb\nc\n' },
      { path: 'cli.ts', body: 'x\n' },
    ]),
  };
  const gh = fakeGitHub(heads, archives);
  let now = 1_761_000_000_000;
  const first = await runCodeCount({ db, fetcher: gh.fetcher, clock: () => now, log: () => {} });
  assert.equal(first.status, 'counted');
  assert.equal(first.status === 'counted' && first.count.total, 5);
  assert.equal(first.status === 'counted' && first.count.code, 4);

  const callsBefore = gh.calls.length;
  now += 60_000;
  const second = await runCodeCount({ db, fetcher: gh.fetcher, clock: () => now, log: () => {} });
  assert.equal(second.status, 'unchanged');
  assert.equal(gh.calls.length - callsBefore, CODE_COUNT_REPOS.length, 'only the head reads');

  heads.protocol = commit('b');
  now += 60_000;
  const third = await runCodeCount({ db, fetcher: gh.fetcher, clock: () => now, log: () => {} });
  assert.equal(third.status, 'counted');
  const { rows } = await db.query<{ n: string }>('SELECT count(*) AS n FROM code_counts');
  assert.equal(Number(rows[0].n), 2);
});

test('runCodeCount: a failing head read stores nothing; a held lease means busy', async () => {
  const db = await database();
  const failing: Fetch = async () => new Response('nope', { status: 500 });
  const run = await runCodeCount({ db, fetcher: failing, log: () => {} });
  assert.deepEqual(run, { status: 'failed', error: 'head_500' });

  const gh = fakeGitHub(Object.fromEntries(CODE_COUNT_REPOS.map((r) => [r, commit('c')])), {});
  await db.query(`INSERT INTO public_stats (key, refreshing_until) VALUES ('code_count', $1)`, [
    Date.now() + 60_000,
  ]);
  assert.deepEqual(await runCodeCount({ db, fetcher: gh.fetcher, log: () => {} }), {
    status: 'busy',
  });
});

test('routes: cron needs the secret; the public route serves the latest count, edge-cached', async () => {
  const db = await database();
  const gh = fakeGitHub(Object.fromEntries(CODE_COUNT_REPOS.map((r) => [r, commit('d')])), {
    protocol: tar([{ path: 'a.ts', body: 'a\n' }]),
  });
  const app = Fastify();
  const limited: string[] = [];
  registerCodeCountRoutes(app, {
    db,
    limit: async (key) => void limited.push(key),
    cronSecret: 'secret',
    fetcher: gh.fetcher,
    log: () => {},
  });
  assert.equal((await app.inject({ url: '/api/public/code' })).statusCode, 503);
  assert.equal((await app.inject({ url: '/api/cron/code-count' })).statusCode, 404);
  assert.equal(
    (await app.inject({ url: '/api/cron/code-count', headers: { authorization: 'Bearer wrong!' } }))
      .statusCode,
    404,
  );
  const cron = await app.inject({
    url: '/api/cron/code-count',
    headers: { authorization: 'Bearer secret' },
  });
  assert.equal(cron.statusCode, 200);
  assert.equal(cron.json().status, 'counted');
  const pub = await app.inject({ url: '/api/public/code' });
  assert.equal(pub.statusCode, 200);
  assert.equal(pub.json().total, 1);
  assert.equal(pub.json().repos.length, CODE_COUNT_REPOS.length);
  assert.match(String(pub.headers['vercel-cdn-cache-control']), /max-age=300/);
  assert.ok(limited.every((k) => k.startsWith('ip:code:')));
  await app.close();
});

test('countRepo: an oversize file is reported as skipped, never silently dropped', async () => {
  const db = await database();
  const big = 'x\n'.repeat(1_100_000); // 2.2 MB, over the 2 MB limit
  const gh = fakeGitHub(Object.fromEntries(CODE_COUNT_REPOS.map((r) => [r, commit('e')])), {
    'sdk-ts': tar([
      { path: 'gen/huge.ts', body: big },
      { path: 'a.ts', body: 'a\n' },
    ]),
  });
  const run = await runCodeCount({ db, fetcher: gh.fetcher, log: () => {} });
  assert.equal(run.status, 'counted');
  if (run.status !== 'counted') return;
  assert.equal(run.count.total, 1);
  assert.equal(run.count.skipped_files, 1);
  assert.equal(run.count.repos.find((r) => r.name === 'sdk-ts')?.skipped, 1);
});

test('a failed recount keeps the last count public, with its date', async () => {
  const db = await database();
  const heads = Object.fromEntries(CODE_COUNT_REPOS.map((r) => [r, commit('f')]));
  const good = fakeGitHub(heads, { protocol: tar([{ path: 'a.ts', body: 'a\nb\n' }]) });
  const first = await runCodeCount({ db, fetcher: good.fetcher, log: () => {} });
  assert.equal(first.status, 'counted');
  heads.protocol = commit('9');
  const broken: Fetch = async (url, init) =>
    new URL(url).host === 'codeload.github.com'
      ? new Response('gone', { status: 404 })
      : good.fetcher(url, init);
  const second = await runCodeCount({ db, fetcher: broken, log: () => {} });
  assert.deepEqual(second, { status: 'failed', error: 'tarball_404' });
  const app = Fastify();
  registerCodeCountRoutes(app, { db, limit: async () => {}, log: () => {} });
  const pub = await app.inject({ url: '/api/public/code' });
  assert.equal(pub.json().total, 2);
  assert.equal(pub.json().counted_at, first.status === 'counted' ? first.count.counted_at : '');
  const { rows } = await db.query<{ refreshing_until: string }>(
    "SELECT refreshing_until FROM public_stats WHERE key = 'code_count'",
  );
  assert.equal(Number(rows[0].refreshing_until), 0, 'the lease is released after a failure');
  await app.close();
});

// --- regressions from the security review ---
const LIMITS = { maxTarBytes: 1 << 30, maxFileBytes: 1 << 20, maxMetaBytes: 1024 };
async function drain(buf: Buffer, limits = LIMITS) {
  const out: string[] = [];
  for await (const f of tarFiles(chunked(buf), limits)) out.push(f.path);
  return out;
}

test('tarFiles: an entry cut short at the end of the stream is an error, not fewer files', async () => {
  // A valid header declaring 10 bytes, followed by only 2.
  const cut = Buffer.concat([header('org-repo-abc/a.ts', 10), Buffer.from('a\n')]);
  await assert.rejects(drain(cut), /tar_truncated/);
});

test('tarFiles: an archive without its end-of-archive block is an error', async () => {
  const whole = tar([{ path: 'a.ts', body: 'a\n' }]);
  await assert.rejects(drain(whole.subarray(0, whole.length - 1024)), /tar_truncated/);
});

test('tarFiles: a bad checksum or a malformed size is an error', async () => {
  const bad = tar([{ path: 'a.ts', body: 'a\n' }]);
  bad[512 + 10] ^= 0xff; // a name byte of the file header, so its checksum no longer matches
  await assert.rejects(drain(bad), /tar_invalid/);
  const h = header('org-repo-abc/a.ts', 0);
  h.write('9999999999\0', 124); // not octal
  await assert.rejects(drain(Buffer.concat([h, Buffer.alloc(1024)])), /tar_invalid/);
});

test('tarFiles: a pax or long-name body over the metadata limit is an error', async () => {
  const huge = Buffer.concat([
    header('PaxHeader', 4096, 'x'),
    Buffer.alloc(4096, 0x41),
    Buffer.alloc(1024),
  ]);
  await assert.rejects(drain(huge), /tar_invalid/);
});

test('countRepo: a failing body stream rejects the count instead of hanging', async () => {
  const db = await database();
  const heads = Object.fromEntries(CODE_COUNT_REPOS.map((r) => [r, commit('7')]));
  const fetcher: Fetch = async (url) => {
    if (new URL(url).host === 'api.github.com') return new Response(heads.protocol + '\n');
    const gz = gzipSync(tar([{ path: 'a.ts', body: 'a\n'.repeat(5000) }]));
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(gz.subarray(0, 100));
        } else controller.error(new Error('socket hang up'));
      },
    });
    return new Response(body);
  };
  const run = await runCodeCount({ db, fetcher, log: () => {} });
  assert.equal(run.status, 'failed');
  const { rows } = await db.query<{ n: string }>('SELECT count(*) AS n FROM code_counts');
  assert.equal(Number(rows[0].n), 0);
});

test('runCodeCount: a run whose lease was taken over never stores its count', async () => {
  const db = await database();
  const heads = Object.fromEntries(CODE_COUNT_REPOS.map((r) => [r, commit('8')]));
  const gh = fakeGitHub(heads, { transparency: tar([{ path: 'a.ts', body: 'a\n' }]) });
  // While the last tarball downloads, another instance takes the lease (as if ours had expired).
  const fetcher: Fetch = async (url, init) => {
    if (url.includes('/transparency/tar.gz/'))
      await db.query(`UPDATE public_stats SET refreshing_until = 42 WHERE key = 'code_count'`);
    return gh.fetcher(url, init);
  };
  const run = await runCodeCount({ db, fetcher, log: () => {} });
  assert.deepEqual(run, { status: 'failed', error: 'lease_lost' });
  const { rows } = await db.query<{ n: string }>('SELECT count(*) AS n FROM code_counts');
  assert.equal(Number(rows[0].n), 0);
  const lease = await db.query<{ refreshing_until: string }>(
    `SELECT refreshing_until FROM public_stats WHERE key = 'code_count'`,
  );
  assert.equal(Number(lease.rows[0].refreshing_until), 42, 'the other instance keeps its lease');
});

test('runCodeCount: the whole run stays inside its budget', async () => {
  const db = await database();
  const heads = Object.fromEntries(CODE_COUNT_REPOS.map((r) => [r, commit('6')]));
  const gh = fakeGitHub(heads, {});
  let now = 1_000_000;
  // Every tarball "takes" 100 s on this clock: the third repository is past the 240 s budget.
  const fetcher: Fetch = async (url, init) => {
    if (url.includes('/tar.gz/')) now += 100_000;
    return gh.fetcher(url, init);
  };
  const run = await runCodeCount({ db, fetcher, clock: () => now, log: () => {} });
  assert.deepEqual(run, { status: 'failed', error: 'run_budget_exhausted' });
});

test('runCodeCount: slow head reads count against the same run budget', async () => {
  const db = await database();
  const heads = Object.fromEntries(CODE_COUNT_REPOS.map((r) => [r, commit('5')]));
  const gh = fakeGitHub(heads, {});
  let now = 2_000_000;
  const timeouts: number[] = [];
  // Every head read "takes" 50 s: by the sixth read the 240 s budget is gone, before any tarball.
  const fetcher: Fetch = async (url, init) => {
    if (url.startsWith('https://api.github.com/')) {
      timeouts.push(now);
      now += 50_000;
    }
    return gh.fetcher(url, init);
  };
  const run = await runCodeCount({ db, fetcher, clock: () => now, log: () => {} });
  assert.deepEqual(run, { status: 'failed', error: 'run_budget_exhausted' });
  assert.equal(timeouts.length, 5, 'no head read starts after the budget is used up');
  assert.equal(gh.calls.filter((u) => u.includes('/tar.gz/')).length, 0);
});

test('the app repository counted at build replaces its public copy; totals and time follow', () => {
  const stored = {
    total: 1000,
    code: 700,
    tests: 300,
    files: 30,
    skipped_files: 1,
    counted_at: '2026-10-24T22:17:48.471Z',
    repos: [
      {
        name: 'central-city-code' as const,
        commit: 'a'.repeat(40),
        code: 600,
        tests: 250,
        files: 20,
        skipped: 1,
      },
      {
        name: 'protocol' as const,
        commit: 'b'.repeat(40),
        code: 100,
        tests: 50,
        files: 10,
        skipped: 0,
      },
    ],
  };
  // No build count (development, tests): the stored count unchanged.
  assert.equal(withAppCount(stored, null), stored);
  const merged = withAppCount(stored, {
    name: 'central-city',
    code: 800,
    tests: 400,
    files: 40,
    commit: 'c'.repeat(40),
    counted_at: '2026-10-25T08:30:00.000Z',
  });
  assert.deepEqual(
    merged.repos.map((r) => r.name),
    ['central-city', 'protocol'],
  );
  assert.equal(merged.code, 900);
  assert.equal(merged.tests, 450);
  assert.equal(merged.total, 1350);
  assert.equal(merged.files, 50);
  // The public copy's skipped file went with it.
  assert.equal(merged.skipped_files, 0);
  assert.equal(merged.counted_at, '2026-10-25T08:30:00.000Z');
  // An older build count keeps the newer stored time.
  assert.equal(
    withAppCount(stored, {
      name: 'central-city',
      code: 1,
      tests: 1,
      files: 1,
      commit: null,
      counted_at: '2026-10-20T00:00:00.000Z',
    }).counted_at,
    stored.counted_at,
  );
});
