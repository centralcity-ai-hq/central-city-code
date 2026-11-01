import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import { BASE_MAINNET } from '../shared/base/chains.js';
import { ARC_TESTNET } from '../shared/chains.js';
import { createIdentityService, IdentityServiceError } from '../server/base/identity/service.js';

process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-arc-one-chain-test-root-secret';

const AGENT = '22222222-2222-4222-8222-222222222222';
const ENV = {
  CITY_BASE_MAINNET: '1',
  CITY_ARC: '1',
  CITY_ARC_CHAIN_ID: String(ARC_TESTNET),
  CITY_ARC_SMART_WALLET_FACTORY: '0x00000000000000000000000000000000000000f1',
  CITY_ARC_SPEND_PERMISSION_MANAGER: '0x00000000000000000000000000000000000000f2',
};

test('two advances at once on Base and Arc: one chain wins, the other is told which', async (t) => {
  const app = await createApp({
    database: await PGlite.create('memory://'),
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: 'https://centralcity.ai',
      allowedOrigins: ['https://centralcity.ai'],
    },
    startWorkers: false,
  });
  t.after(() => app.close());
  const db = app.city.db as any;
  // The chain port is never reached: a stop right after the claim shows who got through.
  const stop = new Error('stop');
  const service = createIdentityService({
    db: {
      query: (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM base_wallets'))
          return Promise.resolve({
            rows: [
              {
                operator_id: 'w1',
                address: `0x${'1'.repeat(40)}`,
                spender_address: `0x${'2'.repeat(40)}`,
                spender_key_ref: 'ref',
                state: 'active',
              },
            ],
          });
        return db.query(sql, params);
      },
      transaction: (action: never) => db.transaction(action),
    } as never,
    chain: new Proxy({}, { get: () => () => Promise.reject(stop) }) as never,
    env: ENV,
    log: () => {},
  });
  await db.query(`SET session_replication_role = replica`);
  const results = await Promise.allSettled([
    service.advance(AGENT, BASE_MAINNET),
    service.advance(AGENT, ARC_TESTNET),
  ]);
  const refused = results.filter(
    (r) =>
      r.status === 'rejected' &&
      r.reason instanceof IdentityServiceError &&
      r.reason.code === 'other_chain',
  );
  assert.equal(refused.length, 1, JSON.stringify(results.map((r) => r.status)));
  const { rows } = await db.query('SELECT chain_id FROM base_identities WHERE agent_id = $1', [
    AGENT,
  ]);
  assert.equal(rows.length, 1);
});
