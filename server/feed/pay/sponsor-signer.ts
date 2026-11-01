/**
 * The sponsored first purchase's payment legs (server/feed/pay/sponsor.ts): the two EIP-3009
 * authorizations of a fee router 3 settlement (docs/protocol/FEE_ROUTER_3.md) signed by Central
 * City's sponsor account, a plain EOA whose key lives in the keystore like the facilitator's.
 * USDC (FiatToken v2.2) verifies an EOA's `bytes signature` as ECDSA, so no ERC-1271 wrapper and
 * no deployed account are needed.
 *
 * Same guarantees as the agents' router3Legs (server/base/chain/feed-pay-chain.ts), kept apart so
 * the live agent path is untouched: nonces as the router derives them (router3Nonce), one window
 * for both legs, each leg stored under `<key>:seller` / `<key>:fee` BEFORE it is returned, and a
 * retry gets the stored pair unchanged (window read back from the seller leg). Never a second pair
 * for the same key, never a leg for another payer, payee, value, window or nonce.
 *
 * Because this key moves Central City's own money (room #335), its limits live in the signer itself,
 * whatever the caller asks:
 *   - it signs only for a stored reservation it reads itself (reservationOf, by the key): the
 *     sponsored call row and its credit, both of the same kind, the credit reserved or used, the
 *     call's amount and payee exactly what is asked;
 *   - the price is at most that kind's ceiling: SFP_CREDIT_CEILING_RAW (2 USDC) for a real user,
 *     SFP_FLEET_CREDIT_CEILING_RAW (40 USDC) only for a fleet credit. The kind is the one the server
 *     stored when the credit was reserved (migration 260), never one a caller passes;
 *   - the split is exactly router 3's (quoteFeeIncluded), and the router and its treasury are bound
 *     by configuration (the treasury read from the router once), so a fee leg can never authorize a
 *     transfer to any other address.
 */
import { getAddress, type Hex } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import type { Address, BaseNetwork } from '../../../shared/base/chains.js';
import {
  AuthorizationError,
  transferAuthorizationTypedData,
  type AuthorizationStore,
  type IssuedAuthorization,
  type TransferAuthorization,
} from '../../base/chain/x402.js';
import { quoteFeeIncluded } from '../../protocol/fees/fee-call.js';
import { isReservedPayee, reservedPayees } from '../../../shared/protocol.js';
import type { Database } from '../../database.js';
import { LEG_FEE, LEG_SELLER, router3Nonce } from './router3.js';
import { SFP_CREDIT_CEILING_RAW, SFP_FLEET_CREDIT_CEILING_RAW } from './sponsor.js';

/** A sponsored call and its credit as stored, read by the signer itself (by the call's key). */
export interface SponsorReservation {
  grossRaw: bigint;
  payTo: Address;
  /** The call row's kind and the credit's: both written by the server when it reserved. */
  callFleet: boolean;
  creditFleet: boolean;
  creditAmountRaw: bigint;
  creditState: string;
  /** The buying agent on the call and on the credit, and the credit's chain. */
  callAgentId: string;
  creditAgentId: string;
  creditChainId: number;
}

export interface SponsorSignerDeps {
  network: BaseNetwork;
  keystore: {
    withSigner<T>(ref: string, use: (account: PrivateKeyAccount) => Promise<T>): Promise<T>;
  };
  /** The sponsor's key (CITY_SFP_SPONSOR_KEY_REF) and the address it must sign as. */
  keyRef: string;
  sponsor: Address;
  token: Address;
  store: AuthorizationStore;
  now: () => number;
  /** Router 3 from configuration (CITY_PROTOCOL_FEE_ROUTER3), never from a caller. */
  router: Address;
  /** The router's own treasury, read on chain (its treasury()); read once per signer. */
  treasuryOf: () => Promise<Address>;
  /** The stored reservation behind a key (feed_pay_sponsored_calls.op_key), or null. */
  reservationOf: (key: string) => Promise<SponsorReservation | null>;
  /** The chain's reserved payees (protocolReservedPayees); left out: Base mainnet's. */
  reserved?: ReadonlySet<string>;
}

