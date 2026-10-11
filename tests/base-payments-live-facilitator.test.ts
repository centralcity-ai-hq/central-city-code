import assert from 'node:assert/strict';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createPublicClient, getAddress, http, type Hex } from 'viem';
import { baseSepolia } from 'viem/chains';
import { BASE_SEPOLIA, baseNetwork } from '../shared/base/chains.js';
import { exactPaymentPayload, facilitatorClient } from '../server/base/chain/x402-facilitator.js';
import type { IssuedAuthorization } from '../server/base/chain/x402.js';
import { receivePaymentProven } from '../server/base/payments/receive-evidence.js';

/** Base finalizes a block roughly 15-20 minutes after inclusion; the gate waits up to this long. */
const FINALITY_WAIT_MS = 30 * 60_000;
const FINALITY_POLL_MS = 10_000;

// Private fixture: a persisted IssuedAuthorization with bigint fields encoded as decimal strings.
// Never generate/sign here. The journal is exclusive and must survive ambiguous settlement.
test(
  'live facilitator: persisted smart-wallet authorization settles on Base Sepolia',
  {
    skip: process.env.BASE_X402_LIVE !== 'sepolia-only',
    // Settlement and receipt (about 3 minutes) plus the wait for Base to finalize the block.
    timeout: 180_000 + FINALITY_WAIT_MS,
  },
  async () => {
    let stage = 'config';
    let reason = 'unspecified';
    const safeReason = (value: string) =>
      [
        'invalid_signature',
        'insufficient_funds',
        'invalid_network',
        'invalid_scheme',
        'invalid_payload',
        'invalid_exact_evm_payload_authorization_valid_before',
        'invalid_exact_evm_payload_authorization_valid_after',
      ].includes(value)
        ? value
        : 'unrecognized_reason';
    try {
      const required = (key: string) => {
        const value = process.env[key];
        if (!value) throw new Error('Missing private live-gate configuration');
        return value;
      };
      const endpoint = new URL(required('BASE_X402_FACILITATOR_URL'));
      assert.equal(endpoint.protocol, 'https:');
      const journal = resolve(required('BASE_X402_JOURNAL'));
      const root = await realpath(fileURLToPath(new URL('..', import.meta.url)));
      const parent = await realpath(dirname(journal));
      const location = relative(root, parent);
      assert.ok(
        isAbsolute(location) || location === '..' || location.startsWith(`..${sep}`),
        'Journal must be outside the repository',
      );
      const raw = JSON.parse(await readFile(required('BASE_X402_FIXTURE'), 'utf8'));
      assert.equal(raw.chainId, BASE_SEPOLIA);
      assert.equal(typeof raw.paymentIntentId, 'string');
      const decimal = (value: unknown) => {
        assert.equal(typeof value, 'string');
        assert.match(value as string, /^(0|[1-9][0-9]{0,77})$/);
        return BigInt(value as string);
      };
      const a = raw.authorization;
      assert.match(a.nonce, /^0x[0-9a-fA-F]{64}$/);
      assert.match(raw.signature, /^0x(?:[0-9a-fA-F]{2})+$/);
      assert.ok(raw.signature.length > 132, 'Require smart-wallet wrapped signature');
      const issued: IssuedAuthorization = {
        paymentIntentId: raw.paymentIntentId,
        chainId: BASE_SEPOLIA,
        token: getAddress(raw.token),
        signature: raw.signature as Hex,
        authorization: {
          from: getAddress(a.from),
          to: getAddress(a.to),
          nonce: a.nonce,
          value: decimal(a.value),
          validAfter: decimal(a.validAfter),
          validBefore: decimal(a.validBefore),
        },
      };
      const cap = decimal(required('BASE_X402_MAX_ATOMIC'));
      assert.ok(issued.authorization.value > 0n && issued.authorization.value <= cap);
      assert.equal(issued.authorization.to, getAddress(required('BASE_X402_RECIPIENT')));
      stage = 'rpc';
      const client = createPublicClient({
        chain: baseSepolia,
        transport: http(required('BASE_X402_RPC_URL')),
      });
      assert.equal(await client.getChainId(), BASE_SEPOLIA);
      assert.ok((await client.getCode({ address: issued.authorization.from }))?.length! > 2);
      const now = (await client.getBlock()).timestamp;
      assert.ok(issued.authorization.validAfter < now && issued.authorization.validBefore > now);
      const network = baseNetwork(BASE_SEPOLIA)!;
      const requirements = {
        scheme: 'exact',
        network: `eip155:${BASE_SEPOLIA}`,
        amount: issued.authorization.value.toString(),
        asset: issued.token,
        payTo: issued.authorization.to,
        maxTimeoutSeconds: 60,
        extra: { assetTransferMethod: 'eip3009', ...network.tokens.USDC.eip712 },
      };
      const payload = exactPaymentPayload(network, requirements, issued);
      const serialized = JSON.stringify(payload);
      const facilitator = facilitatorClient({
        url: endpoint.href,
        fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }),
      });
      stage = 'verify';
      const verification = await facilitator.verify(payload, requirements);
      if (verification.kind === 'invalid') reason = safeReason(verification.reason);
      assert.equal(verification.kind, 'valid');
      if (verification.kind === 'valid' && verification.payer !== null)
        assert.equal(getAddress(verification.payer), issued.authorization.from);
      // Persist BEFORE /settle. A rerun refuses rather than resending after an unknown outcome.
      stage = 'journal';
      await writeFile(
        journal,
        JSON.stringify({ state: 'attempted', paymentIntentId: issued.paymentIntentId }),
        { flag: 'wx', mode: 0o600 },
      );
      stage = 'settle';
      const settlement = await facilitator.settle(payload, requirements);
      if (settlement.kind === 'refused') reason = safeReason(settlement.reason);
      assert.equal(JSON.stringify(payload), serialized);
      await writeFile(
        journal,
        JSON.stringify({ paymentIntentId: issued.paymentIntentId, ...settlement }),
        { mode: 0o600 },
      );
      assert.ok(settlement.kind === 'settled' || settlement.kind === 'pending');
      if (settlement.kind !== 'settled' && settlement.kind !== 'pending') return;
      // Timeout means reconcile the journal's transaction hash, never retry settlement.
      stage = 'receipt';
      const receipt = await client.waitForTransactionReceipt({
        hash: settlement.transaction,
        confirmations: network.confirmations,
        timeout: 120_000,
      });
      // A receipt a few confirmations deep is not final yet: wait until Base has finalized its
      // block. Running out of time is inconclusive like any other failure here (journal kept).
      stage = 'finality';
      const deadline = Date.now() + FINALITY_WAIT_MS;
      let finalized = await client.getBlock({ blockTag: 'finalized' });
      while (finalized.number < receipt.blockNumber) {
        assert.ok(Date.now() < deadline, 'block not finalized in time');
        await new Promise((done) => setTimeout(done, FINALITY_POLL_MS));
        finalized = await client.getBlock({ blockTag: 'finalized' });
      }
      stage = 'direct-finalized-proof';
      // Read again at finality: the proof needs the receipt and block that are canonical now.
      const finalReceipt = await client.getTransactionReceipt({ hash: settlement.transaction });
      const directCall = await client.getTransaction({ hash: settlement.transaction });
      const canonical = await client.getBlock({ blockNumber: finalReceipt.blockNumber });
      // A shallow receipt is still inconclusive: retain the journal, never settle again.
      assert.ok(
        receivePaymentProven(
          {
            workspaceId: 'live-gate',
            resource: 'live-gate',
            chainId: BASE_SEPOLIA,
            token: issued.token,
            payer: issued.authorization.from,
            recipient: issued.authorization.to,
            nonce: issued.authorization.nonce,
            amount: issued.authorization.value.toString(10),
          },
          {
            chainId: await client.getChainId(),
            transaction: settlement.transaction,
            receipt: finalReceipt,
            directCall,
            canonicalBlockHash: canonical.hash,
            finalizedBlock: finalized.number,
          },
        ),
      );
    } catch {
      // RPC and facilitator errors can contain URLs, credentials or signed authorizations.
      throw new Error(
        `Live facilitator gate failed at ${stage} (${reason}); retain private journal and reconcile before any retry.`,
      );
    }
  },
);
