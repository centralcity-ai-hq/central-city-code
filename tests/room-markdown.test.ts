import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown, safeHref, textOf, textShowsHost } from '../src/rooms/markdown/render.js';
import { parseMarkdown, parseSafely } from '../src/rooms/markdown/parse.js';
import {
  closesFence,
  openingFence,
  tooComplexForMarkdown,
  withoutBidiControls,
} from '../src/rooms/markdown/guard.js';
import { highlight } from '../src/rooms/markdown/highlight.js';
import { messageFormat } from '../src/rooms/markdown/format.js';

const html = (text: string, names: string[] = []) =>
  renderToStaticMarkup(createElement(Markdown, { text, names, parse: parseSafely }));

/** Only these elements may come out of room content (React-emitted markup, text is escaped). */
const ALLOWED_TAGS = new Set(
  'div p span a em strong del code pre h4 h5 h6 ul ol li input blockquote hr br table thead tbody tr th td sup button svg rect path'.split(
    ' ',
  ),
);
/** Every element and attribute React emitted: none may be dangerous. */
function assertInert(out: string, input: string) {
  for (const match of out.matchAll(/<([a-zA-Z0-9]+)((?:\s[^>]*)?)\/?>/g)) {
    const [tag, attrs] = [match[1]!.toLowerCase(), match[2] ?? ''];
    assert.ok(ALLOWED_TAGS.has(tag), `${JSON.stringify(input)} produced <${tag}>: ${out}`);
    // lucide icons are the only SVG, always aria-hidden, from our code.
    if (['svg', 'rect', 'path'].includes(tag)) continue;
    for (const attr of attrs.matchAll(/\s([a-zA-Z-:]+)(?:="([^"]*)")?/g)) {
      const [name, value = ''] = [attr[1]!.toLowerCase(), attr[2]];
      assert.ok(!name.startsWith('on'), `${input} produced ${name}: ${out}`);
      assert.ok(
        !['src', 'srcdoc', 'srcset', 'formaction', 'action'].includes(name),
        `${input}: ${name}`,
      );
      if (name === 'href') assert.match(value, /^https?:\/\//, `${input} produced href=${value}`);
      if (name === 'style')
        assert.match(value, /^text-align:(left|right|center)$/, `${input}: style`);
    }
  }
}

// OWASP XSS filter evasion cheat-sheet style vectors, plus Markdown-specific ones.
const CORPUS = [
  '<script>alert(1)</script>',
  '<SCRIPT SRC=https://evil.example/xss.js></SCRIPT>',
  '<img src=x onerror=alert(1)>',
  '<IMG SRC="javascript:alert(\'XSS\');">',
  '<IMG SRC=JaVaScRiPt:alert(1)>',
  '<svg/onload=alert(1)>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<a href="javascript:alert(1)">x</a>',
  '<div style="background:url(javascript:alert(1))">x</div>',
  '<body onload=alert(1)>',
  '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
  '<details open ontoggle=alert(1)>',
  '[click](javascript:alert(1))',
  '[click](JAVASCRIPT:alert(1))',
  '[click](  javascript:alert(1))',
  '[click](java&#x09;script:alert(1))',
  '[click](jav&#x61;script:alert(1))',
  '[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  '[click](vbscript:msgbox(1))',
  '[click](file:///etc/passwd)',
  '[x][r]\n\n[r]: javascript:alert(1)',
  '<javascript:alert(1)>',
  '![x](javascript:alert(1))',
  '![x](https://tracker.example/pixel.png)',
  '![x][i]\n\n[i]: https://tracker.example/p.png',
  '```html\n<script>alert(1)</script>\n```',
  '`<img src=x onerror=alert(1)>`',
  '| a |\n|---|\n| <img src=x onerror=alert(1)> |',
  '- [ ] <script>alert(1)</script>',
  '> <iframe src=//evil.example>',
  '<!-- <script>alert(1)</script> -->',
  '<a href="https://ok.example" onclick="alert(1)">x</a>',
  'text <span onmouseover=alert(1)>hover</span>',
];

test('no path from room Markdown to HTML: the XSS corpus renders inert', () => {
  for (const input of CORPUS) assertInert(html(input), input);
});

test('raw HTML is shown as literal text, not interpreted', () => {
  const out = html('Hello <b>bold</b> <script>alert(1)</script>');
  const text = out
    .replace(/<[^>]+>/g, '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
  assert.equal(text, 'Hello <b>bold</b> <script>alert(1)</script>');
  assert.doesNotMatch(out, /<b>|<script/);
});

test('links are http(s) only, open in a new tab, and carry noopener nofollow ugc', () => {
  const out = html('[docs](https://centralcity.ai/docs) and https://example.com/a');
  assert.match(
    out,
    /<a href="https:\/\/centralcity\.ai\/docs" title="https:\/\/centralcity\.ai\/docs" target="_blank" rel="noopener nofollow ugc noreferrer"><span>docs<\/span><\/a>/,
  );
  // GFM autolink literal.
  assert.match(out, /<a href="https:\/\/example\.com\/a"/);
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,x',
    'mailto:a@b.c',
    '/relative',
    'ftp://x',
  ])
    assert.equal(safeHref(url), null, url);
  assert.equal(safeHref('HTTPS://Example.com'), 'https://example.com/');
  // An unsafe link keeps its text, without a link.
  assert.equal(
    html('[t](javascript:x)'),
    '<div class="md-body-wrap"><div class="md-body"><p><span><span>t</span></span></p></div></div>',
  );
});

