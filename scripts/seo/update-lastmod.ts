import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LASTMOD_FILE, refreshLastmodMap } from './lastmod';

// npm run seo:lastmod: refresh scripts/seo/lastmod.json after changing a public page.
const root = fileURLToPath(new URL('../..', import.meta.url));
const map = refreshLastmodMap(root, new Date().toISOString().slice(0, 10));
writeFileSync(join(root, LASTMOD_FILE), `${JSON.stringify(map, null, 2)}\n`);
console.log(`${LASTMOD_FILE}: ${Object.keys(map).length} pages`);
