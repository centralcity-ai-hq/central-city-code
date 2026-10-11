import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  formatUnread,
  matchesFilter,
  messageTime,
  partyName,
  partyRole,
  privacyNote,
  relativeTime,
  roomOrigin,
  splitCode,
  sumUnread,
  unreadLabel,
} from '../src/messagesV2';

/*
 * Workspace preview Messages: the labels built from ConversationSummary.unread / unread_capped
 * and DirectParty.owner_label / is_self, and the styles staying the Rooms v2 tokens with no orange.
 */

test('unread badges are empty at zero and 99+ when the server capped the count', () => {
  assert.equal(formatUnread(0), '');
  assert.equal(formatUnread(-3), '');
  assert.equal(formatUnread(1), '1');
  assert.equal(formatUnread(99), '99');
  assert.equal(formatUnread(99, true), '99+');
  assert.equal(formatUnread(100), '99+');
  assert.equal(unreadLabel(3), '3 unread');
  assert.equal(unreadLabel(99, true), 'More than 99 unread');
});

test('a chat that groups several summaries sums unread and keeps the cap', () => {
  assert.deepEqual(sumUnread([]), { count: 0, capped: false });
  assert.deepEqual(
    sumUnread([
      { unread: 2, unread_capped: false },
      { unread: 5, unread_capped: false },
    ]),
    { count: 7, capped: false },
  );
  assert.deepEqual(
    sumUnread([
      { unread: 60, unread_capped: false },
      { unread: 60, unread_capped: false },
    ]),
    { count: 99, capped: true },
  );
  assert.deepEqual(sumUnread([{ unread: 99, unread_capped: true }]), { count: 99, capped: true });
});

test('room origin chips read "From #room" without doubling the hash', () => {
  assert.equal(roomOrigin('research'), 'From #research');
  assert.equal(roomOrigin('#research'), 'From #research');
  assert.equal(roomOrigin(' Review & planning '), 'From #Review & planning');
});

test('parties: the viewer is You, an AI shows its owner label, a person has no role', () => {
  const self = {
    name: 'Sam',
    kind: 'person' as const,
    owner_label: 'Account 1a2b3c4d',
    is_self: true,
  };
  const ai = { name: 'Scout', kind: 'agent' as const, owner_label: 'Acme', is_self: false };
  const person = {
    name: 'Jamie',
    kind: 'person' as const,
    owner_label: 'Account 9f8e7d6c',
    is_self: false,
  };
  assert.equal(partyName(self), 'You');
  assert.equal(partyName(ai), 'Scout');
  assert.equal(partyRole(self), null);
  assert.equal(partyRole(ai), 'AI · Acme');
  assert.equal(partyRole({ ...ai, owner_label: null }), 'AI agent');
  assert.equal(partyRole(person), null);
  assert.equal(partyRole({ ...ai, is_self: true }), null);
  // Only a literal true is the viewer's own member.
  const loose = { ...ai, is_self: 'yes' as unknown as boolean };
  assert.equal(partyName(loose), 'Scout');
  assert.equal(partyRole(loose), 'AI · Acme');
});

test('the privacy note names everyone who can read a private thread', () => {
  const me = { name: 'Alex', kind: 'person' as const, owner_label: null };
  const jamie = { name: 'Jamie', kind: 'person' as const, owner_label: 'Account 9f8e7d6c' };
  const myAgent = { name: 'Build worker', kind: 'agent' as const, owner_label: 'My lab' };
  const scout = { name: 'Scout', kind: 'agent' as const, owner_label: 'Acme' };
  assert.equal(privacyNote(me, jamie), 'Private: you and Jamie.');
  assert.equal(
    privacyNote(me, scout),
    "Private: you and Scout. Scout's owner (Acme) can read it too.",
  );
  assert.equal(
    privacyNote(myAgent, jamie),
    'Private between your agent Build worker and Jamie. You can read it as its owner.',
  );
  assert.equal(
    privacyNote(myAgent, { ...scout, owner_label: null }),
    "Private between your agent Build worker and Scout. You can read it as its owner, and so can Scout's owner.",
  );
  for (const note of [privacyNote(me, jamie), privacyNote(myAgent, scout)])
    assert.doesNotMatch(note, /only/i);
  // One of your own AIs (a 1:1 thread from a room): nobody else reads it.
  const helper = { ...myAgent, name: 'Helper', own: true };
  assert.equal(privacyNote(me, helper), 'Private: you and your AI Helper. Only you can read it.');
  assert.equal(
    privacyNote(myAgent, helper),
    'Private between your agents Build worker and Helper. Only you can read it.',
  );
  assert.equal(partyRole({ ...helper, is_self: false }), 'Your AI');
});

test('inbox tabs: Unread keeps chats with unread (or capped) messages, Agents chats with an AI', () => {
  const person = { unread: 0, ai: false };
  const ai = { unread: 2, ai: true };
  const capped = { unread: 0, capped: true, ai: false };
  for (const chat of [person, ai, capped]) assert.equal(matchesFilter('all', chat), true);
  assert.equal(matchesFilter('unread', person), false);
  assert.equal(matchesFilter('unread', ai), true);
  assert.equal(matchesFilter('unread', capped), true);
  assert.equal(matchesFilter('agents', person), false);
  assert.equal(matchesFilter('agents', ai), true);
});

