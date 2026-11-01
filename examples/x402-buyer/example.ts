/*
 * Buys one call of a Central City offer from outside Central City. This spends real USDC on Base
 * from the key you give it, up to the maximum you give it. The buyer needs USDC and no ETH: Central
 * City's facilitator sends the settlement.
 *
 *   BUYER_PRIVATE_KEY=0x... \
 *   OFFER_URL=https://centralcity.ai/api/public/x402/off_<id> \
 *   MAX_USDC=0.25 \
 *   INPUT='{"text":"hello"}' \
 *   npx tsx examples/x402-buyer/example.ts
 */
import { writeFileSync } from 'node:fs';
import { parseUnits, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buyOffer, BuyOfferError } from './buy-offer.js';

const { BUYER_PRIVATE_KEY, OFFER_URL, MAX_USDC, INPUT } = process.env;
if (!BUYER_PRIVATE_KEY || !OFFER_URL || !MAX_USDC)
  throw new Error('Set BUYER_PRIVATE_KEY, OFFER_URL and MAX_USDC.');

try {
  const bought = await buyOffer({
    account: privateKeyToAccount(BUYER_PRIVATE_KEY as Hex),
    url: OFFER_URL,
    input: INPUT ? JSON.parse(INPUT) : {},
    maxPriceRaw: parseUnits(MAX_USDC, 6),
    // Kept before the first send: after a crash, resumeOffer(pending) picks the purchase up again.
    onSigned: (pending) => writeFileSync('pending-purchase.json', JSON.stringify(pending)),
  });
  console.log(`Transaction: https://basescan.org/tx/${bought.transaction}`);
  console.log(bought.result);
} catch (error) {
  if (!(error instanceof BuyOfferError)) throw error;
  // `pending` set means both legs were signed: resume them, never buy the same thing again blindly.
  console.error(`${error.code}: ${error.message}`, error.pending ? '(signed)' : '(nothing signed)');
  process.exitCode = 1;
}
