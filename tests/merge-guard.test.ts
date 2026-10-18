import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MAX_CHECK_SUITES,
  MAX_PR_COMMITS,
  PER_PAGE,
  decide,
  isEntryPoint,
  main,
  parseTargets,
} from '../scripts/ops/merge-guard.mjs';

/**
 * scripts/ops/merge-guard.mjs against a mocked GitHub API: no request leaves the process.
 * Shas are repeated letters so a failure message shows which one was used.
 */
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const SQUASH = 'c'.repeat(40);
const HEAD_2 = 'd'.repeat(40);
const EARLIER = 'e'.repeat(40);
/** The base branch tip the PR and its CI run were made against, and a later one. */
const BASE = 'f'.repeat(40);
const NEW_BASE = '7'.repeat(40);
const REPO = 'example-org/example-repo';
const TOKEN = 'placeholder';
const AUTHOR = { login: 'pr-author', id: 1 };
const ALICE = { login: 'reviewer-a', id: 2 };
const BOB = { login: 'reviewer-b', id: 3 };
/** GitHub's committer for commits made in its web interface. */
const WEB_FLOW = { login: 'web-flow', id: 4 };
const script = fileURLToPath(new URL('../scripts/ops/merge-guard.mjs', import.meta.url));

type Item = Record<string, any>;
let clock = 0;
let ids = 0;
/** Strictly increasing timestamps and ids, so creation order is the API's order. */
const next = () => new Date(Date.UTC(2026, 9, 15, 10) + ++clock * 1000).toISOString();

/** The check suite of the check.yml workflow run on a sha (one per sha in these fixtures). */
const suiteOf = (sha: string) => 9000 + parseInt(sha[0]!, 16);
const CHECK_YML = '.github/workflows/check.yml';
/** The check suite of an unrelated workflow that also has a job named like a check.yml job. */
const OTHER_SUITE = 8001;
const OTHER_YML = '.github/workflows/other.yml';

/** A check run; by default a job of the check.yml workflow run on its head_sha. */
function run(name: string, extra: Item = {}): Item {
  return {
    id: ++ids,
    name,
    head_sha: HEAD,
    status: 'completed',
    conclusion: 'success',
    started_at: next(),
    app: { slug: 'github-actions' },
    check_suite: { id: suiteOf(extra.head_sha ?? HEAD) },
    ...extra,
  };
}

/** A pull_requests entry of a workflow run: the PR it ran for, with that PR's base. */
function association(number = 101, extra: Item = {}): Item {
  return {
    id: 50_000 + number,
    number,
    head: { ref: 'feature', sha: HEAD },
    base: { ref: 'main', sha: BASE },
    ...extra,
  };
}

/** A workflow run as GET /actions/runs?check_suite_id= lists it: check.yml for a pull request. */
function workflowRun(sha = HEAD, extra: Item = {}, number = 101): Item {
  return {
    id: ++ids,
    name: 'Verify application',
    path: CHECK_YML,
    check_suite_id: suiteOf(sha),
    head_sha: sha,
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
    pull_requests: [association(number, { head: { ref: 'feature', sha } })],
    ...extra,
  };
}

/** The unrelated workflow, and a check run of one of its jobs. */
const otherWorkflow = (extra: Item = {}) =>
  workflowRun(HEAD, { name: 'Other', path: OTHER_YML, check_suite_id: OTHER_SUITE, ...extra });
const fromOther = (name: string, extra: Item = {}) =>
  run(name, { check_suite: { id: OTHER_SUITE }, ...extra });

function review(user: Item, state: string, extra: Item = {}): Item {
  return { id: ++ids, user, state, commit_id: HEAD, submitted_at: next(), ...extra };
}

/** A PR commit as GET /pulls/{n}/commits lists it; author and committer are GitHub accounts. */
function commit(author: Item | null, extra: Item = {}): Item {
  return { sha: HEAD, author, committer: author, commit: { message: 'change' }, ...extra };
}

/** The checks of a green code PR: docs is skipped, everything else succeeded, verify last. */
function green(sha = HEAD, without: string[] = []): Item[] {
  return [
    run('changes', { head_sha: sha }),
    run('secrets', { head_sha: sha }),
    run('docs', { head_sha: sha, conclusion: 'skipped' }),
    run('unit (1)', { head_sha: sha }),
    run('browser (1)', { head_sha: sha }),
    run('postgres-races', { head_sha: sha }),
    run('verify', { head_sha: sha }),
  ].filter((item) => !without.includes(item.name));
}

interface Pr {
  number: number;
  pull: Item;
  checkRuns: Item[];
  /** The workflow runs behind the check suites; by default check.yml's run on the head. */
  workflowRuns: Item[];
  reviews: Item[];
  /** The PR's commits; pull.commits defaults to their number. */
  commits: Item[];
  merge: { status: number; body: Item };
  /** total_count the check-runs endpoint reports; defaults to the real count. */
  checkTotal?: number;
}

function pr(over: Partial<Pr> & { pull?: Item } = {}, number = 101, head = HEAD): Pr {
  const commits = over.commits ?? [commit(AUTHOR, { sha: head })];
  const base: Pr = {
    number,
    pull: {
      number,
      state: 'open',
      merged: false,
      mergeable_state: 'clean',
      head: { sha: head },
      base: { ref: 'main', sha: BASE },
      user: AUTHOR,
      commits: commits.length,
    },
    checkRuns: green(head),
    workflowRuns: [workflowRun(head, {}, number)],
    reviews: [review(ALICE, 'APPROVED', { commit_id: head })],
    commits,
    merge: { status: 200, body: { merged: true, sha: SQUASH, message: 'Pull Request merged' } },
  };
  return { ...base, ...over, pull: { ...base.pull, ...over.pull } };
}

