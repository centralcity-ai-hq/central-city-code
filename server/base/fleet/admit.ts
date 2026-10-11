import type { Hex } from 'viem';
import type { Database } from '../../database.js';
import { verifyRunAuthorization, type RunIntent, type VerifyRunDeps } from '../chain/runs.js';
import { createReservationLedger, type ReservationDeps } from '../chain/reservations.js';
import type { ManifestEntry } from '../../../shared/base/manifest.js';
import type { Address } from '../../../shared/base/chains.js';
import { lockFleetWallets } from './wallet-locks.js';
import { bindFleetManifest } from './manifest-binding.js';
import { fleetWindowOpen } from './window.js';
import { holdFleetFee } from './fee-hold.js';
import { snapshotFleetPricing } from './pricing.js';

export interface FleetAdmission {
  workspaceId: string;
  jobId: string;
  treasuryWalletId: string;
  intent: RunIntent;
  signature: Hex;
  manifest: readonly ManifestEntry[];
  /** Server planner output, never arbitrary request-supplied execution data. */
  batch: {
    operationKey: string;
    intentHash: string;
    principal: readonly { token: Address; amount: bigint }[];
    maxCostWei: bigint;
  };
  providerPricing: string;
  registrationMode: 'lazy' | 'immediate';
}

/** Initial job/first-batch accounting only. Does not authorize broadcasting or later batches.
 * Replays refuse; reconcile the durable job instead. Every thrown error rolls back all holds.
 */
