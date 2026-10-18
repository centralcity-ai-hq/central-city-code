import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import {
  OFFER_ANSWER_MAX_BYTES,
  OFFER_KIND_REGISTRY,
  OfferKindInputError,
  type OfferKindAnswer,
} from '../server/feed/offers/kinds.js';
import { addressChecksum } from '../server/feed/offers/kinds-base.js';
import { CSV_MAX_ROWS, parseCsv } from '../server/feed/offers/kinds-csv.js';
import { inlineText, markdownToText } from '../server/feed/offers/kinds-markdown.js';
import { dateDiff, dayNumber, hslToRgb, rgbToHsl } from '../server/feed/offers/kinds-numbers.js';
import {
  BASE64_ENCODE_MAX_BYTES,
  identifierWords,
  SLUG_MAX_LENGTH,
} from '../server/feed/offers/kinds-strings.js';
import { OFFER_KIND_SPECS, type OfferKindName } from '../shared/feed-offers.js';
import { agreeingRun, agreementLog, checkAgreementSeen } from './feed-offer-kinds-agree.js';

const ctx = () => ({ signal: new AbortController().signal, now: Date.UTC(2026, 9, 15) });
/** Every run is also checked against the pre-payment check (feed-offer-kinds-agree.ts). */
const agreement = agreementLog();
const run = (kind: OfferKindName, input: unknown) =>
  agreeingRun(OFFER_KIND_REGISTRY.get(kind)!, input, ctx(), agreement);

async function text(kind: OfferKindName, input: unknown): Promise<string> {
  const { body, mime }: OfferKindAnswer = await run(kind, input);
  assert.equal(mime, 'text/plain');
  assert.equal(mime, OFFER_KIND_SPECS[kind].outputMime);
  assert.equal(typeof body, 'string');
  assert.ok(Buffer.byteLength(body as string) <= OFFER_ANSWER_MAX_BYTES);
  return body as string;
}

async function json(kind: OfferKindName, input: unknown): Promise<Record<string, unknown>> {
  const { body, mime }: OfferKindAnswer = await run(kind, input);
  assert.equal(mime, 'application/json');
  assert.equal(mime, OFFER_KIND_SPECS[kind].outputMime);
  assert.ok(Buffer.byteLength(JSON.stringify(body)) <= OFFER_ANSWER_MAX_BYTES);
  // Answers are plain JSON: what is sent parses back to the same value.
  return JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
}

async function refused(kind: OfferKindName, input: unknown, message?: RegExp): Promise<void> {
  await assert.rejects(run(kind, input), (error: unknown) => {
    assert.ok(error instanceof OfferKindInputError, String(error));
    if (message) assert.match(error.message, message);
    return true;
  });
}

/** Runs `body` and fails when it takes longer than `ms` (linear time on hostile input). */
async function quickly(label: string, ms: number, body: () => Promise<unknown> | unknown) {
  const started = performance.now();
  await body();
  const elapsed = performance.now() - started;
  assert.ok(elapsed < ms, `${label}: ${elapsed.toFixed(1)} ms`);
}

const TOO_LARGE = /answer would be larger than 65536 bytes/;

// ---------------------------------------------------------------- base64

test('base64: encodes UTF-8 and decodes canonical Base64 back to text', async () => {
  assert.equal(await text('base64', { text: 'hello', mode: 'encode' }), 'aGVsbG8=');
  assert.equal(await text('base64', { text: '', mode: 'encode' }), '');
  assert.equal(await text('base64', { text: 'aGVsbG8=', mode: 'decode' }), 'hello');
  const unicode = 'café \u{1F600}';
  const encoded = await text('base64', { text: unicode, mode: 'encode' });
  assert.equal(encoded, Buffer.from(unicode).toString('base64'));
  assert.equal(await text('base64', { text: encoded, mode: 'decode' }), unicode);
  assert.equal(await text('base64', { text: '', mode: 'decode' }), '');
});

