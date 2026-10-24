import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createApp } from '../../server/app.js';
import type { Database } from '../../server/database.js';
import { agentWalletRecipe, deriveAddressLocal } from '../../server/base/chain/derive.js';
import { accountIndexFor } from '../../server/base/wallet/service.js';
import type { AssistantScope } from '../../shared/assistant.js';
import {
  LIMIT_PERMISSION_END,
  permissionToJson,
  spendPermissionHash,
} from '../../shared/base/spend-limits.js';
import type { SpendPermission } from '../../shared/base/types.js';
import { WALLET_CHAIN_ID } from '../../shared/base/wallet-network.js';
import { FEED_USDC, type FeedSchemaSummary } from '../../shared/feed.js';
import { FEED_PAY_PATHS, type FeedPayAlert, type FeedPayCall } from '../../shared/feed-pay.js';
import { BAZAAR_SOURCE } from '../../server/feed/types.js';
import { WALLET_NET } from '../wallet-network-fixture.js';
import { fakeX402Service, type FakeServiceConfig } from './fake-x402-service.js';
import { feedPayFakeBase } from './feed-pay-fake-base.js';
import { OWNER, PASSWORD } from '../oauth-helpers.js';
import type { ScreeningProvider } from '../../server/protocol/screening/gate.js';
import type { FeedPayEngineDeps } from '../../server/feed/pay/engine.js';

/*
 * The Feed D6 app fixture (createApp on PGlite with the real routes, engine, chain side and MCP
 * tool) against a fake x402 service and a fake Base: tests/feed-pay-app.test.ts and
 * tests/feed-pay-integration.test.ts share it. Nothing reaches a network; no real payment is ever
 * made. Synthetic data.
 */

export const CHAIN_ID = WALLET_CHAIN_ID;
export const USDC = WALLET_NET.tokens.USDC.address;
export const json = { 'content-type': 'application/json', 'x-city-request': '1' };
export const CRON = 'feed-pay-cron-secret-0123456789abcdef';
/**
 * The environment every Feed pay app test starts from. The Feed and Feed pay are live by default
 * (docs/protocol/LIVE.md), so they are left unset. The protocol fee and payment screening are live
 * by default too; they are switched off here with their emergency off ('0') so that a test about
 * something else pays exactly the price with no screening: the fee and screening tests turn them
 * back on (tests/feed-pay-fee.test.ts, tests/protocol-screening.test.ts and
 * tests/protocol-live.test.ts).
 */
export const FLAGS = {
  CITY_FEED: undefined,
  CITY_FEED_PAY: undefined,
  CITY_PROTOCOL_FEES: '0',
  CITY_PROTOCOL_SCREENING: '0',
  // Unset (and put back after each test): on Base mainnet the code's addresses apply anyway.
  CITY_PROTOCOL_CHAIN_ID: undefined,
  CITY_PROTOCOL_ROUTER: undefined,
  CITY_PROTOCOL_TREASURY: undefined,
  CITY_PROTOCOL_START_BLOCK: undefined,
  CITY_PROTOCOL_SCREENING_ORACLE: undefined,
  CITY_PROTOCOL_SCREENING_DENY: undefined,
  CITY_BASE_WALLET: '1',
  CITY_BASE_MAINNET: '1',
  CRON_SECRET: CRON,
  CITY_OPS_ALERT_WEBHOOK: undefined,
};
export const PAY_TO = getAddress(`0x${'7a'.repeat(20)}`);
export const SVC = 'svc_aaaaaaaaaaaaaaaaaaaa';
export const SVC_URL = 'https://www.ax1.example/api/q-verdict/resource';
export const INPUT: FeedSchemaSummary = {
  format: 'json',
  fields: [
    { name: 'tokenAddress', in: 'body', type: 'string', required: true, description: '' },
    { name: 'chain', in: 'body', type: 'string', required: false, description: '' },
  ],
  more: 0,
  example: '{"tokenAddress":"0x0"}',
  exampleState: 'whole',
};
/** The inputs the service is called with: Base USDC's contract address (as the listing asks). */
export const BODY = { body: { tokenAddress: FEED_USDC.address.toLowerCase() } };

export function withEnv(
  t: { after: (fn: () => unknown) => void },
  values: Record<string, string | undefined>,
) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const apply = (entries: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(entries))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  };
  apply(values);
  t.after(() => apply(saved));
}

let address = 20;

