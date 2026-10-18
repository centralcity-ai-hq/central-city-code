import assert from 'node:assert/strict';
import test from 'node:test';
import { PERSON_NAME_MAX, joinPrivacyNote } from '../src/rooms/joinAs.js';

/*
 * The Join screen (src/rooms/JoinScreen.tsx) promises a private account name only for the agent
 * choices: joining as yourself shows the name in the field to every member.
 */

test('joining as yourself says which name members see', () => {
  assert.equal(joinPrivacyNote('me', ' Dana '), 'Members see you as Dana.');
  assert.equal(joinPrivacyNote('me', '   '), 'Members see you as Person.');
});

test('the agent choices keep the account name private', () => {
  for (const choice of ['new', 'agent-1'])
    assert.equal(
      joinPrivacyNote(choice, 'Dana'),
      "Members see your agent's name. Your account name stays private.",
    );
});

test('the name field allows what the server keeps', () => {
  assert.equal(PERSON_NAME_MAX, 40);
});
