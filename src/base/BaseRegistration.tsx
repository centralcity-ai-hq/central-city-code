import { Check, Copy, ExternalLink, Info } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Agent } from '../../shared/types';
import '../agents/my-agents-v3.css';
import './base-registration.css';
import {
  FINALIZING_INFO,
  TX_HASH,
  finishedId,
  retryAllowed,
  short,
  validAddress,
  type IdentityView,
  type Stage,
} from './baseRegistrationModel';
import { useBaseRegistration } from './useBaseRegistration';
import {
  isKeyMode,
  useOwnerModeFromKey,
  useRegisterWithKey,
  walletAddressShown,
} from './useRegisterWithKey';
import {
  finalizingLine,
  finalizingSince,
  msUntilFinalizingLong,
} from '../agents/v4/baseScreenModel';

const steps = ['Registering on Base', 'Handing identity to the agent’s wallet', 'Done'] as const;

function stepOf(identity: IdentityView, stage: Stage): number {
  if (stage === 'confirmed') return 2;
  if (stage === 'handing_over') return 1;
  if (stage === 'failed') return identity.erc8004AgentId ? 1 : 0;
  return 0;
}

/** A shortened address, the whole one on hover, and a button that copies the whole one. */
function CopyAddress({ address, label }: { address: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  function copy() {
    // Called straight from the click, so the browser treats it as the person's own copy. A
    // refused clipboard changes nothing on screen; the whole address is still in the tooltip.
    try {
      void navigator.clipboard.writeText(address).then(
        () => {
          window.clearTimeout(timer.current);
          setCopied(true);
          timer.current = window.setTimeout(() => setCopied(false), 2000);
        },
        () => undefined,
      );
    } catch {
      // No clipboard in this browser.
    }
  }
  return (
    <span className="base-reg-address">
      <span className="base-reg-mono" title={address}>
        {short(address)}
      </span>
      <button
        type="button"
        className="ma3-icon-btn base-reg-copy"
        aria-label={`Copy ${label}`}
        title={`Copy ${label}`}
        onClick={copy}
      >
        {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
      </button>
      <span className="visually-hidden" role="status">
        {copied ? 'Copied' : ''}
      </span>
    </span>
  );
}

function BasescanLink({ hash, children }: { hash: string; children: ReactNode }) {
  return (
    <a
      className="ma3-link base-reg-link"
      href={`https://basescan.org/tx/${hash}`}
      target="_blank"
      rel="noreferrer"
    >
      {children} <ExternalLink size={12} aria-hidden="true" />
    </a>
  );
}

/**
 * "Make it a Base agent" (owner only; My agents → agent → Base): gives the agent its own wallet on
 * Base and registers its ERC-8004 identity, controlled by the wallet the owner names. The server
 * does the chain work step by step; this calls it again when the server says to (every few seconds
 * on older servers) until the identity is confirmed.
 */
export function BaseRegistration({ agent }: { agent: Agent }) {
  const isPublic = agent.visibility === 'public';
  const registration = useBaseRegistration(agent.id, false, { ownerModePending: true });
  // Wallets on: registering takes the person's wallet key, on the agent's Base screen.
  const key = useRegisterWithKey(agent.id);
  useOwnerModeFromKey(registration.setMode, key.state);
  const keyMode = isKeyMode(key.state);
  const keyReady = key.state.k === 'ready';
  const {
    loading,
    loadFailed,
    identity,
    wallet,
    stage,
    busy,
    error,
    conflict,
    backoff,
    retryFailed,
    progressing,
    polling,
    owner,
    boundOwner,
    address,
    setAddress,
    retryNow,
    continueWithBound,
  } = registration;
  /** The finalizing explanation, opened from its info button. */
  const [aboutOpen, setAboutOpen] = useState(false);
  // Re-renders once Base's usual finalizing time has passed, so the line says so on time.
  const finalizingFrom = finalizingSince(identity, stage);
  const [, setTick] = useState(0);
  useEffect(() => {
    const wait = msUntilFinalizingLong(finalizingFrom, Date.now());
    if (wait === null) return;
    const handle = window.setTimeout(() => setTick((tick) => tick + 1), wait);
    return () => window.clearTimeout(handle);
  }, [finalizingFrom]);

  function submit(event: FormEvent) {
    event.preventDefault();
    registration.submit();
  }

  const problem = conflict ? (
    <div className="base-reg-problem">
      <p className="base-reg-error" role="alert">
        {conflict.ownerAddress ? (
          <>
            {agent.name}’s wallet is already controlled by{' '}
            <span className="base-reg-mono" title={conflict.ownerAddress}>
              {short(conflict.ownerAddress)}
            </span>
            . Use that wallet.
          </>
        ) : (
          `${agent.name}’s wallet is already controlled by a different wallet. Use the wallet you started with.`
        )}
      </p>
      {conflict.ownerAddress ? (
        <button
          type="button"
          className="ma3-btn ma3-btn-ghost ma3-btn-sm ma3-self-start"
          disabled={busy}
          onClick={() => continueWithBound(conflict.ownerAddress!, conflict.retry)}
        >
          Continue with that wallet
        </button>
      ) : null}
    </div>
  ) : error ? (
    <p className="base-reg-error" role="alert">
      {error}
    </p>
  ) : null;

  /** With the wallet key, this panel never asks for an address: the Base screen registers. */
  const keyElsewhere = (
    <p className="ma3-panel-note" data-k="key-elsewhere">
      {agent.name} registers with your wallet key on its Base screen: My agents → {agent.name} →
      Base.
    </p>
  );

  /** For a registration that isn't advancing by itself: the owner's wallet address, to continue. */
  const continueForm = keyMode ? (
    keyElsewhere
  ) : (
    <form className="base-reg" onSubmit={submit}>
      <label className="base-reg-label" htmlFor={`base-owner-${agent.id}`}>
        Your wallet address, to continue
      </label>
      <input
        id={`base-owner-${agent.id}`}
        className="ma3-field base-reg-mono"
        autoComplete="off"
        spellCheck={false}
        placeholder="0x…"
        value={address}
        onChange={(event) => setAddress(event.target.value)}
      />
      <p className="ma3-panel-note">
        Use the same wallet you started with. Never enter a seed phrase.
      </p>
      <button
        type="submit"
        className="ma3-btn ma3-btn-primary ma3-self-start"
        disabled={!address.trim()}
      >
        Continue
      </button>
    </form>
  );

  // Until it is known whether wallets are on, nothing is offered: an action then would do nothing.
  if (loading || key.state.k === 'loading')
    return (
      <p className="ma3-panel-note" role="status">
        Loading…
      </p>
    );

  if (loadFailed)
    return (
      <div className="base-reg">
        <p className="base-reg-error" role="alert">
          The Base registration status couldn’t be loaded.
        </p>
        <button
          type="button"
          className="ma3-btn ma3-btn-ghost ma3-btn-sm ma3-self-start"
          onClick={registration.reloadStatus}
        >
          Try again
        </button>
      </div>
    );

  const doneId = identity && stage ? finishedId(identity, stage) : null;

  if (identity && stage && doneId !== null) {
    const confirmed = stage === 'confirmed';
    // With wallets on, the agent's wallet is also its money wallet: shown only as Add funds does.
    const { address: agentWallet, note: walletNote } = walletAddressShown(
      key.state,
      validAddress(wallet?.address),
    );
    // The final transaction once confirmed; before that, the transaction already in a block.
    const shownTx = confirmed ? identity.txHash : (identity.txHash ?? identity.mintTxHash);
    const txHash = shownTx && TX_HASH.test(shownTx) ? shownTx : null;
    // Not advancing by itself (another browser, cleared storage, or an error): the same form as
    // during the steps, under the finished view.
    const stalled = !confirmed && !busy && !polling;
    return (
      <div className="base-reg">
        <div className="base-reg-head">
          <p className={confirmed ? 'base-reg-done' : 'base-reg-id base-reg-title'}>
            {confirmed ? <Check size={16} aria-hidden="true" /> : null}
            <span>
              Base agent · ID <span className="base-reg-mono">{doneId}</span>
            </span>
            {confirmed ? null : (
              <button
                type="button"
                className="base-reg-info"
                aria-label="About finalizing"
                title={FINALIZING_INFO}
                aria-expanded={aboutOpen}
                onClick={() => setAboutOpen((open) => !open)}
              >
                <Info size={14} aria-hidden="true" />
              </button>
            )}
          </p>
          {confirmed ? null : (
            <p className="base-reg-sub">
              {stage === 'rechecking'
                ? 'Re-checking on Base…'
                : finalizingLine(finalizingFrom, Date.now())}
            </p>
          )}
          {!confirmed && aboutOpen ? <p className="base-reg-sub">{FINALIZING_INFO}</p> : null}
        </div>
        <dl className="ma3-kv base-reg-kv">
          <dt>Base ID</dt>
          <dd className="base-reg-mono">{doneId}</dd>
          {agentWallet ? (
            <>
              <dt>{agent.name}’s wallet</dt>
              <dd>
                <CopyAddress address={agentWallet} label={`${agent.name}’s wallet address`} />
              </dd>
            </>
          ) : walletNote ? (
            <>
              <dt>{agent.name}’s wallet</dt>
              <dd data-k="wallet-hidden">{walletNote}</dd>
            </>
          ) : null}
          {/* Only the owner the server has bound, never an address remembered in this browser. */}
          {boundOwner ? (
            <>
              <dt>Controlled by</dt>
              <dd>
                <span className="base-reg-owner">Your wallet</span>
                <CopyAddress address={boundOwner} label="your wallet address" />
              </dd>
            </>
          ) : null}
        </dl>
        <p className="ma3-panel-note base-reg-help">
          {agent.name}’s wallet has no seed phrase of its own. Your wallet controls it, so keep your
          wallet’s seed phrase safe. Central City never has the seed phrase or private key of your
          wallet.
        </p>
        {confirmed || txHash ? (
          <dl className="ma3-kv base-reg-kv">
            {/* The public passport exists only once Base has finalized the registration. */}
            {confirmed ? (
              <>
                <dt>Profile</dt>
                <dd>
                  <a className="ma3-link" href={identity.agentUri} target="_blank" rel="noreferrer">
                    {identity.agentUri.replace(/^https:\/\//, '')}
                  </a>
                </dd>
              </>
            ) : null}
            {txHash ? (
              <>
                <dt>Transaction</dt>
                <dd>
                  <BasescanLink hash={txHash}>View on basescan</BasescanLink>
                </dd>
              </>
            ) : null}
          </dl>
        ) : null}
        <p className="ma3-panel-note">
          The network fee for this registration was covered by Central City.
        </p>
        {confirmed ? null : problem}
        {stalled ? continueForm : null}
        {!confirmed && backoff === 'poll' ? (
          <p className="ma3-panel-note">
            Couldn’t check on the registration just now. Trying again in 30 seconds.
          </p>
        ) : null}
      </div>
    );
  }

  if (identity && stage === 'failed') {
    const canRetry = retryAllowed(identity, stage);
    const known = boundOwner ?? owner;
    return (
      <div className="base-reg">
        <p className="ma3-panel-note" role="alert">
          The Base registration didn’t complete.
          {identity.erc8004AgentId
            ? ` Base ID ${identity.erc8004AgentId} was created, but it isn’t in the agent’s wallet yet.`
            : ''}{' '}
          {canRetry
            ? 'You can try again; if it keeps failing, contact support.'
            : 'It can’t be tried again from here; contact support.'}
        </p>
        {canRetry && keyMode && !keyReady ? keyElsewhere : null}
        {canRetry && !known && !keyMode ? (
          <input
            aria-label="Your wallet address"
            className="ma3-field base-reg-mono"
            autoComplete="off"
            spellCheck={false}
            placeholder="0x…"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
        ) : null}
        {problem}
        {canRetry && (!keyMode || keyReady) ? (
          <button
            type="button"
            className="ma3-btn ma3-btn-primary ma3-self-start"
            disabled={busy}
            onClick={retryNow}
          >
            Try again
          </button>
        ) : null}
      </div>
    );
  }

  if (identity && stage && (progressing || busy)) {
    const current = stepOf(identity, stage);
    // A registration that isn't advancing by itself (another browser, cleared storage, or an
    // error) asks for the owner's wallet address again to continue.
    const stalled = !busy && !polling;
    // Older servers send no stage; each of their steps waits for finality, so it takes longer.
    const legacy = identity.stage === undefined;
    // A replaced block can change the number, so it is hidden until Base has settled again.
    const id =
      stage === 'handing_over'
        ? (identity.erc8004AgentId ?? identity.provisionalAgentId ?? null)
        : null;
    // The registration transaction itself, marked pending until the hand-over is in a block.
    const mintTx =
      id !== null && identity.mintTxHash && TX_HASH.test(identity.mintTxHash)
        ? identity.mintTxHash
        : null;
    const note =
      stage === 'rechecking'
        ? 'Base replaced a recent block; re-checking. Nothing to do.'
        : legacy
          ? 'Each step waits until Base has finalized it, so this takes about 30 minutes. You can close this panel; it continues when you come back.'
          : 'You can close this panel; it continues when you come back.';
    return (
      <div className="base-reg">
        <ol className="base-reg-steps" aria-label="Base registration progress">
          {steps.map((label, index) => (
            <li
              key={label}
              data-state={index < current ? 'done' : index === current ? 'active' : 'next'}
              aria-current={index === current ? 'step' : undefined}
            >
              {label}
            </li>
          ))}
        </ol>
        {id !== null ? (
          <p className="base-reg-id">
            Base ID <span className="base-reg-mono">{id}</span>
          </p>
        ) : null}
        {problem}
        {stalled ? (
          continueForm
        ) : (
          <>
            <p className="ma3-panel-note" role="status">
              {note}
            </p>
            {mintTx ? <BasescanLink hash={mintTx}>View on basescan (pending)</BasescanLink> : null}
            {backoff === 'poll' ? (
              <p className="ma3-panel-note">
                Couldn’t check on the registration just now. Trying again in 30 seconds.
              </p>
            ) : null}
            {/* Only next to the button it refers to, so it goes when the server stops accepting one. */}
            {retryFailed && retryAllowed(identity, stage) ? (
              <p className="base-reg-error" role="alert">
                The new attempt couldn’t be started just now. Try again in a moment.
              </p>
            ) : null}
            {retryAllowed(identity, stage) ? (
              <button
                type="button"
                className="ma3-btn ma3-btn-ghost ma3-btn-sm ma3-self-start"
                disabled={busy}
                onClick={retryNow}
              >
                Taking long? Try again
              </button>
            ) : null}
          </>
        )}
      </div>
    );
  }

  if (!isPublic)
    return (
      <p className="ma3-panel-note">
        Only agents created as Public can become Base agents. To make one, add a new agent and
        choose Public under “Who can see it”.
      </p>
    );

  if (keyMode)
    return (
      <div className="base-reg">
        <p className="ma3-panel-note">
          Give {agent.name} its own wallet on Base and a public ERC-8004 identity that agent
          explorers can list.
        </p>
        {keyElsewhere}
      </div>
    );

  return (
    <form className="base-reg" onSubmit={submit}>
      <p className="ma3-panel-note">
        Give {agent.name} its own wallet on Base and a public ERC-8004 identity that agent explorers
        can list.
      </p>
      <label className="base-reg-label" htmlFor={`base-owner-${agent.id}`}>
        Your wallet address
      </label>
      <input
        id={`base-owner-${agent.id}`}
        className="ma3-field base-reg-mono"
        inputMode="text"
        autoComplete="off"
        spellCheck={false}
        placeholder="0x…"
        value={address}
        onChange={(event) => setAddress(event.target.value)}
        disabled={busy}
        aria-describedby={`base-owner-note-${agent.id}`}
      />
      <p className="ma3-panel-note" id={`base-owner-note-${agent.id}`}>
        This wallet will control {agent.name}’s wallet. Never enter a seed phrase.
      </p>
      {problem}
      <button
        type="submit"
        className="ma3-btn ma3-btn-primary ma3-self-start"
        disabled={busy || !address.trim()}
      >
        {busy ? 'Starting…' : 'Make it a Base agent'}
      </button>
    </form>
  );
}