test('base64: refuses what is not canonical Base64 or not UTF-8, and an encoding past 64 KiB', async () => {
  for (const bad of [
    'abc',
    'ab$=',
    'aGVsbG8',
    ' aGVsbG8=',
    'aGVs\nbG8=',
    'aGVsbG8-',
    'a===',
    '=abc',
  ])
    await refused('base64', { text: bad, mode: 'decode' }, /not valid Base64/);
  // Stray bits in the last character: 'aGVsbG9=' would also decode to "hello".
  await refused('base64', { text: 'aGVsbG9=', mode: 'decode' }, /stray bits/);
  await refused('base64', { text: '/w==', mode: 'decode' }, /not UTF-8/);
  await refused('base64', { text: 'hi', mode: 'both' }, /mode must be one of encode, decode/);
  // The largest text whose Base64 fits, then one byte more.
  const fits = await text('base64', { text: 'a'.repeat(BASE64_ENCODE_MAX_BYTES), mode: 'encode' });
  assert.equal(fits.length, OFFER_ANSWER_MAX_BYTES);
  await refused(
    'base64',
    { text: 'a'.repeat(BASE64_ENCODE_MAX_BYTES + 1), mode: 'encode' },
    /49152/,
  );
  // 64 KiB of Base64 decodes.
  assert.equal(
    (await text('base64', { text: fits, mode: 'decode' })).length,
    BASE64_ENCODE_MAX_BYTES,
  );
});

// ---------------------------------------------------------------- url-encode

test('url-encode: percent-encodes UTF-8 and decodes it, + stays +', async () => {
  assert.equal(
    await text('url-encode', { text: 'a b&c/é?', mode: 'encode' }),
    'a%20b%26c%2F%C3%A9%3F',
  );
  assert.equal(await text('url-encode', { text: 'a%20b%26c%2F%C3%A9', mode: 'decode' }), 'a b&c/é');
  assert.equal(await text('url-encode', { text: 'a+b', mode: 'decode' }), 'a+b');
  assert.equal(await text('url-encode', { text: "-_.!~*'()", mode: 'encode' }), "-_.!~*'()");
  for (const bad of ['%', '%ZZ', '%E0%A4%A', '%C3', '%FF'])
    await refused('url-encode', { text: bad, mode: 'decode' }, /not valid percent-encoding/);
  await refused('url-encode', { text: 'a\ud800b', mode: 'encode' }, /lone surrogate/);
  // Encoding can grow 9 times: an answer past 64 KiB is refused, not cut.
  await refused('url-encode', { text: 'é'.repeat(30_000), mode: 'encode' }, TOO_LARGE);
});

// ---------------------------------------------------------------- case-convert

test('case-convert: every case', async () => {
  const cases: Record<string, string> = {
    upper: 'HELLO BIG WORLD',
    lower: 'hello big world',
    title: 'Hello Big World',
    sentence: 'Hello big world',
    snake: 'hello_big_world',
    kebab: 'hello-big-world',
    camel: 'helloBigWorld',
    pascal: 'HelloBigWorld',
  };
  for (const [to, expected] of Object.entries(cases))
    assert.equal(await text('case-convert', { text: 'Hello big world', to }), expected, to);
  assert.deepEqual(identifierWords('HTMLParser version2Beta, user_id-x'), [
    'HTML',
    'Parser',
    'version',
    '2',
    'Beta',
    'user',
    'id',
    'x',
  ]);
  assert.equal(
    await text('case-convert', { text: 'HTMLParser version2Beta', to: 'snake' }),
    'html_parser_version_2_beta',
  );
  assert.equal(
    await text('case-convert', { text: 'some_snake_case', to: 'camel' }),
    'someSnakeCase',
  );
  assert.equal(await text('case-convert', { text: 'café über', to: 'pascal' }), 'CaféÜber');
  assert.equal(
    await text('case-convert', { text: "don't STOP me now", to: 'title' }),
    "Don't Stop Me Now",
  );
  assert.equal(
    await text('case-convert', {
      text: 'hello. how ARE you?  fine! e.g.x yes\n\nnew',
      to: 'sentence',
    }),
    'Hello. How are you?  Fine! E.g.x yes\n\nnew',
  );
  assert.equal(await text('case-convert', { text: 'straße', to: 'upper' }), 'STRASSE');
  assert.equal(await text('case-convert', { text: '', to: 'snake' }), '');
  await refused('case-convert', { text: 'x', to: 'shout' }, /to must be one of/);
  // Upper case can grow: ŉ is 2 bytes, its capital 3.
  await refused('case-convert', { text: 'ŉ'.repeat(32_768), to: 'upper' }, TOO_LARGE);
});

