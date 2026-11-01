/**
 * AI-guest smoke harness: behaves exactly like an external AI joining a room.
 *
 * Flow, like a real AI client:
 *  1. GET /j/<code> as JSON and follow its instructions (MCP endpoint + tool).
 *  2. Join through MCP on /mcp/open with city_join_invite.
 *  3. city_room_post, expecting posted: true and a "message #" confirmation.
 *  4. city_room_read with since posted.seq - 1, expecting message.seq === posted.seq.
 *  5. city_room_members.
 *
 * Negative checks: a revoked link is refused, a removed member is refused,
 * other tools with the room credential are refused, and a wrong or expired
 * code gives the uniform invite_invalid.
 *
 * The report never prints the credential, the invite code, or message
 * contents: only step names, timings, message sequence numbers and error
 * codes leave this module.
 */

import { randomBytes, randomUUID } from 'node:crypto';

export const SMOKE_GUEST_NAME = 'Smoke guest';
export const SMOKE_POST_TEXT = 'Smoke harness guest post';

const JOIN_TOOL = 'city_join_invite';
const POST_TOOL = 'city_room_post';
const READ_TOOL = 'city_room_read';
const MEMBERS_TOOL = 'city_room_members';
const FOREIGN_TOOL = 'city_create_agent';
const OPEN_PATH = '/mcp/open';

