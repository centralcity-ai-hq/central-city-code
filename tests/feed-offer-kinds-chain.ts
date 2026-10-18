/*
 * A fake Base chain for the offer kinds' tests: the reads base-tx, base-erc20-balance and base-gas
 * make (OfferBaseReader in server/feed/offers/kinds-base.ts), answering one fixed transaction, one
 * token and a fee history. Each test overrides the reads it is about.
 */
import { encodeAbiParameters, type Hex } from 'viem';
import type {
  OfferBaseFeeHistory,
  OfferBaseReader,
  OfferBaseReceipt,
  OfferBaseTransaction,
} from '../server/feed/offers/kinds-base.js';
import { TRANSFER_TOPIC } from '../server/feed/offers/kinds-base-tx.js';

export const TX_HASH = `0x${'ab'.repeat(32)}` as Hex;
export const TX_BLOCK = 35_999_990n;
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const TOKEN = USDC_BASE;
export const FROM = '0x1111111111111111111111111111111111111111';
export const TO = '0x2222222222222222222222222222222222222222';

const topicOf = (address: string) => `0x${'0'.repeat(24)}${address.slice(2)}`;
const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}` as Hex;

export const transferLog = (amount: bigint, token = TOKEN) => ({
  address: token,
  topics: [TRANSFER_TOPIC, topicOf(FROM), topicOf(TO)],
  data: word(amount),
});

export const fakeTx = (hash: string = TX_HASH): OfferBaseTransaction => ({
  hash,
  blockNumber: TX_BLOCK,
  from: FROM,
  to: TOKEN,
  value: 10n ** 15n,
});

export const fakeReceipt = (
  blockHash: string,
  logs = [transferLog(1_500_000n)],
): OfferBaseReceipt => ({
  status: 'success',
  blockNumber: TX_BLOCK,
  blockHash,
  from: FROM,
  to: TOKEN,
  gasUsed: 51_234n,
  effectiveGasPrice: 6_000_000n,
  logs,
});

export const fakeFeeHistory = (head: bigint): OfferBaseFeeHistory => ({
  oldestBlock: head - 4n,
  baseFeePerGas: [5_000_000n, 5_100_000n, 5_200_000n, 5_300_000n, 5_400_000n, 5_500_000n],
  reward: [[1_000n], [2_000n], [3_000n], [4_000n], [5_000n]],
});

/** ERC-20 answers by selector: balanceOf 1234.5 (6 decimals), decimals 6, symbol USDC. */
export const fakeTokenCall: OfferBaseReader['call'] = async ({ data }) => {
  const selector = data.slice(0, 10);
  if (selector === '0x70a08231') return { data: word(1_234_500_000n) };
  if (selector === '0x313ce567') return { data: word(6n) };
  if (selector === '0x95d89b41')
    return { data: encodeAbiParameters([{ type: 'string' }], ['USDC']) };
  throw Object.assign(new Error('execution reverted'), { code: 3 });
};

/** The new reads of OfferBaseReader, answering for a chain whose blocks all have `blockHash`. */
export const chainExtras = (
  head: bigint,
  blockHash: string,
): Pick<
  OfferBaseReader,
  'call' | 'getTransaction' | 'getTransactionReceipt' | 'getFeeHistory' | 'getGasPrice'
> => ({
  call: fakeTokenCall,
  getTransaction: async ({ hash }) => fakeTx(hash),
  getTransactionReceipt: async () => fakeReceipt(blockHash),
  getFeeHistory: async () => fakeFeeHistory(head),
  getGasPrice: async () => 5_600_000n,
});
