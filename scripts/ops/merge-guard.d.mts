export interface MergeTarget {
  pr: number;
  sha: string;
}

export interface GuardResult extends MergeTarget {
  status: 'merged' | 'passed' | 'refused' | 'skipped';
  reasons: string[];
  mergeSha?: string;
}

export interface Decision {
  ok: boolean;
  reasons: string[];
}

export interface GitHubClient {
  pull(pr: number): Promise<any>;
  checkRuns(sha: string): Promise<any[]>;
  workflowRuns(checkSuiteId: number): Promise<any[]>;
  reviews(pr: number): Promise<any[]>;
  commits(pr: number): Promise<any[]>;
  merge(pr: number, sha: string): Promise<{ status: number; ok: boolean; data: any }>;
}

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export const API_BASE: string;
export const REQUIRED_CHECK: string;
export const REQUIRED_CHECK_APP: string;
export const REQUIRED_WORKFLOW: string;
export const REQUIRED_EVENT: string;
export const UNASSOCIATED: string;
export const MAX_CHECK_SUITES: number;
export const PASSING_CONCLUSIONS: Set<string>;
export const DECISIVE_REVIEW_STATES: Set<string>;
export const PER_PAGE: number;
export const MAX_PAGES: number;
export const MAX_PR_COMMITS: number;
export const WEB_COMMITTER: string;
export const USAGE: string;

export function parseTargets(values: string[]): MergeTarget[];
export function parseArgs(argv: string[]): {
  targets: MergeTarget[];
  repo: string | undefined;
  dryRun: boolean;
};
export interface CheckSource {
  key: string;
  label: string;
  workflow?: any;
  problem?: string;
}
export function actionsCheckSuites(runs: any[]): number[];
export function pullRequestAssociation(workflow: any, pull: any): string | null;
export function checkSource(run: any, workflowRuns: Map<number, any[]>): CheckSource;
export function latestCheckRuns(
  runs: any[],
  workflowRuns?: any[],
): { latest: Map<string, { run: any; source: CheckSource }>; problems: string[] };
export function latestDecisiveReviews(reviews: any[]): {
  latest: Map<string, any>;
  problems: string[];
};
export function pullRequestAuthors(
  pull: any,
  commits: any[],
  expectedSha: string,
): { authors: Array<{ login: string; id?: number }>; problems: string[] };
export function decide(input: {
  pull: any;
  expectedSha: string;
  checkRuns: any[];
  workflowRuns: any[];
  reviews: any[];
  commits: any[];
}): Decision;
export function createGitHub(options: {
  fetch: Fetcher;
  token: string;
  repo: string;
  apiBase?: string;
}): GitHubClient;
export function guardPullRequest(
  github: GitHubClient,
  target: MergeTarget,
  options?: { dryRun?: boolean },
): Promise<GuardResult>;
export function formatResult(result: GuardResult): string;
export function runBatch(
  github: GitHubClient,
  targets: MergeTarget[],
  options?: { dryRun?: boolean; log?: (line: string) => void },
): Promise<GuardResult[]>;
export function readOrigin(): { repo: string; username: string | undefined } | null;
export function gitCredential(username?: string): string;
export function isEntryPoint(entry: string | undefined, self?: string): boolean;
export function main(
  argv: string[],
  options?: {
    env?: Record<string, string | undefined>;
    fetch?: Fetcher;
    origin?: () => { repo: string; username?: string } | null;
    credential?: (username?: string) => string;
    log?: (line: string) => void;
  },
): Promise<number>;
