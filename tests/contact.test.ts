import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

/*
 * The official mailboxes (live 28 Sep 2026): hello@, support@, security@, privacy@ and contact@.
 * There is no abuse@ or postmaster@, and no personal address belongs in the product.
 */
const root = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

test('security.txt (RFC 9116) names the security mailbox and has not expired', () => {
  const text = read('public/.well-known/security.txt');
  const lines = text.trim().split('\n');
  const values = (field: string) =>
    lines
      .filter((line) => line.startsWith(`${field}: `))
      .map((line) => line.slice(field.length + 2));
  assert.deepEqual(values('Contact'), [
    'mailto:security@centralcity.ai',
    'https://github.com/centralcity-ai-hq/protocol/security/advisories/new',
  ]);
  assert.deepEqual(values('Canonical'), ['https://centralcity.ai/.well-known/security.txt']);
  // The public protocol repository hosts the security policy.
  assert.deepEqual(values('Policy'), [
    'https://github.com/centralcity-ai-hq/protocol/blob/main/SECURITY.md',
  ]);
  const fields = new Map([['Expires', values('Expires')[0]]]);
  const expires = Date.parse(fields.get('Expires') ?? '');
  assert.ok(expires > Date.now(), 'Expires is in the future');
  // RFC 9116 §2.5.5: less than a year ahead is recommended; renew it before it lapses.
  assert.ok(expires - Date.now() < 366 * 24 * 3600 * 1000, 'Expires is at most a year ahead');
});

test('the site links only the public security policy', () => {
  for (const file of ['src/docs/DocsPages.tsx', 'public/.well-known/security.txt'])
    assert.doesNotMatch(read(file), /central-city\/blob\/main\/SECURITY\.md/, file);
});

test('SECURITY.md and llms.txt name the security and privacy mailboxes', () => {
  assert.match(read('SECURITY.md'), /security@centralcity\.ai/);
  assert.match(read('SECURITY.md'), /privacy@centralcity\.ai/);
  const llms = read('public/llms.txt');
  for (const box of ['support', 'security', 'privacy', 'hello'])
    assert.match(llms, new RegExp(`${box}@centralcity\\.ai`), box);
});

test('only official mailboxes appear in the site and its public files', () => {
  const allowed = new Set(['hello', 'support', 'security', 'privacy', 'contact']);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(root, dir))) {
      const path = join(dir, name);
      if (statSync(join(root, path)).isDirectory()) walk(path);
      else if (/\.(tsx?|css|html|txt|md|json)$/.test(name)) files.push(path);
    }
  };
  walk('src');
  walk('public');
  files.push('SECURITY.md', 'index.html');
  for (const file of files)
    for (const [, local, domain] of read(file).matchAll(
      /\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[a-z]{2,})\b/g,
    )) {
      if (domain === 'centralcity.ai')
        assert.ok(allowed.has(local!), `${file}: ${local}@${domain} is not an official mailbox`);
      else
        assert.doesNotMatch(domain!, /gmail|outlook|hotmail|icloud|yahoo/i, `${file}: ${domain}`);
    }
});
