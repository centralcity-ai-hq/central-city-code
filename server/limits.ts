/**
 * Capacity bounds for one deployment. Defaults are the current reviewed bounds; later
 * tiers may raise them through environment overrides without code changes.
 */
export interface CityLimits {
  /**
   * Owner accounts per deployment: 0 (the default) means no ceiling. A positive value is an
   * emergency brake on new sign-ups (soft: checked without a lock, so concurrent sign-ups can
   * overshoot it slightly). Per-address sign-up budgets are `registrationsPerWindow`.
   */
  operators: number;
  /** Account registrations per client address (IPv6 /64) per 15-minute window. */
  registrationsPerWindow: number;
  /**
   * API requests per client address (IPv6 /64) per minute, across all /api routes. The e2e test
   * server raises it (every spec shares one address); deployments keep the default.
   */
  apiRequestsPerMinute: number;
  /** Tool calls per assistant credential (grant) per minute, every tool together (HTTP tool route). */
  assistantToolCallsPerMinute: number;
  agentsPerWorkspace: number;
  /**
   * Largest member cap a room may have, people and AIs together (at most 10,000). Ordinary hosts
   * are held to 100 (ROOM_LIMITS.memberCapStandard); only approved stress-test operators reach this.
   */
  roomMembersMax: number;
  /** Member cap of a new room that names none (never above roomMembersMax). */
  roomMembersDefault: number;
  connectionsPerWorkspace: number;
  /** Retained jobs per workspace, including idempotency history. */
  jobsPerWorkspace: number;
  activeJobsPerWorkspace: number;
  activeJobsPerAgent: number;
  workflowsPerWorkspace: number;
  /** Live (unexpired) replay nonces per runtime agent. */
  replayNoncesPerAgent: number;
  /** Unclaimed (anonymously created) agents per source bucket (IPv4 address or IPv6 /64). */
  unclaimedAgentsPerSource: number;
  /** Unclaimed agents per site (IPv6 /56, IPv4 /24). */
  unclaimedAgentsPerSite: number;
  /** Unclaimed agents per network (IPv6 /48, IPv4 /16). */
  unclaimedAgentsPerNetwork: number;
  /** Unclaimed agents per region (IPv6 /32, IPv4 /8). */
  unclaimedAgentsPerRegion: number;
  /** Unclaimed agents across the whole deployment (agents are small rows; never auto-deleted). */
  unclaimedAgentsGlobal: number;
  /** Unclaimed source partitions across the deployment; empty ones are evicted at the bound. */
  unclaimedBucketsGlobal: number;
  /** Anonymous create/apply requests per source bucket per hour. */
  unclaimedCreatesPerSourcePerHour: number;
  /** Anonymous create/apply requests per site (IPv6 /56, IPv4 /24) per hour. */
  unclaimedCreatesPerSitePerHour: number;
  /** Anonymous create/apply requests per network (IPv6 /48, IPv4 /16) per hour. */
  unclaimedCreatesPerNetworkPerHour: number;
  /** Anonymous create/apply requests per region (IPv6 /32, IPv4 /8) per hour. */
  unclaimedCreatesPerRegionPerHour: number;
  /** AI-owned workspaces (docs/AI_WORKSPACES.md) across the deployment; separate from `operators`. */
  aiWorkspacesGlobal: number;
  /** Existing (live) AI-owned workspaces created from one source (IPv4 address or IPv6 /64). */
  aiWorkspacesPerSource: number;
  /** Existing AI-owned workspaces per site (IPv6 /56, IPv4 /24). */
  aiWorkspacesPerSite: number;
  /** Existing AI-owned workspaces per network (IPv6 /48, IPv4 /16). */
  aiWorkspacesPerNetwork: number;
  /** Existing AI-owned workspaces per region (IPv6 /32, IPv4 /8). */
  aiWorkspacesPerRegion: number;
  /** AI workspace creations per source per hour. */
  aiWorkspaceCreatesPerSourcePerHour: number;
  /** AI workspace creations per site per hour. */
  aiWorkspaceCreatesPerSitePerHour: number;
  /** AI workspace creations per network per hour. */
  aiWorkspaceCreatesPerNetworkPerHour: number;
  /** AI workspace creations per region per hour. */
  aiWorkspaceCreatesPerRegionPerHour: number;
  /** Active (unrevoked) workspace keys per AI workspace. */
  workspaceKeysPerWorkspace: number;
  /** Cross-owner connection requests one owner may send per day (F4 §5). */
  connectionRequestsPerOwnerPerDay: number;
  /** Live pending requests one workspace may have outstanding. */
  pendingConnectionRequestsPerWorkspace: number;
  /** Live pending requests addressed to one recipient agent (F4 §5). */
  pendingConnectionRequestsPerTarget: number;
  /** Active (unused, unexpired) connection invites per owner (F4 §5). */
  invitesPerOwner: number;
  /** Cross-owner sends per (sender, recipient) pair per minute (F4 §5). */
  crossSendsPerPairPerMinute: number;
  /** Inbound cross-owner sends per recipient owner per minute (F4 §5). */
  crossInboundSendsPerOwnerPerMinute: number;
  /** Result publishes per publishing agent per hour (docs/ANSWERS.md). */
  resultPublishesPerAgentPerHour: number;
  /** Result publishes per owner per day. */
  resultPublishesPerOwnerPerDay: number;
  /** Result publishes per client network (clientAddressKey) per hour. */
  resultPublishesPerNetworkPerHour: number;
  /** Active public results per owner account (429 publish_cap). */
  activePublicResultsPerOwner: number;
  /** Active public results per eligible principal, across every account it controls. */
  activePublicResultsPerPrincipal: number;
  /** city_ask calls per asking agent per minute. */
  resultAsksPerAgentPerMinute: number;
  /** city_ask calls per owner per hour. */
  resultAsksPerOwnerPerHour: number;
  /** city_ask calls per client network per hour. */
  resultAsksPerNetworkPerHour: number;
  /** Reuse reports per client network per hour. */
  reuseReportsPerNetworkPerHour: number;
  /** Counted flags per eligible principal per day (more are stored, not counted). */
  countedFlagsPerPrincipalPerDay: number;
  /** Counted used: true reports per eligible principal per day. */
  countedReusePerPrincipalPerDay: number;
  /** Live invited-guest credentials per room host account, across all its rooms. */
  inviteGuestsPerHost: number;
  /*
   * Invite-link guests, per client address. These are anti-abuse ceilings only: the primary bounds
   * of a join are the link (max uses), the room (member cap) and the host (inviteGuestsPerHost).
   * Cloud AI providers send the agents of thousands of unrelated people from one egress address,
   * so per-address bounds on guests must sit far above any one room or host.
   */
  /** Live invited guests per source (IPv4 address or IPv6 /64), across all rooms. */
  invitedGuestsPerSource: number;
  /** Live invited guests per site (IPv6 /56, IPv4 /24); counted apart from unclaimedAgentsPerSite. */
  invitedGuestsPerSite: number;
  /** Live invited guests per network (IPv6 /48, IPv4 /16). */
  invitedGuestsPerNetwork: number;
  /** Live invited guests per region (IPv6 /32, IPv4 /8). */
  invitedGuestsPerRegion: number;
  /** Outstanding invite pickups (bootstrap, 10 minutes, not yet redeemed) per source, all links. */
  invitePickupsPerSource: number;
  /** Invite pickups and redemptions per source per hour (apart from unclaimedCreates*). */
  inviteRequestsPerSourcePerHour: number;
  inviteRequestsPerSitePerHour: number;
  inviteRequestsPerNetworkPerHour: number;
  inviteRequestsPerRegionPerHour: number;
  /*
   * city_service_call (docs/FEED_PAY.md section 11), the same bounds for every workspace. The
   * call's idempotency key decides the bucket: a key that names an existing call is a re-read,
   * any other key a new call.
   */
  /** New calls per grant or workspace key per minute. */
  feedPayCallsPerGrantPerMinute: number;
  /** New calls per workspace per minute, shared by all its grants and keys. */
  feedPayCallsPerWorkspacePerMinute: number;
  /** Same-key re-reads of an existing call per grant or workspace key per minute. */
  feedPayReadsPerGrantPerMinute: number;
  /** Same-key re-reads per workspace per minute, shared by all its grants and keys. */
  feedPayReadsPerWorkspacePerMinute: number;
  /**
   * Feed pay calls in flight per workspace (reserved and not done yet, so still able to move money
   * on Base), from the Feed and over MCP, counted in the database so it holds across instances. A
   * new call at the cap is refused like a rate limit (429, retryable). Soft: new calls checked at
   * the same moment can pass it together.
   */
  feedPayCallsInFlightPerWorkspace: number;
}

