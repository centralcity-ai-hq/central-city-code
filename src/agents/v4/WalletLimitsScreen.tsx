import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from 'react';
import { ApiError } from '../../api';
import { readWallet } from '../../base/wallet/api';
import {
  askRevoke,
  capFromText,
  checkLimit,
  checkRevoke,
  currentLimit,
  LimitCheckError,
  limitText,
  PERIOD_WORDS,
  prepareLimit,
  readLimits,
  signLimit,
  signRevoke,
  usdcText,
  type CheckedLimit,
  type LimitPeriod,
  type LimitsView,
  type LimitView,
  type OnchainCapModel,
  pinSpender,
  readSpenderPin,
} from '../../base/wallet/limits';
import { VaultCryptoError } from '../../base/vault';
import { AgentPayConsent } from './AgentPayConsent';
import type { AgentScreenProps } from './screens';
import { SettingsEmpty, SettingsError, SettingsFrame, SettingsLoading } from './settingsShared';
import './wallet-screen.css';

/*
 * An agent's spending limit (Operation Base Wallet W3). The owner chooses a cap and a period; the
 * server prepares the spend permission; this browser checks it is exactly that limit for this
 * wallet (src/base/wallet/limits.ts) and only then asks for the wallet password to sign it. Base
 * enforces the signed permission and nothing else; Central City's calendar counter is shown as a
 * count, never as protection. A limit starts at 00:00 Berlin today, so it works at once. A revoke
 * blocks the agent's spends at once in Central City and is "revoked" only once Base shows it so.
 * Under an active limit, "Paying on its own" (AgentPayConsent) is the owner's separate permission
 * for the agent to pay within it without asking each time.
 */

const POLL_MS = 5_000;
const PERIODS: readonly LimitPeriod[] = ['day', 'week', 'month'];
const BASE_PERIOD: Record<LimitPeriod, string> = {
  day: 'Base day',
  week: 'Base week',
  month: 'Base month',
};
const USED: Record<LimitPeriod, string> = {
  day: 'Used today',
  week: 'Used this week',
  month: 'Used this month',
};
const RESETS: Record<LimitPeriod, string> = {
  day: 'at midnight (Berlin time)',
  week: 'on Monday at midnight (Berlin time)',
  month: 'on the 1st at midnight (Berlin time)',
};
/** Revokes on their way to Base: the view is read again until Base shows the limit revoked. */
const ON_ITS_WAY = new Set(['submitted', 'included', 'final']);

type Phase =
  | { k: 'loading' }
  | { k: 'error'; message: string }
  | { k: 'off' }
  | { k: 'none' }
  | { k: 'ready' }
  | { k: 'review'; checked: CheckedLimit };

const failure = (error: unknown) =>
  error instanceof LimitCheckError
    ? `Not signed: ${error.message}`
    : error instanceof VaultCryptoError || error instanceof ApiError || error instanceof Error
      ? error.message
      : 'Something went wrong. Try again.';

const berlin = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Berlin',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});
const berlinTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Berlin',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
/** "Sun 11 Oct" in Berlin, from unix seconds. */
const day = (seconds: number) => berlin.format(seconds * 1000);
/** "Sun 11 Oct, 00:00" in Berlin, from unix seconds. */
const moment = (seconds: number) => berlinTime.format(seconds * 1000);

/** What Base enforces, in the owner's words: half the cap (no burst past it) or the full cap. */
function enforced(
  model: OnchainCapModel,
  allowance: bigint | string,
  cap: bigint | string,
  period: LimitPeriod,
  name: string,
) {
  const per = `${usdcText(allowance)} USDC per ${BASE_PERIOD[period]}`;
  return model === 'half'
    ? `Base enforces ${per}, so even around ${period === 'day' ? 'midnight' : 'a reset'} ${name} stays within ${usdcText(cap)}.`
    : `Base enforces ${per}; around a reset ${name} could spend up to ${usdcText(allowance)} just before and ${usdcText(allowance)} just after.`;
}

