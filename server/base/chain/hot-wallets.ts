/*
 * Hot-balance ceilings for app-held wallets (audit CCA-706). Every app-held key sits in one
 * production trust boundary until signing moves to non-exportable keys, so what each of their
 * wallets holds is what a faulty or malicious deployment could move. Each role therefore has a
 * stated ceiling per asset:
 *
 *   sizeTopUp       sizes a top-up so the wallet ends at most at its ceiling (clamped), and refuses
 *                   one for a wallet already at or above it
 *   createHotWalletWatch().observe
 *                   called wherever the app already reads one of these balances: logs an ALERT
 *                   line when the balance is above its ceiling, and when the observed net balance
 *                   decrease between reads runs above the role's planned decrease per hour. This
 *                   is monitoring, not a full outflow record: inflows between reads can mask
 *                   spending (see createHotWalletWatch)
 *
 * Ceilings and hourly outflows are raw units (USDC 6 decimals, ETH wei). Defaults are below; each
 * can be set with CITY_HOT_CEILING_<ROLE>_<ASSET> and CITY_HOT_OUTFLOW_<ROLE>_<ASSET> (decimal raw
 * units, e.g. CITY_HOT_CEILING_SFP_SPONSOR_USDC=500000000). An unparsable value keeps the default.
 * Nothing here signs, sends or blocks a payment; top-ups are owner actions from the funding wallet.
 * The asset 'eth' is the role's gas balance: on Arc that is USDC at 18 decimals, shown as usdc-gas.
 */
import { BASE_MAINNET } from '../../../shared/base/chains.js';
import { chainParams, type ChainParams } from './chain-params.js';

export type HotWalletRole =
  | 'sfp_sponsor'
  | 'router3_facilitator'
  | 'public_settle'
  | 'public_offer'
  | 'paymaster_submitter'
  | 'paymaster_signer';
export type HotWalletAsset = 'usdc' | 'eth';

export interface HotWalletLimit {
  /** Most the wallet should hold (raw units). */
  ceiling: bigint;
  /** Planned net balance decrease per hour; observed faster decreases ALERT (raw units). */
  outflowPerHour: bigint;
}

export type HotWalletCeilings = Readonly<
  Record<HotWalletRole, Readonly<Partial<Record<HotWalletAsset, HotWalletLimit>>>>
>;

/** Base's stated defaults (chain-params.ts holds every chain's). */
export const DEFAULT_HOT_WALLET_CEILINGS: HotWalletCeilings = Object.freeze(
  chainParams(BASE_MAINNET).hotWallets,
);

const settingName = (
  kind: 'CEILING' | 'OUTFLOW',
  role: HotWalletRole,
  asset: HotWalletAsset,
  settings: ChainParams['settings'],
) =>
  `${settings.hotWalletPrefix}_${kind}_${role.toUpperCase()}_${
    asset === 'eth' ? settings.hotWalletGasAsset : asset.toUpperCase()
  }`;

const RAW = /^(0|[1-9][0-9]{0,40})$/;

/**
 * The ceilings of a chain (Base when none is named) with its overrides applied. An override is in
 * its chain's own units, so Arc's are settings of their own (CITY_ARC_HOT_*, its gas balance as GAS).
 */
export function hotWalletCeilingsFromEnv(
  env: Record<string, string | undefined>,
  chainId: number = BASE_MAINNET,
): HotWalletCeilings {
  const params = chainParams(chainId);
  const out = {} as Record<HotWalletRole, Partial<Record<HotWalletAsset, HotWalletLimit>>>;
  for (const [role, assets] of Object.entries(params.hotWallets) as [
    HotWalletRole,
    Partial<Record<HotWalletAsset, HotWalletLimit>>,
  ][]) {
    out[role] = {};
    for (const [asset, limit] of Object.entries(assets) as [HotWalletAsset, HotWalletLimit][]) {
      const ceiling = env[settingName('CEILING', role, asset, params.settings)]?.trim() ?? '';
      const outflow = env[settingName('OUTFLOW', role, asset, params.settings)]?.trim() ?? '';
      out[role][asset] = {
        ceiling: RAW.test(ceiling) ? BigInt(ceiling) : limit.ceiling,
        outflowPerHour: RAW.test(outflow) ? BigInt(outflow) : limit.outflowPerHour,
      };
    }
  }
  return out;
}

export interface TopUpSize {
  /** What to send (raw units); 0 when refused. */
  amount: bigint;
  /** The request was cut down to fit under the ceiling. */
  clamped: boolean;
  /** The wallet is already at or above its ceiling: no top-up. */
  refused: boolean;
}

/** Sizes a top-up so the wallet holds at most its ceiling afterwards. */
export function sizeTopUp(ceiling: bigint, balance: bigint, requested: bigint): TopUpSize {
  if (ceiling < 0n || balance < 0n || requested < 0n) throw new Error('Amounts are non-negative.');
  if (balance >= ceiling) return { amount: 0n, clamped: requested > 0n, refused: true };
  const room = ceiling - balance;
  return requested > room
    ? { amount: room, clamped: true, refused: false }
    : { amount: requested, clamped: false, refused: false };
}

