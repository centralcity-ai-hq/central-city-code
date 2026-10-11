import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MutableRefObject,
} from 'react';
import { ChevronRight, Copy } from 'lucide-react';
import type { Hex } from 'viem';
import { ApiError } from '../../api';
import {
  confirmBackup,
  createVault,
  groupMatches,
  pickConfirmGroups,
  readVault,
  unlockVault,
  VaultCryptoError,
  type VaultState,
} from '../../base/vault';
import {
  ensureWallet,
  fullHistory,
  checkOwnWallet,
  networkProblem,
  walletNetwork,
  type WalletNetwork,
  isSelfTransfer,
  readHistory,
  readWallet,
  transferDelta,
  transferKey,
  usdcNumber,
  type WalletHistory,
  type WalletTransfer,
  type WalletView,
} from '../../base/wallet/api';
import { useLimitRow } from '../../base/wallet/useLimitRow';
import { useRater } from '../../base/wallet/useRater';
import { AssembledQR } from '../../base/wallet/visual/AssembledQR';
import { BalanceLine } from '../../base/wallet/visual/BalanceLine';
import { KeyReveal } from '../../base/wallet/visual/KeyReveal';
import { Odometer } from '../../base/wallet/visual/Odometer';
import type { AgentScreenProps } from './screens';
import { SettingsEmpty, SettingsError, SettingsFrame, SettingsLoading } from './settingsShared';
import { BASE_MAINNET } from '../../../shared/base/chains';
import { WALLET_CHAIN_ID } from '../../../shared/base/wallet-network';
import { AgentPayments } from './AgentPayments';
import { IncomingPayments } from './IncomingPayments';
import { ChangePasswordScreen, ForgotPasswordLink, RestoreKeyScreen } from './WalletKeyScreens';
import { PASSWORD_CHANGED, RESTORED } from './walletKeyModel';
import { StarIcon } from './Stars';
import './wallet-screen.css';

/*
 * An agent's Wallet in its pane (docs/design/base-wallet-mockup.html, approved by the product owner
 * 10 Oct 2026; Operation Base Wallet W1, test network only). The person's wallet key is set up once for
 * all their agents (src/base/vault): a password, the backup key shown once, two groups typed back.
 * Then the agent's wallet: the balance read from Base with its block, the last 24 hours as a line
 * you can scrub, Add funds with the address and its QR, Withdraw (WalletWithdrawScreen) and the
 * spending limit (WalletLimitsScreen, W3; the row stays as it was while the server has no limits).
 * A forgotten password is restored with the backup key, and the password changed, over the screen
 * the owner was on (WalletKeyScreens).
 * Rate (WalletRateScreen) shows only for an agent that is itself a Central City agent on Base.
 */

const MIN_PASSWORD = 12;
const TEST_NETWORK = 'Test network · no real money';
/** The network line of a checked network: the test network says so; Base itself doesn't. */
const networkOf = (network: WalletNetwork) => (network.testnet ? TEST_NETWORK : 'Base');
/** The unlocked backup key is hidden again after this long without a key press or tap. */
export const IDLE_LOCK_MS = 5 * 60_000;

type Step =
  | { k: 'loading' }
  | { k: 'error'; message: string }
  | { k: 'off' }
  | { k: 'setup' }
  | { k: 'finish' }
  | { k: 'backup'; privateKey: Hex }
  | { k: 'confirm'; privateKey: Hex; groups: [number, number] }
  | { k: 'create' }
  | { k: 'chain' }
  /** Registered on Base before wallets: its Base ID is in a wallet another key owns. */
  | { k: 'elsewhere'; address: string; owner: string }
  | {
      k: 'wallet';
      wallet: WalletView;
      network: WalletNetwork;
      history: WalletHistory | null;
      /** The vault it was checked against: every later read of the wallet is checked again. */
      vault: VaultState;
      against: 'key' | 'unlock';
    };

const failure = (error: unknown) =>
  error instanceof VaultCryptoError || error instanceof ApiError || error instanceof Error
    ? error.message
    : 'Something went wrong. Try again.';