test('case-convert: linear on long runs', async () => {
  for (const sample of [
    'A'.repeat(65_536),
    'aA'.repeat(32_768),
    'Ab1'.repeat(21_000),
    '_'.repeat(65_536),
  ])
    for (const to of ['snake', 'camel', 'title', 'sentence'])
      // Some answers are larger than 64 KiB and refused: the time to find that out counts too.
      await quickly(to, 500, () =>
        run('case-convert', { text: sample, to }).catch((error: unknown) => {
          assert.ok(error instanceof OfferKindInputError);
          assert.match(error.message, TOO_LARGE);
        }),
      );
});

// ---------------------------------------------------------------- slugify

test('slugify: lower case ASCII, accents removed, hyphens, at most 200 characters', async () => {
  assert.equal(
    await text('slugify', { text: 'Café & Crème: the best of 2026' }),
    'cafe-creme-the-best-of-2026',
  );
  assert.equal(
    await text('slugify', { text: 'Straße Æsir Øre Łódź Œuvre Þorn' }),
    'strasse-aesir-ore-lodz-oeuvre-thorn',
  );
  assert.equal(await text('slugify', { text: 'ﬁne ＡＢ x²' }), 'fine-ab-x2');
  assert.equal(await text('slugify', { text: '  --Hello,   World!--  ' }), 'hello-world');
  const long = await text('slugify', { text: 'word '.repeat(100) });
  assert.ok(long.length <= SLUG_MAX_LENGTH);
  assert.ok(!long.endsWith('-'));
  assert.equal(long, 'word-'.repeat(40).slice(0, 199));
  assert.equal((await text('slugify', { text: 'a'.repeat(500) })).length, SLUG_MAX_LENGTH);
  for (const empty of ['---', '中文', '', '\u{1F600}'])
    await refused('slugify', { text: empty }, /no letters or digits/);
});

// ---------------------------------------------------------------- reading-time

test('reading-time: words, minutes to one decimal and seconds', async () => {
  const words = 'word '.repeat(400);
  assert.deepEqual(await json('reading-time', { text: words }), {
    words: 400,
    wordsPerMinute: 200,
    minutes: 2,
    seconds: 120,
  });
  assert.deepEqual(await json('reading-time', { text: words, words_per_minute: 300 }), {
    words: 400,
    wordsPerMinute: 300,
    minutes: 1.3,
    seconds: 80,
  });
  assert.deepEqual(await json('reading-time', { text: 'one two three' }), {
    words: 3,
    wordsPerMinute: 200,
    minutes: 0,
    seconds: 1,
  });
  assert.equal((await json('reading-time', { text: '' })).words, 0);
  // Words as text-stats counts them: contractions and decimals are one word.
  assert.equal((await json('reading-time', { text: "isn't 3.50 well-known" })).words, 3);
  await refused('reading-time', { text: 'x', words_per_minute: 99 }, /out of range/);
  await refused('reading-time', { text: 'x', words_per_minute: 1001 }, /out of range/);
  await refused('reading-time', { text: 'x', words_per_minute: 200.5 }, /whole number/);
});

// ---------------------------------------------------------------- csv-to-json

test('csv-to-json: header rows as objects, RFC 4180 quotes, line endings and delimiters', async () => {
  assert.deepEqual(await json('csv-to-json', { text: 'name,age\nAda,36\nAlan,41\n' }), {
    columns: ['name', 'age'],
    rows: [
      { name: 'Ada', age: '36' },
      { name: 'Alan', age: '41' },
    ],
  });
  assert.deepEqual(
    await json('csv-to-json', {
      text: 'a,b\r\n"x, y","say ""hi"""\r\n"line\r\nbreak",\r\n\r\n"",z',
    }),
    {
      columns: ['a', 'b'],
      rows: [
        { a: 'x, y', b: 'say "hi"' },
        { a: 'line\r\nbreak', b: '' },
        { a: '', b: 'z' },
      ],
    },
  );
  assert.deepEqual(await json('csv-to-json', { text: '1;2\r3;4', delimiter: ';', header: false }), {
    rows: [
      ['1', '2'],
      ['3', '4'],
    ],
  });
  assert.deepEqual(await json('csv-to-json', { text: 'a\tb\n1\t2', delimiter: '\t' }), {
    columns: ['a', 'b'],
    rows: [{ a: '1', b: '2' }],
  });
  assert.deepEqual(await json('csv-to-json', { text: 'x|y|\n', delimiter: '|', header: false }), {
    rows: [['x', 'y', '']],
  });
  // Ragged rows are kept as they are without a header.
  assert.deepEqual(await json('csv-to-json', { text: 'a\nb,c', header: false }), {
    rows: [['a'], ['b', 'c']],
  });
  assert.deepEqual(await json('csv-to-json', { text: '' }), { columns: [], rows: [] });
  // A column named __proto__ is an ordinary key.
  const proto = await json('csv-to-json', { text: '__proto__,b\n1,2' });
  assert.deepEqual(JSON.stringify(proto.rows), '[{"__proto__":"1","b":"2"}]');
});

