/*
 * A fake Base for Feed pay tests: a node (PublicClient reads), a bundler and a keystore with a
 * throwaway spender key, over in-memory USDC balances. Operations sent to the bundler land at once
 * (unless `autoLand` is off) and their calls take effect: SpendPermissionManager.spend moves the
 * agent wallet's USDC into its spender account, USDC.transfer moves it on, cancelAuthorization
 * cancels a nonce. `settle` is the facilitator's part of x402: it uses an authorization on Base.
 * As SpendPermissionManager does, getCurrentPeriod reverts before a limit's start, and a spend
 * before it never lands.
 *
 * The real chain side (server/base/chain/feed-pay-chain.ts) runs over these fakes, so the
 * production paths (submit.ts, refreshFinality, issueTransferAuthorization) are exercised. Nothing
 * reaches a network and nothing verifies a signature. Synthetic data only.
 */
import assert from 'node:assert/strict';
import {
  concat,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  getAddress,
  keccak256,
  pad,
  parseAbi,
  parseAbiItem,
  toHex,
  TransactionReceiptNotFoundError,
  zeroAddress,
  type Hex,
  type PublicClient,
} from 'viem';
import { getUserOperationHash, type UserOperation } from 'viem/account-abstraction';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Database } from '../../server/database.js';
import { createFeedPayChain } from '../../server/base/chain/feed-pay-chain.js';
import { deriveAddressLocal, spenderAccountRecipe } from '../../server/base/chain/derive.js';
import { spendPermissionManagerAbi } from '../../server/base/chain/permissions.js';
import { createReservationLedger } from '../../server/base/chain/reservations.js';
import {
  BundlerError,
  bundlerRejection,
  retryAfterHeaderMs,
  SponsorError,
} from '../../server/base/chain/rpc-bundler.js';
import { pgAuthorizationStore, pgChainOperationStore } from '../../server/base/chain/stores.js';
import type { Bundler, ChainOperationStore } from '../../server/base/chain/submit.js';
import type { Address } from '../../shared/base/chains.js';
import { SPONSOR_DATA_BYTES, SPONSOR_PAYMASTERS } from '../../shared/base/paymasters.js';
import { WALLET_CHAIN_ID } from '../../shared/base/wallet-network.js';
import { WALLET_NET } from '../wallet-network-fixture.js';
import type { SettleRequest } from './fake-x402-service.js';

const NETWORK = WALLET_NET;
const CHAIN_ID = WALLET_CHAIN_ID;
const USDC = getAddress(NETWORK.tokens.USDC.address);
const ENTRY_POINT = NETWORK.contracts.entryPointV06;
const SPM = getAddress(NETWORK.contracts.spendPermissionManager);
const PINNED = (SPONSOR_PAYMASTERS[CHAIN_ID] ?? [])[0]!;
/** How far behind the head the fake node's safe and finalized blocks are. */
export const SETTLE = 3n;

const userOperationEvent = parseAbiItem(
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
);
const authorizationUsed = parseAbiItem(
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
);
const authorizationCanceled = parseAbiItem(
  'event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)',
);
const accountAbi = parseAbi([
  'function execute(address target, uint256 value, bytes data)',
  'function executeBatch((address target, uint256 value, bytes data)[] calls)',
]);
const feeRouterAbi = parseAbi([
  'function chargeFee(address payee, uint256 gross, bytes32 ref) returns (uint256 fee)',
  'function pay(address payee, uint256 gross, bytes32 ref) returns (uint256 fee)',
]);
const feeChargedEvent = parseAbiItem(
  'event FeeCharged(address indexed payer, address indexed payee, bytes32 indexed ref, uint8 kind, uint256 gross, uint256 fee)',
);

/** One FeeCharged as the fake router emits it. */
export interface FakeFeeEvent {
  /** The emitter (the router, unless a test changes it). */
  emitter: Address;
  payer: Address;
  payee: Address;
  ref: Hex;
  kind: number;
  gross: bigint;
  fee: bigint;
}
const usdcAbi = parseAbi([
  'function approve(address spender, uint256 value) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function cancelAuthorization(address authorizer, bytes32 nonce, bytes signature)',
]);
const periodWindowErrors = parseAbi([
  'error BeforeSpendPermissionStart(uint48 currentTimestamp, uint48 start)',
  'error AfterSpendPermissionEnd(uint48 currentTimestamp, uint48 end)',
]);

