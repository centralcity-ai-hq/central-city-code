// Writes the software bill of materials of the build (CCA-410): a CycloneDX 1.5 JSON document of
// every package in pnpm-lock.yaml, with its exact version, package URL and the lockfile's SHA-512
// integrity. Packages the production dependencies reach are scope "required"; build and test
// tools are "excluded" (never in the deployed bundle). The document names the source commit when
// the build knows it (VERCEL_GIT_COMMIT_SHA or GITHUB_SHA). No timestamp: the same lockfile and
// commit always give the same bytes. Node built-ins only.
//   node scripts/sbom.mjs [output file]   (pnpm build writes dist/sbom.cdx.json)
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const unquote = (text) => text.replace(/^'(.*)'$/, '$1');
/** `name@version(peers…)` → [name, version]: the last '@' not at the start splits them. */
function splitKey(key) {
  const base = key.replace(/\(.*$/, '');
  const at = base.lastIndexOf('@');
  return [base.slice(0, at), base.slice(at + 1)];
}

/** The pnpm v9 lockfile's packages, snapshots and root importer, read line by line. */
export function readLockfile(text) {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const packages = new Map(); // name@version -> integrity
  const snapshots = new Map(); // key with peers -> [dependency keys]
  const roots = []; // the root importer's production dependency keys
  let section = '';
  let key = '';
  let group = '';
  let rootDep = '';
  for (const line of lines) {
    if (/^\S/.test(line)) {
      section = line.replace(/:.*$/, '');
      continue;
    }
    if (section === 'packages') {
      const head = /^ {2}(\S.*):$/.exec(line);
      if (head) key = unquote(head[1]);
      const integrity = /^ {4}resolution: \{.*integrity: ([^,}\s]+)/.exec(line);
      if (integrity && key) packages.set(key, integrity[1]);
    } else if (section === 'snapshots') {
      const head = /^ {2}(\S.*?):( \{\})?$/.exec(line);
      if (head) {
        key = unquote(head[1]);
        snapshots.set(key, []);
        group = '';
        continue;
      }
      const sub = /^ {4}(\w+):$/.exec(line);
      if (sub) group = sub[1];
      const dep = /^ {6}(\S+): (\S+)$/.exec(line);
      if (dep && (group === 'dependencies' || group === 'optionalDependencies'))
        snapshots.get(key).push(`${unquote(dep[1])}@${dep[2]}`);
    } else if (section === 'importers') {
      if (/^ {2}\S/.test(line)) group = line.trim() === '.:' ? 'root' : 'other';
      const sub = /^ {4}(\w+):$/.exec(line);
      if (sub && group !== 'other') group = `root:${sub[1]}`;
      const dep = /^ {6}(\S+):$/.exec(line);
      if (dep) rootDep = unquote(dep[1]);
      const version = /^ {8}version: (\S+)$/.exec(line);
      if (version && ['root:dependencies', 'root:optionalDependencies'].includes(group))
        roots.push(`${rootDep}@${version[1]}`);
    }
  }
  return { packages, snapshots, roots };
}

/** Every name@version the production dependencies reach. */
export function productionClosure({ snapshots, roots }) {
  const seen = new Set();
  const reached = new Set();
  const queue = [...roots];
  while (queue.length) {
    const next = queue.pop();
    if (seen.has(next)) continue;
    seen.add(next);
    const [name, version] = splitKey(next);
    reached.add(`${name}@${version}`);
    queue.push(...(snapshots.get(next) ?? []));
  }
  return reached;
}

const purl = (name, version) =>
  `pkg:npm/${name.startsWith('@') ? `%40${name.slice(1)}` : name}@${version}`;

/** The CycloneDX document for a lockfile and the application's package.json. */
export function sbom(lockText, pkg, commit) {
  const lock = readLockfile(lockText);
  const production = productionClosure(lock);
  const components = [...lock.packages.entries()]
    .map(([key, integrity]) => {
      const [name, version] = splitKey(key);
      const [alg, base64] = integrity.split('-');
      return {
        type: 'library',
        'bom-ref': purl(name, version),
        name,
        version,
        purl: purl(name, version),
        scope: production.has(key) ? 'required' : 'excluded',
        ...(alg === 'sha512' && base64
          ? {
              hashes: [{ alg: 'SHA-512', content: Buffer.from(base64, 'base64').toString('hex') }],
            }
          : {}),
      };
    })
    .sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref']));
  const digest = createHash('sha256')
    .update(`${pkg.name}@${pkg.version}\n${commit ?? ''}\n${lockText}`)
    .digest('hex');
  const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${uuid}`,
    version: 1,
    metadata: {
      component: {
        type: 'application',
        'bom-ref': `pkg:npm/${pkg.name}@${pkg.version}`,
        name: pkg.name,
        version: pkg.version,
        licenses: [{ license: { id: pkg.license } }],
        ...(commit ? { properties: [{ name: 'vcs:commit', value: commit }] } : {}),
      },
    },
    components,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = new URL('..', import.meta.url);
  const commit = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || undefined;
  const document = sbom(
    readFileSync(new URL('pnpm-lock.yaml', root), 'utf8'),
    JSON.parse(readFileSync(new URL('package.json', root), 'utf8')),
    commit && /^[0-9a-f]{40}$/.test(commit) ? commit : undefined,
  );
  const out = `${JSON.stringify(document, null, 2)}\n`;
  if (process.argv[2]) writeFileSync(process.argv[2], out);
  else process.stdout.write(out);
}
