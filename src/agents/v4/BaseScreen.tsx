import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  FINALIZING_INFO,
  TX_HASH,
  retryAllowed,
  short,
  validAddress,
} from '../../base/baseRegistrationModel';
import {
  useBaseRegistration,
  useBaseRegistrationStatus,
  type BaseRegistrationState,
  type BaseRegistrationStatus,
} from '../../base/useBaseRegistration';
import {
  baseIdOf,
  baseRowSummary,
  baseScreenState,
  finalizingLine,
  finalizingSince,
  mayHaveBase,
  msUntilFinalizingLong,
  msUntilSlow,
  openRetryOffered,
  passportCode,
  publicForBase,
  type BaseScreenState,
} from './baseScreenModel';
import {
  isKeyMode,
  useOwnerModeFromKey,
  useRegisterWithKey,
  walletAddressShown,
  type RegisterKey,
} from '../../base/useRegisterWithKey';
import { useCityScore } from '../../base/useCityScore';
import { scoreLine, type CityScore } from '../../../shared/base/rating-score';
import { DirectoryGroup } from './DirectoryGroup';
import './base-screen.css';

/* The mockup's own icons (docs/design/my-agents-v4-mockup.html), drawn the same way. */
function Icon({ d, className = 'v4b-i' }: { d: ReactNode; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      {d}
    </svg>
  );
}
const BackIcon = () => <Icon d={<path d="m15 6-6 6 6 6" />} />;
const ChevIcon = () => <Icon className="v4b-i v4b-chev" d={<path d="m9 6 6 6-6 6" />} />;
const CheckIcon = () => <Icon d={<path d="M5 12l5 5 9-10" />} />;
const BaseIcon = () => <Icon d={<path d="M12 3 4 7v6c0 4 3.5 7 8 8 4.5-1 8-4 8-8V7z" />} />;
const ExtIcon = () => (
  <Icon
    className="v4b-i v4b-ext"
    d={<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />}
  />
);
const CopyIcon = () => (
  <Icon
    d={
      <>
        <rect x="9" y="9" width="11" height="11" rx="2.5" />
        <path d="M5 15V6a2 2 0 0 1 2-2h9" />
      </>
    }
  />
);

/**
 * The "i" next to a line: a click, tap or Enter shows its note right under the line, and again
 * hides it. (A hover tooltip was cut off by the row's rounded group and never showed on a tap, or
 * on a click in Safari, which doesn't focus buttons.)
 */
function InfoTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <button
        type="button"
        className="v4b-info"
        aria-label={open ? 'Hide note' : 'More'}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((shown) => !shown)}
      >
        i
      </button>
      <span id={id} className="v4b-more" hidden={!open}>
        {text}
      </span>
    </>
  );
}

