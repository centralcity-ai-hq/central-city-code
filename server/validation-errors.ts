import type { z } from 'zod';

/**
 * Field-level validation errors shared by REST (server/app.ts) and remote MCP tool errors
 * (server/remote-mcp). A ZodError becomes a readable sentence plus a short list of
 * `{path, message}` issues.
 *
 * Security: received values are never echoed. Field paths do appear, and a path can contain the
 * caller's own keys (unknown fields, record keys); each segment is reduced to [A-Za-z0-9_-]
 * (a dot inside a key becomes `?`, so it cannot pose as nesting) and the path is capped. The
 * rest is the schema's own constraints (limits, allowed options, formats, and the custom messages
 * it marks as fixed text with FIXED_MESSAGE).
 */

export interface ValidationIssue {
  /** Dot-joined field path (`parts.0.text`); empty for the request as a whole. */
  path: string;
  /** Plain-English constraint, for example `Required` or `Too long, at most 200 characters`. */
  message: string;
}

export interface ValidationFailure {
  /** Readable sentence naming the fields, for example `Check these fields: name (required).` */
  message: string;
  issues: ValidationIssue[];
}

export const VALIDATION_ERROR_CODE = 'invalid_request';
export const MAX_ISSUES = 10;
export const MAX_PATH_LENGTH = 100;
export const MAX_FIXED_MESSAGE_LENGTH = 160;
const MAX_OPTIONS = 5;
const MAX_OPTION_LENGTH = 40;

/**
 * Marks a custom issue whose message is the schema's own fixed text, never built from the received
 * value, so it is shown in place of "is not valid". Pass it as the issue's params
 * (`refine(check, { message, params: FIXED_MESSAGE })` or `addIssue({ ..., params: FIXED_MESSAGE
 * })`) and write the message as a short constraint phrase like the others ("must be ..."). An
 * unmarked custom message stays hidden: zod lets one carry the input.
 */
export const FIXED_MESSAGE: Readonly<Record<string, unknown>> = Object.freeze({
  fixedMessage: true,
});

type Issue = z.core.$ZodIssue;

/** Replaces every character outside [A-Za-z0-9_-] with `?`, so keys cannot carry text. */
function sanitizeSegment(segment: PropertyKey): string {
  const text = typeof segment === 'symbol' ? '?' : String(segment);
  return text.replace(/[^A-Za-z0-9_-]/g, '?');
}

export function formatPath(path: readonly PropertyKey[]): string {
  return path.map(sanitizeSegment).join('.').slice(0, MAX_PATH_LENGTH);
}

const plural = (count: number | bigint, one: string, many: string) =>
  `${String(count)} ${Number(count) === 1 ? one : many}`;

/** A schema literal (never a received value), made safe to show: printable ASCII, capped. */
function option(value: unknown): string {
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'bigint'
        ? String(value)
        : (JSON.stringify(value) ?? String(value));
  return printable(text, MAX_OPTION_LENGTH);
}

/** Printable ASCII only, capped (a cut ends in `~`). */
function printable(text: string, max: number): string {
  const clean = text.replace(/[^\x20-\x7e]/g, '?');
  return clean.length > max ? `${clean.slice(0, max - 1)}~` : clean;
}

/** A custom issue's message when its schema marked it as fixed text (FIXED_MESSAGE), else null. */
function fixedMessage(issue: z.core.$ZodIssueCustom): string | null {
  if (issue.params?.fixedMessage !== true) return null;
  const text = printable(issue.message.trim(), MAX_FIXED_MESSAGE_LENGTH);
  return text || null;
}

const TYPE_NAMES: Record<string, string> = {
  string: 'text',
  number: 'a number',
  int: 'a whole number',
  bigint: 'a whole number',
  boolean: 'true or false',
  object: 'an object',
  array: 'a list',
  date: 'a date',
  null: 'null',
};

const FORMAT_NAMES: Record<string, string> = {
  uuid: 'a UUID',
  guid: 'a UUID',
  url: 'a URL',
  email: 'an email address',
  datetime: 'an ISO date and time',
  date: 'an ISO date',
  time: 'an ISO time',
  duration: 'an ISO duration',
  ipv4: 'an IPv4 address',
  ipv6: 'an IPv6 address',
  base64: 'base64 text',
  base64url: 'base64url text',
  jwt: 'a JWT',
  cuid: 'a CUID',
  cuid2: 'a CUID',
  ulid: 'a ULID',
  nanoid: 'a Nano ID',
  emoji: 'an emoji',
  e164: 'an E.164 phone number',
};