/** The top-up for a role's wallet from the configured ceilings. */
export function topUpFor(
  ceilings: HotWalletCeilings,
  role: HotWalletRole,
  asset: HotWalletAsset,
  balance: bigint,
  requested: bigint,
): TopUpSize {
  const limit = ceilings[role]?.[asset];
  // A role or asset without a stated ceiling is never topped up.
  if (!limit) return { amount: 0n, clamped: requested > 0n, refused: true };
  return sizeTopUp(limit.ceiling, balance, requested);
}

const HOUR_MS = 3_600_000;
/** A previous read older than this is stale: the decrease since then is not charged to an hour. */
export const HOT_WALLET_STALE_MS = HOUR_MS;

export interface HotWalletObservation {
  /** The balance is above the role's ceiling. */
  aboveCeiling: boolean;
  /** The observed net decrease rate is above the role's planned hourly decrease. */
  decreaseAlert: boolean;
  /** The previous read was older than HOT_WALLET_STALE_MS: this read only sets a new baseline. */
  stale: boolean;
}

export interface HotWalletWatch {
  /** Records one balance read; may log lines. Never throws. */
  observe(
    role: HotWalletRole,
    asset: HotWalletAsset,
    balance: bigint,
    /** Another wallet of the role, tracked on its own so two balances never read as a decrease. */
    wallet?: string,
  ): HotWalletObservation;
}

/**
 * Watches balances the app already reads. This is MONITORING of the observed net balance decrease
 * between reads, not a record of every transaction outflow: an inflow (a top-up) between two reads
 * masks spending in the same interval, and nothing between reads is seen. It narrows, it does not
 * close, CCA-706 (the KMS/HSM move and owner-side limits stay open).
 *
 * Each read is stored with its time. A decrease between two reads at most HOT_WALLET_STALE_MS apart
 * is recorded over that interval; the rate is the sum of the decreases whose interval ended in the
 * last hour, divided by the time they span (at least one hour), and an ALERT is logged when it is
 * above the role's planned decrease per hour. A read whose previous read is older than that is
 * stale: its decrease is not charged to the current hour (it is reported as stale instead), and it
 * becomes the new baseline. An increase is never counted as negative spend.
 *
 * Each kind of line (above ceiling, decrease, stale) is logged at most once an hour per role and
 * asset, so a busy wallet is one line, not a flood.
 */
export function createHotWalletWatch(deps: {
  ceilings: HotWalletCeilings;
  log: (line: string) => void;
  now?: () => number;
  /** The chain whose wallets these are, for what a log line calls the gas balance (Base). */
  chainId?: number;
}): HotWalletWatch {
  const now = deps.now ?? Date.now;
  const gasLabel = chainParams(deps.chainId ?? BASE_MAINNET).gasLabel;
  const last = new Map<string, { balance: bigint; at: number }>();
  const drops = new Map<string, { from: number; at: number; amount: bigint }[]>();
  const alerted = new Map<string, number>();
  const once = (key: string, line: string, at: number) => {
    const previous = alerted.get(key);
    if (previous !== undefined && at - previous < HOUR_MS) return;
    alerted.set(key, at);
    deps.log(line);
  };
  const quiet: HotWalletObservation = { aboveCeiling: false, decreaseAlert: false, stale: false };
  return {
    observe(role, asset, balance, wallet) {
      try {
        const limit = deps.ceilings[role]?.[asset];
        if (!limit || typeof balance !== 'bigint') return { ...quiet };
        const key = wallet ? `${role}:${asset}:${wallet}` : `${role}:${asset}`;
        const shown = asset === 'eth' ? gasLabel : asset;
        const at = now();
        const aboveCeiling = balance > limit.ceiling;
        if (aboveCeiling)
          once(
            `${key}:ceiling`,
            `hot wallet: ALERT ${role} ${shown} balance ${balance} above its ceiling ${limit.ceiling}`,
            at,
          );
        const previous = last.get(key);
        last.set(key, { balance, at });
        const stale = previous !== undefined && at - previous.at > HOT_WALLET_STALE_MS;
        if (stale)
          once(
            `${key}:stale`,
            `hot wallet: ${role} ${shown} previous read is ${Math.round((at - previous!.at) / 1000)} s old (stale); its net decrease is not charged to the last hour`,
            at,
          );
        const window = (drops.get(key) ?? []).filter((d) => at - d.at < HOUR_MS);
        if (previous !== undefined && !stale && balance < previous.balance)
          window.push({ from: previous.at, at, amount: previous.balance - balance });
        drops.set(key, window);
        let decreaseAlert = false;
        if (window.length) {
          const lost = window.reduce((sum, d) => sum + d.amount, 0n);
          const span = Math.max(at - Math.min(...window.map((d) => d.from)), HOUR_MS);
          // lost / span > outflowPerHour / hour, in integers.
          decreaseAlert = lost * BigInt(HOUR_MS) > limit.outflowPerHour * BigInt(span);
          if (decreaseAlert)
            once(
              `${key}:outflow`,
              `hot wallet: ALERT ${role} ${shown} observed net balance decrease ${lost} over ${Math.round(span / 1000)} s between reads, above its planned ${limit.outflowPerHour} per hour`,
              at,
            );
        }
        return { aboveCeiling, decreaseAlert, stale };
      } catch {
        // A watch never breaks the read it observes.
        return { ...quiet };
      }
    },
  };
}
