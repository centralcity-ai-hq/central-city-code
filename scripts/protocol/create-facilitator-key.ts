/*
 * Creates the x402 facilitator's EOA key (fee router 3, server/protocol/x402/facilitator.ts)
 * through the existing spender keystore: a random key, encrypted under CITY_BASE_SPENDER_KEK and
 * stored in base_spender_keys. Marked committed at once, so the orphan-key cleanup (an hour for
 * keys no wallet references) never deletes it.
 *
 *   DATABASE_URL=… CITY_BASE_SPENDER_KEK=… pnpm tsx scripts/protocol/create-facilitator-key.ts
 *
 * Prints ONLY the address (fund it with a little ETH for gas) and the opaque keyRef, to be put in
 * env CITY_X402_FACILITATOR_KEY_REF. The key itself never leaves the keystore; nothing else (no
 * database URL, no KEK, no error detail) is printed. Run once; a second run makes a second key.
 */
import { openPostgres } from '../../server/database.js';
import { createKeystore, parseKeks } from '../../server/base/chain/keystore.js';
import { pgSpenderKeyStore } from '../../server/base/chain/stores.js';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set; nothing was created.');
    process.exit(1);
  }
  let keks;
  try {
    keks = parseKeks(process.env.CITY_BASE_SPENDER_KEK);
  } catch {
    console.error('CITY_BASE_SPENDER_KEK is missing or malformed; nothing was created.');
    process.exit(1);
  }
  const db = await openPostgres(url);
  try {
    const store = pgSpenderKeyStore(db);
    const { signer, keyRef } = await createKeystore({ store, keks }).createSpenderKey();
    await store.commit(keyRef);
    console.log(JSON.stringify({ address: signer, keyRef }));
  } finally {
    await db.close();
  }
}

main().catch(() => {
  console.error('Creating the facilitator key failed; check the database and KEK.');
  process.exit(1);
});