export async function setup(
  t: { after: (fn: () => unknown) => void },
  options: {
    env?: Record<string, string | undefined>;
    cap?: bigint;
    funds?: bigint;
    /** The app's clock at the start (ms); now by default. */
    now?: number;
    /** Payment screening's provider (a fake; never the network). */
    screeningProvider?: () => ScreeningProvider | null;
    /** The kinds a service sold by a Central City agent runs (the built-in registry by default). */
    offerKinds?: FeedPayEngineDeps['offerKinds'];
    /**
     * Wires the fake Base's facilitator (fee router 3) into the engine's `facilitator` dep; its
     * state.facilitator toggles absent / cannot pay / revert / never sent. Unset: none (as before).
     */
    facilitator?: boolean;
    /** Calls whose finality one recover run records (the engine's default otherwise). */
    finalityPerRun?: number;
    /** The sponsored first purchase's payer (server/feed/pay/sponsored.ts); unset: none. */
    sponsorPay?: import('../../server/feed/pay/sponsored.js').SponsoredDeps['pay'];
  } = {},
) {
  withEnv(t, { ...FLAGS, ...options.env });
  let clockMs = options.now ?? Date.now();
  const clock = () => clockMs;
  const base = feedPayFakeBase(clock);
  const service = fakeX402Service({ settle: base.settle });
  const alerts: FeedPayAlert[] = [];
  let database: Database | undefined;
  const app = await createApp({
    dataDir: ':memory:',
    startWorkers: false,
    now: clock,
    feedPay: {
      chain: async () => base.chainFor(() => database!),
      http: service.http,
      alert: (alert) => void alerts.push(alert),
      ...(options.screeningProvider ? { screeningProvider: options.screeningProvider } : {}),
      ...(options.offerKinds ? { offerKinds: options.offerKinds } : {}),
      ...(options.facilitator
        ? { facilitator: async () => base.facilitatorFor(() => database!) }
        : { facilitator: async () => null }),
      ...(options.finalityPerRun !== undefined ? { finalityPerRun: options.finalityPerRun } : {}),
      sponsorPay: options.sponsorPay ?? (async () => null),
      sleep: async (ms) => {
        clockMs += ms;
        await new Promise((resolve) => setImmediate(resolve));
      },
    },
  });
  t.after(() => app.close());
  const db = app.city.db;
  database = db;
  const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    db.query<T>(text, params).then((res) => res.rows);

  const register = async (name: string, password: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: json,
      payload: JSON.stringify({ name, password }),
      remoteAddress: `198.51.100.${address++}`,
    });
    assert.equal(res.statusCode, 201, res.body);
    const session = res.cookies.find((entry) => entry.name === 'cc_session')!.value;
    return { id: res.json().operator.id as string, cookie: `cc_session=${session}` };
  };
  const tool = (token: string, name: string, args: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/assistant/tools/${name}`,
      headers: { ...json, authorization: `Bearer ${token}` },
      payload: JSON.stringify(args),
    });
  let salt = 1n;
  /**
   * One owner ready to pay: the owner's grant (workspace:read, agents:create, pay, services:pay),
   * one agent, the owner's vault and the agent's wallet on the fake Base, funded. The fixture's own
   * owner is the first; addPayer makes another workspace in the same app (its wallet uses the fake
   * Base's one spender account too).
   */
  const payer = async (name: string, password: string) => {
    const owner = await register(name, password);
    const grant = async (scopes: AssistantScope[]) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/assistant-access',
        headers: { ...json, cookie: owner.cookie },
        payload: JSON.stringify({ label: 'Synthetic client', scopes, expiresInDays: 1 }),
      });
      assert.equal(res.statusCode, 201, res.body);
      return res.json() as { grant: { id: string }; token: string };
    };
    const main = await grant(['workspace:read', 'agents:create', 'pay', 'services:pay']);
    const created = await tool(main.token, 'city_create_agent', {
      name: 'hhuo',
      description: 'Synthetic agent',
      capability: 'research',
      mode: 'external',
      idempotencyKey: randomUUID(),
    });
    assert.equal(created.statusCode, 200, created.body);
    const agentId = created.json().agent.id as string;

    // The owner's vault (backup confirmed) and the agent's wallet with its spender account.
    const ownerKey = privateKeyToAccount(generatePrivateKey());
    await sql(
      `INSERT INTO base_owner_vaults (operator_id, owner_address, encrypted_owner_key, kdf_params,
         cipher_params, version, backup_confirmed_at, created_at, updated_at)
       VALUES ($1, $2, decode($3, 'hex'), '{}', '{}', 1, 1, 1, 1)`,
      [owner.id, ownerKey.address, '5a'.repeat(48)],
    );
    const recipe = agentWalletRecipe(WALLET_NET, ownerKey.address, accountIndexFor(agentId));
    const wallet = deriveAddressLocal(recipe);
    const walletId = `wallet-${agentId}`;
    await sql(
      `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
         spender_address, spender_key_ref, derivation, state, created_at, updated_at,
         owner_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'v1:00000000-0000-4000-8000-000000000001', $8,
         'derived', 1, 1, $3)`,
      [
        walletId,
        agentId,
        owner.id,
        CHAIN_ID,
        wallet,
        ownerKey.address,
        base.spender,
        JSON.stringify({
          version: 1,
          owners: recipe.owners,
          factory: recipe.factory,
          implementationVersion: 'test-impl-0001',
          accountIndex: recipe.index.toString(10),
        }),
      ],
    );
    base.credit(wallet, options.funds ?? 10_000_000n);

    /**
     * The owner's spending limit: USDC, a Berlin day cap equal to the allowance. It started a day
     * ago, or at `at.start` (unix seconds; a limit signed before 14 Oct 2026 started at the next
     * 00:00 Berlin). It has no end, or ends at `at.end` (unix seconds).
     */
    const limit = async (
      allowance = options.cap ?? 5_000_000n,
      at: { start?: number; end?: number } = {},
    ) => {
      const permission: SpendPermission = {
        account: getAddress(wallet),
        spender: base.spender,
        token: getAddress(USDC),
        allowance,
        period: 86_400,
        start: at.start ?? Math.floor(clockMs / 1000) - 86_400,
        end: at.end ?? LIMIT_PERMISSION_END,
        salt: salt++,
        extraData: '0x',
      };
      const id = randomUUID();
      const hash = spendPermissionHash(CHAIN_ID, permission).toLowerCase();
      await sql(
        `INSERT INTO base_spend_permissions (permission_id, wallet_id, chain_id, permission,
           signature, state, token, permission_hash, period_kind, cap_raw, onchain_model,
           owner_account_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'signed', $6, $7, 'day', $8, 'full', $9, $10, $10)`,
        [
          id,
          walletId,
          CHAIN_ID,
          JSON.stringify(permissionToJson(permission)),
          Buffer.from('ab'.repeat(65), 'hex'),
          USDC.toLowerCase(),
          hash,
          allowance.toString(10),
          owner.id,
          clockMs,
        ],
      );
      return { id, hash };
    };
    /** The owner's consent screen (GET). */
    const consentView = () =>
      app.inject({
        url: `/api/base/agents/${agentId}/wallet/agent-pay`,
        headers: { cookie: owner.cookie },
      });
    /**
     * The owner's consent for the limit, as the console sends it: with the recipients its screen
     * showed (by default read from the screen now: its confirmRecipients; null sends none).
     */
    const consent = async (permissionHash: string, recipients?: string | null) => {
      const shown =
        recipients === undefined
          ? ((await consentView()).json() as { confirmRecipients: string }).confirmRecipients
          : recipients;
      return app.inject({
        method: 'PUT',
        url: `/api/base/agents/${agentId}/wallet/agent-pay`,
        headers: { ...json, cookie: owner.cookie },
        payload: JSON.stringify({ permissionHash, ...(shown ? { recipients: shown } : {}) }),
      });
    };
    return { owner, grant, main, agentId, ownerKey, wallet, walletId, limit, consentView, consent };
  };
  const { owner, grant, main, agentId, ownerKey, wallet, walletId, limit, consentView, consent } =
    await payer(OWNER, PASSWORD);

  /** A listed service (and a complete sweep, so the Feed lists it). */
  const list = async (
    config: Partial<FakeServiceConfig> & { id?: string; method?: string; scheme?: string } = {},
    input: FeedSchemaSummary | null = INPUT,
  ) => {
    const id = config.id ?? SVC;
    const url = config.url ?? SVC_URL;
    const host = new URL(url).hostname;
    const amount = config.amount ?? '20000';
    await sql(
      `INSERT INTO feed_services (id, record_id, host, url, title, description, capabilities,
         provider_name, method, x402_version, scheme, price_raw, pay_to, input, output,
         paid_calls_30d, payers_30d, last_called_at, source_updated_at, fetched_at, first_seen_at,
         last_seen_at, last_seen_sweep, missed_sweeps, withdrawn_at, risky, hidden, search_text)
       VALUES ($1,$2,$3,$2,'AX1 Console','Grades a token.','{}',NULL,$4,2,$5,$6,$7,$8::jsonb,NULL,
         10,NULL,NULL,NULL,$9,$9,$9,1,0,NULL,NULL,false,'ax1 console')
       ON CONFLICT (id) DO UPDATE SET url = $2, record_id = $2, host = $3, method = $4,
         scheme = $5, price_raw = $6, pay_to = $7, input = $8::jsonb`,
      [
        id,
        url,
        host,
        config.method ?? 'POST',
        config.scheme ?? 'exact',
        amount,
        config.payTo ?? PAY_TO,
        input ? JSON.stringify(input) : null,
        clockMs,
      ],
    );
    await sql(
      `INSERT INTO feed_sources (name, sweep_id, sweep_offset, last_attempt_at, last_success_at,
         last_total, listed)
       VALUES ($1, 1, 0, $2, $2, 6, 3)
       ON CONFLICT (name) DO UPDATE SET last_attempt_at = $2, last_success_at = $2`,
      [BAZAAR_SOURCE, clockMs],
    );
    service.serve({ url, payTo: config.payTo ?? PAY_TO, amount, ...config });
    return id;
  };

  const as = (cookie = owner.cookie) => ({ ...json, cookie });
  // Each quote and call moves the clock past its share of the per-minute budget.
  const quote = (inputs: unknown = BODY, id = SVC, cookie = owner.cookie) => {
    clockMs += 6_100;
    return app.inject({
      method: 'POST',
      url: FEED_PAY_PATHS.quote.replace(':id', id),
      headers: as(cookie),
      payload: JSON.stringify({ inputs }),
    });
  };
  const callService = (body: Record<string, unknown>, id = SVC) => {
    clockMs += 12_100;
    return app.inject({
      method: 'POST',
      url: FEED_PAY_PATHS.call.replace(':id', id),
      headers: as(),
      payload: JSON.stringify(body),
    });
  };
  /** Quote then confirm, as the drawer does. */
  const pay = async (inputs: unknown = BODY, extra: Record<string, unknown> = {}) => {
    const q = await quote(inputs);
    assert.equal(q.statusCode, 200, q.body);
    assert.equal(q.json().payable, true, q.body);
    return callService({
      agentId,
      inputs,
      quoteId: q.json().quoteId,
      maxAmountRaw: q.json().amount.raw,
      // The total confirmed, as the page sends it (the price plus Central City's fee when shown).
      maxTotalRaw: q.json().total.raw,
      idempotencyKey: randomUUID(),
      ...extra,
    });
  };
  const status = (callId: string, cookie = owner.cookie) =>
    app.inject({ url: FEED_PAY_PATHS.callStatus.replace(':callId', callId), headers: as(cookie) });
  const agents = () => app.inject({ url: FEED_PAY_PATHS.agents, headers: as() });
  const history = () =>
    app.inject({ url: FEED_PAY_PATHS.history.replace(':agentId', agentId), headers: as() });
  const cron = () =>
    app.inject({ url: FEED_PAY_PATHS.cron, headers: { authorization: `Bearer ${CRON}` } });
  /** Waits (yielding to the background worker) until the call is done. */
  const settled = async (callId: string): Promise<FeedPayCall> => {
    for (let i = 0; i < 400; i++) {
      const res = await status(callId);
      assert.equal(res.statusCode, 200, res.body);
      const call = res.json() as FeedPayCall;
      if (call.done) return call;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('the call did not finish');
  };

  return {
    app,
    db,
    sql,
    base,
    service,
    alerts,
    owner,
    register,
    main,
    grant,
    tool,
    agentId,
    wallet,
    walletId,
    /** The owner's wallet key (the browser's vault key in production). */
    ownerKey,
    limit,
    consent,
    consentView,
    list,
    quote,
    callService,
    pay,
    status,
    agents,
    history,
    cron,
    settled,
    /** Another owner and workspace in the same app, ready to pay (see payer). */
    addPayer: payer,
    advance: (ms: number) => {
      clockMs += ms;
    },
    clock,
  };
}

export type FeedPayApp = Awaited<ReturnType<typeof setup>>;