test('csv-to-json: malformed CSV is refused with its row; caps on rows and on the answer', async () => {
  await refused('csv-to-json', { text: 'a,b\n"open,1' }, /row 2 has a quote that never closes/);
  await refused('csv-to-json', { text: 'a,b\nx"y,1' }, /row 2 has a quote inside a field/);
  await refused(
    'csv-to-json',
    { text: 'a,b\n"x"y,1' },
    /row 2 has characters after a closing quote/,
  );
  await refused('csv-to-json', { text: 'a,b\n1,2\n3' }, /row 3 has 1 fields; the header has 2/);
  await refused('csv-to-json', { text: 'a,a\n1,2' }, /names a column more than once/);
  await refused('csv-to-json', { text: 'a', delimiter: ':' }, /delimiter must be one of/);
  await refused('csv-to-json', { text: 'a', header: 'yes' }, /header must be true or false/);
  const max = 'x\n'.repeat(CSV_MAX_ROWS);
  assert.equal(parseCsv(max, ',').length, CSV_MAX_ROWS);
  assert.equal(
    ((await json('csv-to-json', { text: max, header: false })).rows as unknown[]).length,
    CSV_MAX_ROWS,
  );
  await refused('csv-to-json', { text: `${max}x`, header: false }, /more than 10000 rows/);
  // A long column name repeats in every row: refused while the answer is built.
  await quickly('expanding header', 500, () =>
    refused('csv-to-json', { text: `${'k'.repeat(30_000)}\n${'x\n'.repeat(1000)}` }, TOO_LARGE),
  );
  // Control characters grow six times as JSON.
  await refused('csv-to-json', { text: '\u0001'.repeat(20_000), header: false }, TOO_LARGE);
});

test('csv-to-json: linear on hostile input', async () => {
  for (const sample of [
    '"'.repeat(65_535),
    '""'.repeat(32_768),
    ','.repeat(65_536),
    '"a",'.repeat(16_384),
    '\n'.repeat(65_536),
  ])
    await quickly('csv', 500, () =>
      run('csv-to-json', { text: sample, header: false }).catch(() => null),
    );
});

// ---------------------------------------------------------------- json-to-csv

test('json-to-csv: a header of every key in first-seen order, RFC 4180 quoting, CR LF lines', async () => {
  assert.equal(
    await text('json-to-csv', {
      text: '[{"name":"Ada","age":36},{"name":"Alan","city":"London"}]',
    }),
    'name,age,city\r\nAda,36,\r\nAlan,,London\r\n',
  );
  assert.equal(
    await text('json-to-csv', {
      text: JSON.stringify([
        { a: 'x, y', b: 'say "hi"', c: 'two\nlines', d: null, e: true, f: -1.5 },
      ]),
    }),
    'a,b,c,d,e,f\r\n"x, y","say ""hi""","two\nlines",,true,-1.5\r\n',
  );
  assert.equal(await text('json-to-csv', { text: '[{"__proto__":1}]' }), '__proto__\r\n1\r\n');
  assert.equal(await text('json-to-csv', { text: '[{}]' }), '\r\n\r\n');
  // A round trip through csv-to-json gives the text back.
  const csv = await text('json-to-csv', { text: '[{"k":"v,1"},{"k":"\\"q\\""}]' });
  assert.deepEqual((await json('csv-to-json', { text: csv })).rows, [{ k: 'v,1' }, { k: '"q"' }]);
});

