/*
 * json-query and json-schema-check: pure functions over one JSON document of at most 64 KiB
 * (OFFER_KIND_SPECS), the same answer for the same input on every run. Nothing here evaluates
 * code: a path is read by a small hand-written parser, a schema by a fixed list of keywords.
 *
 * Both kinds first parse the document and refuse one nested deeper than JSON_MAX_DEPTH (counted
 * without recursion), so no later step (the walk, the answer's JSON text) can run out of stack.
 * Object keys are only ever read as the document's own properties: "__proto__" or "constructor"
 * are ordinary keys, never the prototype's.
 *
 * json-query reads a path such as `items[*].price`, `$.a.b[0].c`, `a["key with spaces"]` or
 * `rows.*.id`: names joined by dots (letters, digits, _, $ and -), [n] an array index (from 0),
 * [*] or .* every item of an array or every value of an object, ["name"] or ['name'] any key. A
 * path without wildcards matches at most one value; one with wildcards matches each value in
 * document order, at most JSON_QUERY_MAX_MATCHES of them (the answer says when there were more).
 * A step that does not apply (a name on an array, an index past the end) simply matches nothing.
 * The work is bounded by the document: every match is a different value of it.
 *
 * json-schema-check checks a document against a JSON Schema (draft 2020-12) using only these
 * keywords: type (one or a list, integer included), properties, required, items (one schema for
 * every item), enum, const, minimum, maximum, exclusiveMinimum, exclusiveMaximum, minLength,
 * maxLength (in code points), pattern and additionalProperties (true, false or a schema).
 * Annotations ($schema, $id, $comment, title, description, default, examples, deprecated,
 * readOnly, writeOnly) are read and ignored. Any other keyword ($ref, oneOf, format ...) is
 * refused as an input error, so a "valid" answer never hides a rule that was not checked.
 *
 * pattern is the only place a buyer's text becomes a regular expression, so it is bounded on every
 * side before it runs (JSON_SCHEMA_PATTERN_LIMITS): the pattern is short, has no backreferences or
 * lookarounds, no quantified group that holds a quantifier or an alternation (the shapes of
 * exponential backtracking), at most two unbounded quantifiers; it is only run on strings of at
 * most maxSubjectChars characters, at most maxTests times per call. A pattern outside these
 * bounds, or a document that would need more, is refused as an input error before payment.
 */
import { JSON_QUERY_PATH_MAX_BYTES } from '../../../shared/feed-offers.js';
import { jsonAnswer, OfferKindInputError, pureKind } from './kind-core.js';

/** The deepest nesting of arrays and objects either kind reads. */
export const JSON_MAX_DEPTH = 256;

/** Parses text as JSON (OfferKindInputError naming the field) and checks its depth. */
export function parseJsonInput(text: string, field: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new OfferKindInputError(`${field} is not valid JSON.`);
  }
  // Depth without recursion: a stack of [value, depth].
  const stack: Array<[unknown, number]> = [[value, 0]];
  while (stack.length) {
    const [item, depth] = stack.pop()!;
    if (item === null || typeof item !== 'object') continue;
    if (depth + 1 > JSON_MAX_DEPTH)
      throw new OfferKindInputError(`${field} is nested more than ${JSON_MAX_DEPTH} levels deep.`);
    for (const child of Array.isArray(item) ? item : Object.values(item))
      stack.push([child, depth + 1]);
  }
  return value;
}

const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// ---------------------------------------------------------------------------------------------
// json-query

export const JSON_QUERY_MAX_MATCHES = 1_000;
/** The most steps a path may have. */
export const JSON_QUERY_MAX_STEPS = 64;

export type PathStep = { key: string } | { index: number } | { wildcard: true };

const NAME = /^[A-Za-z0-9_$-]+/;