const sameLeg = (
  stored: IssuedAuthorization,
  chainId: number,
  token: Address,
  want: TransferAuthorization,
) =>
  stored.chainId === chainId &&
  getAddress(stored.token) === getAddress(token) &&
  getAddress(stored.authorization.from) === getAddress(want.from) &&
  getAddress(stored.authorization.to) === getAddress(want.to) &&
  stored.authorization.value === want.value &&
  stored.authorization.validAfter === want.validAfter &&
  stored.authorization.validBefore === want.validBefore &&
  stored.authorization.nonce.toLowerCase() === want.nonce.toLowerCase();

export function createSponsorSigner(deps: SponsorSignerDeps) {
  const chainId = deps.network.chainId;
  const sponsor = getAddress(deps.sponsor) as Address;
  // The router's treasury, read once and kept (a failed read is tried again next time).
  let treasuryRead: Promise<Address> | null = null;
  const treasury$ = () =>
    (treasuryRead ??= deps.treasuryOf().catch((error: unknown) => {
      treasuryRead = null;
      throw error;
    }));

  /** One leg, issued exactly once per id (stored before it is returned). */
  async function issue(id: string, want: TransferAuthorization): Promise<IssuedAuthorization> {
    if (want.value <= 0n || want.value >= 2n ** 256n)
      throw new AuthorizationError('INVALID_AMOUNT', 'Value must be a positive uint256.');
    const existing = await deps.store.get(id);
    if (existing) {
      if (!sameLeg(existing, chainId, deps.token, want))
        throw new AuthorizationError(
          'INVALID_AMOUNT',
          'This leg already has a different authorization.',
        );
      return existing;
    }
    const nowS = BigInt(Math.floor(deps.now() / 1000));
    if (want.validBefore <= want.validAfter || want.validBefore <= nowS)
      throw new AuthorizationError('INVALID_WINDOW', 'The authorization window is empty or over.');
    const typed = transferAuthorizationTypedData(deps.network, deps.token, want);
    const signature: Hex = await deps.keystore.withSigner(deps.keyRef, async (account) => {
      // The key must be the sponsor's own: a wrong key ref never signs for another address.
      if (getAddress(account.address) !== sponsor)
        throw new AuthorizationError(
          'INVALID_AMOUNT',
          'The sponsor key does not match the sponsor address.',
        );
      return account.signTypedData(typed);
    });
    const stored = await deps.store.insert({
      paymentIntentId: id,
      chainId,
      token: getAddress(deps.token) as Address,
      authorization: { ...want, from: sponsor, to: getAddress(want.to) as Address },
      signature,
    });
    if (!sameLeg(stored, chainId, deps.token, want))
      throw new AuthorizationError(
        'INVALID_AMOUNT',
        'This leg already has a different authorization.',
      );
    return stored;
  }

  /** Both legs of one sponsored router 3 purchase: gross - fee to the payee, fee to the treasury. */
  async function router3Legs(input: {
    key: string;
    payee: Address;
    gross: bigint;
    ref: Hex;
    validitySeconds: number;
  }): Promise<{ seller: IssuedAuthorization; fee: IssuedAuthorization }> {
    // Only for a reservation the signer reads itself, and only within its own kind's ceiling.
    const held = await deps.reservationOf(input.key);
    if (
      !held ||
      held.callFleet !== held.creditFleet ||
      held.callAgentId !== held.creditAgentId ||
      held.creditChainId !== chainId ||
      (held.creditState !== 'reserved' && held.creditState !== 'used') ||
      held.grossRaw !== input.gross ||
      held.creditAmountRaw !== input.gross ||
      getAddress(held.payTo) !== getAddress(input.payee)
    )
      throw new AuthorizationError(
        'INVALID_AMOUNT',
        'No matching sponsored reservation for this payment.',
      );
    const ceiling = held.creditFleet ? SFP_FLEET_CREDIT_CEILING_RAW : SFP_CREDIT_CEILING_RAW;
    let split: { fee: bigint; net: bigint };
    try {
      split = quoteFeeIncluded(input.gross, ceiling);
    } catch {
      throw new AuthorizationError(
        'INVALID_AMOUNT',
        held.creditFleet
          ? 'A sponsored fleet price is 0.05 to 40 USDC, fee included.'
          : 'A sponsored price is 0.05 to 2 USDC, fee included.',
      );
    }
    const router = getAddress(deps.router) as Address;
    // A payee no payment may name (a router, the treasury, USDC, the facilitator, zero), nor this
    // router, its token or the sponsor itself: never signed for.
    const payee = input.payee.toLowerCase();
    if (
      isReservedPayee(payee, deps.reserved ?? reservedPayees()) ||
      [router, deps.token, sponsor].some((a) => a.toLowerCase() === payee)
    )
      throw new AuthorizationError('INVALID_AMOUNT', 'This address cannot be paid.');
    const treasury = getAddress(await treasury$()) as Address;
    if (treasury.toLowerCase() === payee)
      throw new AuthorizationError('INVALID_AMOUNT', 'This address cannot be paid.');
    const sellerId = `${input.key}:seller`;
    const earlier = await deps.store.get(sellerId);
    // A used credit (paid) only ever gets back the pair already stored for it, never a new one.
    if (held.creditState === 'used' && (!earlier || !(await deps.store.get(`${input.key}:fee`))))
      throw new AuthorizationError(
        'INVALID_AMOUNT',
        'No matching sponsored reservation for this payment.',
      );
    const at = BigInt(Math.floor(deps.now() / 1000));
    const validAfter = earlier ? earlier.authorization.validAfter : 0n;
    const validBefore = earlier
      ? earlier.authorization.validBefore
      : at + BigInt(input.validitySeconds);
    const leg = (to: Address, value: bigint, which: typeof LEG_SELLER | typeof LEG_FEE) => ({
      from: sponsor,
      to: getAddress(to) as Address,
      value,
      validAfter,
      validBefore,
      nonce: router3Nonce({
        chainId,
        router,
        treasury,
        payer: sponsor,
        payee: input.payee,
        gross: input.gross,
        ref: input.ref,
        validAfter,
        validBefore,
        leg: which,
      }),
    });
    const seller = await issue(sellerId, leg(input.payee, split.net, LEG_SELLER));
    const fee = await issue(`${input.key}:fee`, leg(treasury, split.fee, LEG_FEE));
    return { seller, fee };
  }

  /** The pair stored for a key (never signs), or null when none was issued. */
  async function stored(
    key: string,
  ): Promise<{ seller: IssuedAuthorization; fee: IssuedAuthorization } | null> {
    const [seller, fee] = await Promise.all([
      deps.store.get(`${key}:seller`),
      deps.store.get(`${key}:fee`),
    ]);
    return seller && fee ? { seller, fee } : null;
  }

  return { router3Legs, stored, address: sponsor };
}