test('json-to-csv: refuses what is not an array of flat objects, and answers past 64 KiB', async () => {
  await refused('json-to-csv', { text: '[{"a":1}' }, /not valid JSON/);
  await refused('json-to-csv', { text: '{"a":1}' }, /JSON array of at least one object/);
  await refused('json-to-csv', { text: '[]' }, /JSON array of at least one object/);
  await refused('json-to-csv', { text: '[{"a":1},2]' }, /item 2 is not an object/);
  await refused('json-to-csv', { text: '[[1]]' }, /item 1 is not an object/);
  await refused('json-to-csv', { text: '[{"a":{"b":1}}]' }, /item 1 has a value that is not text/);
  await refused('json-to-csv', { text: '[{"a":[1]}]' }, /item 1 has a value/);
  await refused('json-to-csv', { text: '[{"a":1e400}]' }, /item 1 has a value/);
  // Sparse rows of distinct keys: rows times columns, refused before anything is built.
  const sparse = JSON.stringify(Array.from({ length: 5000 }, (_, index) => ({ [`k${index}`]: 1 })));
  assert.ok(Buffer.byteLength(sparse) <= 65_536);
  await quickly('sparse', 500, () => refused('json-to-csv', { text: sparse }, TOO_LARGE));
  await refused(
    'json-to-csv',
    { text: JSON.stringify(Array.from({ length: 10_001 }, () => ({}))) },
    /more than 10000 objects/,
  );
});

// ---------------------------------------------------------------- markdown-to-text

test('markdown-to-text: keeps the text, link text and code; drops images, addresses and markup', async () => {
  const markdown = [
    '# Title ##',
    'Setext',
    '======',
    '',
    'Some **bold**, *italic*, __strong__, ~~gone~~ and `code *kept*` text.',
    'A [link](https://example.com/a(b)) and ![an image](i.png) and [ref][1] and <https://example.com/x>.',
    'snake_case stays, 2 * 3 = 6, and \\*escaped\\* stars.',
    '',
    '> quoted',
    '> > nested',
    '',
    '- item one',
    '* [x] done',
    '12. numbered',
    '',
    '---',
    '',
    '| a | b |',
    '|---|:-:|',
    '| 1 | 2 |',
    '',
    '```js',
    'const x = **1**;',
    '```',
    '<div class="x">html <b>tags</b></div><!-- comment -->',
    '[1]: https://example.com/ref',
    '',
    '',
    '',
    'End.',
  ].join('\n');
  assert.equal(
    await text('markdown-to-text', { text: markdown }),
    [
      'Title',
      'Setext',
      '',
      'Some bold, italic, strong, gone and code *kept* text.',
      'A link) and  and ref and https://example.com/x.',
      'snake_case stays, 2 * 3 = 6, and *escaped* stars.',
      '',
      'quoted',
      'nested',
      '',
      'item one',
      'done',
      'numbered',
      '',
      'a b',
      '1 2',
      '',
      'const x = **1**;',
      'html tags',
      '',
      'End.',
    ].join('\n'),
  );
  assert.equal(inlineText('[a [b](c)'), 'a [b');
  assert.equal(inlineText('![alt][ref] after'), ' after');
  assert.equal(inlineText('``a ` b``'), 'a ` b');
  assert.equal(
    inlineText('unclosed [bracket and `tick and <tag'),
    'unclosed [bracket and `tick and <tag',
  );
  assert.equal(markdownToText(''), '');
});

test('markdown-to-text: linear on hostile input', async () => {
  for (const sample of [
    '['.repeat(65_536),
    '[a]('.repeat(16_384),
    '![x]['.repeat(13_000),
    '[x]['.repeat(16_000),
    '`'.repeat(65_536),
    '`a``b```c````'.repeat(5000),
    '>'.repeat(65_536),
    '> '.repeat(32_768),
    '<a'.repeat(32_768),
    '<!--'.repeat(16_384),
    '*_'.repeat(32_768),
    `#${' '.repeat(65_000)}#x`,
    `|${'-|'.repeat(32_000)}`,
    `${' '.repeat(65_000)}- x`,
    `[${' '.repeat(65_000)}`,
    '```\n'.repeat(16_000),
  ])
    await quickly(sample.slice(0, 12), 500, () => run('markdown-to-text', { text: sample }));
});

// ---------------------------------------------------------------- roman-numerals

