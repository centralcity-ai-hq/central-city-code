import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
// @ts-expect-error plain ESM script without types
import { readLockfile, sbom } from '../scripts/sbom.mjs';

/*
 * CCA-410: every build publishes a software bill of materials (dist/sbom.cdx.json, served at
 * /sbom.cdx.json) generated from pnpm-lock.yaml.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const lock = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string;
  version: string;
  scripts: Record<string, string>;
};
type Component = {
  name: string;
  version: string;
  purl: string;
  scope: string;
  hashes?: { alg: string; content: string }[];
};

test('the SBOM lists every locked package with its version, purl, hash and scope', () => {
  const commit = 'a'.repeat(40);
  const document = sbom(lock, pkg, commit) as {
    bomFormat: string;
    specVersion: string;
    serialNumber: string;
    metadata: { component: { name: string; version: string; properties: unknown[] } };
    components: Component[];
  };
  assert.equal(document.bomFormat, 'CycloneDX');
  assert.equal(document.specVersion, '1.5');
  assert.match(
    document.serialNumber,
    /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(document.metadata.component.name, pkg.name);
  assert.equal(document.metadata.component.version, pkg.version);
  assert.deepEqual(document.metadata.component.properties, [{ name: 'vcs:commit', value: commit }]);
  const { packages } = readLockfile(lock) as { packages: Map<string, string> };
  assert.equal(document.components.length, packages.size);
  for (const component of document.components) {
    assert.ok(
      component.purl.startsWith('pkg:npm/') && component.purl.endsWith(`@${component.version}`),
    );
    assert.equal(component.hashes?.[0]?.alg, 'SHA-512', component.name);
    assert.match(component.hashes![0]!.content, /^[0-9a-f]{128}$/);
  }
  const scope = (name: string) =>
    document.components.filter((component) => component.name === name).map((c) => c.scope);
  // Production dependencies and what they reach are required; build and test tools are not.
  for (const name of ['fastify', 'zod', 'viem', 'pg', 'fast-uri', '@fastify/cookie'])
    assert.ok(scope(name).length && scope(name).every((s) => s === 'required'), name);
  for (const name of ['solc', 'tmp', 'vite', 'esbuild', '@playwright/test', 'prettier', 'tsx'])
    assert.ok(scope(name).length && scope(name).every((s) => s === 'excluded'), name);
  // The same inputs give the same document.
  assert.deepEqual(sbom(lock, pkg, commit), document);
  assert.notEqual(
    (sbom(lock, pkg, undefined) as { serialNumber: string }).serialNumber,
    document.serialNumber,
  );
});

test('pnpm build writes the SBOM into the published files', () => {
  assert.match(pkg.scripts.build!, /&& node scripts\/sbom\.mjs dist\/sbom\.cdx\.json$/);
  const run = spawnSync(process.execPath, ['scripts/sbom.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, GITHUB_SHA: 'not-a-sha' },
  });
  assert.equal(run.status, 0, run.stderr);
  const printed = JSON.parse(run.stdout) as { metadata: { component: { properties?: unknown } } };
  assert.equal(printed.metadata.component.properties, undefined, 'only a real commit id is named');
});