export type SponsorSigner = ReturnType<typeof createSponsorSigner>;

/** The signer's own read of a reservation: the sponsored call by its key, joined to its credit. */
export function pgSponsorReservations(db: Database): SponsorSignerDeps['reservationOf'] {
  return async (key) => {
    const { rows } = await db.query<{
      gross_raw: string;
      pay_to: string;
      call_fleet: boolean;
      credit_fleet: boolean;
      amount_raw: string;
      state: string;
      call_agent: string;
      credit_agent: string;
      chain_id: number;
    }>(
      `SELECT s.gross_raw::text AS gross_raw, s.pay_to, s.fleet AS call_fleet,
         c.fleet AS credit_fleet, c.amount_raw::text AS amount_raw, c.state,
         s.agent_id AS call_agent, c.agent_id AS credit_agent, c.chain_id
       FROM feed_pay_sponsored_calls s JOIN feed_pay_sponsor_credits c ON c.call_id = s.call_id
       WHERE s.op_key = $1`,
      [key],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      grossRaw: BigInt(row.gross_raw),
      payTo: row.pay_to as Address,
      callFleet: row.call_fleet,
      creditFleet: row.credit_fleet,
      creditAmountRaw: BigInt(row.amount_raw),
      creditState: row.state,
      callAgentId: row.call_agent,
      creditAgentId: row.credit_agent,
      creditChainId: Number(row.chain_id),
    };
  };
}