test('Markdown images are never loaded: they become links (or text when unsafe)', () => {
  const out = html('![diagram](https://example.com/d.png)');
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /<a href="https:\/\/example\.com\/d\.png"[^>]*>Image: diagram<\/a>/);
  assert.match(html('![x](javascript:alert(1))'), /<span>Image: x<\/span>/);
});

test('the allowed Markdown set renders to the expected elements', () => {
  const out = html(
    [
      '# Title',
      '## Sub',
      '#### Deep',
      '',
      'Some *em*, **strong**, ~~gone~~ and `code`.',
      '',
      '- one',
      '- two',
      '',
      '1. first',
      '',
      '- [x] done',
      '- [ ] open',
      '',
      '> quoted',
      '',
      '---',
      '',
      '| a | b |',
      '|:--|--:|',
      '| 1 | 2 |',
      '',
      '```ts',
      'const x = 1;',
      '```',
    ].join('\n'),
  );
  for (const expected of [
    '<h4 class="md-h md-h1">',
    '<h5 class="md-h md-h2">',
    '<h6 class="md-h md-h3">',
    '<em>',
    '<strong>',
    '<del>',
    '<code>code</code>',
    '<ul>',
    '<ol start="1">',
    'type="checkbox"',
    'aria-label="Done"',
    'aria-label="Not done"',
    '<blockquote>',
    '<hr/>',
    '<table>',
    '<th style="text-align:left">',
    '<td style="text-align:right">',
    'class="md-code"',
    'aria-label="Copy code"',
    '<span class="md-code-lang">ts</span>',
    'const x = 1;',
  ])
    assert.ok(out.includes(expected), `missing ${expected} in ${out}`);
  // Task checkboxes are display only.
  assert.match(
    out,
    /<input type="checkbox" disabled="" readOnly=""|<input type="checkbox"[^>]*disabled/,
  );
});