/** Copies the whole address; the row shows it shortened, the whole one on hover. */
function CopyButton({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  function copy() {
    try {
      void navigator.clipboard.writeText(address).then(
        () => {
          window.clearTimeout(timer.current);
          setCopied(true);
          timer.current = window.setTimeout(() => setCopied(false), 1700);
        },
        () => undefined,
      );
    } catch {
      // No clipboard in this browser; the whole address is still in the tooltip.
    }
  }
  return (
    <>
      <button type="button" className="v4b-cp" aria-label="Copy" title={address} onClick={copy}>
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
      <span className="visually-hidden" role="status">
        {copied ? 'Copied' : ''}
      </span>
    </>
  );
}

/**
 * Re-renders when a wait passes its usual time, so "Taking longer" (for the Base ID) and "taking
 * longer than usual" (for finalizing) show on time.
 */
function useSlowTick(registration: BaseRegistrationStatus): number {
  const [now, setNow] = useState(() => Date.now());
  const { stage, waitingSince } = registration;
  const finalizingFrom = finalizingSince(registration.identity, stage);
  useEffect(() => {
    const at = Date.now();
    const wait = msUntilSlow(stage, waitingSince, at) ?? msUntilFinalizingLong(finalizingFrom, at);
    if (wait === null) return;
    const handle = window.setTimeout(() => setNow(Date.now()), wait);
    return () => window.clearTimeout(handle);
  }, [stage, waitingSince, finalizingFrom]);
  return Math.max(now, Date.now());
}

interface AgentProfile {
  /** Only public agents can become Base agents (see baseProfileOf). */
  isPublic: boolean;
  /** A private agent with a profile can be made public; one without reads "Not available". */
  hasProfile: boolean;
}

function screenOf(registration: BaseRegistrationStatus, profile: AgentProfile, now: number) {
  const state = baseScreenState({ ...registration, ...profile, now });
  const since = finalizingSince(registration.identity, registration.stage);
  return { state, id: baseIdOf(registration.identity, registration.stage), since };
}

/**
 * The agent's Base screen in My agents v4: start, registering, taking longer, finalizing, final,
 * re-checking and failed, as the mockup draws them. All data and requests come from
 * useBaseRegistration. A private agent with a profile
 * gets the same start, and one question before its profile is made public (decision G4, option B).
 */
export function BaseScreen({
  agentId,
  agentName,
  onBack,
  isPublic = true,
  hasProfile = true,
  onChanged,
  onOpenWallet,
}: {
  agentId: string;
  agentName: string;
  onBack: () => void;
  /** baseProfileOf(agent).isPublic: public agents can start right away. */
  isPublic?: boolean;
  /** baseProfileOf(agent).hasProfile: agents without one see "Not available for this agent". */
  hasProfile?: boolean;
  /** The agent changed on the server (its profile is public now): reload it where it is shown. */
  onChanged?: () => void;
  /** Opens the agent's Wallet screen (to set up the wallet key or finish its backup). */
  onOpenWallet?: () => void;
}) {
  // An agent without a profile is "Not available" without asking the server.
  const idle = !mayHaveBase({ isPublic, hasProfile });
  const registration = useBaseRegistration(agentId, idle, { ownerModePending: true });
  const key = useRegisterWithKey(agentId, idle);
  // Wallets on: the owner is the person's wallet key, never a typed address (decision A).
  useOwnerModeFromKey(registration.setMode, key.state);
  const now = useSlowTick(registration);
  const { state, id, since } = screenOf(registration, { isPublic, hasProfile }, now);
  const score = useCityScore(state === 'final' ? id : null);
  return (
    <section className="v4b" aria-label={`${agentName} · Base`}>
      <div className="v4b-top">
        <button type="button" className="v4b-back" onClick={onBack}>
          <BackIcon />
          {agentName}
        </button>
      </div>
      <div className="v4b-scroll">
        <div className="v4b-wrap">
          <h3 className="v4b-title">Base</h3>
          <div className="v4b-body" aria-busy={state === 'loading' || undefined}>
            <BaseBody
              state={state}
              id={id}
              finalizing={finalizingLine(since, now)}
              agentName={agentName}
              agentId={agentId}
              registration={registration}
              isPublic={publicForBase({ isPublic, madePublic: registration.madePublic })}
              onChanged={onChanged}
              walletKey={key}
              onOpenWallet={onOpenWallet}
              score={score}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

/** The one question before a private agent's profile is made public; it takes the focus. */
function ConfirmPublic({
  registration,
  problem,
  onChanged,
}: {
  registration: BaseRegistrationState;
  problem: ReactNode;
  onChanged?: () => void;
}) {
  const question = useRef<HTMLParagraphElement>(null);
  useEffect(() => question.current?.focus(), []);
  const { busy } = registration;
  return (
    <>
      <p className="v4b-ask" ref={question} tabIndex={-1}>
        This makes the agent’s profile public. Continue?
      </p>
      {problem}
      <button
        type="button"
        className="v4b-btn"
        disabled={busy}
        onClick={() => registration.makePublicAndRegister(onChanged)}
      >
        Make public and continue
      </button>
      <button
        type="button"
        className="v4b-quiet"
        disabled={busy}
        onClick={registration.cancelMakePublic}
      >
        Cancel
      </button>
    </>
  );
}

/**
 * Registering with the wallet key (decision A): no address to paste. First the key itself: set up,
 * its backup confirmed, and held in this browser (one unlock), so the wallet sent is the one this
 * browser derived from it.
 */
type ReadyKey = Extract<RegisterKey, { k: 'ready' }>;

function KeyForm({
  keyState,
  agentName,
  busy,
  problem,
  starting,
  onRegister,
  onUnlock,
  onOpenWallet,
}: {
  keyState: RegisterKey;
  agentName: string;
  busy: boolean;
  problem: ReactNode;
  /** The offer itself ("Register … on Base"), else a registration that waits ("Continue"). */
  starting: boolean;
  /** Registers; right after an unlock, with the key just held (before the screen re-renders). */
  onRegister: (key?: ReadyKey) => void;
  onUnlock: (password: string) => Promise<RegisterKey>;
  onOpenWallet?: () => void;
}) {
  const [password, setPassword] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState('');
  const label = starting ? `Register ${agentName} on Base` : 'Continue';
  async function unlock(event: FormEvent) {
    event.preventDefault();
    setUnlockError('');
    setUnlocking(true);
    try {
      const next = await onUnlock(password);
      setPassword('');
      if (next.k === 'ready') onRegister(next);
      else if (next.k === 'refused' || next.k === 'error') setUnlockError(next.message);
    } catch (error) {
      setPassword('');
      setUnlockError(error instanceof Error ? error.message : 'Something went wrong. Try again.');
    } finally {
      setUnlocking(false);
    }
  }
  switch (keyState.k) {
    case 'nokey':
      return (
        <div className="v4b-body" data-k="key-setup">
          <p className="v4b-note">
            First, set up your wallet key. It controls the wallets of all your agents, including the
            Base ID {agentName} gets. It’s made and locked in this browser.
          </p>
          <button type="button" className="v4b-btn" onClick={onOpenWallet}>
            Set up your wallet key
          </button>
        </div>
      );
    case 'backup':
      return (
        <div className="v4b-body" data-k="key-backup">
          <p className="v4b-note v4b-bad">
            Confirm your backup key first. {agentName}’s Base ID will be in a wallet only that key
            controls.
          </p>
          <button type="button" className="v4b-btn" onClick={onOpenWallet}>
            Finish the backup
          </button>
        </div>
      );
    case 'unlock':
      return (
        <form className="v4b-body" onSubmit={(event) => void unlock(event)} data-k="key-unlock">
          <p className="v4b-note">
            Unlock your wallet key. This browser checks which wallet your key makes for {agentName}{' '}
            and registers only that one.
          </p>
          <input
            className="v4b-field"
            type="password"
            aria-label="Wallet password"
            placeholder="Wallet password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={unlocking || busy}
          />
          {unlockError ? (
            <p className="v4b-note alone v4b-bad" role="alert">
              {unlockError}
            </p>
          ) : null}
          {problem}
          <button
            type="submit"
            className="v4b-btn"
            disabled={unlocking || busy || !password}
            aria-busy={unlocking}
          >
            {unlocking ? 'Unlocking…' : starting ? 'Unlock and register' : 'Unlock and continue'}
          </button>
        </form>
      );
    case 'ready':
      return (
        <div className="v4b-body" data-k="key-ready">
          <div className="v4b-group">
            <div className="v4b-row">
              <span className="v4b-k">Controlled by</span>
              <span className="v4b-v">
                Your wallet key ·{' '}
                <span className="v4b-mono" title={keyState.owner}>
                  {short(keyState.owner)}
                </span>
              </span>
            </div>
            <div className="v4b-row">
              <span className="v4b-k">{agentName}’s wallet</span>
              <span className="v4b-v">Holds its Base ID and its money</span>
            </div>
          </div>
          {problem}
          <button type="button" className="v4b-btn" disabled={busy} onClick={() => onRegister()}>
            {label}
          </button>
        </div>
      );
    case 'refused':
    case 'error':
      return (
        <p className="v4b-note alone v4b-bad" role="alert">
          {keyState.message}
        </p>
      );
    default:
      return null;
  }
}

function BaseBody({
  state,
  id,
  finalizing,
  agentName,
  agentId,
  registration,
  isPublic,
  onChanged,
  walletKey,
  onOpenWallet,
  score = null,
}: {
  state: BaseScreenState;
  id: string | null;
  /** The quiet line while Base finalizes. */
  finalizing: string;
  agentName: string;
  agentId: string;
  registration: BaseRegistrationState;
  /** Public now (or made public here): Continue registers. Otherwise it asks first. */
  isPublic: boolean;
  onChanged?: () => void;
  walletKey: ReturnType<typeof useRegisterWithKey>;
  onOpenWallet?: () => void;
  /** Final only: the agent's Central City score from its passport, when it has one. */
  score?: CityScore | null;
}) {
  const keyState: RegisterKey = walletKey.state;
  const keyMode = isKeyMode(keyState);
  /** The controller takes the key just held at once, so the action right after uses it. */
  const withKey = (action: () => void) => (held?: ReadyKey) => {
    if (held)
      registration.setMode({
        kind: 'key',
        key: { owner: held.owner, expectedWallet: held.expectedWallet },
      });
    action();
  };
  const { identity, stage, wallet, boundOwner, busy, error, conflict } = registration;
  // A registration in progress that isn't advancing by itself (another browser, cleared storage,
  // or an error) asks for the owner's wallet again, with the start screen's own field.
  const stalled = registration.progressing && !busy && !registration.polling;
  // Cancel on the question returns to the offer with the focus in its wallet field.
  const shown = useRef(state);
  useEffect(() => {
    if (shown.current === 'confirm' && state === 'start')
      document.getElementById(`v4b-owner-${agentId}`)?.focus();
    shown.current = state;
  }, [state, agentId]);

  const problem = conflict ? (
    <>
      <p className="v4b-note alone v4b-bad" role="alert">
        {conflict.ownerAddress ? (
          <>
            {agentName}’s wallet is already controlled by{' '}
            <span className="v4b-mono" title={conflict.ownerAddress}>
              {short(conflict.ownerAddress)}
            </span>
            . Use that wallet.
          </>
        ) : (
          `${agentName}’s wallet is already controlled by a different wallet. Use the wallet you started with.`
        )}
      </p>
      {conflict.ownerAddress ? (
        <button
          type="button"
          className="v4b-quiet"
          disabled={busy}
          onClick={() => registration.continueWithBound(conflict.ownerAddress!, conflict.retry)}
        >
          Continue with that wallet
        </button>
      ) : null}
    </>
  ) : error ? (
    <p className="v4b-note alone v4b-bad" role="alert">
      {error}
    </p>
  ) : null;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (isPublic) registration.submit();
    else registration.askMakePublic();
  }

  const addressForm = (
    <form className="v4b-body" onSubmit={submit}>
      <input
        className="v4b-field"
        id={`v4b-owner-${agentId}`}
        placeholder="Your wallet address · 0x…"
        aria-label="Your wallet address"
        autoComplete="off"
        spellCheck={false}
        value={registration.address}
        onChange={(event) => registration.setAddress(event.target.value)}
        disabled={busy}
      />
      <p className="v4b-note with-info">
        Your wallet will control it. Address only.{' '}
        <InfoTip text="Paste the public address of a wallet you own. Never a seed phrase or private key. Central City never has your keys." />
      </p>
      {problem}
      <button type="submit" className="v4b-btn" disabled={busy || !registration.address.trim()}>
        Continue
      </button>
    </form>
  );
  const walletForm = keyMode ? (
    <KeyForm
      keyState={keyState}
      agentName={agentName}
      busy={busy}
      problem={problem}
      starting={state === 'start'}
      onRegister={withKey(() => (isPublic ? registration.submit() : registration.askMakePublic()))}
      onUnlock={walletKey.unlock}
      onOpenWallet={onOpenWallet}
    />
  ) : keyState.k === 'loading' ? null : (
    addressForm
  );

  // With wallets on, the agent's wallet is also its money wallet: shown only as Add funds shows it.
  const reported = validAddress(wallet?.address);
  const { address: agentWallet, note: walletNote } = walletAddressShown(keyState, reported);
  // Who controls the Base ID, said only when it is known: the wallet key held here (unlocked and
  // the same address), or, for an agent registered before wallets, the person's own wallet outside
  // Central City (as the Wallet screen says). While the key is locked: just the address.
  const ownerLabel = !keyMode
    ? 'You'
    : keyState.k !== 'ready' || !boundOwner
      ? null
      : keyState.owner.toLowerCase() === boundOwner.toLowerCase()
        ? 'Your wallet key'
        : 'Your wallet outside Central City';
  const wallets =
    reported || boundOwner ? (
      <div className="v4b-group">
        {agentWallet ? (
          <div className="v4b-row">
            <span className="v4b-k">{agentName}’s wallet</span>
            <span className="v4b-v v4b-mono" title={agentWallet}>
              {short(agentWallet)}
            </span>
            <CopyButton address={agentWallet} />
          </div>
        ) : walletNote ? (
          <div className="v4b-row" data-k="wallet-hidden">
            <span className="v4b-k">{agentName}’s wallet</span>
            <span className="v4b-v">{walletNote}</span>
          </div>
        ) : null}
        {/* Only the owner the server has bound, never an address remembered in this browser. */}
        {boundOwner ? (
          <div className="v4b-row">
            <span className="v4b-k">Controlled by</span>
            <span className="v4b-v">
              {ownerLabel ? `${ownerLabel} · ` : null}
              <span className="v4b-mono" title={boundOwner}>
                {short(boundOwner)}
              </span>
            </span>
            <CopyButton address={boundOwner} />
          </div>
        ) : null}
      </div>
    ) : null;

  // A registration the server says is stuck (canRetry) can be started again from here, as a
  // failed one can; with the wallet key it unlocks first, as on the failed screen.
  const stuck = !stalled && openRetryOffered(identity, stage) && keyState.k !== 'loading';
  const retryOffer = stuck ? (
    <>
      <p className="v4b-note">
        {identity?.stage === 'handing_over'
          ? 'It isn’t moving. Try again retries the same hand-over now.'
          : 'It isn’t moving. Try again starts a new attempt.'}
      </p>
      {/* Only next to the button it refers to, so it goes when the server stops accepting one. */}
      {registration.retryFailed ? (
        <p className="v4b-note alone v4b-bad" role="alert">
          The new attempt couldn’t be started just now. Try again in a moment.
        </p>
      ) : null}
      {keyMode && keyState.k !== 'ready' ? (
        <KeyForm
          keyState={keyState}
          agentName={agentName}
          busy={busy}
          problem={problem}
          starting={false}
          onRegister={withKey(registration.retryNow)}
          onUnlock={walletKey.unlock}
          onOpenWallet={onOpenWallet}
        />
      ) : (
        <>
          {problem}
          <button type="button" className="v4b-btn" disabled={busy} onClick={registration.retryNow}>
            Try again
          </button>
        </>
      )}
    </>
  ) : null;
  const continueIfStalled = stalled ? walletForm : (retryOffer ?? problem);

  switch (state) {
    case 'loading':
      return null;
    case 'unavailable':
      return <p className="v4b-note alone">Not available for this agent</p>;
    case 'error':
      return (
        <>
          <p className="v4b-note alone v4b-bad" role="alert">
            The Base registration status couldn’t be loaded.
          </p>
          <button type="button" className="v4b-btn" onClick={registration.reloadStatus}>
            Try again
          </button>
        </>
      );
    case 'start':
    case 'confirm':
      return (
        <>
          <div className="v4b-hero">
            <div className="v4b-mark">
              <BaseIcon />
            </div>
            <b>Give {agentName} a Base identity</b>
            <span>Its own ID and wallet on Base. Free.</span>
          </div>
          {state === 'confirm' ? (
            <ConfirmPublic registration={registration} problem={problem} onChanged={onChanged} />
          ) : (
            walletForm
          )}
        </>
      );
    case 'registering':
      return (
        <>
          <div className="v4b-group">
            <div className="v4b-row" role="status">
              <span className="v4b-spin" aria-hidden="true" />
              <span className="v4b-k">Registering on Base</span>
              <span className="v4b-v">{stuck ? 'taking long' : 'a few seconds'}</span>
            </div>
          </div>
          {continueIfStalled}
        </>
      );
    case 'slow':
      return (
        <>
          <div className="v4b-group">
            <div className="v4b-row">
              <span className="v4b-k">Taking longer than usual</span>
              {stuck ? null : (
                <button
                  type="button"
                  className="v4b-quiet"
                  disabled={busy}
                  onClick={registration.checkAgain}
                >
                  Check again
                </button>
              )}
            </div>
          </div>
          {stuck ? null : <p className="v4b-note">Base is busy. It continues by itself.</p>}
          {continueIfStalled}
        </>
      );
    case 'finalizing':
      return (
        <>
          <div className="v4b-group">
            <div className="v4b-row">
              <span className="v4b-k">Base ID</span>
              <span className="v4b-v strong">{id}</span>
            </div>
            <div className="v4b-row v4b-sub">
              <span className="v4b-pulse" aria-hidden="true" />
              {finalizing} <InfoTip text={FINALIZING_INFO} />
            </div>
          </div>
          {wallets}
          {continueIfStalled}
        </>
      );
    case 'final': {
      // The public passport and the final transaction exist only once Base has finalized.
      const txHash = identity?.txHash && TX_HASH.test(identity.txHash) ? identity.txHash : null;
      return (
        <>
          <div className="v4b-group">
            <div className="v4b-row">
              <span className="v4b-k">Base ID</span>
              <span className="v4b-v strong">
                {id}{' '}
                <span className="v4b-okc" role="img" aria-label="Confirmed">
                  <CheckIcon />
                </span>
              </span>
            </div>
            {identity?.agentUri ? (
              <a className="v4b-row" href={identity.agentUri} target="_blank" rel="noreferrer">
                <span className="v4b-k">Passport</span>
                <span className="v4b-v">{passportCode(identity.agentUri)}</span>
                <ChevIcon />
              </a>
            ) : null}
            {score ? (
              <div className="v4b-row" data-k="score">
                <span className="v4b-k">Rating</span>
                <span className="v4b-v">{scoreLine(score)}</span>
              </div>
            ) : null}
            {txHash ? (
              <a
                className="v4b-row"
                href={`https://basescan.org/tx/${txHash}`}
                target="_blank"
                rel="noreferrer"
              >
                <span className="v4b-k">Transaction</span>
                <span className="v4b-v">
                  Basescan <ExtIcon />
                </span>
              </a>
            ) : null}
          </div>
          <DirectoryGroup agentId={agentId} agentName={agentName} />
          {wallets}
          {keyState.k === 'ready' &&
          wallet?.address?.toLowerCase() === keyState.expectedWallet.toLowerCase() ? (
            <p className="v4b-note" data-k="derived">
              Checked in this browser: this is the wallet your own key makes for {agentName}. It
              holds the Base ID and the money.
            </p>
          ) : null}
          <p className="v4b-note">
            {agentName}’s wallet has no seed phrase of its own. Network fee covered by Central City.
          </p>
        </>
      );
    }
    case 'rechecking':
      return (
        <>
          <div className="v4b-group">
            <div className="v4b-row" role="status">
              <span className="v4b-spin" aria-hidden="true" />
              <span className="v4b-k">Re-checking on Base</span>
              {stuck ? null : <span className="v4b-v">nothing to do</span>}
            </div>
          </div>
          {continueIfStalled}
        </>
      );
    case 'failed': {
      const canRetry = identity !== null && stage !== null && retryAllowed(identity, stage);
      const known = boundOwner ?? registration.owner;
      return (
        <>
          <div className="v4b-group">
            <div className="v4b-row" role="alert">
              <span className="v4b-k v4b-bad">Registration didn’t go through</span>
            </div>
          </div>
          {canRetry && !known && !keyMode && keyState.k !== 'loading' ? (
            <input
              className="v4b-field"
              placeholder="Your wallet address · 0x…"
              aria-label="Your wallet address"
              autoComplete="off"
              spellCheck={false}
              value={registration.address}
              onChange={(event) => registration.setAddress(event.target.value)}
            />
          ) : null}
          {canRetry && keyMode && keyState.k !== 'ready' ? (
            <KeyForm
              keyState={keyState}
              agentName={agentName}
              busy={busy}
              problem={problem}
              starting={false}
              onRegister={withKey(registration.retryNow)}
              onUnlock={walletKey.unlock}
              onOpenWallet={onOpenWallet}
            />
          ) : null}
          {keyMode && keyState.k !== 'ready' ? null : problem}
          {canRetry && keyState.k !== 'loading' && (!keyMode || keyState.k === 'ready') ? (
            <button
              type="button"
              className="v4b-btn"
              disabled={busy}
              onClick={registration.retryNow}
            >
              Try again
            </button>
          ) : null}
          <a className="v4b-quiet" href="/support">
            Get help
          </a>
        </>
      );
    }
  }
}

/**
 * The Base row on the agent's home in My agents v4 (place it inside the home's row group): "Base"
 * and where the registration stands, with the quiet finalizing line under it.
 */
export function BaseRowSummary({
  agentId,
  onOpen,
  isPublic = true,
  hasProfile = true,
  paused = false,
}: {
  agentId: string;
  onOpen: () => void;
  isPublic?: boolean;
  hasProfile?: boolean;
  /** A dialog or sheet covers the page: no status reads meanwhile (the last answer stays). */
  paused?: boolean;
}) {
  // An agent without a profile is "Not available" at once: there is nothing to read for it.
  const registration = useBaseRegistrationStatus(
    agentId,
    paused || !mayHaveBase({ isPublic, hasProfile }),
  );
  const now = useSlowTick(registration);
  const { state, id, since } = screenOf(registration, { isPublic, hasProfile }, now);
  const row = baseRowSummary(state, id, since, now);
  const score = useCityScore(state === 'final' ? id : null, paused);
  // While unknown the value keeps its place, empty, and fades in once known; a value known at
  // once (the agent's last answer, or "Not available") shows without a fade.
  const pending = row.text === null;
  return (
    <>
      <button type="button" className="v4b-row" onClick={onOpen}>
        <span className="v4b-k">Base</span>
        <span
          className={`v4b-v v4b-sum${row.tone === 'strong' ? ' strong' : row.tone === 'bad' ? ' v4b-bad' : ''}`}
          data-pending={pending || undefined}
        >
          {row.spinner ? <span className="v4b-spin" aria-hidden="true" /> : null}
          {row.text}
          {row.check ? (
            <>
              {' '}
              <span className="v4b-okc" role="img" aria-label="Confirmed">
                <CheckIcon />
              </span>
            </>
          ) : null}
        </span>
        <ChevIcon />
      </button>
      {row.sub ? (
        <div className="v4b-row v4b-sub">
          <span className="v4b-pulse" aria-hidden="true" />
          {row.sub}
        </div>
      ) : score ? (
        <div className="v4b-row v4b-sub" data-k="score">
          {scoreLine(score)}
        </div>
      ) : null}
    </>
  );
}
