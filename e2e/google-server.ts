import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import { createApp } from '../server/app.js';
import { isClientRoute, shellFor } from '../shared/routes.js';
import {
  FAKE_CLIENT_ID,
  FAKE_CLIENT_SECRET,
  claimsFor,
  fakeGoogle,
  signIdToken,
} from '../tests/fake-google.js';

/*
 * The e2e server for Sign in with Google (e2e/google-signin.spec.ts): the app with
 * CITY_GOOGLE_SIGNIN on and a fake Google injected through createApp options (never through
 * the environment), plus a fake consent page on its own port. The browser is sent to
 * accounts.google.com; the spec reroutes that request to the fake page, which "signs in" a
 * synthetic Google account and redirects back with a code, as Google does. Test-only: it refuses
 * to start on a deployment. Other e2e specs that need a verified Google identity (for example
 * Elric eligibility) can use this server; its other settings come from the environment, like
 * server/index.ts (e.g. CITY_ELRIC=1 in the webServer env).
 */
// Test-only: never on a deployment or with a production database.
if (
  process.env.CITY_HOSTED === '1' ||
  process.env.VERCEL === '1' ||
  process.env.NODE_ENV === 'production' ||
  process.env.DATABASE_URL
)
  throw new Error('The fake-Google e2e server runs only locally, in memory.');
const port = Number(process.env.PORT);
const fakePort = Number(process.env.E2E_GOOGLE_FAKE_PORT);
if (!Number.isInteger(port) || !Number.isInteger(fakePort)) throw new Error('Set the e2e ports.');
const google = fakeGoogle();
const dist = resolve('dist');
const spa = existsSync(resolve(dist, 'index.html'));
const app = await createApp({
  dataDir: 'memory://',
  google: {
    env: {
      CITY_GOOGLE_SIGNIN: '1',
      GOOGLE_OAUTH_CLIENT_ID: FAKE_CLIENT_ID,
      GOOGLE_OAUTH_CLIENT_SECRET: FAKE_CLIENT_SECRET,
    },
    transport: google.transport,
    // One address (127.0.0.1) for every spec that signs in with Google, across the whole run: the
    // production per-address budget (20 starts per 15 minutes) would fail later specs.
    addressLimits: { startsPerAddress: 1000, callbacksPerAddress: 1000 },
  },
  notFound: (request, reply) => {
    const path = request.url.split(/[?#]/)[0]!;
    if (spa && request.method === 'GET' && isClientRoute(path))
      return reply.type('text/html').sendFile(shellFor(path));
    return reply.code(404).send({ error: 'Page not found' });
  },
});
if (spa) await app.register(fastifyStatic, { root: dist, dotfiles: 'deny' });
await app.listen({ host: '127.0.0.1', port });

// The fake consent page: an ID token for the flow's nonce, a code bound to its PKCE challenge.
createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${fakePort}`);
  const nonce = url.searchParams.get('nonce');
  const state = url.searchParams.get('state');
  const challenge = url.searchParams.get('code_challenge');
  const redirect = url.searchParams.get('redirect_uri');
  if (
    url.pathname !== '/authorize' ||
    !nonce ||
    !state ||
    !challenge ||
    redirect !== `http://127.0.0.1:${port}/api/auth/google/callback`
  ) {
    response.writeHead(400).end();
    return;
  }
  // Test-only: a spec that needs its own Google identity passes e2e_subject (digits); the
  // default stays the one synthetic person (a linked identity has a 30-day move cooldown).
  const subject = url.searchParams.get('e2e_subject');
  const own =
    subject && /^\d{1,21}$/.test(subject)
      ? { sub: subject, email: `synthetic.${subject}@example.com` }
      : {};
  const token = signIdToken(google.keys[0]!, claimsFor(nonce, Date.now(), own));
  const code = google.issueCode(token, challenge);
  response
    .writeHead(302, { location: `${redirect}?${new URLSearchParams({ state, code })}` })
    .end();
}).listen(fakePort, '127.0.0.1');
console.log(`Google e2e server at http://127.0.0.1:${port}`);
