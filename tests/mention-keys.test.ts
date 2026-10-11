import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findMentions,
  mentionKeys,
  nameKeyOf,
  slugOf,
  type MentionCandidate,
} from '../server/wake/mentions.js';

/**
 * Mention candidates by key (server/wake/hooks.ts roomPosted, migration 62): findMentions over
 * only the candidates whose name key, slug or id is among mentionKeys(text) must give exactly the
 * result findMentions gives over every candidate: same ids, same offsets, same ambiguous labels.
 * Randomized over awkward names (case, NFKC forms, accents, dotted I, emoji, punctuation,
 * shared prefixes, duplicates, Elric) and texts (quoted names, slugs, ids in any case, emails,
 * prefixes of names, many @s).
 */

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  'Ann',
  'ann',
  'ANN',
  'Ann Lee',
  'Lee',
  'Build',
  'Build Desk',
  'build-desk',
  'City',
  'Desk',
  'Elric',
  'elric',
  'Elric Bot',
  'Ｅｌｒｉｃ',
  'Zoë',
  'Zoë',
  'İstanbul',
  'straße',
  'STRASSE',
  'ﬁx',
  'fix',
  '🤖',
  'Bot 🤖',
  'a.b',
  'a_b',
  'a-b',
  'x',
  'Ω',
  'ω',
  '  padded  ',
  'O’Neil',
  'São Paulo',
  'Dr. Who',
  '"quoted"',
  '-',
  '...',
];

function uuid(random: () => number, upper: boolean): string {
  const hex = () => Math.floor(random() * 16).toString(16);
  const part = (n: number) => Array.from({ length: n }, hex).join('');
  const id = `${part(8)}-${part(4)}-4${part(3)}-a${part(3)}-${part(12)}`;
  return upper ? id.toUpperCase() : id;
}

function candidatesFor(random: () => number): MentionCandidate[] {
  const count = 1 + Math.floor(random() * 25);
  const pick = () => PIECES[Math.floor(random() * PIECES.length)]!;
  return Array.from({ length: count }, () => {
    const parts = 1 + Math.floor(random() * 3);
    const name = Array.from({ length: parts }, pick).join(random() < 0.7 ? ' ' : '-');
    return { id: uuid(random, random() < 0.2), name };
  });
}

function textFor(random: () => number, pool: MentionCandidate[]): string {
  const bits: string[] = [];
  const words = 1 + Math.floor(random() * 8);
  for (let i = 0; i < words; i++) {
    const roll = random();
    const member = pool[Math.floor(random() * pool.length)]!;
    const piece = PIECES[Math.floor(random() * PIECES.length)]!;
    if (roll < 0.2) bits.push(`@${member.name}`);
    else if (roll < 0.3) bits.push(`@"${member.name}"`);
    else if (roll < 0.4) bits.push(`@${slugOf(member.name)}`);
    else if (roll < 0.47) bits.push(`@${random() < 0.5 ? member.id.toUpperCase() : member.id}`);
    else if (roll < 0.52) bits.push(`@${member.id}x`);
    else if (roll < 0.6) bits.push(`@${piece}`);
    else if (roll < 0.65) bits.push(`someone@${piece}`);
    else if (roll < 0.7) bits.push(`@${member.name.slice(0, 1 + Math.floor(random() * 4))}`);
    else if (roll < 0.74) bits.push(`@"${piece}`);
    else if (roll < 0.78) bits.push('@');
    else bits.push(piece);
    bits.push(['', ' ', ', ', '.', '!', '\n', '-', ':'][Math.floor(random() * 8)]!);
  }
  return bits.join('');
}

function byKeys(text: string, pool: MentionCandidate[], keep: string[]): MentionCandidate[] {
  const keys = mentionKeys(text);
  const names = new Set(keys.names);
  const slugs = new Set(keys.slugs);
  const ids = new Set(keys.ids);
  return pool.filter(
    (item) =>
      keep.includes(item.id) ||
      names.has(nameKeyOf(item.name)) ||
      slugs.has(slugOf(item.name)) ||
      ids.has(item.id.toLowerCase()),
  );
}

const plain = (match: ReturnType<typeof findMentions>) => ({
  ids: match.ids,
  offsets: [...match.offsets.entries()],
  ambiguous: match.ambiguous,
});

test('findMentions over the candidates matched by key equals findMentions over every member', () => {
  const random = rng(20261003);
  let mentioned = 0;
  let ambiguous = 0;
  for (let round = 0; round < 20_000; round++) {
    const pool = candidatesFor(random);
    if (random() < 0.3) pool.push({ id: uuid(random, false), name: pool[0]!.name });
    const text = textFor(random, pool);
    const exclude = random() < 0.5 ? [pool[0]!.id] : [];
    const full = findMentions(text, pool, { exclude });
    const subset = findMentions(text, byKeys(text, pool, exclude), { exclude });
    assert.deepEqual(plain(subset), plain(full), JSON.stringify({ text, pool, exclude }));
    mentioned += full.ids.length;
    ambiguous += full.ambiguous.length;
  }
  // The generator exercises both outcomes heavily.
  assert.ok(mentioned > 5_000, `mentions ${mentioned}`);
  assert.ok(ambiguous > 1_000, `ambiguous ${ambiguous}`);
});

test('mention keys: fixed cases', () => {
  const pool: MentionCandidate[] = [
    { id: '11111111-1111-4111-a111-111111111111', name: 'Ann' },
    { id: '22222222-2222-4222-a222-222222222222', name: 'Ann Lee' },
    { id: '33333333-3333-4333-a333-333333333333', name: 'Elric' },
    { id: '44444444-4444-4444-a444-444444444444', name: 'elric' },
    { id: '55555555-5555-4555-a555-555555555555', name: 'Build Desk' },
    { id: '66666666-6666-4666-a666-666666666666', name: 'Ｚｏë' },
  ];
  const cases = [
    'Hi @Ann Lee and @ann',
    '@Elric please',
    '@"Build Desk" and @build-desk',
    '@zoë @ZOË',
    'mail ann@ann.example',
    '@55555555-5555-4555-A555-555555555555 ok',
    'no mention at all',
    '@"unterminated',
  ];
  for (const text of cases) {
    assert.deepEqual(
      plain(findMentions(text, byKeys(text, pool, []))),
      plain(findMentions(text, pool)),
      text,
    );
  }
  assert.deepEqual(mentionKeys('no mention'), { names: [], slugs: [], ids: [] });
  assert.deepEqual(findMentions('@Elric', pool).ambiguous, ['elric']);
});
