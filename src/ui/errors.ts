/**
 * Plain error copy for every server error shape (docs/COPY_GLOSSARY.md).
 *
 * Pure: no I/O, no globals. Server text is never shown, because it can be jargon ("Request fields
 * are invalid.") or contain untrusted names; only the code, status, issues and Retry-After are read.
 *
 * Shapes understood:
 * 1. MCP tool error: CallToolResult `{isError: true, content: [{type:'text', text: '{"error":{code,message,retryable,issues?}}'}]}`.
 * 2. `/mcp` transport error: HTTP status + `{error: "<message>"}`, OAuth-style `{error: "<code>", error_description}`,
 *    or a JSON-RPC error `{jsonrpc: '2.0', error: {code: <number>, message}}`.
 * 3. REST and runtime: HTTP status + `{error: "<message>", code?, issues?: [{code?, path?, message?}]}`;
 *    also `{error: "<code>", message}` (join links).
 * Plus: `ApiError`-like `{status, message}`, fetch network failures (TypeError), aborts and timeouts.
 */

export interface ErrorCopy {
  /** Plain sentence(s) for the person; together with `detail`, at most 20 words. */
  title: string;
  detail?: string;
  /** Form field to mark, from `issues[].path` (dot-joined), when the server provides one. */
  field?: string;
  retryable: boolean;
  retryAfterMs?: number;
  /** Stable machine code for call sites (for example `unauthorized` means redirect to sign-in). */
  code: string;
  /** True when the right action is signing in again (401). */
  signIn?: boolean;
}

export interface ErrorContext {
  /** Name of the agent involved, for "{agent} is paused." */
  agentName?: string;
  /** `navigator.onLine === false`, supplied by the caller. */
  offline?: boolean;
  /** Clock for HTTP-date Retry-After values (defaults to Date.now()). */
  now?: number;
}

type Headers = { get(name: string): string | null } | Record<string, string | string[] | undefined>;

/** An HTTP failure as a call site sees it: status, optional headers and the body (text or parsed). */
export interface HttpErrorInput {
  status: number;
  headers?: Headers;
  body?: unknown;
}

type Copy = { title: string; detail?: string; retryable?: boolean };

const FORM = "Something in this form isn't right. Check it and try again.";
const UNREACHABLE = "We couldn't reach Central City. Try again.";

