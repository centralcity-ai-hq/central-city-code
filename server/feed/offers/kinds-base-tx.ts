/*
 * More Base kinds (base-tx, base-erc20-balance, base-gas): read-only reads of Base mainnet through
 * the same reader as base-block and base-usdc-balance (setOfferKindDeps({ readBase }),
 * offerBaseReader in kinds-base.ts: the server's configured Base read endpoint and its second one,
 * checked to be chain 8453; its URLs are never logged or answered). The same rules hold:
 *
 *   - one read waits at most BASE_READ_TIMEOUT_MS ('timeout', 504) and stops when ctx.signal
 *     aborts; a malformed or failed answer is 'chain_unavailable' (502), never a made-up value; a
 *     reader that is not configured answers 'unavailable' (503)
 *   - check() holds every refusal of the input alone (the schema; an address's EIP-55 checksum),
 *     so it comes before payment; what depends on the chain is the paid call's outcome
 *   - every answer names the block it describes
 *
 * base-tx: a transaction by hash, with its receipt and its block's time. A hash the chain does not
 * have is 'tx_not_found' (422, retryable: it may still arrive); a transaction without a receipt
 * yet answers status 'pending' and nulls for what only the receipt knows. The ERC-20 transfers
 * are the receipt's Transfer(address,address,uint256) logs with three topics and a 32-byte amount
 * (an ERC-721 Transfer has four topics and is not one), in log order, at most
 * BASE_TX_MAX_TRANSFERS; the count says how many there were. Amounts are raw base units (a
 * token's decimals are a further read, which base-erc20-balance makes).
 *
 * base-erc20-balance: balanceOf, decimals and symbol of a token contract, each one eth_call pinned
 * to the latest block's number, so all three describe the same moment. A contract that reverts
 * balanceOf or answers it with something other than one 32-byte word (an address without code
 * included) is 'not_a_token' (422, not retryable). decimals and symbol are optional in ERC-20:
 * a token that has neither answers null for them (and for the formatted balance, which needs
 * decimals). A bytes32 symbol (older tokens) is read as its text; a symbol is at most 32
 * characters with control characters removed.
 *
 * base-gas: eth_feeHistory over the last BASE_GAS_BLOCKS blocks (the base fee of the newest one
 * and of the next, and the median of the blocks' median priority fee) and eth_gasPrice, in gwei
 * as decimal text and in wei. A quote of what the chain charged, never a decision.
 */
import {
  decodeAbiParameters,
  encodeFunctionData,
  formatEther,
  formatGwei,
  formatUnits,
  getAddress,
  hexToString,
  parseAbi,
  type Hex,
} from 'viem';
import { BASE_MAINNET } from '../../../shared/base/chains.js';
import { OFFER_KIND_SPECS } from '../../../shared/feed-offers.js';
import { reverted } from '../../base/chain/read-transport.js';
import {
  checked,
  jsonAnswer,
  offerKindDeps,
  OfferKindFailure,
  type OfferKind,
} from './kind-core.js';
import {
  blockAt,
  chainFailed,
  chainRead,
  chainTimeout,
  checkedAddress,
  FAILED,
  latestBlock,
  TIMEOUT,
  type OfferBaseReceipt,
  type OfferBaseTransaction,
} from './kinds-base.js';

export const BASE_TX_MAX_TRANSFERS = 50;
export const BASE_GAS_BLOCKS = 5;
/** keccak256("Transfer(address,address,uint256)"). */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;

const isUint = (value: unknown): value is bigint => typeof value === 'bigint' && value >= 0n;

// ---------------------------------------------------------------------------------------------
// base-tx

/** A transaction as read, checked: the hash asked for, addresses and a value; else null. */
function wellFormedTx(tx: unknown, hash: string): OfferBaseTransaction | null {
  const value = tx as Partial<OfferBaseTransaction> | null | undefined;
  if (
    typeof value?.hash !== 'string' ||
    value.hash.toLowerCase() !== hash ||
    typeof value.from !== 'string' ||
    !ADDRESS.test(value.from) ||
    (value.to !== null && (typeof value.to !== 'string' || !ADDRESS.test(value.to))) ||
    !isUint(value.value) ||
    (value.blockNumber !== null && !isUint(value.blockNumber))
  )
    return null;
  return value as OfferBaseTransaction;
}

function wellFormedReceipt(receipt: unknown): OfferBaseReceipt | null {
  const value = receipt as Partial<OfferBaseReceipt> | null | undefined;
  if (
    (value?.status !== 'success' && value?.status !== 'reverted') ||
    !isUint(value.blockNumber) ||
    typeof value.blockHash !== 'string' ||
    !HASH.test(value.blockHash) ||
    !isUint(value.gasUsed) ||
    !isUint(value.effectiveGasPrice) ||
    !Array.isArray(value.logs)
  )
    return null;
  return value as OfferBaseReceipt;
}

export interface Erc20Transfer {
  token: string;
  from: string;
  to: string;
  amount_raw: string;
}

