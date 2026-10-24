import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import type { PGlite } from '@electric-sql/pglite';
import {
  openPostgres,
  transientDatabaseError,
  type Database,
  type Transaction as Tx,
} from './database.js';
import {
  agentMessageCountsMigration,
  agentTotalsMigration,
  registerMigration,
  runMigrations,
  sessionsExpiryMigration,
} from './migrations.js';
import { loadLimits, type CityLimits } from './limits.js';
import {
  stressTestMaxGuests,
  stressTestMaxRooms,
  stressTestOperators,
} from './stress-allowlist.js';
import {
  clientAddressKey,
  limitRequestRate,
  PrincipalCache,
  presentedPrincipal,
  FAIL_CLOSED_RETRY_MS,
  LOGIN_FAILURES,
  MemoryRateLimiter,
  PostgresRateLimiter,
  type RateLimiter,
} from './rate-limit.js';
import {
  acceptNonce,
  announcedOnline,
  applyPresence,
  overlayPresence,
  PRESENCE_JSON_SQL,
  recordHeartbeat,
  resetPresence,
  type PresenceIdentity,
} from './presence.js';
import { checkHostedRequest, loadHostedConfig, type HostedConfig } from './hosted.js';
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import type { Operator, Capability, WorkflowDetail } from '../shared/types.js';
import {
  active,
  emptyWorkspace,
  event,
  hasPermission,
  hostedHeartbeatDue,
  iso,
  LEASE_TTL,
  ownerAgent,
  publicAgent,
  publicJob,
  reachable,
  listAgents,
  snapshot,
  stopJob,
  publicWorkflow,
  syncWorkflows,
  type StoredWorkflow,
  type StoredAgent,
  attachInbound,
  type StoredJob,
  type Workspace,
} from './model.js';
import { executeTemplate } from './templates.js';
import { agentActivity, decodeCursor } from './activity.js';
import { decodeAgentCursor } from './agent-pages.js';
import { AGENT_PAGES, AGENTS_PATH } from '../shared/agent-pages.js';
import {
  currentManifest,
  descendants,
  issueRuntimeCredential,
  revokeStoredAgent,
  setAgentPaused,
  updateStoredAgent,
} from './agent-lifecycle.js';
import { acquireDataLock } from './data-lock.js';
import { exportWorkspace } from './export.js';
import {
  ASSISTANT_TOOL_SCOPES,
  assistantAgentSchema,
  assistantJobSchema,
  registerAssistantAccess,
  type GrantIdentity,
} from './assistant-access.js';
import { registerRemoteMcp, type RemoteMcpTestOptions } from './remote-mcp/index.js';
import { registerAutonomy } from './autonomy/index.js';
import { createMessaging } from './messaging/service.js';
import { registerMessagingRoutes } from './messaging/routes.js';
import { registerMessagingMigration } from './messaging/schema.js';
import { registerPairRemediationMigration } from './messaging/remediation-schema.js';
import { registerAiWorkspacesMigration } from './workspaces/schema.js';
import { registerAiWorkspaces } from './workspaces/service.js';
import { registerCrossConnectionsMigration } from './connections/schema.js';
import {
  createConnections,
  inboundFromRows,
  INBOUND_JSON_SQL,
  loadInbound,
} from './connections/service.js';
import { registerConnectionRoutes } from './connections/routes.js';
import { registerRoomsMigration } from './rooms/schema.js';
import { registerRoomFormatMigration } from './rooms/format-schema.js';
import { createRooms } from './rooms/service.js';
import {
  createRoomTasks,
  existingStarterTasks,
  insertStarterTasks,
} from './rooms/tasks-service.js';
import { registerTaskRoutes } from './rooms/tasks-routes.js';
import { roomTasksEnabled } from './rooms/tasks-tools.js';
import {
  createRoomReposFromEnv,
  registerRoomCodeMigration,
  type RoomRepos,
} from './rooms/repos/index.js';
import { registerRoomRepoRoutes } from './rooms/repos/routes.js';
import { registerRoomTasksMigration } from './rooms/tasks-schema.js';
import { registerRoomOverviewMigration } from './rooms/overview.js';
import { registerRoomRoutes } from './rooms/routes.js';
import { createRoomInvitations, type RoomInvitationDependencies } from './rooms/invitations.js';
import { registerInvitationRoutes } from './rooms/invitations-routes.js';
import { registerRoomInvitationsMigration } from './rooms/invitations-schema.js';
import { createRoomPins, deliverBriefOnce, registerRoomPinsMigration } from './rooms/pins.js';
import { registerPinRoutes } from './rooms/pins-routes.js';
import { registerWakeMigration, registerWakeUnreadRecountMigration } from './wake/schema.js';
import { createWake, type WakeOptions } from './wake/service.js';
import { inboxWaiter, registerWakeRoutes } from './wake/routes.js';
import { wakeKeys } from './wake/webhooks.js';
import type { RoomLimits } from './rooms/contract.js';
import { registerResultsMigration } from './results/schema.js';
import { registerResponderMigration } from './responder/schema.js';
import { registerResponderExecutionMigration } from './responder/execution-schema.js';
import { responderKeys } from './responder/keys.js';
import { createResponder, ResponderError } from './responder/service.js';
import {
  AgentPayError,
  createAgentPayService,
  type AgentPayDeps,
} from './base/payments/agent-pay.js';
import { registerPaymentRecoveryCron } from './base/payments/recover-cron.js';
import { registerResponderRoutes } from './responder/routes.js';
import type { ProviderPostTransport, ProviderTransport } from './responder/providers.js';
import { createResponderDelivery } from './responder/deliver.js';
import { RoomError } from './rooms/service.js';
import { registerElricMigration } from './elric/schema.js';
import { registerElricCeilingMigration } from './elric/budget.js';
import {
  registerGoogleMigration,
  registerGoogleSignIn,
  type GoogleSignInOptions,
} from './google/index.js';
import { GOOGLE_SALT_NO_PASSWORD, GOOGLE_SALT_PENDING_NAME } from './google/routes.js';
import {
  NEWSLETTER_RATE,
  registerEmail,
  registerEmailMigration,
  type EmailOptions,
} from './email/index.js';
import { registerBaseMigration } from './base/schema.js';
import { baseRegistrationStarted, registerShortLinks } from './base/identity/short-links.js';
import { registerBaseRegistrationRoutes } from './base/identity/routes.js';
import { chainRuntimes } from './base/chain/runtime.js';
import { registerOnBaseRoutes } from './base/explorer/routes.js';
import { registerServiceCallsRoutes } from './base/explorer/calls.js';
import { registerDirectoryRoutes } from './directory/routes.js';
import { registerDirectoryMigration } from './directory/schema.js';
import { registerFeedRequestsMigration } from './feed/schema.js';
import { createFeedRequests, feedCaps } from './feed/requests.js';
import { registerFeedRoutes } from './feed/routes.js';
import { feedEventLog, registerFeedReviewRoutes } from './feed/review.js';
import { registerFacilitatorKeyRoute } from './protocol/x402/facilitator-key-route.js';
import {
  registerOwnPaymasterKeysMigration,
  registerOwnPaymasterKeysRoute,
  registerPaymasterPublicRoute,
  provisionPaymasterKeysAtStart,
} from './base/chain/own-paymaster-keys.js';
import { registerOwnPaymasterBudgetMigration } from './base/chain/own-paymaster-budget.js';
import {
  registerDirectBundlerMigration,
  registerOwnBundlerMaintainRoute,
} from './base/chain/direct-bundler.js';
import { registerFeedCron } from './feed/cron.js';
import { protocolFeeLedgerMigration } from './protocol/fees/ledger.js';
import { registerProtocolFeeTimeIndexMigration } from './protocol/fees/time-index-schema.js';
import { registerProtocolFeeRouterStartsMigration } from './protocol/fees/router-starts-schema.js';
import { registerFeedPayFloatTargetMigration } from './feed/pay/router2-schema.js';
import { offerPriceMaxRaw } from './feed/pay/router2.js';
import { registerFeedPayFeeMigration } from './feed/pay/fee-schema.js';
import { registerFeedPayIncludedMigration } from './feed/pay/included-schema.js';
import { registerFeedPayPaidIndexMigration } from './feed/pay/paid-index-schema.js';
import { registerPaidCallCountMigration } from './feed/pay/count-schema.js';
import { registerPaidCallCountDropMigration } from './feed/pay/count-drop-schema.js';
import { registerFeedPayTopUpRetryMigration } from './feed/pay/topup-retry-schema.js';
import { registerFeedPayPayRetryMigration } from './feed/pay/pay-retry-schema.js';
import { registerProtocolScreeningMigration } from './protocol/screening/schema.js';
import { createScreeningGate, type ScreeningProvider } from './protocol/screening/gate.js';
import { sanctionsOracleFor } from './protocol/screening/sanctions-oracle.js';
import { registerProtocolFeeRoutes } from './protocol/fees/routes.js';
import {
  protocolFeeChainFromEnv,
  protocolFeeChainId,
  registerProtocolFeeCron,
} from './protocol/fees/cron.js';
import type { FeedSyncDeps } from './feed/ingest.js';
import { registerFeedServiceRoutes } from './feed/services-routes.js';
import { registerFeedServicesMigration } from './feed/services-schema.js';
import { registerFeedOffersMigration } from './feed/offers/schema.js';
import { registerFeedOfferKindsV2Migration } from './feed/offers/kinds-schema.js';
import { registerFeedOfferPresetsMigration } from './feed/offers/preset-schema.js';
import { registerFeedPayRouter2CapsMigration } from './feed/pay/router2-caps-schema.js';
import { registerX402FacilitatorMigration } from './protocol/x402/facilitator-schema.js';
import { registerFeedPayMovesCheckedMigration } from './feed/pay/moves-checked-schema.js';
import { registerPaidCallValueMigration } from './feed/pay/value-schema.js';
import { registerAgentNamesResetScopedMigration } from './rooms/agent-names-schema.js';
import { registerWorkspaceAgentPathMigration } from './agent-rows/agent-lookup-schema.js';
import { registerAgentRowsMigration } from './agent-rows/schema.js';
import { registerBaseWalletsAddressLowerMigration } from './base/pay/address-index-schema.js';
import { registerBaseIdentitiesBaseIdMigration } from './base/explorer/base-id-index-schema.js';
import { registerBaseWalletsSpenderMigration } from './base/wallet/spender-index-schema.js';
import { registerFeedPaySponsorMigration } from './feed/pay/sponsor-schema.js';
import { registerSponsorStatsRoute } from './feed/pay/sponsor-routes.js';
import { createSponsorCredits } from './feed/pay/sponsor.js';
import {
  createSponsoredCalls,
  registerFeedPaySponsoredMigration,
  type SponsoredDeps,
} from './feed/pay/sponsored.js';
import { registerSponsoredRoutes } from './feed/pay/sponsored-routes.js';
import { registerFeedPaySponsoredExplorerMigration } from './feed/pay/sponsored-explorer-schema.js';
import { registerPaidCallCountSponsoredMigration } from './feed/pay/sponsored-count-schema.js';
import {
  registerFeedPaySponsorKeyMigration,
  registerSponsorKeyRoute,
} from './feed/pay/sponsor-key.js';
import { setOfferKindDeps } from './feed/offers/kinds.js';
import { offerBaseReaderFromEnv } from './feed/offers/kinds-base.js';
import {
  createOfferStore,
  OFFER_CAPS_DEFAULT,
  offerCaps,
  syncOfferListing,
  type OfferCaps,
} from './feed/offers/store.js';
import { refreshHostedUses } from './feed/offers/uses.js';
import { registerFeedPayIncludedSettledMigration } from './feed/offers/uses-schema.js';
import { registerFeedPayMigration } from './feed/pay/schema.js';
import { createFeedPayEngine, type FeedPayEngineDeps } from './feed/pay/engine.js';
import { registerFeedPayRoutes } from './feed/pay/routes.js';
import { createFeedPayAlerts } from './feed/pay/alerts.js';
import { FeedPayToolError, feedPayRefusalFields } from './feed/pay/tool.js';
import { FeedToolError } from './feed/tools.js';
import { FeedBusyError, isFeedPath, sendFeedBusy } from './feed/busy.js';
import { sendDatabaseBusy } from './busy.js';
import { feedServicesStatus } from './feed/query.js';
import { registerFeedRespondMigration } from './feed/respond-schema.js';
import { createFeedRespond, type FeedRespondDependencies } from './feed/respond.js';
import { registerFeedRespondRoutes } from './feed/respond-routes.js';
import { feedEnabled } from './feed/flag.js';
import { baseChainReader } from './base/explorer/head.js';
import { registerBaseWalletRoutes, WALLET_CHAIN_ID, walletReaders } from './base/wallet/routes.js';
import { ownerRevokePortFromEnv } from './base/chain/owner-revoke.js';
import { BASE_MAINNET, BASE_NETWORKS } from '../shared/base/chains.js';
import { PUBLIC_BASE_RPC } from '../shared/base/on-base.js';
import { newsletterEmailSchema } from '../shared/newsletter-schema.js';
import {
  OnboardingRequiredError,
  assertOnboarded as assertOnboardedIn,
  onboardingOf as onboardingOfIn,
  onboardingState,
} from './onboarding.js';
import { TERMS_VERSION } from '../shared/terms.js';
import { registerElric } from './elric/index.js';
import { ELRIC_MANAGED, elricAgentIds } from './elric/access.js';
import { unavailableAdapter, type ModelAdapter } from './elric/adapter.js';
import {
  elricEnabled,
  elricRateConfig,
  elricRates,
  elricRunBudgetMs,
  type ElricConfig,
} from './elric/config.js';
import { elricMockModels, elricModels, type ElricModelWiring } from './elric/endpoints.js';
import { registerElricHealth } from './elric/health.js';
import { ELRIC_RESERVED_NAME_MESSAGE, reservedName } from './elric/names.js';
import { createResults, ResultError } from './results/service.js';
import { registerResultRoutes } from './results/routes.js';
import { pauseKey, syncResultSuspension } from './results/store.js';
import type { ResultOptions } from './results/contract.js';
import { registerJoinLinksMigration } from './links/schema.js';
import { createJoinLinks } from './links/service.js';
import { registerJoinLinkRoutes } from './links/routes.js';
import {
  createPublicStats,
  parseExcludedOperators,
  registerPublicStatsRoutes,
  sqlPublicStatsStore,
} from './stats/public-stats.js';
import { createBaseAgentsReader } from './stats/base-agents.js';
import { registerFastCountCheckRoute } from './stats/fast-count-check.js';
import { createPaidCallsReader } from './stats/paid-calls.js';
import { loadPlatformSigner } from './autonomy/signing.js';
import {
  createCountLog,
  registerCountLogMigration,
  registerCountLogRoutes,
} from './count-log/index.js';
import type { SigningKey } from './manifest/keys.js';
import { requestOrigin } from './oauth/server.js';
import { describeValidation, validationErrorBody } from './validation-errors.js';
import { A2A_PIN, parseA2AIntent, projectNativeJob, createTaskResponse } from '../protocol/a2a.js';
import {
  A2A_AUTH_EXTENSION,
  A2ATransportError,
  a2aMessageKey,
  a2aTaskIds,
  a2aErrorResponse,
} from './a2a.js';

