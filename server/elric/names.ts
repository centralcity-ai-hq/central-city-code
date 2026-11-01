import { elricEnabled } from './config.js';

/**
 * The display name "Elric" is reserved for first-party Elric agents (docs/ELRIC.md): no other
 * agent and no person may take it, so nobody can collide with or impersonate an Elric in a room
 * ("@Elric" matching two members mentions neither, and a person named Elric would block the real
 * one with name_taken).
 *
 * The comparison is a skeleton: NFKC, lower case, invisible characters removed, Unicode
 * look-alikes (Cyrillic, Greek, small capitals, and the Lisu and Cherokee letters that read as
 * Latin capitals; fullwidth and math letters via NFKC) folded to Latin, accents removed, digits
 * folded to the letters they resemble (0→o, 3→e, 4→a, 5→s, 7→t), i/l/1/| treated as one class,
 * and everything that is not a letter or digit removed. Look-alikes outside these tables are
 * removed, not folded: the table covers the scripts whose letters are drawn like Latin ones
 * (the Latin-looking entries of Unicode's confusables data, UTS #39), not every confusable.
 */
const LOOK_ALIKES: Record<string, string> = {
  // Cyrillic
  а: 'a',
  в: 'b',
  е: 'e',
  ё: 'e',
  є: 'e',
  э: 'e',
  с: 'c',
  г: 'r',
  і: 'i',
  ї: 'i',
  ј: 'j',
  ӏ: 'l',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  т: 't',
  у: 'y',
  х: 'x',
  ѕ: 's',
  // Greek
  α: 'a',
  β: 'b',
  ε: 'e',
  η: 'n',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
  ϲ: 'c',
  // Latin look-alikes NFKC keeps
  ı: 'i',
  ɩ: 'i',
  ℓ: 'l',
  ʀ: 'r',
  ᴦ: 'r',
  ᴇ: 'e',
  ʟ: 'l',
  ɪ: 'i',
  ᴄ: 'c',
  ɾ: 'r',
  // Digits that read as letters
  '0': 'o',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
};

/**
 * Letters of whole scripts drawn like Latin capitals (UTS #39 confusables): Lisu (Fraser), and
 * Cherokee in both cases (lower case is what the skeleton sees after toLowerCase).
 */
const SCRIPT_LOOK_ALIKES: Record<string, string> = {
  // Lisu
  ꓮ: 'a',
  ꓐ: 'b',
  ꓚ: 'c',
  ꓓ: 'd',
  ꓰ: 'e',
  ꓝ: 'f',
  ꓖ: 'g',
  ꓧ: 'h',
  ꓲ: 'i',
  ꓙ: 'j',
  ꓗ: 'k',
  ꓡ: 'l',
  ꓟ: 'm',
  ꓠ: 'n',
  ꓳ: 'o',
  ꓑ: 'p',
  ꓣ: 'r',
  ꓢ: 's',
  ꓔ: 't',
  ꓴ: 'u',
  ꓦ: 'v',
  ꓪ: 'w',
  ꓫ: 'x',
  ꓬ: 'y',
  ꓜ: 'z',
  // Cherokee
  Ꭺ: 'a',
  Ᏼ: 'b',
  Ꮟ: 'b',
  Ꮯ: 'c',
  Ꭰ: 'd',
  Ꮷ: 'd',
  Ꭼ: 'e',
  Ꮐ: 'g',
  Ꮋ: 'h',
  Ꮒ: 'h',
  Ꭵ: 'i',
  Ꭻ: 'j',
  Ꮶ: 'k',
  Ꮮ: 'l',
  Ꮇ: 'm',
  Ꮲ: 'p',
  Ꭱ: 'r',
  Ꮢ: 'r',
  Ꮪ: 's',
  Ꮥ: 's',
  Ꭲ: 't',
  Ꮩ: 'v',
  Ꮃ: 'w',
  Ꮤ: 'w',
  Ꭹ: 'y',
  Ꮓ: 'z',
};
for (const [letter, latin] of Object.entries(SCRIPT_LOOK_ALIKES))
  LOOK_ALIKES[letter.toLowerCase()] = LOOK_ALIKES[letter] = latin;

export function foldElricName(name: string): string {
  return [
    ...name
      .normalize('NFKC')
      .replace(/[\p{Cc}\p{Cf}]/gu, '')
      .toLowerCase(),
  ]
    .map((char) => LOOK_ALIKES[char] ?? char)
    .join('')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[il1|!¡]/g, '1')
    .replace(/[^a-z0-9]/g, '');
}

const RESERVED = foldElricName('Elric');

/** True when `name` reads as "Elric", whatever the flag (the pure skeleton comparison). */
export function isReservedElricName(name: string): boolean {
  return foldElricName(name) === RESERVED;
}

/**
 * The one check every name-setting path calls (agent create in the console, city_create_agent,
 * manifest apply, a new agent on room join, the accountless invite join, a person joining a room):
 * true when Elric is enabled and `name` reads as "Elric". First-party Elric agents are created by
 * addElric only, which never calls it.
 */
export function reservedName(
  name: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return elricEnabled(env) && isReservedElricName(name);
}

export const ELRIC_RESERVED_NAME_CODE = 'name_reserved';
export const ELRIC_RESERVED_NAME_MESSAGE =
  "The name Elric is reserved for Central City's own agent. Choose another name.";
