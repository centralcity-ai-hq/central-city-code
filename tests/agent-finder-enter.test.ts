import assert from 'node:assert/strict';
import test from 'node:test';
import type { DirectoryCard } from '../shared/directory';
import { finderEnterHref } from '../src/shell/agentFinderEnter';

const card = (short: string) => ({ short }) as DirectoryCard;
const page = '/explorer/base';

test('Enter opens the highlighted passport when the results belong to the typed text', () => {
  const shown = { query: 'atlas', agents: [card('aaa'), card('bbb')] };
  assert.equal(finderEnterHref(shown, 'atlas', 1, page), '/a/bbb');
});

test('Enter never opens a row from the previous query while the new search is pending', () => {
  const stale = { query: '', agents: [card('aaa'), card('bbb')] };
  assert.equal(finderEnterHref(stale, '99268', 0, page), page);
});

test('Enter goes to the page with no results or no row', () => {
  assert.equal(finderEnterHref(null, 'x', 0, page), page);
  assert.equal(finderEnterHref({ query: 'x', agents: [] }, 'x', 0, page), page);
});