export interface AppOptions {
  dataDir?: string;
  /**
   * Unknown paths outside `/api/` (the local server serves the SPA and 404 page here). Unknown
   * `/api/` routes always get the same body, and nothing echoes the requested path or query.
   */
  notFound?: (request: FastifyRequest, reply: FastifyReply) => unknown;
  /**
   * The passport page (the SPA shell) for a browser at /a/<short> (short-links.ts wantsHtml); the
   * local server passes it. Hosted, vercel.json rewrites those requests to the shell before they
   * reach the function. Without it every client gets the registration file.
   */
  passportPage?: (request: FastifyRequest, reply: FastifyReply) => unknown;
  now?: () => number;
  /**
   * Tests only: the clock of the count-log cron gate, pinned so cron tests do not depend on the
   * time of day (CITY_COUNT_LOG_CRON_NOW in the e2e server). Defaults to the app clock (`now`).
   * When set, the cron seals without the noon cut.
   */
  countLogCronNow?: () => number;
  startWorkers?: boolean;
  secureCookies?: boolean;
  hosted?: HostedConfig;
  /** Injection for isolated storage integration tests; never selected from environment. */
  database?: Database;
  /** Test-only injection for the remote MCP/OAuth front door (e.g. a client metadata fetcher). */
  remoteMcp?: RemoteMcpTestOptions;
  /**
   * Feed offers (server/feed/offers/store.ts): the https origin offers are listed under (default:
   * the hosted public origin, else https://centralcity.ai) and, for tests, the caps (default: the
   * CITY_LIMIT_OFFERS_* settings).
   */
  offers?: { origin?: string; caps?: OfferCaps };
  /**
   * Request rate limiter. Defaults to a PostgreSQL-backed shared limiter in hosted mode and a
   * bounded in-memory limiter locally. 'memory' and 'postgres' select a built-in explicitly.
   */
  rateLimiter?: RateLimiter | 'memory' | 'postgres';
  /** Capacity overrides applied after CITY_LIMIT_* environment overrides. */
  limits?: Partial<CityLimits>;
  /**
   * Trusted proxy hops for the client address (Fastify trustProxy). Defaults to one hop when
   * the hosted configuration runs on Vercel, otherwise 0 so a direct client cannot spoof
   * X-Forwarded-For.
   */
  trustProxyHops?: number;
  /**
   * Agent Card signing key. Defaults to CITY_SIGNING_KEY, else an ephemeral key locally and no
   * key (cards served unsigned and flagged) in hosted mode. null forces unsigned cards.
   */
  signingKey?: SigningKey | null;
  /** Structured operational log sink (e.g. capacity.pressure lines). Defaults to console.warn. */
  logLine?: (line: string) => void;
  /**
   * Tests only: builds the room repos service (a fake GitHub transport and allowlist) instead of
   * reading the environment (docs/ROOM_REPOS.md).
   */
  roomRepos?: (deps: {
    db: Database;
    clock(): number;
    limit(key: string, max: number, windowMs: number): Promise<void>;
  }) => RoomRepos;
  /** Agent messaging bounds (docs/MESSAGING.md); defaults 1000 unacknowledged and 60 sends/min. */
  messaging?: { inboxDepth?: number; sendsPerMinute?: number; crossPairPerMinute?: number };
  /** Room limit overrides (docs/ROOMS.md). */
  rooms?: Partial<RoomLimits>;
  /** Tests only: room invitation pause points for the race suite (rooms/invitations.ts). */
  roomInvitations?: Pick<RoomInvitationDependencies, 'pause'>;
  /** Tests only: Feed Respond pause points for its race tests (server/feed/respond.ts). */
  feedRespond?: Pick<FeedRespondDependencies, 'pause'>;
  /**
   * Tests only: the agent payment chain and the recipient reader of Base Pay P2c (fakes without
   * any network) instead of the wallet network's chain runtime and configured endpoint.
   */
  agentPay?: Pick<AgentPayDeps, 'chain' | 'recipients'>;
  /** Wake-up tuning and the test webhook transport (docs/WAKE.md). */
  wake?: WakeOptions;
  /** Results tuning (ask timeout, candidate cap, principal age; docs/ANSWERS.md). */
  results?: ResultOptions;
  /**
   * Hosted responder (docs/RESPONDER.md). Off unless CITY_RESPONDER=1 (or `enabled`). `env`
   * replaces process.env for the root key; `transport` replaces the provider HTTP calls in tests.
   */
  responder?: {
    enabled?: boolean;
    env?: Record<string, string | undefined>;
    transport?: ProviderTransport;
    /** Replaces the reply calls (POST /v1/messages, /v1/chat/completions) in tests. */
    postTransport?: ProviderPostTransport;
    /** Responder drain budget per kick (default 20 s; review B5). */
    drainBudgetMs?: number;
    /**
     * false: attach no reply delivery to the wake outbox, for tests that drive
     * createResponderDelivery themselves (otherwise the in-process drain would race them).
     */
    delivery?: boolean;
  };
  /**
   * Elric (docs/ELRIC.md). Off unless CITY_ELRIC=1 (or `enabled`). Tests inject the model per tier
   * (`adapterFor`, the MockAdapter); without it every model call is refused as model_unavailable.
   */
  elric?: {
    enabled?: boolean;
    adapterFor?: (tier: 1 | 2) => ModelAdapter;
    config?: Partial<ElricConfig>;
    /** false: no drain after responses (tests drive it). */
    autoDrain?: boolean;
    /** Tests only: awaited at fixed points of a run (server/elric/service.ts). */
    probe?: (point: 'reserved' | 'before_tool' | 'before_post') => Promise<void>;
    /**
     * Tests only: the self-hosted model wiring (server/elric/endpoints.ts), instead of the one
     * built from CITY_ELRIC_T{1,2}_URL / _MODEL; null for none.
     */
    models?: ElricModelWiring | null;
    /** Tests only: the wall clock of the run budget (default Date.now). */
    wallClock?: () => number;
    /** Tests only: the wait before a model retry, and the operator log of a failed turn. */
    sleep?: (ms: number) => Promise<void>;
    log?: (line: string) => void;
  };
  /** Sign in with Google (docs/GOOGLE_SIGNIN.md); off unless CITY_GOOGLE_SIGNIN=1. */
  google?: GoogleSignInOptions;
  /** Email (docs/EMAIL.md): the CITY_EMAIL_* environment and the provider transport (tests). */
  email?: EmailOptions;
  /**
   * Tests only: the fetch the Feed's Bazaar sweep reads the source with (server/feed/ingest.ts), a
   * fake without any network, instead of the global fetch.
   */
  feed?: Pick<FeedSyncDeps, 'fetch'>;
  /**
   * Tests only: Feed pay's chain side, outbound transport, alerts and clock of its worker
   * (server/feed/pay/engine.ts), and how long POST call and city_service_call wait.
   */
  feedPay?: Partial<
    Pick<
      FeedPayEngineDeps,
      | 'chain'
      | 'http'
      | 'alert'
      | 'sleep'
      | 'pollMs'
      | 'offerKinds'
      | 'facilitator'
      | 'finalityPerRun'
    >
  > & {
    answerWaitMs?: number;
    mcpWaitMs?: number;
    /** Tests: the payment screening provider (never the network); null = none configured. */
    screeningProvider?: () => ScreeningProvider | null;
    /** Tests: the sponsored first purchase's payer (server/feed/pay/sponsored.ts). */
    sponsorPay?: SponsoredDeps['pay'];
  };
}
export interface CityServices {
  tick(): Promise<void>;
  db: Database;
}
declare module 'fastify' {
  interface FastifyInstance {
    city: CityServices;
  }
  interface FastifyRequest {
    rawBody?: string;
  }
}
type OperatorRow = { id: string; name: string; password_hash: string; salt: string };
type RuntimeIdentity = PresenceIdentity;
/** idleJobPoll's one read (the workspace is unlocked): $1 workspace, $2 agent, $3 credential hash. */
const IDLE_JOB_POLL_SQL = `SELECT (ws.data->'paused') = 'true'::jsonb AS paused,
  EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ws.data->'jobs') = 'array'
            THEN ws.data->'jobs' ELSE '[]'::jsonb END) j
          WHERE j->>'status' IN ('queued', 'running'))
  OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ws.data->'workflows') = 'array'
            THEN ws.data->'workflows' ELSE '[]'::jsonb END) f
          WHERE f->>'status' IS NULL OR f->>'status' NOT IN ('accepted', 'failed', 'canceled')) AS busy,
  workspace_agent(ws.operator_id, ws.data, $2) AS agent,
  p.agent_id IS NOT NULL AS has_presence, p.last_seen_at::text AS last_seen_at,
  EXISTS (SELECT 1 FROM credentials c
          WHERE c.agent_id = $2 AND c.operator_id = $1 AND c.token_hash = $3) AS current
FROM workspaces ws
LEFT JOIN agent_presence p ON p.agent_id = $2 AND p.operator_id = ws.operator_id
WHERE ws.operator_id = $1`;
class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}
/** The only routes an account in onboarding may call with its session. */
const ONBOARDING_ROUTES = new Set([
  'GET /api/session',
  'GET /api/auth/google',
  'POST /api/auth/google/handle',
  'POST /api/auth/onboarding',
  'POST /api/auth/logout',
]);
function fail(code: number, message: string, errorCode?: string): never {
  throw Object.assign(new ApiError(code, message), errorCode ? { errorCode } : {});
}
/** Refuses a per-agent destructive console route when the target (or a descendant) is Elric. */
async function refuseElric(tx: Pick<Tx, 'query'>, agentIds: readonly string[]) {
  if ((await elricAgentIds(tx, agentIds)).size)
    throw Object.assign(new ApiError(409, ELRIC_MANAGED.message), {
      errorCode: ELRIC_MANAGED.code,
    });
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function constantEqual(left: string, right: string): boolean {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function passwordHash(password: string, salt: string): Promise<string> {
  return new Promise((resolveHash, reject) =>
    scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) =>
      err ? reject(err) : resolveHash(key.toString('hex')),
    ),
  );
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `${JSON.stringify(key)}:${canonical(val)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function validOutput(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  let count = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (depth > 8 || ++count > 2000) return false;
    if (typeof item === 'number' && !Number.isFinite(item)) return false;
    if (item && typeof item === 'object')
      return Object.entries(item).every(
        ([key, val]) =>
          !['__proto__', 'prototype', 'constructor'].includes(key) && visit(val, depth + 1),
      );
    return true;
  };
  return Buffer.byteLength(JSON.stringify(value)) <= 32768 && visit(value, 0);
}
const authSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2)
      .max(48)
      .regex(/^[a-zA-Z0-9 _.-]+$/),
    password: z.string().min(12).max(256),
  })
  .strict();
/** Password sign-up: the newsletter tick needs an address; without it none is accepted. */
const registerSchema = authSchema
  .extend({ newsletter: z.boolean().optional(), email: newsletterEmailSchema.optional() })
  .strict()
  .superRefine((value, context) => {
    if (value.newsletter === true && !value.email)
      context.addIssue({
        code: 'custom',
        path: ['email'],
        message: 'Enter your email address for the newsletter.',
      });
    if (value.newsletter !== true && value.email !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['email'],
        message: 'An email address is only needed for the newsletter.',
      });
  });
const agentSchema = assistantAgentSchema;
/** The built-in template behind each capability (server/manifest/templates.ts). */
const CAPABILITY_TEMPLATES = {
  research: 'template:research-analyst@1.0.0',
  extract: 'template:extractor@1.0.0',
  verify: 'template:fact-checker@1.0.0',
} as const;
const pairSchema = z
  .object({ fromAgentId: z.string().uuid(), toAgentId: z.string().uuid() })
  .strict();
const jobSchema = assistantJobSchema;
const idFrom = (request: FastifyRequest) =>
  z.object({ id: z.string().uuid() }).parse(request.params).id;
const AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Comma-separated agent ids (include=, ids=): at most `max`, each a UUID. */
function agentIdsParam(value: string | undefined, max: number): string[] {
  if (value === undefined || value === '') return [];
  const ids = [...new Set(value.split(','))];
  if (ids.length > max || ids.some((id) => !AGENT_ID.test(id))) fail(400, 'Invalid agent ids.');
  return ids;
}
const workflowSchema = z
  .object({
    requesterId: z.string().uuid(),
    researcherId: z.string().uuid(),
    reviewerId: z.string().uuid(),
    source: z.string().trim().min(1).max(4000),
    idempotencyKey: z
      .string()
      .min(8)
      .max(128)
      .refine((key) => !key.startsWith('workflow:')),
  })
  .strict();

/** Hosted mode refuses to start without a shared CITY_RATE_LIMIT_KEY of at least 32 characters. */
export function assertHostedSecret(env: NodeJS.ProcessEnv): void {
  const key = env.CITY_RATE_LIMIT_KEY;
  if (!key || key.length < 32)
    throw new Error(
      'CITY_RATE_LIMIT_KEY must be set to a secret of at least 32 characters in hosted mode (CITY_HOSTED=1 or VERCEL=1); refusing to start.',
    );
}

/** Idle timeout of a browser sign-in: each authenticated request slides it forward. */
export const SESSION_TTL_MS = 24 * 60 * 60_000;
/** Absolute lifetime of a browser sign-in, however active it stays. */
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
/** Minimum time between two renewals of one session (at most one UPDATE per interval). */
export const SESSION_RENEW_INTERVAL_MS = 60 * 60_000;
/** Browsers (and tools) that can stay signed in to one account at once. */
export const SESSIONS_PER_ACCOUNT = 20;

export async function createApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const clock = options.now ?? Date.now;
  if (!options.hosted && (process.env.CITY_HOSTED === '1' || process.env.VERCEL === '1'))
    options = { ...options, hosted: loadHostedConfig() };
  if (options.hosted) {
    // Hosted instances derive rate-limit, known-device and unclaimed-partition identifiers from
    // this secret; a per-instance random fallback would split them across instances.
    assertHostedSecret(process.env);
    const db = options.database ?? (await openPostgres(options.hosted.databaseUrl));
    try {
      return await createDatabaseApp(options, clock, db, () => undefined);
    } catch {
      await db.close();
      throw new Error('Hosted database initialization failed.');
    }
  }
  const requestedDataDir =
    options.dataDir === ':memory:' ? 'memory://' : (options.dataDir ?? resolve('.local/data'));
  const dataLock =
    requestedDataDir === 'memory://' ? undefined : await acquireDataLock(requestedDataDir);
  const dataDir = dataLock?.dataDir ?? requestedDataDir;
  let openedDb: PGlite | undefined;
  try {
    if (dataDir !== 'memory://') await mkdir(dirname(dataDir), { recursive: true });
    const { PGlite } = await import('@electric-sql/pglite');
    // btree_gin: the composite (room_id, search_tsv) index of room search (migration 55).
    const { btree_gin } = await import('@electric-sql/pglite/contrib/btree_gin');
    const db = (openedDb = await PGlite.create(dataDir, { extensions: { btree_gin } }));
    return await createDatabaseApp(options, clock, db, () => dataLock?.release());
  } catch (error) {
    if (openedDb) await openedDb.close();
    await dataLock?.release();
    throw error;
  }
}

async function createDatabaseApp(
  options: AppOptions,
  clock: () => number,
  db: Database,
  releaseDataLock: () => Promise<void> | undefined,
): Promise<FastifyInstance> {
  // Versioned, forward-only schema under the shared advisory lock (server/migrations.ts).
  // Feature modules register their migrations before the ledger runs (10: agent_messages).
  registerMessagingMigration();
  // 25: one-time remediation of #61-era pair ids (data migration; needs 10, 15 and 19).
  registerPairRemediationMigration();
  // 11: AI-owned workspaces and keys; 12: cross-workspace connection requests.
  registerAiWorkspacesMigration();
  registerCrossConnectionsMigration();
  // 13: rooms; 14: universal join links.
  registerRoomsMigration();
  // 101: room invitations (rooms/invitations-schema.ts; reads migration 100's agent_directory).
  registerRoomInvitationsMigration();
  registerJoinLinksMigration();
  // 15: mentions and wake-up.
  registerWakeMigration();
  // 16: published results.
  registerResultsMigration();
  // 22: room_messages.format (plain|markdown).
  registerRoomFormatMigration();
  // Room tasks: the schema always exists; the MCP tools are behind CITY_ROOM_TASKS=1.
  registerRoomTasksMigration();
  // 68: room pins and the handoff brief ledger (docs/ROOMS.md "Pins and the handoff brief").
  registerRoomPinsMigration();
  // 23: room repos, proposals, reviews and evidence; the tools are behind
  // CITY_ROOM_REPOS=1 (docs/ROOM_REPOS.md).
  registerRoomCodeMigration();
  // 20: hosted responder settings and write-only provider keys. The schema always exists
  // (it also registers on import); the feature itself is behind CITY_RESPONDER=1.
  registerResponderMigration();
  // 26: responder execution (reply leases, usage, wake target kinds, unread_count, room columns).
  registerResponderExecutionMigration();
  // 142: recounts unread_count from the mentions (person read marks left it high).
  registerWakeUnreadRecountMigration();
  // 29: the verifiable agent count's append-only log (docs: AGENT_COUNT_TRANSPARENCY spec).
  registerCountLogMigration();
  // 39: Elric (first-party agent). The schema always exists; the feature is behind CITY_ELRIC=1.
  registerElricMigration();
  registerElricCeilingMigration();
  // 41: Sign in with Google (flows, and the Workspace domain on Elric's verified identities).
  registerGoogleMigration();
  // 61: the sessions expiry index (server/migrations.ts).
  registerMigration(sessionsExpiryMigration);
  // 74: the My agents Overview totals' indexes (server/migrations.ts).
  registerMigration(agentTotalsMigration);
  // 75: messages each agent sent (counter + trigger, server/migrations.ts).
  registerMigration(agentMessageCountsMigration);
  // 64: room overview counters, messages today and the "Needs you" indexes; 71: dismissed
  // "Needs you" items (rooms/overview.ts).
  registerRoomOverviewMigration();
  // 76: the email outbox and the newsletter consent (server/email/schema.ts).
  registerEmailMigration();
  registerBaseMigration();
  // 100: the directory's per-agent settings (server/directory/schema.ts).
  registerDirectoryMigration();
  // Migration 103 (Feed requests): the tables of the Feed's requests (live unless CITY_FEED=0).
  // 105: the requests search reads the tags too, through an expression index (server/feed/schema.ts).
  registerFeedRequestsMigration();
  // 104: the Feed's services, exclusions and source sweeps; 107: `hidden` is the operator's own
  // hide, risk is recomputed every sweep (server/feed/services-schema.ts). The schema
  // always exists; the routes, the sweep's cron and the MCP tool stop while CITY_FEED is '0'.
  registerFeedServicesMigration();
  // 122: Feed offers, services an owner's agents sell in the Feed (server/feed/offers/schema.ts):
  // new tables, a nullable column with its index and one source row; nothing writes offers yet
  // but the store (server/feed/offers/store.ts).
  registerFeedOffersMigration();
  // 108: Feed Respond, responses to requests as room invitations (server/feed/respond-schema.ts;
  // needs the rooms tables and 103). The routes stop while CITY_FEED is '0'.
  registerFeedRespondMigration();
  // 112: Feed pay, "Use with my agent" (server/feed/pay/schema.ts): new tables only (Feed pay is
  // live unless CITY_FEED_PAY is '0').
  registerFeedPayMigration();
  // 234: the owner's pot target on Feed pay agent settings (server/feed/pay/router2-schema.ts),
  // fee router 2's one top-up up to 100 USDC; a new nullable column only.
  registerFeedPayFloatTargetMigration();
  // 113: the protocol fee ledger (server/protocol/fees/ledger.ts), filled by the scan cron and read
  // by the public metrics route (both answer 404 only while CITY_PROTOCOL_FEES is '0').
  registerMigration(protocolFeeLedgerMigration);
  // 172: the index the public fee metrics read their days through
  // (server/protocol/fees/time-index-schema.ts): one plain index, no data changes.
  registerProtocolFeeTimeIndexMigration();
  // 232: the fee routers the ledger started reading after router 1 (router 2 rewind, once each).
  registerProtocolFeeRouterStartsMigration();
  // 114: the protocol fee leg of a Feed pay call (server/feed/pay/fee-schema.ts): columns on the
  // Feed pay calls and the 'protocol_fee' chain operation; no new fee is owed while
  // CITY_PROTOCOL_FEES=0.
  registerFeedPayFeeMigration();
  // 123: a Feed pay call to a service sold by a Central City agent, fee included and delivered
  // in-process (server/feed/pay/included-schema.ts): four nullable or defaulted columns on the
  // Feed pay calls and two partial indexes.
  registerFeedPayIncludedMigration();
  // 115: payment screening decisions (server/protocol/screening/schema.ts) and the fee leg's
  // screening hold; a new table and two nullable columns, unused while CITY_PROTOCOL_SCREENING=0.
  registerProtocolScreeningMigration();
  // 120: the index the public passport's "Paid for services" totals read through
  // (server/feed/pay/paid-index-schema.ts); 116 and 117 belong to other open changes.
  registerFeedPayPaidIndexMigration();
  // 125: the paid service calls count (server/feed/pay/count-schema.ts): a small table kept by a
  // deferred trigger on feed_pay_calls that can never block a payment save; read by the public
  // stats field `paid_calls` and checked daily (server/stats/paid-calls.ts).
  registerPaidCallCountMigration();
  // 127: the index the use counts of the services sold by Central City agents read through
  // (server/feed/offers/uses-schema.ts): a partial index on the settled fee-included Feed pay calls;
  // 126 belongs to another open change; 128 and 129 are already applied.
  registerFeedPayIncludedSettledMigration();
  // 128: the paid service calls count's -1 when a reorg drops a settled payment
  // (server/feed/pay/count-drop-schema.ts): one more deferred trigger of the same kind, so it ships
  // alone or last in its batch as well; 126 and 127 belong to other open changes.
  registerPaidCallCountDropMigration();
  // 129: a rate-limited float top-up planned again later (server/feed/pay/topup-retry-schema.ts):
  // two defaulted or nullable columns on the Feed pay calls; 126 and 127 belong to other open
  // changes; 128 (above) is already applied before this one ships.
  registerFeedPayTopUpRetryMigration();
  // 210: a rate-limited fee-included router payment planned again later
  // (server/feed/pay/pay-retry-schema.ts): defaulted or nullable columns on the Feed pay calls.
  registerFeedPayPayRetryMigration();
  // 230: city_offers.kind accepts the ten kinds added after the first twenty
  // (server/feed/offers/kinds-schema.ts): the column's CHECK replaced, nothing else.
  registerFeedOfferKindsV2Migration();
  // 231: city_offers.preset, an offer's fixed input fields (server/feed/offers/preset-schema.ts):
  // one nullable column on the offers table only.
  registerFeedOfferPresetsMigration();
  // 233: the 0.10 USDC CHECKs of one Feed payment widened to 100 USDC for fee router 2
  // (server/feed/pay/router2-caps-schema.ts); the code still enforces 0.10 unless router 2 is on.
  registerFeedPayRouter2CapsMigration();
  // 240: fee router 3's facilitator operations and its nonce lane
  // (server/protocol/x402/facilitator-schema.ts): two new tables only.
  registerX402FacilitatorMigration();
  // 241: pending float moves settled least recently checked first
  // (server/feed/pay/moves-checked-schema.ts): one column and a partial index.
  registerFeedPayMovesCheckedMigration();
  // 243: the total value settled next to the paid calls count (server/feed/pay/value-schema.ts):
  // one column on paid_call_count and its two trigger functions replaced (no trigger created).
  registerPaidCallValueMigration();
  // 244: the workspaces agent-name trigger resets only the renamed, removed or added agents'
  // memberships (server/rooms/agent-names-schema.ts): one trigger function replaced.
  registerAgentNamesResetScopedMigration();
  // 245: one row per agent, schema only (server/agent-rows/schema.ts): new tables, dual-mode read
  // functions and guards in three trigger functions; nothing switches yet.
  registerAgentRowsMigration();
  // 247: the index Base Pay's recipient lookup by wallet reads through
  // (server/base/pay/address-index-schema.ts): one expression index on base_wallets, no data change.
  registerBaseWalletsAddressLowerMigration();
  // 248: the sponsored first purchase's credits (server/feed/pay/sponsor-schema.ts): two new
  // tables, unused while CITY_SFP_ENABLED is not '1'.
  registerFeedPaySponsorMigration();
  // 249: the sponsor account's key record (server/feed/pay/sponsor-key.ts): one new one-row table.
  registerFeedPaySponsorKeyMigration();
  // 250: the sponsored first purchase's calls (server/feed/pay/sponsored.ts): one new table.
  registerFeedPaySponsoredMigration();
  // 251: the indexes the Explorer's service calls read the paid sponsored calls through
  // (server/feed/pay/sponsored-explorer-schema.ts): five partial indexes, no data change.
  registerFeedPaySponsoredExplorerMigration();
  // 252: sponsored first purchases count in paid_call_count (server/feed/pay/sponsored-count-schema.ts):
  // one trigger function, two deferred triggers on feed_pay_sponsored_calls, one backfill.
  registerPaidCallCountSponsoredMigration();
  // 253: the index the wallet lookups by spender read through
  // (server/base/wallet/spender-index-schema.ts): one index on base_wallets, no data change.
  registerBaseWalletsSpenderMigration();
  // 254: workspace_agent() finds one agent in a document with one JSON path pass
  // (server/agent-rows/agent-lookup-schema.ts): one function replaced, no table touched.
  registerWorkspaceAgentPathMigration();
  // 255: the index the Explorer's newest-first list reads through
  // (server/base/explorer/base-id-index-schema.ts): one expression index, no data change.
  registerBaseIdentitiesBaseIdMigration();
  // 256: Operation Paymaster's key records (server/base/chain/own-paymaster-keys.ts): one new table.
  registerOwnPaymasterKeysMigration();
  // 257: Operation Paymaster's spending gate (server/base/chain/own-paymaster-budget.ts): two new tables.
  registerOwnPaymasterBudgetMigration();
  registerDirectBundlerMigration();
  await runMigrations(db);
  // This build reads every workspace's agents from its document. A workspace whose agents were
  // moved to rows (by a later build) would look empty here, so it never serves such a database.
  if (
    (
      await db.query<{ found: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM workspace_storage WHERE mode = 'rows') AS found",
      )
    ).rows[0]?.found
  )
    throw new Error(
      'A workspace stores its agents as rows; this build reads agents from documents only; refusing to start.',
    );
  const caps = loadLimits(process.env, options.limits);
  // Number of trusted proxy hops nearest the socket; 0 disables X-Forwarded-For entirely.
  const trustedHops = options.trustProxyHops ?? (options.hosted?.trustProxy ? 1 : 0);
  const trustProxy = trustedHops > 0 ? (_address: string, hop: number) => hop < trustedHops : false;
  const app = Fastify({
    logger: false,
    bodyLimit: 65536,
    requestTimeout: 15000,
    connectionTimeout: 15000,
    // Only Vercel's edge sets a trustworthy X-Forwarded-For; trust exactly that one hop.
    trustProxy,
  });
  await app.register(cookie);
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    request.rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch {
      done(new ApiError(400, 'Invalid JSON'));
    }
  });
  // Fastify's default 404 body repeats the method, path and query string; this one never does.
  app.setNotFoundHandler((request, reply) => {
    // A build file that doesn't exist (yet): Vercel serves every existing /assets/ file itself and
    // only a miss reaches here (vercel.json rewrite). Never cacheable, so a chunk asked for during a
    // deploy is fetched again instead of staying a 404 for a year under /assets' immutable header.
    if (request.url.startsWith('/assets/'))
      return reply.code(404).header('Cache-Control', 'no-store').send({ error: 'Not found' });
    if (!request.url.startsWith('/api/') && options.notFound)
      return options.notFound(request, reply);
    return reply
      .code(404)
      .send({ error: request.url.startsWith('/api/') ? 'Unknown API route' : 'Not found' });
  });
  // With a stress-test allowlist set, the invite joins charge the per-IP API limit in their
  // handler (server/links/invites.ts deferredApiLimit). A request refused before the handler
  // (bad JSON, content type, body size) is charged here instead, so it is never free.
  const DEFERRED_LIMIT_ROUTES = new Set([
    '/api/public/invites/bootstrap',
    '/api/public/invites/redeem',
  ]);
  const apiLimitDeferred = (method: string, path: string | undefined) =>
    method === 'POST' && DEFERRED_LIMIT_ROUTES.has(path ?? '') && stressTestOperators().size > 0;
  const reachedHandler = new WeakSet<FastifyRequest>();
  app.addHook('preHandler', async (request) => {
    reachedHandler.add(request);
  });
  app.setErrorHandler(async (error, _request, reply) => {
    if (
      !reachedHandler.has(_request) &&
      apiLimitDeferred(_request.method, _request.routeOptions.url)
    ) {
      try {
        await limit(`ip:${clientAddressKey(_request.ip)}`, caps.apiRequestsPerMinute, 60_000);
      } catch (limited) {
        error = limited as typeof error;
      }
    }
    // The Feed under database load, wherever the failure came from: the app's own request hook
    // (the session, key or token lookup of the rate limit), the flag check or a handler. Busy,
    // never the plain 500 (server/feed/busy.ts).
    if (
      isFeedPath(_request.url) &&
      (error instanceof FeedBusyError || transientDatabaseError(error))
    )
      return sendFeedBusy(reply, error);
    const retryAfterMs = (error as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof retryAfterMs === 'number')
      reply.header('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
    if (_request.url.startsWith('/api/runtime/a2a/')) {
      const response = a2aErrorResponse(
        // A2A keeps its JSON-RPC error shape; only the message names the fields.
        error instanceof z.ZodError ? new ApiError(400, describeValidation(error).message) : error,
        _request.body,
      );
      return reply
        .header('A2A-Version', A2A_PIN.wireVersion)
        .code(response.status)
        .send(response.body);
    }
    // Any other route under database load: busy (503, Retry-After), never the plain 500
    // (server/busy.ts). A2A keeps its JSON-RPC shape above.
    if (transientDatabaseError(error)) return sendDatabaseBusy(reply, error);
    // Field-level detail (paths and constraints only, never received values).
    if (error instanceof z.ZodError) return reply.code(400).send(validationErrorBody(error));
    const possible = error as { statusCode?: number; message?: string };
    // Stable machine-readable codes (messaging) accompany the message.
    const errorCode = (error as { errorCode?: unknown }).errorCode;
    const code =
      error instanceof ApiError
        ? error.statusCode
        : typeof possible.statusCode === 'number' &&
            ((possible.statusCode >= 400 && possible.statusCode < 500) ||
              // Only the ask timeout keeps its 503 (retryable, with Retry-After).
              (error instanceof ResultError &&
                error.statusCode === 503 &&
                errorCode === 'ask_timeout') ||
              // Base Pay: unavailable or no sponsor (503; nothing was sent, a retry may work).
              (error instanceof AgentPayError && error.statusCode === 503) ||
              // The Feed's search before its first complete sweep (503 source_unavailable,
              // retryable): never an empty success. Or under load (503 busy, with Retry-After).
              (error instanceof FeedToolError && error.statusCode === 503) ||
              // city_service_call: the service or Base could not be reached (502, 503; nothing
              // was signed or sent, a retry may work), or busy.
              (error instanceof FeedPayToolError && error.statusCode >= 500) ||
              // The responder provider could not be reached (502), or the feature has no root key (503).
              (error instanceof ResponderError &&
                (error.statusCode === 502 || error.statusCode === 503)))
          ? possible.statusCode
          : 500;
    if (code === 500) app.log.error('Request failed.');
    const issues = (error as { issues?: unknown }).issues;
    return reply.code(code).send({
      error:
        code === 500
          ? 'The operation could not be completed.'
          : (possible.message ?? 'Request rejected.'),
      ...(code !== 500 && typeof errorCode === 'string' ? { code: errorCode } : {}),
      // Machine-actionable manifest issues (autonomy routes) accompany the message.
      ...(code !== 500 && Array.isArray(issues) ? { issues } : {}),
      // Room facts for the caller (removed_from_room: the host's reason, may_rejoin).
      // Room task errors keep their REST shape (their details travel over MCP only).
      ...(code !== 500 &&
      error instanceof RoomError &&
      error.constructor === RoomError &&
      error.details !== undefined
        ? { details: error.details }
        : {}),
      // city_service_call's refusals (nothing signed, nothing sent): the same answer as over MCP,
      // retryable, retry_after_ms and details (amounts as USDC text, the reason, input problems).
      ...(code !== 500 && error instanceof FeedPayToolError ? feedPayRefusalFields(error) : {}),
    });
  });
  const limiter: RateLimiter =
    typeof options.rateLimiter === 'object'
      ? options.rateLimiter
      : (options.rateLimiter ?? (options.hosted ? 'postgres' : 'memory')) === 'postgres'
        ? new PostgresRateLimiter(db, clock)
        : new MemoryRateLimiter(clock);
  const principals = new PrincipalCache(clock);
  async function limit(key: string, max: number, window: number, message?: string): Promise<void> {
    const result = await limiter.hit(key, max, window);
    if (!result.allowed)
      throw new ApiError(
        429,
        message ?? 'Too many requests. Try again later.',
        result.retryAfterMs,
      );
  }
  /** A newsletter budget on sign-up/onboarding: false when spent (429), never a refusal there. */
  async function newsletterBudget(take: () => Promise<void>): Promise<boolean> {
    try {
      await take();
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 429) return false;
      throw error;
    }
  }
  /**
   * The newsletter opt-in after a committed sign-up or onboarding: any error is logged and the
   * opt-in skipped (no email queued), so the committed account always gets its normal reply.
   */
  async function bestEffortOptIn(request: FastifyRequest, run: () => Promise<void>) {
    try {
      await run();
    } catch (error) {
      request.log.warn({ err: error }, 'newsletter opt-in skipped');
    }
  }
  // Session renewal happens during the operator lookup, which only receives the request.
  const replies = new WeakMap<FastifyRequest, FastifyReply>();
  const renewedSessions = new WeakMap<FastifyRequest, number>();
  app.addHook('onRequest', async (request, reply) => {
    replies.set(request, reply);
    reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'same-origin');
    if (!request.url.startsWith('/api/')) return;
    const host = request.headers.host ?? '';
    const origin = request.headers.origin;
    if (options.hosted) {
      if (!checkHostedRequest(options.hosted, host, origin))
        fail(403, 'Host or origin is not allowed.');
    } else {
      let hostname: string;
      try {
        hostname = new URL(`http://${host}`).hostname;
      } catch {
        return fail(403, 'Invalid host.');
      }
      if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname))
        fail(403, 'This development server accepts localhost only.');

      if (origin) {
        let parsed: URL;
        try {
          parsed = new URL(origin);
        } catch {
          return fail(403, 'Invalid origin.');
        }
        if (parsed.host !== host || parsed.protocol !== `${request.protocol}:`)
          fail(403, 'Cross-origin requests are not allowed.');
      }
    }
    // Deferred for the invite joins while a stress-test allowlist is set (apiLimitDeferred).
    // Otherwise per principal for a valid session, workspace key, OAuth access token or guest room
    // credential, with a much higher per-address floor; per address without a valid credential
    // (shared cloud egress; rate-limit.ts limitRequestRate).
    if (!apiLimitDeferred(request.method, request.url.split('?')[0]))
      await limitRequestRate(
        limit,
        request.ip,
        presentedPrincipal(request.headers.authorization, request.cookies.cc_session, {
          guest: (token) => links.invites.verify(token),
          workspaceKey: (token) => workspaces.verifyKey(token),
          accessToken: (token) => oauthServer.verifyAccessToken(token, originOf(request)),
          session: async (token) =>
            (
              await db.query<{ operator_id: string }>(
                'SELECT operator_id FROM sessions WHERE token_hash=$1 AND expires_at>$2',
                [sha(token), clock()],
              )
            ).rows[0]?.operator_id ?? null,
        }),
        caps.apiRequestsPerMinute,
        principals,
      );
    const runtime = request.url.startsWith('/api/runtime/');
    // Anonymous creation carries no cookie authority, so it needs no CSRF header. Nor do the
    // newsletter link POSTs (the confirm/unsubscribe page buttons and the RFC 8058 one-click
    // unsubscribe from the mail client), authorized only by the signed link; docs/EMAIL.md.
    const newsletterLink =
      request.method === 'POST' &&
      (request.url.startsWith('/api/newsletter/unsubscribe?') ||
        request.url.startsWith('/api/newsletter/confirm?'));
    const cookieless = runtime || request.url.startsWith('/api/public/') || newsletterLink;
    if (!runtime && !['GET', 'HEAD'].includes(request.method)) {
      if (!cookieless && request.headers['x-city-request'] !== '1')
        fail(403, 'Missing request protection header.');
      if (!newsletterLink && !request.headers['content-type']?.startsWith('application/json'))
        fail(415, 'Use application/json.');
    }
  });
  const subscribers = new Map<string, Set<FastifyReply>>();
  const subscriptionSessions = new Map<FastifyReply, string>();
  function notify(operatorId: string): void {
    const message = `event: invalidate\ndata: ${JSON.stringify({ revision: randomUUID() })}\n\n`;
    for (const reply of subscribers.get(operatorId) ?? []) {
      if (reply.raw.writableEnded || reply.raw.destroyed) continue;
      if (!reply.raw.write(message)) reply.raw.end();
    }
  }
  async function readWorkspace(tx: Tx, operatorId: string, lock = false): Promise<Workspace> {
    if (!lock) {
      // Unlocked reads (snapshots) take the document, its presence rows and its inbound
      // connections in one round trip; the result is the same as the three reads below.
      const row = (
        await tx.query<{
          data: Workspace;
          presence: Parameters<typeof applyPresence>[1];
          inbound: Parameters<typeof inboundFromRows>[0];
        }>(
          `SELECT ws.data, ${PRESENCE_JSON_SQL} AS presence, ${INBOUND_JSON_SQL} AS inbound
             FROM workspaces ws WHERE ws.operator_id=$1`,
          [operatorId],
        )
      ).rows[0];
      if (!row) fail(401, 'Sign in to continue.');
      applyPresence(row.data, row.presence);
      attachInbound(row.data, inboundFromRows(row.inbound));
      return row.data;
    }
    const row = (
      await tx.query<{ data: Workspace }>(
        `SELECT data FROM workspaces WHERE operator_id=$1${lock ? ' FOR UPDATE' : ''}`,
        [operatorId],
      )
    ).rows[0];
    if (!row) fail(401, 'Sign in to continue.');
    // Runtime presence is authoritative in agent_presence (server/presence.ts).
    await overlayPresence(tx, operatorId, row.data);
    // Accepted cross-workspace connections, never persisted in the document (server/model.ts).
    attachInbound(row.data, await loadInbound(tx, operatorId));
    return row.data;
  }
  async function mutate<T>(
    operatorId: string,
    action: (workspace: Workspace, tx: Tx, time: number) => T | Promise<T>,
  ): Promise<T> {
    let changed = false;
    const result = await db.transaction(async (tx) => {
      const workspace = await readWorkspace(tx, operatorId, true);
      const before = JSON.stringify(workspace);
      const paused = pauseKey(workspace);
      const time = clock();
      syncWorkflows(workspace, time);
      const response = await action(workspace, tx, time);
      syncWorkflows(workspace, time);
      // Pausing or resuming the workspace or an agent suspends or restores its published
      // results, and withdraws or lists again its agents' Feed offers, in the same transaction,
      // whichever path changed the pause state.
      if (pauseKey(workspace) !== paused) {
        await syncResultSuspension(tx, operatorId, workspace, time);
        await syncOfferListing(tx, operatorId, workspace, time);
      }
      const after = JSON.stringify(workspace);
      changed = before !== after;
      if (changed)
        await tx.query('UPDATE workspaces SET data=$2::jsonb WHERE operator_id=$1', [
          operatorId,
          after,
        ]);
      return response;
    });
    if (changed) notify(operatorId);
    return result;
  }
  /** Locks several workspaces in sorted order (deadlock-free) and writes those that changed. */
  async function mutateMany<T>(
    operatorIds: string[],
    action: (workspaces: Map<string, Workspace>, tx: Tx, time: number) => T | Promise<T>,
  ): Promise<T> {
    const ids = [...new Set(operatorIds)].sort();
    const changed: string[] = [];
    const result = await db.transaction(async (tx) => {
      const time = clock();
      const workspaces = new Map<string, Workspace>();
      const before = new Map<string, string>();
      const paused = new Map<string, string>();
      for (const id of ids) {
        const workspace = await readWorkspace(tx, id, true);
        before.set(id, JSON.stringify(workspace));
        paused.set(id, pauseKey(workspace));
        syncWorkflows(workspace, time);
        workspaces.set(id, workspace);
      }
      const response = await action(workspaces, tx, time);
      for (const id of ids) {
        const workspace = workspaces.get(id)!;
        syncWorkflows(workspace, time);
        if (pauseKey(workspace) !== paused.get(id)) {
          await syncResultSuspension(tx, id, workspace, time);
          await syncOfferListing(tx, id, workspace, time);
        }
        const after = JSON.stringify(workspace);
        if (after === before.get(id)) continue;
        await tx.query('UPDATE workspaces SET data=$2::jsonb WHERE operator_id=$1', [id, after]);
        changed.push(id);
      }
      return response;
    });
    for (const id of changed) notify(id);
    return result;
  }
  /**
   * Appends one event to many workspaces in one statement (a room change told to up to 10,000
   * member owners), with the same 1,000-event window as model.ts event(). Rows are locked in
   * sorted order first, as mutateMany does, so it cannot deadlock with it.
   */
  async function appendEvents(
    entries: ReadonlyArray<{ operatorId: string; agentId: string | null }>,
    type: string,
    message: string,
    time: number,
  ): Promise<void> {
    if (!entries.length) return;
    const ids = entries.map((entry) => entry.operatorId);
    const changed = await db.transaction(async (tx) => {
      await tx.query(
        'SELECT 1 FROM workspaces WHERE operator_id = ANY($1::text[]) ORDER BY operator_id FOR UPDATE',
        [ids],
      );
      return (
        await tx.query<{ operator_id: string }>(
          `UPDATE workspaces w SET data = jsonb_set(w.data, '{events}',
              (CASE WHEN jsonb_array_length(COALESCE(w.data->'events', '[]'::jsonb)) >= 1000
                    THEN (w.data->'events') - 0 ELSE COALESCE(w.data->'events', '[]'::jsonb) END)
              || jsonb_build_array(jsonb_build_object('id', gen_random_uuid()::text, 'type', $3::text,
                   'message', $4::text, 'agentId', n.agent_id, 'jobId', NULL, 'createdAt', $5::text)))
            FROM unnest($1::text[], $2::text[]) AS n(operator_id, agent_id)
            WHERE w.operator_id = n.operator_id
            RETURNING w.operator_id`,
          [ids, entries.map((entry) => entry.agentId), type, message, iso(time)],
        )
      ).rows;
    });
    for (const row of changed) notify(row.operator_id);
  }
  async function optionalOperator(request: FastifyRequest): Promise<Operator | null> {
    const token = request.cookies.cc_session;
    if (!token || token.length > 128) return null;
    const hash = sha(token),
      time = clock();
    const row = (
      await db.query<
        Operator & {
          expires_at: string | number;
          created_at: string | number;
          salt: string;
          terms_version: string | null;
        }
      >(
        `SELECT o.id,o.name,o.salt,s.expires_at,s.created_at,a.version AS terms_version,
                EXISTS (SELECT 1 FROM elric_verified_identities v WHERE v.operator_id=o.id)
                  AS google_linked
           FROM operators o JOIN sessions s ON s.operator_id=o.id
           LEFT JOIN account_terms_acceptances a ON a.operator_id=o.id
          WHERE s.token_hash=$1 AND s.expires_at>$2`,
        [hash, time],
      )
    ).rows[0];
    if (!row) return null;
    // Onboarding gate (docs/GOOGLE_SIGNIN.md "Onboarding"): an account created with Google can
    // only reach the onboarding routes until it has a name and has accepted the current Terms
    // and Privacy Policy. Enforced here, where every session-authenticated route resolves.
    if (onboardingState(row).pending && !ONBOARDING_ROUTES.has(routeKey(request)))
      throw new OnboardingRequiredError();
    // Sliding renewal: activity extends the 24 h idle timeout, capped at 30 days after sign-in.
    // Throttled to one conditional UPDATE per hour per session, outside any transaction.
    const expiresAt = Number(row.expires_at),
      renewed = Math.min(time + SESSION_TTL_MS, Number(row.created_at) + SESSION_MAX_AGE_MS);
    if (expiresAt - time < SESSION_TTL_MS - SESSION_RENEW_INTERVAL_MS && renewed > expiresAt) {
      const updated = await db.query(
        'UPDATE sessions SET expires_at=$3 WHERE token_hash=$1 AND expires_at>$2 AND expires_at<$3 RETURNING token_hash',
        [hash, time, renewed],
      );
      if (updated.rows.length) {
        const maxAge = Math.floor((renewed - time) / 1000);
        renewedSessions.set(request, maxAge);
        const reply = replies.get(request);
        if (reply) setSessionCookie(reply, token, maxAge);
      }
    }
    return { id: row.id, name: row.name };
  }
  /** The method and path (no query) of a request, as ONBOARDING_ROUTES lists them. */
  function routeKey(request: FastifyRequest): string {
    return `${request.method} ${request.url.split('?')[0]}`;
  }
  function sessionCookieOptions(maxAge: number) {
    return {
      httpOnly: true,
      secure: options.hosted ? true : (options.secureCookies ?? false),
      sameSite: 'strict' as const,
      path: '/',
      maxAge,
    };
  }
  function setSessionCookie(reply: FastifyReply, token: string, maxAge: number): void {
    reply.setCookie('cc_session', token, sessionCookieOptions(maxAge));
  }
  /** The signed-in person (session cookie), whatever workspace the request selects. */
  async function person(request: FastifyRequest): Promise<Operator> {
    return (await optionalOperator(request)) ?? fail(401, 'Sign in to continue.');
  }
  /**
   * The workspace a console request acts in: the signed-in person's own, or an AI-owned workspace
   * they co-own, selected with the X-City-Workspace header (the event stream, which cannot send
   * headers, uses ?workspace=). Co-ownership is an operator_links row (docs/AI_WORKSPACES.md);
   * everything downstream stays scoped by the one returned operator id.
   */
  async function owner(request: FastifyRequest): Promise<Operator> {
    const human = await person(request);
    const header = request.headers['x-city-workspace'];
    const query = request.url.startsWith('/api/events?')
      ? new URLSearchParams(request.url.slice(request.url.indexOf('?') + 1)).get('workspace')
      : null;
    const selected = typeof header === 'string' ? header : query;
    if (!selected || selected === human.id) return human;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(selected))
      fail(404, 'Workspace not found.');
    const row = (
      await db.query<Operator>(
        "SELECT o.id,o.name FROM operator_links l JOIN operators o ON o.id=l.ai_operator_id AND o.kind='ai' WHERE l.human_operator_id=$1 AND l.ai_operator_id=$2",
        [human.id, selected],
      )
    ).rows[0];
    return row ?? fail(404, 'Workspace not found.');
  }
  async function session(tx: Tx, reply: FastifyReply, operatorId: string): Promise<void> {
    // Sign-ins idle out after 24 h (activity renews them, 30-day cap), up to SESSIONS_PER_ACCOUNT
    // browsers per account (the oldest is signed out; token_hash breaks created_at ties).
    const token = randomBytes(32).toString('base64url'),
      time = clock();
    await tx.query('DELETE FROM sessions WHERE expires_at<=$1', [time]);
    await tx.query(
      'DELETE FROM sessions WHERE operator_id=$1 AND token_hash IN (SELECT token_hash FROM sessions WHERE operator_id=$1 ORDER BY created_at DESC, token_hash DESC OFFSET $2)',
      [operatorId, SESSIONS_PER_ACCOUNT - 1],
    );
    await tx.query(
      'INSERT INTO sessions (token_hash,operator_id,expires_at,created_at) VALUES ($1,$2,$3,$4)',
      [sha(token), operatorId, time + SESSION_TTL_MS, time],
    );
    setSessionCookie(reply, token, SESSION_TTL_MS / 1000);
  }
  function ensureAgent(workspace: Workspace, id: string): StoredAgent {
    return workspace.agents.find((agent) => agent.id === id) ?? fail(404, 'Agent not found.');
  }
  function ensureJob(workspace: Workspace, id: string): StoredJob {
    return workspace.jobs.find((job) => job.id === id) ?? fail(404, 'Job not found.');
  }
  async function currentRuntimeAgent(
    workspace: Workspace,
    tx: Tx,
    identity: RuntimeIdentity,
  ): Promise<StoredAgent> {
    const agent = ensureAgent(workspace, identity.agentId);
    const current = await tx.query(
      'SELECT agent_id FROM credentials WHERE agent_id=$1 AND operator_id=$2 AND token_hash=$3',
      [identity.agentId, identity.operatorId, identity.credentialHash],
    );
    if (agent.revokedAt || agent.mode !== 'external' || !current.rows.length)
      fail(401, 'Invalid runtime credential.');
    return agent;
  }
  function mutateRuntime<T>(
    identity: RuntimeIdentity,
    action: (workspace: Workspace, agent: StoredAgent, time: number) => T | Promise<T>,
  ): Promise<T> {
    return mutate(identity.operatorId, async (workspace, tx, time) => {
      // Authentication and mutation are separate transactions. Recheck the exact credential
      // under the workspace lock so a rotation between them cannot revive old authority.
      const agent = await currentRuntimeAgent(workspace, tx, identity);
      return action(workspace, agent, time);
    });
  }
  async function runtime(
    request: FastifyRequest,
    options: { query?: boolean } = {},
  ): Promise<RuntimeIdentity> {
    const authorization = request.headers.authorization ?? '';
    if (!authorization.startsWith('Bearer ') || authorization.length > 160)
      fail(401, 'Invalid runtime credential.');
    const token = authorization.slice(7);
    const credential = (
      await db.query<{ operator_id: string; agent_id: string; token_hash: string }>(
        'SELECT operator_id,agent_id,token_hash FROM credentials WHERE token_hash=$1',
        [sha(token)],
      )
    ).rows[0];
    if (!credential || !constantEqual(credential.token_hash, sha(token)))
      fail(401, 'Invalid runtime credential.');
    // An owner that has not finished onboarding (a Google account without a Terms acceptance)
    // cannot act through its agents' existing credentials either.
    await assertOnboarded(credential.operator_id);
    const identity: RuntimeIdentity = {
      operatorId: credential.operator_id,
      agentId: credential.agent_id,
      credentialHash: credential.token_hash,
    };
    await limit(`runtime:${credential.agent_id}`, 120, 60_000);
    const stamp = request.headers['x-cc-timestamp'],
      nonce = request.headers['x-cc-nonce'],
      signature = request.headers['x-cc-signature'];
    if (
      typeof stamp !== 'string' ||
      !/^\d{13}$/.test(stamp) ||
      Math.abs(clock() - Number(stamp)) > 60_000 ||
      typeof nonce !== 'string' ||
      !/^[a-zA-Z0-9_-]{16,128}$/.test(nonce) ||
      typeof signature !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(signature)
    )
      fail(401, 'Invalid or expired runtime signature.');
    // Routes that take query parameters sign the full request target (path and query).
    const pathname = options.query ? request.url : request.url.split('?')[0];
    if (!options.query && request.url.includes('?'))
      fail(400, 'Runtime query parameters are not supported.');
    const payload = `${request.method}\n${pathname}\n${stamp}\n${nonce}\n${sha(request.rawBody ?? '')}`;
    const expected = createHmac('sha256', token).update(payload).digest('hex');
    if (!constantEqual(signature.toLowerCase(), expected))
      fail(401, 'Invalid or expired runtime signature.');
    // Locks only this agent's presence row; never the owner's workspace row.
    const accepted = await db.transaction((tx) =>
      acceptNonce(tx, identity, nonce, clock(), caps.replayNoncesPerAgent),
    );
    if (accepted === 'unauthorized') fail(401, 'Invalid runtime credential.');
    if (accepted === 'capacity') fail(429, 'Runtime replay capacity reached.');
    if (accepted === 'replayed') fail(409, 'Runtime request was already used.');
    return identity;
  }

  /** 403 onboarding_required for an account that has not finished onboarding (bearer paths). */
  const assertOnboarded = (operatorId: string) => assertOnboardedIn(db, operatorId);
  /** Onboarding status of a signed-in account (for /api/session and the onboarding route). */
  const onboardingOf = (operatorId: string) => onboardingOfIn(db, operatorId);
  const onboardingInput = z
    .object({
      name: authSchema.shape.name.optional(),
      terms_version: z.string().max(32),
      accept_terms: z.literal(true),
      // The newsletter opt-in (unticked by default, never required; docs/EMAIL.md).
      newsletter: z.boolean().optional(),
    })
    .strict();
  // Finish onboarding: the account name (if still needed) and the Terms/Privacy acceptance, with
  // its version and time. Session only; one of the few routes open during onboarding.
  app.post('/api/auth/onboarding', async (request) => {
    const signedIn = (await optionalOperator(request)) ?? fail(401, 'Sign in to continue.');
    await limit(`register:onboarding:${signedIn.id}`, 20, 15 * 60_000);
    const input = onboardingInput.parse(request.body ?? {});
    if (input.terms_version !== TERMS_VERSION)
      throw Object.assign(
        new ApiError(
          409,
          'The Terms were updated. Reload the page and accept the current version.',
        ),
        { errorCode: 'terms_version_outdated' },
      );
    const name = await db.transaction(async (tx) => {
      const row = (
        await tx.query<{ name: string; salt: string }>(
          'SELECT name,salt FROM operators WHERE id=$1 FOR UPDATE',
          [signedIn.id],
        )
      ).rows[0]!;
      let current = row.name;
      if (row.salt === GOOGLE_SALT_PENDING_NAME) {
        if (!input.name) fail(400, 'Choose an account name.');
        const taken = (
          await tx.query('SELECT 1 FROM operators WHERE name_key=$1 AND id<>$2', [
            input.name.toLowerCase(),
            signedIn.id,
          ])
        ).rows.length;
        if (taken) fail(409, 'That account name is unavailable.');
        try {
          await tx.query('UPDATE operators SET name=$2, name_key=$3, salt=$4 WHERE id=$1', [
            signedIn.id,
            input.name,
            input.name.toLowerCase(),
            GOOGLE_SALT_NO_PASSWORD,
          ]);
        } catch (error) {
          // A concurrent claim of the same name passed the check: the unique name_key refuses
          // ours. Throwing rolls the (now aborted) transaction back.
          if ((error as { code?: string }).code === '23505')
            fail(409, 'That account name is unavailable.');
          throw error;
        }
        current = input.name;
      }
      await recordAcceptance(tx, signedIn.id);
      // A new account created with Google: the welcome email, queued once (only when sending is on).
      if (row.salt === GOOGLE_SALT_PENDING_NAME || row.salt === GOOGLE_SALT_NO_PASSWORD)
        await email.queueWelcome(tx, signedIn.id, current, requestOrigin(request, options.hosted));
      return current;
    });
    // The opt-in goes to the Google account's verified address, only after onboarding is
    // committed: a refused attempt spends no recipient budget, and a spent one (null) skips the
    // opt-in and never blocks onboarding.
    // Best effort: onboarding is already committed, so an error here is logged and skipped.
    if (input.newsletter === true)
      await bestEffortOptIn(request, async () => {
        const admission = await email.admitOptIn(signedIn.id, 'onboarding');
        if (admission)
          await db.transaction((tx) =>
            email.optIn(tx, admission, requestOrigin(request, options.hosted)),
          );
      });
    // Sent after the response path is free (never blocking sign-up); the cron drain retries.
    email.kick();
    return { operator: { id: signedIn.id, name }, onboarding: await onboardingOf(signedIn.id) };
  });
  app.get('/api/session', async (request) => {
    const operator = await optionalOperator(request);
    return {
      operator,
      // Present for a signed-in account; `required` sends the app to the onboarding screen.
      ...(operator
        ? {
            onboarding: {
              ...(await onboardingOf(operator.id)),
              // Whether onboarding offers the newsletter opt-in (the account has a Google address).
              newsletter_available: (await email.emailOf(db, operator.id)) !== null,
            },
          }
        : {}),
      // One probe of the operators_owner partial index (migration 59), not a count of every
      // operator: unclaimed partitions make that table grow with every agent.
      setupRequired: !(
        await db.query<{ any: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM operators WHERE kind='owner') AS any",
        )
      ).rows[0]?.any,
    };
  });
  /**
   * Creates an owner account and its workspace (shared by the password sign-up and Continue with
   * Google; a Google-only account's hash and salt: google/routes.ts). No table lock: the unique
   * name_key settles concurrent sign-ups for one name. `caps.operators` is 0 (no ceiling) unless
   * CITY_LIMIT_OPERATORS is set as an emergency brake; that check is a plain count.
   */
  async function createOwner(
    tx: Tx,
    id: string,
    name: string,
    hash: string,
    salt: string,
  ): Promise<'created' | 'limit' | 'name_taken'> {
    if (caps.operators > 0) {
      const count = Number(
        (await tx.query<{ count: string }>("SELECT count(*) FROM operators WHERE kind='owner'"))
          .rows[0]?.count,
      );
      if (count >= caps.operators) return 'limit';
    }
    const inserted = await tx.query(
      `INSERT INTO operators(id,name,name_key,password_hash,salt,created_at) VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (name_key) DO NOTHING RETURNING id`,
      [id, name, name.toLowerCase(), hash, salt, clock()],
    );
    if (!inserted.rows.length) return 'name_taken';
    const workspace = emptyWorkspace();
    event(workspace, clock(), 'operator.created', 'Operator account created.');
    await tx.query('INSERT INTO workspaces(operator_id,data) VALUES($1,$2::jsonb)', [
      id,
      JSON.stringify(workspace),
    ]);
    return 'created';
  }
  /** Records an acceptance of the current Terms/Privacy version (latest row and history). */
  async function recordAcceptance(tx: Tx, operatorId: string): Promise<void> {
    const acceptedAt = clock();
    await tx.query(
      `INSERT INTO account_terms_acceptances(operator_id,version,accepted_at) VALUES($1,$2,$3)
       ON CONFLICT (operator_id) DO UPDATE SET version=EXCLUDED.version, accepted_at=EXCLUDED.accepted_at`,
      [operatorId, TERMS_VERSION, acceptedAt],
    );
    // The history keeps every acceptance (append-only); the row above is only the latest.
    await tx.query(
      'INSERT INTO account_terms_acceptance_history(operator_id,version,accepted_at) VALUES($1,$2,$3)',
      [operatorId, TERMS_VERSION, acceptedAt],
    );
  }
  app.post('/api/auth/register', async (request, reply) => {
    await limit(
      `register:${clientAddressKey(request.ip)}`,
      caps.registrationsPerWindow,
      15 * 60_000,
    );
    const { name, password, newsletter, email: address } = registerSchema.parse(request.body);
    const salt = randomBytes(16).toString('hex'),
      hash = await passwordHash(password, salt);
    const operator = { id: randomUUID(), name };
    await db.transaction(async (tx) => {
      const created = await createOwner(tx, operator.id, name, hash, salt);
      if (created === 'limit') fail(409, 'Account limit reached.');
      if (created === 'name_taken') fail(409, 'That account name is unavailable.');
      // The sign-up form states that creating the account accepts the Terms and Privacy Policy.
      await recordAcceptance(tx, operator.id);
      await session(tx, reply, operator.id);
    });
    // The newsletter opt-in (unticked by default): a pending sign-up and its confirmation email.
    // Without the tick no address is collected or stored. Only after the account is committed, so
    // a refused sign-up spends no newsletter budget, and a spent budget skips the opt-in.
    if (newsletter && address) {
      // Best effort: the account is already committed, so an error here is logged and skipped.
      await bestEffortOptIn(request, async () => {
        // The ticked box queues an email: the same per-address budget as settings.
        const addressAllowed = await newsletterBudget(() =>
          limit(
            `newsletter:address:${clientAddressKey(request.ip)}`,
            NEWSLETTER_RATE.perAddress,
            NEWSLETTER_RATE.windowMs,
          ),
        );
        const admission = addressAllowed
          ? await email.admitOptIn(operator.id, 'signup', address)
          : null;
        if (admission)
          await db.transaction((tx) =>
            email.optIn(tx, admission, requestOrigin(request, options.hosted)),
          );
      });
      email.kick();
    }
    return reply.code(201).send({ operator });
  });
  // Known-device cookie: a browser that has signed in to an account before carries an HMAC of
  // the operator id, which exempts it from the account-wide failure ceiling (not from the
  // per-source budget). Stateless and unforgeable without the server secret, so an attacker
  // spreading failures across many sources cannot lock the owner's own browser out.
  const deviceSecret = process.env.CITY_RATE_LIMIT_KEY || randomBytes(32).toString('base64url');
  const deviceToken = (operatorId: string) =>
    createHmac('sha256', deviceSecret).update(`known-device:${operatorId}`).digest('base64url');
  function rememberDevice(reply: FastifyReply, operatorId: string): void {
    reply.setCookie('cc_device', deviceToken(operatorId), {
      httpOnly: true,
      secure: options.hosted ? true : (options.secureCookies ?? false),
      sameSite: 'strict',
      path: '/',
      maxAge: 180 * 24 * 60 * 60,
    });
  }
  /** Password check shared by the owner login and the OAuth consent page; callers rate-limit. */
  async function authenticate(
    values: unknown,
    address: string,
    request: FastifyRequest,
  ): Promise<Operator> {
    const { name, password } = authSchema.parse(values);
    const nameKey = name.toLowerCase();
    // Budgets apply to submitted names whether or not they exist, so lockout never reveals which
    // accounts exist. The per-source attempt is counted atomically before the slow password
    // check, so parallel requests cannot exceed it. The account-wide failure ceiling does not
    // apply to a browser that previously signed in to this account (known-device cookie).
    const accountKey = `login-fail:account:${nameKey}`;
    const attempt = await limiter.hit(
      `login-attempt:${nameKey}:${address}`,
      LOGIN_FAILURES.perAccountAddress,
      LOGIN_FAILURES.windowMs,
    );
    if (!attempt.allowed)
      throw new ApiError(
        429,
        'Too many failed sign-in attempts. Try again later.',
        attempt.retryAfterMs,
      );
    const row = (
      await db.query<OperatorRow>(
        "SELECT id,name,password_hash,salt FROM operators WHERE name_key=$1 AND kind='owner'",
        [nameKey],
      )
    ).rows[0];
    const device = request.cookies.cc_device;
    const knownDevice = Boolean(row && device && constantEqual(device, deviceToken(row.id)));
    const accountFailures = knownDevice
      ? 0
      : await limiter.count(accountKey, LOGIN_FAILURES.windowMs);
    if (accountFailures >= LOGIN_FAILURES.perAccount)
      throw new ApiError(
        429,
        'Too many failed sign-in attempts. Try again later.',
        // A fail-closed outage reads as exhausted: retry shortly. Otherwise, at most the window.
        accountFailures === Number.MAX_SAFE_INTEGER
          ? FAIL_CLOSED_RETRY_MS
          : LOGIN_FAILURES.windowMs,
      );
    const hash = await passwordHash(password, row?.salt ?? 'central-city-invalid-account-salt');
    if (!row || !constantEqual(row.password_hash, hash)) {
      await limiter.hit(accountKey, LOGIN_FAILURES.perAccount, LOGIN_FAILURES.windowMs);
      fail(401, 'Invalid account name or password.');
    }
    return { id: row.id, name: row.name };
  }
  app.post('/api/auth/login', async (request, reply) => {
    await limit(`login:${clientAddressKey(request.ip)}`, 20, 15 * 60_000);
    const operator = await authenticate(request.body, clientAddressKey(request.ip), request);
    await db.transaction((tx) => session(tx, reply, operator.id));
    rememberDevice(reply, operator.id);
    return { operator };
  });
  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies.cc_session;
    if (token) {
      const hash = sha(token);
      await db.query('DELETE FROM sessions WHERE token_hash=$1', [hash]);
      for (const [client, clientHash] of subscriptionSessions)
        if (clientHash === hash) client.raw.end();
    }
    reply.clearCookie('cc_session', {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: options.hosted ? true : (options.secureCookies ?? false),
    });
    return { ok: true };
  });
  registerShortLinks(app, {
    db,
    originOf: (request) => requestOrigin(request, options.hosted),
    page: options.passportPage,
    // The same per-IP limit as the card route it used to request.
    limit: (request) =>
      limit(`ip:${clientAddressKey(request.ip)}`, caps.apiRequestsPerMinute, 60_000),
  });
  // Keys, bundler and RPC from the environment; a missing setting answers 503 (fails closed).
  const baseRuntimes = chainRuntimes(db, process.env, { hosted: Boolean(options.hosted) });
  // Feed offers' built-in kinds (server/feed/offers/kind-core.ts): their one Base reader, set once
  // here. Without the Base mainnet gate and endpoint it is null and the Base kinds answer
  // 'unavailable' (503); the web kind's safe fetcher is the process default.
  setOfferKindDeps({
    readBase: offerBaseReaderFromEnv(process.env, { hosted: Boolean(options.hosted) }),
  });
  registerBaseRegistrationRoutes(app, {
    db,
    env: process.env,
    // The selected workspace, like every console route (a co-owned AI workspace via
    // X-City-Workspace, else 404); signed out stays null, which the routes answer with 401.
    currentOperator: async (request) => ((await optionalOperator(request)) ? owner(request) : null),
    // With wallets on, a new registration's wallet is owned by this person's wallet key.
    currentPerson: optionalOperator,
    runtime: baseRuntimes,
    cronSecret: process.env.CRON_SECRET,
  });
  // Operation Base Wallet (behind CITY_BASE_WALLET=1): the person's owner vault and each agent's
  // wallet on the wallet network (shared/base/wallet-network.ts). Balances, spend permissions and
  // Pay's recipient check (ownerOf at one block) are read through that network's configured
  // endpoint, on Base only with its gate open (walletReaders); without them a balance read answers
  // 503, a limit view is stale, a recipient is not verified, and nothing is invented.
  let limitOperations: ReturnType<typeof ownerRevokePortFromEnv> | null = null;
  registerBaseWalletRoutes(app, {
    db,
    env: process.env,
    currentPerson: optionalOperator,
    currentWorkspace: async (request) =>
      (await optionalOperator(request)) ? owner(request) : null,
    runtime: baseRuntimes,
    ...walletReaders(process.env, { hosted: Boolean(options.hosted) }),
    // Built on first use; a missing setting answers 503 and is not cached.
    limitOperations: async () =>
      (limitOperations ??= ownerRevokePortFromEnv(db, process.env, WALLET_CHAIN_ID, {
        hosted: Boolean(options.hosted),
      })),
    limit,
    // The withdrawals sweep (vercel.json crons): expired and finished operations release the
    // sponsor's exposure even when nobody reads them.
    cronSecret: process.env.CRON_SECRET,
    now: clock,
  });
  // The Agent Explorer's On Base view: public, read-only, cached. The server reads Base (the head
  // and ownerOf) through the configured Base endpoint, else (hosted only) the public one; locally
  // and in tests without either, owners and readAt come from the stored evidence instead.
  const onBaseUrl =
    process.env[BASE_NETWORKS[BASE_MAINNET].bundlerEnv]?.trim() ||
    (options.hosted ? PUBLIC_BASE_RPC : undefined);
  const onBaseRegistry = BASE_NETWORKS[BASE_MAINNET].contracts.identityRegistry;
  // The explorer's reads fall back to a second, keyless endpoint (Base's public RPC unless set):
  // the configured endpoint also carries the paymaster and every wallet read, and a busy moment
  // there must not leave the public list showing an old block.
  const onBaseFallback =
    process.env.CITY_BASE_READ_FALLBACK_RPC_URL?.trim() ||
    (options.hosted ? PUBLIC_BASE_RPC : undefined);
  const onBaseUrls = onBaseUrl
    ? [onBaseUrl, ...(onBaseFallback && onBaseFallback !== onBaseUrl ? [onBaseFallback] : [])]
    : [];
  registerOnBaseRoutes(app, {
    db,
    limit,
    chain:
      onBaseUrl && onBaseRegistry
        ? baseChainReader(
            onBaseUrls,
            BASE_MAINNET,
            onBaseRegistry,
            undefined,
            BASE_NETWORKS[BASE_MAINNET].contracts.reputationRegistry,
          )
        : undefined,
  });
  // The Agent Explorer's Service calls view: every paid service call on Base mainnet as its
  // transaction (server/base/explorer/calls.ts). Public, read-only, cached; it shares the paid
  // calls counter reader with the homepage stats, so both read that row at most once per 5 s.
  const paidCallsReader = createPaidCallsReader({ db, clock });
  registerServiceCallsRoutes(app, { db, limit, now: clock, counter: paidCallsReader });
  // Operation Directory D1: the public directory search and the owner's "Show in the directory"
  // settings per agent (server/directory/routes.ts), listing on the explorer's network.
  registerDirectoryRoutes(app, {
    db,
    limit,
    // The selected workspace owns the agent (as every /api/agents/:id route checks it).
    owns: async (request, agentId) => {
      if (!(await optionalOperator(request))) return 'signed_out';
      const operator = await owner(request);
      const workspace = await readWorkspace(db, operator.id);
      return workspace.agents.some((agent) => agent.id === agentId) ? 'ok' : 'not_found';
    },
  });
  // Operation Central City Feed, requests side (server/feed/routes.ts): every route answers 404
  // while CITY_FEED is '0'. Locally without CITY_RATE_LIMIT_KEY, a per-process secret keys
  // the address hashes; hosted deployments must set it (writes fail without it).
  const feedLocalSecret = options.hosted ? undefined : randomBytes(32).toString('base64url');
  // One JSON line per event on the console (the app's own logger is off), never an address; a
  // request held or hidden for review also alerts CITY_OPS_ALERT_WEBHOOK when set (throttled).
  const feedLog = feedEventLog(process.env, options.logLine ? { log: options.logLine } : {});
  // One instance for the routes and city_request_search, so both read the same list.
  const feedRequests = createFeedRequests({
    db,
    clock,
    limit,
    caps: feedCaps(),
    secret: () => process.env.CITY_RATE_LIMIT_KEY || feedLocalSecret,
    log: feedLog,
  });
  registerFeedRoutes(app, {
    requests: feedRequests,
    limit,
    // The session counts only with the console's request header (a public POST skips that guard).
    // Only the workspace: the person's sign-in name is never published on the Feed.
    signedIn: async (request) => {
      if (request.headers['x-city-request'] !== '1' || !request.cookies.cc_session) return null;
      if (!(await optionalOperator(request))) return null;
      return { ownerId: (await owner(request)).id };
    },
    agentOf: async (ownerId, agentId) => {
      const agent = (await readWorkspace(db, ownerId)).agents.find(
        (item) => item.id === agentId && !item.revokedAt,
      );
      return agent ? { id: agent.id, name: agent.name } : null;
    },
    // The Offered numbers of the status route (server/feed/query.ts).
    services: () => feedServicesStatus(db, clock()),
  });
  // The operators' review queue of held and hidden requests and the posting pause
  // (server/feed/review.ts): CITY_OPS_SECRET and the Feed on, read per request; 404 otherwise.
  // A release holds the open caps posting holds.
  registerFeedReviewRoutes(app, {
    db,
    clock,
    env: process.env,
    log: feedLog,
    caps: feedRequests.caps,
  });
  // Creates fee router 3's facilitator key inside the app (CITY_OPS_SECRET; 409 once configured),
  // so the production KEK and database never leave the platform (server/protocol/x402).
  registerFacilitatorKeyRoute(app, { db, env: process.env });
  // The sponsored first purchase's ops numbers (server/feed/pay/sponsor-routes.ts; CITY_OPS_SECRET).
  registerSponsorStatsRoute(app, { db, env: process.env, now: clock });
  // Creates the sponsor account's key inside the app (CITY_OPS_SECRET; 409 once configured).
  registerSponsorKeyRoute(app, { db, env: process.env, now: clock });
  registerOwnPaymasterKeysRoute(app, { db, env: process.env, now: clock });
  // Operation Paymaster prepare mode: the server provisions its own keys (no ops secret needed)
  // and publishes only their public addresses. Never blocks or fails the start.
  registerPaymasterPublicRoute(app, {
    db,
    env: process.env,
    chainId: BASE_MAINNET,
    entryPoint: BASE_NETWORKS[BASE_MAINNET].contracts.entryPointV06,
    effective: async () => (await baseRuntimes(BASE_MAINNET)).ownBundlerEffective?.(),
  });
  // Our own bundler's upkeep (direct-bundler.ts maintain), every minute; 'off' unless
  // CITY_BASE_BUNDLER=direct is in effect.
  registerOwnBundlerMaintainRoute(app, {
    cronSecret: process.env.CRON_SECRET,
    upkeep: async () => (await baseRuntimes(BASE_MAINNET)).ownBundlerUpkeep,
  });
  // Awaited (a frozen serverless instance would drop a background promise), but never longer
  // than 3 s and never thrown: the site starts whatever happens here.
  const paymasterKeys = await Promise.race([
    provisionPaymasterKeysAtStart({ db, env: process.env, now: clock }),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3_000).unref()),
  ]);
  if (paymasterKeys !== 'off') app.log.info({ event: 'own_paymaster_keys', state: paymasterKeys });
  // Operation Central City Feed (live unless CITY_FEED=0, read per request): the services the Feed
  // lists as Offered, read from the x402 Bazaar (server/feed/services-routes.ts). Public and read-only. The status
  // route (FEED_PATHS.status) is the requests slice's; it takes feedServicesStatus (query.ts).
  registerFeedServiceRoutes(app, { db, env: process.env, limit, now: clock });
  // Its Bazaar sweep (server/feed/cron.ts; vercel.json crons, every 15 minutes; CRON_SECRET): a
  // sweep in progress resumes where the last run stopped, never in the noon checkpoint's window.
  registerFeedCron(app, {
    db,
    env: process.env,
    cronSecret: process.env.CRON_SECRET,
    now: clock,
    // A Bazaar record on the host Central City serves its own offers from is never a row
    // ('hosted_here'): it is listed from its offer (server/feed/offers/store.ts).
    hostedHost: options.hosted ? new URL(options.hosted.publicOrigin).hostname : null,
    // Each run first recomputes the use counts of the services sold by Central City agents from
    // their settled Feed pay calls (server/feed/offers/uses.ts).
    hostedUses: (at) => refreshHostedUses(db, at),
    ...(options.feed?.fetch ? { fetch: options.feed.fetch } : {}),
    ...(options.logLine ? { log: options.logLine } : {}),
  });
  // Operation Protocol fees (docs/protocol/FEES.md, LIVE.md): the public daily metrics and the
  // ledger scan (vercel.json crons; CRON_SECRET), live by default on Base mainnet with the router,
  // treasury and start block fixed in code (shared/protocol.ts). Both answer 404 while
  // CITY_PROTOCOL_FEES is '0'. The scan reads Base through CITY_PROTOCOL_RPC_URL, else the wallet
  // network's RPC (CITY_BASE_CDP_RPC_URL); without either it answers 503 unavailable.
  registerProtocolFeeRoutes(app, {
    db,
    clock,
    limit,
    chainId: () => protocolFeeChainId(process.env),
  });
  registerProtocolFeeCron(app, {
    db,
    env: process.env,
    cronSecret: process.env.CRON_SECRET,
    chainFor: protocolFeeChainFromEnv(process.env),
    ...(options.logLine ? { log: options.logLine } : {}),
  });
  const email = registerEmail(app, {
    db,
    clock,
    options: options.email,
    originOf: (request) => requestOrigin(request, options.hosted),
    elricEnabled: () => options.elric?.enabled ?? elricEnabled(),
    owner: person,
    cronSecret: process.env.CRON_SECRET,
    limit,
    clientKey: (request) => clientAddressKey(request.ip),
  });
  // Locally (not hosted), a worker drains the email queue every minute; Vercel Cron does it hosted.
  if (!options.hosted && options.startWorkers !== false) {
    const emailTimer = setInterval(() => {
      email.kick();
      void email.purge().catch(() => undefined);
    }, 60_000);
    emailTimer.unref();
    app.addHook('onClose', async () => clearInterval(emailTimer));
  }
  registerGoogleSignIn(app, {
    db,
    clock,
    limiter,
    session,
    currentPerson: optionalOperator,
    signup: {
      registrationsPerWindow: caps.registrationsPerWindow,
      create: createOwner,
    },
    hosted: options.hosted,
    secureCookies: options.secureCookies,
    options: options.google,
  });
  app.get('/api/snapshot', async (request) => {
    const operator = await owner(request);
    // include= only matters to a paged snapshot (shared/agent-pages.ts): the agents of the screen
    // asking for it. Other query parameters are ignored, as before.
    const include = agentIdsParam(
      z
        .object({ include: z.string().optional() })
        .passthrough()
        .parse(request.query ?? {}).include,
      AGENT_PAGES.include,
    );
    const view = (workspace: Workspace) =>
      snapshot(workspace, operator, clock(), include.length ? { include } : {});
    // Polling advances hosted demonstrations. Controls must apply without first
    // completing work that the operator is trying to cancel, pause or revoke.
    if (options.hosted) {
      // Most polls find nothing to advance: decide that from an unlocked read and answer from it,
      // without the locked tick transaction or a second read. A workspace with work to advance
      // takes the locked tick exactly as before.
      const current = await readWorkspace(db, operator.id);
      if (!advances(current, clock())) {
        await sweepExpired();
        return view(current);
      }
      await performTick(operator.id);
    }
    return view(await readWorkspace(db, operator.id));
  });
  // The owner's agents, one page at a time, newest first (shared/agent-pages.ts): how the console
  // lists and searches a workspace too large for the snapshot to carry whole. Reads only; it
  // advances no work. q= searches name, description and capability; ids= reads named agents;
  // under= lists the live agents a removal of that agent takes with it; live=1 leaves removed
  // agents out (the pickers of an agent to act as).
  app.get(AGENTS_PATH, async (request) => {
    const operator = await owner(request);
    const query = z
      .object({
        limit: z
          .string()
          .regex(/^\d{1,3}$/)
          .transform(Number)
          .pipe(z.number().int().min(1).max(AGENT_PAGES.max))
          .optional(),
        cursor: z.string().min(1).max(AGENT_PAGES.cursor).optional(),
        q: z.string().max(AGENT_PAGES.query).optional(),
        ids: z.string().optional(),
        under: z.string().uuid().optional(),
        live: z.literal('1').optional(),
      })
      .strict()
      .parse(request.query ?? {});
    const cursor = query.cursor === undefined ? null : decodeAgentCursor(query.cursor);
    if (query.cursor !== undefined && !cursor) fail(400, 'Invalid cursor.');
    const ids = query.ids === undefined ? undefined : agentIdsParam(query.ids, AGENT_PAGES.ids);
    const workspace = await readWorkspace(db, operator.id);
    return listAgents(workspace, clock(), {
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      cursor,
      ...(query.q?.trim() ? { q: query.q } : {}),
      ...(ids ? { ids } : {}),
      ...(query.under === undefined ? {} : { under: query.under }),
      ...(query.live ? { live: true } : {}),
    });
  });
  app.get('/api/events', async (request, reply) => {
    const operator = await owner(request);
    // 204 stops EventSource reconnecting; the UI already polls every 15 seconds.
    if (options.hosted) return reply.code(204).send();
    const clients = subscribers.get(operator.id) ?? new Set<FastifyReply>();
    if (clients.size >= 4) fail(429, 'Live connection limit reached.');
    const total = [...subscribers.values()].reduce((sum, set) => sum + set.size, 0);
    if (total >= 100) fail(429, 'Live connection limit reached.');
    reply.hijack();
    // A hijacked reply skips the cookie onSend hook, so a renewal is written here directly.
    const renewedMaxAge = renewedSessions.get(request);
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...(renewedMaxAge === undefined
        ? {}
        : {
            'Set-Cookie': app.serializeCookie(
              'cc_session',
              request.cookies.cc_session!,
              sessionCookieOptions(renewedMaxAge),
            ),
          }),
    });
    clients.add(reply);
    subscribers.set(operator.id, clients);
    const sessionHash = sha(request.cookies.cc_session!);
    subscriptionSessions.set(reply, sessionHash);
    reply.raw.write('retry: 3000\nevent: invalidate\ndata: {"connected":true}\n\n');
    const ping = setInterval(() => {
      void db
        .query('SELECT token_hash FROM sessions WHERE token_hash=$1 AND expires_at>$2', [
          sessionHash,
          clock(),
        ])
        .then((result) => {
          if (
            !result.rows.length ||
            (!reply.raw.writableEnded && !reply.raw.write(': keepalive\n\n'))
          )
            reply.raw.end();
        })
        .catch(() => reply.raw.end());
    }, 15_000);
    const expiry = setTimeout(() => reply.raw.end(), 5 * 60_000);
    ping.unref();
    expiry.unref();
    reply.raw.on('close', () => {
      clearInterval(ping);
      clearTimeout(expiry);
      clients.delete(reply);
      subscriptionSessions.delete(reply);
      if (!clients.size) subscribers.delete(operator.id);
    });
    return reply;
  });

  app.post('/api/agents', async (request, reply) => {
    const operator = await owner(request);
    const { visibility, ...rest } = z
      .object({ visibility: z.enum(['private', 'public']).optional() })
      .passthrough()
      .parse(request.body);
    const values = agentSchema.parse(rest);
    // Elric (docs/ELRIC.md): the name is reserved for first-party Elric agents.
    if (reservedName(values.name)) fail(409, ELRIC_RESERVED_NAME_MESSAGE);
    // A visibility choice needs a manifest, which only hosted agents get here: refuse it for
    // external agents instead of silently dropping the choice.
    if (visibility && values.mode !== 'hosted')
      fail(400, 'Visibility can only be chosen for hosted agents.');
    // With a visibility choice, a hosted agent is created like city_create_agent does: from a
    // manifest (template by capability), so it has a signed Agent Card and, when public, a public
    // profile that agent explorers and the Base registration can use.
    if (visibility && values.mode === 'hosted') {
      const created = await mutate(operator.id, async (workspace, tx, time) => {
        if (workspace.agents.length >= caps.agentsPerWorkspace)
          fail(409, `Local workspace limit of ${caps.agentsPerWorkspace} agents reached.`);
        const base = values.name
          .normalize('NFKD')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 48);
        const result = await autonomy.service.createAgentTool(
          tx,
          workspace,
          time,
          {
            mode: 'owned',
            operatorId: operator.id,
            createdBy: { kind: 'owner', id: operator.id },
            rootSponsor: operator.id,
            label: operator.name,
            canConnect: true,
            origin: requestOrigin(request, options.hosted),
          },
          {
            manifest: {
              apiVersion: 'centralcity.agent/v1',
              kind: 'Agent',
              metadata: {
                // Unique per agent, so two agents with the same display name never merge.
                name: `${base || 'agent'}-${randomBytes(3).toString('hex')}`,
                displayName: values.name,
                description: values.description,
              },
              spec: { extends: CAPABILITY_TEMPLATES[values.capability], visibility },
            },
            idempotency_key: randomUUID(),
          },
        );
        // Remembered on the agent so the owner's pages know whether it has a public profile.
        const stored =
          result.agent && workspace.agents.find((item) => item.id === result.agent!.id);
        if (stored) stored.visibility = visibility;
        return result.agent ? { ...result, agent: { ...result.agent, visibility } } : result;
      });
      if (!('agent_card_url' in created) || !created.agent) fail(500, 'The agent was not created.');
      return reply.code(201).send({ agent: created.agent, agent_card_url: created.agent_card_url });
    }
    const response = await mutate(operator.id, async (workspace, tx, time) => {
      if (workspace.agents.length >= caps.agentsPerWorkspace)
        fail(409, `Local workspace limit of ${caps.agentsPerWorkspace} agents reached.`);
      const agent: StoredAgent = {
        id: randomUUID(),
        ...values,
        isDemo: values.mode === 'hosted',
        lastSeenAt: null,
        createdAt: iso(time),
        revokedAt: null,
        lastSequence: -1,
        announcedOnline: false,
      };
      workspace.agents.push(agent);
      event(
        workspace,
        time,
        'agent.registered',
        `${agent.name} registered as ${agent.mode === 'hosted' ? 'a deterministic demonstration' : 'an external runtime'}.`,
        agent.id,
      );
      let token: string | undefined;
      if (agent.mode === 'external') {
        token = randomBytes(32).toString('base64url');
        await tx.query(
          'INSERT INTO credentials(token_hash,operator_id,agent_id) VALUES($1,$2,$3)',
          [sha(token), operator.id, agent.id],
        );
        agent.credentialHint = token.slice(-4);
      }
      return { agent: ownerAgent(agent, workspace.jobs, time), ...(token ? { token } : {}) };
    });
    return reply.code(201).send(response);
  });
  app.post('/api/agents/:id/revoke', async (request) => {
    const operator = await owner(request),
      id = idFrom(request);
    return mutate(operator.id, async (workspace, tx, time) => {
      const agent = ensureAgent(workspace, id);
      // Revocation cascades down the parentAgentId lineage (agents created under this one).
      const targets = [agent, ...descendants(workspace, agent.id)];
      await refuseElric(
        tx,
        targets.map((item) => item.id),
      );
      for (const target of targets)
        await revokeStoredAgent(
          workspace,
          tx,
          operator.id,
          target,
          time,
          target === agent
            ? undefined
            : `${target.name} revoked because its parent agent ${agent.name} was revoked.`,
        );
      return { ok: true };
    });
  });
  // My agents' Overview totals: tasks the agent handed in that were approved (one indexed count,
  // migration 74) and messages it sent in rooms (a counter row, migration 75). Owner only, like the rest of the agent routes.
  app.get('/api/agents/:id/totals', async (request) => {
    const operator = await owner(request),
      id = idFrom(request);
    ensureAgent(await readWorkspace(db, operator.id), id);
    const [tasks, messages] = await Promise.all([
      db.query<{ count: string | number }>(
        "SELECT count(*) AS count FROM room_tasks WHERE submitted_by=$1 AND status='done'",
        [id],
      ),
      db.query<{ sent: string | number }>(
        'SELECT sent FROM agent_message_counts WHERE agent_id=$1',
        [id],
      ),
    ]);
    return {
      tasks_done: Number(tasks.rows[0]?.count ?? 0),
      messages_sent: Number(messages.rows[0]?.sent ?? 0),
    };
  });
  // My agents' Activity feed: this agent's events and runs, newest first, paged (server/activity.ts),
  // plus a line per confirmed Base registration read from base_identities. Owner only.
  app.get('/api/agents/:id/activity', async (request) => {
    const operator = await owner(request),
      id = idFrom(request);
    const query = z
      .object({
        before: z.string().max(200).optional(),
        limit: z
          .string()
          .regex(/^\d{1,3}$/)
          .transform(Number)
          .optional(),
      })
      .strict()
      .parse(request.query);
    if (query.before !== undefined && !decodeCursor(query.before)) fail(400, 'Invalid cursor.');
    const workspace = await readWorkspace(db, operator.id);
    ensureAgent(workspace, id);
    const identities = await db.query<{
      chain_id: number;
      erc8004_agent_id: string;
      updated_at: string | number;
    }>(
      "SELECT chain_id, erc8004_agent_id::text AS erc8004_agent_id, updated_at FROM base_identities WHERE agent_id=$1 AND operator_id=$2 AND state='confirmed'",
      [id, operator.id],
    );
    return agentActivity(
      workspace,
      id,
      identities.rows.map((row) => ({
        chainId: Number(row.chain_id),
        erc8004AgentId: row.erc8004_agent_id,
        confirmedAt: Number(row.updated_at),
      })),
      query,
    );
  });
  // Rename one agent and/or make its profile public or private from My agents (owner only, Elric
  // refused, audit events). The name follows the creation rules (names need not be unique); both
  // changes together make one manifest revision; the same values are a no-op. Answers with the agent.
  app.patch('/api/agents/:id', async (request) => {
    const operator = await owner(request),
      id = idFrom(request);
    const { name, visibility } = z
      .object({
        name: agentSchema.shape.name.optional(),
        visibility: z.enum(['private', 'public']).optional(),
      })
      .strict()
      .refine((body) => body.name !== undefined || body.visibility !== undefined, {
        message: 'Give a name or a visibility.',
      })
      .parse(request.body);
    return mutate(operator.id, async (workspace, tx, time) => {
      const agent = ensureAgent(workspace, id);
      await refuseElric(tx, [agent.id]);
      if (agent.revokedAt)
        fail(
          409,
          name !== undefined
            ? 'Removed agents cannot be renamed.'
            : 'Removed agents cannot be changed.',
        );
      // Elric (docs/ELRIC.md): the name is reserved for first-party Elric agents.
      if (name !== undefined && name !== agent.name && reservedName(name))
        fail(409, ELRIC_RESERVED_NAME_MESSAGE);
      const manifest = await currentManifest(tx, agent);
      // The card, and so the Base registration file, is compiled from the manifest: an agent
      // created without one has no card at all and stays private (which is what it already is).
      if (visibility === 'public' && !manifest)
        fail(
          409,
          'This agent was created without a profile, so it cannot be made public. Create a new agent with a public profile instead.',
          'no_profile',
        );
      // A Base agent's on-chain URI (/a/<id>) is read from its public card, so it stays public.
      // The workspace row lock taken by mutate is the one Base registration takes before it
      // assigns the short id, so the two cannot interleave.
      if (
        visibility === 'private' &&
        manifest &&
        manifest.spec.visibility !== 'private' &&
        (await baseRegistrationStarted(tx, agent.id))
      )
        fail(409, "A Base agent's profile stays public.", 'base_stays_public');
      const changed = await updateStoredAgent(
        workspace,
        tx,
        operator.id,
        agent,
        manifest,
        { name, visibility },
        time,
      );
      return { agent: ownerAgent(agent, workspace.jobs, time), changed };
    });
  });
  // Pause / Resume one agent from My agents: the same change as city_control without the cascade
  // (owner only, Elric refused, audit event). Idempotent; answers with the agent as it is now.
  for (const action of ['pause', 'resume'] as const)
    app.post(`/api/agents/:id/${action}`, async (request) => {
      const operator = await owner(request),
        id = idFrom(request);
      z.object({})
        .strict()
        .parse(request.body ?? {});
      return mutate(operator.id, async (workspace, tx, time) => {
        const agent = ensureAgent(workspace, id);
        await refuseElric(tx, [agent.id]);
        if (agent.revokedAt) fail(409, 'Removed agents cannot be paused or resumed.');
        const changed = setAgentPaused(workspace, agent, time, action === 'pause', operator.name);
        return { agent: ownerAgent(agent, workspace.jobs, time), changed };
      });
    });
  app.post('/api/agents/:id/rotate-credential', async (request) => {
    const operator = await owner(request),
      id = idFrom(request);
    z.object({}).strict().parse(request.body);
    return mutate(operator.id, async (workspace, tx, time) => {
      const agent = ensureAgent(workspace, id);
      await refuseElric(tx, [agent.id]);
      if (agent.mode !== 'external') fail(409, 'Hosted agents do not use runtime credentials.');
      if (agent.revokedAt) fail(409, 'Revoked agents cannot rotate credentials.');
      // Replaced in the same transaction as presence, cancellation and the audit event.
      const token = await issueRuntimeCredential(
        workspace,
        tx,
        operator.id,
        agent,
        time,
        'rotated',
      );
      return { agent: ownerAgent(agent, workspace.jobs, time), token };
    });
  });
  app.post('/api/connections', async (request, reply) => {
    const operator = await owner(request),
      values = pairSchema.parse(request.body);
    const response = await mutate(operator.id, (workspace, _tx, time) => {
      if (values.fromAgentId === values.toAgentId) fail(400, 'Choose two different agents.');
      const from = ensureAgent(workspace, values.fromAgentId),
        to = ensureAgent(workspace, values.toAgentId);
      if (from.revokedAt || to.revokedAt) fail(409, 'Revoked agents cannot connect.');
      const existing = workspace.connections.find(
        (connection) => connection.fromAgentId === from.id && connection.toAgentId === to.id,
      );
      if (existing) return { connection: existing };
      if (workspace.connections.length >= caps.connectionsPerWorkspace)
        fail(409, 'Local connection limit reached.');
      const connection = { id: randomUUID(), ...values, createdAt: iso(time) };
      workspace.connections.push(connection);
      event(
        workspace,
        time,
        'connection.authorized',
        `${from.name} may request work from ${to.name}.`,
        to.id,
      );
      return { connection };
    });
    return reply.code(201).send(response);
  });
  app.delete('/api/connections/:id', async (request) => {
    const operator = await owner(request),
      id = idFrom(request);
    return mutate(operator.id, (workspace, _tx, time) => {
      const connection =
        workspace.connections.find((item) => item.id === id) ?? fail(404, 'Connection not found.');
      workspace.connections = workspace.connections.filter((item) => item.id !== id);
      for (const job of workspace.jobs)
        if (job.requesterId === connection.fromAgentId && job.providerId === connection.toAgentId)
          stopJob(workspace, job, time, 'Work stopped because its connection was revoked.');
      event(
        workspace,
        time,
        'connection.revoked',
        'Directional connection revoked.',
        connection.toAgentId,
      );
      return { ok: true };
    });
  });
  function admitJob(
    workspace: Workspace,
    values: z.infer<typeof jobSchema>,
    time: number,
    transportHash?: string,
    /** Requester in another workspace (accepted cross-workspace connection, checked by caller). */
    remoteRequester?: StoredAgent,
  ) {
    const requestHash =
      transportHash ??
      sha(
        canonical({
          requesterId: values.requesterId,
          providerId: values.providerId,
          input: values.input,
        }),
      );
    const existing = workspace.jobs.find((job) => job.idempotencyKey === values.idempotencyKey);
    // A remote requester's key is bound to that requester: it never resolves another's job.
    if (existing && remoteRequester && existing.requesterId !== remoteRequester.id)
      fail(409, 'This idempotency key belongs to a different requester.');
    if (existing) {
      if (existing.requestHash !== requestHash)
        fail(409, 'This idempotency key belongs to different job input.');
      return { job: publicJob(existing) };
    }
    if (workspace.paused) fail(409, 'Workspace is paused.');
    if (!hasPermission(workspace, values))
      fail(403, 'A current directional connection is required.');
    const requester = remoteRequester ?? ensureAgent(workspace, values.requesterId),
      provider = ensureAgent(workspace, values.providerId);
    if (remoteRequester && remoteRequester.id !== values.requesterId)
      fail(400, 'Requester mismatch.');
    if (options.hosted) refreshPresence(workspace, time);
    // A remote requester's liveness is checked in its own workspace (revoked or paused refuses).
    if ((!remoteRequester && !reachable(requester, time)) || !reachable(provider, time))
      fail(409, 'Both agents must be reachable.');
    const activeJobs = workspace.jobs.filter(active);
    if (
      activeJobs.length >= caps.activeJobsPerWorkspace ||
      [requester.id, provider.id].some(
        (id) =>
          activeJobs.filter((job) => job.requesterId === id || job.providerId === id).length >=
          caps.activeJobsPerAgent,
      )
    )
      fail(
        409,
        `Active job capacity reached (${caps.activeJobsPerAgent} per agent, ${caps.activeJobsPerWorkspace} per workspace).`,
      );
    if (workspace.jobs.length >= caps.jobsPerWorkspace)
      fail(
        409,
        `Local history limit of ${caps.jobsPerWorkspace} jobs reached. Export/archive support is required before further work.`,
      );
    const job: StoredJob = {
      id: randomUUID(),
      requesterId: requester.id,
      providerId: provider.id,
      capability: provider.capability,
      input: values.input,
      status: 'queued',
      acceptance: 'pending',
      output: null,
      createdAt: iso(time),
      updatedAt: iso(time),
      completedAt: null,
      acceptedAt: null,
      costCents: provider.mode === 'hosted' ? 0 : null,
      error: null,
      isDemo: requester.isDemo || provider.isDemo,
      idempotencyKey: values.idempotencyKey,
      requestHash,
      attempts: 0,
      leaseHash: null,
      leaseExpiresAt: null,
      outputHash: null,
    };
    workspace.jobs.push(job);
    event(
      workspace,
      time,
      'job.submitted',
      `${requester.name} requested ${provider.capability} from ${provider.name}.`,
      provider.id,
      job.id,
    );
    return { job: publicJob(job) };
  }
  app.post('/api/jobs', async (request, reply) => {
    const operator = await owner(request),
      values = jobSchema.parse(request.body);
    const response = await mutate(operator.id, (workspace, _tx, time) =>
      admitJob(workspace, values, time),
    );
    return reply.code(201).send(response);
  });
  const originOf = (request: FastifyRequest) => requestOrigin(request, options.hosted);
  // One platform signer for Agent Cards and count checkpoints (distinct signing contexts).
  const platformSigner = loadPlatformSigner(
    process.env,
    Boolean(options.hosted),
    undefined,
    options.signingKey,
  );
  const autonomy = await registerAutonomy(app, {
    db,
    caps,
    signer: platformSigner,
    clock,
    sourceSecret: process.env.CITY_RATE_LIMIT_KEY,
    ...(options.logLine ? { log: options.logLine } : {}),
    limit,
    fail,
    owner,
    optionalOperator,
    originOf,
    mutate,
    mutateMany,
    // Late-bound: the AI workspace module registers below.
    aiCapacity: () => workspaces.capacity(),
  });
  // Mentions and wake-up (docs/WAKE.md): messaging and rooms write through wake.db so
  // their commits wake long-polls, streams and webhooks.
  const wake = createWake({
    db,
    clock,
    limit,
    // Separate wake root key: CITY_WAKE_SECRET, else an HKDF subkey of CITY_RATE_LIMIT_KEY.
    keys: wakeKeys(process.env, randomBytes(32).toString('hex')),
    retryTimer: !options.hosted,
    ...options.wake,
  });
  const messaging = createMessaging({
    db: wake.db,
    clock,
    limit,
    crossPairPerMinute: caps.crossSendsPerPairPerMinute,
    crossInboundPerMinute: caps.crossInboundSendsPerOwnerPerMinute,
    ...options.messaging,
  });
  registerMessagingRoutes(app, { messaging, owner, runtime, waitInbox: inboxWaiter(wake) });
  const workspaces = registerAiWorkspaces(app, {
    db,
    caps,
    clock,
    sourceSecret: process.env.CITY_RATE_LIMIT_KEY,
    limit,
    fail,
    person,
    owner,
    originOf,
    mutate,
    ...(options.logLine ? { log: options.logLine } : {}),
  });
  const connections = createConnections({ db, clock, caps, limit, mutateMany, mutate });
  registerConnectionRoutes(app, { connections, owner });
  // Hosted instances share CITY_RATE_LIMIT_KEY, so every instance derives the same links.
  const roomsSecret = process.env.CITY_RATE_LIMIT_KEY || randomBytes(32).toString('hex');
  const rooms = createRooms({
    db: wake.db,
    clock,
    limit,
    secret: roomsSecret,
    // Member caps from CITY_LIMIT_ROOM_MEMBERS_MAX / _DEFAULT (clamped to the protocol ceiling).
    limits: {
      memberCapMax: caps.roomMembersMax,
      memberCapDefault: caps.roomMembersDefault,
      ...options.rooms,
    },
    agentsPerWorkspace: caps.agentsPerWorkspace,
    mutate,
    mutateMany,
    appendEvents,
    // Room tasks on or off (same flag as the task tools). Templates never create tasks.
    starterTasks: {
      enabled: () => roomTasksEnabled(process.env),
      insert: insertStarterTasks,
      existing: existingStarterTasks,
    },
    // An AI's first read of a room carries the handoff brief once (docs/ROOMS.md).
    handoffBrief: deliverBriefOnce,
  });
  registerRoomRoutes(app, { rooms, owner, originOf, limit });
  // Room invitations (Operation Directory D2, rooms/invitations.ts): a host invites a listed
  // Base agent; it joins only when it or its owner accepts. Always on.
  const invitations = createRoomInvitations({
    db: wake.db,
    clock,
    limit,
    rooms,
    ...options.roomInvitations,
  });
  // Feed Respond (server/feed/respond.ts, live unless CITY_FEED=0, read per request): a response
  // to a signed-in request is a room invitation to its poster, answered in the same inbox.
  const feedRespond = createFeedRespond({
    db: wake.db,
    clock,
    limit,
    rooms,
    ...options.feedRespond,
  });
  registerInvitationRoutes(app, {
    invitations,
    owner,
    originOf,
    feed: { respond: feedRespond, enabled: () => feedEnabled() },
  });
  registerFeedRespondRoutes(app, { respond: feedRespond, owner, originOf });
  // Context pins (docs/ROOMS.md "Pins and the handoff brief"): console REST and MCP tools.
  const pins = createRoomPins({ db: wake.db, clock, limit });
  registerPinRoutes(app, { pins, owner, originOf });
  // Room tasks (docs/ROOM_TASKS.md): limits are charged before its transactions.
  const tasks = createRoomTasks({ db, clock, limit, secret: roomsSecret });
  // Owner console REST mirror of the task tools, behind the same flag (no routes when off: 404).
  if (roomTasksEnabled(process.env)) registerTaskRoutes(app, { tasks, owner, originOf });
  // Room repos (docs/ROOM_REPOS.md): GitHub App from the environment; without an
  // App id and key the tools answer 503 repos_not_configured.
  const repos = options.roomRepos
    ? options.roomRepos({ db, clock, limit })
    : createRoomReposFromEnv({
        db,
        clock,
        limit,
        // The message never contains key material; the tools answer 503 repos_not_configured.
        onConfigError: (message) =>
          (options.logLine ?? console.warn)(`room_repos.misconfigured ${message}`),
      });
  // Console REST to connect or disconnect a room's repository: host session only.
  registerRoomRepoRoutes(app, { repos, owner, originOf, fail });
  // Published results, city_ask and reuse reports (docs/ANSWERS.md).
  const results = createResults({
    db,
    clock,
    limit,
    count: (key, windowMs) => limiter.count(key, windowMs),
    limits: caps,
    options: options.results,
    appOrigins: options.hosted?.allowedOrigins ?? [],
    mutate,
  });
  registerResultRoutes(app, { results, owner, originOf });
  const links = createJoinLinks({ db, clock, limit, rooms, caps, tasks, messaging });
  registerJoinLinkRoutes(app, {
    links,
    owner,
    originOf,
    limit,
  });
  stressTestMaxGuests(); // fails startup on an invalid CITY_STRESS_TEST_MAX_GUESTS
  stressTestMaxRooms(); // and on an invalid CITY_STRESS_TEST_MAX_ROOMS
  // "Verify here": the daily, hash-chained, signed checkpoints of the same count, public leaves,
  // owner-only inclusion proofs, and the Vercel Cron endpoint (CRON_SECRET).
  registerCountLogRoutes(app, {
    log: createCountLog({
      db,
      clock,
      excludedOperators: parseExcludedOperators(process.env.CITY_STATS_EXCLUDED_OPERATORS),
      signingKey: platformSigner.key,
    }),
    owner,
    cronSecret: process.env.CRON_SECRET,
    // The Berlin-noon gate reads the app's injected clock so tests can pin it; the e2e server can
    // override the gate alone through CITY_COUNT_LOG_CRON_NOW (server/index.ts). A pinned gate
    // seals without the noon cut: the pinned day is not the time the database stamps on the
    // agents those suites create, so its cut would leave all of them out.
    now: options.countLogCronNow ?? clock,
    noonCut: options.countLogCronNow === undefined,
    limit,
  });
  // Daily guard that the fast count still equals the published scan (CRON_SECRET).
  registerFastCountCheckRoute(app, {
    db,
    excludedOperators: parseExcludedOperators(process.env.CITY_STATS_EXCLUDED_OPERATORS),
    cronSecret: process.env.CRON_SECRET,
  });
  // Homepage ticker: AI agents that ever joined, cached per instance and at the edge; and the paid
  // service calls on Base mainnet (migration 125), left out while CITY_PAID_CALLS_TICKER is '0'.
  registerPublicStatsRoutes(app, {
    stats: createPublicStats({
      db,
      clock,
      excludedOperators: parseExcludedOperators(process.env.CITY_STATS_EXCLUDED_OPERATORS),
    }),
    limit,
    paidCalls: paidCallsReader,
    // The Agent Explorer's "On Base now" total, shared through its own public_stats row.
    baseAgents: createBaseAgentsReader({ db, store: sqlPublicStatsStore(db), clock }),
    clock,
  });
  // Base Pay P2c: agents pay other Central City agents on their own (tools behind CITY_BASE_WALLET=1
  // and CITY_BASE_AGENT_PAY=1, read per call). Payments use the wallet network's chain runtime and
  // its endpoint for recipients; without them a payment answers unavailable and nothing is stored.
  const agentPayChain: AgentPayDeps['chain'] =
    options.agentPay?.chain ??
    (async (authorize) => {
      const runtime = await baseRuntimes(WALLET_CHAIN_ID);
      if (!runtime.agentPayments) throw new Error('Agent payments are not configured.');
      return runtime.agentPayments(authorize);
    });
  const agentPay = createAgentPayService({
    db,
    env: process.env,
    now: clock,
    chain: agentPayChain,
    recipients: options.agentPay
      ? options.agentPay.recipients
      : walletReaders(process.env, { hosted: Boolean(options.hosted) }).payChain,
  });
  // Its recovery cron (CRON_SECRET): the same payment chain, whatever the agent-pay flags say, so
  // reservations held by earlier payments still settle after the flags are turned off. Recovery
  // never sends for the first time; its authority check refuses everything all the same.
  registerPaymentRecoveryCron(app, {
    db,
    chainId: WALLET_CHAIN_ID,
    chain: () =>
      agentPayChain(async () => {
        throw new Error('Payment recovery never authorizes a broadcast.');
      }),
    cronSecret: process.env.CRON_SECRET,
    env: process.env,
    now: clock,
  });
  // Feed D6, "Use with my agent" (server/feed/pay, docs/FEED_PAY.md): live for every owner unless
  // CITY_FEED or CITY_FEED_PAY is '0', read per request. The agent's spender
  // account pays a listed x402 service from the agent's own wallet within the owner's limits; the
  // chain side is the wallet network's runtime (feedPay), without which a call answers unavailable.
  // The batch lane's grant check from stored ids (assistant-access.ts), bound once the assistant
  // access below exists; until then (and in apps without it) it refuses, so nothing is batched.
  let grantCheck:
    ((input: { operatorId: string; kind: 'grant' | 'key'; id: string }) => Promise<void>) | null =
    null;
  const feedPay = createFeedPayEngine({
    db,
    env: process.env,
    now: clock,
    revalidateGrant: (input) =>
      grantCheck ? grantCheck(input) : Promise.reject(new Error('Grant check not ready.')),
    chain:
      options.feedPay?.chain ??
      (async () => {
        const runtime = await baseRuntimes(WALLET_CHAIN_ID);
        if (!runtime.feedPay) throw new Error('Feed pay is not configured.');
        return runtime.feedPay();
      }),
    ...(options.feedPay?.http ? { http: options.feedPay.http } : {}),
    ...(options.feedPay?.sleep ? { sleep: options.feedPay.sleep } : {}),
    ...(options.feedPay?.pollMs !== undefined ? { pollMs: options.feedPay.pollMs } : {}),
    ...(options.feedPay?.finalityPerRun !== undefined
      ? { finalityPerRun: options.feedPay.finalityPerRun }
      : {}),
    ...(options.feedPay?.offerKinds ? { offerKinds: options.feedPay.offerKinds } : {}),
    alert:
      options.feedPay?.alert ??
      createFeedPayAlerts({
        env: process.env,
        ...(options.logLine ? { log: options.logLine } : {}),
      }),
    ...(options.logLine ? { log: options.logLine } : {}),
    // One cap on a workspace's calls in flight, the same for every workspace
    // (CITY_LIMIT_FEED_PAY_CALLS_IN_FLIGHT_PER_WORKSPACE).
    callsInFlightMax: caps.feedPayCallsInFlightPerWorkspace,
    // Fee router 3's facilitator (docs/protocol/FEE_ROUTER_3.md); null unless its key and router 3
    // are configured, so router 3 stays off.
    facilitator:
      options.feedPay?.facilitator ??
      (async () => {
        const runtime = await baseRuntimes(WALLET_CHAIN_ID);
        return runtime.router3Facilitator?.() ?? null;
      }),
    // Payment screening (docs/protocol/SCREENING-GATE.md), live unless CITY_PROTOCOL_SCREENING is
    // '0'. On Base mainnet the sanctions oracle is the one fixed in code (shared/protocol.ts); on a
    // test network CITY_PROTOCOL_SCREENING_ORACLE names it. Without one, new payments are refused.
    screening: createScreeningGate({
      db,
      env: process.env,
      now: clock,
      provider:
        options.feedPay?.screeningProvider ??
        (() =>
          sanctionsOracleFor(process.env, WALLET_CHAIN_ID, async () => {
            // Feed pay's own endpoint when CITY_FEED_PAY_CDP_RPC_URL is set (runtime.ts).
            const runtime = await baseRuntimes(WALLET_CHAIN_ID);
            const reader = runtime.feedPayReadClient?.() ?? runtime.readClient;
            if (!reader) throw new Error('No read client.');
            return reader;
          })),
    }),
  });
  // The person's own account (whichever workspace is selected), with the console's header.
  const feedPayPerson = async (request: FastifyRequest) => {
    if (request.headers['x-city-request'] !== '1' || !request.cookies.cc_session) return null;
    const person = await optionalOperator(request);
    if (!person) return null;
    const { rows } = await db.query<{ kind: string }>('SELECT kind FROM operators WHERE id = $1', [
      person.id,
    ]);
    return rows[0]?.kind === 'owner' ? { accountId: person.id } : null;
  };
  registerFeedPayRoutes(app, {
    engine: feedPay,
    env: process.env,
    person: feedPayPerson,
    limit,
    cronSecret: process.env.CRON_SECRET,
    ...(options.feedPay?.answerWaitMs !== undefined
      ? { answerWaitMs: options.feedPay.answerWaitMs }
      : {}),
  });
  // The sponsored first purchase (server/feed/pay/sponsored.ts; docs/protocol/
  // SPONSORED_FIRST_PURCHASE.md): its own routes and worker, off unless CITY_SFP_ENABLED is '1'.
  // Paid by the sponsor's own key and facilitator (runtime sponsorPay); the engine is only read.
  registerSponsoredRoutes(app, {
    sponsored: createSponsoredCalls({
      db,
      env: process.env,
      now: clock,
      chainId: WALLET_CHAIN_ID,
      credits: createSponsorCredits({ db, env: process.env, now: clock }),
      hosted: { forSponsor: feedPay.hostedForSponsor, run: feedPay.runHostedOffer },
      pay:
        options.feedPay?.sponsorPay ??
        (async () => (await baseRuntimes(WALLET_CHAIN_ID)).sponsorPay?.() ?? null),
      // Called per request, after `offers` below exists.
      serviceIdOf: (offerId) => offers.serviceIdOf(offerId),
      ...(options.logLine ? { log: options.logLine } : {}),
    }),
    env: process.env,
    person: feedPayPerson,
    limit,
    cronSecret: process.env.CRON_SECRET,
  });
  // Feed offers (server/feed/offers): the services:sell tools write through this store. Offers are
  // listed under the configured public origin, never a request's Host. A bad cap setting keeps the
  // defaults (logged) instead of stopping the app.
  let offerCapsNow: OfferCaps;
  try {
    offerCapsNow = options.offers?.caps ?? offerCaps(process.env);
  } catch (error) {
    app.log.error(
      { err: error },
      'Offer caps: a CITY_LIMIT_OFFERS_ setting is invalid; using defaults.',
    );
    offerCapsNow = { ...OFFER_CAPS_DEFAULT };
  }
  const offers = createOfferStore(db, {
    origin: options.offers?.origin ?? options.hosted?.publicOrigin ?? 'https://centralcity.ai',
    caps: offerCapsNow,
    now: clock,
    // Above 0.10 USDC only while fee router 2 is live (docs/protocol/FEE_ROUTER_2.md section 5).
    priceMaxRaw: () => offerPriceMaxRaw(process.env),
  });
  const assistantAccess = await registerAssistantAccess(app, {
    db,
    messaging,
    owner,
    mutate,
    limit,
    limits: caps,
    fail,
    autonomy: autonomy.service,
    originOf,
    admitJob,
    advanceRead: advanceHostedRead,
    mutateMany,
    workspaces,
    connections,
    rooms,
    tasks,
    pins,
    repos,
    wake,
    results,
    agentPay,
    feedPay,
    ...(options.feedPay?.mcpWaitMs !== undefined
      ? { feedPayWaitMs: options.feedPay.mcpWaitMs }
      : {}),
    invitations,
    now: clock,
    feedRequests,
    offers,
  });
  // The batch lane re-checks an MCP purchase's grant or key from its ids: the same row checks as
  // every tool call (revoked, expired, onboarding) and the city_service_call scope.
  grantCheck = async ({ operatorId, kind, id }) => {
    await db.transaction(async (tx) => {
      const identity: GrantIdentity = { grantId: id, operatorId };
      if (kind === 'key') {
        const key = (
          await tx.query<{ key_hash: string }>(
            'SELECT key_hash FROM workspace_keys WHERE id = $1 AND operator_id = $2',
            [id, operatorId],
          )
        ).rows[0];
        if (!key) throw new Error('Workspace key gone.');
        identity.keyHash = key.key_hash;
      }
      const granted = await assistantAccess.authority(identity)(tx as never, clock());
      if (
        !granted.includes('workspace:read') ||
        !granted.includes(ASSISTANT_TOOL_SCOPES.city_service_call!)
      )
        throw new Error('Grant does not permit city_service_call.');
    });
  };
  const oauthServer = await registerRemoteMcp(app, {
    roomInvites: links.invites,
    db,
    access: assistantAccess,
    anonymousTool: autonomy.anonymousTool,
    createWorkspace: workspaces.createWorkspace,
    verifyWorkspaceKey: workspaces.verifyKey,
    apiRequestsPerMinute: caps.apiRequestsPerMinute,
    mutate,
    limit,
    fail,
    clock,
    optionalOperator,
    authenticate,
    rememberDevice,
    startSession: (reply, operatorId) => db.transaction((tx) => session(tx, reply, operatorId)),
    hosted: options.hosted,
    secureCookies: options.hosted ? true : (options.secureCookies ?? false),
    ...options.remoteMcp,
  });
  // Hosted responder: owner settings and write-only provider keys (console session only).
  if (options.responder?.enabled ?? process.env.CITY_RESPONDER === '1') {
    const keys = responderKeys(options.responder?.env ?? process.env, {
      hosted: Boolean(options.hosted),
    });
    // The reason only (missing|invalid|not_distinct), never a value.
    if (!keys.available)
      (options.logLine ?? console.warn)(`responder.unavailable reason=${keys.reason}`);
    const responder = createResponder({
      db,
      clock,
      limit,
      mutate,
      keys,
      transport: options.responder?.transport,
    });
    registerResponderRoutes(app, { responder, owner });
    // S2b: the wake outbox drains kind 'responder' through this handler (no root key: no drain).
    if (keys.available && options.responder?.delivery !== false) {
      const delivery = createResponderDelivery({
        db: wake.db,
        clock,
        limit,
        mutate,
        keys,
        transport: options.responder?.postTransport,
        async postReply(args) {
          try {
            const result = await rooms.post(
              { operatorId: args.ownerId, actor: 'hosted responder', origin: '' },
              {
                room_id: args.roomId,
                agent_id: args.agentId,
                text: args.text,
                idempotency_key: args.idempotencyKey,
              },
              undefined,
              { autoReply: args.autoReply, precondition: args.precondition },
            );
            return { ok: true, seq: (result as { message: { seq: number } }).message.seq };
          } catch (error) {
            if (error instanceof RoomError)
              return {
                ok: false,
                code: error.errorCode,
                ...(error.statusCode === 429 && typeof error.retryAfterMs === 'number'
                  ? { retryAfterMs: error.retryAfterMs }
                  : {}),
              };
            // The shared limiter (ApiError 429) on the owner's room-post budget.
            const retry = (error as { retryAfterMs?: unknown }).retryAfterMs;
            if (typeof retry === 'number')
              return { ok: false, code: 'rate_limited', retryAfterMs: retry };
            return { ok: false, code: 'post_failed' };
          }
        },
      });
      wake.attachResponder(delivery.handle, { budgetMs: options.responder?.drainBudgetMs });
    }
  }
  // Elric (docs/ELRIC.md): Central City's own agent, owner-invoked, agent-bound room access.
  if (options.elric?.enabled ?? elricEnabled()) {
    // Per-tier cost rates from measured GPU time (CITY_ELRIC_GPU_USD_PER_HOUR and
    // CITY_ELRIC_T{1,2}_GPU_S_PER_1K_{IN,OUT}); test config overrides them.
    const elricConfig = {
      ...elricRateConfig(elricRates()),
      runBudgetMs: elricRunBudgetMs(),
      ...options.elric?.config,
    };
    const elricProbe = options.elric?.probe;
    const elricWallClock = options.elric?.wallClock;
    // The self-hosted endpoints (docs/ELRIC_MODEL.md); none configured: model_unavailable.
    const elricModelWiring =
      options.elric?.models !== undefined
        ? options.elric.models
        : (elricMockModels(process.env, Boolean(options.hosted)) ??
          elricModels(process.env, { hosted: Boolean(options.hosted) }));
    registerElricHealth(app, {
      models: elricModelWiring,
      cronSecret: process.env.CRON_SECRET,
      clock,
    });
    registerElric(app, {
      db: wake.db,
      clock,
      mutate,
      owner,
      limit,
      agentsPerWorkspace: caps.agentsPerWorkspace,
      config: elricConfig,
      ...(elricProbe ? { probe: elricProbe } : {}),
      ...(elricWallClock ? { wallClock: elricWallClock } : {}),
      ...(options.elric?.sleep ? { sleep: options.elric.sleep } : {}),
      ...(options.elric?.log ? { log: options.elric.log } : {}),
      adapterFor:
        options.elric?.adapterFor ??
        elricModelWiring?.adapterFor ??
        ((tier) => unavailableAdapter(tier === 1 ? 'elric-small' : 'elric-large')),
      tasksEnabled: () => roomTasksEnabled(process.env),
      retryTimer: !options.hosted && options.startWorkers !== false,
      autoDrain: options.elric?.autoDrain ?? true,
      async postReply(args) {
        try {
          const result = await rooms.post(
            { operatorId: args.ownerId, actor: 'Elric', origin: '', elric: true },
            {
              room_id: args.roomId,
              agent_id: args.agentId,
              text: args.text,
              idempotency_key: args.idempotencyKey,
            },
            undefined,
            // The public attribution (auto_reply provider 'elric', label from shared/elric-copy.ts).
            { autoReply: args.stamp, precondition: args.precondition },
          );
          return { ok: true, seq: (result as { message: { seq: number } }).message.seq };
        } catch (error) {
          if (error instanceof RoomError) return { ok: false, code: error.errorCode };
          return { ok: false, code: 'post_failed' };
        }
      },
      async createTask(args) {
        const { task } = await tasks.create(
          { operatorId: args.ownerId, actor: 'Elric', origin: '', elric: true },
          {
            room_id: args.roomId,
            agent_id: args.agentId,
            title: args.title,
            ...(args.body !== undefined ? { body: args.body } : {}),
            idempotency_key: args.idempotencyKey,
          },
          // Elric's agent-bound recheck, inside the create transaction under the room lock.
          { precondition: args.precondition },
        );
        return { id: task.id, number: task.number };
      },
    });
  }
  const elricService = app.elric;
  registerWakeRoutes(app, {
    wake,
    ...(elricService ? { drainElric: (budgetMs: number) => elricService.drain(budgetMs) } : {}),
    db,
    messaging,
    rooms,
    access: assistantAccess,
    owner,
    runtime,
    originOf,
    limit,
    verifyWorkspaceKey: workspaces.verifyKey,
    verifyAccessToken: (token, origin) => oauthServer.verifyAccessToken(token, origin),
  });
  function workflowDetail(workspace: Workspace, workflow: StoredWorkflow): WorkflowDetail {
    return {
      workflow: publicWorkflow(workflow),
      briefJob: publicJob(ensureJob(workspace, workflow.briefJobId)),
      checkJob: workflow.checkJobId ? publicJob(ensureJob(workspace, workflow.checkJobId)) : null,
    };
  }
  function ensureWorkflow(workspace: Workspace, id: string): StoredWorkflow {
    return workspace.workflows?.find((item) => item.id === id) ?? fail(404, 'Workflow not found.');
  }
  function requireWorkflowGrants(
    workspace: Workspace,
    workflow: Pick<StoredWorkflow, 'requesterId' | 'researcherId' | 'reviewerId'>,
  ) {
    if (
      !hasPermission(workspace, {
        requesterId: workflow.requesterId,
        providerId: workflow.researcherId,
      }) ||
      !hasPermission(workspace, {
        requesterId: workflow.researcherId,
        providerId: workflow.reviewerId,
      })
    )
      fail(
        403,
        'Current requester-to-researcher and researcher-to-reviewer connections are required.',
      );
  }
  app.post('/api/workflows', async (request, reply) => {
    const operator = await owner(request),
      values = workflowSchema.parse(request.body);
    const result = await mutate(operator.id, (workspace, _tx, time) => {
      const requestHash = sha(
        canonical({
          requesterId: values.requesterId,
          researcherId: values.researcherId,
          reviewerId: values.reviewerId,
          source: values.source,
        }),
      );
      const key = `workflow:${sha(values.idempotencyKey)}`;
      const existing = workspace.workflows?.find((workflow) => workflow.idempotencyKey === key);
      requireWorkflowGrants(workspace, values);
      if (existing) {
        if (existing.requestHash !== requestHash)
          fail(409, 'This workflow idempotency key belongs to different input.');
        return workflowDetail(workspace, existing);
      }
      if (workspace.paused) fail(409, 'Workspace is paused.');
      if ((workspace.workflows?.length ?? 0) >= caps.workflowsPerWorkspace)
        fail(
          409,
          `Local workflow limit of ${caps.workflowsPerWorkspace} reached. Export retained work before continuing.`,
        );
      if (new Set([values.requesterId, values.researcherId, values.reviewerId]).size !== 3)
        fail(400, 'Choose three distinct agents.');
      const agents = [values.requesterId, values.researcherId, values.reviewerId].map((id) =>
        ensureAgent(workspace, id),
      );
      if (agents[1]!.capability !== 'research' || agents[2]!.capability !== 'verify')
        fail(400, 'Choose a research agent for the brief and a verify agent for the check.');
      if (agents.some((agent) => !reachable(agent, time)))
        fail(409, 'All three agents must be reachable.');
      const id = randomUUID();
      const briefJob = admitJob(
        workspace,
        {
          requesterId: values.requesterId,
          providerId: values.researcherId,
          input: values.source,
          idempotencyKey: `workflow:brief:${id}`,
        },
        time,
      ).job;
      const workflow: StoredWorkflow = {
        id,
        requesterId: values.requesterId,
        researcherId: values.researcherId,
        reviewerId: values.reviewerId,
        source: values.source,
        briefJobId: briefJob.id,
        checkJobId: null,
        status: 'briefing',
        createdAt: iso(time),
        updatedAt: iso(time),
        error: null,
        idempotencyKey: key,
        requestHash,
      };
      (workspace.workflows ??= []).push(workflow);
      event(
        workspace,
        time,
        'workflow.created',
        'Source brief started. Owner review is required before the check.',
        values.researcherId,
        briefJob.id,
      );
      return workflowDetail(workspace, workflow);
    });
    return reply.code(201).send(result);
  });
  app.get('/api/workflows/:id', async (request) => {
    const operator = await owner(request),
      id = idFrom(request);
    return mutate(operator.id, (workspace) =>
      workflowDetail(workspace, ensureWorkflow(workspace, id)),
    );
  });
  app.post('/api/workflows/:id/check', async (request) => {
    const operator = await owner(request),
      id = idFrom(request);
    z.object({}).strict().parse(request.body);
    return mutate(operator.id, (workspace, _tx, time) => {
      const workflow = ensureWorkflow(workspace, id);
      requireWorkflowGrants(workspace, workflow);
      if (['failed', 'canceled'].includes(workflow.status))
        fail(409, 'This workflow stopped. Start a new workflow after inspecting its history.');
      if (workflow.checkJobId) return workflowDetail(workspace, workflow);
      if (workspace.paused) fail(409, 'Workspace is paused.');
      if (workflow.status !== 'awaiting_review')
        fail(409, 'Wait for the completed brief and review it before starting the check.');
      const brief = ensureJob(workspace, workflow.briefJobId);
      if (brief.status !== 'completed' || !brief.output)
        fail(409, 'The brief must contain a completed result.');
      const input = JSON.stringify({ source: workflow.source, draft: brief.output });
      if (input.length > 12000)
        fail(
          409,
          'The complete source and draft exceed the 12000-character checker limit. Nothing was truncated or sent; export the draft and start a smaller workflow.',
        );
      workflow.checkJobId = admitJob(
        workspace,
        {
          requesterId: workflow.researcherId,
          providerId: workflow.reviewerId,
          input,
          idempotencyKey: `workflow:check:${workflow.id}`,
        },
        time,
      ).job.id;
      workflow.status = 'checking';
      workflow.updatedAt = iso(time);
      event(
        workspace,
        time,
        'workflow.check_started',
        'Owner reviewed the brief and requested a check against the supplied source.',
        workflow.reviewerId,
        workflow.checkJobId,
      );
      return workflowDetail(workspace, workflow);
    });
  });
  app.post('/api/workflows/:id/accept', async (request) => {
    const operator = await owner(request),
      id = idFrom(request);
    z.object({}).strict().parse(request.body);
    return mutate(operator.id, (workspace, _tx, time) => {
      const workflow = ensureWorkflow(workspace, id);
      if (workflow.status === 'accepted') return workflowDetail(workspace, workflow);
      requireWorkflowGrants(workspace, workflow);
      if (workflow.status !== 'completed' || !workflow.checkJobId)
        fail(409, 'Both the brief and check must finish before owner acceptance.');
      for (const jobId of [workflow.briefJobId, workflow.checkJobId]) {
        const job = ensureJob(workspace, jobId);
        if (job.status !== 'completed' || !job.output) fail(409, 'Both results must be complete.');
        if (job.acceptance !== 'accepted') {
          job.acceptance = 'accepted';
          job.acceptedAt = iso(time);
          job.updatedAt = iso(time);
        }
      }
      workflow.status = 'accepted';
      workflow.updatedAt = iso(time);
      event(
        workspace,
        time,
        'workflow.accepted',
        'Owner accepted the brief and check. No payment occurred.',
        workflow.reviewerId,
        workflow.checkJobId,
      );
      return workflowDetail(workspace, workflow);
    });
  });
  app.post('/api/workflows/:id/cancel', async (request) => {
    const operator = await owner(request),
      id = idFrom(request);
    z.object({}).strict().parse(request.body);
    return mutate(operator.id, (workspace, _tx, time) => {
      const workflow = ensureWorkflow(workspace, id);
      if (['accepted', 'failed', 'canceled'].includes(workflow.status))
        return workflowDetail(workspace, workflow);
      for (const jobId of [workflow.briefJobId, workflow.checkJobId])
        if (jobId)
          stopJob(workspace, ensureJob(workspace, jobId), time, 'Owner canceled the workflow.');
      workflow.status = 'canceled';
      workflow.updatedAt = iso(time);
      workflow.error = 'Owner canceled the workflow.';
      event(
        workspace,
        time,
        'workflow.canceled',
        'Owner canceled the source brief workflow.',
        workflow.reviewerId,
        workflow.checkJobId ?? workflow.briefJobId,
      );
      return workflowDetail(workspace, workflow);
    });
  });
  app.post('/api/jobs/:id/accept', async (request) => {
    const operator = await owner(request),
      id = idFrom(request);
    return mutate(operator.id, (workspace, _tx, time) => {
      const job = ensureJob(workspace, id);
      if (job.status !== 'completed' || !job.output)
        fail(409, 'Only a completed result can be accepted.');
      if (job.acceptance !== 'accepted') {
        job.acceptance = 'accepted';
        job.acceptedAt = iso(time);
        job.updatedAt = iso(time);
        event(
          workspace,
          time,
          'job.accepted',
          'Operator accepted the completed result. No payment occurred.',
          job.providerId,
          job.id,
        );
      }
      return { job: publicJob(job) };
    });
  });
  app.post('/api/jobs/:id/cancel', async (request) => {
    const operator = await owner(request),
      id = idFrom(request);
    return mutate(operator.id, (workspace, _tx, time) => {
      const job = ensureJob(workspace, id);
      stopJob(workspace, job, time, 'Operator canceled the job.');
      return { job: publicJob(job) };
    });
  });
  app.post('/api/workspace/pause', async (request) => {
    const operator = await owner(request),
      { paused } = z.object({ paused: z.boolean() }).strict().parse(request.body);
    return mutate(operator.id, (workspace, _tx, time) => {
      if (workspace.paused !== paused) {
        workspace.paused = paused;
        event(
          workspace,
          time,
          paused ? 'workspace.paused' : 'workspace.resumed',
          paused
            ? 'New jobs, hosted execution and result commits paused. Running external code may continue.'
            : 'Workspace execution resumed.',
        );
      }
      return { paused };
    });
  });
  app.post('/api/demo/start', async (request) => {
    const operator = await owner(request);
    return mutate(operator.id, (workspace, _tx, time) => {
      const definitions: Array<{ name: string; capability: Capability }> = [
        { name: 'Atlas', capability: 'research' },
        { name: 'Relay', capability: 'extract' },
        { name: 'Sentinel', capability: 'verify' },
      ];
      const missing = definitions.filter(
        (definition) => !workspace.agents.some((agent) => agent.demoKey === definition.name),
      );
      if (workspace.agents.length + missing.length > caps.agentsPerWorkspace)
        fail(409, 'Local agent limit reached.');
      for (const definition of missing) {
        const agent: StoredAgent = {
          id: randomUUID(),
          name: definition.name,
          description: `Zero-cost ${definition.capability} agent that runs on Central City; deterministic text processing.`,
          capability: definition.capability,
          mode: 'hosted',
          isDemo: true,
          createdAt: iso(time),
          lastSeenAt: null,
          revokedAt: null,
          lastSequence: -1,
          announcedOnline: false,
          demoKey: definition.name,
        };
        workspace.agents.push(agent);
        event(
          workspace,
          time,
          'agent.registered',
          `${agent.name} demonstration registered.`,
          agent.id,
        );
      }
      const demo = definitions.map((definition) =>
        workspace.agents.find((agent) => agent.demoKey === definition.name)!,
      );
      for (let index = 0; index < 2; index++) {
        const from = demo[index]!,
          to = demo[index + 1]!;
        if (from.revokedAt || to.revokedAt) continue;
        if (
          !workspace.connections.some(
            (connection) => connection.fromAgentId === from.id && connection.toAgentId === to.id,
          )
        ) {
          if (workspace.connections.length >= caps.connectionsPerWorkspace)
            fail(409, 'Local connection limit reached.');
          workspace.connections.push({
            id: randomUUID(),
            fromAgentId: from.id,
            toAgentId: to.id,
            createdAt: iso(time),
          });
          event(
            workspace,
            time,
            'connection.authorized',
            `${from.name} may request work from ${to.name}.`,
            to.id,
          );
        }
      }
      return { ok: true };
    });
  });

  app.get('/api/workspace/export', async (request, reply) => {
    const operator = await owner(request);
    reply.header('Content-Disposition', 'attachment; filename="central-city-workspace.json"');
    const exported = await mutate(operator.id, (workspace, _tx, time) =>
      exportWorkspace(workspace, operator, time),
    );
    // The newsletter subscription and its consent record, if any (Privacy Policy 2.14).
    return { ...exported, newsletter: await email.record(db, operator.id) };
  });

  app.post('/api/runtime/a2a/:providerId', async (request, reply) => {
    const identity = await runtime(request);
    const { providerId } = z.object({ providerId: z.string().uuid() }).parse(request.params);
    if (request.headers['a2a-extensions'] !== A2A_AUTH_EXTENSION)
      throw new A2ATransportError(-32008, 'The native authentication extension is required.');
    const selection = {
      version:
        typeof request.headers['a2a-version'] === 'string'
          ? request.headers['a2a-version']
          : undefined,
      binding: A2A_PIN.binding,
    };
    const intent = parseA2AIntent(request.rawBody ?? '', selection);
    const result = await mutateRuntime(identity, (workspace, requester, time) => {
      const provider = ensureAgent(workspace, providerId);
      if (provider.mode !== 'hosted')
        fail(403, 'Agent requests are limited to hosted, zero-cost demonstrations.');
      const route = { requesterId: requester.id, providerId };
      let job: StoredJob;
      if (intent.method === 'SendMessage') {
        if (!hasPermission(workspace, route))
          fail(403, 'A current directional connection is required.');
        const admitted = admitJob(
          workspace,
          {
            ...route,
            input: intent.input.trim(),
            idempotencyKey: a2aMessageKey(requester.id, providerId, intent.messageId),
          },
          time,
          sha(
            canonical({
              profile: A2A_AUTH_EXTENSION,
              params: (request.body as { params: unknown }).params,
            }),
          ),
        );
        job = ensureJob(workspace, admitted.job.id);
      } else {
        const found = workspace.jobs.find(
          (candidate) =>
            candidate.requesterId === requester.id &&
            candidate.providerId === providerId &&
            candidate.idempotencyKey.startsWith('a2a:') &&
            a2aTaskIds(requester.id, providerId, candidate.id).taskId === intent.taskId,
        );
        if (!found) throw new A2ATransportError(-32001, 'Task not found.');
        job = found;
        if (!hasPermission(workspace, route))
          fail(403, 'The task connection is no longer authorized.');
        if (intent.method === 'CancelTask') {
          if (!active(job)) throw new A2ATransportError(-32002, 'Task is already terminal.');
          stopJob(workspace, job, time, 'Authenticated requester canceled the task.');
          job.completedAt = iso(time);
        } else advanceHostedRead(workspace, time);
      }
      const projected = publicJob(job);
      // Older native canceled/failed records did not record a terminal timestamp.
      if (['canceled', 'failed'].includes(projected.status) && !projected.completedAt)
        projected.completedAt = projected.updatedAt;
      return createTaskResponse(
        intent,
        projectNativeJob(projected, {
          ...selection,
          ...a2aTaskIds(requester.id, providerId, job.id),
        }),
      );
    });
    return reply
      .header('A2A-Version', A2A_PIN.wireVersion)
      .header('A2A-Extensions', A2A_AUTH_EXTENSION)
      .send(result);
  });

  app.post('/api/runtime/requests', async (request, reply) => {
    const identity = await runtime(request);
    const supplied = jobSchema.omit({ requesterId: true }).strict().parse(request.body);
    const response = await mutateRuntime(identity, (workspace, requester, time) => {
      const provider = ensureAgent(workspace, supplied.providerId);
      if (provider.mode !== 'hosted')
        fail(403, 'Native agent requests are limited to hosted, zero-cost demonstrations.');
      const values = { ...supplied, requesterId: requester.id };
      // Even an idempotent retrieval requires the current agent's communication grant.
      if (!hasPermission(workspace, values))
        fail(403, 'A current directional connection is required.');
      return admitJob(workspace, values, time);
    });
    return reply.code(201).send(response);
  });
  app.get('/api/runtime/requests/:id', async (request) => {
    const identity = await runtime(request),
      id = idFrom(request);
    return mutateRuntime(identity, (workspace, requester, time) => {
      const job = ensureJob(workspace, id);
      if (job.requesterId !== requester.id) fail(404, 'Job not found.');
      if (!hasPermission(workspace, job)) fail(403, 'The job connection is no longer authorized.');
      advanceHostedRead(workspace, time);
      return { job: publicJob(job) };
    });
  });
  app.post('/api/runtime/heartbeat', async (request) => {
    const identity = await runtime(request),
      { sequence } = z
        .object({ sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
        .strict()
        .parse(request.body);
    // A pure heartbeat updates only the agent's presence row. The workspace row is locked and
    // rewritten only for an offline-to-online transition, which is recorded once as an event.
    const result = await db.transaction((tx) => recordHeartbeat(tx, identity, sequence, clock()));
    if (result === 'unauthorized') fail(401, 'Invalid runtime credential.');
    if (result === 'stale') fail(409, 'Heartbeat sequence must increase.');
    if (!(await announcedOnline(db, identity.operatorId, identity.agentId)))
      await mutateRuntime(identity, (workspace, agent, time) => {
        if (agent.announcedOnline || !reachable(agent, time)) return;
        agent.announcedOnline = true;
        event(
          workspace,
          time,
          'agent.online',
          `${agent.name} authenticated heartbeat received; online.`,
          agent.id,
        );
      });
    else notify(identity.operatorId);
    return { ok: true, heartbeatSeconds: 30, ttlSeconds: 90 };
  });
  /**
   * A job poll with nothing to claim, answered without the workspace lock: the workspace has no
   * queued or running job and no open workflow, so the locked poll below would change nothing
   * (recoverLeases and syncWorkflows have nothing to do, no job to claim) and write nothing. One
   * unlocked read decides with the locked poll's own rules: the exact credential is still current
   * and the agent external and not revoked (else the locked path answers), a paused workspace has
   * no job, an agent without a fresh heartbeat gets 409. Anything else (undefined): the locked poll.
   * Fleet agents poll while their workspace holds ~19.5k agents; each locked poll held the
   * workspace row and parsed the whole document (22-23 Oct 2026 DB overload).
   */
  async function idleJobPoll(identity: RuntimeIdentity): Promise<{ job: null } | undefined> {
    const row = (
      await db.query<{
        paused: boolean | null;
        busy: boolean;
        agent: StoredAgent | null;
        has_presence: boolean;
        last_seen_at: string | null;
        current: boolean;
      }>(IDLE_JOB_POLL_SQL, [identity.operatorId, identity.agentId, identity.credentialHash])
    ).rows[0];
    if (!row || row.busy || !row.current) return undefined;
    const agent = row.agent;
    if (!agent || agent.revokedAt || agent.mode !== 'external') return undefined;
    if (row.paused) return { job: null };
    // Runtime presence is authoritative in agent_presence (applyPresence, server/presence.ts).
    const lastSeenAt = row.has_presence
      ? row.last_seen_at === null
        ? null
        : iso(Number(row.last_seen_at))
      : agent.lastSeenAt;
    if (!reachable({ ...agent, lastSeenAt }, clock()))
      fail(409, 'Send a heartbeat before claiming work.');
    return { job: null };
  }
  app.get('/api/runtime/jobs', async (request) => {
    const identity = await runtime(request);
    const idle = await idleJobPoll(identity);
    if (idle) return idle;
    return mutateRuntime(identity, (workspace, agent, time) => {
      if (workspace.paused) return { job: null };
      if (!reachable(agent, time)) fail(409, 'Send a heartbeat before claiming work.');
      recoverLeases(workspace, time);
      const job = workspace.jobs.find(
        (item) =>
          item.providerId === agent.id &&
          item.status === 'queued' &&
          hasPermission(workspace, item),
      );
      if (!job) return { job: null };
      const leaseToken = randomBytes(24).toString('base64url');
      job.status = 'running';
      job.attempts++;
      job.leaseHash = sha(leaseToken);
      job.leaseExpiresAt = time + LEASE_TTL;
      job.updatedAt = iso(time);
      event(workspace, time, 'job.started', `${agent.name} claimed the job.`, agent.id, job.id);
      return { job: publicJob(job), leaseToken };
    });
  });
  app.post('/api/runtime/jobs/:id/result', async (request) => {
    const identity = await runtime(request),
      id = idFrom(request);
    const { leaseToken, output } = z
      .object({ leaseToken: z.string().min(16).max(128), output: z.unknown() })
      .strict()
      .parse(request.body);
    if (!validOutput(output))
      fail(400, 'Output must be a JSON object within 32 KiB, 8 levels, and 2000 values.');
    return mutateRuntime(identity, (workspace, agent, time) => {
      const job = ensureJob(workspace, id);
      if (job.providerId !== agent.id) fail(404, 'Job not found.');
      if (!hasPermission(workspace, job)) fail(403, 'The job connection is no longer authorized.');
      if (workspace.paused) fail(409, 'Workspace is paused. Retry after it resumes.');
      if (!job.leaseHash || !constantEqual(job.leaseHash, sha(leaseToken)))
        fail(409, 'Job lease is invalid.');
      const outputHash = sha(canonical(output));
      if (job.status === 'completed') {
        if (job.outputHash !== outputHash) fail(409, 'A different result was already submitted.');
        return { job: publicJob(job) };
      }
      if (job.status !== 'running' || job.leaseExpiresAt === null || job.leaseExpiresAt <= time)
        fail(409, 'Job is not running under this lease.');
      job.output = output;
      job.outputHash = outputHash;
      job.status = 'completed';
      job.completedAt = iso(time);
      job.updatedAt = iso(time);
      job.leaseExpiresAt = null;
      event(
        workspace,
        time,
        'job.completed',
        `${agent.name} submitted a result. Operator acceptance is pending.`,
        agent.id,
        job.id,
      );
      return { job: publicJob(job) };
    });
  });
  app.post('/api/runtime/jobs/:id/failure', async (request) => {
    const identity = await runtime(request),
      id = idFrom(request);
    const { leaseToken, reason } = z
      .object({
        leaseToken: z.string().min(16).max(128),
        reason: z.enum([
          'invalid-input',
          'invalid-output',
          'execution-timeout',
          'runtime-unavailable',
        ]),
      })
      .strict()
      .parse(request.body);
    const message = {
      'invalid-input': 'Provider reported invalid model input.',
      'invalid-output': 'Provider reported invalid model output.',
      'execution-timeout': 'Provider reported an execution timeout.',
      'runtime-unavailable': 'Provider reported its runtime was unavailable.',
    }[reason];
    return mutateRuntime(identity, (workspace, agent, time) => {
      const job = ensureJob(workspace, id);
      if (job.providerId !== agent.id) fail(404, 'Job not found.');
      if (!hasPermission(workspace, job)) fail(403, 'The job connection is no longer authorized.');
      if (workspace.paused) fail(409, 'Workspace is paused. Retry after it resumes.');
      if (!job.leaseHash || !constantEqual(job.leaseHash, sha(leaseToken)))
        fail(409, 'Job lease is invalid.');
      if (job.status === 'failed') {
        if (job.error !== message) fail(409, 'A different failure was already submitted.');
        return { job: publicJob(job) };
      }
      if (job.status !== 'running' || job.leaseExpiresAt === null || job.leaseExpiresAt <= time)
        fail(409, 'Job is not running under this lease.');
      job.status = 'failed';
      job.error = message;
      job.completedAt = iso(time);
      job.updatedAt = iso(time);
      job.leaseExpiresAt = null;
      event(workspace, time, 'job.failed', message, agent.id, job.id);
      return { job: publicJob(job) };
    });
  });

  function recoverLeases(workspace: Workspace, time: number): void {
    for (const job of workspace.jobs) {
      if (!active(job)) continue;
      if (!hasPermission(workspace, job)) {
        stopJob(workspace, job, time, 'Work stopped because its permission expired.');
        continue;
      }
      // Hosted server demos execute synchronously on a later request, never on an
      // outstanding external lease. A quiet client must not exhaust their retries.
      if (options.hosted && ensureAgent(workspace, job.providerId).mode === 'hosted') continue;
      if (job.status !== 'running' || job.leaseExpiresAt === null || job.leaseExpiresAt > time)
        continue;
      job.leaseHash = null;
      job.leaseExpiresAt = null;
      job.updatedAt = iso(time);
      job.status = job.attempts >= 3 ? 'failed' : 'queued';
      if (job.status === 'failed') job.completedAt = iso(time);
      job.error =
        job.status === 'failed' ? 'Pure-compute runtime lease expired after three attempts.' : null;
      event(
        workspace,
        time,
        job.status === 'failed' ? 'job.failed' : 'job.retry_queued',
        job.status === 'failed'
          ? 'Job failed after three expired pure-compute leases.'
          : 'Expired pure-compute lease returned to the queue.',
        job.providerId,
        job.id,
      );
    }
  }
  // Called only under the owner's workspace lock. Presence refresh never executes jobs.
  // Hosted agents' synthetic heartbeat is renewed for all of them together, and only when one is
  // new, not yet announced or HOSTED_HEARTBEAT_MS old (server/model.ts): every renewal changes
  // the workspace document, and the caller then rewrites all of it. Renewing each agent on its own
  // 30 s phase rewrote a workspace of thousands on nearly every read; now presence alone rewrites
  // it at most once per interval, and hosted agents stay reachable (HOSTED_PRESENCE_TTL) between.
  function refreshPresence(workspace: Workspace, time: number): void {
    const renewHosted = workspace.agents.some((agent) => hostedHeartbeatDue(agent, time));
    for (const agent of workspace.agents) {
      if (agent.revokedAt) continue;
      if (agent.mode === 'hosted') {
        if (!renewHosted) continue;
        agent.lastSeenAt = iso(time);
        agent.lastSequence++;
        // Synthetic presence refreshes silently; only the transition to online is an event.
        if (!agent.announcedOnline)
          event(workspace, time, 'agent.online', `${agent.name} hosted runtime online.`, agent.id);
        agent.announcedOnline = true;
      } else if (agent.announcedOnline && !reachable(agent, time)) {
        agent.announcedOnline = false;
        event(workspace, time, 'agent.offline', `${agent.name} heartbeat expired.`, agent.id);
      }
    }
  }
  function advanceWorkspace(workspace: Workspace, time: number): void {
    refreshPresence(workspace, time);
    recoverLeases(workspace, time);
    if (!workspace.paused) {
      const runningAtStart = workspace.jobs.filter((job) => job.status === 'running');
      for (const job of runningAtStart) {
        const provider = ensureAgent(workspace, job.providerId);
        if (provider.mode !== 'hosted' || !hasPermission(workspace, job)) continue;
        job.output = executeTemplate(job.capability, job.input);
        job.outputHash = sha(canonical(job.output));
        job.status = 'completed';
        job.completedAt = iso(time);
        job.updatedAt = iso(time);
        job.leaseExpiresAt = null;
        event(
          workspace,
          time,
          'job.completed',
          `${provider.name} completed deterministic text processing. Operator acceptance is pending.`,
          provider.id,
          job.id,
        );
      }
      for (const job of workspace.jobs) {
        const provider = ensureAgent(workspace, job.providerId);
        if (
          job.status !== 'queued' ||
          provider.mode !== 'hosted' ||
          !reachable(provider, time) ||
          !hasPermission(workspace, job)
        )
          continue;
        job.status = 'running';
        job.attempts++;
        job.updatedAt = iso(time);
        job.leaseExpiresAt = time + LEASE_TTL;
        event(
          workspace,
          time,
          'job.started',
          `${provider.name} started deterministic text processing.`,
          provider.id,
          job.id,
        );
      }
    }
  }
  function advanceHostedRead(workspace: Workspace, time: number): void {
    if (options.hosted) advanceWorkspace(workspace, time);
  }
  let tickRunning: Promise<void> | null = null;
  let closing = false;
  /** Advances the workspace in place (the tick's step); true when that changed it. */
  function advances(workspace: Workspace, time: number): boolean {
    const before = JSON.stringify(workspace);
    syncWorkflows(workspace, time);
    advanceWorkspace(workspace, time);
    syncWorkflows(workspace, time);
    return before !== JSON.stringify(workspace);
  }
  async function performTick(operatorId?: string): Promise<void> {
    const owners = operatorId
      ? [{ operator_id: operatorId }]
      : (await db.query<{ operator_id: string }>('SELECT operator_id FROM workspaces')).rows;
    for (const row of owners) {
      let changed = false;
      await db.transaction(async (tx) => {
        const workspace = await readWorkspace(tx, row.operator_id, true),
          time = clock();
        changed = advances(workspace, time);
        if (changed)
          await tx.query('UPDATE workspaces SET data=$2::jsonb WHERE operator_id=$1', [
            row.operator_id,
            JSON.stringify(workspace),
          ]);
      });
      if (changed) notify(row.operator_id);
    }
    await sweepExpired();
  }
  // Global expiry sweeps are throttled per instance and bounded per run. Runtime authentication
  // already removes each agent's own expired nonces, so this only reclaims idle agents' rows.
  let lastSweep = -Infinity;
  async function sweepExpired(): Promise<void> {
    const time = clock();
    if (time - lastSweep < 60_000) return;
    lastSweep = time;
    // One round trip for the three expiry deletes (independent tables, nothing references them).
    // Expired guest source blocks (migration 37) stop blocking at expires_at anyway.
    await db.query(
      `WITH nonces AS (
         DELETE FROM replay_nonces WHERE (agent_id,nonce) IN
           (SELECT agent_id,nonce FROM replay_nonces WHERE expires_at<=$1 LIMIT 1000)),
       expired_sessions AS (
         DELETE FROM sessions WHERE token_hash IN
           (SELECT token_hash FROM sessions WHERE expires_at<=$1 LIMIT 1000)),
       blocks AS (
         DELETE FROM room_guest_blocks WHERE (room_id,source_hash) IN
           (SELECT room_id,source_hash FROM room_guest_blocks WHERE expires_at<=$1 LIMIT 1000))
       SELECT 1`,
      [time],
    );
    // Answers: asks, receipts and revoked tombstones older than 30 days.
    await results.sweep(time);
  }
  function tick(): Promise<void> {
    if (closing) return Promise.resolve();
    if (!tickRunning)
      tickRunning = performTick().finally(() => {
        tickRunning = null;
      });
    return tickRunning;
  }
  app.decorate('city', { tick, db });
  const interval =
    options.hosted || options.startWorkers === false
      ? undefined
      : setInterval(() => {
          void tick().catch(() => app.log.error('Worker tick failed.'));
        }, 1000);
  interval?.unref();
  app.addHook('preClose', async () => {
    closing = true;
    if (interval) clearInterval(interval);
    for (const clients of subscribers.values()) for (const reply of clients) reply.raw.end();
    subscribers.clear();
    if (tickRunning) await tickRunning;
  });
  app.addHook('onClose', async () => {
    await db.close();
    await releaseDataLock();
  });
  return app;
}
