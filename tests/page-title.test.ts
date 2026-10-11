import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TITLE, PAGE_TITLES } from '../shared/page-titles.js';
import { applyPageTitle } from '../src/shell/usePageTitle.js';

/** The tab title a page sets while shown, and the one it puts back when it leaves. */

test('page title: leaving a page inside another view puts back that view title', () => {
  const doc = { title: 'Workspace · Central City' };
  const leave = applyPageTitle(doc, PAGE_TITLES['/elric']);
  assert.equal(doc.title, PAGE_TITLES['/elric']);
  leave();
  assert.equal(doc.title, 'Workspace · Central City');
});

test('page title: leaving a page opened directly shows the default title, not its own', () => {
  // The server already sent the page's title in its HTML, so that is the title found on mount.
  const doc = { title: PAGE_TITLES['/connect'] };
  const leave = applyPageTitle(doc, PAGE_TITLES['/connect']);
  assert.equal(doc.title, PAGE_TITLES['/connect']);
  leave();
  assert.equal(doc.title, DEFAULT_TITLE);
});

test('page title: from the home page and back, the home title returns', () => {
  const doc = { title: DEFAULT_TITLE };
  const leave = applyPageTitle(doc, PAGE_TITLES['/workflows']);
  assert.equal(doc.title, PAGE_TITLES['/workflows']);
  leave();
  assert.equal(doc.title, DEFAULT_TITLE);
});
