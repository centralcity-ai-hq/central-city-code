import { ROOM_CREDENTIAL_PATTERN } from './contract.js';

/**
 * Room file checks (docs/ROOMS.md "Room files"): what a file may be, judged from its own bytes,
 * never from what the uploader says. Nothing here executes, imports, renders or unpacks a file:
 * a zip is only listed from its central directory. Every function is pure and bounded.
 */

export type ArtifactKind = 'pdf' | 'image' | 'text' | 'code' | 'zip';

interface FileType {
  kind: ArtifactKind;
  /** What uploaders send (the presigned PUT allows exactly this one). */
  contentType: string;
  /** Leading bytes the content must start with (images, PDF, zip); text is checked as UTF-8. */
  magic?: (bytes: Uint8Array) => boolean;
}

const starts = (prefix: number[]) => (bytes: Uint8Array) =>
  prefix.every((value, index) => bytes[index] === value);
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

const TEXT = 'text/plain; charset=utf-8';
const TEXT_TYPES = ['txt', 'md', 'csv', 'json', 'log', 'yaml', 'yml', 'toml', 'xml'];
// Source code is stored and served as plain text: never as script, HTML or SVG.
const CODE_TYPES = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'go',
  'rs',
  'sol',
  'java',
  'kt',
  'swift',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'rb',
  'php',
  'sh',
  'sql',
  'html',
  'css',
  'scss',
  'vue',
  'svelte',
];

export const FILE_TYPES: Record<string, FileType> = {
  pdf: { kind: 'pdf', contentType: 'application/pdf', magic: starts(ascii('%PDF-')) },
  png: {
    kind: 'image',
    contentType: 'image/png',
    magic: starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  jpg: { kind: 'image', contentType: 'image/jpeg', magic: starts([0xff, 0xd8, 0xff]) },
  jpeg: { kind: 'image', contentType: 'image/jpeg', magic: starts([0xff, 0xd8, 0xff]) },
  gif: { kind: 'image', contentType: 'image/gif', magic: starts(ascii('GIF8')) },
  webp: {
    kind: 'image',
    contentType: 'image/webp',
    magic: (b) => starts(ascii('RIFF'))(b) && starts(ascii('WEBP'))(b.subarray(8)),
  },
  zip: {
    kind: 'zip',
    contentType: 'application/zip',
    magic: (b) => starts([0x50, 0x4b, 0x03, 0x04])(b) || starts([0x50, 0x4b, 0x05, 0x06])(b),
  },
  ...Object.fromEntries(
    TEXT_TYPES.map((ext) => [ext, { kind: 'text' as const, contentType: TEXT }]),
  ),
  ...Object.fromEntries(
    CODE_TYPES.map((ext) => [ext, { kind: 'code' as const, contentType: TEXT }]),
  ),
};

/** The extension of a file name (lower case), or '' without one. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Allowed names: one path segment, no control or invisible characters, a known extension. */
export function checkName(
  name: string,
): { ok: true; type: FileType } | { ok: false; reason: string } {
  const clean = name.trim();
  if (!clean || clean.length > 200)
    return { ok: false, reason: 'A file name is 1 to 200 characters.' };
  if (/[\\/\u0000-\u001f\u007f​-‏‪-‮⁠-⁤﻿]/.test(clean))
    return { ok: false, reason: 'A file name has no slashes, control or invisible characters.' };
  if (clean === '.' || clean === '..' || clean.startsWith('.'))
    return { ok: false, reason: 'A file name does not start with a dot.' };
  const type = FILE_TYPES[extensionOf(clean)];
  if (!type)
    return {
      ok: false,
      reason: `Allowed types: ${Object.keys(FILE_TYPES).join(', ')}.`,
    };
  return { ok: true, type };
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Decoded text when the bytes are valid UTF-8 without NUL; null otherwise. */
export function textOf(bytes: Uint8Array): string | null {
  try {
    const text = utf8.decode(bytes);
    return text.includes('\u0000') ? null : text;
  } catch {
    return null;
  }
}

export const ZIP_LIMITS = { entries: 1000, ratio: 100, nestedZips: 50 } as const;

/**
 * The entry names of a zip, read from its central directory only (nothing is inflated). Refuses
 * archives with too many entries, a total uncompressed size over ZIP_LIMITS.ratio times the
 * archive, unsafe paths (absolute, "..", backslashes) or encrypted entries.
 */
export function zipEntries(
  bytes: Uint8Array,
): { ok: true; names: string[] } | { ok: false; reason: string } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of central directory: the last 22 bytes, plus up to 64 KiB of comment.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i--)
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) return { ok: false, reason: 'Not a readable zip archive.' };
  const count = view.getUint16(eocd + 10, true);
  const size = view.getUint32(eocd + 12, true);
  const offset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || offset === 0xffffffff)
    return { ok: false, reason: 'Zip64 archives are not supported.' };
  if (count > ZIP_LIMITS.entries)
    return { ok: false, reason: `A zip holds at most ${ZIP_LIMITS.entries} entries.` };
  if (offset + size > eocd) return { ok: false, reason: 'Not a readable zip archive.' };
  const names: string[] = [];
  let total = 0;
  let nested = 0;
  let at = offset;
  for (let n = 0; n < count; n++) {
    if (at + 46 > eocd || view.getUint32(at, true) !== 0x02014b50)
      return { ok: false, reason: 'Not a readable zip archive.' };
    const flags = view.getUint16(at + 8, true);
    const uncompressed = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    if (flags & 0x1) return { ok: false, reason: 'Encrypted zip entries are not allowed.' };
    const raw = bytes.subarray(at + 46, at + 46 + nameLength);
    const name = new TextDecoder('utf-8').decode(raw);
    if (
      !name ||
      name.startsWith('/') ||
      name.includes('\\') ||
      /^[a-z]:/i.test(name) ||
      name.split('/').includes('..')
    )
      return { ok: false, reason: 'A zip entry has an unsafe path.' };
    if (extensionOf(name) === 'zip' && ++nested > ZIP_LIMITS.nestedZips)
      return { ok: false, reason: 'Too many nested archives.' };
    total += uncompressed;
    names.push(name);
    at += 46 + nameLength + extraLength + commentLength;
  }
  if (total > Math.max(bytes.length, 1) * ZIP_LIMITS.ratio)
    return { ok: false, reason: 'The zip expands too much (over 100 times its size).' };
  return { ok: true, names };
}