/** The ERC-20 Transfer logs of a receipt (see the module header). */
export function erc20Transfers(logs: OfferBaseReceipt['logs']): {
  transfers: Erc20Transfer[];
  count: number;
} {
  const transfers: Erc20Transfer[] = [];
  let count = 0;
  for (const log of logs) {
    const topics = log?.topics;
    if (
      !Array.isArray(topics) ||
      topics.length !== 3 ||
      String(topics[0]).toLowerCase() !== TRANSFER_TOPIC ||
      typeof log.address !== 'string' ||
      !ADDRESS.test(log.address) ||
      typeof log.data !== 'string' ||
      !WORD.test(log.data) ||
      !topics.slice(1).every((topic) => typeof topic === 'string' && WORD.test(topic))
    )
      continue;
    count++;
    if (transfers.length >= BASE_TX_MAX_TRANSFERS) continue;
    transfers.push({
      token: getAddress(log.address),
      from: getAddress(`0x${topics[1]!.slice(26)}`),
      to: getAddress(`0x${topics[2]!.slice(26)}`),
      amount_raw: BigInt(log.data).toString(),
    });
  }
  return { transfers, count };
}

export const baseTxKind: OfferKind = {
  name: 'base-tx',
  inputSchema: OFFER_KIND_SPECS['base-tx'].input,
  outputMime: OFFER_KIND_SPECS['base-tx'].outputMime,
  check(input) {
    checked('base-tx', input);
  },
  async run(input, ctx) {
    baseTxKind.check(input);
    const hash = String(checked('base-tx', input).hash).toLowerCase() as Hex;
    const reader = offerKindDeps().readBase;
    const read = await chainRead(() => reader.getTransaction({ hash }), ctx);
    if (read === TIMEOUT) throw chainTimeout();
    if (read === FAILED) throw chainFailed();
    if (read === null)
      throw new OfferKindFailure('tx_not_found', 'Base has no transaction with this hash.', 422, {
        retryable: true,
      });
    const tx = wellFormedTx(read, hash);
    if (!tx) throw chainFailed();
    const receiptRead = await chainRead(() => reader.getTransactionReceipt({ hash }), ctx);
    if (receiptRead === TIMEOUT) throw chainTimeout();
    if (receiptRead === FAILED) throw chainFailed();
    const common = {
      chainId: BASE_MAINNET,
      hash,
      from: getAddress(tx.from),
      to: tx.to === null ? null : getAddress(tx.to),
      value_wei: tx.value.toString(),
      value_eth: formatEther(tx.value),
    };
    if (receiptRead === null)
      return jsonAnswer({
        ...common,
        status: 'pending',
        block: null,
        block_hash: null,
        timestamp: null,
        time: null,
        gas_used: null,
        effective_gas_price: null,
        effective_gas_price_gwei: null,
        fee_eth: null,
        erc20_transfers: [],
        erc20_transfer_count: 0,
      });
    const receipt = wellFormedReceipt(receiptRead);
    if (!receipt) throw chainFailed();
    const block = await blockAt(receipt.blockNumber, ctx);
    // The receipt's block and the block read must be the same one (no reorg in between).
    if (block.hash !== receipt.blockHash.toLowerCase()) throw chainFailed();
    const { transfers, count } = erc20Transfers(receipt.logs);
    const timestamp = Number(block.timestamp);
    return jsonAnswer({
      ...common,
      status: receipt.status,
      block: Number(block.number),
      block_hash: block.hash,
      timestamp,
      time: new Date(timestamp * 1000).toISOString(),
      gas_used: receipt.gasUsed.toString(),
      effective_gas_price: receipt.effectiveGasPrice.toString(),
      effective_gas_price_gwei: formatGwei(receipt.effectiveGasPrice),
      fee_eth: formatEther(receipt.gasUsed * receipt.effectiveGasPrice),
      erc20_transfers: transfers,
      erc20_transfer_count: count,
    });
  },
};

// ---------------------------------------------------------------------------------------------
// base-erc20-balance

export const ERC20_READ_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

const REVERTED: unique symbol = Symbol('reverted');

/**
 * One eth_call under the Base deadline: its data, REVERTED for the chain's refusal (a revert), or
 * the chainRead outcomes.
 */
async function ethCall(
  to: `0x${string}`,
  data: Hex,
  blockNumber: bigint,
  ctx: Parameters<OfferKind['run']>[1],
) {
  return chainRead(
    () =>
      offerKindDeps()
        .readBase.call({ to, data, blockNumber })
        .then(
          (answer): Hex | typeof REVERTED => answer?.data ?? '0x',
          (error: unknown): typeof REVERTED => {
            if (reverted(error)) return REVERTED;
            throw error;
          },
        ),
    ctx,
  );
}

