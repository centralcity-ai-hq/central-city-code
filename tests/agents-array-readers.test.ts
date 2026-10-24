import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY, PERMANENT } from './agents-array-readers.baseline.js';

/**
 * Agents as rows (server/agent-rows/schema.ts): once a workspace stores its agents one row each,
 * its document no longer carries them, so every reader of `data->'agents'` must go through
 * workspace_agents(), workspace_agent() or workspace_document(), which answer the same in both
 * storage modes. This guard counts the places that still read the agents array (or the whole
 * document) directly, per file and rule, against tests/agents-array-readers.baseline.ts:
 *
 * - a new direct reader fails (use the read functions instead);
 * - a reader moved to the functions fails until its baseline count is lowered, so the count only
 *   goes down;
 * - only server/agent-rows/schema.ts writes the agent rows tables.
 *
 * PERMANENT entries are migrations and the backup (they read documents on purpose); LEGACY entries
 * are the readers still to move.
 */
const root = fileURLToPath(new URL('..', import.meta.url));

export const RULES = {
  json: /(?:->>?|#>>?)\s*'\{?agents\b/g,
  path: /'\{agents[,}]|\$\.agents\b/g,
  docHelpers: /\b(?:counted_agent_ids_of|count_log_backfill_pending)\s*\(/g,
  wholeDocument:
    /SELECT\s+(?:[\w.]+(?:\s+AS\s+\w+)?\s*,\s*)*(?:\w+\.)?data\b(?!\s*(?:->|#>|\?|::))[\s\S]{0,200}?\bFROM\s+workspaces\b/gi,
  tsAgents: /\b(?:workspace|ws|own|other|bucket|target|from|to)\.agents\b|\bdata\.agents\b/g,
  storageWrites:
    /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:agents|workspace_storage|agent_rows_precopy|agent_rows_control)\b/gi,
} as const;
export type Rule = keyof typeof RULES;

/** The only file that writes the agent rows tables. */
const STORAGE_WRITER = 'server/agent-rows/schema.ts';
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'tests']);

function walk(dir: string, accept: (path: string) => boolean, out: string[]) {
  for (const name of readdirSync(join(root, dir))) {
    const path = dir ? `${dir}/${name}` : name;
    if (SKIPPED_DIRS.has(name) || path === 'api/_bundle') continue;
    const stat = statSync(join(root, path));
    if (stat.isDirectory()) walk(path, accept, out);
    else if (accept(path)) out.push(path);
  }
}

export function scannedFiles(): string[] {
  const files: string[] = [];
  walk('server', (path) => path.endsWith('.ts'), files);
  walk('scripts', (path) => /\.(?:ts|mjs|sql)$/.test(path), files);
  for (const name of readdirSync(join(root, 'api')))
    if (name.endsWith('.ts') && statSync(join(root, 'api', name)).isFile())
      files.push(`api/${name}`);
  return files.map((path) => relative(root, join(root, path)).split(sep).join('/')).sort();
}

export interface Hit {
  file: string;
  rule: Rule;
  line: number;
  snippet: string;
}

export function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const file of scannedFiles()) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const [rule, pattern] of Object.entries(RULES) as Array<[Rule, RegExp]>)
      for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
        const at = match.index ?? 0;
        const line = text.slice(0, at).split('\n').length;
        hits.push({ file, rule, line, snippet: text.split('\n')[line - 1]!.trim().slice(0, 160) });
      }
  }
  return hits;
}

type Baseline = Record<string, Partial<Record<Rule, number>>>;

test('the baselines name existing files, known rules and positive counts, once each', () => {
  const files = new Set(scannedFiles());
  for (const [name, baseline] of [
    ['PERMANENT', PERMANENT],
    ['LEGACY', LEGACY],
  ] as Array<[string, Baseline]>)
    for (const [file, counts] of Object.entries(baseline)) {
      assert.ok(files.has(file), `${name} names ${file}, which is not scanned (moved or deleted?)`);
      for (const [rule, count] of Object.entries(counts)) {
        assert.ok(
          rule in RULES && rule !== 'storageWrites',
          `${name} ${file}: unknown rule ${rule}`,
        );
        assert.ok(Number.isInteger(count) && count! > 0, `${name} ${file} ${rule}: remove a zero`);
      }
    }
  for (const file of Object.keys(LEGACY))
    assert.ok(!(file in PERMANENT), `${file} is both PERMANENT and LEGACY`);
});

test('only the agent rows schema writes the agent rows tables', () => {
  const writes = scan().filter(
    (hit) => hit.rule === 'storageWrites' && hit.file !== STORAGE_WRITER,
  );
  assert.deepEqual(
    writes.map((hit) => `${hit.file}:${hit.line}  ${hit.snippet}`),
    [],
    `Only ${STORAGE_WRITER} writes agents, workspace_storage, agent_rows_precopy and agent_rows_control.`,
  );
});

test('no new direct reader of the agents array, and the baseline only goes down', () => {
  const found = new Map<string, Hit[]>();
  for (const hit of scan()) {
    if (hit.rule === 'storageWrites') continue;
    const key = `${hit.file}\0${hit.rule}`;
    found.set(key, [...(found.get(key) ?? []), hit]);
  }
  const allowed = new Map<string, number>();
  for (const baseline of [PERMANENT, LEGACY] as Baseline[])
    for (const [file, counts] of Object.entries(baseline))
      for (const [rule, count] of Object.entries(counts)) allowed.set(`${file}\0${rule}`, count!);
  const problems: string[] = [];
  for (const key of new Set([...found.keys(), ...allowed.keys()])) {
    const [file, rule] = key.split('\0') as [string, Rule];
    const hits = found.get(key) ?? [];
    const limit = allowed.get(key) ?? 0;
    if (hits.length > limit)
      problems.push(
        `${file} ${rule}: ${hits.length} direct reads of the agents array, ${limit} allowed. Read ` +
          `agents through workspace_agents(), workspace_agent() or workspace_document() ` +
          `(server/agent-rows/schema.ts) instead:\n` +
          hits.map((hit) => `    ${hit.file}:${hit.line}  ${hit.snippet}`).join('\n'),
      );
    else if (hits.length < limit)
      problems.push(
        `${file} ${rule}: ${hits.length} found, ${limit} allowed. Lower its count in ` +
          `tests/agents-array-readers.baseline.ts to ${hits.length}${hits.length ? '' : ' (remove the entry)'}.`,
      );
  }
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
});
