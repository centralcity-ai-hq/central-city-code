// The static-analysis gate of the review repository (CCA-408). Reads the SARIF files CodeQL wrote
// (codeql.yml, `upload: never`: the private repository has no code-scanning upload) and fails
// when any result has the level `error`, after listing every result. Warnings and notes are
// listed but do not fail. Node built-ins only.
//   node scripts/ci/sast-gate.mjs <directory with .sarif files>
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Every result of one SARIF log, with its effective level (result, then rule default). */
export function sarifResults(log) {
  const found = [];
  for (const run of log.runs ?? []) {
    const rules = new Map();
    for (const rule of [
      ...(run.tool?.driver?.rules ?? []),
      ...(run.tool?.extensions ?? []).flatMap((extension) => extension.rules ?? []),
    ])
      rules.set(rule.id, rule);
    for (const result of run.results ?? []) {
      const rule = rules.get(result.ruleId) ?? {};
      const level = result.level ?? rule.defaultConfiguration?.level ?? 'warning';
      const location = result.locations?.[0]?.physicalLocation;
      found.push({
        ruleId: result.ruleId ?? 'unknown',
        level,
        file: location?.artifactLocation?.uri ?? '?',
        line: location?.region?.startLine ?? 0,
        message: String(result.message?.text ?? '')
          .split('\n')[0]
          .slice(0, 200),
      });
    }
  }
  return found;
}

/** The gate over a directory: { results, failing }. Throws when there is no SARIF file at all. */
export function gate(directory) {
  const files = readdirSync(directory).filter((name) => name.endsWith('.sarif'));
  if (!files.length) throw new Error(`no .sarif file in ${directory}`);
  const results = files.flatMap((name) =>
    sarifResults(JSON.parse(readFileSync(join(directory, name), 'utf8'))),
  );
  return { results, failing: results.filter((result) => result.level === 'error') };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const directory = process.argv[2];
  if (!directory) throw new Error('usage: node scripts/ci/sast-gate.mjs <sarif directory>');
  const { results, failing } = gate(directory);
  const lines = results.map(
    (result) => `${result.level} ${result.ruleId} ${result.file}:${result.line} ${result.message}`,
  );
  const summary = `CodeQL: ${results.length} result(s), ${failing.length} at level error.`;
  console.log([summary, ...lines].join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Static analysis\n\n${summary}\n\n${lines.map((line) => `- ${line}`).join('\n')}\n`,
    );
  if (failing.length) process.exitCode = 1;
}