test('inbox times are relative: now, minutes, hours, days, then the date', () => {
  // Noon local time, so the dates below are the same in every time zone.
  const now = new Date(2026, 9, 4, 12, 0).getTime();
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  assert.equal(relativeTime(ago(0), now), 'now');
  assert.equal(relativeTime(new Date(now + 90_000).toISOString(), now), 'now');
  assert.equal(relativeTime(ago(2), now), '2m');
  assert.equal(relativeTime(ago(59), now), '59m');
  assert.equal(relativeTime(ago(60), now), '1h');
  assert.equal(relativeTime(ago(23 * 60 + 59), now), '23h');
  assert.equal(relativeTime(ago(4 * 24 * 60), now), '4d');
  assert.equal(relativeTime(ago(30 * 24 * 60), now, 'en-GB'), '4 Sept');
  assert.equal(relativeTime('not a date', now), '');
});

// Past 24 hours the label follows the viewer's local calendar, so it is the same in every zone.
// Dates are built in local time inside each zone (process.env.TZ applies at once in Node).
for (const zone of ['UTC', 'America/Los_Angeles', 'Pacific/Auckland']) {
  test(`inbox times past 24 hours follow local calendar days in ${zone}`, () => {
    const saved = process.env.TZ;
    process.env.TZ = zone;
    try {
      const local = (day: number, hour: number) => new Date(2026, 9, day, hour, 0).getTime();
      const iso = (time: number) => new Date(time).toISOString();
      const now = local(4, 1); // 01:00 on 4 Oct, local time
      // 23h back is still hours, even across midnight.
      assert.equal(relativeTime(iso(local(3, 2)), now), '23h');
      // 30h back from 01:00 is 19:00 on 2 Oct: two calendar days, never "Yesterday" or "1d".
      assert.equal(relativeTime(iso(local(2, 19)), now), '2d');
      // From 12:00, 30h back is 06:00 yesterday.
      assert.equal(relativeTime(iso(local(3, 6)), local(4, 12)), 'Yesterday');
      // Just past 24h and still the day before: Yesterday.
      assert.equal(relativeTime(iso(local(3, 0)), local(4, 23)), 'Yesterday');
      assert.equal(
        relativeTime(iso(local(1, 12) - 6 * 86_400_000), local(4, 12), 'en-GB'),
        '25 Sept',
      );
      assert.equal(relativeTime(iso(local(1, 12)), local(4, 12)), '3d');
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });
}

test('message times show the clock today and the date on other days', () => {
  const now = new Date(2026, 9, 4, 18, 30).getTime();
  assert.equal(messageTime(new Date(2026, 9, 4, 8, 5).toISOString(), now, 'en-GB'), '08:05');
  assert.match(
    messageTime(new Date(2026, 9, 2, 8, 5).toISOString(), now, 'en-GB'),
    /^2 Oct.*08:05$/,
  );
  assert.equal(messageTime('nope', now), '');
});

test('fenced code blocks split out of plain text; anything else stays text', () => {
  const fence = '```';
  assert.deepEqual(splitCode('Hello'), [{ type: 'text', text: 'Hello' }]);
  assert.deepEqual(splitCode(''), [{ type: 'text', text: '' }]);
  const lines = (...parts: string[]) => parts.join('\n');
  assert.deepEqual(
    splitCode(lines('Run this:', `${fence}sh`, 'pnpm build', fence, 'Then merge.')),
    [
      { type: 'text', text: 'Run this:' },
      { type: 'code', code: 'pnpm build' },
      { type: 'text', text: 'Then merge.' },
    ],
  );
  assert.deepEqual(splitCode(lines(fence, 'a', 'b', fence)), [
    { type: 'code', code: lines('a', 'b') },
  ]);
  // An unclosed fence is not a code block; HTML is never interpreted.
  const open = lines(fence, '<img src=x>');
  assert.deepEqual(splitCode(open), [{ type: 'text', text: open }]);
});

function block(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `no ${selector} block`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  const tokens = new Map<string, string>();
  for (const match of body.matchAll(/(--[\w-]+):\s*([^;]+);/g))
    tokens.set(match[1]!, match[2]!.trim());
  return tokens;
}

const messagesCss = readFileSync(resolve(process.cwd(), 'src/messages-v2.css'), 'utf8');
const roomsCss = readFileSync(resolve(process.cwd(), 'src/rooms/rooms-v2.css'), 'utf8');

for (const [theme, messagesSelector, roomsSelector] of [
  ['light', '.messages-v2', ".rm-app[data-rooms='v2']"],
  [
    'dark',
    ":root[data-theme='dark'] .messages-v2",
    ":root[data-theme='dark'] .rm-app[data-rooms='v2']",
  ],
] as const) {
  test(`messages ${theme} tokens are the Rooms v2 values`, () => {
    const messages = block(messagesCss, messagesSelector);
    const rooms = block(roomsCss, roomsSelector);
    let shared = 0;
    for (const [name, value] of messages) {
      const theirs = rooms.get(name);
      if (!theirs || value.startsWith('var(') || theirs.startsWith('var(')) continue;
      shared += 1;
      assert.equal(value, theirs, `${theme} ${name} differs from rooms-v2.css`);
    }
    assert.ok(shared >= 20, `only ${shared} tokens compared`);
  });
}

test('messages styles stay scoped and use no orange or amber', () => {
  for (const match of messagesCss.matchAll(/^([^@\s/*}][^{]*)\{/gm)) {
    const selectors = match[1]!.split(/,(?![^(]*\))/).map((item) => item.trim());
    for (const selector of selectors)
      assert.match(selector, /\.messages-v2/, `unscoped selector in messages-v2.css: ${selector}`);
  }
  const rules = messagesCss.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(rules, /#f97316|#fb923c|#ea580c|#f59e0b|#fbbf24|#d97706|orange|amber/i);
});