test('@mentions of room members become chips, inside Markdown text', () => {
  const out = html('Hi **@Claude Code** and @Nobody', ['Claude Code', 'Relay']);
  assert.match(
    out,
    /<strong><span><span class="rm-mention">@Claude Code<\/span><\/span><\/strong>/,
  );
  assert.doesNotMatch(out, /rm-mention">@Nobody/);
});

test('parser DoS bounds: input is capped and deep nesting is flattened', () => {
  const deep = `${'> '.repeat(2000)}deep`;
  const started = Date.now();
  const out = html(deep);
  assert.ok(Date.now() - started < 2000, 'deeply nested quotes render quickly');
  assert.ok(out.includes('deep'));
  assert.ok((out.match(/<blockquote>/g) ?? []).length <= 26);
  const list = `${Array.from({ length: 500 }, (_, i) => `${'  '.repeat(i)}- x`).join('\n')}`;
  assert.ok(html(list).length > 0);
  // Only the first 64 KB (MAX_MARKDOWN_CHARS) are parsed.
  const tree = parseMarkdown(`${'a'.repeat(65_536)}TAIL`);
  assert.ok(!JSON.stringify(tree).includes('TAIL'));
});

test('long messages start collapsed with Show more', () => {
  const out = html(Array.from({ length: 45 }, (_, i) => `line ${i}`).join('\n\n'));
  assert.match(out, /class="md-body collapsed"/);
  assert.match(out, /aria-expanded="false"[^>]*>Show more</);
  assert.doesNotMatch(html('short'), /Show more/);
});

test('code blocks: highlighted per language, unknown and HTML stay plain', () => {
  for (const [language, code] of [
    ['ts', 'const a: number = 1;'],
    ['tsx', 'const a = <div />;'],
    ['javascript', 'function f() { return "x"; }'],
    ['python', 'def f():\n    return 1'],
    ['go', 'func main() {}'],
    ['rust', 'fn main() { let x = 1; }'],
    ['java', 'class A { int x = 1; }'],
    ['json', '{"a": 1}'],
    ['yaml', 'a: 1'],
    ['bash', 'echo "hi"'],
    ['sql', 'SELECT 1 FROM t'],
    ['diff', '+ added\n- removed'],
    ['css', 'a { color: red; }'],
    ['markdown', '# Title'],
    ['toml', 'a = "b"'],
  ] as const) {
    const tree = highlight(language, code);
    assert.ok(tree, language);
    assert.ok(JSON.stringify(tree).includes('hljs-'), `${language} has tokens`);
  }
  assert.equal(highlight('html', '<b>x</b>'), null, 'HTML is shown as text');
  assert.equal(highlight('brainfuck', '+++'), null);
  assert.equal(highlight('', 'x'), null);
  assert.equal(highlight('ts', 'x'.repeat(20_001)), null, 'oversize blocks stay plain');
});

test('format: the server decides; no format is plain; there is no client switch', async () => {
  assert.equal(messageFormat({ format: 'markdown' }), 'markdown');
  assert.equal(messageFormat({ format: 'plain' }), 'plain');
  assert.equal(messageFormat({}), 'plain');
  assert.equal(messageFormat({ format: 'html' }), 'plain');
  // No flag left anywhere in the room UI (build variable or localStorage).
  const root = join(import.meta.dirname, '..', 'src', 'rooms');
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    );
  for (const file of walk(root).filter((f) => /\.(tsx?|css)$/.test(f)))
    assert.doesNotMatch(readFileSync(file, 'utf8'), /VITE_ROOM_MARKDOWN|cc\.rooms\.markdown/, file);
});

test('no highlight.js HTML-string API, and no hast-to-HTML, anywhere in src/', () => {
  const root = join(import.meta.dirname, '..', 'src');
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    );
  const banned = [
    /\bhighlightAuto\b/,
    /\bhighlightElement\b/,
    /\bhighlightAll\b/,
    /\bhljs\.highlight\b/,
    /\.highlight\([^)]*\)\s*\.value\b/,
    /hast-util-to-html|\btoHtml\b/,
    /from ['"]highlight\.js['"]/,
    /from ['"]highlight\.js\/lib\/(?!languages\/)/,
  ];
  for (const file of walk(root).filter((f) => /\.(tsx?|jsx?)$/.test(f))) {
    // The one comment that names the banned calls documents the rule.
    const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const pattern of banned) assert.doesNotMatch(code, pattern, `${file}: ${pattern}`);
  }
});

test('parse order: newest first, and a message on screen jumps the queue', async () => {
  class SlowWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    postMessage() {}
    terminate() {}
  }
  const saved = (globalThis as { Worker?: unknown }).Worker;
  (globalThis as { Worker?: unknown }).Worker = SlowWorker;
  try {
    // A fresh module instance (its own queue), with a worker that never becomes ready.
    const url = new URL('../src/rooms/markdown/workerClient.ts?order', import.meta.url).href;
    const client = (await import(url)) as typeof import('../src/rooms/markdown/workerClient.js');
    void client.parseInWorker('seq 3', 3);
    void client.parseInWorker('seq 9', 9);
    void client.parseInWorker('seq 1', 1);
    void client.parseInWorker('seq 9', 2); // the same text waits once, keeping its best priority
    assert.deepEqual(client.queuedOrder(), ['seq 9', 'seq 3', 'seq 1']);
    client.prioritize('seq 1');
    assert.deepEqual(client.queuedOrder(), ['seq 1', 'seq 9', 'seq 3']);
  } finally {
    (globalThis as { Worker?: unknown }).Worker = saved;
  }
});

test('no dangerouslySetInnerHTML or innerHTML anywhere in the room UI', () => {
  const root = join(import.meta.dirname, '..', 'src', 'rooms');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }))
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (/\.(tsx?|jsx?)$/.test(entry.name)) files.push(join(dir, entry.name));
  };
  walk(root);
  for (const file of files)
    assert.doesNotMatch(
      readFileSync(file, 'utf8'),
      /dangerouslySetInnerHTML|\.innerHTML\s*=/,
      file,
    );
});