type Fail = (url: URL, method: string) => Response | undefined;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** A fake api.github.com for the given PRs. Lists honour per_page and page. */
function fakeGitHub(prs: Pr[], fail?: Fail) {
  const calls: Array<{ method: string; url: URL; body?: any; authorization?: string }> = [];
  const unexpected: string[] = [];
  const fetch = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({
      method,
      url,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      authorization: headers.authorization,
    });
    const failure = fail?.(url, method);
    if (failure) return failure;
    const page = Number(url.searchParams.get('page') ?? 1);
    const perPage = Number(url.searchParams.get('per_page') ?? 30);
    const slice = (items: Item[]) => items.slice((page - 1) * perPage, page * perPage);
    const prefix = `/repos/${REPO}`;
    const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : null;
    if (url.origin !== 'https://api.github.com' || path === null) {
      unexpected.push(`${method} ${url}`);
      return json({ message: 'Not Found' }, 404);
    }
    const checks = /^\/commits\/([0-9a-f]{40})\/check-runs$/.exec(path);
    if (method === 'GET' && checks) {
      const owner = prs.find((item) => item.pull.head.sha === checks[1]);
      const runs = owner?.checkRuns ?? [];
      return json({ total_count: owner?.checkTotal ?? runs.length, check_runs: slice(runs) });
    }
    if (method === 'GET' && path === '/actions/runs' && url.searchParams.has('check_suite_id')) {
      const suite = Number(url.searchParams.get('check_suite_id'));
      const runs = prs
        .flatMap((item) => item.workflowRuns)
        .filter((item) => item.check_suite_id === suite);
      return json({ total_count: runs.length, workflow_runs: runs });
    }
    const match = /^\/pulls\/(\d+)(\/reviews|\/commits|\/merge)?$/.exec(path);
    const target = match && prs.find((item) => item.number === Number(match[1]));
    if (target && method === 'GET' && !match[2]) return json(target.pull);
    if (target && method === 'GET' && match[2] === '/reviews') return json(slice(target.reviews));
    // GitHub lists at most 250 commits of a PR and silently leaves out the rest.
    if (target && method === 'GET' && match[2] === '/commits')
      return json(slice(target.commits.slice(0, 250)));
    if (target && method === 'PUT' && match[2] === '/merge')
      return json(target.merge.body, target.merge.status);
    unexpected.push(`${method} ${url}`);
    return json({ message: 'Not Found' }, 404);
  };
  return { fetch, calls, unexpected };
}

type Options = { fail?: Fail; env?: Record<string, string> };

async function guard(
  argv: string[],
  prs: Pr[],
  { fail, env = { GITHUB_TOKEN: TOKEN } }: Options = {},
) {
  const github = fakeGitHub(prs, fail);
  const lines: string[] = [];
  const code = await main(argv, {
    env,
    fetch: github.fetch,
    origin: () => {
      throw new Error('origin is not read when --repo is given');
    },
    credential: () => {
      throw new Error('no credential helper in tests');
    },
    log: (line) => lines.push(line),
  });
  assert.deepEqual(github.unexpected, []);
  const output = lines.join('\n');
  assert.ok(!output.includes(TOKEN), 'the token never reaches the output');
  return {
    code,
    output,
    calls: github.calls,
    merges: github.calls.filter((call) => call.method === 'PUT'),
  };
}

const one = (item: Pr, extra: string[] = [], options: Options = {}) =>
  guard([`${item.number}:${HEAD}`, '--repo', REPO, ...extra], [item], options);

async function refused(item: Pr, reason: RegExp, options: Options = {}) {
  const result = await one(item, [], options);
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /^REFUSED #101 @ aaaaaaaa: /m);
  assert.match(result.output, reason);
  assert.equal(result.merges.length, 0, 'no merge call after a refusal');
  return result;
}

async function merged(item: Pr) {
  const result = await one(item);
  assert.equal(result.code, 0, result.output);
  assert.equal(result.merges.length, 1);
  return result;
}

test('happy path: one squash merge call that carries the expected head sha', async () => {
  const result = await merged(pr());
  assert.equal(result.output, 'MERGED #101 @ aaaaaaaa (squash commit cccccccc)');
  const [call] = result.merges;
  assert.equal(call!.url.href, `https://api.github.com/repos/${REPO}/pulls/101/merge`);
  assert.deepEqual(call!.body, { merge_method: 'squash', sha: HEAD });
  assert.equal(call!.authorization, `Bearer ${TOKEN}`);
  const checks = result.calls.find((item) => item.url.pathname.endsWith('/check-runs'))!;
  assert.equal(checks.url.pathname, `/repos/${REPO}/commits/${HEAD}/check-runs`);
  assert.equal(checks.url.searchParams.get('filter'), 'all');
  assert.equal(checks.url.searchParams.get('per_page'), String(PER_PAGE));
  // The merge is the last call: every read happened before it.
  assert.equal(result.calls.at(-1)!.method, 'PUT');
});

test('--dry-run decides without merging', async () => {
  const result = await one(pr(), ['--dry-run']);
  assert.equal(result.code, 0);
  assert.equal(result.output, 'PASSED #101 @ aaaaaaaa (dry run: not merged)');
  assert.equal(result.merges.length, 0);
});

test('missing verify refuses', async () => {
  await refused(
    pr({ checkRuns: green(HEAD, ['verify']) }),
    /'verify' check is missing on aaaaaaaa/,
  );
});

test('pending verify refuses', async () => {
  const checkRuns = [
    ...green(HEAD, ['verify']),
    run('verify', { status: 'in_progress', conclusion: null }),
  ];
  const result = await refused(pr({ checkRuns }), /'verify' is in_progress, need success/);
  assert.match(result.output, /checks not green: verify=in_progress/);
});

test('failed verify refuses', async () => {
  const checkRuns = [...green(HEAD, ['verify']), run('verify', { conclusion: 'failure' })];
  await refused(pr({ checkRuns }), /'verify' is failure, need success/);
  // skipped and neutral pass for other checks, but never for verify.
  for (const conclusion of ['skipped', 'neutral']) {
    const runs = [...green(HEAD, ['verify']), run('verify', { conclusion })];
    await refused(pr({ checkRuns: runs }), new RegExp(`'verify' is ${conclusion}, need success`));
  }
});

test('verify from another app refuses, even after a real verify passed', async () => {
  const impostor = { slug: 'impostor-app' };
  const only = [...green(HEAD, ['verify']), run('verify', { app: impostor })];
  await refused(pr({ checkRuns: only }), /latest 'verify' comes from app 'impostor-app'/);
  const later = [...green(), run('verify', { app: impostor })];
  await refused(pr({ checkRuns: later }), /latest 'verify' comes from app 'impostor-app'/);
  const noApp = [...green(HEAD, ['verify']), run('verify', { app: null })];
  await refused(pr({ checkRuns: noApp }), /comes from app 'unknown'/);
});

