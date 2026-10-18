#!/usr/bin/env node
/*
 * Merge guard: squash-merges a pull request only when the exact head you reviewed is green and
 * approved by someone who is not one of its authors. Read docs/OPERATIONS.md, "Merging a pull
 * request".
 *
 *   node scripts/ops/merge-guard.mjs <pr>:<head-sha> [<pr>:<head-sha> ...] [--repo owner/name] [--dry-run]
 *
 * Every rule must hold, or the pull request is refused with the reasons and the exit code is 2:
 *
 * - the PR head is the expected 40-character sha, the PR is open and mergeable_state is 'clean';
 * - check runs are grouped by name and source: the workflow file of their check suite's workflow
 *   run for GitHub Actions (looked up with GET /actions/runs?check_suite_id=), the app otherwise.
 *   In each group the latest run (by started_at, then id) on that sha is completed with success,
 *   skipped or neutral; a source that cannot be identified refuses;
 * - 'verify' must come from REQUIRED_WORKFLOW only: its latest run succeeded, and its workflow
 *   run is for the expected sha, was started by a pull_request event, completed with success and
 *   lists this PR with its base branch and full base sha among its pull_requests; a run
 *   that lists none (a fork) refuses for manual review. A 'verify' from any other workflow or app
 *   refuses, whatever its result (strict: two sources for the gate's name are ambiguous);
 * - the authors are whoever opened the PR and whoever wrote or committed any of its commits
 *   (GitHub's own web-flow committer aside); every commit's author and committer must be a
 *   GitHub account, the commit list must be complete (GitHub lists at most 250) and hold the
 *   expected head;
 * - per reviewer, the latest APPROVED, CHANGES_REQUESTED or DISMISSED review counts (COMMENTED
 *   is ignored): at least one reviewer who is not an author approved this exact head, and no
 *   reviewer's latest such review requests changes. There is no bypass for an author.
 *
 * Commit authorship is whatever the committer configured, so the author rule stops honest
 * mistakes, not a forged identity.
 *
 * Any API error, non-2xx answer or incomplete page list refuses (fail closed). The merge call
 * sends the expected sha, so a head that moves after the checks makes GitHub answer 409; that
 * is a refusal and is never retried. All targets are validated before the first is processed,
 * and a batch stops at its first refusal. The token comes from GITHUB_TOKEN, otherwise from
 * `git credential fill` for github.com. No dependencies.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const API_BASE = 'https://api.github.com';
export const REQUIRED_CHECK = 'verify';
export const REQUIRED_CHECK_APP = 'github-actions';
/** The only workflow whose 'verify' job is the gate, and the event its pull request runs use. */
export const REQUIRED_WORKFLOW = '.github/workflows/check.yml';
export const REQUIRED_EVENT = 'pull_request';
/** The refusal when the gate's workflow run cannot be shown to have run for this pull request. */
export const UNASSOCIATED = 'manual review needed: CI run not associated with this PR';
/** At most this many GitHub Actions check suites (one lookup each) are identified per head. */
export const MAX_CHECK_SUITES = 20;
export const PASSING_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);
export const DECISIVE_REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);
export const PER_PAGE = 100;
export const MAX_PAGES = 50;
/** GET /pulls/{n}/commits lists at most this many commits; a longer PR cannot be checked. */
export const MAX_PR_COMMITS = 250;
/** The committer of commits made in GitHub's web interface; it never wrote the change. */
export const WEB_COMMITTER = 'web-flow';
export const USAGE =
  'usage: node scripts/ops/merge-guard.mjs <pr>:<head-sha> [<pr>:<head-sha> ...] [--repo owner/name] [--dry-run]';