/** Copy per server code. Keys are the codes the server sends today (including answer and OAuth codes). */
const BY_CODE: Record<string, Copy | ((context: ErrorContext) => Copy)> = {
  // Room and message codes
  invalid_arguments: { title: FORM },
  invite_invalid: {
    title: 'This invite link is invalid or has expired.',
    detail: 'Ask the host for a new link.',
  },
  link_invalid: {
    title: 'This invite link is invalid or has expired.',
    detail: 'Ask the host for a new link.',
  },
  room_closed: { title: 'This room is closed.', detail: 'Its history stays readable.' },
  room_full: { title: 'This room is full.' },
  room_storage_full: { title: 'This room has reached its message limit.', retryable: false },
  read_only: { title: 'You can read this room but not post.' },
  not_a_member: { title: "You're no longer in this room." },
  removed_from_room: { title: "You're no longer in this room." },
  agent_paused: (context) => ({
    title: `${context.agentName ? cleanName(context.agentName) : 'This agent'} is paused.`,
    detail: 'Resume it in Agents.',
  }),
  elric_managed: {
    title: 'Elric is managed by Central City.',
    detail: 'Turn it off in Elric settings instead.',
  },
  workspace_paused: { title: 'Your workspace is paused.', detail: 'Resume it to continue.' },
  rate_limited: {
    title: 'Too many messages at once.',
    detail: 'Try again in a minute.',
    retryable: true,
  },
  message_too_large: { title: 'This message is too long.' },
  too_large: { title: 'This message is too long.' },
  idempotency_conflict: {
    title: 'This was already sent with different content.',
    detail: 'Refresh and try again.',
  },
  connection_required: { title: "Your agent can't message that agent yet." },
  // Authentication (401): the call site redirects to sign-in with `next`.
  unauthorized: { title: 'Your session has ended.', detail: 'Sign in again to continue.' },
  authorization_expired: { title: 'Your session has ended.', detail: 'Sign in again to continue.' },
  invalid_token: { title: 'Your session has ended.', detail: 'Sign in again to continue.' },
  insufficient_scope: {
    title: "Your AI app doesn't have permission for this.",
    detail: 'Reconnect it and allow the permission.',
  },
  // Other codes the server sends today
  forbidden: { title: "You don't have access to this." },
  host_required: { title: 'Only the room host can do this.' },
  agent_revoked: { title: 'This agent has been removed.' },
  agent_required: { title: 'Choose which of your agents posts here.' },
  agent_unavailable: { title: "That agent isn't available right now." },
  context_forbidden: { title: "This conversation isn't available to your agent." },
  same_workspace: { title: 'Both agents are already in your account.' },
  not_found: { title: "We couldn't find that.", detail: 'It may have been removed.' },
  agent_not_found: { title: "We couldn't find that agent." },
  room_not_found: { title: "We couldn't find that room.", detail: 'Ask the host for a new link.' },
  member_not_found: { title: "That agent isn't in this room." },
  request_not_found: { title: "We couldn't find that request." },
  invite_not_found: { title: "We couldn't find that invite." },
  reply_not_found: { title: "The message you're replying to isn't available." },
  gone: { title: 'This is no longer available.' },
  message_expired: { title: 'This message is no longer available.' },
  conflict: { title: 'This changed while you were working.', detail: 'Refresh and try again.' },
  slug_taken: { title: 'That room address is taken.', detail: 'Choose another one.' },
  agent_limit: { title: 'You already have the most agents allowed in this room.' },
  too_many_agents: { title: 'You already have the most agents allowed in this room.' },
  too_many_rooms: { title: "You've reached the limit of open rooms.", detail: 'Close one first.' },
  too_many_invites: {
    title: "You've reached the limit of active invites.",
    detail: 'Revoke one first.',
  },
  too_many_pending: {
    title: 'Too many requests are waiting.',
    detail: 'Try again after some are answered.',
  },
  pending_exists: { title: 'A request is already waiting for an answer.' },
  already_approved: { title: 'These agents are already connected.' },
  not_pending: { title: 'This request was already answered.' },
  cannot_remove_host: { title: "The host can't be removed from its own room." },
  ack_beyond_latest: { title: 'Refresh to see the latest messages.' },
  inbox_full: {
    title: "That agent's inbox is full.",
    detail: 'Try again after it catches up.',
    retryable: true,
  },
  remote_quota: {
    title: "That agent's inbox is full.",
    detail: 'Try again after it catches up.',
    retryable: true,
  },
  ask_timeout: {
    title: 'The city took too long to answer.',
    detail: 'Try again.',
    retryable: true,
  },
  internal_error: { title: UNREACHABLE, retryable: true },
  protocol_error: { title: 'Something went wrong.', detail: 'Try again in a moment.' },
  // Manifest issue codes (they arrive inside issues[] of a 403/409, never as the top-level code)
  QUOTA_EXCEEDED: {
    title: "You've reached the limit for agents.",
    detail: 'Remove one, then try again.',
  },
  OWNER_APPROVAL_REQUIRED: { title: 'This needs your approval first.' },
  UNCLAIMED_ZERO_COST_ONLY: {
    title: 'Without an account, only the free CC agents are allowed.',
    detail: 'Sign in to do more.',
  },
};

/** Manifest issue codes that decide the copy ahead of the top-level code, in priority order. */
const ISSUE_CODES = [
  'UNCLAIMED_ZERO_COST_ONLY',
  'OWNER_APPROVAL_REQUIRED',
  'QUOTA_EXCEEDED',
] as const;

const BY_STATUS: Record<number, { code: string; copy: Copy }> = {
  400: { code: 'invalid_arguments', copy: { title: FORM } },
  401: { code: 'unauthorized', copy: BY_CODE.unauthorized as Copy },
  403: { code: 'forbidden', copy: BY_CODE.forbidden as Copy },
  404: { code: 'not_found', copy: BY_CODE.not_found as Copy },
  409: { code: 'conflict', copy: BY_CODE.conflict as Copy },
  410: { code: 'gone', copy: BY_CODE.gone as Copy },
  413: { code: 'too_large', copy: BY_CODE.too_large as Copy },
  415: { code: 'invalid_arguments', copy: { title: FORM } },
  429: { code: 'rate_limited', copy: BY_CODE.rate_limited as Copy },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const CODE = /^[A-Za-z][A-Za-z0-9_]{1,63}$/;

function cleanName(name: string): string {
  // Untrusted label: strip controls and cap length so it can't become a paragraph.
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean.length > 40 ? `${clean.slice(0, 39)}…` : clean || 'This agent';
}

function header(headers: Headers | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get(name: string): string | null }).get(name) ?? undefined;
  }
  const record = headers as Record<string, string | string[] | undefined>;
  const key = Object.keys(record).find((item) => item.toLowerCase() === name.toLowerCase());
  const value = key === undefined ? undefined : record[key];
  return Array.isArray(value) ? value[0] : value;
}

