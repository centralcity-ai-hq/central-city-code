// Serves contracts/deploy-kit on http://127.0.0.1:8790 with Node built-ins only (no packages to
// fetch, nothing unpinned): only deploy.html, deploy-arc.html, keccak.js, guard.js, arc-guard.js,
// router.json, router2.json, router3.json and arc-mainnet.json, never another file.
//   node scripts/protocol/serve-deploy-kit.mjs   then open http://127.0.0.1:8790/deploy.html
//   (Arc mainnet: http://127.0.0.1:8790/deploy-arc.html)
// One origin only: the deploy-once latch lives in that origin's storage, so a request under any
// other host name (localhost included) is refused.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const root = new URL('../../contracts/deploy-kit/', import.meta.url);
const HOST = '127.0.0.1:8790';
const FILES = {
  '/': ['deploy.html', 'text/html; charset=utf-8'],
  '/deploy.html': ['deploy.html', 'text/html; charset=utf-8'],
  '/deploy-arc.html': ['deploy-arc.html', 'text/html; charset=utf-8'],
  '/keccak.js': ['keccak.js', 'text/javascript; charset=utf-8'],
  '/guard.js': ['guard.js', 'text/javascript; charset=utf-8'],
  '/arc-guard.js': ['arc-guard.js', 'text/javascript; charset=utf-8'],
  '/arc-mainnet.json': ['arc-mainnet.json', 'application/json'],
  '/router.json': ['router.json', 'application/json'],
  '/router2.json': ['router2.json', 'application/json'],
  '/router3.json': ['router3.json', 'application/json'],
};
createServer((req, res) => {
  if (req.headers.host !== HOST) {
    res.writeHead(421, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`open http://${HOST}/deploy.html`);
    return;
  }
  const entry = FILES[new URL(req.url, `http://${HOST}`).pathname];
  if (!entry || req.method !== 'GET') {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': entry[1], 'cache-control': 'no-store' });
  res.end(readFileSync(new URL(entry[0], root)));
}).listen(8790, '127.0.0.1', () => console.log(`deploy kit: http://${HOST}/deploy.html`));