const TARGET = /^([1-9]\d{0,8}):([0-9a-fA-F]{40})$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.\.?$)[A-Za-z0-9_.-]+$/;
const short = (sha) => (typeof sha === 'string' && sha ? sha.slice(0, 8) : '(none)');
const shown = (value) => JSON.stringify(String(value).slice(0, 80));
const time = (value) => (typeof value === 'string' ? Date.parse(value) : Number.NaN);
/** A full 40-character hex sha in lower case, or null for anything else. */
const fullSha = (value) =>
  typeof value === 'string' && /^[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : null;
const oneLine = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

/**
 * Validates every `<pr>:<sha>` argument before any is processed. Throws one error naming each
 * malformed or repeated target.
 */
export function parseTargets(values) {
  const problems = [];
  const targets = [];
  const seen = new Set();
  if (!values.length) problems.push('no target given: pass <pr>:<expected head sha>');
  for (const value of values) {
    const match = TARGET.exec(value);
    if (!match) {
      problems.push(`malformed target ${shown(value)}: expected <pr>:<40-character head sha>`);
      continue;
    }
    const pr = Number(match[1]);
    if (seen.has(pr)) {
      problems.push(`PR #${pr} is given twice`);
      continue;
    }
    seen.add(pr);
    targets.push({ pr, sha: match[2].toLowerCase() });
  }
  if (problems.length) throw new Error(problems.join('; '));
  return targets;
}

/** `{ targets, repo, dryRun }` from the command line; throws on anything unexpected. */
export function parseArgs(argv) {
  const values = [];
  const problems = [];
  let repo;
  let dryRun = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--repo') {
      repo = argv[++index];
      if (repo === undefined) problems.push('--repo needs owner/name');
    } else if (arg.startsWith('--repo=')) repo = arg.slice('--repo='.length);
    else if (arg.startsWith('-')) problems.push(`unknown option ${shown(arg)}`);
    else values.push(arg);
  }
  if (repo !== undefined && !REPO.test(repo))
    problems.push(`malformed repository ${shown(repo)}: expected owner/name`);
  let targets = [];
  try {
    targets = parseTargets(values);
  } catch (error) {
    problems.push(error.message);
  }
  if (problems.length) throw new Error(problems.join('; '));
  return { targets, repo, dryRun };
}

/** The distinct check suite ids of the GitHub Actions check runs, whose workflow runs are read. */
export function actionsCheckSuites(runs) {
  const suites = new Set();
  for (const run of runs)
    if (run?.app?.slug === REQUIRED_CHECK_APP && Number.isSafeInteger(run.check_suite?.id))
      suites.add(run.check_suite.id);
  return [...suites];
}

/**
 * Where a check run comes from: `{ key, label, workflow?, problem? }`. A GitHub Actions run is
 * identified by the workflow run of its check suite (`workflowRuns` indexed by check_suite_id),
 * any other app by its slug. A run whose source is unknown (no check suite, no app, no single
 * workflow run for its suite, a workflow run without a path) carries a problem, so it refuses.
 */
export function checkSource(run, workflowRuns) {
  const suite = run?.check_suite?.id;
  const app = run?.app?.slug;
  const named = `check run '${run?.name}'`;
  if (typeof app !== 'string' || !app)
    return { key: 'app:', label: 'an unknown app', problem: `${named} has no app` };
  if (!Number.isSafeInteger(suite))
    return {
      key: `app:${app}`,
      label: `app '${app}' without a check suite`,
      problem: `${named} has no check suite`,
    };
  if (app !== REQUIRED_CHECK_APP) return { key: `app:${app}`, label: `app '${app}'` };
  const unknown = (problem) => ({
    key: `suite:${suite}`,
    label: `check suite ${suite} (workflow unknown)`,
    problem,
  });
  const found = workflowRuns.get(suite) ?? [];
  if (found.length !== 1)
    return unknown(
      found.length
        ? `check suite ${suite} has ${found.length} workflow runs, expected one`
        : `no workflow run found for check suite ${suite}`,
    );
  const [workflow] = found;
  if (typeof workflow?.path !== 'string' || !workflow.path)
    return unknown(`workflow run ${workflow?.id ?? '?'} of check suite ${suite} has no path`);
  return { key: `workflow:${workflow.path}`, label: `workflow '${workflow.path}'`, workflow };
}