export async function admitFleetRun(
  deps: {
    db: Database;
    client: VerifyRunDeps['client'];
    network: VerifyRunDeps['network'];
    balanceOf: ReservationDeps['balanceOf'];
    now?: () => number;
  },
  input: FleetAdmission,
): Promise<{ jobId: string; intentHash: Hex; feeHeld: bigint }> {
  const now = deps.now ?? Date.now;
  // Snapshot the planner's primitive data before any asynchronous validation.
  const { workspaceId, jobId, treasuryWalletId, signature, registrationMode, providerPricing } =
    input;
  const batch = input.batch;
  const allocations = batch.principal;
  const sourceManifest = input.manifest;
  const { operationKey, intentHash: batchHash, maxCostWei } = batch;
  if (
    ![workspaceId, jobId, treasuryWalletId, operationKey, batchHash].every(
      (v) => typeof v === 'string' && v.length > 0 && v.length <= 128,
    ) ||
    !['lazy', 'immediate'].includes(registrationMode) ||
    !Array.isArray(allocations) ||
    typeof maxCostWei !== 'bigint' ||
    maxCostWei < 0n ||
    maxCostWei >= 2n ** 256n
  )
    throw new Error('Invalid fleet admission.');
  const principal: { token: Address; amount: bigint }[] = [];
  const seen = new Set<string>();
  for (let index = 0, length = allocations.length; index < length; index++) {
    const { token, amount } = allocations[index];
    if (
      typeof token !== 'string' ||
      typeof amount !== 'bigint' ||
      amount <= 0n ||
      seen.has(token.toLowerCase())
    )
      throw new Error('Invalid fleet principal allocation.');
    seen.add(token.toLowerCase());
    principal.push({ token: token.toLowerCase() as Address, amount });
  }
  if (!principal.length) throw new Error('Empty fleet principal allocation.');
  const pricing = snapshotFleetPricing(providerPricing);
  // Capture manifest primitives now; binding below validates its signed hash under wallet locks.
  const manifest: ManifestEntry[] = [];
  if (!Array.isArray(sourceManifest)) throw new Error('Invalid fleet manifest.');
  for (let index = 0, length = sourceManifest.length; index < length; index++) {
    const { ordinal, agentId, owner, wallet, derivationVersion } = sourceManifest[index];
    if (
      typeof ordinal !== 'number' ||
      typeof agentId !== 'string' ||
      typeof owner !== 'string' ||
      typeof wallet !== 'string' ||
      typeof derivationVersion !== 'number'
    )
      throw new Error('Invalid fleet manifest.');
    manifest.push({ ordinal, agentId, owner, wallet, derivationVersion });
  }
  const checked = await verifyRunAuthorization(
    {
      client: deps.client,
      network: deps.network,
      nonceUsed: async () => false,
      now: () => Math.floor(now() / 1000),
    },
    input.intent,
    signature,
  );
  if (!checked.ok) throw new Error(`Fleet run rejected: ${checked.reason}.`);
  const signed = checked.intent;
  if (signed.workspaceId !== workspaceId) throw new Error('Fleet workspace mismatch.');
  const ledger = createReservationLedger({
    chainId: signed.chainId,
    balanceOf: deps.balanceOf,
    now,
  });
  return deps.db.transaction(async (tx) => {
    await lockFleetWallets(
      tx,
      workspaceId,
      signed.chainId,
      treasuryWalletId,
      manifest.map((e) => e.agentId),
    );
    const treasury = (
      await tx.query<{ address: string; state: string }>(
        'SELECT address, state FROM base_wallets WHERE wallet_id=$1 AND operator_id=$2 AND chain_id=$3',
        [treasuryWalletId, workspaceId, signed.chainId],
      )
    ).rows[0];
    if (!treasury || treasury.address.toLowerCase() !== signed.treasury.toLowerCase())
      throw new Error('Fleet treasury mismatch.');
    if (!['derived', 'deployed'].includes(treasury.state))
      throw new Error('Fleet treasury is not active.');
    await bindFleetManifest(tx, workspaceId, signed.chainId, manifest, signed.manifestHash);
    const used = await tx.query(
      'SELECT job_id FROM base_fleet_jobs WHERE operator_id=$1 AND run_nonce=$2',
      [workspaceId, signed.nonce.toString()],
    );
    if (used.rows.length) throw new Error('Fleet nonce already used.');
    const assertWindow = () => {
      if (!fleetWindowOpen(signed.notBefore, signed.expiry, now()))
        throw new Error('Fleet run window closed.');
    };
    assertWindow();
    const at = now();
    // Unique (operator_id, run_nonce) also arbitrates races involving different treasuries.
    await tx.query(
      `INSERT INTO base_fleet_jobs(job_id,operator_id,chain_id,treasury_wallet_id,run_nonce,intent_hash,intent,signature,manifest_hash,registration_mode,expires_at,state,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'running',$12,$12)`,
      [
        jobId,
        workspaceId,
        signed.chainId,
        treasuryWalletId,
        signed.nonce.toString(),
        checked.intentHash,
        JSON.stringify(signed, (_key, value) =>
          typeof value === 'bigint' ? value.toString() : value,
        ),
        Buffer.from(signature.slice(2), 'hex'),
        signed.manifestHash,
        registrationMode,
        (BigInt(signed.expiry) * 1000n).toString(),
        at,
      ],
    );
    for (const cap of signed.principal)
      await tx.query(
        'INSERT INTO base_fleet_token_budgets(job_id,token,principal_ceiling) VALUES($1,$2,$3)',
        [jobId, cap.token.toLowerCase(), cap.amount.toString()],
      );
    await tx.query(
      `INSERT INTO base_fleet_fee_budgets(job_id,ceiling_wei,provider_pricing_version,provider_terms) VALUES($1,$2,$3,$4)`,
      [jobId, signed.feeCeilingWei.toString(), pricing.version, JSON.stringify(pricing.terms)],
    );
    await tx.query(
      `INSERT INTO base_fleet_batches(job_id,batch_no,operation_key,intent_hash,state,created_at,updated_at) VALUES($1,0,$2,$3,'pending',$4,$4)`,
      [jobId, operationKey, batchHash, at],
    );
    for (const allocation of principal) {
      const cap = signed.principal.find((p) => p.token.toLowerCase() === allocation.token);
      if (!cap || allocation.amount > cap.amount)
        throw new Error('Fleet principal ceiling exceeded.');
      const reservation = await ledger.reserve(tx, {
        walletId: treasuryWalletId,
        chainId: signed.chainId,
        token: allocation.token,
        amount: allocation.amount,
        holder: { kind: 'fleet_job', ref: `${jobId}:0` },
        intentHash: batchHash,
      });
      await tx.query(
        'UPDATE base_fleet_token_budgets SET principal_reserved=$3 WHERE job_id=$1 AND token=$2',
        [jobId, allocation.token, allocation.amount.toString()],
      );
      await tx.query(
        `INSERT INTO base_fleet_batch_allocations(job_id,batch_no,token,reserved_principal,reservation_id) VALUES($1,0,$2,$3,$4)`,
        [jobId, allocation.token, allocation.amount.toString(), reservation.reservationId],
      );
    }
    const feeHeld = await holdFleetFee(
      tx,
      {
        jobId,
        workspaceId,
        chainId: signed.chainId,
        batchNo: 0,
        operationKey,
        intentHash: batchHash,
        maxCostWei,
      },
      now,
    );
    assertWindow();
    return { jobId, intentHash: checked.intentHash, feeHeld };
  });
}