test('roman-numerals: both ways, standard form only', async () => {
  for (const [value, roman] of [
    [1, 'I'],
    [4, 'IV'],
    [9, 'IX'],
    [14, 'XIV'],
    [40, 'XL'],
    [90, 'XC'],
    [400, 'CD'],
    [1994, 'MCMXCIV'],
    [2026, 'MMXXVI'],
    [3999, 'MMMCMXCIX'],
  ] as const) {
    assert.deepEqual(await json('roman-numerals', { value }), { value, roman });
    assert.deepEqual(await json('roman-numerals', { text: roman }), { value, roman });
  }
  assert.deepEqual(await json('roman-numerals', { text: 'xiv' }), { value: 14, roman: 'XIV' });
  for (const bad of ['IIII', 'IC', 'VX', 'MMMM', 'IIV', 'XM', 'VV', '', ' X', 'X ', 'ABC', 'IL'])
    await refused('roman-numerals', { text: bad }, /standard form/);
  await refused('roman-numerals', { value: 0 }, /out of range/);
  await refused('roman-numerals', { value: 4000 }, /out of range/);
  await refused('roman-numerals', {}, /one of value or text/);
  await refused('roman-numerals', { value: 1, text: 'I' }, /one of value or text/);
});

// ---------------------------------------------------------------- number-to-words

test('number-to-words: English words for whole numbers up to the hundreds of billions', async () => {
  const cases: Array<[number, string]> = [
    [0, 'zero'],
    [7, 'seven'],
    [13, 'thirteen'],
    [20, 'twenty'],
    [21, 'twenty-one'],
    [100, 'one hundred'],
    [101, 'one hundred one'],
    [1234, 'one thousand two hundred thirty-four'],
    [1_000_000, 'one million'],
    [1_000_001, 'one million one'],
    [-5, 'minus five'],
    [
      999_999_999_999,
      'nine hundred ninety-nine billion nine hundred ninety-nine million nine hundred ninety-nine thousand nine hundred ninety-nine',
    ],
    [
      -999_999_999_999,
      `minus nine hundred ninety-nine billion nine hundred ninety-nine million nine hundred ninety-nine thousand nine hundred ninety-nine`,
    ],
    [2_000_030_000, 'two billion thirty thousand'],
  ];
  for (const [value, words] of cases)
    assert.deepEqual(await json('number-to-words', { value }), { value, words });
  assert.deepEqual(await json('number-to-words', { value: -0 }), { value: 0, words: 'zero' });
  await refused('number-to-words', { value: 1e12 }, /out of range/);
  await refused('number-to-words', { value: 1.5 }, /whole number/);
});

// ---------------------------------------------------------------- color-convert

test('color-convert: hex, rgb and hsl, each from any of them', async () => {
  assert.deepEqual(await json('color-convert', { color: '#1E90FF' }), {
    hex: '#1e90ff',
    rgb: { r: 30, g: 144, b: 255 },
    hsl: { h: 209.6, s: 100, l: 55.9 },
    css: { rgb: 'rgb(30, 144, 255)', hsl: 'hsl(209.6, 100%, 55.9%)' },
  });
  assert.deepEqual((await json('color-convert', { color: '#fff' })).rgb, {
    r: 255,
    g: 255,
    b: 255,
  });
  assert.deepEqual(await json('color-convert', { color: ' rgb( 255 , 0 , 0 ) ' }), {
    hex: '#ff0000',
    rgb: { r: 255, g: 0, b: 0 },
    hsl: { h: 0, s: 100, l: 50 },
    css: { rgb: 'rgb(255, 0, 0)', hsl: 'hsl(0, 100%, 50%)' },
  });
  const green = await json('color-convert', { color: 'hsl(120, 100%, 25%)' });
  assert.equal(green.hex, '#008000');
  assert.deepEqual(green.hsl, { h: 120, s: 100, l: 25 });
  assert.deepEqual((await json('color-convert', { color: 'HSL(360,0%,100%)' })).hsl, {
    h: 0,
    s: 0,
    l: 100,
  });
  assert.equal((await json('color-convert', { color: 'hsl(300.5, 50.25%, 40%)' })).hex, '#993398');
  // Every hex color survives hex to HSL and back within one step per channel.
  for (let index = 0; index < 4096; index += 7) {
    const rgb = { r: (index * 37) % 256, g: (index * 91) % 256, b: (index * 13) % 256 };
    const back = hslToRgb(rgbToHsl(rgb));
    for (const channel of ['r', 'g', 'b'] as const)
      assert.ok(Math.abs(back[channel] - rgb[channel]) <= 1, JSON.stringify([rgb, back]));
  }
  for (const bad of [
    '#12',
    '#12345g',
    'rgb(256,0,0)',
    'rgb(1,2)',
    'hsl(361,0%,0%)',
    'hsl(0,101%,0%)',
    'red',
    '',
  ])
    await refused('color-convert', { color: bad });
});

