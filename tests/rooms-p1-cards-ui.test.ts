import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  approvalRefOfLine,
  approvalState,
  decisionRefOfLine,
  isCardLine,
  type RoomCard,
} from '../src/rooms/cards.js';
import { expiryLabel, whenLabel } from '../src/rooms/RoomCards.js';

/**
 * Rooms P1 cards in the console (RoomCards.tsx, cards.ts): which server lines carry a card, the
 * approval state words and dates, and a stylesheet drawn from the app tokens only.
 */

test('the thread finds the card a server line is about, and nothing else', () => {
  // The exact line shapes server/rooms/cards.ts writes.
  assert.equal(approvalRefOfLine('Nova asked its owner for approval #a-3.'), '#a-3');
  assert.equal(approvalRefOfLine('Nova asked the host for approval #a-12.'), '#a-12');
  assert.equal(decisionRefOfLine('Bravo AI recorded decision #d-1.'), '#d-1');
  assert.equal(decisionRefOfLine('Harbor recorded decision #d-4; it supersedes #d-2.'), '#d-4');
  // Answers, withdrawals and member text are not "asked" or "recorded" lines.
  assert.equal(approvalRefOfLine('Harbor answered approval #a-3: approved (decision #d-5).'), null);
  assert.equal(decisionRefOfLine('Harbor answered approval #a-3: approved (decision #d-5).'), null);
  assert.equal(approvalRefOfLine('Please approve #a-3 for me'), null);
  assert.equal(decisionRefOfLine('I recorded decision #d-0.'), null);
  assert.ok(isCardLine('Nova withdrew approval #a-2.'));
  assert.ok(!isCardLine('Nova created task #4.'));
});

test('approval states and dates read in a few words', () => {
  const card = (status: RoomCard['status']) =>
    ({
      status,
      approval: {
        to: 'host',
        addressed_to: 'Harbor',
        expires_at: '',
        answered_at: null,
        answer_note: '',
        decision: null,
        can_answer: false,
      },
    }) as unknown as RoomCard;
  assert.equal(approvalState(card('pending')), 'Waiting for Harbor');
  assert.equal(approvalState(card('approved')), 'Approved by Harbor');
  assert.equal(approvalState(card('not_now')), 'Harbor: not now');
  assert.equal(approvalState(card('changes_requested')), 'Harbor suggested changes');
  assert.equal(approvalState(card('expired')), 'Expired without an answer');
  const now = new Date(2026, 9, 29, 9, 0);
  assert.equal(whenLabel(new Date(2026, 9, 29, 8, 0).toISOString(), now), 'today');
  assert.equal(whenLabel(new Date(2026, 9, 28, 23, 0).toISOString(), now), 'yesterday');
  assert.match(expiryLabel(new Date(2026, 9, 29, 12, 0).toISOString(), now), /^expires today /);
  assert.match(expiryLabel(new Date(2026, 9, 30, 12, 0).toISOString(), now), /^expires tomorrow /);
  assert.doesNotMatch(
    expiryLabel(new Date(2026, 10, 2, 12, 0).toISOString(), now),
    /today|tomorrow/,
  );
});

test('the cards stylesheet uses the app tokens, no literal colours', () => {
  const css = readFileSync(resolve('src/rooms/rooms-p1-cards.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(/i);
  for (const rule of css.split('}').filter((part) => part.includes('{')))
    assert.match(
      rule.trim(),
      /^(@media[^{]*\{\s*)?\.rm-app /,
      `scoped: ${rule.trim().slice(0, 60)}`,
    );
});

test('file sizes read in the units of the limits, and type tiles are short', async () => {
  const { sizeLabel, typeLabel } = await import('../src/rooms/files.js');
  assert.equal(sizeLabel(980), '980 B');
  assert.equal(sizeLabel(412 * 1024), '412 KB');
  assert.equal(sizeLabel(25 * 1024 * 1024), '25 MB');
  assert.equal(sizeLabel(250 * 1024 * 1024), '250 MB');
  assert.equal(sizeLabel(3.4 * 1024 * 1024), '3.4 MB');
  assert.equal(typeLabel('spec.pdf'), 'PDF');
  assert.equal(typeLabel('session.ts'), 'TS');
  assert.equal(typeLabel('archive.tar.gzip'), 'GZIP');
  assert.equal(typeLabel('README'), 'FILE');
});
