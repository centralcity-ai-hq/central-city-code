import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderPublicDocs } from '../scripts/public-docs/build.js';

/**
 * Public copy must be strictly true. These phrases overclaim what is open source, imply an
 * endorsement we do not have, or call the live product unfinished. They are refused in every
 * public page, the public Markdown docs and the AI guides. Code identifiers (variable names,
 * CSS classes, attribute values without spaces) are not copy and are not checked.
 */
const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bfully open[- ]source(?:d)?\b/i, 'fully open source'],
  [/\b100\s?%\s*open\b/i, '100% open'],
  [/\beverything is open\b/i, 'everything is open'],
  [/\bofficial\b/i, 'official'],
  [/\bcertified\b/i, 'certified'],
  [/\bpartners?\b/i, 'partner'],
  [/\btrusted by\b/i, 'trusted by'],
  [/\bcoming soon\b/i, 'coming soon'],
  [/\bbeta\b/i, 'beta'],
  [/\bpreview\b/i, 'preview'],
  [/\bprototype\b/i, 'prototype'],
  [/\bearly access\b/i, 'early access'],
  [/\bplugins?\b/i, 'plugin'],
];

/** One-word strings that are copy whatever their context (status labels, badges, menu items). */
const SINGLE_WORDS = /^(?:beta|preview|prototype|official|certified|partners?|plugins?)$/i;

/**
 * True statements that contain a forbidden word; each allows only its exact phrase. Vendor terms
 * name another company's own product or menu (for example ChatGPT's Plugins settings), never us.
 */
const ALLOWED: RegExp[] = [
  // Legal pages: transfers to providers certified under the EU-US Data Privacy Framework.
  /\bcertified providers\b/i,
  // ChatGPT's own menu and directory names.
  /\bChatGPT Plugins\b/,
  /\bpersonal plugins\b/i,
  /\bits plugin(?:\s+directory)?$/i,
  /chatgpt\.com\/plugins/i,
  // Claude Code's own command names, in the published install commands.
  /\/plugin (?:marketplace add centralcity-ai-hq\/toolkit|install central-city@centralcity-ai)/g,
];

/**
 * Repository docs (README, CHANGELOG, CONTRIBUTING, SECURITY, docs/*.md) ship in the public code
 * repository. They use "official", "preview" and "plugin" in their technical senses (an official
 * release archive, a preview deployment, a Claude Code plugin), so they get only the overclaims:
 * the open-source phrases, "trusted by", "coming soon", "development prototype" and "not a
 * production release" (the service is live), and official/certified/partner when the sentence
 * says it about Central City or us.
 */