/** A symbol answered as an ABI string or as bytes32; null when it is neither. */
export function readSymbol(data: Hex): string | null {
  let text: string | null = null;
  try {
    [text] = decodeAbiParameters([{ type: 'string' }], data) as [string];
  } catch {
    if (WORD.test(data)) {
      try {
        text = hexToString(data, { size: 32 }).replace(/\u0000+$/, '');
      } catch {
        text = null;
      }
    }
  }
  if (text === null) return null;
  const clean = Array.from(text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim())
    .slice(0, 32)
    .join('');
  return clean || null;
}

function erc20Input(input: unknown) {
  const value = checked('base-erc20-balance', input);
  return {
    address: checkedAddress(String(value.address), 'address'),
    token: checkedAddress(String(value.token), 'token'),
  };
}

const notAToken = () =>
  new OfferKindFailure('not_a_token', 'token did not answer balanceOf as an ERC-20 token.', 422, {
    retryable: false,
  });

export const baseErc20BalanceKind: OfferKind = {
  name: 'base-erc20-balance',
  inputSchema: OFFER_KIND_SPECS['base-erc20-balance'].input,
  outputMime: OFFER_KIND_SPECS['base-erc20-balance'].outputMime,
  check(input) {
    erc20Input(input);
  },
  async run(input, ctx) {
    const { address, token } = erc20Input(input);
    const block = await latestBlock(ctx);
    const read = async (data: Hex) => {
      const answer = await ethCall(token, data, block.number, ctx);
      if (answer === TIMEOUT) throw chainTimeout();
      if (answer === FAILED || (answer !== REVERTED && typeof answer !== 'string'))
        throw chainFailed();
      return answer as Hex | typeof REVERTED;
    };
    const balanceData = await read(
      encodeFunctionData({ abi: ERC20_READ_ABI, functionName: 'balanceOf', args: [address] }),
    );
    if (balanceData === REVERTED || !WORD.test(balanceData)) throw notAToken();
    const balance = BigInt(balanceData);
    const decimalsData = await read(
      encodeFunctionData({ abi: ERC20_READ_ABI, functionName: 'decimals' }),
    );
    let decimals: number | null = null;
    if (decimalsData !== REVERTED && WORD.test(decimalsData)) {
      const value = BigInt(decimalsData);
      decimals = value <= 255n ? Number(value) : null;
    }
    const symbolData = await read(
      encodeFunctionData({ abi: ERC20_READ_ABI, functionName: 'symbol' }),
    );
    const symbol = symbolData === REVERTED ? null : readSymbol(symbolData);
    return jsonAnswer({
      chainId: BASE_MAINNET,
      address,
      token,
      balance_raw: balance.toString(),
      decimals,
      symbol,
      balance: decimals === null ? null : formatUnits(balance, decimals),
      block: Number(block.number),
      block_hash: block.hash,
    });
  },
};

// ---------------------------------------------------------------------------------------------
// base-gas

const median = (values: bigint[]): bigint => {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2n;
};

export const baseGasKind: OfferKind = {
  name: 'base-gas',
  inputSchema: OFFER_KIND_SPECS['base-gas'].input,
  outputMime: OFFER_KIND_SPECS['base-gas'].outputMime,
  check(input) {
    checked('base-gas', input);
  },
  async run(input, ctx) {
    baseGasKind.check(input);
    const reader = offerKindDeps().readBase;
    const history = await chainRead(
      () =>
        reader.getFeeHistory({
          blockCount: BASE_GAS_BLOCKS,
          blockTag: 'latest',
          rewardPercentiles: [50],
        }),
      ctx,
    );
    if (history === TIMEOUT) throw chainTimeout();
    if (history === FAILED) throw chainFailed();
    const fees = history?.baseFeePerGas;
    // One base fee per block read, and one more for the next block.
    if (
      !isUint(history?.oldestBlock) ||
      !Array.isArray(fees) ||
      fees.length < 2 ||
      fees.length > BASE_GAS_BLOCKS + 1 ||
      !fees.every(isUint)
    )
      throw chainFailed();
    const rewards = (history.reward ?? [])
      .map((row) => row?.[0])
      .filter((value): value is bigint => isUint(value));
    const price = await chainRead(() => reader.getGasPrice(), ctx);
    if (price === TIMEOUT) throw chainTimeout();
    if (price === FAILED || !isUint(price)) throw chainFailed();
    const baseFee = fees[fees.length - 2]!;
    const nextBaseFee = fees[fees.length - 1]!;
    const priority = rewards.length ? median(rewards) : null;
    return jsonAnswer({
      chainId: BASE_MAINNET,
      block: Number(history.oldestBlock) + fees.length - 2,
      base_fee_gwei: formatGwei(baseFee),
      next_base_fee_gwei: formatGwei(nextBaseFee),
      suggested_priority_gwei: priority === null ? null : formatGwei(priority),
      gas_price_gwei: formatGwei(price),
      base_fee_wei: baseFee.toString(),
      next_base_fee_wei: nextBaseFee.toString(),
      suggested_priority_wei: priority === null ? null : priority.toString(),
      gas_price_wei: price.toString(),
      blocks: fees.length - 1,
    });
  },
};