// Each of these overflowed the stack or took seconds before the guard.
const PATHOLOGICAL: Record<string, string> = {
  'quotes 16k': `${'>'.repeat(16_000)} x`,
  'quotes 5k': `${'>'.repeat(5_000)} x`,
  'list markers 4k': `${'- '.repeat(4_000)}x`,
  'emphasis 8k': `${'*'.repeat(8_000)}a${'*'.repeat(8_000)}`,
};

test('pathological nesting and delimiter runs fall back to plain text, fast', () => {
  for (const [name, input] of Object.entries(PATHOLOGICAL)) {
    assert.equal(tooComplexForMarkdown(input), true, name);
    const started = performance.now();
    const out = html(input);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 100, `${name} took ${elapsed.toFixed(1)} ms`);
    assert.match(out, /data-markdown="plain"/, name);
    assert.doesNotMatch(out, /<blockquote|<ul|<em|<strong/, name);
  }
});

test('the guard is linear and leaves ordinary Markdown alone', () => {
  for (const ok of [
    '> quote\n> > nested\n\n- a\n  - b\n    - c',
    '**bold** _em_ ~~del~~ [link](https://example.com)',
    `${'> '.repeat(30)}deep`,
    '```\n' + '*'.repeat(60) + '\n```',
  ])
    assert.equal(tooComplexForMarkdown(ok), false, ok);
  assert.equal(tooComplexForMarkdown(`${'> '.repeat(33)}x`), true);
  assert.equal(tooComplexForMarkdown(`${'1. '.repeat(33)}x`), true);
  assert.equal(tooComplexForMarkdown('_'.repeat(65)), true);
  assert.equal(tooComplexForMarkdown('[a] '.repeat(1_001)), true, 'total delimiter cap');
  const big = 'x*'.repeat(8_000);
  const started = performance.now();
  tooComplexForMarkdown(big);
  assert.ok(performance.now() - started < 20);
});

test('deep but allowed trees render without recursion past the depth cap', () => {
  // 30 levels of quotes is under the guard; rendering flattens below MAX_DEPTH iteratively.
  const out = html(`${'> '.repeat(30)}deep`);
  assert.ok(out.includes('deep'));
  assert.ok((out.match(/<blockquote>/g) ?? []).length <= 26);
  const node = parseMarkdown(`${'> '.repeat(30)}deep`);
  assert.equal(textOf(node), 'deep');
});

test('links show the real host when their text names another, and drop user:pass@ (P3)', () => {
  const spoof = html('[https://centralcity.ai](https://user:pw@evil.example/x)');
  assert.match(spoof, /<a href="https:\/\/evil\.example\/x" title="https:\/\/evil\.example\/x"/);
  assert.doesNotMatch(spoof, /user|pw@/);
  assert.match(spoof, /<span class="md-link-host"> \(evil\.example\)<\/span>/);
  // Named links show their host; a bare URL or matching text does not repeat it.
  assert.match(
    html('[the docs](https://centralcity.ai/docs)'),
    /md-link-host"> \(centralcity\.ai\)/,
  );
  assert.doesNotMatch(html('https://centralcity.ai/docs'), /md-link-host/);
  assert.doesNotMatch(html('[centralcity.ai/docs](https://centralcity.ai/docs)'), /md-link-host/);
  assert.equal(textShowsHost('https://centralcity.ai.evil.example', 'centralcity.ai'), false);
  assert.equal(textShowsHost('www.example.com/a', 'example.com'), true);
  assert.equal(safeHref('https://a:b@example.com/p'), 'https://example.com/p');
});

test('bidi override and isolate controls are removed (P3)', () => {
  const out = html('safe ‮txt.exe‬ and ⁦x⁩ `a‮b`');
  assert.doesNotMatch(out, /[‪-‮⁦-⁩]/);
  assert.equal(withoutBidiControls('a‮b⁧c'), 'abc');
});

test('text past 64 KB is marked "(message truncated)" (P3)', () => {
  assert.match(html(`${'word '.repeat(14_000)}`), /\(message truncated\)/);
  assert.doesNotMatch(html('short'), /truncated/);
});