/** Unlocked, yet this browser still holds no key for the person signed in: nothing is shown. */
const NOT_HELD_HERE =
  'Your key was unlocked, but this browser couldn’t hold it for this account, so no address is shown.';

const usd = (value: number) => (Math.round(value * 100) / 100).toFixed(2);
const eth = (display: string) => {
  const value = Number(display);
  return value === 0 ? '0' : value < 0.0001 ? '<0.0001' : value.toFixed(4).replace(/0+$/, '');
};
const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
const clock = (at: number) =>
  new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className="w4-copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => setDone(true),
          () => setDone(false),
        );
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setDone(false), 1400);
      }}
    >
      <Copy size={13} aria-hidden="true" />
      {done ? 'Copied' : label}
    </button>
  );
}

/**
 * The person's wallet key: a password, then the backup key, then two groups typed back. The
 * unlocked key lives only in the parent's step; `session` changes whenever the parent locks it
 * (hidden, idle, left), and an answer that arrives after that is dropped, never shown.
 */
function KeySetup({
  step,
  name,
  locked,
  session,
  onStep,
  onBusy,
  onStale,
  onDone,
  onForgot,
}: {
  step: Extract<Step, { k: 'setup' | 'finish' | 'backup' | 'confirm' }>;
  name: string;
  locked: boolean;
  session: MutableRefObject<number>;
  onStep: (step: Step) => void;
  onBusy: (busy: boolean) => void;
  /** Something finished after a lock: read the state again from the server (no key in it). */
  onStale: () => void;
  onDone: () => void;
  /** Opens the restore with the backup key (only offered where the password unlocks). */
  onForgot: () => void;
}) {
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [saved, setSaved] = useState(false);
  const [typed, setTyped] = useState<[string, string]>(['', '']);

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (step.k === 'setup') {
      if (password.length < MIN_PASSWORD)
        return setError(`Use at least ${MIN_PASSWORD} characters.`);
      if (password !== repeat) return setError('The two passwords aren’t the same.');
    }
    const started = session.current;
    setBusy(true);
    onBusy(true);
    try {
      const privateKey =
        step.k === 'setup' ? (await createVault(password)).privateKey : await unlockVault(password);
      if (session.current !== started) return onStale();
      setPassword('');
      setRepeat('');
      onStep({ k: 'backup', privateKey });
    } catch (err) {
      if (session.current !== started) return onStale();
      // Set up meanwhile (another tab, or a lock mid-way): unlock it to finish.
      if (err instanceof ApiError && err.status === 409) return onStale();
      setError(failure(err));
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }

  async function submitGroups(event: FormEvent) {
    event.preventDefault();
    if (step.k !== 'confirm') return;
    setError('');
    const [a, b] = step.groups;
    if (!groupMatches(step.privateKey, a, typed[0]) || !groupMatches(step.privateKey, b, typed[1]))
      return setError('One of the groups doesn’t match. Check the key you saved.');
    const started = session.current;
    setBusy(true);
    onBusy(true);
    try {
      await confirmBackup(step.privateKey);
      if (session.current !== started) return onStale();
      onDone();
    } catch (err) {
      if (session.current !== started) return onStale();
      setError(failure(err));
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }

  if (step.k === 'setup' || step.k === 'finish')
    return (
      <form className="w4-steps" onSubmit={(event) => void submitPassword(event)}>
        <div className="w4-progress" aria-hidden="true">
          <i className="on" />
          <i />
          <i />
        </div>
        {step.k === 'setup' ? (
          <>
            <p className="w4-lead">
              One key for the wallets of all your agents. You set it up once.
            </p>
            <ul className="w4-points">
              <li>
                <b>Only you can take money out.</b>
                <span>Moving money needs your wallet password. Central City can’t.</span>
              </li>
              <li>
                <b>Your agents spend only inside your limits.</b>
                <span>You set an amount per day, week or month, and can revoke it.</span>
              </li>
              <li>
                <b>The key stays with you.</b>
                <span>
                  It’s made and locked in this browser. Central City keeps only the locked copy.
                </span>
              </li>
            </ul>
          </>
        ) : locked ? (
          <p className="w4-lead" role="status">
            The backup key is hidden again because this page was in the background or nobody used it
            for {IDLE_LOCK_MS / 60_000} minutes. Unlock with your wallet password to see it.
          </p>
        ) : (
          <p className="w4-lead">
            Your wallet key is set up but its backup isn’t confirmed yet. Unlock it to see the
            backup key again and finish.
          </p>
        )}
        <label className="w4-field">
          <span>Wallet password</span>
          <input
            type="password"
            autoComplete={step.k === 'setup' ? 'new-password' : 'current-password'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {step.k === 'setup' ? (
            <small>At least {MIN_PASSWORD} characters. Central City never sees it.</small>
          ) : null}
        </label>
        {step.k === 'setup' ? (
          <label className="w4-field">
            <span>Repeat the password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={repeat}
              onChange={(event) => setRepeat(event.target.value)}
            />
          </label>
        ) : null}
        {error ? (
          <p className="w4-error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className="ap4-btn w4-wide" disabled={busy} aria-busy={busy}>
          {busy ? 'Locking your key…' : step.k === 'setup' ? 'Continue' : 'Unlock'}
        </button>
        {step.k === 'finish' ? <ForgotPasswordLink onOpen={onForgot} disabled={busy} /> : null}
      </form>
    );

  if (step.k === 'backup')
    return (
      <div className="w4-steps">
        <div className="w4-progress" aria-hidden="true">
          <i className="on" />
          <i className="on" />
          <i />
        </div>
        <p className="w4-lead">
          It restores your wallets if you forget the password or lose this browser. It’s shown once.
        </p>
        <KeyReveal privateKey={step.privateKey} onRevealed={() => setRevealed(true)}>
          {revealed ? <CopyButton text={step.privateKey.slice(2)} label="Copy key" /> : null}
        </KeyReveal>
        <p className="w4-caution">
          <b>Keep it offline.</b> Anyone with this key can take the money. Central City will never
          ask for it.
        </p>
        <label className={`w4-check${revealed ? '' : ' off'}`}>
          <input
            type="checkbox"
            disabled={!revealed}
            checked={saved}
            onChange={(event) => setSaved(event.target.checked)}
          />
          I saved the backup key. I understand it can’t be shown again.
        </label>
        <button
          type="button"
          className="ap4-btn w4-wide"
          disabled={!saved}
          onClick={() =>
            onStep({ k: 'confirm', privateKey: step.privateKey, groups: pickConfirmGroups() })
          }
        >
          Continue
        </button>
      </div>
    );

  return (
    <form className="w4-steps" onSubmit={(event) => void submitGroups(event)}>
      <div className="w4-progress" aria-hidden="true">
        <i className="on" />
        <i className="on" />
        <i className="on" />
      </div>
      <p className="w4-lead">
        Type two groups from the key you saved. {name}’s wallet takes money only after this.
      </p>
      {step.groups.map((group, index) => (
        <label className="w4-field" key={group}>
          <span>Group {group}</span>
          <input
            className="w4-mono"
            maxLength={4}
            autoComplete="off"
            spellCheck={false}
            value={typed[index]}
            onChange={(event) => {
              const next: [string, string] = [...typed];
              next[index] = event.target.value;
              setTyped(next);
            }}
          />
        </label>
      ))}
      {error ? (
        <p className="w4-error" role="alert">
          {error}
        </p>
      ) : null}
      <button type="submit" className="ap4-btn w4-wide" disabled={busy} aria-busy={busy}>
        {busy ? 'Saving…' : 'Finish'}
      </button>
    </form>
  );
}

/** The wallet itself: the balance, the last 24 hours, Add funds, the address and the list. */
function WalletView_({
  agentId,
  name,
  wallet,
  network,
  history,
  now,
  onOpen,
  against,
  onChangePassword,
}: {
  agentId: string;
  name: string;
  wallet: WalletView;
  /** The wallet's network, already checked to be exactly one of the two. */
  network: WalletNetwork;
  history: WalletHistory | null;
  now: number;
  onOpen: (screen: string) => void;
  /** 'key': checked against the key this browser held, so its address can be offered for funds. */
  against: 'key' | 'unlock';
  onChangePassword: () => void;
}) {
  const current = usd(usdcNumber(wallet.usdc));
  const limitRow = useLimitRow(agentId);
  // Rate only from a Central City agent on Base itself (a final Base ID and a passport).
  const rater = useRater(agentId);
  const [scrub, setScrub] = useState<{ at: number; balance: number; label: string | null } | null>(
    null,
  );
  // The line needs the whole window and its opening balance; anything less is shown as partial.
  const full = fullHistory(history);
  const labelOf = useCallback(
    (transfer: WalletTransfer) =>
      isSelfTransfer(transfer, wallet.address)
        ? 'To itself'
        : transfer.kind === 'received'
          ? 'Received'
          : transfer.kind === 'withdrawn'
            ? 'Withdrawn'
            : `Spent by ${name}`,
    [name, wallet.address],
  );
  const transfers = useMemo(
    () =>
      (history?.transfers ?? []).map((transfer) => ({
        at: transfer.at,
        amount: transferDelta(transfer, wallet.address),
        kind: transfer.kind,
        label: labelOf(transfer),
      })),
    [history, labelOf, wallet.address],
  );
  const since = history ? `block ${history.scannedFrom.toLocaleString('en-US')}` : '';
  return (
    <>
      <div className="w4-hero">
        <p className="w4-eyebrow">
          {name}’s wallet{' '}
          <span className={`w4-net${network.testnet ? '' : ' live'}`}>{networkOf(network)}</span>
        </p>
        <div className="w4-amount">
          <Odometer value={scrub ? usd(scrub.balance) : current} className="w4-big" />
          <span className="w4-unit">USDC</span>
        </div>
        <p className="w4-sub">
          {scrub ? (
            <span className="w4-scrub">
              {clock(scrub.at)}
              {scrub.label ? ` · ${scrub.label}` : ''}
            </span>
          ) : (
            <>
              <span>{eth(wallet.eth.display)} ETH</span>
              <span className="w4-read">
                {wallet.stale ? 'Last read from Base' : 'Read from Base'} · block{' '}
                {wallet.readAtBlock.toLocaleString('en-US')} · {ago(now - wallet.readAt)}
              </span>
            </>
          )}
        </p>
        {full && transfers.length ? (
          <BalanceLine
            startBalance={usdcNumber(history.startBalance.usdc)}
            transfers={transfers}
            now={history.window.to}
            onScrub={(state) => {
              const transfer = state?.transfer == null ? null : transfers[state.transfer];
              setScrub(
                state
                  ? {
                      at: state.at,
                      balance: state.balance,
                      label: transfer
                        ? `${transfer.label} ${transfer.amount === 0 ? '' : transfer.amount > 0 ? '+' : '−'}${usd(Math.abs(transfer.amount))}`
                        : null,
                    }
                  : null,
              );
            }}
          />
        ) : full ? (
          <p className="w4-hint">No transfers in the last 24 hours.</p>
        ) : history ? (
          <p className="w4-hint">
            Read from Base since {since} only, so the last 24 hours aren’t complete yet.
          </p>
        ) : null}
      </div>
      {wallet.stale ? (
        <p className="w4-caution" role="status">
          <b>Base isn’t answering right now.</b> This is the last balance read.
        </p>
      ) : null}
      <div className="ap4-actions">
        <button
          type="button"
          className="ap4-btn"
          disabled={wallet.fundingLocked || !wallet.address}
          onClick={() => onOpen('wallet-add')}
        >
          Add funds
        </button>
        <button
          type="button"
          className="ap4-btn ap4-ghost"
          disabled={wallet.fundingLocked || !wallet.address}
          onClick={() => onOpen('wallet-withdraw')}
        >
          Withdraw
        </button>
        <button
          type="button"
          className="ap4-btn ap4-ghost"
          disabled={wallet.fundingLocked || !wallet.address}
          onClick={() => onOpen('wallet-pay')}
        >
          Pay
        </button>
        {rater ? (
          <button
            type="button"
            className="ap4-btn ap4-ghost"
            disabled={wallet.fundingLocked || !wallet.address}
            onClick={() => onOpen('wallet-rate')}
          >
            <StarIcon on={false} outline size={15} />
            Rate
          </button>
        ) : null}
      </div>
      <div className="ap4-group">
        {limitRow ? (
          <button
            type="button"
            className="ap4-row"
            data-k="row-limit"
            onClick={() => onOpen('wallet-limits')}
          >
            <span className="ap4-k">Spending limit</span>
            {limitRow.value ? <span className="ap4-v">{limitRow.value}</span> : null}
            <ChevronRight className="ap4-chev" size={14} aria-hidden="true" />
          </button>
        ) : (
          <div className="ap4-row v4s-still">
            <span className="ap4-k">Spending limit</span>
            {limitRow === null ? <span className="ap4-v">Coming soon</span> : null}
          </div>
        )}
        {wallet.address && against === 'key' ? (
          <div className="ap4-row v4s-still">
            <span className="ap4-k">
              Address
              <span className="w4-row-sub w4-mono">
                {shortAddress(wallet.address)} · Base network only
              </span>
            </span>
            <CopyButton text={wallet.address} />
          </div>
        ) : wallet.address ? (
          <div className="ap4-row v4s-still" data-k="address-locked">
            <span className="ap4-k">
              Address
              <span className="w4-row-sub">Shown once your key is unlocked in this browser</span>
            </span>
          </div>
        ) : null}
        <button type="button" className="ap4-row" data-k="row-password" onClick={onChangePassword}>
          <span className="ap4-k">
            Change password
            <span className="w4-row-sub">The password of your wallet key</span>
          </span>
          <ChevronRight className="ap4-chev" size={14} aria-hidden="true" />
        </button>
      </div>
      {history && (transfers.length || !full) ? (
        <>
          <p className="w4-section">{full ? 'Last 24 hours' : `Since ${since}`}</p>
          {transfers.length ? (
            <div className="ap4-group w4-list">
              {[...history.transfers].reverse().map((transfer) => {
                const delta = transferDelta(transfer, wallet.address);
                const self = isSelfTransfer(transfer, wallet.address);
                return (
                  <div className="ap4-row v4s-still" key={transferKey(transfer)}>
                    <span className="ap4-k">
                      {labelOf(transfer)}
                      <span className="w4-row-sub">
                        {transfer.counterparty && !self
                          ? `${transfer.kind === 'received' ? 'From' : 'To'} ${shortAddress(transfer.counterparty)} · `
                          : ''}
                        block {transfer.block.toLocaleString('en-US')} · {clock(transfer.at)}
                      </span>
                    </span>
                    <span className={`w4-amt${delta > 0 ? ' in' : ''}`}>
                      {self ? '' : delta > 0 ? '+' : '−'}
                      {usd(self ? usdcNumber(transfer.amount) : Math.abs(delta))}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="w4-hint">No transfers seen since {since}.</p>
          )}
          <p className="w4-hint">
            Amounts in USDC. {full ? 'The line and the list are' : 'The list is'} read from Base
            transfers to and from this address.
          </p>
        </>
      ) : null}
    </>
  );
}

export function WalletScreen({ agent, onBack, onOpen, backLabel }: AgentScreenProps) {
  const [step, setStep] = useState<Step>({ k: 'loading' });
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // The unlocked key (backup, confirm) is dropped when the page is hidden or left, after
  // IDLE_LOCK_MS without input, or when this screen closes; then it takes the password again.
  // session counts those locks, so an unlock or confirm that answers later is never shown.
  const session = useRef(0);
  // Each lock also remounts the key form, so a password typed for a pending unlock goes at once.
  const [epoch, setEpoch] = useState(0);
  const [locked, setLocked] = useState(false);
  const [keyBusy, setKeyBusy] = useState(false);
  /** Restore or Change password, open over this screen; the note says what they did. */
  const [aside, setAside] = useState<'restore' | 'password' | null>(null);
  const [note, setNote] = useState('');
  const unlocked = step.k === 'backup' || step.k === 'confirm';
  const lock = useCallback(() => {
    session.current += 1;
    setEpoch((value) => value + 1);
    setLocked(true);
    setStep((current) =>
      current.k === 'backup' || current.k === 'confirm' ? { k: 'finish' } : current,
    );
  }, []);
  useEffect(
    () => () => {
      session.current += 1;
    },
    [],
  );
  useEffect(() => {
    if (!unlocked && !keyBusy) return;
    let last = Date.now();
    const touch = () => {
      last = Date.now();
    };
    const hidden = () => {
      if (document.visibilityState === 'hidden') lock();
    };
    const idle = window.setInterval(() => {
      if (Date.now() - last >= IDLE_LOCK_MS) lock();
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
  }, [unlocked, keyBusy, lock]);

  const load = useCallback(async () => {
    setStep({ k: 'loading' });
    try {
      const read = await readWallet(agent.id);
      if (read.kind === 'off') return setStep({ k: 'off' });
      if (read.kind === 'registered_elsewhere')
        return setStep({ k: 'elsewhere', address: read.address, owner: read.ownerAddress });
      const vault = await readVault();
      if (!vault.exists) return setStep({ k: 'setup' });
      if (vault.backupConfirmedAt === null) return setStep({ k: 'finish' });
      if (read.kind === 'none') return setStep({ k: 'create' });
      if (read.kind === 'chain_unavailable') return setStep({ k: 'chain' });
      // Only the two exact networks: anything else shows no wallet, address or QR.
      const network = walletNetwork(read.wallet);
      if (!network) return setStep({ k: 'error', message: networkProblem(read.wallet) });
      // Derived here: only the wallet this person's key makes for this agent is ever shown.
      const own = checkOwnWallet(read.wallet, vault, agent.id);
      if (own.problem !== null) return setStep({ k: 'error', message: own.problem });
      const history = await readHistory(agent.id).catch(() => null);
      setStep({ k: 'wallet', wallet: read.wallet, network, history, vault, against: own.against });
      setNow(Date.now());
    } catch (err) {
      setStep({ k: 'error', message: failure(err) });
    }
  }, [agent.id]);
  useEffect(() => {
    void load();
  }, [load]);
  // The read line's age keeps counting, and the wallet is read again every 30 s while open.
  useEffect(() => {
    if (step.k !== 'wallet') return;
    const tick = window.setInterval(() => setNow(Date.now()), 5_000);
    const reread = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 30_000);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(reread);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.k]);
  async function refresh() {
    let read: Awaited<ReturnType<typeof readWallet>> | null = null;
    try {
      read = await readWallet(agent.id);
    } catch {
      read = null;
    }
    if (read?.kind === 'wallet') {
      const wallet = read.wallet;
      const network = walletNetwork(wallet);
      if (!network) return setStep({ k: 'error', message: networkProblem(wallet) });
      const history = await readHistory(agent.id).catch(() => null);
      setStep((current) => {
        if (current.k !== 'wallet') return current;
        // Each read is checked like the first: a later answer can't change the address shown.
        const own = checkOwnWallet(wallet, current.vault, agent.id);
        if (own.problem !== null) return { k: 'error', message: own.problem };
        return { ...current, wallet, network, history, against: own.against };
      });
      return;
    }
    // Not answered: what is shown stays with its own block and time, marked as the last read.
    setStep((current) =>
      current.k === 'wallet' ? { ...current, wallet: { ...current.wallet, stale: true } } : current,
    );
  }
  async function create() {
    setBusy(true);
    try {
      await ensureWallet(agent.id);
      await load();
    } catch (err) {
      setStep({ k: 'error', message: failure(err) });
    } finally {
      setBusy(false);
    }
  }

  const title =
    step.k === 'setup' || step.k === 'finish'
      ? 'Your wallet key'
      : step.k === 'backup'
        ? 'Save your backup key'
        : step.k === 'confirm'
          ? 'Check your backup key'
          : 'Wallet';
  // Back to where the owner was: read again, since the key is now held here as after an unlock.
  const done = (message: string) => {
    setAside(null);
    setNote(message);
    void load();
  };
  const openAside = (which: 'restore' | 'password') => {
    setNote('');
    setAside(which);
  };
  if (aside === 'restore')
    return (
      <RestoreKeyScreen
        backLabel={title}
        onBack={() => setAside(null)}
        onRestored={() => done(RESTORED)}
      />
    );
  if (aside === 'password')
    return (
      <ChangePasswordScreen
        backLabel={title}
        onBack={() => setAside(null)}
        onChanged={() => done(PASSWORD_CHANGED)}
        onForgot={() => openAside('restore')}
      />
    );
  return (
    <SettingsFrame backLabel={backLabel ?? agent.name} onBack={onBack} title={title}>
      {note ? (
        <p className="w4-done" role="status" data-k="key-note">
          {note}
        </p>
      ) : null}
      {step.k === 'loading' ? (
        <SettingsLoading />
      ) : step.k === 'error' ? (
        <SettingsError message={step.message} onRetry={() => void load()} />
      ) : step.k === 'off' ? (
        <SettingsEmpty title="Not available yet">
          Agent wallets aren’t switched on here yet.
        </SettingsEmpty>
      ) : step.k === 'elsewhere' ? (
        <div className="w4-steps" data-k="elsewhere">
          <p className="w4-caution">
            <b>Central City can’t use this wallet yet.</b> {agent.name}’s Base ID is held by a
            wallet that your own wallet outside Central City controls.
          </p>
          <div className="ap4-group">
            <div className="ap4-row v4s-still">
              <span className="ap4-k">
                {agent.name}’s wallet
                <span className="w4-row-sub w4-mono">{step.address}</span>
              </span>
              <CopyButton text={step.address} />
            </div>
            <div className="ap4-row v4s-still">
              <span className="ap4-k">
                Owner on Base
                <span className="w4-row-sub w4-mono">{step.owner}</span>
                <span className="w4-row-sub">your wallet outside Central City</span>
              </span>
            </div>
          </div>
          <p className="w4-hint">
            Withdraw, Pay and spending limits here need a one-time step from that wallet. Until
            then, only that wallet can move what this one holds.
          </p>
        </div>
      ) : step.k === 'chain' ? (
        <SettingsError
          message="Base isn’t answering right now, so the balance can’t be read."
          onRetry={() => void load()}
        />
      ) : step.k === 'create' ? (
        <div className="w4-steps">
          <p className="w4-lead">
            Your wallet key is ready. Create {agent.name}’s wallet{' '}
            {WALLET_CHAIN_ID === BASE_MAINNET ? 'on Base' : 'on the test network'}.
          </p>
          <button
            type="button"
            className="ap4-btn w4-wide"
            disabled={busy}
            onClick={() => void create()}
          >
            {busy ? 'Creating…' : `Create ${agent.name}’s wallet`}
          </button>
        </div>
      ) : step.k === 'wallet' ? (
        <>
          <WalletView_
            agentId={agent.id}
            name={agent.name}
            wallet={step.wallet}
            network={step.network}
            history={step.history}
            now={now}
            onOpen={onOpen}
            against={step.against}
            onChangePassword={() => openAside('password')}
          />
          <IncomingPayments agentId={agent.id} name={agent.name} />
          <AgentPayments agentId={agent.id} name={agent.name} />
        </>
      ) : (
        <KeySetup
          key={`${step.k}:${epoch}`}
          step={step}
          name={agent.name}
          locked={locked}
          session={session}
          onStep={(next) => {
            if (next.k === 'backup') setLocked(false);
            setStep(next);
          }}
          onBusy={setKeyBusy}
          onStale={() => void load()}
          onDone={() => void create()}
          onForgot={() => openAside('restore')}
        />
      )}
    </SettingsFrame>
  );
}

/**
 * Add funds: the wallet's address on Base, its QR, and "Base network only". Shown only against the
 * wallet key this browser held itself; before that, one unlock here (checkOwnWallet).
 */
export function WalletAddScreen({ agent, onBack, backLabel }: AgentScreenProps) {
  const [read, setRead] = useState<
    | { k: 'loading' }
    | { k: 'error'; message: string }
    | { k: 'ready'; address: string; network: WalletNetwork }
    | { k: 'unlock' }
    | { k: 'none' }
  >({ k: 'loading' });
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [note, setNote] = useState('');
  const load = useCallback(
    async (unlocked = false) => {
      setRead({ k: 'loading' });
      try {
        const wallet = await readWallet(agent.id);
        if (wallet.kind !== 'wallet' || !wallet.wallet.address) return setRead({ k: 'none' });
        // Only the two exact networks: anything else shows no address, QR or copy.
        const network = walletNetwork(wallet.wallet);
        if (!network) return setRead({ k: 'error', message: networkProblem(wallet.wallet) });
        // The address to send funds to: only the one this person's key makes for this agent,
        // checked against that key as this browser held it.
        const vault = await readVault();
        const own = checkOwnWallet(wallet.wallet, vault, agent.id);
        if (own.problem !== null) return setRead({ k: 'error', message: own.problem });
        if (own.against === 'unlock')
          return setRead(unlocked ? { k: 'error', message: NOT_HELD_HERE } : { k: 'unlock' });
        setRead({ k: 'ready', address: wallet.wallet.address, network });
      } catch (err) {
        setRead({ k: 'error', message: failure(err) });
      }
    },
    [agent.id],
  );
  useEffect(() => {
    void load();
  }, [load]);
  async function unlock(event: FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      // Opened here and dropped: unlocking records the key's address for this person (keyPin.ts).
      await unlockVault(password);
      setPassword('');
      await load(true);
    } catch (err) {
      setPassword('');
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  }
  if (restoring)
    return (
      <RestoreKeyScreen
        backLabel="Add funds"
        onBack={() => setRestoring(false)}
        onRestored={() => {
          // Restoring held the key here as an unlock does: the address is checked against it.
          setRestoring(false);
          setError('');
          setNote(RESTORED);
          void load(true);
        }}
      />
    );
  return (
    <SettingsFrame
      backLabel={backLabel ?? 'Wallet'}
      onBack={onBack}
      title="Add funds"
      sub={`Send USDC to ${agent.name}’s address on the Base network.`}
    >
      {note ? (
        <p className="w4-done" role="status" data-k="key-note">
          {note}
        </p>
      ) : null}
      {read.k === 'loading' ? (
        <SettingsLoading />
      ) : read.k === 'error' ? (
        <SettingsError message={read.message} onRetry={() => void load()} />
      ) : read.k === 'none' ? (
        <SettingsEmpty title="Not ready yet">
          Confirm your backup key first; then the address shows here.
        </SettingsEmpty>
      ) : read.k === 'unlock' ? (
        <form className="w4-steps" onSubmit={(event) => void unlock(event)} data-k="unlock-first">
          <p className="w4-lead">Unlock your wallet key to see where to send money.</p>
          <p className="w4-hint">
            This browser hasn’t held your key yet, so it doesn’t show an address on Central City’s
            word alone. Once unlocked, it checks the address against your key itself.
          </p>
          <label className="w4-field">
            <span>Wallet password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {error ? (
            <p className="w4-error" role="alert">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            className="ap4-btn w4-wide"
            disabled={busy || !password}
            aria-busy={busy}
          >
            {busy ? 'Unlocking…' : 'Unlock and show address'}
          </button>
          <ForgotPasswordLink
            disabled={busy}
            onOpen={() => {
              setPassword('');
              setNote('');
              setRestoring(true);
            }}
          />
        </form>
      ) : (
        <div className="w4-steps">
          {/* EIP-681: the address on the wallet's own chain, as the server read it. */}
          <AssembledQR value={`ethereum:${read.address}@${read.network.chainId}`} size={184} />
          <div className="w4-address">
            <span className="w4-mono">{read.address}</span>
            <CopyButton text={read.address} />
          </div>
          <p className="w4-caution">
            <b>Base network only.</b> USDC or ETH sent on any other network, such as Ethereum or
            Arbitrum, doesn’t arrive and can’t be recovered.
          </p>
          {read.network.testnet ? (
            <p className="w4-hint">{TEST_NETWORK}: use Base Sepolia test USDC.</p>
          ) : (
            <p className="w4-hint">This is real USDC on Base. A payment can’t be undone.</p>
          )}
          <p className="w4-hint" data-k="derived">
            Checked in this browser: this is the wallet your own key makes for {agent.name}.
          </p>
        </div>
      )}
    </SettingsFrame>
  );
}
