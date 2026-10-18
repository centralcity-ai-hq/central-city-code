/*
 * Fee-included payments for services Central City agents sell (docs/protocol/FEES.md, "Fee
 * included: x402 auth-capture"): pure helpers for the operator side of Base's AuthCaptureEscrow.
 *
 * - paymentTerms: the PaymentInfo for one call. Price between MIN_PRICE ($0.05) and MAX_TOTAL
 *   ($0.10), fee bounds fixed at exactly 10% (minFeeBps = maxFeeBps = 1000), the treasury as the
 *   only fee receiver, short expiries.
 * - paymentInfoHash / payerAgnosticHash: the escrow's getHash, computed locally (checked against
 *   the deployed escrow by scripts/protocol/auth-capture-spike.ts).
 * - receiveAuthorization: the one EIP-712 message the payer signs (USDC ReceiveWithAuthorization to
 *   the ERC-3009 collector, nonce = payer-agnostic hash), so the signature binds every term.
 * - chargeCall: the operator's single `charge` call: seller 90%, treasury 10%, one transaction.
 */
import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  stringToHex,
  type Hex,
} from 'viem';
import { MAX_TOTAL, feeFor } from './fee-call.js';
import { allowedToken, BASE_NETWORKS, type BaseNetwork } from '../../../shared/base/chains.js';

export const ESCROW_CONTRACT_ADDRESS: Hex = '0xf96815976523E00e65Be8f34cA5e64b4f41EB19c';
export const COLLECTOR_CONTRACT_ADDRESS: Hex = '0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88';
/** Smallest price of a service sold by a Central City agent: $0.05. */
export const MIN_PRICE = 50_000n;
export const FEE_BPS_EXACT = 1_000;
/** The payer's authorization is usable for 10 minutes; capture and refund windows follow it. */
export const PRE_APPROVAL_SECONDS = 600n;
export const AUTHORIZATION_SECONDS = 3_600n;
export const REFUND_SECONDS = 7n * 86_400n;

const PAYMENT_INFO_TYPEHASH = keccak256(
  stringToHex(
    'PaymentInfo(address operator,address payer,address receiver,address token,uint120 maxAmount,uint48 preApprovalExpiry,uint48 authorizationExpiry,uint48 refundExpiry,uint16 minFeeBps,uint16 maxFeeBps,address feeReceiver,uint256 salt)',
  ),
);
const PAYMENT_INFO_COMPONENTS = [
  { name: 'operator', type: 'address' },
  { name: 'payer', type: 'address' },
  { name: 'receiver', type: 'address' },
  { name: 'token', type: 'address' },
  { name: 'maxAmount', type: 'uint120' },
  { name: 'preApprovalExpiry', type: 'uint48' },
  { name: 'authorizationExpiry', type: 'uint48' },
  { name: 'refundExpiry', type: 'uint48' },
  { name: 'minFeeBps', type: 'uint16' },
  { name: 'maxFeeBps', type: 'uint16' },
  { name: 'feeReceiver', type: 'address' },
  { name: 'salt', type: 'uint256' },
] as const;

export const ESCROW_ABI = parseAbi([
  'struct PaymentInfo { address operator; address payer; address receiver; address token; uint120 maxAmount; uint48 preApprovalExpiry; uint48 authorizationExpiry; uint48 refundExpiry; uint16 minFeeBps; uint16 maxFeeBps; address feeReceiver; uint256 salt; }',
  'function charge(PaymentInfo paymentInfo, uint256 amount, address tokenCollector, bytes collectorData, uint256 feeAmount, address feeReceiver)',
  'function getHash(PaymentInfo paymentInfo) view returns (bytes32)',
]);

export interface PaymentInfo {
  operator: Hex;
  payer: Hex;
  receiver: Hex;
  token: Hex;
  maxAmount: bigint;
  preApprovalExpiry: number;
  authorizationExpiry: number;
  refundExpiry: number;
  minFeeBps: number;
  maxFeeBps: number;
  feeReceiver: Hex;
  salt: bigint;
}

export class PaymentTermsError extends Error {
  constructor(
    readonly code: 'BELOW_MINIMUM' | 'OVER_CAP' | 'BAD_PARTY' | 'BAD_TIME',
    message: string,
  ) {
    super(message);
  }
}