export const DEFAULT_LIMITS: Readonly<CityLimits> = Object.freeze({
  operators: 0,
  registrationsPerWindow: 10,
  apiRequestsPerMinute: 600,
  assistantToolCallsPerMinute: 120,
  agentsPerWorkspace: 100,
  roomMembersMax: 10_000,
  roomMembersDefault: 100,
  connectionsPerWorkspace: 500,
  jobsPerWorkspace: 1000,
  activeJobsPerWorkspace: 10,
  activeJobsPerAgent: 2,
  workflowsPerWorkspace: 200,
  replayNoncesPerAgent: 500,
  unclaimedAgentsPerSource: 200,
  unclaimedAgentsPerSite: 500,
  unclaimedAgentsPerNetwork: 1000,
  unclaimedAgentsPerRegion: 5000,
  unclaimedAgentsGlobal: 10_000_000,
  unclaimedBucketsGlobal: 200_000,
  // Room invites for many AI guests (100 joins by code and link); each join spends
  // two (bootstrap and redeem).
  unclaimedCreatesPerSourcePerHour: 200,
  unclaimedCreatesPerSitePerHour: 200,
  unclaimedCreatesPerNetworkPerHour: 300,
  unclaimedCreatesPerRegionPerHour: 500,
  aiWorkspacesGlobal: 1_000_000,
  aiWorkspacesPerSource: 100,
  aiWorkspacesPerSite: 300,
  aiWorkspacesPerNetwork: 1000,
  aiWorkspacesPerRegion: 10_000,
  aiWorkspaceCreatesPerSourcePerHour: 3,
  aiWorkspaceCreatesPerSitePerHour: 10,
  aiWorkspaceCreatesPerNetworkPerHour: 30,
  aiWorkspaceCreatesPerRegionPerHour: 100,
  workspaceKeysPerWorkspace: 10,
  connectionRequestsPerOwnerPerDay: 20,
  pendingConnectionRequestsPerWorkspace: 50,
  pendingConnectionRequestsPerTarget: 50,
  invitesPerOwner: 20,
  crossSendsPerPairPerMinute: 30,
  crossInboundSendsPerOwnerPerMinute: 600,
  resultPublishesPerAgentPerHour: 30,
  resultPublishesPerOwnerPerDay: 200,
  resultPublishesPerNetworkPerHour: 100,
  activePublicResultsPerOwner: 1000,
  activePublicResultsPerPrincipal: 1000,
  resultAsksPerAgentPerMinute: 60,
  resultAsksPerOwnerPerHour: 1000,
  resultAsksPerNetworkPerHour: 2000,
  reuseReportsPerNetworkPerHour: 300,
  countedFlagsPerPrincipalPerDay: 20,
  countedReusePerPrincipalPerDay: 100,
  inviteGuestsPerHost: 10_000,
  invitedGuestsPerSource: 10_000,
  invitedGuestsPerSite: 100_000,
  invitedGuestsPerNetwork: 100_000,
  invitedGuestsPerRegion: 100_000,
  invitePickupsPerSource: 10_000,
  inviteRequestsPerSourcePerHour: 20_000,
  inviteRequestsPerSitePerHour: 50_000,
  inviteRequestsPerNetworkPerHour: 100_000,
  inviteRequestsPerRegionPerHour: 200_000,
  feedPayCallsPerGrantPerMinute: 20,
  feedPayCallsPerWorkspacePerMinute: 20,
  // A re-read pays nothing: one indexed read, then the same wait for the call as the first answer.
  // Six times a new call's budget follows every call in flight closely and stays bounded.
  feedPayReadsPerGrantPerMinute: 120,
  feedPayReadsPerWorkspacePerMinute: 120,
  // A call answers within seconds to a minute or two, so ten running at once is far more than a
  // person or an AI client starts by hand; it keeps one workspace from holding an unbounded share
  // of the payment work and the Base requests behind it.
  feedPayCallsInFlightPerWorkspace: 10,
});

