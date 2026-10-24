// Operation Paymaster canary report (read-only; public Base RPC, no keys, no database).
// node canary-report.mjs <txHash> [<txHash> ...]   (the submitter's handleOps transactions)
// Per transaction, in exact wei:
//   actualGasCost  sum of the EntryPoint's UserOperationEvent actualGasCost (deposit-funded)
//   outer L2/L1    gasUsed x effectiveGasPrice, and the receipt's l1Fee
//   beneficiary    decoded from the handleOps calldata (who the EntryPoint repays)
//   repaid         VERIFIED from balances only in an isolated block: no other transaction, or
//                  full call traces (BASE_RPC with debug_traceTransaction) showing none touches the
//                  beneficiary, sender or EntryPoint; else UNVERIFIED and never subtracted
//   overhead       L2 + L1 - verified repayment (or L2 + L1 when unverified)
// Then the paymaster deposit and the submitter float now. BASE_RPC overrides the endpoint.
const RPC = process.env.BASE_RPC ?? 'https://mainnet.base.org';
const ENTRY_POINT = '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789';
const PAYMASTER = (
  process.env.PAYMASTER ?? '0x8bf5b18b733a864c17cd92615cd45d833fcfe105'
).toLowerCase();
const SUBMITTER = (
  process.env.SUBMITTER ?? '0xbbd1b99822d03a1c46f8b4c063dd1a66fcca1d47'
).toLowerCase();
// keccak256('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)')
const USER_OP_EVENT = '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f';
const HANDLE_OPS = '0x1fad948c'; // handleOps((...)[],address)

let id = 0;
const rpc = async (method, params) => {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
};
const big = (hex) => (hex ? BigInt(hex) : 0n);
const hex = (n) => `0x${n.toString(16)}`;
const eth = (wei) => `${wei < 0n ? '-' : ''}${(Number(wei < 0n ? -wei : wei) / 1e18).toFixed(9)}`;

const L1_BLOCK = '0x4200000000000000000000000000000000000015';
const L1_DEPOSITOR = '0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001';
const isL1Attributes = (t) =>
  t.type === '0x7e' && t.from.toLowerCase() === L1_DEPOSITOR && t.to?.toLowerCase() === L1_BLOCK;
const touchesTop = (t, who) => t.from.toLowerCase() === who || t.to?.toLowerCase() === who;
/** A callTracer frame or any frame below it: a call, transfer or selfdestruct to/from `who`. */
const touchesFrame = (frame, who) =>
  frame.from?.toLowerCase() === who ||
  frame.to?.toLowerCase() === who ||
  (frame.calls ?? []).some((c) => touchesFrame(c, who));
