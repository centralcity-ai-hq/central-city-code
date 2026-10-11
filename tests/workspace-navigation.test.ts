import assert from 'node:assert/strict';
import test from 'node:test';
import { workspaceView } from '../src/shell/workspaceDestinations';
import { workspaceLanding } from '../src/shell/workspaceLanding';

test('console history is validated and scoped to the selected workspace', () => {
  assert.equal(
    workspaceView({ workspaceId: 'owner-a', workspaceView: 'messages' }, 'owner-a'),
    'messages',
  );
  assert.equal(
    workspaceView({ workspaceId: 'owner-a', workspaceView: 'messages' }, 'owner-b'),
    null,
  );
  for (const state of [null, 'messages', {}, { workspaceId: 'owner-a', workspaceView: '/unknown' }])
    assert.equal(workspaceView(state, 'owner-a'), null);
});
test('explicit console history survives preview default landing without inventing routes', () => {
  assert.equal(
    workspaceLanding({
      enabled: true,
      consoleEntry: true,
      signedIn: true,
      onboarding: false,
      pathname: '/',
      search: '',
      hash: '',
      pendingJoin: null,
    }),
    null,
  );
});