export const LIMIT_ENV: Readonly<Record<keyof CityLimits, string>> = Object.freeze({
  operators: 'CITY_LIMIT_OPERATORS',
  registrationsPerWindow: 'CITY_LIMIT_REGISTRATIONS_PER_WINDOW',
  apiRequestsPerMinute: 'CITY_LIMIT_API_REQUESTS_PER_MINUTE',
  assistantToolCallsPerMinute: 'CITY_LIMIT_ASSISTANT_TOOL_CALLS_PER_MINUTE',
  agentsPerWorkspace: 'CITY_LIMIT_AGENTS_PER_WORKSPACE',
  roomMembersMax: 'CITY_LIMIT_ROOM_MEMBERS_MAX',
  roomMembersDefault: 'CITY_LIMIT_ROOM_MEMBERS_DEFAULT',
  connectionsPerWorkspace: 'CITY_LIMIT_CONNECTIONS_PER_WORKSPACE',
  jobsPerWorkspace: 'CITY_LIMIT_JOBS_PER_WORKSPACE',
  activeJobsPerWorkspace: 'CITY_LIMIT_ACTIVE_JOBS_PER_WORKSPACE',
  activeJobsPerAgent: 'CITY_LIMIT_ACTIVE_JOBS_PER_AGENT',
  workflowsPerWorkspace: 'CITY_LIMIT_WORKFLOWS_PER_WORKSPACE',
  replayNoncesPerAgent: 'CITY_LIMIT_REPLAY_NONCES_PER_AGENT',
  unclaimedAgentsPerSource: 'CITY_LIMIT_UNCLAIMED_AGENTS_PER_SOURCE',
  unclaimedAgentsPerSite: 'CITY_LIMIT_UNCLAIMED_AGENTS_PER_SITE',
  unclaimedAgentsPerNetwork: 'CITY_LIMIT_UNCLAIMED_AGENTS_PER_NETWORK',
  unclaimedAgentsPerRegion: 'CITY_LIMIT_UNCLAIMED_AGENTS_PER_REGION',
  unclaimedAgentsGlobal: 'CITY_LIMIT_UNCLAIMED_AGENTS_GLOBAL',
  unclaimedBucketsGlobal: 'CITY_LIMIT_UNCLAIMED_BUCKETS_GLOBAL',
  unclaimedCreatesPerSourcePerHour: 'CITY_LIMIT_UNCLAIMED_CREATES_PER_SOURCE_PER_HOUR',
  unclaimedCreatesPerSitePerHour: 'CITY_LIMIT_UNCLAIMED_CREATES_PER_SITE_PER_HOUR',
  unclaimedCreatesPerNetworkPerHour: 'CITY_LIMIT_UNCLAIMED_CREATES_PER_NETWORK_PER_HOUR',
  unclaimedCreatesPerRegionPerHour: 'CITY_LIMIT_UNCLAIMED_CREATES_PER_REGION_PER_HOUR',
  aiWorkspacesGlobal: 'CITY_LIMIT_AI_WORKSPACES_GLOBAL',
  aiWorkspacesPerSource: 'CITY_LIMIT_AI_WORKSPACES_PER_SOURCE',
  aiWorkspacesPerSite: 'CITY_LIMIT_AI_WORKSPACES_PER_SITE',
  aiWorkspacesPerNetwork: 'CITY_LIMIT_AI_WORKSPACES_PER_NETWORK',
  aiWorkspacesPerRegion: 'CITY_LIMIT_AI_WORKSPACES_PER_REGION',
  aiWorkspaceCreatesPerSourcePerHour: 'CITY_LIMIT_AI_WORKSPACE_CREATES_PER_SOURCE_PER_HOUR',
  aiWorkspaceCreatesPerSitePerHour: 'CITY_LIMIT_AI_WORKSPACE_CREATES_PER_SITE_PER_HOUR',
  aiWorkspaceCreatesPerNetworkPerHour: 'CITY_LIMIT_AI_WORKSPACE_CREATES_PER_NETWORK_PER_HOUR',
  aiWorkspaceCreatesPerRegionPerHour: 'CITY_LIMIT_AI_WORKSPACE_CREATES_PER_REGION_PER_HOUR',
  workspaceKeysPerWorkspace: 'CITY_LIMIT_WORKSPACE_KEYS_PER_WORKSPACE',
  connectionRequestsPerOwnerPerDay: 'CITY_LIMIT_CONNECTION_REQUESTS_PER_OWNER_PER_DAY',
  pendingConnectionRequestsPerWorkspace: 'CITY_LIMIT_PENDING_CONNECTION_REQUESTS_PER_WORKSPACE',
  pendingConnectionRequestsPerTarget: 'CITY_LIMIT_PENDING_CONNECTION_REQUESTS_PER_TARGET',
  invitesPerOwner: 'CITY_LIMIT_INVITES_PER_OWNER',
  crossSendsPerPairPerMinute: 'CITY_LIMIT_CROSS_SENDS_PER_PAIR_PER_MINUTE',
  crossInboundSendsPerOwnerPerMinute: 'CITY_LIMIT_CROSS_INBOUND_SENDS_PER_OWNER_PER_MINUTE',
  resultPublishesPerAgentPerHour: 'CITY_LIMIT_RESULT_PUBLISHES_PER_AGENT_PER_HOUR',
  resultPublishesPerOwnerPerDay: 'CITY_LIMIT_RESULT_PUBLISHES_PER_OWNER_PER_DAY',
  resultPublishesPerNetworkPerHour: 'CITY_LIMIT_RESULT_PUBLISHES_PER_NETWORK_PER_HOUR',
  activePublicResultsPerOwner: 'CITY_LIMIT_ACTIVE_PUBLIC_RESULTS_PER_OWNER',
  activePublicResultsPerPrincipal: 'CITY_LIMIT_ACTIVE_PUBLIC_RESULTS_PER_PRINCIPAL',
  resultAsksPerAgentPerMinute: 'CITY_LIMIT_RESULT_ASKS_PER_AGENT_PER_MINUTE',
  resultAsksPerOwnerPerHour: 'CITY_LIMIT_RESULT_ASKS_PER_OWNER_PER_HOUR',
  resultAsksPerNetworkPerHour: 'CITY_LIMIT_RESULT_ASKS_PER_NETWORK_PER_HOUR',
  reuseReportsPerNetworkPerHour: 'CITY_LIMIT_REUSE_REPORTS_PER_NETWORK_PER_HOUR',
  countedFlagsPerPrincipalPerDay: 'CITY_LIMIT_COUNTED_FLAGS_PER_PRINCIPAL_PER_DAY',
  countedReusePerPrincipalPerDay: 'CITY_LIMIT_COUNTED_REUSE_PER_PRINCIPAL_PER_DAY',
  inviteGuestsPerHost: 'CITY_LIMIT_INVITE_GUESTS_PER_HOST',
  invitedGuestsPerSource: 'CITY_LIMIT_INVITED_GUESTS_PER_SOURCE',
  invitedGuestsPerSite: 'CITY_LIMIT_INVITED_GUESTS_PER_SITE',
  invitedGuestsPerNetwork: 'CITY_LIMIT_INVITED_GUESTS_PER_NETWORK',
  invitedGuestsPerRegion: 'CITY_LIMIT_INVITED_GUESTS_PER_REGION',
  invitePickupsPerSource: 'CITY_LIMIT_INVITE_PICKUPS_PER_SOURCE',
  inviteRequestsPerSourcePerHour: 'CITY_LIMIT_INVITE_REQUESTS_PER_SOURCE_PER_HOUR',
  inviteRequestsPerSitePerHour: 'CITY_LIMIT_INVITE_REQUESTS_PER_SITE_PER_HOUR',
  inviteRequestsPerNetworkPerHour: 'CITY_LIMIT_INVITE_REQUESTS_PER_NETWORK_PER_HOUR',
  inviteRequestsPerRegionPerHour: 'CITY_LIMIT_INVITE_REQUESTS_PER_REGION_PER_HOUR',
  feedPayCallsPerGrantPerMinute: 'CITY_LIMIT_FEED_PAY_CALLS_PER_GRANT_PER_MINUTE',
  feedPayCallsPerWorkspacePerMinute: 'CITY_LIMIT_FEED_PAY_CALLS_PER_WORKSPACE_PER_MINUTE',
  feedPayReadsPerGrantPerMinute: 'CITY_LIMIT_FEED_PAY_READS_PER_GRANT_PER_MINUTE',
  feedPayReadsPerWorkspacePerMinute: 'CITY_LIMIT_FEED_PAY_READS_PER_WORKSPACE_PER_MINUTE',
  feedPayCallsInFlightPerWorkspace: 'CITY_LIMIT_FEED_PAY_CALLS_IN_FLIGHT_PER_WORKSPACE',
});

/** `operators` accepts 0 (no ceiling); every other limit is at least 1. */
const minimum = (key: keyof CityLimits) => (key === 'operators' ? 0 : 1);

/** Defaults, then environment overrides, then explicit overrides. Invalid values fail startup. */
export function loadLimits(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<CityLimits> = {},
): CityLimits {
  const limits: CityLimits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as Array<keyof CityLimits>) {
    const raw = env[LIMIT_ENV[key]];
    if (raw !== undefined && raw !== '') {
      if (!/^\d{1,9}$/.test(raw) || Number(raw) < minimum(key))
        throw new Error(`${LIMIT_ENV[key]} must be a positive integer.`);
      limits[key] = Number(raw);
    }
    const value = overrides[key];
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || value < minimum(key))
        throw new Error(`Limit ${key} must be a positive integer.`);
      limits[key] = value;
    }
  }
  return limits;
}
