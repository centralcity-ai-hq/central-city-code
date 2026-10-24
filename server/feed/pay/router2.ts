/**
 * Fee router 2 switch (docs/protocol/FEE_ROUTER_2.md section 2), in one place for the payment
 * engine and the offer store: live only while protocol fees are on, router 2 is configured
 * (protocolRouter2FromEnv, the parser the ledger uses) and CITY_PROTOCOL_FEE_ROUTER2_ENABLED is
 * exactly '1'.
 */
import { FEE_ROUTER2_FLAG } from '../../../shared/protocol.js';
import { FEE_ROUTER_MAX_TOTAL } from '../../../shared/feed-offers.js';
import { protocolFeesEnabled, protocolRouter2FromEnv } from '../../protocol/fees/cron.js';
import { feeRouter3Live } from './router3.js';

export function feeRouter2Live(env: Record<string, string | undefined>): boolean {
  return (
    env[FEE_ROUTER2_FLAG]?.trim() === '1' &&
    protocolFeesEnabled(env) &&
    protocolRouter2FromEnv(env).length > 0
  );
}

/** Router 2's cap (100 USDC): the most an offer may cost while router 2 is live. */
export const OFFER_PRICE_MAX_ROUTER2_RAW = 100_000_000;

/** The highest offer price allowed now: router 1's cap, or 100 USDC while router 2 or 3 is live. */
export const offerPriceMaxRaw = (env: Record<string, string | undefined>): number =>
  feeRouter2Live(env) || feeRouter3Live(env) ? OFFER_PRICE_MAX_ROUTER2_RAW : FEE_ROUTER_MAX_TOTAL;
