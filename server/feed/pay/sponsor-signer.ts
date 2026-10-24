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
 * Because this key moves Central City's own money (room #335), two limits live in the signer
 * itself, whatever the caller asks: the price is at most SFP_CREDIT_CEILING_RAW (2 USDC) and split
 * exactly as router 3 does (quoteFeeIncluded), and the router and its treasury are bound by
 * configuration (the treasury read from the router once), never taken from the caller, so a fee
 * leg can never authorize a transfer to any other address.
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
import { LEG_FEE, LEG_SELLER, router3Nonce } from './router3.js';
import { SFP_CREDIT_CEILING_RAW } from './sponsor.js';

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
    let split: { fee: bigint; net: bigint };
    try {
      split = quoteFeeIncluded(input.gross, SFP_CREDIT_CEILING_RAW);
    } catch {
      throw new AuthorizationError(
        'INVALID_AMOUNT',
        'A sponsored price is 0.05 to 2 USDC, fee included.',
      );
    }
    const router = getAddress(deps.router) as Address;
    const treasury = getAddress(await treasury$()) as Address;
    const sellerId = `${input.key}:seller`;
    const earlier = await deps.store.get(sellerId);
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
