/**
 * Structured error lines (audit CCA-515). The Fastify logger is off (server/app.ts), so failures
 * are written here instead: one JSON line per event, to the app's log sink (options.logLine, else
 * the console).
 *
 * A line names only facts that carry no personal data: the event, the route pattern (never the
 * URL with its values), the method, the request id, the error's class and a database SQLSTATE or
 * Node system code. Never the message, values, headers or body: a message can quote a received
 * value, an email address or a query.
 */

export type LogLine = (line: string) => void;

const CLASS_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
// PostgreSQL SQLSTATE (5 characters) or a Node system/library code (ECONNRESET, ERR_...).
const SAFE_CODE = /^(?:[0-9A-Z]{5}|E[A-Z0-9_]{2,40}|ERR_[A-Z0-9_]{1,60}|UND_ERR_[A-Z0-9_]{1,40})$/;

export type ErrorFacts = {
  error: string;
  code?: string;
  reason?: string;
  cause?: string;
  cause_code?: string;
};

function className(error: unknown): string {
  if (error === null || error === undefined) return String(error);
  if (typeof error !== 'object' && typeof error !== 'function') return typeof error;
  const name = (error as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof name === 'string' && CLASS_NAME.test(name) ? name : 'unknown';
}

function safeCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && SAFE_CODE.test(code) ? code : undefined;
}

// The driver's own failures are plain Errors with no code. Matched against its fixed wording, and
// only this label is written, so the message itself never reaches a line.
const DRIVER_REASONS: readonly [RegExp, string][] = [
  [/^timeout exceeded when trying to connect/, 'pool_connect_timeout'],
  [/^Query read timeout/, 'query_read_timeout'],
  [/^Connection terminated/, 'connection_terminated'],
  [/^Client has encountered a connection error/, 'connection_error'],
];

function driverReason(error: unknown): string | undefined {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  if (typeof message !== 'string') return undefined;
  return DRIVER_REASONS.find(([wording]) => wording.test(message))?.[1];
}

const FRAME =
  /^\s+at (?:async )?(?:([\w$.<>]{1,80}) \()?(?:.*[\\/])?([\w$.-]{1,80}):(\d{1,7}):\d{1,7}\)?$/;

/**
 * Where an error was thrown: up to three stack frames as function@file:line. Taken line by line
 * from the frames only, the path cut to its file name; the message never matches. Empty if unknown.
 */
export function errorWhere(error: unknown): string | undefined {
  const stack = (error as { stack?: unknown } | null | undefined)?.stack;
  if (typeof stack !== 'string') return undefined;
  const frames: string[] = [];
  for (const line of stack.split('\n')) {
    const frame = FRAME.exec(line);
    if (frame) frames.push(`${frame[1] ?? ''}@${frame[2]}:${frame[3]}`);
    if (frames.length === 3) break;
  }
  return frames.length ? frames.join(' < ') : undefined;
}

/** The error's class and safe code, and the same for its cause (one level). Never a message. */
export function errorFacts(error: unknown): ErrorFacts {
  const facts: ErrorFacts = { error: className(error) };
  const code = safeCode(error);
  if (code) facts.code = code;
  const reason = driverReason(error);
  if (reason) facts.reason = reason;
  const cause =
    error !== null && typeof error === 'object' ? (error as { cause?: unknown }).cause : undefined;
  if (cause !== undefined) {
    facts.cause = className(cause);
    const causeCode = safeCode(cause);
    if (causeCode) facts.cause_code = causeCode;
  }
  return facts;
}

type Field = string | number | boolean | null | undefined;

/** One JSON line: the event first, then the given fields (undefined ones left out). */
export function errorLine(event: string, fields: Record<string, Field> = {}): string {
  const entry: Record<string, Field> = { event };
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) entry[key] = value;
  return JSON.stringify(entry);
}

/** The request facts a line may carry: the route pattern (no values), the method and the id. */
export function requestFacts(request: {
  id?: unknown;
  method?: unknown;
  routeOptions?: { url?: unknown };
}): Record<string, string | null> {
  const route = request.routeOptions?.url;
  return {
    route: typeof route === 'string' && route !== '' ? route : null,
    method: typeof request.method === 'string' ? request.method : null,
    request_id: typeof request.id === 'string' ? request.id : null,
  };
}
