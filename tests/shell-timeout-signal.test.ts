import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { timeoutSignal } from '../src/shell/timeoutSignal.js';

/*
 * The console's polls must not need AbortSignal.any, which older browsers lack (the call throws
 * before any request goes out, so badges and lists never load). timeoutSignal stands in for it.
 */

test('timeoutSignal works without AbortSignal.any', async (t) => {
  t.mock.method(AbortSignal, 'any', () => {
    throw new TypeError('AbortSignal.any is not a function');
  });
  const parent = new AbortController();
  const signal = timeoutSignal(parent.signal, 20);
  assert.equal(signal.aborted, false);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(signal.aborted, true);
  assert.equal((signal.reason as DOMException).name, 'TimeoutError');
});

test('timeoutSignal follows its parent', () => {
  const parent = new AbortController();
  const signal = timeoutSignal(parent.signal, 60_000);
  parent.abort();
  assert.equal(signal.aborted, true);
  assert.equal((signal.reason as DOMException).name, 'AbortError');
  const done = new AbortController();
  done.abort();
  assert.equal(timeoutSignal(done.signal, 60_000).aborted, true);
});

test('console polls avoid AbortSignal.any, and sidebar badges skip hidden tabs', () => {
  for (const file of [
    'src/shell/WorkspaceNavigation.tsx',
    'src/shell/SidebarRoomList.tsx',
    'src/agents/MyAgentsV2.tsx',
  ]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /AbortSignal\.any/, file);
  }
  const nav = readFileSync(
    new URL('../src/shell/WorkspaceNavigation.tsx', import.meta.url),
    'utf8',
  );
  assert.match(nav, /setInterval\(\(\) => \{\s*if \(pageVisible\(\)\) void load\(\);/);
  assert.match(nav, /addEventListener\('visibilitychange', shown\)/);
});

/** R5-11: the same Safari < 17.4 failure came back in later screens; no client file may use it. */
test('no client source calls AbortSignal.any (Safari before 17.4 lacks it)', () => {
  const root = new URL('../src/', import.meta.url);
  const offenders: string[] = [];
  const walk = (dir: URL) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
      if (entry.isDirectory()) walk(url);
      else if (/\.(tsx?|jsx?|mjs)$/.test(entry.name)) {
        const code = readFileSync(url, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        if (/AbortSignal\.any\s*\(/.test(code)) offenders.push(url.pathname.split('/src/')[1]!);
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});