/** When Base's periods start: fixed lengths from 00:00 Berlin on the day it is signed. */
function baseStarts(period: LimitPeriod, start: number) {
  if (period === 'day') return `Base days start at 00:00 Berlin time (${day(start)}).`;
  if (period === 'week')
    return `Base weeks start at 00:00 Berlin time (${day(start)}) and last 7 days.`;
  return `Base months start at 00:00 Berlin time (${day(start)}) and last 31 days.`;
}

function stateLine(limit: LimitView, name: string) {
  if (limit.state === 'signed') return 'Signed · waiting for its first use on Base.';
  if (limit.state === 'approved') return 'Approved on Base.';
  if (limit.state === 'revoked') return 'Revoked on Base.';
  // Base itself says revoked once the revoke is in a block; "final" waits for Base's finality.
  if (limit.revoke && ON_ITS_WAY.has(limit.revoke.state))
    return limit.onchain?.revoked
      ? `Revoked on Base. ${name}’s spends are blocked; Base makes it final in about 15–20 minutes.`
      : `Revoking… ${name}’s spends are blocked now; the revoke is on its way to Base.`;
  return `${name}’s spends are blocked here. Sign the revoke so Base stops it too.`;
}

/** Whether the owner can (still) sign a revoke for this limit. */
const canRevoke = (limit: LimitView) =>
  limit.state === 'signed' ||
  limit.state === 'approved' ||
  (limit.state === 'revoke_pending' && !(limit.revoke && ON_ITS_WAY.has(limit.revoke.state)));

/** Base's period, read at one block; when Base couldn't be read, no numbers at all. */
function BasePeriod({
  limit,
  view,
  onRetry,
}: {
  limit: LimitView;
  view: LimitsView;
  onRetry: () => void;
}) {
  const onchain = limit.onchain;
  if (view.stale || !onchain)
    return (
      <p className="w4-caution" role="status" data-k="base-unread">
        <b>Couldn’t read Base just now.</b>{' '}
        <button type="button" className="v4s-quiet" onClick={onRetry}>
          Try again
        </button>
      </p>
    );
  // The block Base was read at for these numbers (not the block of any one transaction).
  const block = `read at block ${onchain.readAtBlock.toLocaleString('en-US')}`;
  return (
    <div className="ap4-group" data-k="base-period">
      {onchain.revoked ? (
        <div className="ap4-row v4s-still">
          <span className="ap4-k">
            On Base<span className="w4-row-sub">{block}</span>
          </span>
          <span className="ap4-v">Revoked</span>
        </div>
      ) : onchain.phase === 'active' && onchain.currentPeriodEnd !== null ? (
        <div className="ap4-row v4s-still">
          <span className="ap4-k">
            This {BASE_PERIOD[limit.period]}
            <span className="w4-row-sub">
              Until {moment(onchain.currentPeriodEnd)} · {block}
            </span>
          </span>
          <span className="ap4-v">
            {usdcText(onchain.spentRaw)} spent · {usdcText(onchain.leftRaw)} left
          </span>
        </div>
      ) : onchain.phase === 'before_start' ? (
        <div className="ap4-row v4s-still">
          <span className="ap4-k">
            Base starts counting<span className="w4-row-sub">{block}</span>
          </span>
          <span className="ap4-v">{moment(onchain.start)}</span>
        </div>
      ) : (
        <div className="ap4-row v4s-still">
          <span className="ap4-k">
            On Base<span className="w4-row-sub">{block}</span>
          </span>
          <span className="ap4-v">Ended</span>
        </div>
      )}
    </div>
  );
}

