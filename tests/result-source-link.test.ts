import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SourceLink } from '../src/results/SourceLink.js';

/** CCA-611: result page sources show the destination host next to an untrusted title. */
const html = (url: string, title?: string) =>
  renderToStaticMarkup(createElement(SourceLink, { url, title }));

test('CCA-611: a source title that does not name its destination is followed by the host', () => {
  const out = html('https://evil.example/login', 'Official Central City docs');
  assert.match(out, /Official Central City docs<\/a>/);
  assert.match(out, /\(evil\.example\)/);
  assert.match(out, /title="https:\/\/evil\.example\/login"/);
  // A look-alike host in the title is not the destination either.
  assert.match(html('https://evil.example/', 'centralcity.ai.evil.example'), /\(evil\.example\)/);
});

test('CCA-611: a title that names the host, or the bare url, adds nothing; non-web sources stay text', () => {
  assert.doesNotMatch(html('https://example.com/a', 'example.com/a'), /\(example\.com\)/);
  assert.doesNotMatch(html('https://example.com/a'), /\(example\.com\)/);
  assert.equal(html('javascript:alert(1)', 'Click'), 'Click');
});

test('CCA-611: the result page renders its sources through SourceLink', async () => {
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../src/results/ResultPage.tsx', import.meta.url), 'utf8');
  assert.match(page, /<SourceLink url=\{source\.url\} title=\{source\.title\} \/>/);
});