/** The steps of a path; OfferKindInputError (naming the position) for anything else. */
export function parseJsonPath(path: string): PathStep[] {
  const steps: PathStep[] = [];
  let i = 0;
  const fail = (what: string) => new OfferKindInputError(`path has ${what} at character ${i + 1}.`);
  if (path.startsWith('$')) i = 1;
  if (i === path.length && i === 1) return steps;
  if (path.length === 0) throw new OfferKindInputError('path is empty.');
  let first = true;
  while (i < path.length) {
    const c = path[i];
    if (c === '[') {
      const close = path.indexOf(']', i);
      const quote = path[i + 1];
      if (quote === '"' || quote === "'") {
        // A quoted key: up to the same quote followed by ']'; \ escapes the next character.
        let key = '';
        let j = i + 2;
        for (; j < path.length && path[j] !== quote; j++) {
          if (path[j] === '\\' && j + 1 < path.length) j++;
          key += path[j];
        }
        if (path[j] !== quote || path[j + 1] !== ']') throw fail('a quoted key that never closes');
        steps.push({ key });
        i = j + 2;
      } else {
        if (close < 0) throw fail('a [ that never closes');
        const inner = path.slice(i + 1, close);
        if (inner === '*') steps.push({ wildcard: true });
        else if (/^(0|[1-9][0-9]{0,8})$/.test(inner)) steps.push({ index: Number(inner) });
        else throw fail('a bracket that is not [n], [*] or a quoted key');
        i = close + 1;
      }
    } else {
      if (c === '.') i++;
      else if (!first) throw fail('an unexpected character');
      if (path[i] === '*') {
        steps.push({ wildcard: true });
        i++;
      } else {
        const name = NAME.exec(path.slice(i))?.[0];
        if (!name) throw fail('a step without a name');
        steps.push({ key: name });
        i += name.length;
      }
    }
    first = false;
    if (steps.length > JSON_QUERY_MAX_STEPS)
      throw new OfferKindInputError(`path has more than ${JSON_QUERY_MAX_STEPS} steps.`);
  }
  return steps;
}