/** Retry-After as delta-seconds or an HTTP date; returns ms, or undefined when absent/invalid. */
export function parseRetryAfter(value: string | undefined, now = Date.now()): number | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const date = Date.parse(text);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return undefined;
}

function parseBody(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  const text = body.trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return undefined; // HTML, plain text, empty
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

interface Extracted {
  code?: string;
  issues: Array<{ code?: string; path?: string }>;
  retryAfterMs?: number;
  serverRetryable?: boolean;
  jsonRpc?: boolean;
}

function issuesOf(value: unknown): Extracted['issues'] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((issue) => {
    const path = Array.isArray(issue.path)
      ? issue.path.filter((part) => typeof part === 'string' || typeof part === 'number').join('.')
      : typeof issue.path === 'string'
        ? issue.path
        : undefined;
    return {
      code: typeof issue.code === 'string' ? issue.code : undefined,
      path: path || undefined,
    };
  });
}

function extract(body: unknown): Extracted {
  const parsed = parseBody(body);
  if (!isRecord(parsed)) return { issues: [] };
  // MCP tool error body, or a JSON-RPC error.
  if (isRecord(parsed.error)) {
    const inner = parsed.error;
    if (typeof inner.code === 'number' || parsed.jsonrpc === '2.0')
      return { issues: [], jsonRpc: true, code: 'protocol_error' };
    return {
      code: typeof inner.code === 'string' && CODE.test(inner.code) ? inner.code : undefined,
      issues: issuesOf(inner.issues),
      serverRetryable: typeof inner.retryable === 'boolean' ? inner.retryable : undefined,
      retryAfterMs:
        typeof inner.retry_after_ms === 'number' && inner.retry_after_ms >= 0
          ? inner.retry_after_ms
          : undefined,
    };
  }
  // REST/runtime `{error: message, code?}`, OAuth `{error: code, error_description}`,
  // join links `{error: code, message}`.
  const explicit =
    typeof parsed.code === 'string' && CODE.test(parsed.code) ? parsed.code : undefined;
  const errorAsCode =
    typeof parsed.error === 'string' && /^[a-z][a-z0-9_]{1,63}$/.test(parsed.error)
      ? parsed.error
      : undefined;
  return {
    code: explicit ?? errorAsCode,
    issues: issuesOf(parsed.issues),
    retryAfterMs:
      typeof parsed.retry_after_ms === 'number' && parsed.retry_after_ms >= 0
        ? parsed.retry_after_ms
        : undefined,
  };
}

function finish(
  code: string,
  copy: Copy,
  options: { retryable: boolean; retryAfterMs?: number; field?: string; signIn?: boolean },
): ErrorCopy {
  return {
    title: copy.title,
    ...(copy.detail ? { detail: copy.detail } : {}),
    ...(options.field ? { field: options.field } : {}),
    retryable: options.retryable,
    ...(options.retryAfterMs !== undefined ? { retryAfterMs: options.retryAfterMs } : {}),
    code,
    ...(options.signIn ? { signIn: true } : {}),
  };
}

function lookup(code: string, context: ErrorContext): Copy | undefined {
  const entry = BY_CODE[code];
  return typeof entry === 'function' ? entry(context) : entry;
}