function isMissing(issue: Issue): boolean {
  if (issue.code !== 'invalid_type') return false;
  if ('input' in issue) return issue.input === undefined;
  // Zod does not report the input by default; its default message names what it received.
  return /received undefined$/.test(issue.message);
}

function tooBig(issue: z.core.$ZodIssueTooBig): string {
  const limit = issue.maximum;
  const at = issue.inclusive === false ? 'less than' : 'at most';
  switch (issue.origin) {
    case 'string':
      return `too long, ${at} ${plural(limit, 'character', 'characters')}`;
    case 'array':
    case 'set':
      return `too many items, ${at} ${String(limit)}`;
    case 'file':
      return `too large, ${at} ${plural(limit, 'byte', 'bytes')}`;
    case 'date':
      return 'too late';
    default:
      return `too large, ${at} ${String(limit)}`;
  }
}

function tooSmall(issue: z.core.$ZodIssueTooSmall): string {
  const limit = issue.minimum;
  const at = issue.inclusive === false ? 'more than' : 'at least';
  switch (issue.origin) {
    case 'string':
      return Number(limit) === 1 && issue.inclusive !== false
        ? 'must not be empty'
        : `too short, ${at} ${plural(limit, 'character', 'characters')}`;
    case 'array':
    case 'set':
      return Number(limit) === 1 && issue.inclusive !== false
        ? 'must not be empty'
        : `too few items, ${at} ${String(limit)}`;
    case 'file':
      return `too small, ${at} ${plural(limit, 'byte', 'bytes')}`;
    case 'date':
      return 'too early';
    default:
      return `too small, ${at} ${String(limit)}`;
  }
}

/** Lower-case constraint phrase for one issue; never contains the received value. */
function describe(issue: Issue): string {
  if (isMissing(issue)) return 'required';
  switch (issue.code) {
    case 'invalid_type':
      return `must be ${TYPE_NAMES[issue.expected] ?? 'a different type'}`;
    case 'too_big':
      return tooBig(issue);
    case 'too_small':
      return tooSmall(issue);
    case 'invalid_value': {
      const values = issue.values.slice(0, MAX_OPTIONS).map(option);
      if (issue.values.length === 1) return `must be ${values[0]}`;
      const more = issue.values.length - values.length;
      return `must be one of: ${values.join(', ')}${more > 0 ? ` (and ${String(more)} more)` : ''}`;
    }
    case 'invalid_format': {
      const name = FORMAT_NAMES[issue.format];
      return name ? `must be ${name}` : 'has an invalid format';
    }
    case 'not_multiple_of':
      return `must be a multiple of ${String(issue.divisor)}`;
    case 'unrecognized_keys':
      return 'unknown field';
    case 'invalid_union':
      return 'does not match any allowed form';
    case 'invalid_key':
      return 'has an invalid key';
    case 'invalid_element':
      return 'has an invalid item';
    case 'custom':
      return fixedMessage(issue) ?? 'is not valid';
    default:
      return 'is not valid';
  }
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Converts a ZodError into `{message, issues}` (at most MAX_ISSUES issues, deduplicated). */
export function describeValidation(error: z.ZodError): ValidationFailure {
  const all: ValidationIssue[] = [];
  const seen = new Set<string>();
  const add = (path: readonly PropertyKey[], phrase: string) => {
    const issue = { path: formatPath(path), message: capitalize(phrase) };
    const key = `${issue.path}\u0000${issue.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    all.push(issue);
  };
  for (const issue of error.issues) {
    // One issue per unknown key, so each is named by its (sanitized) path.
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) add([...issue.path, key], 'unknown field');
      continue;
    }
    add(issue.path, describe(issue));
  }
  const issues = all.slice(0, MAX_ISSUES);
  const parts = issues.map(
    (issue) =>
      `${issue.path || 'request'} (${issue.message.charAt(0).toLowerCase()}${issue.message.slice(1)})`,
  );
  const more = all.length - issues.length;
  const message = parts.length
    ? `Check these fields: ${parts.join(', ')}${more > 0 ? `, and ${plural(more, 'more issue', 'more issues')}` : ''}.`
    : 'Request fields are invalid.';
  return { message, issues };
}

/** The REST 400 body: `{error, code: 'invalid_request', issues}`. */
export function validationErrorBody(error: z.ZodError): {
  error: string;
  code: typeof VALIDATION_ERROR_CODE;
  issues: ValidationIssue[];
} {
  const { message, issues } = describeValidation(error);
  return { error: message, code: VALIDATION_ERROR_CODE, issues };
}
