import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../server/app.js';
import { createHostedHandler, installCrashMonitor } from '../server/vercel-handler.js';
import { errorFacts, errorWhere } from '../server/error-log.js';

const SECRET = 'synthetic-private-value@example.test';

test('CCA-515: an unexpected 500 writes one JSON line: route pattern, class, SQLSTATE, request id; never the message or values', async (t) => {
  const lines: string[] = [];
  const app = await createApp({
    dataDir: ':memory:',
    startWorkers: false,
    logLine: (line) => lines.push(line),
  });
  t.after(() => app.close());
  class StoreFailure extends Error {
    code = '23505';
  }
  app.get('/api/test-only/fail/:value', async () => {
    throw new StoreFailure(`duplicate key (email)=(${SECRET})`);
  });
  const response = await app.inject({
    method: 'GET',
    url: `/api/test-only/fail/${encodeURIComponent(SECRET)}?q=${encodeURIComponent(SECRET)}`,
  });
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.includes(SECRET), false);
  const failures = lines
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.event === 'request_failed');
  assert.equal(failures.length, 1, `one request_failed line, got ${JSON.stringify(lines)}`);
  const [entry] = failures;
  assert.equal(entry.route, '/api/test-only/fail/:value');
  assert.equal(entry.method, 'GET');
  assert.equal(entry.error, 'StoreFailure');
  assert.equal(entry.code, '23505');
  assert.match(entry.request_id, /^[0-9a-f-]{36}$/);
  assert.equal(lines.join('\n').includes('synthetic-private'), false, 'no message or value');
  assert.equal(lines.join('\n').includes('duplicate key'), false);
});

test('CCA-515: a refused request (4xx) writes no failure line', async (t) => {
  const lines: string[] = [];
  const app = await createApp({
    dataDir: ':memory:',
    startWorkers: false,
    logLine: (line) => lines.push(line),
  });
  t.after(() => app.close());
  await app.inject({ method: 'GET', url: '/api/session' });
  assert.equal(
    lines.some((line) => line.includes('request_failed')),
    false,
  );
});

test('CCA-515: a failed cold start writes one line with the class and code of its cause, never the message', async () => {
  const lines: string[] = [];
  const cause = Object.assign(new Error(`password authentication failed for ${SECRET}`), {
    code: '28P01',
  });
  const handler = createHostedHandler(
    async () => {
      throw new Error('Hosted database initialization failed.', { cause });
    },
    (line) => lines.push(line),
  );
  const response = new EventEmitter() as ServerResponse & { status?: number; body?: string };
  Object.assign(response, {
    headersSent: false,
    writeHead(status: number) {
      response.status = status;
      return response;
    },
    end(body?: string) {
      response.body = body;
    },
  });
  await handler({ url: '/api/session', headers: {} } as IncomingMessage, response);
  assert.equal(response.status, 503);
  const entries = lines.map((line) => JSON.parse(line));
  assert.deepEqual(entries, [
    { event: 'cold_start_failed', error: 'Error', cause: 'Error', cause_code: '28P01' },
  ]);
  assert.equal(lines.join('').includes('synthetic-private'), false);
});

test('CCA-515: a process crash is recorded (class and code only) without changing how Node handles it', () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: unknown) => lines.push(String(line));
  try {
    installCrashMonitor(); // already installed when the module loaded; a second call adds nothing
    const crash = Object.assign(new TypeError(SECRET), { code: 'ERR_INVALID_ARG_TYPE' });
    process.emit('uncaughtExceptionMonitor', crash, 'unhandledRejection');
  } finally {
    console.error = original;
  }
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    [
      {
        event: 'process_crash',
        origin: 'unhandledRejection',
        error: 'TypeError',
        code: 'ERR_INVALID_ARG_TYPE',
      },
    ],
  );
  // Only the monitor: no 'uncaughtException'/'unhandledRejection' handler that would swallow it.
  const source = readFileSync('server/vercel-handler.ts', 'utf8');
  assert.equal(/process\.on\('(?:uncaughtException|unhandledRejection)'/.test(source), false);
});

test('CCA-515: errorFacts keeps only safe codes', () => {
  assert.deepEqual(errorFacts(Object.assign(new Error('x'), { code: SECRET })), { error: 'Error' });
  assert.deepEqual(errorFacts('plain text'), { error: 'string' });
  assert.deepEqual(errorFacts(Object.assign(new RangeError('x'), { code: 'ECONNRESET' })), {
    error: 'RangeError',
    code: 'ECONNRESET',
  });
});

test('a driver failure with no code gets a fixed label, and the message never reaches a line', () => {
  assert.deepEqual(errorFacts(new Error('timeout exceeded when trying to connect')), {
    error: 'Error',
    reason: 'pool_connect_timeout',
  });
  assert.equal(
    errorFacts(new Error('Connection terminated unexpectedly')).reason,
    'connection_terminated',
  );
  assert.deepEqual(errorFacts(new Error(`other ${SECRET}`)), { error: 'Error' });
});

test('errorWhere: frames only, file names only, never the message', () => {
  const error = new Error(`at ${SECRET} (C:/secret/path.ts:1:1)`);
  error.stack = [
    `Error: boom ${SECRET}`,
    `    at evil (/home/${SECRET}/x.ts:1:1) ${SECRET}`,
    '    at verifyKey (/var/task/api/_bundle.mjs:120:7)',
    '    at async Object.handler (/var/task/api/_bundle.mjs:900:3)',
    '    at /var/task/api/_bundle.mjs:5:1',
    '    at last (/var/task/api/_bundle.mjs:6:1)',
  ].join('\n');
  const where = errorWhere(error);
  assert.equal(
    where,
    'verifyKey@_bundle.mjs:120 < Object.handler@_bundle.mjs:900 < @_bundle.mjs:5',
  );
  assert.equal(errorWhere('text'), undefined);
  assert.equal(errorWhere(null), undefined);
});

test('CCA-515: no server code writes to the disabled Fastify logger or logs an error message', () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.ts')) {
        const source = readFileSync(path, 'utf8');
        source.split('\n').forEach((line, index) => {
          if (/\b(?:app|request|fastify)\.log\.(?:info|warn|error|debug|fatal|trace)\b/.test(line))
            offenders.push(`${path}:${index + 1} ${line.trim()}`);
          if (/\b(?:app|request)\.log\[/.test(line))
            offenders.push(`${path}:${index + 1} ${line.trim()}`);
        });
        if (/rooms\.notify_owners[^\n]*\(error as Error\)\.message/.test(source))
          offenders.push(`${path}: rooms.notify_owners logs the error message`);
      }
    }
  };
  walk('server');
  assert.deepEqual(offenders, []);
});