/** The limit in force: the cap, what Base enforces, the calendar count, Base's period, the state. */
function LimitCard({
  limit,
  view,
  name,
  onRetry,
  stateRef,
}: {
  limit: LimitView;
  view: LimitsView;
  name: string;
  onRetry: () => void;
  /** The state line, where focus goes when the section under the card goes away. */
  stateRef: RefObject<HTMLParagraphElement | null>;
}) {
  const cap = BigInt(limit.capRaw);
  const spent = BigInt(limit.calendar.spentRaw);
  const share = cap > 0n ? Math.min(100, Number((spent * 10_000n) / cap) / 100) : 0;
  return (
    <>
      <div className="w4-limit" data-k="limit-card" data-state={limit.state}>
        {/* A ceiling, not a permission: paying on its own is the owner's separate OK below. */}
        <p className="w4-eyebrow">
          The most {name} may spend
          <span className={`w4-net${view.testnet ? '' : ' live'}`}>
            {view.testnet ? 'Test network · no real money' : 'Base'}
          </span>
        </p>
        <p className="w4-limit-cap">
          <b>{usdcText(cap)}</b> USDC {PERIOD_WORDS[limit.period]}
        </p>
        <p className="w4-hint">
          {enforced(limit.onchainModel, limit.allowanceRaw, cap, limit.period, name)}
        </p>
        <p
          ref={stateRef}
          className="w4-state"
          data-state={limit.state}
          data-k="limit-state"
          role="status"
          tabIndex={-1}
        >
          {stateLine(limit, name)}
        </p>
      </div>
      <div className="w4-usage" data-k="calendar">
        <p>
          {USED[limit.period]}: {usdcText(spent)} of {usdcText(cap)} · resets {RESETS[limit.period]}
        </p>
        <div
          className="w4-bar"
          role="meter"
          aria-label={USED[limit.period]}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(share)}
        >
          <i style={{ width: `${share}%` }} data-full={share >= 100 || undefined} />
        </div>
      </div>
      <BasePeriod limit={limit} view={view} onRetry={onRetry} />
    </>
  );
}