/**
 * Whether a workflow run ran for this pull request, not only for its head: a pull_request run
 * tests a merge with the base and may use the PR's own data, so a green run on the same head for
 * another PR or another base proves nothing here. Its pull_requests list must hold an entry with
 * this PR's number, base branch and base sha. Both base shas must be full 40-character hex shas
 * (compared without regard to case); a missing, short or malformed one on either side is no
 * match. Returns null when it does, otherwise the refusal. A run that lists no pull request (a
 * run for a fork lists none) or whose association cannot be checked is never taken as associated.
 */
export function pullRequestAssociation(workflow, pull) {
  const refuse = (detail) => `${UNASSOCIATED} (workflow run ${workflow?.id ?? '?'} ${detail})`;
  const number = pull?.number;
  const ref = pull?.base?.ref;
  const sha = fullSha(pull?.base?.sha);
  if (!Number.isSafeInteger(number) || typeof ref !== 'string' || !ref)
    return refuse('cannot be compared: the PR number or base branch is unknown');
  if (!sha) return refuse("cannot be compared: this PR's base sha is missing or malformed");
  const listed = workflow?.pull_requests;
  if (!Array.isArray(listed) || !listed.length)
    return refuse('lists no pull request, as for a fork');
  const same = listed.filter((entry) => entry?.number === number);
  if (!same.length) {
    const numbers = listed.slice(0, 5).map((entry) => `#${entry?.number ?? '?'}`);
    const more = listed.length > 5 ? ` and ${listed.length - 5} more` : '';
    return refuse(`ran for ${numbers.join(', ')}${more}, not #${number}`);
  }
  const sameBase = (entry) => entry.base?.ref === ref && fullSha(entry.base?.sha) === sha;
  if (same.some(sameBase)) return null;
  const [entry] = same;
  const entrySha = fullSha(entry.base?.sha);
  return refuse(
    `ran for #${number} against base '${entry.base?.ref ?? 'unknown'}' at ` +
      `${entrySha ? short(entrySha) : 'no full sha'}, this PR's base is '${ref}' at ${short(sha)}`,
  );
}

/**
 * The latest run per check name and source (see checkSource), by started_at and then id, as
 * `{ run, source }`. Runs of one workflow across several of its workflow runs share a group, so
 * a rerun supersedes; the same name from another workflow or app is a group of its own and
 * cannot hide or replace it. A run without a name, a start time or an id makes the order
 * unknowable, and a run of unknown source cannot be grouped: both are problems, never guesses.
 */
export function latestCheckRuns(runs, workflowRuns = []) {
  const bySuite = new Map();
  for (const workflow of Array.isArray(workflowRuns) ? workflowRuns : []) {
    const suite = workflow?.check_suite_id;
    if (Number.isSafeInteger(suite)) bySuite.set(suite, [...(bySuite.get(suite) ?? []), workflow]);
  }
  const latest = new Map();
  const problems = new Set();
  for (const run of runs) {
    const started = time(run?.started_at);
    if (typeof run?.name !== 'string' || !run.name || !Number.isFinite(started)) {
      problems.add(`check run ${run?.id ?? '?'} has no name or start time`);
      continue;
    }
    if (!Number.isSafeInteger(run.id)) {
      problems.add(`check run '${run.name}' has no id`);
      continue;
    }
    const source = checkSource(run, bySuite);
    if (source.problem) problems.add(source.problem);
    const group = `${source.key}\n${run.name}`;
    const seen = latest.get(group)?.run;
    const seenStarted = seen ? time(seen.started_at) : -Infinity;
    if (!seen || started > seenStarted || (started === seenStarted && run.id > seen.id))
      latest.set(group, { run, source });
  }
  return { latest, problems: [...problems] };
}

