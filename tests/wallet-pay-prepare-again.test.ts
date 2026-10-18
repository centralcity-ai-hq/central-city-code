import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

/*
 * Pay: "Prepare again" after the signing window closes runs the form's own prepare. Its checks
 * (amount, more than available, note) refuse before prepare marks itself busy, so prepareAgain
 * must not leave busy set when it hands over: otherwise the form stays on "Preparing…" with its
 * button disabled even after the owner corrects the amount.
 */

const source = readFileSync(resolve(process.cwd(), 'src/agents/v4/WalletPayScreen.tsx'), 'utf8');

function body(name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} is defined`);
  const open = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`${name} has no end`);
}

test('prepare refuses on its checks before it marks itself busy', () => {
  const prepare = body('prepare');
  const busyAt = prepare.indexOf('setBusy(true)');
  assert.ok(busyAt > 0);
  const overAt = prepare.indexOf('if (over)');
  assert.ok(overAt > 0 && overAt < busyAt, 'the available-balance check runs before busy');
  // The check itself stays as strict as before.
  assert.match(source, /const over = typed !== null && typed > available;/);
});

test('prepareAgain clears busy before it hands over to prepare', () => {
  const again = body('prepareAgain');
  const handOver = again.indexOf('await prepare(');
  assert.ok(handOver > 0, 'prepareAgain prepares the same form again');
  // The path that reaches prepare: after the last early return (hidden or locked meanwhile).
  const lastReturn = again.lastIndexOf('return;', handOver);
  assert.ok(lastReturn > 0);
  const path = again.slice(lastReturn, handOver);
  assert.match(
    path,
    /setBusy\(false\)/,
    'a refused check in prepare does not leave the form stuck on Preparing',
  );
  assert.doesNotMatch(path, /setBusy\(true\)/);
});