const SIMPLE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const keyPath = (key: string) => (SIMPLE_KEY.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`);

export interface JsonQueryAnswer {
  count: number;
  truncated: boolean;
  matches: Array<{ path: string; value: unknown }>;
}

export function jsonQuery(document: unknown, steps: readonly PathStep[]): JsonQueryAnswer {
  let current: Array<{ path: string; value: unknown }> = [{ path: '$', value: document }];
  let truncated = false;
  for (const step of steps) {
    const next: typeof current = [];
    for (const { path, value } of current) {
      if ('wildcard' in step) {
        if (Array.isArray(value))
          value.forEach((item, index) => next.push({ path: `${path}[${index}]`, value: item }));
        else if (isObject(value))
          for (const key of Object.keys(value))
            next.push({ path: `${path}${keyPath(key)}`, value: value[key] });
      } else if ('index' in step) {
        if (Array.isArray(value) && step.index < value.length)
          next.push({ path: `${path}[${step.index}]`, value: value[step.index] });
      } else if (isObject(value) && own(value, step.key)) {
        next.push({ path: `${path}${keyPath(step.key)}`, value: value[step.key] });
      }
    }
    current = next;
  }
  if (current.length > JSON_QUERY_MAX_MATCHES) {
    truncated = true;
    current = current.slice(0, JSON_QUERY_MAX_MATCHES);
  }
  return { count: current.length, truncated, matches: current };
}

export const jsonQueryKind = pureKind('json-query', (value) => {
  const path = String(value.path);
  if (Buffer.byteLength(path, 'utf8') > JSON_QUERY_PATH_MAX_BYTES)
    throw new OfferKindInputError(`path is longer than ${JSON_QUERY_PATH_MAX_BYTES} bytes.`);
  const steps = parseJsonPath(path);
  return jsonAnswer(jsonQuery(parseJsonInput(String(value.json), 'json'), steps));
});

// ---------------------------------------------------------------------------------------------
// json-schema-check

export const JSON_SCHEMA_PATTERN_LIMITS = {
  /** The longest pattern, in UTF-16 units. */
  maxPatternLength: 128,
  /** Quantifiers *, +, {n,} and {n,m} with m above 16 in one pattern. */
  maxUnboundedQuantifiers: 2,
  /** The longest string a pattern is run on, in UTF-16 units. */
  maxSubjectChars: 1_000,
  /** Pattern runs per call. */
  maxTests: 100,
} as const;
export const JSON_SCHEMA_MAX_DEPTH = 32;
export const JSON_SCHEMA_MAX_ERRORS = 100;

const ANNOTATIONS = new Set([
  '$schema',
  '$id',
  '$comment',
  'title',
  'description',
  'default',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
]);
const KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'items',
  'enum',
  'const',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'pattern',
  'additionalProperties',
]);
const TYPES = ['null', 'boolean', 'object', 'array', 'number', 'string', 'integer'] as const;
type SchemaType = (typeof TYPES)[number];

/** A schema checked once, before any document is read. */
interface Schema {
  /** true or false: the boolean schemas. */
  always?: boolean;
  types?: SchemaType[];
  properties?: Map<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  hasConst?: boolean;
  const?: unknown;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
  additional?: Schema;
}

/**
 * Whether a regular expression's source stays within JSON_SCHEMA_PATTERN_LIMITS; the reason if
 * not. Reads the source once, tracking the groups it is in.
 */
export function patternProblem(source: string): string | null {
  const limits = JSON_SCHEMA_PATTERN_LIMITS;
  if (source.length > limits.maxPatternLength)
    return `is longer than ${limits.maxPatternLength} characters`;
  // Per open group: whether it holds a quantifier or an alternation.
  const groups: boolean[] = [];
  let unbounded = 0;
  /** The last thing read was a group that holds a quantifier or an alternation. */
  let riskyGroupJustClosed = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    let quantifier: 'bounded' | 'unbounded' | null = null;
    let closedRisky = false;
    if (c === '\\') {
      const next = source[i + 1] ?? '';
      if (/[1-9k]/.test(next)) return 'uses a backreference';
      i++;
    } else if (c === '[') {
      // A class: skip to its closing ] (a \ escapes the next character).
      let j = i + 1;
      if (source[j] === '^') j++;
      if (source[j] === ']') j++;
      for (; j < source.length && source[j] !== ']'; j++) if (source[j] === '\\') j++;
      if (j >= source.length) return 'has a [ that never closes';
      i = j;
    } else if (c === '(') {
      if (source[i + 1] === '?') {
        // Only (?:...) and named groups (?<name>...); lookarounds are refused.
        if (source[i + 2] === ':') i += 2;
        else if (source[i + 2] === '<' && /^\(\?<[A-Za-z_$][A-Za-z0-9_$]*>/.test(source.slice(i)))
          i = source.indexOf('>', i);
        else return 'uses a lookaround or a group this service does not run';
      }
      groups.push(false);
    } else if (c === ')') {
      if (!groups.length) return 'has a ) without a (';
      closedRisky = groups.pop()!;
      // A group holding a risky group is risky itself.
      if (closedRisky && groups.length) groups[groups.length - 1] = true;
    } else if (c === '|') {
      if (groups.length) groups[groups.length - 1] = true;
    } else if (c === '*' || c === '+') {
      quantifier = 'unbounded';
    } else if (c === '?') {
      quantifier = 'bounded';
    } else if (c === '{') {
      const brace = /^\{(\d{1,4})(,(\d{0,4}))?\}/.exec(source.slice(i));
      if (brace) {
        const upper =
          brace[2] === undefined ? Number(brace[1]) : brace[3] ? Number(brace[3]) : Infinity;
        quantifier = upper > 16 ? 'unbounded' : 'bounded';
        i += brace[0].length - 1;
      }
    }
    if (quantifier) {
      // Only ? (zero or once) may follow such a group: any repeat, even a bounded one, can make
      // the engine try the inner choices against each other.
      if (riskyGroupJustClosed && c !== '?')
        return 'repeats a group that holds a quantifier or an alternation';
      if (quantifier === 'unbounded' && ++unbounded > limits.maxUnboundedQuantifiers)
        return `has more than ${limits.maxUnboundedQuantifiers} unbounded quantifiers`;
      // A lazy or possessive marker right after is part of this quantifier.
      if (source[i + 1] === '?') i++;
      if (groups.length) groups[groups.length - 1] = true;
    }
    riskyGroupJustClosed = closedRisky;
  }
  if (groups.length) return 'has a ( that never closes';
  return null;
}

/** A schema read into its checked form; OfferKindInputError naming its place for anything else. */
function readSchema(value: unknown, at: string, depth: number): Schema {
  const refuse = (what: string) => new OfferKindInputError(`schema ${at || '/'} ${what}.`);
  if (depth > JSON_SCHEMA_MAX_DEPTH)
    throw new OfferKindInputError(
      `schema is nested more than ${JSON_SCHEMA_MAX_DEPTH} levels deep.`,
    );
  if (typeof value === 'boolean') return { always: value };
  if (!isObject(value)) throw refuse('is not a schema (an object, true or false)');
  const schema: Schema = {};
  const number = (key: string) => {
    const given = value[key];
    if (typeof given !== 'number' || !Number.isFinite(given))
      throw refuse(`has a ${key} that is not a number`);
    return given;
  };
  const count = (key: string) => {
    const given = value[key];
    if (typeof given !== 'number' || !Number.isSafeInteger(given) || given < 0)
      throw refuse(`has a ${key} that is not a whole number of at least 0`);
    return given;
  };
  for (const key of Object.keys(value)) {
    if (ANNOTATIONS.has(key)) continue;
    if (!KEYWORDS.has(key))
      throw refuse(`uses ${JSON.stringify(key.slice(0, 40))}, which this service does not check`);
    const given = value[key];
    switch (key) {
      case 'type': {
        const list = Array.isArray(given) ? given : [given];
        if (!list.length || !list.every((item) => (TYPES as readonly unknown[]).includes(item)))
          throw refuse(
            'has a type that is not one of null, boolean, object, array, number, string or integer',
          );
        schema.types = list as SchemaType[];
        break;
      }
      case 'properties': {
        if (!isObject(given)) throw refuse('has properties that are not an object');
        schema.properties = new Map(
          Object.keys(given).map((name) => [
            name,
            readSchema(given[name], `${at}/properties/${pointerToken(name)}`, depth + 1),
          ]),
        );
        break;
      }
      case 'required':
        if (!Array.isArray(given) || !given.every((item) => typeof item === 'string'))
          throw refuse('has a required that is not a list of names');
        schema.required = given as string[];
        break;
      case 'items':
        schema.items = readSchema(given, `${at}/items`, depth + 1);
        break;
      case 'additionalProperties':
        schema.additional = readSchema(given, `${at}/additionalProperties`, depth + 1);
        break;
      case 'enum':
        if (!Array.isArray(given) || !given.length) throw refuse('has an enum that is not a list');
        schema.enum = given;
        break;
      case 'const':
        schema.hasConst = true;
        schema.const = given;
        break;
      case 'minimum':
      case 'maximum':
      case 'exclusiveMinimum':
      case 'exclusiveMaximum':
        schema[key] = number(key);
        break;
      case 'minLength':
      case 'maxLength':
        schema[key] = count(key);
        break;
      case 'pattern': {
        if (typeof given !== 'string') throw refuse('has a pattern that is not text');
        const problem = patternProblem(given);
        if (problem) throw refuse(`has a pattern that ${problem}`);
        try {
          schema.pattern = new RegExp(given, 'u');
        } catch {
          throw refuse('has a pattern that is not a valid regular expression');
        }
        break;
      }
    }
  }
  return schema;
}

/** A JSON Pointer token (RFC 6901): ~ as ~0, / as ~1. */
const pointerToken = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');

/** JSON equality as JSON Schema means it (numbers by value, objects regardless of key order). */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => jsonEqual(item, b[index]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => own(b, key) && jsonEqual(a[key], b[key]));
  }
  return false;
}

function typeOf(value: unknown): Exclude<SchemaType, 'integer'> {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value as 'boolean' | 'object' | 'number' | 'string';
}

export interface SchemaCheck {
  valid: boolean;
  /** Every error found (counting stops at JSON_SCHEMA_MAX_ERRORS + 1). */
  error_count: number;
  /** At most JSON_SCHEMA_MAX_ERRORS, in document order; path is a JSON Pointer. */
  errors: Array<{ path: string; message: string }>;
  truncated: boolean;
}

export function checkJsonSchema(document: unknown, schemaValue: unknown): SchemaCheck {
  const root = readSchema(schemaValue, '', 0);
  const errors: Array<{ path: string; message: string }> = [];
  let total = 0;
  let tests = 0;
  const report = (path: string, message: string) => {
    total++;
    if (errors.length < JSON_SCHEMA_MAX_ERRORS) errors.push({ path: path || '/', message });
  };
  const visit = (schema: Schema, value: unknown, path: string) => {
    // The walk follows the schema, at most JSON_SCHEMA_MAX_DEPTH levels; past the error cap it
    // still counts to one more, then stops.
    if (total > JSON_SCHEMA_MAX_ERRORS) return;
    if (schema.always !== undefined) {
      if (!schema.always) report(path, 'No value is allowed here.');
      return;
    }
    const type = typeOf(value);
    if (schema.types) {
      const ok = schema.types.some(
        (want) =>
          want === type || (want === 'integer' && type === 'number' && Number.isInteger(value)),
      );
      if (!ok) {
        report(path, `Must be ${schema.types.join(' or ')}, not ${type}.`);
        return;
      }
    }
    if (schema.enum && !schema.enum.some((item) => jsonEqual(item, value)))
      report(path, 'Must be one of the enum values.');
    if (schema.hasConst && !jsonEqual(schema.const, value))
      report(path, 'Must equal the const value.');
    if (type === 'number') {
      const n = value as number;
      if (schema.minimum !== undefined && n < schema.minimum)
        report(path, `Must be at least ${schema.minimum}.`);
      if (schema.maximum !== undefined && n > schema.maximum)
        report(path, `Must be at most ${schema.maximum}.`);
      if (schema.exclusiveMinimum !== undefined && n <= schema.exclusiveMinimum)
        report(path, `Must be more than ${schema.exclusiveMinimum}.`);
      if (schema.exclusiveMaximum !== undefined && n >= schema.exclusiveMaximum)
        report(path, `Must be less than ${schema.exclusiveMaximum}.`);
    }
    if (type === 'string') {
      const text = value as string;
      if (schema.minLength !== undefined || schema.maxLength !== undefined) {
        // Code points, as JSON Schema counts a string's length.
        let length = 0;
        for (const _ of text) length++;
        if (schema.minLength !== undefined && length < schema.minLength)
          report(path, `Must be at least ${schema.minLength} characters long.`);
        if (schema.maxLength !== undefined && length > schema.maxLength)
          report(path, `Must be at most ${schema.maxLength} characters long.`);
      }
      if (schema.pattern) {
        if (text.length > JSON_SCHEMA_PATTERN_LIMITS.maxSubjectChars)
          throw new OfferKindInputError(
            `json ${path || '/'} is longer than ${JSON_SCHEMA_PATTERN_LIMITS.maxSubjectChars} characters, the most a pattern is checked on.`,
          );
        if (++tests > JSON_SCHEMA_PATTERN_LIMITS.maxTests)
          throw new OfferKindInputError(
            `The document needs more than ${JSON_SCHEMA_PATTERN_LIMITS.maxTests} pattern checks.`,
          );
        if (!schema.pattern.test(text)) report(path, 'Must match the pattern.');
      }
    }
    if (type === 'object') {
      const object = value as Record<string, unknown>;
      for (const name of schema.required ?? [])
        if (!own(object, name)) report(path, `Must have the property ${JSON.stringify(name)}.`);
      for (const key of Object.keys(object)) {
        const child = `${path}/${pointerToken(key)}`;
        const declared = schema.properties?.get(key);
        if (declared && schema.properties!.has(key)) visit(declared, object[key], child);
        else if (schema.additional) {
          if (schema.additional.always === false) report(child, 'This property is not allowed.');
          else visit(schema.additional, object[key], child);
        }
      }
    }
    if (type === 'array' && schema.items) {
      (value as unknown[]).forEach((item, index) => visit(schema.items!, item, `${path}/${index}`));
    }
  };
  visit(root, document, '');
  return {
    valid: total === 0,
    error_count: Math.min(total, JSON_SCHEMA_MAX_ERRORS + 1),
    errors,
    truncated: total > errors.length,
  };
}

export const jsonSchemaCheckKind = pureKind('json-schema-check', (value) => {
  const schema = parseJsonInput(String(value.schema), 'schema');
  const document = parseJsonInput(String(value.json), 'json');
  return jsonAnswer(checkJsonSchema(document, schema));
});