/**
 * Each reviewer's latest APPROVED, CHANGES_REQUESTED or DISMISSED review (by submitted_at, then
 * id), keyed by lower-case login. COMMENTED and PENDING reviews do not count.
 */
export function latestDecisiveReviews(reviews) {
  const latest = new Map();
  const problems = [];
  for (const review of reviews) {
    if (!DECISIVE_REVIEW_STATES.has(review?.state)) continue;
    const login = review.user?.login;
    const submitted = time(review.submitted_at);
    if (typeof login !== 'string' || !login || !Number.isFinite(submitted)) {
      problems.push(`${review.state} review ${review.id ?? '?'} has no reviewer or time`);
      continue;
    }
    if (!Number.isSafeInteger(review.id)) {
      problems.push(`${review.state} review by ${login} has no id`);
      continue;
    }
    const key = login.toLowerCase();
    const seen = latest.get(key);
    const seenSubmitted = seen ? time(seen.submitted_at) : -Infinity;
    if (!seen || submitted > seenSubmitted || (submitted === seenSubmitted && review.id > seen.id))
      latest.set(key, review);
  }
  return { latest, problems };
}

/**
 * The authors of a pull request: whoever opened it and whoever wrote or committed any of its
 * commits (the web-flow committer of a commit made in GitHub's web interface aside). Whatever
 * leaves an author unknown is a problem: an opener, commit author or committer without a GitHub
 * account, a commit list shorter or longer than the PR's commit count (GitHub lists at most
 * MAX_PR_COMMITS), or one without the expected head.
 */
export function pullRequestAuthors(pull, commits, expectedSha) {
  const authors = [];
  const problems = [];
  const opener = pull?.user;
  if (typeof opener?.login === 'string' && opener.login) authors.push(opener);
  else problems.push('PR author is unknown');
  const count = pull?.commits;
  if (!Number.isSafeInteger(count) || count < 1) problems.push('PR commit count is unknown');
  else if (count > MAX_PR_COMMITS)
    problems.push(
      `PR has ${count} commits; GitHub lists at most ${MAX_PR_COMMITS}, so their authors cannot all be read`,
    );
  else if (commits.length !== count)
    problems.push(`read ${commits.length} of the PR's ${count} commits`);
  if (!commits.some((commit) => commit?.sha === expectedSha))
    problems.push(`the PR's commits do not include ${short(expectedSha)}`);
  const unlinked = [];
  for (const commit of commits) {
    for (const role of ['author', 'committer']) {
      const user = commit?.[role];
      if (typeof user?.login !== 'string' || !user.login)
        unlinked.push(`${short(commit?.sha)} (${role})`);
      else if (role === 'author' || user.login.toLowerCase() !== WEB_COMMITTER) authors.push(user);
    }
  }
  if (unlinked.length) {
    const more = unlinked.length > 5 ? ` and ${unlinked.length - 5} more` : '';
    problems.push(
      `commits whose author or committer is no GitHub account: ${unlinked.slice(0, 5).join(', ')}${more}`,
    );
  }
  return { authors, problems };
}

/**
 * The decision, from data only: `{ ok, reasons }`. `ok` is true only when every rule holds;
 * otherwise `reasons` names each rule that failed.
 */