test('the guard skips fenced code (snake_case code never forces plain text) and stays linear', () => {
  const code = [
    '```py',
    ...Array.from({ length: 400 }, () => 'a_b = c_d * e_f  # [x]'),
    '```',
  ].join('\n');
  assert.equal(tooComplexForMarkdown(code), false);
  assert.equal(tooComplexForMarkdown(`${code}\n${'_a'.repeat(1_001)}`), true);
  for (const input of [' '.repeat(16_384), `${' '.repeat(16_000)}\`\`\``, '\n'.repeat(16_384)]) {
    const started = performance.now();
    tooComplexForMarkdown(input);
    assert.ok(performance.now() - started < 20, 'linear');
  }
});

// A line the guard took for a fence (```a` is not one) hid the rest.
const FENCE_BYPASS: Record<string, string> = {
  'list markers after ```a`': '```a`\n' + '- '.repeat(8_000) + 'x',
  'emphasis after ```a`': '```a`\n' + '*'.repeat(8_000) + 'a' + '*'.repeat(8_000),
  'quotes after ```a`': '```a`\n' + '>'.repeat(16_000) + ' x',
  'list markers inside a real fence': '```\n' + '- '.repeat(8_000) + 'x',
  'emphasis inside an unclosed ~~~ fence': '~~~ a\n' + '*'.repeat(8_000) + 'a',
};

test('nesting and run checks apply inside fences too; the fence bypass falls back fast', () => {
  for (const [name, input] of Object.entries(FENCE_BYPASS)) {
    assert.equal(tooComplexForMarkdown(input), true, name);
    const started = performance.now();
    const out = html(input);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 100, `${name} took ${elapsed.toFixed(1)} ms`);
    assert.match(out, /data-markdown="plain"/, name);
  }
});

test('code fences follow CommonMark exactly (for the delimiter total only)', () => {
  assert.deepEqual(openingFence('```ts'), { char: '`', length: 3 });
  assert.deepEqual(openingFence('   ~~~~ info `with` ticks'), { char: '~', length: 4 });
  assert.equal(openingFence('```a`'), null, 'a backtick fence info string has no backtick');
  assert.equal(openingFence('    ```'), null, 'four spaces is indented code');
  assert.equal(openingFence('``'), null);
  assert.equal(closesFence('```', { char: '`', length: 3 }), true);
  assert.equal(closesFence('````  ', { char: '`', length: 3 }), true);
  assert.equal(closesFence('``', { char: '`', length: 3 }), false, 'shorter');
  assert.equal(closesFence('``` ts', { char: '`', length: 3 }), false, 'closing has no info');
  assert.equal(closesFence('~~~', { char: '`', length: 3 }), false, 'other character');
  // Delimiters hidden after a non-fence line still count.
  assert.equal(tooComplexForMarkdown('```a`\n' + '_a'.repeat(1_001)), true);
  // Real code is still exempt from the total.
  assert.equal(tooComplexForMarkdown('```\n' + 'a_b '.repeat(1_500) + '\n```'), false);
});

test('bidi marks (LRM, RLM, ALM) are removed too', () => {
  assert.equal(withoutBidiControls('a‎b‏c؜d'), 'abcd');
});

test('the worker client: a parse over budget terminates the worker and falls back to plain', async () => {
  const workers: FakeWorker[] = [];
  class FakeWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    terminated = false;
    constructor() {
      workers.push(this);
      setTimeout(() => this.onmessage?.({ data: { ready: true } }), 1);
    }
    postMessage(message: { id: number; text: string }) {
      // 'hang' never answers (a parser worst case); anything else answers at once.
      if (message.text === 'hang') return;
      setTimeout(
        () => this.onmessage?.({ data: { id: message.id, result: parseSafely(message.text) } }),
        1,
      );
    }
    terminate() {
      this.terminated = true;
    }
  }
  const saved = (globalThis as { Worker?: unknown }).Worker;
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;
  try {
    const { parseInWorker, PARSE_BUDGET_MS } =
      await import('../src/rooms/markdown/workerClient.js');
    const started = performance.now();
    const [hung, after] = await Promise.all([parseInWorker('hang'), parseInWorker('**ok**')]);
    assert.deepEqual(hung, { plain: true });
    assert.ok(performance.now() - started < PARSE_BUDGET_MS + 150);
    assert.equal(workers[0]!.terminated, true, 'the hung worker was terminated');
    assert.ok('tree' in after, 'the next parse ran on a fresh worker');
    assert.equal(workers.length, 2);
    // Cached: no new request for the same text.
    assert.deepEqual(await parseInWorker('**ok**'), after);
  } finally {
    (globalThis as { Worker?: unknown }).Worker = saved;
  }
});