const FRAME_TYPES = new Set([
  'CALL',
  'STATICCALL',
  'DELEGATECALL',
  'CALLCODE',
  'CREATE',
  'CREATE2',
  'SELFDESTRUCT',
]);
const isAddress = (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
/** A well-formed callTracer frame, recursively: known type, from and to, calls an array of frames. */
const frameOk = (frame) =>
  frame !== null &&
  typeof frame === 'object' &&
  !Array.isArray(frame) &&
  typeof frame.type === 'string' &&
  FRAME_TYPES.has(frame.type.toUpperCase()) &&
  isAddress(frame.from) &&
  isAddress(frame.to) &&
  (frame.calls === undefined || (Array.isArray(frame.calls) && frame.calls.every(frameOk)));
/** The trace root is this very transaction: from the sender, a CALL to its target (CREATE without). */
const rootOk = (frame, t) =>
  frameOk(frame) &&
  frame.from.toLowerCase() === t.from.toLowerCase() &&
  (t.to
    ? frame.type.toUpperCase() === 'CALL' && frame.to.toLowerCase() === t.to.toLowerCase()
    : frame.type.toUpperCase() === 'CREATE');
/**
 * Every transaction's full call trace, each checked against its transaction; any refusal, missing
 * or malformed trace leaves isolation unproven (fail closed).
 */
const traceAll = async (txs) => {
  let traces;
  try {
    traces = await Promise.all(
      txs.map((t) => rpc('debug_traceTransaction', [t.hash, { tracer: 'callTracer' }])),
    );
  } catch {
    return { error: 'NO_TRACE(other txs in the block; set BASE_RPC to a tracing node)' };
  }
  if (!traces.every((frame, i) => rootOk(frame, txs[i])))
    return { error: 'MALFORMED_TRACE(a trace is missing or does not match its transaction)' };
  return { traces };
};

const hashes = process.argv.slice(2);
if (!hashes.length) {
  console.error('usage: node canary-report.mjs <txHash> [...]');
  process.exit(2);
}
const totals = { actual: 0n, l2: 0n, l1: 0n, repaid: 0n, overhead: 0n, unverified: 0 };
console.log(
  'tx | block | status | ops | outcomes | actualGasCost | outer L2 | outer L1 | beneficiary | repaid (verified?) | net overhead (wei)',
);
for (const hash of hashes) {
  const [r, tx] = await Promise.all([
    rpc('eth_getTransactionReceipt', [hash]),
    rpc('eth_getTransactionByHash', [hash]),
  ]);
  if (!r || !tx) {
    console.log(`${hash} | not found (pending, dropped or wrong chain)`);
    continue;
  }
  const flags = [];
  const events = r.logs.filter(
    (l) => l.address.toLowerCase() === ENTRY_POINT && l.topics[0] === USER_OP_EVENT,
  );
  let actual = 0n;
  for (const e of events) {
    // data: nonce, success, actualGasCost, actualGasUsed (32 bytes each)
    const words = e.data.slice(2).match(/.{64}/g) ?? [];
    actual += BigInt(`0x${words[2] ?? '0'}`);
    flags.push(BigInt(`0x${words[1] ?? '0'}`) === 1n ? 'ok' : 'USEROP_REVERTED');
    if (`0x${e.topics[3]?.slice(26)}`.toLowerCase() !== PAYMASTER) flags.push('PAYMASTER_NOT_OURS');
  }
  if (r.status !== '0x1') flags.push('BUNDLE_REVERTED');
  // Beneficiary: second argument of handleOps (word 1 after the selector).
  let beneficiary = null;
  if (tx.to?.toLowerCase() === ENTRY_POINT && tx.input.startsWith(HANDLE_OPS))
    beneficiary = `0x${tx.input.slice(10 + 64 + 24, 10 + 128)}`.toLowerCase();
  else flags.push('NOT_HANDLE_OPS');
  if (tx.from.toLowerCase() !== SUBMITTER) flags.push('NOT_OUR_SUBMITTER');
  if (beneficiary && beneficiary !== SUBMITTER) flags.push('BENEFICIARY_NOT_SUBMITTER');
  const l2 = big(r.gasUsed) * big(r.effectiveGasPrice);
  // Base receipts carry l1Fee; a node that charges it but omits the field (Anvil forking Base)
  // gets it inferred below from reconciled balances, flagged L1_FEE_INFERRED.
  const l1Reported = r.l1Fee !== undefined;
  let l1 = big(r.l1Fee);

  // Repayment, verified: the beneficiary's balance over the block, plus what it paid in it. Only
  // when it sent exactly this one transaction in that block (else other payments mix in).
  let repaid = 0n;
  let verified = false;
  if (beneficiary) {
    const block = big(r.blockNumber);
    const blockTxs = (await rpc('eth_getBlockByNumber', [hex(block), true])).transactions;
    // Isolation: no OTHER transaction in the block touches the beneficiary, the sender or the
    // EntryPoint, so their balance changes over the block are this transaction's alone.
    const sender = tx.from.toLowerCase();
    // Base's L1-attributes system transaction (one per block) only writes the L1Block predeploy.
    const others = blockTxs.filter(
      (t) => t.hash.toLowerCase() !== hash.toLowerCase() && !isL1Attributes(t),
    );
    const watched = [beneficiary, sender, ENTRY_POINT];
    // Top-level from/to cannot show an INTERNAL call or transfer, so isolation needs one of: no
    // other transaction at all, or every other transaction's full call trace (BASE_RPC with
    // debug_traceTransaction). Without either the repayment stays unverified.
    let isolated = others.length === 0;
    if (!isolated && !others.some((t) => watched.some((w) => touchesTop(t, w)))) {
      const { traces, error } = await traceAll(others);
      if (traces) isolated = !traces.some((frame) => watched.some((w) => touchesFrame(frame, w)));
      else flags.push(error);
    }
    if (isolated) {
      const [before, after, epBefore, epAfter, senderBefore, senderAfter] = await Promise.all([
        rpc('eth_getBalance', [beneficiary, hex(block - 1n)]),
        rpc('eth_getBalance', [beneficiary, hex(block)]),
        rpc('eth_getBalance', [ENTRY_POINT, hex(block - 1n)]),
        rpc('eth_getBalance', [ENTRY_POINT, hex(block)]),
        rpc('eth_getBalance', [sender, hex(block - 1n)]),
        rpc('eth_getBalance', [sender, hex(block)]),
      ]);
      if (beneficiary !== sender && !l1Reported) {
        // The sender is not repaid here: its whole loss is its fee. An ESTIMATE of the L1 part.
        l1 = big(senderBefore) - big(senderAfter) - l2;
        flags.push(`L1_FEE_ESTIMATED(${l1})`);
      }
      // What the EntryPoint actually paid out in this block (its only transaction): the repayment.
      const paidOut = big(epBefore) - big(epAfter);
      const change = big(after) - big(before);
      const ownTx = beneficiary === tx.from.toLowerCase();
      // The repayment is proven ONLY by evidence independent of the fee math: the
      // EntryPoint's own ETH balance fell by exactly the events' actualGasCost in a block where
      // this is its only transaction (so nothing else moved its balance).
      const payoutProven = paidOut === actual;
      if (ownTx && !l1Reported) {
        // An ESTIMATE, not evidence: the L1 fee that makes the beneficiary's balance reconcile
        // with the proven payout. Used only to complete the cost columns; never to verify.
        l1 = paidOut - change - l2;
        flags.push(`L1_FEE_ESTIMATED(${l1})`);
      }
      repaid = paidOut;
      verified = payoutProven;
      // With a reported L1 fee the beneficiary's own balance is a second, independent check.
      if (verified && l1Reported && change + (ownTx ? l2 + l1 : 0n) !== paidOut) {
        verified = false;
        flags.push(`BENEFICIARY_BALANCE_MISMATCH(change ${change}, paid out ${paidOut})`);
      }
      if (!payoutProven)
        flags.push(`REPAYMENT_MISMATCH(EntryPoint paid ${paidOut}, actualGasCost ${actual})`);
    } else
      flags.push(
        'REPAYMENT_UNVERIFIABLE(isolation of the beneficiary, sender and EntryPoint in the block not proven)',
      );
  }
  const counted = verified && beneficiary === SUBMITTER ? repaid : 0n;
  if (!verified) totals.unverified += 1;
  const overhead = l2 + l1 - counted;
  totals.actual += actual;
  totals.l2 += l2;
  totals.l1 += l1;
  totals.repaid += counted;
  totals.overhead += overhead;
  console.log(
    [
      hash,
      big(r.blockNumber),
      r.status === '0x1' ? 'success' : 'REVERTED',
      events.length,
      flags.join(',') || '-',
      actual,
      l2,
      l1,
      beneficiary ?? '-',
      `${repaid} (${verified ? 'verified' : 'UNVERIFIED, not subtracted'})`,
      overhead,
    ].join(' | '),
  );
}
const deposit = await rpc('eth_call', [
  { to: ENTRY_POINT, data: `0x70a08231${PAYMASTER.slice(2).padStart(64, '0')}` },
  'latest',
]);
const float = await rpc('eth_getBalance', [SUBMITTER, 'latest']);
console.log(
  `TOTAL | deposit-funded actualGasCost ${totals.actual} (${eth(totals.actual)} ETH) | outer L2 ${totals.l2} | outer L1 ${totals.l1} | verified repayment ${totals.repaid} | net submitter overhead ${totals.overhead} (${eth(totals.overhead)} ETH) | unverified rows ${totals.unverified}`,
);
console.log(
  `TOTAL CONSUMED = actualGasCost + outer L2 + outer L1 - VERIFIED repayment = ${totals.actual + totals.overhead} wei (${eth(totals.actual + totals.overhead)} ETH); deploy/admin costs separate`,
);
console.log(
  `NOW | paymaster deposit ${big(deposit)} (${eth(big(deposit))} ETH) | submitter float ${big(float)} (${eth(big(float))} ETH)`,
);