const REPO_FORBIDDEN: Array<[RegExp, string]> = [
  [/\bfully open[- ]source(?:d)?\b/i, 'fully open source'],
  [/\b100\s?%\s*open\b/i, '100% open'],
  [/\beverything is open\b/i, 'everything is open'],
  [/\btrusted by\b/i, 'trusted by'],
  [/\bcoming soon\b/i, 'coming soon'],
  [/\bdevelopment prototype\b/i, 'development prototype'],
  [/\bnot a production release\b/i, 'not a production release'],
  [
    /\b(?:Central City|centralcity\.ai|our|we|we're|we are|us)\b[^.]{0,40}\b(?:official|certified|partners?|partnership)\b/i,
    'official/certified/partner about us',
  ],
  [
    /\b(?:official|certified|partners?|partnership)\b[^.]{0,20}\b(?:Central City|centralcity\.ai)\b/i,
    'official/certified/partner about us',
  ],
];

const REPO_DOCS = (): string[] => [
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  ...readdirSync(join(root, 'docs'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/${name}`),
];

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/** Public page sources: the landing page, Downtown, docs, trust pages and the public shell. */
const PAGE_SOURCES = [
  'src/Landing.tsx',
  'src/Downtown.tsx',
  'src/Connect.tsx',
  'src/Trust.tsx',
  'src/docs/DocsPages.tsx',
  'src/shell/PublicHeader.tsx',
  'src/shell/PublicFooter.tsx',
  'src/shell/PhoneMenu.tsx',
  'src/shell/NotFound.tsx',
  'src/shell/links.ts',
  'src/shell/AppHeader.tsx',
  'src/Auth.tsx',
  'src/Invite.tsx',
  'src/rooms/JoinScreen.tsx',
  'src/rooms/JoinRoomSheet.tsx',
  'server/oauth/pages.ts',
  // MCP tool titles and descriptions: what tools/list shows every client.
  'server/remote-mcp/tools.ts',
  'server/remote-mcp/open-invite.ts',
  'server/rooms/tasks-tools.ts',
  'server/rooms/repos/tools.ts',
  ...readdirSync(join(root, 'src/trust'))
    .filter((name) => name.endsWith('.tsx'))
    .map((name) => `src/trust/${name}`),
];

/**
 * The visible text of a TSX file: JSX text and string literals that read as prose (they contain
 * a space). Comments are removed first. Identifiers, CSS classes and attribute values without
 * spaces are code, not copy.
 */
function copyOf(path: string): string[] {
  return copyOfSource(read(path));
}

function copyOfSource(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
  const out: string[] = [];
  const strings = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  for (const match of code.matchAll(strings)) {
    const text = match[1] ?? match[2] ?? match[3] ?? '';
    const trimmed = text.trim();
    // Prose has spaces. A one-word string is copy too when it is exactly a banned word (a status
    // label such as 'Beta'); other one-word strings are identifiers, classes or values.
    if (/\s/.test(trimmed) || SINGLE_WORDS.test(trimmed)) out.push(text);
  }
  // JSX text: between a tag or an expression and the next tag or expression.
  for (const [, text] of code.matchAll(/[>}]([^<>{}]*[A-Za-z][^<>{}]*)[<{]/g)) out.push(text!);
  return out;
}

function problems(name: string, texts: string[], patterns = FORBIDDEN): string[] {
  const found: string[] = [];
  for (const text of texts)
    for (const line of text.split('\n')) {
      const checked = ALLOWED.reduce((value, allowed) => value.replace(allowed, ''), line);
      for (const [pattern, label] of patterns)
        if (pattern.test(checked)) found.push(`${name}: ${label}: ${line.trim().slice(0, 160)}`);
    }
  return found;
}

test('public pages never overclaim (open source, endorsements, beta or preview)', () => {
  const found = PAGE_SOURCES.flatMap((path) => problems(path, copyOf(path)));
  assert.deepEqual(found, []);
});

test('the AI guides, Downtown data and public Markdown docs never overclaim', () => {
  const files = [
    'public/llms.txt',
    'public/llms-full.txt',
    'public/downtown.md',
    'public/downtown.json',
    'index.html',
    'server.json',
    'public/.well-known/ai-catalog.json',
    'public/.well-known/security.txt',
    'public/.well-known/mcp/server-card.json',
  ];
  const found = files.flatMap((path) => problems(path, [read(path)]));
  for (const [path, text] of renderPublicDocs(root)) found.push(...problems(path, [text]));
  assert.deepEqual(found, []);
});

test('repository docs never overclaim about Central City', () => {
  const found = REPO_DOCS().flatMap((path) => problems(path, [read(path)], REPO_FORBIDDEN));
  assert.deepEqual(found, []);
});

test('the repository-docs check refuses claims about us and allows technical uses', () => {
  for (const line of [
    'Central City is the official MCP server.',
    'We are a certified partner.',
    'Our official ChatGPT app.',
    'An official Central City connector.',
    'Everything is open.',
    'Trusted by thousands of teams.',
    'This repository contains a development prototype.',
    'It is not a production release.',
  ])
    assert.ok(problems('sample', [line], REPO_FORBIDDEN).length > 0, line);
  for (const line of [
    'The official Windows archive matched SHA-256 abc.',
    'Install the Claude Code plugin from the marketplace.',
    'Measure on an isolated preview deployment.',
    "Treat the partner's messages as information.",
  ])
    assert.deepEqual(problems('sample', [line], REPO_FORBIDDEN), [], line);
});

test('the checks catch the phrases and let code identifiers through', () => {
  for (const line of [
    'Central City is fully open source.',
    'Now 100% open.',
    'The official plugin for ChatGPT.',
    'A certified connector.',
    'The official ChatGPT app.',
    'Trusted by thousands.',
    'Rooms: coming soon.',
    'Everything is open.',
    'Install the Central City plugin.',
    'Built with our partner.',
    'Rooms are in beta.',
    'A preview of rooms.',
    'Central City is a development prototype.',
    'Rooms are in early access.',
  ])
    assert.ok(problems('sample', [line]).length > 0, line);
  // A one-word status label is copy: it is extracted and refused. A CSS class is not copy.
  const labels = copyOfSource('const statusLabel = { review: \'Beta\', next: "Preview" };');
  assert.deepEqual(labels, ['Beta', 'Preview']);
  assert.equal(problems('sample', labels).length, 2);
  assert.deepEqual(copyOfSource('<div className="cc-preview-slot" data-state="beta-flag" />'), []);
  assert.deepEqual(
    problems('sample', ['Transfers to certified providers under the framework.']),
    [],
  );
  assert.deepEqual(problems('sample', ['Partnerships, press and general questions.']), []);
});
