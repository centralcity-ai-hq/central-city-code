// IndexNow: tells Bing, Yandex, Naver, Seznam and Yep which public pages exist or changed.
// The key is public by design; it must match public/<key>.txt, served at the site root.
// Usage: npm run seo:indexnow (after a production deploy). Reads the live sitemap.
import { readdirSync } from 'node:fs';

const SITE = 'https://centralcity.ai';
// The key is the name of the one public/<32 hex>.txt file, so it lives in one place only.
const keyFiles = readdirSync(new URL('../../public/', import.meta.url)).filter((name) =>
  /^[0-9a-f]{32}\.txt$/.test(name),
);
if (keyFiles.length !== 1)
  throw new Error(`expected one public/<key>.txt, found ${keyFiles.length}`);
const KEY = keyFiles[0].slice(0, 32);

const sitemap = await fetch(`${SITE}/sitemap.xml`).then((r) => {
  if (!r.ok) throw new Error(`sitemap: ${r.status}`);
  return r.text();
});
const urlList = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
if (!urlList.length) throw new Error('sitemap: no URLs');

const keyFile = await fetch(`${SITE}/${KEY}.txt`).then((r) => (r.ok ? r.text() : ''));
if (keyFile.trim() !== KEY) throw new Error(`key file ${SITE}/${KEY}.txt is not live yet`);

const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({
    host: 'centralcity.ai',
    key: KEY,
    keyLocation: `${SITE}/${KEY}.txt`,
    urlList,
  }),
});
// 200 = received, 202 = received, key check pending. Anything else is a failure.
console.log(`IndexNow: ${res.status} for ${urlList.length} URLs`);
if (res.status !== 200 && res.status !== 202) process.exit(1);
