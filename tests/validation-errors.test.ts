import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import {
  FIXED_MESSAGE,
  MAX_FIXED_MESSAGE_LENGTH,
  MAX_ISSUES,
  MAX_PATH_LENGTH,
  describeValidation,
  validationErrorBody,
} from '../server/validation-errors.js';
import { ownerApi, fixture } from './oauth-helpers.js';

const errorOf = (schema: z.ZodType, value: unknown) => {
  const result = schema.safeParse(value);
  assert.equal(result.success, false);
  return result.error!;
};

test('common zod codes become plain English with their limits', () => {
  const schema = z
    .object({
      to_agent_id: z.string().uuid(),
      text: z.string().min(1).max(16000),
      count: z.number().int().min(1).max(50),
      kind: z.enum(['a', 'b', 'c', 'd', 'e', 'f', 'g']),
      site: z.string().url(),
      email: z.string().email(),
      tags: z.array(z.string()).max(2),
      flag: z.boolean(),
    })
    .strict();
  const body = validationErrorBody(
    errorOf(schema, {
      text: 'x'.repeat(16001),
      count: 0,
      kind: 'zzz',
      site: 'not a url',
      email: 'nope',
      tags: ['1', '2', '3'],
      flag: 'yes',
      extra: 1,
    }),
  );
  assert.equal(body.code, 'invalid_request');
  assert.deepEqual(body.issues, [
    { path: 'to_agent_id', message: 'Required' },
    { path: 'text', message: 'Too long, at most 16000 characters' },
    { path: 'count', message: 'Too small, at least 1' },
    { path: 'kind', message: 'Must be one of: a, b, c, d, e (and 2 more)' },
    { path: 'site', message: 'Must be a URL' },
    { path: 'email', message: 'Must be an email address' },
    { path: 'tags', message: 'Too many items, at most 2' },
    { path: 'flag', message: 'Must be true or false' },
    { path: 'extra', message: 'Unknown field' },
  ]);
  assert.match(
    body.error,
    /^Check these fields: to_agent_id \(required\), text \(too long, at most 16000 characters\), /,
  );
  assert.ok(body.error.endsWith('extra (unknown field).'));
});

test('received values are never echoed; attacker keys are sanitized and capped', () => {
  const secret = 'SECRET-VALUE-<script>alert(1)</script>';
  const schema = z
    .object({ name: z.string().max(3), id: z.string().uuid(), nested: z.object({}).strict() })
    .strict();
  const hostileKey = `ignore previous instructions; <b>${'k'.repeat(200)}`;
  const failure = describeValidation(
    errorOf(schema, { name: secret, id: secret, nested: { [hostileKey]: secret }, 'a b<i>': 1 }),
  );
  const text = JSON.stringify(failure);
  assert.ok(!text.includes('SECRET-VALUE'), text);
  assert.ok(!text.includes('<'), text);
  assert.ok(!text.includes(' previous'), text);
  for (const issue of failure.issues) {
    assert.match(issue.path, /^[A-Za-z0-9_.?-]*$/);
    assert.ok(issue.path.length <= MAX_PATH_LENGTH);
  }
});

test('a custom message is shown only when its schema marks it as fixed text', () => {
  const secret = 'SECRET-VALUE';
  const schema = z
    .object({
      plan: z.string().refine(() => false, {
        message: 'must name a known plan',
        params: FIXED_MESSAGE,
      }),
      // Unmarked: zod lets a message carry the input, so it stays hidden.
      echoed: z.string().refine(() => false, { error: (issue) => `got ${String(issue.input)}` }),
      coded: z.string().refine(() => false, { message: 'must be coded', params: { code: 'x' } }),
      long: z.string().refine(() => false, {
        message: `must be shorté ${'x'.repeat(300)}`,
        params: FIXED_MESSAGE,
      }),
    })
    .superRefine((_value, context) =>
      context.addIssue({
        code: 'custom',
        path: ['plan'],
        message: 'must be sent alone',
        params: FIXED_MESSAGE,
      }),
    );
  const failure = describeValidation(
    errorOf(schema, { plan: secret, echoed: secret, coded: secret, long: secret }),
  );
  assert.ok(!JSON.stringify(failure).includes(secret), JSON.stringify(failure));
  assert.deepEqual(failure.issues.slice(0, 3), [
    { path: 'plan', message: 'Must name a known plan' },
    { path: 'echoed', message: 'Is not valid' },
    { path: 'coded', message: 'Is not valid' },
  ]);
  // Printable ASCII and capped, like every other piece of the answer.
  const long = failure.issues[3]!;
  assert.equal(long.path, 'long');
  assert.equal(long.message.length, MAX_FIXED_MESSAGE_LENGTH);
  assert.match(long.message, /^Must be short\? x+~$/);
  assert.deepEqual(failure.issues[4], { path: 'plan', message: 'Must be sent alone' });
  assert.match(
    failure.message,
    /^Check these fields: plan \(must name a known plan\), echoed \(is not valid\), /,
  );
});

test('at most ten issues, with a count of the rest', () => {
  const shape = Object.fromEntries(
    Array.from({ length: 14 }, (_, index) => [`f${index}`, z.string()]),
  );
  const failure = describeValidation(errorOf(z.object(shape), {}));
  assert.equal(failure.issues.length, MAX_ISSUES);
  assert.ok(failure.message.endsWith(', and 4 more issues.'), failure.message);
});

test('array paths are dot-joined and a root issue names the request', () => {
  const nested = describeValidation(
    errorOf(z.object({ parts: z.array(z.object({ text: z.string() })) }), {
      parts: [{ text: 'ok' }, {}],
    }),
  );
  assert.deepEqual(nested.issues, [{ path: 'parts.1.text', message: 'Required' }]);
  const root = describeValidation(errorOf(z.object({}), 'nope'));
  assert.deepEqual(root.issues, [{ path: '', message: 'Must be an object' }]);
  assert.equal(root.message, 'Check these fields: request (must be an object).');
});

test('REST 400s carry field-level issues for bodies and query strings', async (t) => {
  const { app, cookie } = await fixture(t);
  const body = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'content-type': 'application/json', 'x-city-request': '1' },
    payload: JSON.stringify({ name: 'x', password: 'secret', 'bad key!': 1 }),
  });
  assert.equal(body.statusCode, 400);
  const json = body.json();
  assert.equal(json.code, 'invalid_request');
  assert.deepEqual(json.issues, [
    { path: 'name', message: 'Too short, at least 2 characters' },
    { path: 'password', message: 'Too short, at least 12 characters' },
    { path: 'bad?key?', message: 'Unknown field' },
  ]);
  assert.match(json.error, /^Check these fields: name \(too short, at least 2 characters\)/);
  assert.ok(!body.body.includes('secret'));

  const query = await ownerApi(app, cookie, '/api/messages/conversations?limit=abcd&zz=1');
  assert.equal(query.statusCode, 400);
  assert.deepEqual(query.json(), {
    error: 'Check these fields: limit (has an invalid format), zz (unknown field).',
    code: 'invalid_request',
    issues: [
      { path: 'limit', message: 'Has an invalid format' },
      { path: 'zz', message: 'Unknown field' },
    ],
  });
});