function describeHttp(
  status: number,
  extracted: Extracted,
  retryAfterHeader: number | undefined,
  context: ErrorContext,
): ErrorCopy {
  const retryAfterMs = extracted.retryAfterMs ?? retryAfterHeader;
  const field = extracted.issues.find((issue) => issue.path)?.path;
  const signIn = status === 401;

  // Manifest issue codes decide ahead of the generic 403/409.
  const issueCode = ISSUE_CODES.find((code) =>
    extracted.issues.some((issue) => issue.code === code),
  );
  if (issueCode) {
    const copy = lookup(issueCode, context)!;
    return finish(issueCode, copy, { retryable: false, field });
  }

  if (status >= 500 || status === 0) {
    const code = extracted.code === 'ask_timeout' ? 'ask_timeout' : 'unreachable';
    const copy = code === 'ask_timeout' ? lookup(code, context)! : { title: UNREACHABLE };
    return finish(code, copy, { retryable: true, retryAfterMs });
  }

  const known = extracted.code ? lookup(extracted.code, context) : undefined;
  if (extracted.code && known) {
    const retryable =
      extracted.code === 'room_storage_full'
        ? false
        : (known.retryable ?? (status === 429 || extracted.serverRetryable === true));
    return finish(extracted.code, known, { retryable, retryAfterMs, field, signIn });
  }

  const fallback = BY_STATUS[status];
  if (fallback)
    return finish(fallback.code, fallback.copy, {
      retryable: status === 429,
      retryAfterMs,
      field,
      signIn,
    });
  return finish(
    status >= 400 && status < 500 ? 'client_error' : 'unknown',
    {
      title: 'Something went wrong.',
      detail: 'Try again in a moment.',
    },
    { retryable: false, retryAfterMs },
  );
}

/**
 * Maps any error a call site can catch to plain copy. Never returns server text; never says
 * "Request fields are invalid".
 */
export function describeError(err: unknown, context: ErrorContext = {}): ErrorCopy {
  const now = context.now ?? Date.now();
  if (context.offline)
    return finish(
      'offline',
      { title: "You're offline.", detail: "We'll reconnect automatically." },
      {
        retryable: true,
      },
    );

  // 1. MCP CallToolResult with isError.
  if (isRecord(err) && err.isError === true && Array.isArray(err.content)) {
    const text = err.content.find(
      (part): part is { type: 'text'; text: string } =>
        isRecord(part) && part.type === 'text' && typeof part.text === 'string',
    )?.text;
    const extracted = extract(text);
    const status = STATUS_OF_TOOL_CODE[extracted.code ?? ''] ?? 400;
    return describeHttp(status, extracted, undefined, context);
  }

  // Network failures and timeouts.
  if (isRecord(err) || err instanceof Error) {
    const name = (err as { name?: unknown }).name;
    if (name === 'AbortError' || name === 'TimeoutError')
      return finish(
        'timeout',
        { title: 'This is taking too long.', detail: 'Try again.' },
        {
          retryable: true,
        },
      );
    if (err instanceof TypeError && typeof (err as { status?: unknown }).status !== 'number')
      return finish('unreachable', { title: UNREACHABLE }, { retryable: true });
  }

  // 2 and 3. HTTP failures: {status, headers?, body?}, or ApiError-like {status, message}.
  if (isRecord(err) || err instanceof Error) {
    const status = (err as { status?: unknown }).status;
    if (typeof status === 'number') {
      const extracted = extract((err as { body?: unknown }).body);
      const retryAfter = parseRetryAfter(
        header((err as { headers?: Headers }).headers, 'retry-after'),
        now,
      );
      return describeHttp(status, extracted, retryAfter, context);
    }
    // A bare JSON-RPC error object.
    if ((err as { jsonrpc?: unknown }).jsonrpc === '2.0')
      return describeHttp(400, extract(err), undefined, context);
  }

  return finish(
    'unknown',
    { title: 'Something went wrong.', detail: 'Try again in a moment.' },
    {
      retryable: false,
    },
  );
}

/** Tool-error codes map back to the HTTP status the server derived them from (toolErrorCode). */
const STATUS_OF_TOOL_CODE: Record<string, number> = {
  invalid_arguments: 400,
  authorization_expired: 401,
  unauthorized: 401,
  forbidden: 403,
  agent_revoked: 403,
  connection_required: 403,
  host_required: 403,
  not_a_member: 403,
  read_only: 403,
  removed_from_room: 403,
  not_found: 404,
  invite_invalid: 404,
  conflict: 409,
  gone: 410,
  too_large: 413,
  message_too_large: 413,
  rate_limited: 429,
  inbox_full: 429,
  remote_quota: 429,
  room_storage_full: 429,
  internal_error: 500,
  ask_timeout: 503,
};

/** Every code with dedicated copy (used by tests and by call sites that want to branch). */
export const KNOWN_ERROR_CODES = Object.keys(BY_CODE);
