import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PUBLIC_DOCS } from '../scripts/public-docs/build.js';
import {
  ELRIC_ABOUT_PATH,
  ELRIC_AI_NOTICE,
  ELRIC_DETERMINISTIC_MODEL,
  ELRIC_MEMBER_BADGE,
  ELRIC_VERSION,
  elricProfileTitle,
  elricPublicModel,
  elricReplyTag,
  elricTooltip,
  elricReplyLabel,
} from '../shared/elric-copy.js';

const root = fileURLToPath(new URL('..', import.meta.url));

test('a model reply is the name plus the AI tag; a plain-code reply says automated, never AI', () => {
  assert.equal(elricReplyLabel('any-model'), 'Elric · AI');
  assert.equal(elricReplyTag('any-model'), 'AI');
  assert.equal(elricPublicModel('any-model'), 'elric-1.0');
  for (const model of [ELRIC_DETERMINISTIC_MODEL, '', null, undefined]) {
    assert.equal(elricReplyLabel(model), 'Elric · automated', String(model));
    assert.equal(elricReplyTag(model), null);
    assert.doesNotMatch(elricReplyLabel(model), /\bAI\b/, 'a Tier 0 reply never says AI');
    assert.equal(elricPublicModel(model), ELRIC_DETERMINISTIC_MODEL);
  }
  // The version only on hover and in the profile, from one constant.
  assert.equal(ELRIC_VERSION, '1.0');
  assert.equal(elricTooltip(), 'Elric v1.0');
  assert.equal(elricProfileTitle(), 'Elric · Version 1.0');
  assert.doesNotMatch(elricReplyLabel('m'), /v1\.0|Version/);
});

test('no model name in public copy or the client: src/, public/ and the public docs', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true }))
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (/\.(tsx?|css|html|md|txt|json)$/.test(entry.name)) files.push(join(dir, entry.name));
  };
  for (const dir of ['src', 'public']) walk(dir);
  for (const doc of PUBLIC_DOCS) files.push(join('docs', doc.source));
  for (const file of files)
    assert.doesNotMatch(readFileSync(join(root, file), 'utf8'), /gemma/i, file);
});

test('the disclosure says Elric is an AI and can be wrong, in one short line', () => {
  assert.match(ELRIC_AI_NOTICE, /\bAI assistant\b/);
  assert.ok(ELRIC_AI_NOTICE.length <= 100, 'one line');
  assert.equal(ELRIC_MEMBER_BADGE, 'AI assistant');
  // TERMINOLOGY.md: no claims without the mechanism, no status words.
  for (const text of [ELRIC_AI_NOTICE, ELRIC_MEMBER_BADGE, elricReplyLabel('m')])
    assert.doesNotMatch(
      text,
      /\b(?:safe|secure|private|accurate|guaranteed|beta|preview)\b/i,
      text,
    );
});

test('the About Elric page is published at /docs/elric.md and names no model or provider', () => {
  const entry = PUBLIC_DOCS.find((doc) => doc.source === 'ELRIC_ABOUT.md');
  assert.ok(entry, 'in the public docs');
  assert.equal(`/docs/${entry.slug}.md`, ELRIC_ABOUT_PATH);
  const about = readFileSync(join(root, 'docs/ELRIC_ABOUT.md'), 'utf8');
  assert.match(about, /\*\*Elric is an AI\.\*\*/);
  assert.match(about, /18 or over/);
  assert.match(about, /Only its owner can ask it/);
  assert.match(about, /Nothing is created until you approve it/);
  assert.doesNotMatch(about, /gemma|qwen|llama|mistral|haiku|claude|anthropic|gemini|\bgpt/i);
  assert.doesNotMatch(about, /\b(?:agent|bot|beta|preview)\b/i);
});
