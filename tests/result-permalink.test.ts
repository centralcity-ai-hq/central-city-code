import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { resultApiPath, resultId, sourceHref } from '../src/results/resultPath';

const id = '3f2b8c1e-9a4d-4e5f-8a6b-1c2d3e4f5a6b';

test('the results API url (<origin>/results/<id>) is a page the app renders', () => {
  const url = new URL(`https://centralcity.ai/results/${id}`);
  assert.equal(resultId(url.pathname), id);
  assert.equal(resultId(`/results/${id}/`), id);
  assert.equal(resultId('/results'), null);
  assert.equal(resultId(`/results/${id}/edit`), null);
  // Root.tsx counts it as known (no 404) and renders the result page there.
  const root = readFileSync(new URL('../src/Root.tsx', import.meta.url), 'utf8');
  assert.match(root, /resultId\(path\) !== null/);
  assert.match(root, /<ResultPage key=\{result\} id=\{result\}/);
  // The address the server hands out has this shape.
  const service = readFileSync(new URL('../server/results/service.ts', import.meta.url), 'utf8');
  assert.match(service, /url: `\$\{origin\}\/results\/\$\{row\.id\}`/);
});

test('only a UUID asks the API; anything else is not found without a request', () => {
  assert.equal(resultApiPath(id.toUpperCase()), `/api/results/${id}`);
  assert.equal(resultApiPath('not-a-result'), null);
});

test('sources link only to web addresses', () => {
  assert.equal(sourceHref('https://example.com/a'), 'https://example.com/a');
  assert.equal(sourceHref('javascript:alert(1)'), null);
  assert.equal(sourceHref('not a url'), null);
});
