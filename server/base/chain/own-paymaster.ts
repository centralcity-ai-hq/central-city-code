/*
 * Our own sponsoring paymaster (Operation Paymaster, Phase 1): an instance of Coinbase's
 * VerifyingPaymaster v1.0.0 (github.com/coinbase/verifying-paymaster, tag v1.0.0, EntryPoint v0.6,
 * MIT, Cantina audit), deployed byte for byte with our own entryPoint/signer/owner arguments. This
 * module is its off-chain half: it builds paymasterAndData in the contract's 194-byte layout (the
 * same layout shared/base/paymasters.ts already checks) and signs the contract's getHash() with our
 * verifying signer, in process (no pm_* endpoint is exposed to anyone).
 *
 * The contract recovers the signer from toEthSignedMessageHash(getHash(userOp, paymasterData)), and
 * getHash binds sender, nonce, initCode, callData, all five gas fields, the chain id, the paymaster
 * address and every paymaster field. So a signature covers exactly one operation on one chain and
 * one paymaster, and the gas ceilings the policy enforces here are binding on chain.
 *
 * Every sponsorship is signed with allowAnyBundler = false: the contract's _postOp then reverts
 * unless tx.origin (our submitter EOA) is on its bundler allowlist, so no foreign bundler can spend
 * our deposit. token, receiver, exchangeRate and postOpGas are always zero: the wallet is charged
 * nothing (shared/base/paymasters.ts refuses anything else).
 */
import { concat, encodeAbiParameters, keccak256, numberToHex, pad, type Hex } from 'viem';
import type { UserOperation } from 'viem/account-abstraction';
import type { Address } from '../../../shared/base/chains.js';
import { SPONSOR_DATA_BYTES } from '../../../shared/base/paymasters.js';

/** The fields of paymasterAndData after the paymaster address, before the signature. */
export interface PaymasterFields {
  /** Seconds; the signature is valid up to and including this time (EntryPoint AA32 after it). */
  validUntil: number;
  /** Seconds; the signature is valid from this time on. */
  validAfter: number;
  /** For our own accounting (UserOperationSponsored's indexed sponsorUUID); 128 bits. */
  sponsorUUID: bigint;
}

const UINT48_MAX = 2 ** 48 - 1;
const UINT128_MAX = (1n << 128n) - 1n;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

function checkFields(fields: PaymasterFields): void {
  const { validUntil, validAfter, sponsorUUID } = fields;
  if (!Number.isSafeInteger(validUntil) || validUntil <= 0 || validUntil > UINT48_MAX)
    throw new Error('validUntil must be a positive uint48.');
  if (!Number.isSafeInteger(validAfter) || validAfter < 0 || validAfter >= validUntil)
    throw new Error('validAfter must be a uint48 below validUntil.');
  if (sponsorUUID < 0n || sponsorUUID > UINT128_MAX)
    throw new Error('sponsorUUID must be a uint128.');
}

/**
 * The 129 bytes the contract parses (_parsePaymasterAndData): paymaster, validUntil, validAfter,
 * sponsorUUID, allowAnyBundler = 0, precheckBalance = 0, prepaymentRequired = 0, token = 0,
 * receiver = 0, exchangeRate = 0, postOpGas = 0.
 */
export function paymasterPrefix(paymaster: Address, fields: PaymasterFields): Hex {
  checkFields(fields);
  return concat([
    paymaster,
    pad(numberToHex(fields.validUntil), { size: 6 }),
    pad(numberToHex(fields.validAfter), { size: 6 }),
    pad(numberToHex(fields.sponsorUUID), { size: 16 }),
    '0x00', // allowAnyBundler: only allowlisted submitters (enforced in _postOp via tx.origin)
    '0x00', // precheckBalance
    '0x00', // prepaymentRequired
    ZERO_ADDRESS, // token: none, the wallet is charged nothing
    ZERO_ADDRESS, // receiver
    pad('0x00', { size: 32 }), // exchangeRate
    pad('0x00', { size: 6 }), // postOpGas
  ]);
}

/**
 * The contract's getHash(userOp, paymasterData): keccak256(abi.encode(sender, nonce,
 * keccak256(initCode), keccak256(callData), callGasLimit, verificationGasLimit,
 * preVerificationGas, maxFeePerGas, maxPriorityFeePerGas, block.chainid, address(this),
 * paymasterData)), the PaymasterData struct encoded inline (all its members are static).
 */
export function paymasterHash(
  op: UserOperation<'0.6'>,
  input: { chainId: number; paymaster: Address; fields: PaymasterFields },
): Hex {
  checkFields(input.fields);
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'address' },
        {
          type: 'tuple',
          components: [
            { name: 'validUntil', type: 'uint48' },
            { name: 'validAfter', type: 'uint48' },
            { name: 'sponsorUUID', type: 'uint128' },
            { name: 'allowAnyBundler', type: 'bool' },
            { name: 'precheckBalance', type: 'bool' },
            { name: 'prepaymentRequired', type: 'bool' },
            { name: 'token', type: 'address' },
            { name: 'receiver', type: 'address' },
            { name: 'exchangeRate', type: 'uint256' },
            { name: 'postOpGas', type: 'uint48' },
          ],
        },
      ],
      [
        op.sender,
        op.nonce,
        keccak256(op.initCode ?? '0x'),
        keccak256(op.callData),
        op.callGasLimit,
        op.verificationGasLimit,
        op.preVerificationGas,
        op.maxFeePerGas,
        op.maxPriorityFeePerGas,
        BigInt(input.chainId),
        input.paymaster,
        {
          validUntil: input.fields.validUntil,
          validAfter: input.fields.validAfter,
          sponsorUUID: input.fields.sponsorUUID,
          allowAnyBundler: false,
          precheckBalance: false,
          prepaymentRequired: false,
          token: ZERO_ADDRESS,
          receiver: ZERO_ADDRESS,
          exchangeRate: 0n,
          postOpGas: 0,
        },
      ],
    ),
  );
}

/**
 * A stub of the final length for gas estimation (ERC-7677 pm_getPaymasterStubData): the real
 * fields and a 65-byte placeholder signature. It never validates on chain (the signature is not
 * ours), so it is only ever used where validation does not run, never sent.
 */
export function paymasterStub(paymaster: Address, fields: PaymasterFields): Hex {
  const stub = concat([paymasterPrefix(paymaster, fields), `0x${'ff'.repeat(64)}1c`]);
  if ((stub.length - 2) / 2 !== SPONSOR_DATA_BYTES) throw new Error('Stub has the wrong length.');
  return stub;
}

/** Signs a 32-byte hash as an Ethereum signed message (the contract's toEthSignedMessageHash). */
export type HashSigner = (hash: Hex) => Promise<Hex>;

/**
 * The signed paymasterAndData for one operation whose gas fields are final (ERC-7677
 * pm_getPaymasterData). The operation must already carry every field getHash reads; any later
 * change to them invalidates the signature (EntryPoint AA34).
 */
export async function signPaymasterData(
  op: UserOperation<'0.6'>,
  input: { chainId: number; paymaster: Address; fields: PaymasterFields; sign: HashSigner },
): Promise<Hex> {
  const hash = paymasterHash(op, input);
  const signature = await input.sign(hash);
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature))
    throw new Error('Paymaster signature must be 65 bytes.');
  const data = concat([paymasterPrefix(input.paymaster, input.fields), signature]);
  if ((data.length - 2) / 2 !== SPONSOR_DATA_BYTES)
    throw new Error('paymasterAndData has the wrong length.');
  return data;
}
