/*
 * The inputs of a Feed pay call (docs/FEED_PAY.md section 5): checked against the listing before
 * anything is requested or paid, and turned into exactly one request. The listed URL is called as
 * listed; `query`, when given, replaces its query string (the provider's example); `body` is sent
 * as JSON only for POST, PUT and PATCH. The path is never changed and header inputs are never sent
 * (a listing that requires one is needs_own_setup). Nothing else is ever added.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FeedField, FeedHttpMethod, FeedSchemaSummary } from '../../../shared/feed.js';
import {
  FEED_PAY_LIMITS,
  type FeedPayInputProblem,
  type FeedPayInputs,
  type FeedPayJson,
} from '../../../shared/feed-pay.js';

/** The shape alone (what the route and the MCP tool parse); the listing check comes after. */
export const feedPayInputsSchema = z
  .object({
    query: z.record(z.string().max(FEED_PAY_LIMITS.queryNameMax * 4), z.string()).optional(),
    body: z.json().optional(),
  })
  .strict();

const BODY_METHODS: ReadonlySet<FeedHttpMethod> = new Set(['POST', 'PUT', 'PATCH']);

export const methodSendsBody = (method: FeedHttpMethod) => BODY_METHODS.has(method);

/** JSON with object keys sorted, so equal inputs always hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
}

export const sha256Hex = (text: string) => createHash('sha256').update(text).digest('hex');

/** The inputs' hash: what a quote binds and an idempotent retry must repeat. */
export const inputsHash = (inputs: FeedPayInputs) => sha256Hex(canonicalJson(inputs));

const isPlainObject = (value: unknown): value is Record<string, FeedPayJson> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Does a value fit a listed type text ("string", "integer | null", "string[]", "unknown")? */
function fits(type: string, value: unknown, fromQuery: boolean): boolean {
  if (!type || type === 'unknown') return true;
  return type.split('|').some((part) => {
    const t = part.trim();
    if (fromQuery) {
      const raw = String(value);
      if (t === 'integer') return /^-?[0-9]+$/.test(raw);
      if (t === 'number') return raw.trim() !== '' && Number.isFinite(Number(raw));
      if (t === 'boolean') return raw === 'true' || raw === 'false';
      // Strings, lists and objects travel as text in a query: the service reads them.
      return t !== 'null';
    }
    if (t === 'string') return typeof value === 'string';
    if (t === 'integer') return typeof value === 'number' && Number.isInteger(value);
    if (t === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (t === 'boolean') return typeof value === 'boolean';
    if (t === 'null') return value === null;
    if (t === 'object') return isPlainObject(value);
    if (t === 'array' || t.endsWith('[]')) return Array.isArray(value);
    return true;
  });
}

/**
 * The problems of these inputs for this listing, in a stable order; empty when they may be sent.
 * Unknown fields are refused only when the listing names all its fields (`more` 0) and has some.
 */
export function inputProblems(
  service: { method: FeedHttpMethod; input: FeedSchemaSummary | null },
  inputs: FeedPayInputs,
): FeedPayInputProblem[] {
  const problems: FeedPayInputProblem[] = [];
  if (Buffer.byteLength(JSON.stringify(inputs)) > FEED_PAY_LIMITS.inputsMaxBytes)
    return [{ field: '', in: null, problem: 'too_large' }];
  const summary = service.input;
  const complete = !!summary && summary.more === 0 && summary.fields.length > 0;
  const fields = (place: FeedField['in']) => summary?.fields.filter((f) => f.in === place) ?? [];

  if (inputs.query !== undefined) {
    const entries = Object.entries(inputs.query);
    if (entries.length > FEED_PAY_LIMITS.queryParamsMax)
      problems.push({ field: '', in: 'query', problem: 'too_large' });
    const listed = new Map(fields('query').map((field) => [field.name, field]));
    for (const [name, value] of entries) {
      if (!name || name.length > FEED_PAY_LIMITS.queryNameMax)
        problems.push({ field: name, in: 'query', problem: 'too_large' });
      else if (value.length > FEED_PAY_LIMITS.queryValueMax)
        problems.push({ field: name, in: 'query', problem: 'too_large' });
      else if (complete && !listed.has(name))
        problems.push({ field: name, in: 'query', problem: 'not_allowed' });
      else if (listed.has(name) && !fits(listed.get(name)!.type, value, true))
        problems.push({ field: name, in: 'query', problem: 'wrong_type' });
    }
    for (const field of listed.values())
      if (field.required && !Object.hasOwn(inputs.query, field.name))
        problems.push({ field: field.name, in: 'query', problem: 'missing' });
  }

  if (!methodSendsBody(service.method)) {
    if (inputs.body !== undefined) problems.push({ field: '', in: 'body', problem: 'not_allowed' });
    return problems;
  }
  const bodyFields = fields('body');
  if (inputs.body === undefined) {
    for (const field of bodyFields)
      if (field.required) problems.push({ field: field.name, in: 'body', problem: 'missing' });
    return problems;
  }
  if (!bodyFields.length) return problems;
  if (!isPlainObject(inputs.body)) {
    problems.push({ field: '', in: 'body', problem: 'wrong_type' });
    return problems;
  }
  const body = inputs.body;
  const listed = new Map(bodyFields.map((field) => [field.name, field]));
  for (const [name, value] of Object.entries(body)) {
    if (complete && !listed.has(name))
      problems.push({ field: name, in: 'body', problem: 'not_allowed' });
    else if (listed.has(name) && !fits(listed.get(name)!.type, value, false))
      problems.push({ field: name, in: 'body', problem: 'wrong_type' });
  }
  for (const field of listed.values())
    if (field.required && !Object.hasOwn(body, field.name))
      problems.push({ field: field.name, in: 'body', problem: 'missing' });
  return problems;
}

/**
 * Deeper than `max` levels of objects and arrays (checked without recursion, before any parser
 * that recurses sees the value).
 */
export function jsonTooDeep(value: unknown, max: number = FEED_PAY_LIMITS.inputsMaxDepth): boolean {
  const stack: Array<[unknown, number]> = [[value, 0]];
  while (stack.length) {
    const [item, depth] = stack.pop()!;
    if (typeof item !== 'object' || item === null) continue;
    if (depth >= max) return true;
    for (const child of Array.isArray(item) ? item : Object.values(item))
      if (typeof child === 'object' && child !== null) stack.push([child, depth + 1]);
  }
  return false;
}

/**
 * A called URL without what the person typed into its query (kept once the paid request was
 * sent or the call ended): scheme, host and path only.
 */
export function withoutQuery(value: string): string {
  try {
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return value.split(/[?#]/)[0] ?? '';
  }
}

/** The one request these inputs make: the listed URL (its query replaced when given) and body. */
export function requestOf(
  service: { url: string; method: FeedHttpMethod },
  inputs: FeedPayInputs,
): { url: string; body: string | null } {
  const url = new URL(service.url);
  url.hash = '';
  if (inputs.query !== undefined) {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(inputs.query)) params.append(name, value);
    url.search = params.toString();
  }
  const body =
    methodSendsBody(service.method) && inputs.body !== undefined
      ? JSON.stringify(inputs.body)
      : null;
  return { url: url.toString(), body };
}
