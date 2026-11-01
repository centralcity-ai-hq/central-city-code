import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { btree_gin } from '@electric-sql/pglite/contrib/btree_gin';
import { createApp, signingKeyRequired } from '../server/app.js';
import { loadPlatformSigner, parseSigningKey } from '../server/autonomy/signing.js';
import type { Database } from '../server/database.js';
import { signDetached, verifyDetached, type SigningKey } from '../server/manifest/keys.js';

// Throwaway keys generated per run; nothing here is a deployed key.
function privateJwk(kid?: string): Record<string, unknown> {
  const jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  return kid ? { ...jwk, kid } : { ...jwk };
}
const publicOf = (jwk: Record<string, unknown>) => {
  const { d: _d, ...rest } = jwk;
  return rest;
};
const quiet = () => {};

test('CCA-637: a retired key that reuses the current kid is a configuration error, not dropped', () => {
  // Private JWKs in PREVIOUS: the form every release accepts (CCA-638 adds public-only keys).
  const current = privateJwk('cc-platform');
  const retired = privateJwk('cc-platform');
  assert.throws(
    () =>
      loadPlatformSigner(
        {
          CITY_SIGNING_KEY: JSON.stringify(current),
          CITY_SIGNING_KEY_PREVIOUS: JSON.stringify(retired),
        },
        true,
        quiet,
      ),
    /CITY_SIGNING_KEY_PREVIOUS has kid "cc-platform"/,
  );
  // The same key material listed twice is skipped quietly (a harmless leftover).
  const same = loadPlatformSigner(
    {
      CITY_SIGNING_KEY: JSON.stringify(current),
      CITY_SIGNING_KEY_PREVIOUS: JSON.stringify(current),
    },
    true,
    quiet,
  );
  assert.equal(same.jwks().keys.length, 1);
  // Distinct kids: both published, and a card the retired key signed still verifies.
  const old = privateJwk('cc-platform-2026-09');
  const signer = loadPlatformSigner(
    {
      CITY_SIGNING_KEY: JSON.stringify(current),
      CITY_SIGNING_KEY_PREVIOUS: JSON.stringify(old),
    },
    true,
    quiet,
  );
  const oldSigner = loadPlatformSigner({ CITY_SIGNING_KEY: JSON.stringify(old) }, true, quiet);
  const card = { name: 'Scout' };
  assert.deepEqual(verifyDetached(card, signDetached(card, oldSigner.key!), signer.jwks()), {
    valid: true,
    kid: 'cc-platform-2026-09',
  });
});

test('CCA-638: CITY_SIGNING_KEY_PREVIOUS takes public-only keys and never keeps a private key', () => {
  const current = privateJwk();
  const retired = privateJwk('retired-1');
  const warnings: string[] = [];
  const signer = loadPlatformSigner(
    {
      CITY_SIGNING_KEY: JSON.stringify(current),
      CITY_SIGNING_KEY_PREVIOUS: JSON.stringify(publicOf(retired)),
    },
    true,
    (message) => warnings.push(message),
  );
  assert.equal(warnings.length, 0);
  assert.deepEqual(
    signer.jwks().keys.map((key) => key.kid),
    [signer.key!.kid, 'retired-1'],
  );
  for (const key of signer.previous) assert.equal('privateKey' in key, false);
  // A private key in the slot still loads (existing deployments) but only its public half is
  // kept, with a warning to replace it.
  const legacy = loadPlatformSigner(
    {
      CITY_SIGNING_KEY: JSON.stringify(current),
      CITY_SIGNING_KEY_PREVIOUS: JSON.stringify(retired),
    },
    true,
    (message) => warnings.push(message),
  );
  assert.equal(legacy.previous.length, 1);
  assert.equal('privateKey' in legacy.previous[0]!, false);
  assert.match(warnings.join('\n'), /CITY_SIGNING_KEY_PREVIOUS holds a private key/);
  // Several retired keys as a JSON array, so older checkpoints keep verifying.
  const older = privateJwk('retired-0');
  const both = loadPlatformSigner(
    {
      CITY_SIGNING_KEY: JSON.stringify(current),
      CITY_SIGNING_KEY_PREVIOUS: JSON.stringify([publicOf(retired), publicOf(older)]),
    },
    true,
    quiet,
  );
  assert.deepEqual(
    both.jwks().keys.map((key) => key.kid),
    [both.key!.kid, 'retired-1', 'retired-0'],
  );
  assert.throws(
    () =>
      loadPlatformSigner(
        { CITY_SIGNING_KEY: JSON.stringify(current), CITY_SIGNING_KEY_PREVIOUS: 'x' },
        true,
        quiet,
      ),
    (error: Error) =>
      /CITY_SIGNING_KEY_PREVIOUS/.test(error.message) && !error.message.includes(String(current.d)),
  );
});

test('CCA-635: a pre-published next key is in the JWKS before it signs, so rotation has no gap', () => {
  const current = privateJwk('k-2026-10');
  const upcoming = privateJwk('k-2026-11');
  // Step 1: publish the next key's public half; the current key still signs.
  const before = loadPlatformSigner(
    {
      CITY_SIGNING_KEY: JSON.stringify(current),
      CITY_SIGNING_KEY_NEXT: JSON.stringify(publicOf(upcoming)),
    },
    true,
    quiet,
  );
  assert.equal(before.key!.kid, 'k-2026-10');
  assert.equal(before.next!.kid, 'k-2026-11');
  const cachedJwks = before.jwks();
  assert.deepEqual(
    cachedJwks.keys.map((key) => key.kid),
    ['k-2026-10', 'k-2026-11'],
  );
  // Step 2: the next key becomes current, the old one moves to PREVIOUS.
  const after = loadPlatformSigner(
    {
      CITY_SIGNING_KEY: JSON.stringify(upcoming),
      CITY_SIGNING_KEY_PREVIOUS: JSON.stringify(publicOf(current)),
    },
    true,
    quiet,
  );
  const card = { name: 'Scout' };
  // A verifier still holding the JWKS from step 1 accepts the new signatures.
  assert.equal(verifyDetached(card, signDetached(card, after.key!), cachedJwks).valid, true);
  // A verifier holding the new JWKS still accepts cards signed before the switch.
  assert.equal(verifyDetached(card, signDetached(card, before.key!), after.jwks()).valid, true);
  // The next slot never takes a private key.
  assert.throws(
    () =>
      loadPlatformSigner(
        {
          CITY_SIGNING_KEY: JSON.stringify(current),
          CITY_SIGNING_KEY_NEXT: JSON.stringify(upcoming),
        },
        true,
        quiet,
      ),
    /CITY_SIGNING_KEY_NEXT must be a public Ed25519 JWK/,
  );
});