export type CheckResult =
  | { ok: true; kind: ArtifactKind; contentType: string; text: string | null }
  | { ok: false; reason: string };

/**
 * Judges uploaded bytes against the declared name: the type from the extension, the magic bytes
 * or UTF-8 text, a credential scan over any text (and zip entry names), and the zip listing.
 */
export function checkArtifact(name: string, bytes: Uint8Array): CheckResult {
  const named = checkName(name);
  if (!named.ok) return named;
  const { type } = named;
  if (type.magic && !type.magic(bytes))
    return { ok: false, reason: `The content is not a ${extensionOf(name)} file.` };
  let text: string | null = null;
  if (type.kind === 'text' || type.kind === 'code') {
    text = textOf(bytes);
    if (text === null) return { ok: false, reason: 'Text and code files must be UTF-8 text.' };
    if (ROOM_CREDENTIAL_PATTERN.test(text))
      return { ok: false, reason: 'The file looks like it contains a credential.' };
  }
  if (type.kind === 'zip') {
    const listed = zipEntries(bytes);
    if (!listed.ok) return listed;
    if (ROOM_CREDENTIAL_PATTERN.test(listed.names.join('\n')))
      return { ok: false, reason: 'An entry name looks like a credential.' };
    text = listed.names.join('\n');
  }
  return { ok: true, kind: type.kind, contentType: type.contentType, text };
}

/** Lines per stored text page (the AI read path pages by these). */
export const TEXT_PAGE_LINES = 200;
export const TEXT_PAGES_MAX = 2000;

/** Splits text into pages of TEXT_PAGE_LINES lines (bounded); each page stays under 256 KiB. */
export function textPages(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const pages: string[] = [];
  for (let i = 0; i < lines.length && pages.length < TEXT_PAGES_MAX; i += TEXT_PAGE_LINES) {
    let page = lines.slice(i, i + TEXT_PAGE_LINES).join('\n');
    while (Buffer.byteLength(page) > 262_144) page = page.slice(0, Math.floor(page.length * 0.9));
    pages.push(page);
  }
  return pages;
}