/** getCurrentPeriod's revert outside start..end, as viem's readContract throws it. */
function windowRevert(
  errorName: 'BeforeSpendPermissionStart' | 'AfterSpendPermissionEnd',
  args: readonly [number, number],
  callArgs: unknown[],
) {
  const data = encodeErrorResult({ abi: periodWindowErrors, errorName, args });
  return new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({
      abi: spendPermissionManagerAbi,
      data,
      functionName: 'getCurrentPeriod',
    }),
    { abi: spendPermissionManagerAbi, args: callArgs, functionName: 'getCurrentPeriod' },
  );
}

/** paymasterAndData in the pinned verifying paymaster's layout (shared/base/paymasters.ts). */
function sponsorData(): Hex {
  return concat([
    PINNED,
    pad('0x', { size: 31 }),
    zeroAddress,
    pad('0x', { size: SPONSOR_DATA_BYTES - 20 - 31 - 20 }),
  ]);
}

interface AuthEvent {
  txHash: Hex;
  blockNumber: bigint;
}

export function feedPayFakeBase(clock: () => number) {
  const SPENDER_KEY = privateKeyToAccount(generatePrivateKey());
  const spender = deriveAddressLocal(spenderAccountRecipe(NETWORK, SPENDER_KEY.address));
  const state = {
    /**
     * The protocol fee router (a test sets it with the treasury): chargeFee moves the approved
     * fee from the sender to the treasury once per (payer, ref), like CentralCityFeeRouter.
     */
    feeRouter: null as null | { router: Address; treasury: Address; token?: Address },
    /** treasury() and token() reads of the fee router fail (a node that cannot answer them). */
    routerReadsDown: false,
    /**
     * Fee router 2 (docs/protocol/FEE_ROUTER_2.md), read only: its binding and its limits
     * (MAX_TOTAL, FEE_BPS) for the readiness check. Null: no contract at its address.
     */
    feeRouter2: null as null | {
      router: Address;
      treasury: Address;
      token?: Address;
      maxTotal?: bigint;
      feeBps?: bigint;
    },
    allowances: new Map<string, bigint>(),
    feeCharges: [] as {
      payer: Address;
      payee: Address;
      ref: Hex;
      gross: bigint;
      fee: bigint;
      /** 0: chargeFee (fee on top); 1: pay (fee included). */
      kind: number;
      /** The router that charged it (router 1 or router 2). */
      router?: Address;
    }[],
    /** The FeeCharged events of each landed transaction (its receipt carries them). */
    feeEvents: new Map<Hex, FakeFeeEvent[]>(),
    /** Changes the FeeCharged a receipt shows (a test of a mismatched event); null: as emitted. */
    tamperFeeEvent: null as null | ((event: FakeFeeEvent) => FakeFeeEvent),
    /**
     * The FeeCharged events of other operations bundled into the same transaction: every receipt
     * shows them after its own (one bundle carrying several payers' operations).
     */
    bundledFeeEvents: [] as FakeFeeEvent[],
    /**
     * A landed operation is final at once (the safe and finalized heads move past it) while set;
     * off, it stays in a block above the finalized head until a test moves `head` on.
     */
    finalizeOnLand: true,
    /** Runs before each USDC balance read of the chain side (a test can change things meanwhile). */
    beforeBalanceRead: null as null | ((address: Address) => Promise<void>),
    head: 1000n,
    balances: new Map<string, bigint>(),
    code: new Set<string>(),
    nonces: new Map<string, bigint>(),
    pool: new Map<Hex, UserOperation<'0.6'>>(),
    landed: new Map<Hex, { txHash: Hex; blockNumber: bigint; sender: Address; nonce: bigint }>(),
    /** payer:nonce → the transaction that used it. */
    used: new Map<string, AuthEvent>(),
    canceled: new Map<string, AuthEvent>(),
    /** wallet → USDC spent through the limit in the current period. */
    spent: new Map<string, bigint>(),
    /** Every broadcast, rebroadcasts included. */
    sends: [] as Hex[],
    /** Decoded effects of landed operations, in order: 'spend', 'transfer', 'cancel', 'approve'. */
    effects: [] as string[],
    autoLand: true,
    /** Operations calling the fee router stay sent (unlanded) while set; land() still lands them. */
    holdFee: false,
    /** Reads fail (a node that cannot answer). */
    down: false,
    /** How far the node's clock is behind ours (seconds): Base's latest block is a little older. */
    nodeBehindS: 0,
    signatures: 0,
    /**
     * The first-send claim (queued → submitted) of operations whose key this matches throws, as
     * a worker that dies between storing an operation and claiming its send: the operation stays
     * 'queued' and is never sent by that worker. null: every claim runs.
     */
    crashBeforeClaim: null as null | ((key: string) => boolean),
    /**
     * The provider's rate limit for the next `left` operations: an HTTP 429 with this Retry-After
     * header (null: none), carried on the error as rpc-bundler.ts does. At 'prepare' it is the
     * paymaster's answer (a SponsorError: nothing was stored, the operation is abandoned before
     * broadcast); at 'send' it is eth_sendUserOperation's (the operation was stored and claimed:
     * its send is ambiguous).
     */
    rateLimit: null as null | {
      left: number;
      retryAfter: string | null;
      at: 'prepare' | 'send';
      /** Only operations that call the fee router (a fee-included payment) are limited. */
      feeOnly?: boolean;
      /** A JSON-RPC 'busy' answer inside an HTTP 200 (-32002, resource unavailable), not a 429. */
      busy?: boolean;
    },
    /** Errors the next prepares throw instead, first one first (a paymaster policy, a 500...). */
    prepareErrors: [] as Error[],
    /** Likewise, for the prepares of operations that call the fee router only. */
    feePrepareErrors: [] as Error[],
    /** Every prepare asked, refused ones included. */
    prepares: 0,
  };
  const lower = (value: string) => value.toLowerCase();
  const balanceOf = (address: string) => state.balances.get(lower(address)) ?? 0n;
  const credit = (address: string, amount: bigint) =>
    state.balances.set(lower(address), balanceOf(address) + amount);
  const blockHash = (n: bigint) => keccak256(toHex(`feed-pay-fake-block-${n}`));
  const timestamp = (n: bigint) => BigInt(Math.floor(clock() / 1000)) - (state.head - n) * 2n;
  const authKey = (payer: string, nonce: string) => `${lower(payer)}:${lower(nonce)}`;
  const lane = (sender: string, key: bigint) => `${lower(sender)}:${key}`;

  function guard() {
    if (state.down) throw new Error('the fake node is down');
  }

  const client = {
    getCode: async ({ address }: { address: string }) => {
      guard();
      return state.code.has(lower(address)) ? '0x6080' : undefined;
    },
    readContract: async (call: {
      address?: string;
      functionName: string;
      args: unknown[];
      blockNumber?: bigint;
    }) => {
      guard();
      // The fee router's immutable binding (CentralCityFeeRouter.treasury() and token()).
      const r2 = state.feeRouter2;
      if (r2 && call.address && lower(call.address) === lower(r2.router)) {
        if (state.routerReadsDown) throw new Error('the fake router read failed');
        if (call.functionName === 'treasury') return r2.treasury;
        if (call.functionName === 'token') return r2.token ?? USDC;
        if (call.functionName === 'MAX_TOTAL') return r2.maxTotal ?? 100_000_000n;
        if (call.functionName === 'FEE_BPS') return r2.feeBps ?? 1_000n;
      }
      if (call.functionName === 'MAX_TOTAL' || call.functionName === 'FEE_BPS') {
        if (
          !state.feeRouter ||
          !call.address ||
          lower(call.address) !== lower(state.feeRouter.router)
        )
          throw new Error('no contract at this address');
        return call.functionName === 'MAX_TOTAL' ? 100_000n : 1_000n;
      }
      if (call.functionName === 'treasury' || call.functionName === 'token') {
        const router = state.feeRouter;
        if (state.routerReadsDown) throw new Error('the fake router read failed');
        if (!router || !call.address || lower(call.address) !== lower(router.router))
          throw new Error('no contract at this address');
        return call.functionName === 'treasury' ? router.treasury : (router.token ?? USDC);
      }
      if (call.functionName === 'getNonce') {
        const [sender, key] = call.args as [string, bigint];
        return (key << 64n) | (state.nonces.get(lane(sender, key)) ?? 0n);
      }
      if (call.functionName === 'isApproved') return true;
      if (call.functionName === 'getCurrentPeriod') {
        const permission = call.args[0] as {
          account: string;
          start: number;
          end: number;
          period: number;
        };
        const nowS = Math.floor(clock() / 1000) - state.nodeBehindS;
        // SpendPermissionManager reverts outside the permission's start..end.
        if (nowS < permission.start)
          throw windowRevert('BeforeSpendPermissionStart', [nowS, permission.start], call.args);
        if (nowS >= permission.end)
          throw windowRevert('AfterSpendPermissionEnd', [nowS, permission.end], call.args);
        const start =
          permission.start +
          Math.floor((nowS - permission.start) / permission.period) * permission.period;
        return {
          start,
          end: start + permission.period,
          spend: state.spent.get(lower(permission.account)) ?? 0n,
        };
      }
      if (call.functionName === 'authorizationState') {
        const [payer, nonce] = call.args as [string, string];
        const at = call.blockNumber ?? state.head;
        const hit =
          state.used.get(authKey(payer, nonce)) ?? state.canceled.get(authKey(payer, nonce));
        return !!hit && hit.blockNumber <= at;
      }
      throw new Error(`no ${call.functionName} on the fake node`);
    },
    getBlockNumber: async () => {
      guard();
      return state.head;
    },
    getChainId: async () => CHAIN_ID,
    getBlock: async (args: { blockNumber?: bigint; blockTag?: string } = {}) => {
      guard();
      const number =
        args.blockNumber ??
        (args.blockTag === 'finalized' || args.blockTag === 'safe'
          ? state.head - SETTLE
          : state.head);
      return { number, hash: blockHash(number), timestamp: timestamp(number) };
    },
    getLogs: async (query: {
      event?: { name: string };
      args: Record<string, string>;
      fromBlock: bigint;
      toBlock: bigint;
    }) => {
      guard();
      const within = (n: bigint) => n >= query.fromBlock && n <= query.toBlock;
      if (
        query.event?.name === 'AuthorizationUsed' ||
        query.event?.name === 'AuthorizationCanceled'
      ) {
        const map = query.event.name === 'AuthorizationUsed' ? state.used : state.canceled;
        const hit = map.get(authKey(query.args.authorizer!, query.args.nonce!));
        if (!hit || !within(hit.blockNumber)) return [];
        return [
          {
            removed: false,
            transactionHash: hit.txHash,
            blockNumber: hit.blockNumber,
            blockHash: blockHash(hit.blockNumber),
            args: { authorizer: query.args.authorizer, nonce: query.args.nonce },
          },
        ];
      }
      const hit = state.landed.get(query.args.userOpHash as Hex);
      if (!hit || !within(hit.blockNumber)) return [];
      return [
        {
          args: {
            userOpHash: query.args.userOpHash,
            sender: hit.sender,
            paymaster: PINNED,
            nonce: hit.nonce,
            success: true,
            actualGasCost: 1_000n,
            actualGasUsed: 100n,
          },
          transactionHash: hit.txHash,
          blockNumber: hit.blockNumber,
        },
      ];
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      guard();
      const op = [...state.landed.entries()].find(([, hit]) => hit.txHash === hash);
      if (op) {
        const [userOpHash, hit] = op;
        const fees = [
          ...(state.feeEvents.get(hit.txHash) ?? []).map((event) =>
            state.tamperFeeEvent ? state.tamperFeeEvent(event) : event,
          ),
          ...state.bundledFeeEvents,
        ];
        return {
          transactionHash: hit.txHash,
          blockNumber: hit.blockNumber,
          blockHash: blockHash(hit.blockNumber),
          status: 'success',
          logs: [
            ...fees.map((event) => ({
              address: event.emitter,
              topics: encodeEventTopics({
                abi: [feeChargedEvent],
                eventName: 'FeeCharged',
                args: { payer: event.payer, payee: event.payee, ref: event.ref },
              }),
              data: encodeAbiParameters(
                [{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }],
                [event.kind, event.gross, event.fee],
              ),
            })),
            {
              address: ENTRY_POINT,
              topics: encodeEventTopics({
                abi: [userOperationEvent],
                eventName: 'UserOperationEvent',
                args: { userOpHash, sender: hit.sender, paymaster: PINNED },
              }),
              data: encodeAbiParameters(
                [{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }],
                [hit.nonce, true, 1_000n, 100n],
              ),
            },
          ],
        };
      }
      const settled = [...state.used.entries()].find(([, hit]) => hit.txHash === hash);
      if (settled) {
        const [key, hit] = settled;
        const [payer, nonce] = key.split(':') as [Address, Hex];
        return {
          transactionHash: hit.txHash,
          blockNumber: hit.blockNumber,
          blockHash: blockHash(hit.blockNumber),
          status: 'success',
          logs: [
            {
              address: USDC,
              topics: encodeEventTopics({
                abi: [authorizationUsed],
                eventName: 'AuthorizationUsed',
                args: { authorizer: getAddress(payer), nonce },
              }),
              data: '0x',
            },
          ],
        };
      }
      throw new TransactionReceiptNotFoundError({ hash });
    },
  } as unknown as PublicClient;

  /** The calls of an operation's callData (Coinbase Smart Wallet execute / executeBatch). */
  function callsOf(op: UserOperation<'0.6'>) {
    const decoded = decodeFunctionData({ abi: accountAbi, data: op.callData });
    if (decoded.functionName === 'execute') {
      const [target, value, data] = decoded.args;
      return [{ target, value, data }];
    }
    return decoded.args[0].map((call) => ({
      target: call.target,
      value: call.value,
      data: call.data,
    }));
  }

  /** The routers that execute calls: router 1 (cap 0.10 USDC) and router 2 (its MAX_TOTAL). */
  function liveRouters() {
    const routers: { router: Address; treasury: Address; maxTotal: bigint }[] = [];
    if (state.feeRouter) routers.push({ ...state.feeRouter, maxTotal: 100_000n });
    if (state.feeRouter2)
      routers.push({
        router: state.feeRouter2.router,
        treasury: state.feeRouter2.treasury,
        maxTotal: state.feeRouter2.maxTotal ?? 100_000_000n,
      });
    return routers;
  }

  /** Whether an operation calls a fee router (a fee or a fee-included payment). */
  function callsFeeRouter(op: UserOperation<'0.6'>) {
    return callsOf(op).some((c) =>
      liveRouters().some((r) => getAddress(c.target) === getAddress(r.router)),
    );
  }

  /** The sent operation lands in the next block, takes effect and is final at once. */
  function land(userOpHash: Hex) {
    const op = state.pool.get(userOpHash);
    assert.ok(op, 'the operation was sent');
    state.head += 1n;
    const txHash = keccak256(concat([userOpHash, '0x01']));
    for (const call of callsOf(op)) {
      if (getAddress(call.target) === SPM) {
        const inner = decodeFunctionData({ abi: spendPermissionManagerAbi, data: call.data });
        if (inner.functionName === 'approveWithSignature') state.effects.push('approve');
        if (inner.functionName === 'spend') {
          const [permission, value] = inner.args as unknown as [
            { account: Address; spender: Address; start: number },
            bigint,
          ];
          assert.ok(
            Math.floor(clock() / 1000) >= permission.start,
            'BeforeSpendPermissionStart: a spend before the limit starts never lands',
          );
          assert.ok(balanceOf(permission.account) >= value, 'the wallet holds the top-up');
          credit(permission.account, -value);
          credit(permission.spender, value);
          state.spent.set(
            lower(permission.account),
            (state.spent.get(lower(permission.account)) ?? 0n) + value,
          );
          state.effects.push('spend');
        }
      } else if (getAddress(call.target) === USDC) {
        const inner = decodeFunctionData({ abi: usdcAbi, data: call.data });
        if (inner.functionName === 'approve') {
          const [spender, value] = inner.args;
          state.allowances.set(`${lower(op.sender)}:${lower(spender)}`, value);
          state.effects.push('approve_fee');
        }
        if (inner.functionName === 'transfer') {
          const [to, amount] = inner.args;
          assert.ok(balanceOf(op.sender) >= amount, 'the sender holds the transfer');
          credit(op.sender, -amount);
          credit(to, amount);
          state.effects.push('transfer');
        }
        if (inner.functionName === 'cancelAuthorization') {
          const [authorizer, nonce] = inner.args;
          const key = authKey(authorizer, nonce);
          if (!state.used.has(key) && !state.canceled.has(key))
            state.canceled.set(key, { txHash, blockNumber: state.head });
          state.effects.push('cancel');
        }
      }
    }
    for (const call of callsOf(op)) {
      const routerOf = liveRouters().find((r) => getAddress(call.target) === getAddress(r.router));
      if (!routerOf) continue;
      const inner = decodeFunctionData({ abi: feeRouterAbi, data: call.data });
      const [payee, gross, ref] = inner.args as [Address, bigint, Hex];
      const included = inner.functionName === 'pay';
      const fee = (gross * 1000n) / 10000n;
      // What the router pulls from the payer: the fee on top, or the whole price fee included.
      const pulled = included ? gross : fee;
      const allowanceKey: string = `${lower(op.sender)}:${lower(routerOf.router)}`;
      assert.ok((state.allowances.get(allowanceKey) ?? 0n) >= pulled, 'the router was approved');
      assert.ok(
        !state.feeCharges.some(
          (c) =>
            lower(c.router ?? state.feeRouter?.router ?? '') === lower(routerOf.router) &&
            lower(c.payer) === lower(op.sender) &&
            c.ref === ref,
        ),
        'one charge per (payer, ref) on each router',
      );
      if (included)
        assert.ok(gross >= 50_000n && gross <= routerOf.maxTotal, 'MIN_INCLUDED..MAX_TOTAL');
      else assert.ok(gross + fee <= routerOf.maxTotal, 'gross + fee <= MAX_TOTAL');
      assert.ok(balanceOf(op.sender) >= pulled, 'the sender holds the amount');
      credit(op.sender, -pulled);
      if (included) credit(payee, gross - fee);
      credit(routerOf.treasury, fee);
      state.allowances.set(allowanceKey, (state.allowances.get(allowanceKey) ?? 0n) - pulled);
      state.feeCharges.push({
        payer: getAddress(op.sender),
        payee: getAddress(payee),
        ref,
        gross,
        fee,
        kind: included ? 1 : 0,
        router: getAddress(routerOf.router),
      });
      const events = state.feeEvents.get(txHash) ?? [];
      events.push({
        emitter: getAddress(routerOf.router),
        payer: getAddress(op.sender),
        payee: getAddress(payee),
        ref,
        kind: included ? 1 : 0,
        gross,
        fee,
      });
      state.feeEvents.set(txHash, events);
      state.effects.push(included ? 'pay' : 'fee');
    }
    const key = op.nonce >> 64n;
    state.nonces.set(lane(op.sender, key), (op.nonce & (2n ** 64n - 1n)) + 1n);
    state.code.add(lower(op.sender));
    state.landed.set(userOpHash, {
      txHash,
      blockNumber: state.head,
      sender: getAddress(op.sender),
      nonce: op.nonce,
    });
    state.pool.delete(userOpHash);
    if (state.finalizeOnLand) state.head += SETTLE;
  }

  /** The 429 of state.rateLimit at this point, once per operation while any are left. */
  function rateLimited(
    at: 'prepare' | 'send',
    method: string,
    op: UserOperation<'0.6'>,
  ): BundlerError | null {
    const limit = state.rateLimit;
    if (!limit || limit.at !== at || limit.left <= 0) return null;
    if (limit.feeOnly && !callsFeeRouter(op)) return null;
    limit.left--;
    if (limit.busy)
      return bundlerRejection(method, { code: -32002, message: 'resource unavailable' });
    return new BundlerError(
      'RPC_UNAVAILABLE',
      `${method}: HTTP 429.`,
      undefined,
      undefined,
      429,
      retryAfterHeaderMs(limit.retryAfter, clock()),
    );
  }

  const bundler: Bundler = {
    async prepare(op) {
      guard();
      state.prepares++;
      const refused = state.prepareErrors.shift();
      if (refused) throw refused;
      const feeRefused = callsFeeRouter(op) ? state.feePrepareErrors.shift() : undefined;
      if (feeRefused) throw feeRefused;
      const limited = rateLimited('prepare', 'pm_getPaymasterStubData', op);
      if (limited) throw new SponsorError(limited);
      return {
        ...op,
        callGasLimit: 100_000n,
        verificationGasLimit: 100_000n,
        preVerificationGas: 50_000n,
        maxFeePerGas: 1_000_000n,
        maxPriorityFeePerGas: 1_000n,
        paymasterAndData: sponsorData(),
      };
    },
    async send(op) {
      const hash = getUserOperationHash({
        chainId: CHAIN_ID,
        entryPointAddress: ENTRY_POINT,
        entryPointVersion: '0.6',
        userOperation: op,
      });
      const limited = rateLimited('send', 'eth_sendUserOperation', op);
      if (limited) throw limited;
      state.sends.push(hash);
      if (!state.landed.has(hash)) state.pool.set(hash, op);
      const isFee = callsFeeRouter(op);
      if (state.autoLand && !(state.holdFee && isFee) && state.pool.has(hash)) land(hash);
      return hash;
    },
    async receipt(userOpHash) {
      const hit = state.landed.get(userOpHash);
      return hit
        ? {
            success: true,
            txHash: hit.txHash,
            blockNumber: hit.blockNumber,
            actualGasUsed: 100n,
            actualGasCost: 1_000n,
          }
        : null;
    },
  };

  const keystore = {
    async withSigner<T>(
      _ref: string,
      use: (account: typeof SPENDER_KEY) => Promise<T>,
    ): Promise<T> {
      state.signatures++;
      return use(SPENDER_KEY);
    },
  };

  /** The facilitator: uses the authorization on Base (moves the USDC) and names the transaction. */
  async function settle(request: SettleRequest): Promise<Hex> {
    const key = authKey(request.from, request.nonce);
    assert.ok(!state.used.has(key) && !state.canceled.has(key), 'the nonce is unused');
    assert.ok(
      request.validBefore > BigInt(Math.floor(clock() / 1000)),
      'the authorization is valid',
    );
    assert.ok(balanceOf(request.from) >= request.value, 'the payer holds the amount');
    credit(request.from, -request.value);
    credit(request.to, request.value);
    state.head += 1n;
    const txHash = keccak256(toHex(`feed-pay-settle-${key}`));
    state.used.set(key, { txHash, blockNumber: state.head });
    return txHash;
  }

  /** The operation store, with the crash between store and claim (state.crashBeforeClaim). */
  function operationsFor(db: Database): ChainOperationStore {
    const store = pgChainOperationStore(db);
    return {
      ...store,
      transition(key, from, patch, expect) {
        if (
          state.crashBeforeClaim?.(key) &&
          from.length === 1 &&
          from[0] === 'queued' &&
          patch.status === 'submitted'
        )
          return Promise.reject(new Error('synthetic crash before the claim'));
        return store.transition(key, from, patch, expect);
      },
    };
  }

  /** The chain side over these fakes, as the runtime builds it (pinned sponsor, fee budget). */
  function chainFor(db: () => Database) {
    const usdcBalance = async (address: Address) => {
      guard();
      if (state.beforeBalanceRead) await state.beforeBalanceRead(address);
      return { balance: balanceOf(address), blockNumber: state.head };
    };
    return createFeedPayChain({
      network: NETWORK,
      client,
      db: db(),
      operations: operationsFor(db()),
      bundler,
      keystore,
      signerOf: async () => SPENDER_KEY.address,
      ledger: createReservationLedger({ chainId: CHAIN_ID, balanceOf: usdcBalance }),
      usdcBalance,
      authorizations: pgAuthorizationStore(db()),
      maxCostWeiCap: 10n ** 15n,
      sponsors: SPONSOR_PAYMASTERS,
      now: clock,
    });
  }

  return {
    state,
    client,
    bundler,
    keystore,
    land,
    settle,
    chainFor,
    spender,
    spenderSigner: SPENDER_KEY.address,
    balanceOf,
    credit,
    /** Marks an authorization used by someone else (a service that settles late). */
    useLater: settle,
  };
}

export type FeedPayFakeBase = ReturnType<typeof feedPayFakeBase>;
