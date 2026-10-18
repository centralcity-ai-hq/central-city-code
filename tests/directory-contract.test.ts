import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanNote,
  DIRECTORY_ERRORS,
  DIRECTORY_LIMITS,
  readDirectoryQuery,
} from '../shared/directory.js';

test('directory query: defaults, trimming, bounds and a safe cursor', () => {
  assert.deepEqual(readDirectoryQuery({}), {
    q: '',
    minRating: 0,
    sort: 'best_rated',
    before: null,
  });
  const read = readDirectoryQuery({
    q: '  market   research  ',
    min_rating: '4',
    sort: 'most_paid',
    before: 'abc_DEF-1',
  });
  assert.deepEqual(read, {
    q: 'market research',
    minRating: 4,
    sort: 'most_paid',
    before: 'abc_DEF-1',
  });
  assert.equal(readDirectoryQuery({ q: 'x'.repeat(500) }).q.length, DIRECTORY_LIMITS.queryMax);
  for (const bad of ['0', '6', '4.5', 'x', '-1']) {
    assert.equal(readDirectoryQuery({ min_rating: bad }).minRating, 0, bad);
  }
  assert.equal(readDirectoryQuery({ sort: 'cheapest' }).sort, 'best_rated');
  assert.equal(readDirectoryQuery({ before: "1' OR 1=1" }).before, null);
  assert.equal(readDirectoryQuery({ q: ['a', 'b'] }).q, '');
  // Control characters (a NUL would make Postgres refuse the search with a 500) become spaces.
  assert.equal(readDirectoryQuery({ q: 'har\u0000bor\u0007 scout' }).q, 'har bor scout');
});

test('invitation note: control characters removed, trimmed, bounded', () => {
  assert.equal(cleanNote('  Hi\u0000 there\u0007  '), 'Hi there');
  assert.equal(cleanNote('line one\nline two'), 'line one\nline two');
  assert.equal(cleanNote('n'.repeat(1000)).length, DIRECTORY_LIMITS.noteMax);
  assert.equal(cleanNote(42), '');
  // An emoji (two UTF-16 units) across the limit stays whole, never cut in half.
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  const atLimit = cleanNote('n'.repeat(DIRECTORY_LIMITS.noteMax - 1) + '\u{1F600}tail');
  assert.equal(Array.from(atLimit).length, DIRECTORY_LIMITS.noteMax);
  assert.ok(atLimit.endsWith('\u{1F600}'));
  assert.equal(lone.test(atLimit), false);
  const emojis = cleanNote('\u{1F600}'.repeat(DIRECTORY_LIMITS.noteMax + 5));
  assert.equal(Array.from(emojis).length, DIRECTORY_LIMITS.noteMax);
  assert.equal(lone.test(emojis), false);
});

test('every "can not invite" case shares one 404 code', () => {
  assert.equal(DIRECTORY_ERRORS.agent_not_found, 404);
  assert.equal(DIRECTORY_ERRORS.daily_limit, 429);
});