test("a 'verify' from an unrelated workflow is not the gate", async () => {
  const ambiguous =
    /a 'verify' check comes from workflow '\.github\/workflows\/other\.yml', not '\.github\/workflows\/check\.yml': two sources make the gate ambiguous/;
  // The only verify on the head is another workflow's job; head, approval and the rest are valid.
  const repro = pr({
    checkRuns: [...green(HEAD, ['verify']), fromOther('verify')],
    workflowRuns: [workflowRun(), otherWorkflow()],
  });
  const result = await refused(
    repro,
    /no 'verify' check from '\.github\/workflows\/check\.yml' on aaaaaaaa/,
  );
  assert.match(result.output, ambiguous);
  const direct = decide({
    pull: repro.pull,
    expectedSha: HEAD,
    checkRuns: repro.checkRuns,
    workflowRuns: repro.workflowRuns,
    reviews: repro.reviews,
    commits: repro.commits,
  });
  assert.equal(direct.ok, false);
  // Nothing from check.yml on the head at all.
  await refused(
    pr({ checkRuns: [fromOther('verify')], workflowRuns: [otherWorkflow()] }),
    /no 'verify' check from '\.github\/workflows\/check\.yml'/,
  );
  // Started later and green, it does not replace check.yml's failed verify.
  const masked = [
    ...green(HEAD, ['verify']),
    run('verify', { conclusion: 'failure' }),
    fromOther('verify'),
  ];
  await refused(
    pr({ checkRuns: masked, workflowRuns: [workflowRun(), otherWorkflow()] }),
    /'verify' is failure, need success/,
  );
  // The same holds for any other name: check.yml's failed unit (1) stays failed.
  const hidden = [
    ...green(HEAD, ['unit (1)']),
    run('unit (1)', { conclusion: 'failure' }),
    fromOther('unit (1)'),
  ];
  await refused(
    pr({ checkRuns: hidden, workflowRuns: [workflowRun(), otherWorkflow()] }),
    /checks not green: unit \(1\)=failure/,
  );
  // And a failure of the other workflow's job is named with its workflow.
  await refused(
    pr({
      checkRuns: [...green(), fromOther('unit (1)', { conclusion: 'failure' })],
      workflowRuns: [workflowRun(), otherWorkflow()],
    }),
    /checks not green: unit \(1\) \(workflow '\.github\/workflows\/other\.yml'\)=failure/,
  );
});

test("verify from check.yml's pull request run, green and approved, merges", async () => {
  // A check of another app (its own check suite) is not looked up as a workflow.
  const vercel = run('Vercel', { app: { slug: 'vercel' }, check_suite: { id: 5000 } });
  const result = await merged(pr({ checkRuns: [...green(), vercel] }));
  const lookups = result.calls.filter((call) => call.url.pathname.endsWith('/actions/runs'));
  assert.deepEqual(
    lookups.map((call) => [call.url.pathname, call.url.searchParams.get('check_suite_id')]),
    [[`/repos/${REPO}/actions/runs`, String(suiteOf(HEAD))]],
  );
  // Several workflow runs of check.yml on the head: the latest verify decides, so a rerun in a
  // new workflow run supersedes an earlier failure.
  const earlier = workflowRun(HEAD, { check_suite_id: 9100, conclusion: 'failure' });
  const failedFirst = run('verify', { conclusion: 'failure', check_suite: { id: 9100 } });
  const rerun = await merged(
    pr({ checkRuns: [failedFirst, ...green()], workflowRuns: [earlier, workflowRun()] }),
  );
  assert.equal(
    rerun.calls.filter((call) => call.url.pathname.endsWith('/actions/runs')).length,
    2,
    'one lookup per check suite',
  );
  // The other way round, the later failed run decides.
  const later = workflowRun(HEAD, { check_suite_id: 9100, conclusion: 'failure' });
  await refused(
    pr({
      checkRuns: [...green(), run('verify', { conclusion: 'failure', check_suite: { id: 9100 } })],
      workflowRuns: [workflowRun(), later],
    }),
    /'verify' is failure, need success/,
  );
});

test("two 'verify' checks, check.yml's green and another workflow's: strict, refuses", async () => {
  for (const conclusion of ['success', 'failure', 'skipped', 'neutral']) {
    for (const otherFirst of [true, false]) {
      const other = fromOther('verify', { conclusion });
      const checkRuns = otherFirst ? [other, ...green()] : [...green(), other];
      await refused(
        pr({ checkRuns, workflowRuns: [workflowRun(), otherWorkflow()] }),
        /two sources make the gate ambiguous \(rename the other job\)/,
      );
    }
  }
});

test("check.yml's workflow run must be for the head, a pull request, and completed green", async () => {
  const gate = (extra: Item) => pr({ workflowRuns: [workflowRun(HEAD, extra)] });
  await refused(
    gate({ head_sha: OLD }),
    /'verify' workflow run \d+ is for bbbbbbbb, expected aaaaaaaa/,
  );
  await refused(gate({ head_sha: null }), /'verify' workflow run \d+ is for \(none\)/);
  await refused(
    gate({ status: 'in_progress', conclusion: null }),
    /'verify' workflow run \d+ is in_progress, need completed with success/,
  );
  await refused(gate({ status: 'queued', conclusion: null }), /is queued, need completed/);
  for (const conclusion of ['failure', 'cancelled', 'skipped', 'neutral', null])
    await refused(
      gate({ conclusion }),
      new RegExp(`'verify' workflow run \\d+ is ${conclusion}, need completed with success`),
    );
  for (const event of ['workflow_dispatch', 'push', 'schedule', 'pull_request_target'])
    await refused(
      gate({ event }),
      new RegExp(`'verify' workflow run \\d+ was started by '${event}', need 'pull_request'`),
    );
  // The path must be exactly check.yml's.
  for (const path of [
    '.github/workflows/check.yaml',
    './.github/workflows/check.yml',
    '.github/workflows/Check.yml',
    '.github/workflows/check.yml@refs/heads/main',
    'other/repo/.github/workflows/check.yml',
  ])
    await refused(
      gate({ path }),
      /no 'verify' check from '\.github\/workflows\/check\.yml' on aaaaaaaa/,
    );
});