export function decide({
  pull,
  expectedSha,
  checkRuns: runs,
  workflowRuns,
  reviews: given,
  commits: listed,
}) {
  const reasons = [];
  if (!Array.isArray(runs) || !Array.isArray(given) || !Array.isArray(listed))
    reasons.push('check runs, reviews or commits unread');
  if (!Array.isArray(workflowRuns)) reasons.push('workflow runs unread');
  const checkRuns = Array.isArray(runs) ? runs : [];
  const reviews = Array.isArray(given) ? given : [];
  const commits = Array.isArray(listed) ? listed : [];
  const head = pull?.head?.sha;
  if (typeof expectedSha !== 'string' || !/^[0-9a-f]{40}$/.test(expectedSha))
    reasons.push('no expected head sha');
  else if (head !== expectedSha)
    reasons.push(`head is ${short(head)}, expected ${short(expectedSha)}`);
  if (pull?.merged === true) reasons.push('PR is already merged');
  else if (pull?.state !== 'open') reasons.push(`PR is ${pull?.state ?? 'in an unknown state'}`);
  if (pull?.mergeable_state !== 'clean')
    reasons.push(
      `mergeable_state is '${pull?.mergeable_state ?? 'missing'}', need 'clean'` +
        (pull?.mergeable_state === 'unknown' ? ' (GitHub is still computing it: run again)' : ''),
    );

  // Checks: the latest run of every name and source must be green, and verify must be the real
  // gate: the job of REQUIRED_WORKFLOW, not a check that only shares its name.
  const checks = latestCheckRuns(checkRuns, workflowRuns);
  reasons.push(...checks.problems);
  const foreign = checkRuns.filter((run) => run?.head_sha !== expectedSha);
  if (foreign.length)
    reasons.push(`${foreign.length} check run(s) are not for ${short(expectedSha)}`);
  if (!checks.latest.size && !checks.problems.length)
    reasons.push(`no check runs on ${short(expectedSha)}`);
  const groups = [...checks.latest.values()];
  const shownName = ({ run, source }) =>
    source.key.startsWith('app:') || source.workflow?.path === REQUIRED_WORKFLOW
      ? run.name
      : `${run.name} (${source.label})`;
  const notGreen = groups.filter(
    ({ run }) => run.status !== 'completed' || !PASSING_CONCLUSIONS.has(run.conclusion),
  );
  if (notGreen.length)
    reasons.push(
      'checks not green: ' +
        notGreen
          .map(
            (group) =>
              `${shownName(group)}=${group.run.status === 'completed' ? group.run.conclusion : group.run.status}`,
          )
          .join(', '),
    );
  const named = groups.filter(({ run }) => run.name === REQUIRED_CHECK);
  const gate = named.find(({ source }) => source.workflow?.path === REQUIRED_WORKFLOW);
  // Strict: any other source of a check named like the gate refuses, whatever its result.
  for (const { run, source } of named) {
    if (source.workflow?.path === REQUIRED_WORKFLOW) continue;
    if (run.app?.slug !== REQUIRED_CHECK_APP)
      reasons.push(
        `latest '${REQUIRED_CHECK}' comes from app '${run.app?.slug || 'unknown'}', ` +
          `expected '${REQUIRED_CHECK_APP}'`,
      );
    else
      reasons.push(
        `a '${REQUIRED_CHECK}' check comes from ${source.label}, not '${REQUIRED_WORKFLOW}': ` +
          'two sources make the gate ambiguous (rename the other job)',
      );
  }
  if (!named.length) reasons.push(`'${REQUIRED_CHECK}' check is missing on ${short(expectedSha)}`);
  else if (!gate)
    reasons.push(
      `no '${REQUIRED_CHECK}' check from '${REQUIRED_WORKFLOW}' on ${short(expectedSha)}`,
    );
  else {
    const { run: verify, source } = gate;
    const workflow = source.workflow;
    const at = `'${REQUIRED_CHECK}' workflow run ${workflow.id ?? '?'}`;
    if (verify.status !== 'completed' || verify.conclusion !== 'success')
      reasons.push(
        `'${REQUIRED_CHECK}' is ${verify.status === 'completed' ? verify.conclusion : verify.status}, need success`,
      );
    if (workflow.head_sha !== expectedSha)
      reasons.push(`${at} is for ${short(workflow.head_sha)}, expected ${short(expectedSha)}`);
    if (workflow.event !== REQUIRED_EVENT)
      reasons.push(
        `${at} was started by '${workflow.event ?? 'unknown'}', need '${REQUIRED_EVENT}'`,
      );
    if (workflow.status !== 'completed' || workflow.conclusion !== 'success')
      reasons.push(
        `${at} is ${workflow.status === 'completed' ? workflow.conclusion : (workflow.status ?? 'in an unknown state')}, ` +
          'need completed with success',
      );
    const association = pullRequestAssociation(workflow, pull);
    if (association) reasons.push(association);
  }

  // Reviews: an approval of this exact head by someone who opened none of it and wrote or
  // committed none of its commits, and no outstanding change request.
  const owners = pullRequestAuthors(pull, commits, expectedSha);
  reasons.push(...owners.problems);
  const authorLogins = new Set(owners.authors.map((user) => user.login.toLowerCase()));
  const authorIds = new Set(owners.authors.map((user) => user.id).filter(Number.isSafeInteger));
  const isAuthor = (user) =>
    (typeof user?.login === 'string' && authorLogins.has(user.login.toLowerCase())) ||
    (Number.isSafeInteger(user?.id) && authorIds.has(user.id));
  const decisive = latestDecisiveReviews(reviews);
  reasons.push(...decisive.problems);
  const latest = [...decisive.latest.values()];
  const blocking = latest.filter((review) => review.state === 'CHANGES_REQUESTED');
  if (blocking.length)
    reasons.push(`changes requested by ${blocking.map((review) => review.user.login).join(', ')}`);
  const approvals = latest.filter((review) => review.state === 'APPROVED');
  const counted = approvals.filter((review) => !isAuthor(review.user));
  if (!counted.some((review) => review.commit_id === expectedSha)) {
    const stale = counted.map((review) => `${review.user.login}@${short(review.commit_id)}`);
    const own = approvals.filter((review) => isAuthor(review.user));
    reasons.push(
      `no non-author approval on ${short(expectedSha)}` +
        (stale.length ? ` (approvals on other commits: ${stale.join(', ')})` : '') +
        (own.length
          ? ` (approvals by an author do not count: ${own.map((review) => review.user.login).join(', ')})`
          : ''),
    );
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * A minimal GitHub REST client over an injected fetch. Every non-2xx answer, unreadable body or
 * incomplete page list throws. Lists are read page by page (per_page=100) until a short page;
 * check runs must also add up to their total_count, and an id (a sha, for commits) seen twice
 * means the list moved while it was read. Whether the commits add up to the PR's commit count is
 * part of the decision.
 */
export function createGitHub({ fetch: fetcher, token, repo, apiBase = API_BASE }) {
  if (typeof fetcher !== 'function') throw new Error('no fetch implementation');
  if (typeof token !== 'string' || !token) throw new Error('no GitHub token');
  if (!REPO.test(repo ?? '')) throw new Error(`malformed repository ${shown(repo)}`);
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'user-agent': 'merge-guard',
    'x-github-api-version': '2022-11-28',
  };

  async function call(method, path, body) {
    let response;
    try {
      response = await fetcher(`${apiBase}/repos/${repo}${path}`, {
        method,
        headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new Error(`${method} ${path}: request failed (${oneLine(error?.message ?? error)})`);
    }
    let data = null;
    try {
      const text = await response.text();
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { status: response.status, ok: response.ok, data };
  }

  async function get(path) {
    const answer = await call('GET', path);
    if (!answer.ok)
      throw new Error(`GET ${path}: HTTP ${answer.status} ${oneLine(answer.data?.message)}`.trim());
    if (answer.data === null || typeof answer.data !== 'object')
      throw new Error(`GET ${path}: unreadable response`);
    return answer.data;
  }

  async function list(path, pick, key = (item) => item?.id) {
    const items = [];
    const pages = [];
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) throw new Error(`${path}: more than ${MAX_PAGES} pages`);
      const data = await get(
        `${path}${path.includes('?') ? '&' : '?'}per_page=${PER_PAGE}&page=${page}`,
      );
      const batch = pick(data);
      if (!Array.isArray(batch) || batch.length > PER_PAGE)
        throw new Error(`${path} page ${page}: unexpected response`);
      items.push(...batch);
      pages.push(data);
      if (batch.length < PER_PAGE) break;
    }
    if (new Set(items.map(key)).size !== items.length)
      throw new Error(`${path}: incomplete pages (repeated ids)`);
    return { items, pages };
  }

  return {
    async pull(pr) {
      return get(`/pulls/${pr}`);
    },
    async checkRuns(sha) {
      const { items, pages } = await list(
        `/commits/${sha}/check-runs?filter=all`,
        (data) => data.check_runs,
      );
      const totals = new Set(pages.map((page) => page.total_count));
      if (totals.size !== 1 || !totals.has(items.length))
        throw new Error(
          `check runs for ${short(sha)}: incomplete pages (read ${items.length}, ` +
            `total_count ${[...totals].join('/')})`,
        );
      return items;
    },
    async workflowRuns(suite) {
      if (!Number.isSafeInteger(suite)) throw new Error(`malformed check suite id ${shown(suite)}`);
      const data = await get(`/actions/runs?check_suite_id=${suite}`);
      const runs = data.workflow_runs;
      if (!Array.isArray(runs) || data.total_count !== runs.length)
        throw new Error(`workflow runs of check suite ${suite}: unexpected response`);
      return runs;
    },
    async reviews(pr) {
      return (await list(`/pulls/${pr}/reviews`, (data) => data)).items;
    },
    async commits(pr) {
      const read = await list(
        `/pulls/${pr}/commits`,
        (data) => data,
        (item) => item?.sha,
      );
      return read.items;
    },
    async merge(pr, sha) {
      return call('PUT', `/pulls/${pr}/merge`, { merge_method: 'squash', sha });
    },
  };
}

/**
 * Reads, decides and (unless dryRun) merges one target. Returns
 * `{ pr, sha, status: 'merged' | 'passed' | 'refused', reasons, mergeSha? }`; never throws.
 */
export async function guardPullRequest(github, { pr, sha }, { dryRun = false } = {}) {
  const refused = (reasons) => ({ pr, sha, status: 'refused', reasons });
  let pull;
  let checkRuns;
  const workflowRuns = [];
  let reviews;
  let commits;
  try {
    pull = await github.pull(pr);
    checkRuns = await github.checkRuns(sha);
    // The workflow run behind each GitHub Actions check suite: which workflow file it ran.
    const suites = actionsCheckSuites(checkRuns);
    if (suites.length > MAX_CHECK_SUITES)
      return refused([
        `check runs come from ${suites.length} check suites; at most ${MAX_CHECK_SUITES} are looked up`,
      ]);
    for (const suite of suites) workflowRuns.push(...(await github.workflowRuns(suite)));
    reviews = await github.reviews(pr);
    commits = await github.commits(pr);
  } catch (error) {
    return refused([`GitHub API: ${oneLine(error?.message ?? error)}`]);
  }
  const decision = decide({ pull, expectedSha: sha, checkRuns, workflowRuns, reviews, commits });
  if (!decision.ok) return refused(decision.reasons);
  if (dryRun) return { pr, sha, status: 'passed', reasons: [] };
  let answer;
  try {
    answer = await github.merge(pr, sha);
  } catch (error) {
    return refused([
      `merge request failed (${oneLine(error?.message ?? error)}); check the PR before running again`,
    ]);
  }
  if (answer.status !== 200 || answer.data?.merged !== true)
    return refused([
      `merge answered HTTP ${answer.status}: ${oneLine(answer.data?.message) || 'not merged'}; not retried`,
    ]);
  return { pr, sha, status: 'merged', reasons: [], mergeSha: answer.data.sha };
}

export function formatResult(result) {
  const at = `#${result.pr} @ ${short(result.sha)}`;
  if (result.status === 'merged') return `MERGED ${at} (squash commit ${short(result.mergeSha)})`;
  if (result.status === 'passed') return `PASSED ${at} (dry run: not merged)`;
  return `${result.status === 'skipped' ? 'SKIPPED' : 'REFUSED'} ${at}: ${result.reasons.join('; ')}`;
}

/** Processes the targets in order and stops at the first refusal. */
export async function runBatch(github, targets, { dryRun = false, log = console.log } = {}) {
  const results = [];
  for (const [index, target] of targets.entries()) {
    const result = await guardPullRequest(github, target, { dryRun });
    results.push(result);
    log(formatResult(result));
    if (result.status !== 'refused') continue;
    for (const rest of targets.slice(index + 1)) {
      const skipped = { ...rest, status: 'skipped', reasons: ['not attempted after a refusal'] };
      results.push(skipped);
      log(formatResult(skipped));
    }
    break;
  }
  return results;
}

/** `{ repo, username }` from the origin remote of the current checkout, or null. */
export function readOrigin() {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
    })
      .toString()
      .trim();
    const match =
      /^(?:https:\/\/(?:([^@/:]+)@)?github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(
        url,
      );
    return match && REPO.test(match[2]) ? { repo: match[2], username: match[1] } : null;
  } catch {
    return null;
  }
}

