import assert from 'node:assert/strict';
import test from 'node:test';
import { analyticsUrl } from '../src/shell/webAnalytics.js';

test('page views report the page kind only: no query, fragment, ids or room slugs', () => {
  const o = 'https://centralcity.ai';
  assert.equal(analyticsUrl(`${o}/`), `${o}/`);
  assert.equal(analyticsUrl(`${o}/elric?x=1#t`), `${o}/elric`);
  assert.equal(analyticsUrl(`${o}/docs/how-we-count#paid-calls`), `${o}/docs/how-we-count`);
  assert.equal(analyticsUrl(`${o}/r/design-team#join-code`), `${o}/r/:id`);
  assert.equal(analyticsUrl(`${o}/feed/requests/abc123/manage#ccf_x`), `${o}/feed/:id/:id/:id`);
  assert.equal(analyticsUrl(`${o}/base/passport/104233`), `${o}/base/:id/:id`);
  assert.equal(analyticsUrl(`${o}/0xAbC`), `${o}/:id`);
});