test('the CI run must have run for this PR and its base, not only for its head', async () => {
  const unassociated = /manual review needed: CI run not associated with this PR/;
  const gate = (pullRequests: unknown, pull: Item = {}) =>
    pr({ pull, workflowRuns: [workflowRun(HEAD, { pull_requests: pullRequests })] });
  // This PR, its base branch and base sha: passes.
  await merged(gate([association()]));
  // Same head, but the run is associated with another PR.
  await refused(
    gate([association(102)]),
    /manual review needed: CI run not associated with this PR \(workflow run \d+ ran for #102, not #101\)/,
  );
  // Same PR number, another base branch or base sha.
  await refused(
    gate([association(101, { base: { ref: 'release', sha: BASE } })]),
    /ran for #101 against base 'release' at ffffffff, this PR's base is 'main' at ffffffff/,
  );
  await refused(
    gate([association(101, { base: { ref: 'main', sha: OLD } })]),
    /ran for #101 against base 'main' at bbbbbbbb, this PR's base is 'main' at ffffffff/,
  );
  // The PR's base moved after the run.
  await refused(
    gate([association()], { base: { ref: 'main', sha: NEW_BASE } }),
    /this PR's base is 'main' at 77777777/,
  );
  // The run's base sha must be a full sha equal to the PR's: missing, null, short or malformed
  // is no match, even on the right branch.
  const noFullSha =
    /manual review needed: CI run not associated with this PR \(workflow run \d+ ran for #101 against base 'main' at no full sha, this PR's base is 'main' at ffffffff\)/;
  for (const sha of [
    undefined,
    null,
    '',
    BASE.slice(0, 8),
    BASE.slice(0, 39),
    `${BASE}0`,
    'g'.repeat(40),
    40,
  ])
    await refused(gate([association(101, { base: { ref: 'main', sha } })]), noFullSha);
  await refused(gate([association(101, { base: { ref: 'main' } })]), noFullSha);
  await refused(gate([association(101, { base: { ref: 'release' } })]), unassociated);
  await refused(gate([association(101, { base: null })]), unassociated);
  // The PR's own base sha must be a full sha too: missing, null, short or malformed refuses.
  const prNoSha =
    /manual review needed: CI run not associated with this PR \(workflow run \d+ cannot be compared: this PR's base sha is missing or malformed\)/;
  await refused(gate([association()], { base: { ref: 'main' } }), prNoSha);
  for (const sha of [null, '', BASE.slice(0, 8), 'g'.repeat(40), ` ${BASE}`])
    await refused(gate([association()], { base: { ref: 'main', sha } }), prNoSha);
  // Case is normalized on both sides, then the full 40-hex shas must be equal.
  const upper = BASE.toUpperCase();
  await merged(gate([association(101, { base: { ref: 'main', sha: upper } })]));
  await merged(gate([association()], { base: { ref: 'main', sha: upper } }));
  await refused(
    gate([association(101, { base: { ref: 'main', sha: OLD.toUpperCase() } })]),
    /ran for #101 against base 'main' at bbbbbbbb, this PR's base is 'main' at ffffffff/,
  );
  // A run for a fork lists no pull request; a missing or unreadable list is no association.
  for (const listed of [[], undefined, null, {}, 'main'])
    await refused(
      gate(listed),
      /CI run not associated with this PR \(workflow run \d+ lists no pull request, as for a fork\)/,
    );
  // Several PRs: this one, with the matching base, must be among them.
  await merged(gate([association(102), association(101)]));
  await refused(gate([association(102), association(103)]), /ran for #102, #103, not #101/);
  await refused(
    gate([association(102), association(101, { base: { ref: 'release', sha: BASE } })]),
    /ran for #101 against base 'release'/,
  );
  // A PR whose base branch is unknown cannot be matched.
  await refused(gate([association()], { base: null }), /cannot be compared/);
  // Only the gate's own workflow run counts: the latest verify decides which run that is.
  const older = workflowRun(HEAD, { check_suite_id: 9100 });
  const olderVerify = run('verify', { check_suite: { id: 9100 } });
  await refused(
    pr({
      checkRuns: [olderVerify, ...green()],
      workflowRuns: [older, workflowRun(HEAD, { pull_requests: [] })],
    }),
    unassociated,
  );
  const unrelated = workflowRun(HEAD, { check_suite_id: 9100, pull_requests: [] });
  await merged(
    pr({
      checkRuns: [run('verify', { check_suite: { id: 9100 } }), ...green()],
      workflowRuns: [unrelated, workflowRun()],
    }),
  );
});

test('a source that cannot be identified fails closed', async () => {
  const lookup =
    (response: () => Response): Fail =>
    (url) =>
      url.pathname.endsWith('/actions/runs') ? response() : undefined;
  for (const [response, reason] of [
    [
      () => json({ message: 'Server Error' }, 500),
      /GitHub API: GET \/actions\/runs\?check_suite_id=9010: HTTP 500 Server Error/,
    ],
    [() => json({ message: 'Not Found' }, 404), /HTTP 404 Not Found/],
    [() => new Response('<html>busy</html>', { status: 200 }), /unreadable response/],
    [() => json({ workflow_runs: {} }), /check suite 9010: unexpected response/],
    [
      () => json({ total_count: 2, workflow_runs: [workflowRun()] }),
      /check suite 9010: unexpected response/,
    ],
  ] as const)
    await refused(pr(), reason, { fail: lookup(response) });
  const offline: Fail = (url) => {
    if (url.pathname.endsWith('/actions/runs')) throw new Error('getaddrinfo ENOTFOUND');
    return undefined;
  };
  await refused(pr(), /actions\/runs.*request failed \(getaddrinfo ENOTFOUND\)/, {
    fail: offline,
  });
  // No workflow run for the suite, one that belongs to another suite, or two for one suite.
  await refused(pr({ workflowRuns: [] }), /no workflow run found for check suite 9010/);
  const elsewhere = lookup(() =>
    json({ total_count: 1, workflow_runs: [workflowRun(HEAD, { check_suite_id: 1 })] }),
  );
  await refused(pr(), /no workflow run found for check suite 9010/, { fail: elsewhere });
  await refused(
    pr({ workflowRuns: [workflowRun(), workflowRun()] }),
    /check suite 9010 has 2 workflow runs, expected one/,
  );
  // A workflow run without a path, a check run without a check suite or without an app.
  await refused(
    pr({ workflowRuns: [workflowRun(HEAD, { path: '' })] }),
    /workflow run \d+ of check suite 9010 has no path/,
  );
  await refused(
    pr({ checkRuns: [...green(HEAD, ['verify']), run('verify', { check_suite: null })] }),
    /check run 'verify' has no check suite/,
  );
  await refused(
    pr({ checkRuns: [...green(), run('unit (2)', { check_suite: {} })] }),
    /check run 'unit \(2\)' has no check suite/,
  );
  await refused(
    pr({ checkRuns: [...green(), run('unit (2)', { app: null })] }),
    /check run 'unit \(2\)' has no app/,
  );
  // decide() without the workflow runs never passes.
  const item = pr();
  const unread = decide({
    pull: item.pull,
    expectedSha: HEAD,
    checkRuns: item.checkRuns,
    reviews: item.reviews,
    commits: item.commits,
  } as Parameters<typeof decide>[0]);
  assert.equal(unread.ok, false);
  assert.ok(unread.reasons.includes('workflow runs unread'));
  assert.ok(unread.reasons.includes('no workflow run found for check suite 9010'));
  // Too many check suites to look up: refused before any lookup.
  const spread = Array.from({ length: MAX_CHECK_SUITES + 1 }, (_, index) =>
    run(`matrix (${index})`, { check_suite: { id: 100 + index } }),
  );
  const many = await refused(
    pr({ checkRuns: [...green(), ...spread] }),
    new RegExp(`come from ${MAX_CHECK_SUITES + 2} check suites; at most ${MAX_CHECK_SUITES}`),
  );
  assert.ok(!many.calls.some((call) => call.url.pathname.endsWith('/actions/runs')));
});

test('a partial check list (early in CI, verify not created yet) refuses', async () => {
  await refused(pr({ checkRuns: [run('changes'), run('secrets')] }), /'verify' check is missing/);
  await refused(pr({ checkRuns: [] }), /no check runs on aaaaaaaa/);
});

test('a failed check other than verify refuses', async () => {
  const checkRuns = [
    ...green(HEAD, ['verify']),
    run('browser (1)', { conclusion: 'failure' }),
    run('verify'),
  ];
  await refused(pr({ checkRuns }), /checks not green: browser \(1\)=failure/);
  const cancelled = [run('unit (2)', { conclusion: 'cancelled' }), ...green()];
  await refused(pr({ checkRuns: cancelled }), /checks not green: unit \(2\)=cancelled/);
  const queued = [
    run('Vercel', { status: 'queued', conclusion: null, app: { slug: 'vercel' } }),
    ...green(),
  ];
  await refused(pr({ checkRuns: queued }), /checks not green: Vercel=queued/);
});

test('the latest run of each name decides: by started_at, then by id', async () => {
  // A failed run superseded by a later successful rerun passes.
  await merged(pr({ checkRuns: [run('unit (1)', { conclusion: 'failure' }), ...green()] }));
  // A successful run followed by a rerun still in progress refuses.
  const rerun = [...green(), run('unit (1)', { status: 'in_progress', conclusion: null })];
  await refused(pr({ checkRuns: rerun }), /checks not green: unit \(1\)=in_progress/);
  // Array order is not trusted: the rerun is listed first but started later.
  const reordered = [...green()].reverse();
  reordered.unshift(run('browser (1)', { conclusion: 'failure' }));
  reordered.push(run('browser (1)', { started_at: '2026-10-14T09:00:00.000Z' }));
  await refused(pr({ checkRuns: reordered }), /browser \(1\)=failure/);
  // Same start time: the higher id is the later run, whatever the list order.
  const tie = '2026-10-16T12:00:00.000Z';
  const tied = [
    ...green(),
    run('unit (1)', { id: 1_000_001, started_at: tie, conclusion: 'failure' }),
    run('unit (1)', { id: 1_000_000, started_at: tie, conclusion: 'success' }),
  ];
  await refused(pr({ checkRuns: tied }), /unit \(1\)=failure/);
  // A run without a start time cannot be ordered, so it refuses.
  await refused(
    pr({ checkRuns: [...green(), run('unit (3)', { started_at: null })] }),
    /has no name or start time/,
  );
  // A run for another commit in the list refuses.
  await refused(
    pr({ checkRuns: [...green(), run('extra', { head_sha: OLD })] }),
    /not for aaaaaaaa/,
  );
});

test('an approval of an older commit refuses', async () => {
  const reviews = [review(ALICE, 'APPROVED', { commit_id: OLD })];
  await refused(
    pr({ reviews }),
    /no non-author approval on aaaaaaaa \(approvals on other commits: reviewer-a@bbbbbbbb\)/,
  );
});

test('no approval refuses; comments are not approvals', async () => {
  await refused(pr({ reviews: [] }), /no non-author approval on aaaaaaaa/);
  await refused(pr({ reviews: [review(ALICE, 'COMMENTED')] }), /no non-author approval/);
  await refused(
    pr({ reviews: [review(ALICE, 'PENDING', { submitted_at: null })] }),
    /no non-author approval/,
  );
});

test("the author's own approval does not count", async () => {
  await refused(pr({ reviews: [review(AUTHOR, 'APPROVED')] }), /no non-author approval/);
  // Same account with a differently cased login, or the same id under a new login.
  const cased = review({ login: 'PR-Author', id: 99 }, 'APPROVED');
  await refused(pr({ reviews: [cased] }), /no non-author approval/);
  const renamed = review({ login: 'renamed-author', id: AUTHOR.id }, 'APPROVED');
  await refused(pr({ reviews: [renamed] }), /no non-author approval/);
});

test("an approver who pushed a commit to someone else's PR does not count", async () => {
  const own =
    /no non-author approval on aaaaaaaa \(approvals by an author do not count: reviewer-a\)/;
  // The head commit is the approver's, on a PR someone else opened.
  const head = [commit(AUTHOR, { sha: EARLIER }), commit(ALICE)];
  await refused(pr({ commits: head }), own);
  // An earlier commit of the approver's, under a later one of the opener's.
  const earlier = [commit(ALICE, { sha: EARLIER }), commit(AUTHOR)];
  await refused(pr({ commits: earlier }), own);
  // Committed (rebased or picked) by the approver, written by the opener.
  await refused(pr({ commits: [commit(AUTHOR, { committer: ALICE })] }), own);
  // Written by the approver, committed by the opener.
  await refused(pr({ commits: [commit(ALICE, { committer: AUTHOR })] }), own);
  // The same account under another login or case.
  const cased = [commit({ login: 'Reviewer-A', id: 77 })];
  await refused(pr({ commits: cased }), own);
  const renamed = [commit({ login: 'renamed-reviewer', id: ALICE.id })];
  await refused(pr({ commits: renamed }), own);
  // A reviewer who wrote nothing on the PR still counts, whoever else pushed to it.
  const third = await merged(pr({ commits: head, reviews: [review(BOB, 'APPROVED')] }));
  assert.equal(third.output, 'MERGED #101 @ aaaaaaaa (squash commit cccccccc)');
  // An approval by an author next to one from someone else: the other one counts.
  await merged(
    pr({ commits: head, reviews: [review(ALICE, 'APPROVED'), review(BOB, 'APPROVED')] }),
  );
  // The commit list is read: GET /pulls/101/commits, a page at a time.
  const commits = third.calls.filter((call) => call.url.pathname.endsWith('/commits'));
  assert.deepEqual(
    commits.map((call) => [call.url.pathname, call.url.searchParams.get('per_page')]),
    [[`/repos/${REPO}/pulls/101/commits`, String(PER_PAGE)]],
  );
});

test('the web-flow committer of a web commit is no author; an unknown author refuses', async () => {
  // A commit made in GitHub's web interface: written by the opener, committed by web-flow.
  await merged(pr({ commits: [commit(AUTHOR, { committer: WEB_FLOW })] }));
  // An author or committer whose email belongs to no GitHub account cannot be checked.
  await refused(
    pr({ commits: [commit(null, { committer: AUTHOR })] }),
    /commits whose author or committer is no GitHub account: aaaaaaaa \(author\)/,
  );
  await refused(
    pr({ commits: [commit(AUTHOR, { committer: null })] }),
    /commits whose author or committer is no GitHub account: aaaaaaaa \(committer\)/,
  );
  await refused(
    pr({ commits: [commit({ login: '' }, { sha: EARLIER }), commit(AUTHOR)] }),
    /no GitHub account: eeeeeeee \(author\), eeeeeeee \(committer\)(;|$)/m,
  );
  // A long list is cut short in the reason: four commits, eight unknown accounts.
  const many = Array.from({ length: 4 }, (_, index) =>
    commit(null, { sha: String(index + 1).repeat(40) }),
  );
  await refused(
    pr({ commits: [...many, commit(AUTHOR)] }),
    /no GitHub account: 11111111 \(author\), 11111111 \(committer\), 22222222 \(author\), 22222222 \(committer\), 33333333 \(author\) and 3 more/,
  );
});

test('the commit list must be complete and hold the expected head', async () => {
  // Fewer commits read than the PR has.
  await refused(pr({ pull: { commits: 2 } }), /read 1 of the PR's 2 commits/);
  await refused(pr({ pull: { commits: undefined } }), /PR commit count is unknown/);
  await refused(pr({ pull: { commits: 0 } }), /PR commit count is unknown/);
  // More than GitHub lists: the authors of the rest are unknown.
  const sha = (index: number) => index.toString(16).padStart(40, '0');
  const long = Array.from({ length: MAX_PR_COMMITS + 1 }, (_, index) =>
    commit(AUTHOR, { sha: index === MAX_PR_COMMITS ? HEAD : sha(index + 1) }),
  );
  await refused(
    pr({ commits: long }),
    /PR has 251 commits; GitHub lists at most 250, so their authors cannot all be read/,
  );
  // Exactly the cap is read in full, across three pages.
  const capped = await merged(pr({ commits: long.slice(1) }));
  assert.deepEqual(
    capped.calls
      .filter((call) => call.url.pathname.endsWith('/commits'))
      .map((call) => call.url.searchParams.get('page')),
    ['1', '2', '3'],
  );
  // An approver's commit on page 2 is seen.
  const page2 = [...long.slice(0, PER_PAGE + 1), commit(ALICE, { sha: sha(999) }), commit(AUTHOR)];
  await refused(pr({ commits: page2 }), /approvals by an author do not count: reviewer-a/);
  // A list without the expected head (the branch moved between the reads).
  await refused(
    pr({ commits: [commit(AUTHOR, { sha: OLD })] }),
    /the PR's commits do not include aaaaaaaa/,
  );
  // A sha seen twice means the list moved while it was read.
  const repeated = Array.from({ length: PER_PAGE }, (_, index) =>
    commit(AUTHOR, { sha: sha(index + 1) }),
  );
  await refused(
    pr({ commits: [...repeated, repeated[0]!, commit(AUTHOR)] }),
    /pulls\/101\/commits: incomplete pages \(repeated ids\)/,
  );
});

test('a dismissed approval refuses', async () => {
  // GitHub turns a dismissed review's state into DISMISSED.
  await refused(pr({ reviews: [review(ALICE, 'DISMISSED')] }), /no non-author approval/);
  const later = [review(ALICE, 'APPROVED'), review(ALICE, 'DISMISSED')];
  await refused(pr({ reviews: later }), /no non-author approval/);
  // A fresh approval after the dismissal counts again.
  await merged(pr({ reviews: [review(ALICE, 'DISMISSED'), review(ALICE, 'APPROVED')] }));
});

test('an approval followed by a change request from the same reviewer refuses', async () => {
  const reviews = [review(ALICE, 'APPROVED'), review(ALICE, 'CHANGES_REQUESTED')];
  const result = await refused(pr({ reviews }), /changes requested by reviewer-a/);
  assert.match(result.output, /no non-author approval/);
  // Later comments do not undo an approval or a change request.
  await merged(pr({ reviews: [review(ALICE, 'APPROVED'), review(ALICE, 'COMMENTED')] }));
  await merged(pr({ reviews: [review(ALICE, 'CHANGES_REQUESTED'), review(ALICE, 'APPROVED')] }));
});

test("another reviewer's change request refuses despite an approval", async () => {
  const reviews = [review(ALICE, 'APPROVED'), review(BOB, 'CHANGES_REQUESTED')];
  const result = await refused(pr({ reviews }), /changes requested by reviewer-b/);
  assert.doesNotMatch(result.output, /no non-author approval/);
  // Order does not matter: the change request is still the reviewer's latest decision.
  await refused(
    pr({ reviews: [review(BOB, 'CHANGES_REQUESTED'), review(ALICE, 'APPROVED')] }),
    /changes requested by reviewer-b/,
  );
});

test('a head that moved after the checks: merge answers 409, refused, not retried', async () => {
  const item = pr({
    merge: {
      status: 409,
      body: { message: 'Head branch was modified. Review and try the merge again.' },
    },
  });
  const result = await one(item);
  assert.equal(result.code, 2);
  assert.equal(result.merges.length, 1, 'exactly one merge attempt');
  assert.match(
    result.output,
    /^REFUSED #101 @ aaaaaaaa: merge answered HTTP 409: Head branch was modified\. .*; not retried$/,
  );
  // 405 (not mergeable) and a 200 that did not merge are refusals as well.
  for (const merge of [
    { status: 405, body: { message: 'Pull Request is not mergeable' } },
    { status: 200, body: { merged: false, message: 'not merged' } },
  ]) {
    const other = await one(pr({ merge }));
    assert.equal(other.code, 2);
    assert.equal(other.merges.length, 1);
  }
});

test('a head that differs from the expected sha refuses before any merge call', async () => {
  const item = pr({ pull: { head: { sha: OLD } } });
  await refused(item, /head is bbbbbbbb, expected aaaaaaaa/);
});

test('mergeable_state other than clean, a closed or a merged PR refuses', async () => {
  for (const state of ['blocked', 'unstable', 'dirty', 'behind', 'draft', 'unknown'])
    await refused(
      pr({ pull: { mergeable_state: state } }),
      new RegExp(`mergeable_state is '${state}'`),
    );
  await refused(pr({ pull: { mergeable_state: 'unknown' } }), /still computing it: run again/);
  await refused(pr({ pull: { state: 'closed' } }), /PR is closed/);
  await refused(pr({ pull: { state: 'closed', merged: true } }), /PR is already merged/);
  await refused(pr({ pull: { user: null } }), /PR author is unknown/);
});

test('an inherited SELF_MERGE (or any variant) has no effect', async () => {
  const saved = process.env.SELF_MERGE;
  try {
    for (const value of [HEAD, HEAD.slice(0, 8), '1', 'true']) {
      process.env.SELF_MERGE = value;
      const env = { GITHUB_TOKEN: TOKEN, SELF_MERGE: value };
      await refused(pr({ reviews: [] }), /no non-author approval/, { env });
      await refused(pr({ reviews: [review(AUTHOR, 'APPROVED')] }), /no non-author approval/, {
        env,
      });
    }
  } finally {
    if (saved === undefined) delete process.env.SELF_MERGE;
    else process.env.SELF_MERGE = saved;
  }
  // No code path reads such a variable.
  assert.doesNotMatch(readFileSync(script, 'utf8'), /SELF_MERGE|self.?merge/i);
});

test('any API error fails closed', async () => {
  const at =
    (pattern: RegExp, response: () => Response): Fail =>
    (url) =>
      pattern.test(url.pathname) ? response() : undefined;
  for (const [pattern, name] of [
    [/\/pulls\/101$/, 'pull'],
    [/\/check-runs$/, 'check runs'],
    [/\/reviews$/, 'reviews'],
    [/\/pulls\/101\/commits$/, 'commits'],
  ] as const) {
    for (const [response, reason] of [
      [() => json({ message: 'Server Error' }, 500), /GitHub API: GET .* HTTP 500 Server Error/],
      [() => json({ message: 'Bad credentials' }, 401), /HTTP 401 Bad credentials/],
      [() => json({ message: 'API rate limit exceeded' }, 403), /HTTP 403 API rate limit/],
      [() => new Response('<html>busy</html>', { status: 200 }), /unreadable response/],
      [() => json(null), /unreadable response/],
    ] as const) {
      const result = await refused(pr(), reason, { fail: at(pattern, response) });
      assert.ok(result.calls.length >= 1, name);
    }
  }
  // A network failure (fetch rejects) refuses too.
  const offline: Fail = (url) => {
    if (url.pathname.endsWith('/reviews')) throw new Error('getaddrinfo ENOTFOUND');
    return undefined;
  };
  await refused(pr(), /GitHub API: GET .*reviews.*request failed \(getaddrinfo ENOTFOUND\)/, {
    fail: offline,
  });
  // A merge call that fails in transit is reported as unknown, not retried.
  const lost: Fail = (url, method) => {
    if (method === 'PUT') throw new Error('socket hang up');
    return undefined;
  };
  const result = await one(pr(), [], { fail: lost });
  assert.equal(result.code, 2);
  assert.equal(result.merges.length, 1);
  assert.match(result.output, /merge request failed \(.*socket hang up.*\); check the PR/);
});

test('reviews and checks are read across pages: an approval on page 2 counts', async () => {
  const comments = Array.from({ length: PER_PAGE }, () => review(BOB, 'COMMENTED'));
  const filler = Array.from({ length: PER_PAGE }, (_, index) => run(`matrix (${index})`));
  const item = pr({
    reviews: [...comments, review(ALICE, 'APPROVED')],
    checkRuns: [...filler, ...green()],
  });
  const result = await merged(item);
  const pages = (suffix: string) =>
    result.calls
      .filter((call) => call.url.pathname.endsWith(suffix))
      .map((call) => call.url.searchParams.get('page'));
  assert.deepEqual(pages('/reviews'), ['1', '2']);
  assert.deepEqual(pages('/check-runs'), ['1', '2']);
  // Exactly a full page: the next (empty) page is read to be sure the list ended.
  const full = Array.from({ length: PER_PAGE - 1 }, () => review(BOB, 'COMMENTED'));
  const exact = await merged(pr({ reviews: [...full, review(ALICE, 'APPROVED')] }));
  assert.deepEqual(
    exact.calls
      .filter((call) => call.url.pathname.endsWith('/reviews'))
      .map((call) => call.url.searchParams.get('page')),
    ['1', '2'],
  );
  // And a failed check on page 2 is seen as well.
  const failing = pr({
    checkRuns: [...filler, ...green(), run('late', { conclusion: 'failure' })],
  });
  await refused(failing, /checks not green: late=failure/);
});

test('incomplete pages fail closed', async () => {
  // total_count says more runs exist than the pages returned.
  await refused(
    pr({ checkTotal: 8 }),
    /check runs for aaaaaaaa: incomplete pages \(read 7, total_count 8\)/,
  );
  // Page 2 of the reviews fails.
  const comments = Array.from({ length: PER_PAGE }, () => review(BOB, 'COMMENTED'));
  const page2: Fail = (url) =>
    url.pathname.endsWith('/reviews') && url.searchParams.get('page') === '2'
      ? json({ message: 'Server Error' }, 502)
      : undefined;
  await refused(pr({ reviews: [...comments, review(ALICE, 'APPROVED')] }), /HTTP 502/, {
    fail: page2,
  });
  // The list moved while it was read: page 2 repeats an item of page 1.
  const repeated = [...comments, comments[0]!, review(ALICE, 'APPROVED')];
  await refused(pr({ reviews: repeated }), /incomplete pages \(repeated ids\)/);
  // A page longer than requested is not trusted.
  const long: Fail = (url) =>
    url.pathname.endsWith('/reviews')
      ? json(Array.from({ length: PER_PAGE + 1 }, () => review(BOB, 'COMMENTED')))
      : undefined;
  await refused(pr(), /unexpected response/, { fail: long });
  // A page that is not a list is not trusted.
  const notList: Fail = (url) =>
    url.pathname.endsWith('/reviews') ? json({ reviews: [] }) : undefined;
  await refused(pr(), /unexpected response/, { fail: notList });
});

test('batch: every input is validated before the first is processed', async () => {
  const valid = pr();
  for (const argv of [
    [`101:${HEAD}`, '102:not-a-sha'],
    [`101:${HEAD}`, '102'],
    [`101:${HEAD}`, `102:${HEAD.slice(0, 8)}`],
    [`101:${HEAD}`, `101:${HEAD}`],
    [`101:${HEAD}`, `0:${HEAD}`],
    [`101:${HEAD}`, '--unknown'],
  ]) {
    const result = await guard([...argv, '--repo', REPO], [valid]);
    assert.equal(result.code, 2, argv.join(' '));
    assert.equal(result.calls.length, 0, `no request for ${argv.join(' ')}`);
    assert.match(result.output, /^REFUSED before any request: /);
  }
  const malformed = await guard([`101:${HEAD}`, '102:not-a-sha', '--repo', REPO], [valid]);
  assert.match(
    malformed.output,
    /malformed target "102:not-a-sha": expected <pr>:<40-character head sha>/,
  );
  const twice = await guard([`101:${HEAD}`, `101:${HEAD}`, '--repo', REPO], [valid]);
  assert.match(twice.output, /PR #101 is given twice/);
  const badRepo = await guard([`101:${HEAD}`, '--repo', '../other'], [valid]);
  assert.match(badRepo.output, /malformed repository/);
  assert.equal(badRepo.calls.length, 0);
});

test('batch: targets run in order and stop at the first refusal', async () => {
  const second = pr({}, 102, HEAD_2);
  const both = await guard([`101:${HEAD}`, `102:${HEAD_2}`, '--repo', REPO], [pr(), second]);
  assert.equal(both.code, 0);
  assert.deepEqual(
    both.merges.map((call) => [call.url.pathname.split('/')[5], call.body.sha]),
    [
      ['101', HEAD],
      ['102', HEAD_2],
    ],
  );
  const first = pr({ reviews: [] });
  const stopped = await guard([`101:${HEAD}`, `102:${HEAD_2}`, '--repo', REPO], [first, second]);
  assert.equal(stopped.code, 2);
  assert.equal(stopped.merges.length, 0);
  assert.ok(!stopped.calls.some((call) => call.url.pathname.includes('/pulls/102')));
  assert.match(stopped.output, /^SKIPPED #102 @ dddddddd: not attempted after a refusal$/m);
});

test('the expected sha is required', () => {
  assert.throws(() => parseTargets(['101']), /malformed target "101"/);
  assert.throws(() => parseTargets([]), /no target given/);
  assert.deepEqual(parseTargets([`101:${HEAD.toUpperCase()}`]), [{ pr: 101, sha: HEAD }]);
  // decide() without an expected sha never passes, even for a green, approved PR.
  const item = pr();
  const data = {
    pull: item.pull,
    checkRuns: item.checkRuns,
    workflowRuns: item.workflowRuns,
    reviews: item.reviews,
  };
  const decision = decide({ ...data, expectedSha: '', commits: item.commits });
  assert.equal(decision.ok, false);
  assert.ok(decision.reasons.includes('no expected head sha'));
  assert.equal(decide({ ...data, expectedSha: HEAD, commits: item.commits }).ok, true);
  // Without the commit list the authors are unknown, so it never passes either.
  const unread = decide({ ...data, expectedSha: HEAD } as Parameters<typeof decide>[0]);
  assert.equal(unread.ok, false);
  assert.ok(unread.reasons.includes('check runs, reviews or commits unread'));
});

function cli(path: string, argv: string[]) {
  return spawnSync(process.execPath, [path, ...argv], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, SELF_MERGE: HEAD },
    timeout: 30_000,
  });
}

test('the command line refuses without a sha before reading a token or the network', () => {
  for (const argv of [[], ['101'], ['101:abc']]) {
    const child = cli(script, argv);
    assert.equal(child.status, 2, child.stderr);
    assert.match(child.stdout, /^REFUSED before any request: /);
    assert.match(child.stdout, /usage: node scripts\/ops\/merge-guard\.mjs <pr>:<head-sha>/);
  }
});

test('run through a linked directory, the command line still decides (never a silent exit 0)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-guard-'));
  try {
    const linked = join(dir, 'ops');
    // A junction needs no privileges on Windows; elsewhere the type is ignored.
    symlinkSync(dirname(script), linked, 'junction');
    const child = cli(join(linked, 'merge-guard.mjs'), ['101']);
    assert.equal(child.status, 2, child.stderr);
    assert.match(child.stdout, /^REFUSED before any request: malformed target "101"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(isEntryPoint(script, script), true);
  assert.equal(isEntryPoint(undefined, script), false);
  assert.equal(isEntryPoint(join(dirname(script), 'missing.mjs'), script), false);
});