/** The terms for one fee-included call; salt is derived from the payment intent (retry-stable). */
export function paymentTerms(input: {
  operator: Hex;
  payer: Hex;
  seller: Hex;
  usdc: Hex;
  treasury: Hex;
  price: bigint;
  paymentIntentId: string;
  /**
   * Unix seconds when the payment intent was created, stored with it: a retry passes the same
   * value and so makes exactly the same terms (same expiries, same salt, same hash and nonce).
   * Never the time of the retry.
   */
  issuedAt: bigint;
}): PaymentInfo {
  if (input.price < MIN_PRICE)
    throw new PaymentTermsError('BELOW_MINIMUM', 'A Central City service costs at least $0.05.');
  if (input.price > MAX_TOTAL)
    throw new PaymentTermsError('OVER_CAP', 'A call costs at most $0.10, fee included.');
  const parties = [input.operator, input.payer, input.seller, input.treasury].map((a) =>
    getAddress(a),
  );
  if (new Set(parties).size !== parties.length || parties.some((a) => /^0x0{40}$/i.test(a)))
    throw new PaymentTermsError('BAD_PARTY', 'Operator, payer, seller and treasury must differ.');
  if (input.issuedAt <= 0n || !input.paymentIntentId)
    throw new PaymentTermsError('BAD_TIME', 'A time and a payment intent are required.');
  return {
    operator: getAddress(input.operator),
    payer: getAddress(input.payer),
    receiver: getAddress(input.seller),
    token: getAddress(input.usdc),
    maxAmount: input.price,
    preApprovalExpiry: Number(input.issuedAt + PRE_APPROVAL_SECONDS),
    authorizationExpiry: Number(input.issuedAt + AUTHORIZATION_SECONDS),
    refundExpiry: Number(input.issuedAt + REFUND_SECONDS),
    minFeeBps: FEE_BPS_EXACT,
    maxFeeBps: FEE_BPS_EXACT,
    feeReceiver: getAddress(input.treasury),
    salt: BigInt(keccak256(stringToHex(`cc.protocol.escrow.${input.paymentIntentId}`))),
  };
}

/** AuthCaptureEscrow.getHash, computed locally. */
export function paymentInfoHash(chainId: number, escrow: Hex, info: PaymentInfo): Hex {
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'tuple', components: PAYMENT_INFO_COMPONENTS }],
      [PAYMENT_INFO_TYPEHASH, info],
    ),
  );
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }],
      [BigInt(chainId), getAddress(escrow), inner],
    ),
  );
}

/** The collector's nonce: the hash with the payer set to zero. */
export const payerAgnosticHash = (chainId: number, escrow: Hex, info: PaymentInfo): Hex =>
  paymentInfoHash(chainId, escrow, {
    ...info,
    payer: '0x0000000000000000000000000000000000000000',
  });

/** The EIP-712 message the payer's spender account signs (through its ERC-1271 wrapper). */
export function receiveAuthorization(
  chainId: number,
  info: PaymentInfo,
  escrow = ESCROW_CONTRACT_ADDRESS,
) {
  // The token's own EIP-712 domain on that chain: Base USDC is "USD Coin", Base Sepolia's "USDC".
  const network = (BASE_NETWORKS as Record<number, BaseNetwork | undefined>)[chainId];
  const domain = network ? allowedToken(network, info.token)?.eip712 : undefined;
  if (!domain)
    throw new PaymentTermsError('BAD_PARTY', 'The token has no EIP-712 domain on this chain.');
  return {
    domain: { name: domain.name, version: domain.version, chainId, verifyingContract: info.token },
    types: {
      ReceiveWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'ReceiveWithAuthorization' as const,
    message: {
      from: info.payer,
      to: COLLECTOR_CONTRACT_ADDRESS,
      value: info.maxAmount,
      validAfter: 0n,
      validBefore: BigInt(info.preApprovalExpiry),
      nonce: payerAgnosticHash(chainId, escrow, info),
    },
  };
}

/** The operator's one call: charge the full price, exactly 10% to the treasury. */
export function chargeCall(
  info: PaymentInfo,
  payerSignature: Hex,
  escrow = ESCROW_CONTRACT_ADDRESS,
) {
  if (info.minFeeBps !== FEE_BPS_EXACT || info.maxFeeBps !== FEE_BPS_EXACT)
    throw new PaymentTermsError('BAD_PARTY', 'Fee bounds must be exactly 10%.');
  if (info.maxAmount < MIN_PRICE || info.maxAmount > MAX_TOTAL)
    throw new PaymentTermsError(
      info.maxAmount < MIN_PRICE ? 'BELOW_MINIMUM' : 'OVER_CAP',
      'Price out of range.',
    );
  return {
    to: getAddress(escrow),
    value: 0n,
    data: encodeFunctionData({
      abi: ESCROW_ABI,
      functionName: 'charge',
      args: [
        info,
        info.maxAmount,
        COLLECTOR_CONTRACT_ADDRESS,
        payerSignature,
        feeFor(info.maxAmount),
        info.feeReceiver,
      ],
    }),
  };
}
