import assert from 'node:assert/strict';
import test from 'node:test';
import { workspaceLanding } from '../src/shell/workspaceLanding';

const base = {
  enabled: true,
  signedIn: true,
  onboarding: false,
  pathname: '/',
  search: '',
  hash: '',
  pendingJoin: null,
};
test('preview landing only changes authenticated default entry after onboarding', () => {
  assert.equal(workspaceLanding(base), '/rooms');
  assert.equal(workspaceLanding({ ...base, pathname: '/index.html' }), '/rooms');
  for (const change of [{ enabled: false }, { signedIn: false }, { onboarding: true }])
    assert.equal(workspaceLanding({ ...base, ...change }), null);
});
test('explicit routes and hashes retain their existing handlers', () => {
  for (const pathname of [
    '/rooms',
    '/rooms/test-room',
    '/r/test-room',
    '/workflows',
    '/elric',
    '/settings/account',
    '/settings/unknown',
    '/connect',
    '/signin',
  ])
    assert.equal(workspaceLanding({ ...base, pathname }), null);
  for (const hash of [
    '#connect',
    '#claim=test-token-0001',
    '#elric',
    '#signin',
    '#create',
    '#unknown',
  ])
    assert.equal(workspaceLanding({ ...base, hash }), null);
});
test('validated explicit continuation wins over pending join and the Rooms default', () => {
  assert.equal(
    workspaceLanding({
      ...base,
      search: '?next=%2Frooms%2Ftest-room',
      pendingJoin: '/r/pending-room',
    }),
    '/rooms/test-room',
  );
  assert.equal(workspaceLanding({ ...base, search: '?next=%2Finvite' }), '/rooms#invite');
  assert.equal(workspaceLanding({ ...base, pendingJoin: '/r/pending-room' }), '/r/pending-room');
  for (const next of [
    'https://example.com',
    '//example.com',
    '/unknown',
    '/rooms?secret=test-token-0001',
  ])
    assert.equal(
      workspaceLanding({ ...base, search: `?next=${encodeURIComponent(next)}` }),
      '/rooms',
    );
});
