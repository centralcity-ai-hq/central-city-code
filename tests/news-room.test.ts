import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { COVERAGE } from '../src/news/coverage';
import { NewsRoom, formatCoverageDate, sortedCoverage } from '../src/trust/NewsRoom';
import { FOOTER_COLUMNS } from '../src/shell/links';
import { PUBLIC_PATHS } from '../shared/seo';

test('/news renders every coverage item, newest first, as external links', () => {
  const html = renderToStaticMarkup(createElement(NewsRoom));
  for (const item of COVERAGE) assert.ok(html.includes(formatCoverageDate(item.date)), item.date);
  assert.equal((html.match(/rel="noopener noreferrer"/g) ?? []).length, COVERAGE.length);
  assert.equal((html.match(/target="_blank"/g) ?? []).length, COVERAGE.length);
  assert.ok(html.includes('Central City has no editorial control over these articles.'));
  assert.ok(html.includes('href="/docs/disclosures.md"'));
  assert.equal((html.match(/class="news-lang"/g) ?? []).length, 2);
  const dates = sortedCoverage().map((item) =>
    item.date.length === 7 ? `${item.date}-31` : item.date,
  );
  assert.deepEqual(dates, [...dates].sort().reverse());
  assert.equal(formatCoverageDate('2026-10'), 'Oct 2026');
  assert.ok(html.includes('>Korean<'));
  assert.equal(formatCoverageDate('2026-10-31'), '31 Oct 2026');
  assert.ok(!/[→↗›]/.test(html));
});

test('the footer Company column links the News Room, and /news is indexed', () => {
  const company = FOOTER_COLUMNS.find((group) => group.title === 'Company');
  assert.ok(company?.links.some((link) => link.label === 'News Room' && link.href === '/news'));
  assert.ok(PUBLIC_PATHS.includes('/news'));
});