// ---------------------------------------------------------------- date-diff

test('date-diff: days, weeks and the calendar difference, either direction', async () => {
  assert.deepEqual(await json('date-diff', { from: '2026-01-01', to: '2026-10-15' }), {
    from: '2026-01-01',
    to: '2026-10-15',
    days: 287,
    weeks: 41,
    calendar: { years: 0, months: 9, days: 14 },
  });
  assert.deepEqual(await json('date-diff', { from: '2026-10-15', to: '2026-01-01' }), {
    from: '2026-10-15',
    to: '2026-01-01',
    days: -287,
    weeks: -41,
    calendar: { years: 0, months: -9, days: -14 },
  });
  const calendar = (from: string, to: string) => dateDiff(from, to).calendar;
  // A month after the 31st is the shorter month's last day.
  assert.deepEqual(calendar('2026-01-31', '2026-02-28'), { years: 0, months: 1, days: 0 });
  assert.deepEqual(calendar('2026-01-31', '2026-03-01'), { years: 0, months: 1, days: 1 });
  assert.deepEqual(calendar('2024-02-29', '2025-02-28'), { years: 1, months: 0, days: 0 });
  assert.deepEqual(calendar('2024-02-28', '2024-02-29'), { years: 0, months: 0, days: 1 });
  assert.deepEqual(calendar('2026-10-15', '2026-10-15'), { years: 0, months: 0, days: 0 });
  assert.equal(dateDiff('2024-02-28', '2024-03-01').days, 2);
  assert.equal(dateDiff('2100-02-28', '2100-03-01').days, 1);
  assert.equal(dateDiff('2000-02-28', '2000-03-01').days, 2);
  // The whole range, proleptic Gregorian; the day numbers agree with the platform's.
  const whole = dateDiff('0001-01-01', '9999-12-31');
  assert.equal(whole.days, 3_652_058);
  assert.deepEqual(whole.calendar, { years: 9998, months: 11, days: 30 });
  assert.equal(dayNumber({ year: 1970, month: 1, day: 1 }), 0);
  for (const [year, month, day] of [
    [1, 1, 1],
    [1600, 2, 29],
    [1899, 12, 31],
    [2026, 10, 15],
    [9999, 12, 31],
  ] as const) {
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    assert.equal(dayNumber({ year, month, day }), Math.round(date.getTime() / 86_400_000));
  }
  for (const [from, to] of [
    ['2026-02-29', '2026-03-01'],
    ['2026-02-30', '2026-03-01'],
    ['0000-01-01', '2026-01-01'],
    ['2026-13-01', '2026-01-01'],
    ['2026-00-10', '2026-01-01'],
    ['2026-04-31', '2026-01-01'],
  ])
    await refused('date-diff', { from, to }, /not a date of the years 1 to 9999/);
  await refused('date-diff', { from: '2026-1-01', to: '2026-01-01' }, /expected form/);
});

// ---------------------------------------------------------------- address-checksum

test('address-checksum: the EIP-55 form, and whether the given checksum holds', async () => {
  const checksummed = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  assert.deepEqual(await json('address-checksum', { address: checksummed.toLowerCase() }), {
    checksummed,
    valid: true,
    checksum: 'none',
  });
  assert.deepEqual(addressChecksum(`0x${checksummed.slice(2).toUpperCase()}`), {
    checksummed,
    valid: true,
    checksum: 'none',
  });
  assert.deepEqual(addressChecksum(checksummed), { checksummed, valid: true, checksum: 'correct' });
  assert.deepEqual(addressChecksum('0x833589fcD6eDb6E08f4c7C32D4f71b54bdA02913'), {
    checksummed,
    valid: false,
    checksum: 'wrong',
  });
  // Digits only: nothing to check.
  assert.equal(addressChecksum(`0x${'1'.repeat(40)}`).checksum, 'none');
  for (const bad of ['0x123', `0X${'a'.repeat(40)}`, `0x${'g'.repeat(40)}`, 'a'.repeat(42)])
    await refused('address-checksum', { address: bad }, /expected form/);
});

test('every run of this file agreed with check() (refused there, or never refused after payment)', () => {
  checkAgreementSeen(agreement, 10);
});