/**
 * Runs a hosted app on an in-memory database under the given deployment variables (restored after
 * the test) and returns a starter plus a JWKS reader. The rate-limit secret is synthetic.
 */
function hostedDeployment(t: TestContext, env: Record<string, string | undefined>) {
  const names = [
    'CITY_HOSTED',
    'CITY_RATE_LIMIT_KEY',
    'CITY_SIGNING_KEY',
    'VERCEL',
    'VERCEL_ENV',
    'CITY_PREVIEW_DB_ISOLATED',
  ];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  for (const name of names) delete process.env[name];
  // Throwaway rate-limit root generated per run (32+ characters), never a deployed value.
  process.env.CITY_RATE_LIMIT_KEY = randomBytes(24).toString('hex');
  for (const [name, value] of Object.entries(env))
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  const ORIGIN = 'https://city.example.com';
  const start = async (options: { signingKey?: SigningKey | null } = {}) => {
    const pglite = await PGlite.create('memory://', { extensions: { btree_gin } });
    const app = await createApp({
      hosted: {
        databaseUrl: 'postgres://unused.invalid/test',
        publicOrigin: ORIGIN,
        allowedOrigins: [ORIGIN],
      },
      startWorkers: false,
      database: pglite as unknown as Database,
      ...options,
    }).catch(async (error: unknown) => {
      await pglite.close();
      throw error;
    });
    t.after(async () => {
      await app.close();
      await pglite.close().catch(() => {});
    });
    return app;
  };
  const kids = async (app: Awaited<ReturnType<typeof start>>) => {
    const jwks = await app.inject({
      method: 'GET',
      url: '/.well-known/jwks.json',
      headers: { host: 'city.example.com' },
    });
    assert.equal(jwks.statusCode, 200);
    return jwks.json().keys.map((key: { kid: string }) => key.kid) as string[];
  };
  return { start, kids };
}

const REFUSED = /CITY_SIGNING_KEY must be set on a production deployment/;

test('CCA-636: a self-hosted CITY_HOSTED=1 deployment without CITY_SIGNING_KEY refuses to start', async (t) => {
  const { start, kids } = hostedDeployment(t, { CITY_HOSTED: '1' });
  await assert.rejects(start(), REFUSED);
  // With the key set the same deployment starts and serves a non-empty JWKS.
  process.env.CITY_SIGNING_KEY = JSON.stringify(privateJwk('hosted-test'));
  assert.deepEqual(await kids(await start()), ['hosted-test']);
});

test('CCA-636: Vercel production without CITY_SIGNING_KEY refuses to start', async (t) => {
  const { start, kids } = hostedDeployment(t, {
    CITY_HOSTED: '1',
    VERCEL: '1',
    VERCEL_ENV: 'production',
  });
  await assert.rejects(start(), REFUSED);
  process.env.CITY_SIGNING_KEY = JSON.stringify(privateJwk('production-test'));
  assert.deepEqual(await kids(await start()), ['production-test']);
});

test('CCA-636: a Vercel preview without CITY_SIGNING_KEY still starts (unsigned, flagged)', async (t) => {
  // Previews carry CITY_HOSTED=1 too (loadHostedConfig requires it); they are not the public
  // integrity record, so a missing key keeps the flagged unsigned mode instead of refusing.
  const { start, kids } = hostedDeployment(t, {
    CITY_HOSTED: '1',
    VERCEL: '1',
    VERCEL_ENV: 'preview',
    CITY_PREVIEW_DB_ISOLATED: '1',
  });
  assert.deepEqual(await kids(await start()), []);
});

test('CCA-636: on production an injected key or an explicit null still overrides the refusal', async (t) => {
  const { start, kids } = hostedDeployment(t, {
    CITY_HOSTED: '1',
    VERCEL: '1',
    VERCEL_ENV: 'production',
  });
  const injected = parseSigningKey(JSON.stringify(privateJwk('injected-test')));
  assert.deepEqual(await kids(await start({ signingKey: injected })), ['injected-test']);
  assert.deepEqual(await kids(await start({ signingKey: null })), []);
});

test('CCA-636: production requires the signing key; Vercel previews keep starting', () => {
  assert.equal(signingKeyRequired({ VERCEL: '1', VERCEL_ENV: 'production' }), true);
  assert.equal(signingKeyRequired({ CITY_HOSTED: '1' }), true);
  assert.equal(
    signingKeyRequired({ VERCEL: '1', VERCEL_ENV: 'production', CITY_HOSTED: '1' }),
    true,
  );
  assert.equal(signingKeyRequired({ VERCEL: '1', VERCEL_ENV: 'preview', CITY_HOSTED: '1' }), false);
  assert.equal(signingKeyRequired({ VERCEL: '1', VERCEL_ENV: 'development' }), false);
  assert.equal(signingKeyRequired({}), false);
});