export function WalletLimitsScreen({ agent, onBack, backLabel }: AgentScreenProps) {
  const [phase, setPhase] = useState<Phase>({ k: 'loading' });
  const [view, setView] = useState<LimitsView | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [owner, setOwner] = useState('');
  const [spender, setSpender] = useState<string | null>(null);
  const [newKeyOk, setNewKeyOk] = useState(false);
  const [cap, setCap] = useState('');
  const [period, setPeriod] = useState<LimitPeriod>('day');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const revokeHeading = useId();
  // As on the withdraw screen: the typed password goes when the page is hidden or left, after
  // 5 minutes without input, or when the screen closes; a signature made meanwhile isn't sent.
  const session = useRef(0);
  const lock = useCallback(() => {
    session.current += 1;
    setPassword('');
  }, []);
  useEffect(
    () => () => {
      session.current += 1;
    },
    [],
  );
  const guarded = password !== '' || busy;
  useEffect(() => {
    if (!guarded) return;
    let last = Date.now();
    const touch = () => {
      last = Date.now();
    };
    const hidden = () => {
      if (document.visibilityState === 'hidden') lock();
    };
    const idle = window.setInterval(() => {
      if (Date.now() - last >= 5 * 60_000) lock();
    }, 5_000);
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', lock);
    window.addEventListener('pointerdown', touch, true);
    window.addEventListener('keydown', touch, true);
    return () => {
      window.clearInterval(idle);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', lock);
      window.removeEventListener('pointerdown', touch, true);
      window.removeEventListener('keydown', touch, true);
    };
  }, [guarded, lock]);
  const alive = () => {
    const started = session.current;
    return () => session.current === started;
  };

  const load = useCallback(async () => {
    setPhase({ k: 'loading' });
    try {
      const [wallet, limits] = await Promise.all([readWallet(agent.id), readLimits(agent.id)]);
      if (limits.kind === 'off' || wallet.kind === 'off') return setPhase({ k: 'off' });
      if (wallet.kind === 'none') return setPhase({ k: 'none' });
      // Base not answering: the wallet's address is read again when it is needed to sign.
      setAddress(wallet.kind === 'wallet' ? wallet.wallet.address : null);
      setView(limits.view);
      setPhase({ k: 'ready' });
    } catch (err) {
      setPhase({ k: 'error', message: failure(err) });
    }
  }, [agent.id]);
  useEffect(() => {
    void load();
  }, [load]);

  /** Reads the limits again in place (what is shown stays when the read fails). */
  const refresh = useCallback(async () => {
    try {
      const read = await readLimits(agent.id);
      if (read.kind === 'limits') setView(read.view);
    } catch {
      // Not answered: the next read tries again.
    }
  }, [agent.id]);

  // "Paying on its own" found the limit changed and the limits were read again for it. If that
  // section went away meanwhile (the limit is no longer active) with focus in it, focus goes to
  // what is there now: the card's state line, or the lead when there is no limit at all.
  const limitState = useRef<HTMLParagraphElement>(null);
  const lead = useRef<HTMLParagraphElement>(null);
  const [limitsReread, setLimitsReread] = useState(0);
  useEffect(() => {
    if (!limitsReread) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    (limitState.current ?? lead.current)?.focus();
  }, [limitsReread]);
  const rereadForConsent = useCallback(() => {
    void refresh().then(() => setLimitsReread((count) => count + 1));
  }, [refresh]);

  /** The agent's wallet address, the one the limit must be for. */
  async function walletOf(): Promise<{ address: string; owner: string; spender: string | null }> {
    if (address && owner) return { address, owner, spender };
    const read = await readWallet(agent.id);
    if (read.kind !== 'wallet' || !read.wallet.address)
      throw new Error('The wallet can’t be read right now, so nothing can be checked. Try again.');
    setAddress(read.wallet.address);
    setOwner(read.wallet.ownerAddress);
    setSpender(read.wallet.spenderAddress ?? null);
    return {
      address: read.wallet.address,
      owner: read.wallet.ownerAddress,
      spender: read.wallet.spenderAddress ?? null,
    };
  }

  /** The pinned key, when this limit's spender differs from it (else null). */
  const spenderChanged = (checked: CheckedLimit) => {
    const pinned = readSpenderPin(checked.permission.account);
    return pinned && pinned !== checked.permission.spender ? pinned : null;
  };

  const limit = view ? currentLimit(view) : null;
  // While a revoke is on its way, Base is read again until it shows the limit revoked.
  const polling =
    phase.k === 'ready' && limit?.state === 'revoke_pending' && !canRevoke(limit)
      ? limit.permissionId
      : null;
  useEffect(() => {
    if (!polling) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [polling, refresh]);

  async function prepare(event: FormEvent) {
    event.preventDefault();
    setError('');
    const capRaw = capFromText(cap);
    if (!capRaw) return setError('Type an amount in USDC with up to 2 decimals, like 20.00.');
    setBusy(true);
    try {
      const { address: wallet, owner: ownerKey, spender: spendingKey } = await walletOf();
      const prepared = await prepareLimit(agent.id, { capRaw, period });
      // Checked here, before the owner is even asked: the permission is exactly this limit.
      const checked = checkLimit({
        prepared,
        wallet,
        owner: ownerKey,
        agentId: agent.id,
        spender: spendingKey,
        capRaw,
        period,
      });
      setNewKeyOk(false);
      setPhase({ k: 'review', checked });
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  }

  async function signReview(event: FormEvent) {
    event.preventDefault();
    if (phase.k !== 'review' || (spenderChanged(phase.checked) && !newKeyOk)) return;
    setError('');
    setBusy(true);
    try {
      // Marked first: if the password goes while the wallet is read, nothing is sent.
      const mark = alive();
      const { owner: ownerKey } = await walletOf();
      // The owner saw this spending key and signs for it: it is kept (and read back) before the
      // signature leaves, so later limits here are held to it even if this answer is lost.
      const { account, spender: confirmed } = phase.checked.permission;
      await signLimit(agent.id, phase.checked, password, mark, ownerKey, () =>
        pinSpender(account, confirmed),
      );
      setPassword('');
      setCap('');
      await load();
    } catch (err) {
      setPassword('');
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(event: FormEvent) {
    event.preventDefault();
    if (!limit) return;
    setError('');
    setBusy(true);
    // Marked before anything else: if the password goes while the revoke is asked, nothing is sent.
    const mark = alive();
    try {
      const { address: wallet, owner: ownerKey } = await walletOf();
      // The server blocks the agent's spends now and answers the operation to sign.
      const asked = await askRevoke(agent.id, limit.permissionId);
      if (asked.revokeState === 'awaiting_signature') {
        const hash = checkRevoke({
          request: asked,
          wallet,
          owner: ownerKey,
          agentId: agent.id,
          limit,
        });
        await signRevoke(agent.id, limit.permissionId, hash, password, mark, ownerKey);
      }
      setPassword('');
    } catch (err) {
      // Already on its way, or already revoked on Base: the view below says which.
      if (
        err instanceof ApiError &&
        (err.code === 'revoke_in_progress' || err.code === 'already_revoked')
      )
        setPassword('');
      else {
        setPassword('');
        setError(failure(err));
      }
    } finally {
      await refresh();
      setBusy(false);
    }
  }

  const passwordField = (
    <label className="w4-field">
      <span>Wallet password</span>
      <input
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
    </label>
  );
  const errorLine = error ? (
    <p className="w4-error" role="alert">
      {error}
    </p>
  ) : null;
  const last = view?.limits[0];

  return (
    <SettingsFrame
      backLabel={backLabel ?? 'Wallet'}
      onBack={onBack}
      title={phase.k === 'review' ? 'Check and sign' : 'Spending limit'}
    >
      {phase.k === 'loading' ? (
        <SettingsLoading />
      ) : phase.k === 'error' ? (
        <SettingsError message={phase.message} onRetry={() => void load()} />
      ) : phase.k === 'off' ? (
        <SettingsEmpty title="Not available yet">
          Spending limits aren’t switched on here yet.
        </SettingsEmpty>
      ) : phase.k === 'none' ? (
        <SettingsEmpty title="No wallet yet">
          Set up {agent.name}’s wallet first; then you can give it a limit.
        </SettingsEmpty>
      ) : phase.k === 'review' && view ? (
        <form className="w4-steps" onSubmit={(event) => void signReview(event)}>
          <div className="w4-limit" data-k="limit-review">
            <p className="w4-limit-cap">
              Your limit: <b>{limitText(phase.checked)}</b>
            </p>
            {phase.checked.model === 'half' ? (
              <p className="w4-hint" data-k="enforced">
                {enforced(
                  'half',
                  phase.checked.allowance,
                  phase.checked.capRaw,
                  phase.checked.period,
                  agent.name,
                )}
              </p>
            ) : (
              <p className="w4-caution" data-k="enforced">
                {enforced(
                  'full',
                  phase.checked.allowance,
                  phase.checked.capRaw,
                  phase.checked.period,
                  agent.name,
                )}
              </p>
            )}
          </div>
          <ul className="w4-facts">
            {/* It starts at 00:00 Berlin today; only just before midnight can it be the next day's. */}
            {phase.checked.start * 1000 <= Date.now() ? (
              <li data-k="works-now">{agent.name} can use it as soon as you sign.</li>
            ) : null}
            <li>{baseStarts(phase.checked.period, phase.checked.start)}</li>
            <li>Central City’s counter resets {RESETS[phase.checked.period]}.</li>
            <li>
              {view.testnet ? `${view.network} · test network, no real money.` : view.network}
            </li>
            <li data-k="spender">
              Only {agent.name}’s spending key can use it:{' '}
              <span className="w4-mono">{phase.checked.permission.spender}</span>
              {readSpenderPin(phase.checked.permission.account)
                ? ''
                : '. First limit in this browser: check it.'}
            </li>
          </ul>
          {spenderChanged(phase.checked) ? (
            <div className="w4-caution" data-k="spender-changed" role="status">
              <b>The spending key changed since you confirmed it here.</b> Then{' '}
              <span className="w4-mono">{spenderChanged(phase.checked)}</span>, now{' '}
              <span className="w4-mono">{phase.checked.permission.spender}</span>. Only sign if you
              expected {agent.name} to get a new key.
              <label className="w4-check">
                <input
                  type="checkbox"
                  checked={newKeyOk}
                  onChange={(event) => setNewKeyOk(event.target.checked)}
                />
                I confirm the new spending key
              </label>
            </div>
          ) : null}
          <p className="w4-hint" data-k="checked">
            Checked in this browser: the limit you sign is exactly this.
          </p>
          {passwordField}
          {errorLine}
          <div className="ap4-actions">
            <button
              type="submit"
              className="ap4-btn"
              disabled={busy || !password || (!!spenderChanged(phase.checked) && !newKeyOk)}
              aria-busy={busy}
            >
              {busy ? 'Signing…' : 'Sign'}
            </button>
            <button
              type="button"
              className="ap4-btn ap4-ghost"
              disabled={busy}
              onClick={() => {
                setPassword('');
                setError('');
                setPhase({ k: 'ready' });
              }}
            >
              Back
            </button>
          </div>
        </form>
      ) : phase.k === 'ready' && view && limit ? (
        <div className="w4-steps">
          <LimitCard
            limit={limit}
            view={view}
            name={agent.name}
            onRetry={() => void refresh()}
            stateRef={limitState}
          />
          {/* Paying on its own: only for an active limit (a revoke already blocks every spend). */}
          {limit.state === 'signed' || limit.state === 'approved' ? (
            <AgentPayConsent
              agentId={agent.id}
              name={agent.name}
              limit={limit}
              onLimitChanged={rereadForConsent}
            />
          ) : null}
          {canRevoke(limit) ? (
            /* Its own heading: revoking the whole limit is not withdrawing "Paying on its own". */
            <form
              className="w4-steps"
              aria-labelledby={revokeHeading}
              data-k="limit-revoke"
              onSubmit={(event) => void revoke(event)}
            >
              <h4 id={revokeHeading} className="w4-section">
                Revoke the limit
              </h4>
              <p className="w4-hint">
                {limit.state === 'revoke_pending'
                  ? 'The revoke isn’t on Base yet. Sign it with your wallet password.'
                  : `Revoking blocks ${agent.name}’s spends here at once; Base stops the limit once the revoke you sign lands.`}
              </p>
              {passwordField}
              {errorLine}
              <button
                type="submit"
                className="ap4-btn ap4-ghost w4-wide"
                disabled={busy || !password}
                aria-busy={busy}
              >
                {busy ? 'Signing…' : 'Revoke'}
              </button>
            </form>
          ) : (
            errorLine
          )}
        </div>
      ) : phase.k === 'ready' && view ? (
        <form className="w4-steps" onSubmit={(event) => void prepare(event)}>
          {/* A limit alone doesn't let the agent pay on its own: that is a separate OK. */}
          <p ref={lead} className="w4-lead" tabIndex={-1} data-k="limit-lead">
            Set the most {agent.name} may spend, in a limit you sign. Base holds it to that limit,
            and you can revoke it any time. Paying on its own needs your separate OK once the limit
            is set.
          </p>
          {last?.state === 'revoked' ? (
            <p className="w4-hint">Your last limit, {limitText(last)}, is revoked on Base.</p>
          ) : null}
          <label className="w4-field">
            <span>Limit in USDC</span>
            <input
              inputMode="decimal"
              autoComplete="off"
              placeholder="20.00"
              value={cap}
              onChange={(event) => setCap(event.target.value)}
            />
          </label>
          <div className="w4-seg w4-seg3" role="radiogroup" aria-label="Period">
            {PERIODS.map((each) => (
              <button
                key={each}
                type="button"
                role="radio"
                aria-checked={period === each}
                onClick={() => setPeriod(each)}
              >
                {PERIOD_WORDS[each].replace(/^a/, 'A')}
              </button>
            ))}
          </div>
          {errorLine}
          <button type="submit" className="ap4-btn w4-wide" disabled={busy} aria-busy={busy}>
            {busy ? 'Preparing…' : 'Continue'}
          </button>
        </form>
      ) : null}
    </SettingsFrame>
  );
}