export interface SmokeRequest {
  method: 'GET' | 'POST';
  path: string;
  accept?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface SmokeResponse {
  status: number;
  bodyText: string;
}

export interface SmokeTransport {
  /** Canonical origin, e.g. https://centralcity.ai (no trailing slash). */
  origin: string;
  request(req: SmokeRequest): Promise<SmokeResponse>;
}

/** Live HTTP transport for runs against a local server or a preview deployment. */
export function httpTransport(baseUrl: string): SmokeTransport {
  const origin = baseUrl.replace(/\/+$/, '');
  return {
    origin,
    async request(req: SmokeRequest): Promise<SmokeResponse> {
      const response = await fetch(`${origin}${req.path}`, {
        method: req.method,
        // Never resend a POST carrying room_credential to a redirect target; fail instead.
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          ...req.headers,
          ...(req.accept ? { accept: req.accept } : {}),
          ...(req.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
      });
      return { status: response.status, bodyText: await response.text() };
    },
  };
}

/**
 * In-process transport for tests: the caller adapts its app (e.g. Fastify
 * inject with an https origin) to the send function. This is the host
 * fixture mode the test suite uses.
 */
export function injectTransport(
  send: (req: SmokeRequest) => Promise<{ statusCode: number; body: string }>,
  origin: string,
): SmokeTransport {
  return {
    origin,
    async request(req: SmokeRequest): Promise<SmokeResponse> {
      const res = await send(req);
      return { status: res.statusCode, bodyText: res.body };
    },
  };
}

const hostMatches = (host: string, suffix: string): boolean =>
  host === suffix || host.endsWith(`.${suffix}`);

function targetHost(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Refuse production targets: centralcity.ai, any *.centralcity.ai, and the
 * host of CITY_PUBLIC_ORIGIN when set. Preview deployments (including
 * vercel.app) are the intended target and are allowed. main() calls this
 * unless --allow-production is passed (which needs the owner's OK).
 */
export function assertNotProductionTarget(
  baseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const host = targetHost(baseUrl) ?? baseUrl.toLowerCase();
  if (hostMatches(host, 'centralcity.ai'))
    throw new Error(
      'Refusing smoke run against production centralcity.ai without --allow-production.',
    );
  const production = env['CITY_PUBLIC_ORIGIN'];
  if (production) {
    const productionHost = targetHost(production) ?? production.toLowerCase();
    if (productionHost && hostMatches(host, productionHost))
      throw new Error(
        'Refusing smoke run against the production origin (CITY_PUBLIC_ORIGIN) ' +
          'without --allow-production.',
      );
  }
}

/** Accept a bare code or a full invite link; never echoes the input. */
export function inviteCodeFromInput(input: string): string {
  const trimmed = input.trim();
  const path = trimmed.includes('/j/') ? (trimmed.split('/j/').pop() ?? '') : trimmed;
  const code = path.split(/[?#]/)[0] ?? '';
  if (!/^[A-Za-z0-9_.-]{43,160}$/.test(code))
    throw new Error('Invite input must be a join code or a full /j/ link.');
  return code;
}

export interface ToolResultContent {
  text?: string;
  [key: string]: unknown;
}

export interface ToolCallResult {
  content?: ToolResultContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolOutcome {
  status: number;
  result?: ToolCallResult;
  error?: unknown;
  raw: string;
}

let rpcId = 1;

type RpcEnvelope = { result?: ToolCallResult; error?: unknown };

function parseRpcBody(bodyText: string): RpcEnvelope {
  const text = bodyText.trim();
  if (text.startsWith('{')) return JSON.parse(text) as RpcEnvelope;
  const data = text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('');
  return JSON.parse(data) as RpcEnvelope;
}

/** One JSON-RPC tools/call against the open MCP endpoint. */
export async function callOpenTool(
  transport: SmokeTransport,
  tool: string,
  args: Record<string, unknown>,
  openPath = OPEN_PATH,
): Promise<ToolOutcome> {
  const res = await transport.request({
    method: 'POST',
    path: openPath,
    accept: 'application/json, text/event-stream',
    body: {
      jsonrpc: '2.0',
      id: rpcId++,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    },
  });
  if (res.status !== 200) return { status: res.status, raw: res.bodyText };
  try {
    const parsed = parseRpcBody(res.bodyText);
    return { status: res.status, result: parsed.result, error: parsed.error, raw: res.bodyText };
  } catch {
    return { status: res.status, raw: res.bodyText };
  }
}

/** The uniform error code a refused tool call carries, if any. */
export function outcomeErrorCode(outcome: ToolOutcome): string | null {
  try {
    if (outcome.error) return 'rpc_error';
    const text = outcome.result?.content?.[0]?.text;
    if (typeof text !== 'string') return null;
    const code = (JSON.parse(text) as { error?: { code?: unknown } }).error?.code;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

export interface InviteDocument {
  ok: boolean;
  status: number;
  /** Path of the open MCP endpoint the document points at. */
  openPath: string;
}

/** Step 1: read the invite link document and follow its instructions. */
export async function fetchInviteDocument(
  transport: SmokeTransport,
  code: string,
): Promise<InviteDocument> {
  const res = await transport.request({
    method: 'GET',
    path: `/j/${code}?format=json`,
    accept: 'application/json',
  });
  if (res.status !== 200) return { ok: false, status: res.status, openPath: OPEN_PATH };
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(res.bodyText) as Record<string, unknown>;
  } catch {
    return { ok: false, status: res.status, openPath: OPEN_PATH };
  }
  const text = res.bodyText;
  const mentionsJoin = text.includes(JOIN_TOOL) && text.includes('mcp/open');
  const mcp = doc['mcp'] as Record<string, unknown> | undefined;
  let openPath = OPEN_PATH;
  if (mcp && typeof mcp['open_url'] === 'string') {
    try {
      const pathname = new URL(mcp['open_url'] as string).pathname;
      if (pathname.endsWith(OPEN_PATH)) openPath = pathname;
    } catch {
      openPath = OPEN_PATH;
    }
  }
  return { ok: mentionsJoin, status: res.status, openPath };
}

export interface GuestSession {
  credential: string;
  roomId: string;
  agentId: string;
  /** Redeems a host rejoin link together with it; absent when the answer carried none. */
  recoveryCode?: string;
}

export interface JoinOutcome {
  ok: boolean;
  code: string | null;
  guest: GuestSession | null;
  raw: string;
}

/**
 * Step 2: join through MCP on /mcp/open using city_join_invite (a rejoin link goes with the
 * member's recovery code).
 */
export async function joinWithInvite(
  transport: SmokeTransport,
  code: string,
  name: string,
  idempotencyKey?: string,
  openPath = OPEN_PATH,
  recoveryCode?: string,
): Promise<JoinOutcome> {
  const outcome = await callOpenTool(
    transport,
    JOIN_TOOL,
    {
      invite_link: `${transport.origin}/j/${code}`,
      name,
      ...(idempotencyKey === undefined ? {} : { idempotency_key: idempotencyKey }),
      ...(recoveryCode === undefined ? {} : { recovery_code: recoveryCode }),
    },
    openPath,
  );
  const structured = outcome.result?.structuredContent;
  const credential = structured?.['room_credential'];
  const recovery = structured?.['recovery_code'];
  const roomId = structured?.['room_id'];
  const agentId = structured?.['agent_id'];
  if (
    outcome.result &&
    !outcome.result.isError &&
    typeof credential === 'string' &&
    credential.startsWith('crc_') &&
    typeof roomId === 'string' &&
    typeof agentId === 'string'
  )
    return {
      ok: true,
      code: null,
      guest: {
        credential,
        roomId,
        agentId,
        ...(typeof recovery === 'string' ? { recoveryCode: recovery } : {}),
      },
      raw: outcome.raw,
    };
  return { ok: false, code: outcomeErrorCode(outcome), guest: null, raw: outcome.raw };
}

export interface PostOutcome {
  ok: boolean;
  code: string | null;
  seq: number | null;
  raw: string;
}

/** Step 3: post and check posted: true plus the "message #" confirmation. */
export async function postAsGuest(
  transport: SmokeTransport,
  credential: string,
  text: string,
  idempotencyKey: string,
  openPath = OPEN_PATH,
): Promise<PostOutcome> {
  const outcome = await callOpenTool(
    transport,
    POST_TOOL,
    { room_credential: credential, text, idempotency_key: idempotencyKey },
    openPath,
  );
  const structured = outcome.result?.structuredContent;
  const message = structured?.['message'] as { seq?: unknown } | undefined;
  const seqValue = message?.seq;
  const seq = typeof seqValue === 'number' ? seqValue : null;
  const confirmed =
    outcome.result &&
    !outcome.result.isError &&
    structured?.['posted'] === true &&
    seq !== null &&
    (outcome.result.content ?? []).some(
      (entry) => typeof entry.text === 'string' && entry.text.includes(`message #${seq}`),
    );
  if (confirmed) return { ok: true, code: null, seq, raw: outcome.raw };
  return { ok: false, code: outcomeErrorCode(outcome), seq, raw: outcome.raw };
}

export interface RoomMessage {
  text?: string;
  seq?: number;
  [key: string]: unknown;
}

export interface ReadOutcome {
  ok: boolean;
  code: string | null;
  messages: RoomMessage[];
  raw: string;
}

/** Step 4: read the room, optionally only messages after `since`. */
export async function readAsGuest(
  transport: SmokeTransport,
  credential: string,
  openPath = OPEN_PATH,
  since?: number,
): Promise<ReadOutcome> {
  const outcome = await callOpenTool(
    transport,
    READ_TOOL,
    { room_credential: credential, ...(since === undefined ? {} : { since }) },
    openPath,
  );
  const messages = outcome.result?.structuredContent?.['messages'];
  if (outcome.result && !outcome.result.isError && Array.isArray(messages))
    return { ok: true, code: null, messages: messages as RoomMessage[], raw: outcome.raw };
  return { ok: false, code: outcomeErrorCode(outcome), messages: [], raw: outcome.raw };
}

export interface MembersOutcome {
  ok: boolean;
  code: string | null;
  memberIds: string[];
  raw: string;
}

/** Step 5: list the room members. */
export async function listMembersAsGuest(
  transport: SmokeTransport,
  credential: string,
  openPath = OPEN_PATH,
): Promise<MembersOutcome> {
  const outcome = await callOpenTool(
    transport,
    MEMBERS_TOOL,
    { room_credential: credential },
    openPath,
  );
  const members = outcome.result?.structuredContent?.['members'];
  if (outcome.result && !outcome.result.isError && Array.isArray(members)) {
    const memberIds = (members as Array<Record<string, unknown>>)
      .map((member) => member['id'])
      .filter((id): id is string => typeof id === 'string');
    return { ok: true, code: null, memberIds, raw: outcome.raw };
  }
  return { ok: false, code: outcomeErrorCode(outcome), memberIds: [], raw: outcome.raw };
}

/** A non-room tool on /mcp/open must be refused. */
export async function callForeignTool(transport: SmokeTransport): Promise<ToolOutcome> {
  return callOpenTool(transport, FOREIGN_TOOL, { name: 'Smoke probe' });
}

export interface RenewOutcome {
  ok: boolean;
  code: string | null;
  credential: string | null;
  raw: string;
}

/** Renew a live guest credential (city_room_renew); the old one must stop working. */
export async function renewAsGuest(
  transport: SmokeTransport,
  credential: string,
  openPath = OPEN_PATH,
): Promise<RenewOutcome> {
  const outcome = await callOpenTool(
    transport,
    'city_room_renew',
    { room_credential: credential },
    openPath,
  );
  const next = outcome.result?.structuredContent?.['room_credential'];
  if (outcome.result && !outcome.result.isError && typeof next === 'string')
    return { ok: true, code: null, credential: next, raw: outcome.raw };
  return { ok: false, code: outcomeErrorCode(outcome), credential: null, raw: outcome.raw };
}

export interface LeaveOutcome {
  ok: boolean;
  code: string | null;
  raw: string;
}

/** Leave the room as a guest (city_room_leave); absent until #120 lands on main. */
export async function leaveAsGuest(
  transport: SmokeTransport,
  credential: string,
  openPath = OPEN_PATH,
): Promise<LeaveOutcome> {
  const outcome = await callOpenTool(
    transport,
    'city_room_leave',
    { room_credential: credential },
    openPath,
  );
  if (outcome.result && !outcome.result.isError) return { ok: true, code: null, raw: outcome.raw };
  return { ok: false, code: outcomeErrorCode(outcome), raw: outcome.raw };
}

export interface OpenToolSchema {
  name: string;
  /** Top-level input property names of the tool, or [] when not advertised. */
  properties: string[];
}

/** tools/list on the open endpoint: names plus input properties for feature probes. */
export async function listOpenToolSchemas(
  transport: SmokeTransport,
  openPath = OPEN_PATH,
): Promise<{ ok: boolean; tools: OpenToolSchema[]; raw: string }> {
  const res = await transport.request({
    method: 'POST',
    path: openPath,
    accept: 'application/json, text/event-stream',
    body: { jsonrpc: '2.0', id: rpcId++, method: 'tools/list', params: {} },
  });
  if (res.status !== 200) return { ok: false, tools: [], raw: res.bodyText };
  try {
    const parsed = parseRpcBody(res.bodyText) as {
      result?: { tools?: { name?: unknown; inputSchema?: { properties?: unknown } }[] };
    };
    const listed = parsed.result?.tools;
    if (!Array.isArray(listed)) return { ok: false, tools: [], raw: res.bodyText };
    return {
      ok: true,
      tools: listed.map((tool) => ({
        name: typeof tool.name === 'string' ? tool.name : '',
        properties:
          tool.inputSchema &&
          typeof tool.inputSchema === 'object' &&
          (tool.inputSchema as { properties?: unknown }).properties &&
          typeof (tool.inputSchema as { properties?: unknown }).properties === 'object'
            ? Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties)
            : [],
      })),
      raw: res.bodyText,
    };
  } catch {
    return { ok: false, tools: [], raw: res.bodyText };
  }
}

/** True when city_join_invite advertises a short-code input (newer servers). */
export function joinAcceptsCode(tools: OpenToolSchema[]): boolean {
  const join = tools.find((tool) => tool.name === 'city_join_invite');
  if (!join) return false;
  return join.properties.some((property) =>
    ['code', 'short_code', 'shortcode', 'join_code', 'invite_code'].includes(property),
  );
}

export interface SmokeStep {
  name: string;
  ok: boolean;
  ms: number;
  note: string;
}

export interface SmokeReport {
  ok: boolean;
  ms: number;
  steps: SmokeStep[];
}

/** Short PASS/FAIL report with timings. Notes carry only seq numbers and error codes. */
export function formatSmokeReport(report: SmokeReport): string {
  const passed = report.steps.filter((step) => step.ok).length;
  const lines = [
    `AI guest smoke: ${report.ok ? 'PASS' : 'FAIL'} (${passed}/${report.steps.length} steps, ${report.ms} ms)`,
  ];
  for (const step of report.steps)
    lines.push(
      `  ${step.ok ? 'ok' : 'FAIL'} ${step.name} (${step.ms} ms)${step.note ? ` ${step.note}` : ''}`,
    );
  return lines.join('\n');
}

export interface SmokeOptions {
  invite: string;
  name?: string;
  postText?: string;
}

async function timed(
  name: string,
  run: () => Promise<{ ok: boolean; note: string }>,
): Promise<SmokeStep> {
  const start = Date.now();
  const result = await run();
  return { name, ok: result.ok, ms: Date.now() - start, note: result.note };
}

/**
 * The full positive flow: invite document, join, post, read, members.
 * Secrets stay in local variables; the report carries no credential, code or text.
 */
export async function runAiGuestSmoke(
  transport: SmokeTransport,
  options: SmokeOptions,
): Promise<SmokeReport> {
  const started = Date.now();
  const code = inviteCodeFromInput(options.invite);
  const name = options.name ?? SMOKE_GUEST_NAME;
  const postText = options.postText ?? SMOKE_POST_TEXT;
  let openPath = OPEN_PATH;
  let guest: GuestSession | null = null;
  let postedSeq: number | null = null;

  const steps: SmokeStep[] = [];
  steps.push(
    await timed('invite-doc', async () => {
      const doc = await fetchInviteDocument(transport, code);
      if (doc.ok) openPath = doc.openPath;
      return { ok: doc.ok, note: doc.ok ? '' : `status ${doc.status}` };
    }),
  );
  steps.push(
    await timed('join', async () => {
      if (!steps[0]?.ok) return { ok: false, note: 'skipped' };
      // A real stateless agent joins with a fresh idempotency key per attempt.
      const joined = await joinWithInvite(transport, code, name, randomUUID(), openPath);
      if (joined.ok) guest = joined.guest;
      return { ok: joined.ok, note: joined.ok ? '' : `code ${joined.code ?? 'unknown'}` };
    }),
  );
  steps.push(
    await timed('post', async () => {
      if (!guest) return { ok: false, note: 'skipped' };
      // Fresh random key per run; a retry would reuse the caller's key instead.
      const posted = await postAsGuest(
        transport,
        guest.credential,
        postText,
        randomUUID(),
        openPath,
      );
      if (posted.ok && posted.seq !== null) {
        postedSeq = posted.seq;
        return { ok: true, note: `message #${posted.seq}` };
      }
      return { ok: false, note: `code ${posted.code ?? 'unknown'}` };
    }),
  );
  steps.push(
    await timed('read', async () => {
      if (!guest || postedSeq === null) return { ok: false, note: 'skipped' };
      // Narrow the read to our own post and match on seq, never on text: repeated
      // runs and busy rooms pass, and no message content is compared.
      const read = await readAsGuest(
        transport,
        guest.credential,
        openPath,
        Math.max(0, postedSeq - 1),
      );
      const found = read.messages.filter((message) => message.seq === postedSeq).length;
      if (read.ok && found === 1) return { ok: true, note: `post visible ${found}x` };
      return { ok: false, note: `code ${read.code ?? 'unknown'}` };
    }),
  );
  steps.push(
    await timed('members', async () => {
      if (!guest) return { ok: false, note: 'skipped' };
      const members = await listMembersAsGuest(transport, guest.credential, openPath);
      const self = guest !== null && members.memberIds.includes(guest.agentId);
      if (members.ok && self) return { ok: true, note: `${members.memberIds.length} member(s)` };
      return { ok: false, note: `code ${members.code ?? 'unknown'}` };
    }),
  );
  return { ok: steps.every((step) => step.ok), ms: Date.now() - started, steps };
}

/**
 * Self-contained negative checks: a wrong code gives the uniform
 * invite_invalid, an unknown credential is refused, and a non-room tool on
 * /mcp/open is refused. Revoked-link, removed-member and expired-code checks
 * need host actions, so the test suite drives those with the step primitives.
 */
export async function runAiGuestRefusals(transport: SmokeTransport): Promise<SmokeReport> {
  const started = Date.now();
  const fresh = randomBytes(32).toString('base64url');
  const steps: SmokeStep[] = [];
  steps.push(
    await timed('wrong-code', async () => {
      const joined = await joinWithInvite(transport, fresh, SMOKE_GUEST_NAME);
      const refused = !joined.ok && joined.code === 'invite_invalid';
      return { ok: refused, note: `code ${joined.code ?? 'unknown'}` };
    }),
  );
  steps.push(
    await timed('unknown-credential', async () => {
      const read = await readAsGuest(transport, `crc_${fresh}`);
      const refused = !read.ok && read.code === 'room_credential_denied';
      const leaked = read.raw.includes(fresh);
      return { ok: refused && !leaked, note: `code ${read.code ?? 'unknown'}` };
    }),
  );
  steps.push(
    await timed('open-rejects-foreign-tool', async () => {
      const outcome = await callForeignTool(transport);
      const refused = Boolean(outcome.error) || outcome.result?.isError === true;
      return { ok: refused, note: outcomeErrorCode(outcome) ?? (refused ? 'refused' : 'allowed') };
    }),
  );
  return { ok: steps.every((step) => step.ok), ms: Date.now() - started, steps };
}

function usage(): string {
  return [
    'Usage: tsx scripts/smoke/ai-guest.ts --base-url <origin> --invite <link-or-code> [--name <name>] [--refusals]',
    '   or: SMOKE_INVITE=<link-or-code> tsx scripts/smoke/ai-guest.ts --base-url <origin> [--refusals]',
    '',
    'Runs the AI-guest smoke flow against a server or preview deployment.',
    'Prefer SMOKE_INVITE over --invite: it keeps the secret out of shell history and the process list.',
    'Never run against production without the owner\u2019s OK (--allow-production).',
  ].join('\n');
}

async function main(argv: string[]): Promise<number> {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  const baseUrl = flag('--base-url');
  const invite = flag('--invite') ?? flag('--code') ?? process.env['SMOKE_INVITE'];
  if (!baseUrl || !invite || argv.includes('--help')) {
    console.log(usage());
    return baseUrl && invite ? 0 : 2;
  }
  if (!argv.includes('--allow-production')) {
    try {
      assertNotProductionTarget(baseUrl);
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Refusing production smoke run.');
      return 2;
    }
  }
  const transport = httpTransport(baseUrl);
  const report = await runAiGuestSmoke(transport, { invite, name: flag('--name') });
  console.log(formatSmokeReport(report));
  if (argv.includes('--refusals')) {
    const refusals = await runAiGuestRefusals(transport);
    console.log(formatSmokeReport(refusals));
    return report.ok && refusals.ok ? 0 : 1;
  }
  return report.ok ? 0 : 1;
}

if (process.argv[1]?.endsWith('ai-guest.ts')) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : 'Smoke run failed.');
      process.exitCode = 1;
    },
  );
}