/** The github.com password from the git credential helper; never prompts. */
export function gitCredential(username) {
  const input = `protocol=https\nhost=github.com\n${username ? `username=${username}\n` : ''}\n`;
  const output = execFileSync('git', ['credential', 'fill'], {
    input,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    stdio: ['pipe', 'pipe', 'ignore'],
    timeout: 15_000,
  }).toString();
  const password = /^password=(.+)$/m.exec(output)?.[1]?.trim();
  if (!password) throw new Error('git credential fill gave no password for github.com');
  return password;
}

/**
 * The CLI. Returns the exit code: 0 when every target merged (or passed, with --dry-run),
 * 2 for any refusal. `env` is consulted for GITHUB_TOKEN only.
 */
export async function main(
  argv,
  {
    env = {},
    fetch: fetcher = globalThis.fetch,
    origin = readOrigin,
    credential = gitCredential,
    log = console.log,
  } = {},
) {
  try {
    let options;
    try {
      options = parseArgs(argv);
    } catch (error) {
      log(`REFUSED before any request: ${error.message}`);
      log(USAGE);
      return 2;
    }
    const remote = options.repo ? null : origin();
    const repo = options.repo ?? remote?.repo;
    if (!repo) {
      log('REFUSED before any request: no --repo and no github.com origin remote');
      return 2;
    }
    let token = typeof env.GITHUB_TOKEN === 'string' ? env.GITHUB_TOKEN.trim() : '';
    if (!token) {
      try {
        token = credential(remote?.username);
      } catch (error) {
        log(`REFUSED before any request: no token (${oneLine(error?.message ?? error)})`);
        return 2;
      }
    }
    const github = createGitHub({ fetch: fetcher, token, repo });
    const results = await runBatch(github, options.targets, { dryRun: options.dryRun, log });
    return results.every((result) => result.status === 'merged' || result.status === 'passed')
      ? 0
      : 2;
  } catch (error) {
    log(`REFUSED: unexpected error (${oneLine(error?.message ?? error)})`);
    return 2;
  }
}

/**
 * Whether `entry` (process.argv[1]) is this file. Real paths are compared, so a run through a
 * symlink or junction still runs the CLI instead of silently exiting 0 without a decision.
 */
export function isEntryPoint(entry, self = fileURLToPath(import.meta.url)) {
  if (typeof entry !== 'string' || !entry) return false;
  try {
    const same = (path) => {
      const real = realpathSync(path);
      return process.platform === 'win32' ? real.toLowerCase() : real;
    };
    return same(entry) === same(self);
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2), { env: process.env });
}
