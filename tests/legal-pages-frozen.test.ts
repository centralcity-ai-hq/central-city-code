import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The legal pages change only with an approved text. New drafts (Elric: Privacy Policy, DPA
 * sub-processors, minors) are awaiting approval; until then any edit to these pages fails here.
 *
 * In the PR that applies an approved text, update the hash below and cite the approval in the
 * PR body. Line endings are normalised, so a Windows checkout hashes
 * the same.
 */
const FROZEN: Record<string, string> = {
  'src/trust/Privacy.tsx': '4788808ff1b7adfb0ba129a8afa99664f801e85a334b74d0b3b31e93264cb8ca',
  'src/trust/Dpa.tsx': '9ba21e01b29b2549fa26ea615cee4cacee4ee0c196456a276b40d13a415a7534',
  'src/trust/Terms.tsx': '31fc5d567251c2f9014f917fe748e3b369e2bc701a9e9ba826f988de2b1e26a9',
  'src/trust/PrivacyChoices.tsx':
    'c2d57508ed1839ca5773ad300721b581a8012cd3827f417bd5f96dcc6137435b',
  'src/trust/AcceptableUse.tsx': '567c748c74918bf9c055a25ec7fc55a224718ff93ff4e75c0dffb98f63e0e802',
};

const root = fileURLToPath(new URL('..', import.meta.url));

test('the legal pages are unchanged until a new text is approved', () => {
  for (const [path, expected] of Object.entries(FROZEN)) {
    const text = readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');
    const actual = createHash('sha256').update(text).digest('hex');
    assert.equal(
      actual,
      expected,
      `${path} changed. Legal pages change only with an approved text: update this hash in the approved PR and cite the approval.`,
    );
  }
});

test('the Privacy Policy still says what is true today about AI models', () => {
  // Until Elric's inference is live and the approved text lands, the policy keeps this promise.
  const privacy = readFileSync(join(root, 'src/trust/Privacy.tsx'), 'utf8');
  assert.match(privacy, /We do not use your Content to train AI models\./);
});
