import test from 'node:test';
import assert from 'node:assert/strict';
import { elricEntry } from '../src/elric/entry.js';

test('Elric off on the server: no console entry', () => {
  assert.equal(elricEntry(null), 'hidden');
});

test('under 18: no console entry', () => {
  assert.equal(elricEntry({ eligible: false, eligibility_reason: 'age_under_18' }), 'hidden');
  assert.equal(
    elricEntry({ agent_id: 'a', eligible: false, eligibility_reason: 'age_under_18' }),
    'hidden',
  );
});

test('no Google sign-in or no date of birth yet: the entry leads to the /elric setup step', () => {
  for (const reason of ['unverified', 'age_unknown', 'unknown', 'not_person'])
    assert.equal(
      elricEntry({ agent_id: null, eligible: false, eligibility_reason: reason }),
      'setup',
    );
  // Older servers answer without a reason.
  assert.equal(elricEntry({ agent_id: null, eligible: false }), 'setup');
});

test('a verified adult, or an account that has Elric, opens the activity view', () => {
  assert.equal(
    elricEntry({ agent_id: null, eligible: true, eligibility_reason: null }),
    'activity',
  );
  assert.equal(elricEntry({ agent_id: 'elric-agent', eligible: true }), 'activity');
});
