import assert from 'node:assert/strict';
import test from 'node:test';
import {
  changeProblem,
  NOT_THE_SAME,
  newPasswordProblem,
  restoreProblem,
} from '../src/agents/v4/walletKeyModel.js';

/*
 * The checks the wallet key's restore and change-password forms run before anything is read or
 * sent (src/agents/v4/WalletKeyScreens.tsx). Synthetic keys and passwords only.
 */

const KEY = '4c'.repeat(32);
const GOOD = 'Local-test-only-passphrase-2026';
const OTHER = 'Another-local-test-passphrase';

test('a new password follows the vault’s rules, then has to be typed the same twice', () => {
  assert.equal(newPasswordProblem('short', 'short'), 'Use at least 12 characters.');
  assert.equal(
    newPasswordProblem('aaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaa'),
    'Use more than one repeated character.',
  );
  assert.equal(newPasswordProblem(GOOD, `${GOOD} `), NOT_THE_SAME);
  assert.equal(newPasswordProblem(GOOD, GOOD), null);
});

test('restore: the backup key as written down, its format said plainly and never echoed', () => {
  assert.equal(restoreProblem('   ', GOOD, GOOD), 'Type or paste your backup key.');
  assert.equal(
    restoreProblem('7f3a 9c21', GOOD, GOOD),
    'A backup key has 64 characters; this has 8.',
  );
  assert.equal(
    restoreProblem(`${KEY.slice(0, 60)}zz12`, GOOD, GOOD),
    'A backup key has only the digits 0–9 and the letters a–f.',
  );
  assert.equal(
    restoreProblem('0'.repeat(64), GOOD, GOOD),
    'This isn’t a valid backup key. Check it against your copy.',
  );
  // Spaces, dashes, line breaks, upper case and a leading 0x are all forgiven.
  const written = `0x${KEY.toUpperCase()
    .match(/.{4}/g)!
    .map((group, index) => (index % 4 === 3 ? `${group}\n` : `${group}-`))
    .join('')}`;
  assert.equal(restoreProblem(written, GOOD, GOOD), null);
  // The key is checked first; the passwords after it.
  assert.equal(restoreProblem(KEY, GOOD, OTHER), NOT_THE_SAME);
  for (const text of ['7f3a', `${KEY.slice(0, 60)}zz12`])
    assert.ok(!restoreProblem(text, GOOD, GOOD)!.includes(text.slice(0, 4)));
});

test('change: the current password is needed, and the new one has to be new', () => {
  assert.equal(changeProblem('', GOOD, GOOD), 'Type your current password.');
  assert.equal(changeProblem(GOOD, GOOD, GOOD), 'The new password is the same as the current one.');
  assert.equal(changeProblem(GOOD, OTHER, GOOD), NOT_THE_SAME);
  assert.equal(changeProblem(GOOD, 'short', 'short'), 'Use at least 12 characters.');
  assert.equal(changeProblem(GOOD, OTHER, OTHER), null);
});
