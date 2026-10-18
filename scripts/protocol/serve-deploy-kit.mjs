// Serves contracts/deploy-kit on http://127.0.0.1:8790 with Node built-ins only (no packages to
// fetch, nothing unpinned): only deploy.html, keccak.js, router.json and router2.json, never another file.
//   node scripts/protocol/serve-deploy-kit.mjs   then open http://localhost:8790/deploy.html
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const root = new URL('../../contracts/deploy-kit/', import.meta.url);
const FILES = {
  '/': ['deploy.html', 'text/html; charset=utf-8'],
  '/deploy.html': ['deploy.html', 'text/html; charset=utf-8'],
  '/keccak.js': ['keccak.js', 'text/javascript; charset=utf-8'],
  '/router.json': ['router.json', 'application/json'],
  '/router2.json': ['router2.json', 'application/json'],
};
createServer((req, res) => {
  const entry = FILES[new URL(req.url, 'http://localhost').pathname];
  if (!entry || req.method !== 'GET') {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': entry[1], 'cache-control': 'no-store' });
  res.end(readFileSync(new URL(entry[0], root)));
}).listen(8790, '127.0.0.1', () => console.log('deploy kit: http://localhost:8790/deploy.html'));
