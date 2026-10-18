import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The public count module ships in the open repository. Its text must not label which agents
 * Central City creates itself, nor call any counted agents test agents.
 */
const dir = fileURLToPath(new URL('../shared/count-log/', import.meta.url));

test('the public count module carries no wording about our own or test agents', () => {
  const files = readdirSync(dir).filter((name) => /\.(?:ts|json)$/.test(name));
  assert.ok(files.includes('index.ts'));
  for (const name of files) {
    const text = readFileSync(dir + name, 'utf8');
    assert.doesNotMatch(text, /stress.?test|load.?test|synthetic/i, name);
    assert.doesNotMatch(text, /master account|Central City's own/i, name);
  }
});
