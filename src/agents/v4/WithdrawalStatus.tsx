import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { formatUnits } from 'viem';
import { ApiError } from '../../api';
import type { WalletView } from '../../base/wallet/api';
import { usePasswordLock } from '../../base/wallet/usePasswordLock';
import { usdcText } from '../../base/wallet/limits';
import {
  askCancel,
  cancelSignaturePath,
  checkOperation,
  clearAnchor,
  DONE,
  dropReleased,
  readReleased,
  readWithdrawal,
  releaseAnchor,
  sentStatus,
  signAndSend,
  WithdrawalCheckError,
  WithdrawalLockedError,
  type ReleasedOperation,
  type SigningRequest,
  type WithdrawalAnchor,
  type WithdrawalToken,
  type WithdrawalView,
} from '../../base/wallet/withdraw';
import { VaultCryptoError } from '../../base/vault';
import { SettingsLoading } from './settingsShared';

/*
 * An owner operation on its way (a withdrawal, or a payment, which goes out as one): its steps as
 * Base reports them, read every few seconds until it is done, and its cancel while it can still be
 * cancelled. The screen never says "cancelled" before Base says so, nor paid or final before final.
 * Once Base settled it at its safe head the recipient has the money: it reads "Sent · awaiting
 * finality", its anchor is released and the next operation can start.
 */

const DECIMALS: Record<WithdrawalToken, number> = { USDC: 6, ETH: 18 };
const POLL_MS = 3_000;
/** Once Base settled it at its safe head, final is minutes away: read it less often. */
const SAFE_POLL_MS = 10_000;

/** A POST answer's `safe` never counts (the server sets it there only when final). */
const posted = (view: WithdrawalView): WithdrawalView => ({ ...view, safe: undefined });

export const signingFailure = (error: unknown) =>
  error instanceof WithdrawalLockedError
    ? error.message
    : error instanceof WithdrawalCheckError
      ? `Not signed: ${error.message}`
      : error instanceof VaultCryptoError || error instanceof ApiError || error instanceof Error
        ? error.message
        : 'Something went wrong. Try again.';

export const shortHex = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
export const shownAmount = (raw: bigint, token: WithdrawalToken) => {
  const text = formatUnits(raw, DECIMALS[token]);
  // Exact: every digit that is signed is shown (at least two decimals).
  return token === 'USDC' ? usdcText(raw) : text;
};

/** The operation a cancel must sit at the nonce of: as checked and signed in this browser. */
export type SignedOperation = {
  userOperation: SigningRequest['userOperation'];
  userOpHash: `0x${string}`;
};

export function PasswordField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="w4-field">
      <span>Wallet password</span>
      <input
        type="password"
        autoComplete="current-password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function ErrorLine({ message }: { message: string }) {
  return message ? (
    <p className="w4-error" role="alert">
      {message}
    </p>
  ) : null;
}

/** The steps of an operation on its way, as Base reports them. */
function Steps({ view, label }: { view: WithdrawalView; label: string }) {
  const order = ['submitted', 'included', 'final'] as const;
  const at = order.indexOf(view.state as (typeof order)[number]);
  const steps = [
    { label: 'Signed in your browser', done: true },
    { label: 'Sent to Base', done: at >= 0 },
    {
      label: view.blockNumber
        ? `In block ${view.blockNumber.toLocaleString('en-US')}`
        : 'In a block',
      done: at >= 1,
    },
    { label: 'Final', done: at >= 2 },
  ];
  return (
    <ol className="w4-status" aria-label={label}>
      {steps.map((step) => (
        <li key={step.label} data-done={step.done || undefined}>
          {step.label}
        </li>
      ))}
    </ol>
  );
}

export function WithdrawalStatus({
  agentId,
  wallet,
  withdrawalId,
  original,
  initial = null,
  noun = 'withdrawal',
  lead,
  after,
  payment,
  next,
  onGone,
}: {
  agentId: string;
  wallet: WalletView;
  withdrawalId: string;
  /** As checked and signed in this browser (its anchor): the only operation a cancel binds to. */
  original: SignedOperation;
  initial?: WithdrawalView | null;
  noun?: 'withdrawal' | 'payment';
  /** The line above the steps; by default the amount and where it goes. */
  lead?: (view: WithdrawalView) => ReactNode;
  /** Shown under the status (a payment's receipt once it is final). */
  after?: (view: WithdrawalView) => ReactNode;
  /** A payment's names, kept with it once it is released, so its quiet line still names it. */
  payment?: WithdrawalAnchor['payment'];
  /** Offered once the wallet may start its next operation ("New payment"). */
  next?: { label: string; onClick: () => void };
  /** The server doesn't know this operation: its anchor is gone and the screen moves on. */
  onGone?: () => void;
}) {
  const [view, setView] = useState<WithdrawalView | null>(initial ? posted(initial) : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** The cancel's password field shows only once the owner chooses to cancel. */
  const [cancelOpen, setCancelOpen] = useState(false);
  const { password, setPassword, alive } = usePasswordLock(busy);
  const Noun = noun === 'payment' ? 'Payment' : 'Withdrawal';
  // The poll reads the latest of these without starting over.
  const latest = useRef({ payment, onGone });
  useEffect(() => {
    latest.current = { payment, onGone };
  });

  // While it is on its way, read it every few seconds until it is done.
  const signedHash = original.userOpHash;
  useEffect(() => {
    let stop = false;
    let timer = 0;
    let released = false;
    const operation = { withdrawalId, userOpHash: signedHash };
    const tick = async () => {
      let wait = POLL_MS;
      try {
        const next = await readWithdrawal(agentId, withdrawalId);
        if (stop) return;
        // Only ever this operation's answer.
        if (next.withdrawalId === withdrawalId) {
          setView(next);
          if (DONE.includes(next.state)) {
            clearAnchor(agentId, operation);
            dropReleased(agentId, withdrawalId);
            return;
          }
          if (sentStatus(next, noun).released) {
            // Settled at Base's safe head: once, the wallet may start its next operation. This
            // one is still read, less often, until it is final.
            if (!released)
              releaseAnchor(agentId, { ...operation, payment: latest.current.payment });
            released = true;
            wait = SAFE_POLL_MS;
          }
        }
      } catch (err) {
        if (stop) return;
        // Not known to the server: nothing to wait for. Any other miss: the next read tries again.
        if (err instanceof ApiError && err.status === 404) {
          clearAnchor(agentId, operation);
          dropReleased(agentId, withdrawalId);
          latest.current.onGone?.();
          return;
        }
      }
      if (!stop) timer = window.setTimeout(() => void tick(), wait);
    };
    void tick();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [agentId, withdrawalId, signedHash, noun]);

  async function cancel(event: FormEvent) {
    event.preventDefault();
    if (!wallet.address) return;
    setError('');
    setBusy(true);
    // Marked before anything else: if the password goes while the cancel is asked, nothing is sent.
    const mark = alive();
    try {
      // Only ever the operation this browser checked and signed: the server's copy isn't evidence
      // of what was signed. The one it reports under this id must be that one.
      if (view && original.userOpHash.toLowerCase() !== view.userOpHash.toLowerCase())
        throw new WithdrawalCheckError(`The ${noun} on its way isn’t the one signed here.`);
      const asked = await askCancel(agentId, withdrawalId);
      const noop = asked.cancel;
      if (!noop?.userOperation) throw new Error(`This ${noun} can’t be cancelled any more.`);
      const hash = checkOperation({
        userOperation: noop.userOperation,
        userOpHash: noop.userOpHash,
        entryPoint: noop.entryPoint,
        chainId: asked.chainId,
        wallet: wallet.address,
        owner: wallet.ownerAddress,
        agentId,
        expected: { kind: 'noop', original },
      });
      setView(
        posted(
          await signAndSend(
            cancelSignaturePath(agentId, withdrawalId),
            hash,
            password,
            mark,
            undefined,
            wallet.ownerAddress,
          ),
        ),
      );
      setPassword('');
    } catch (err) {
      setPassword('');
      setError(signingFailure(err));
    } finally {
      setBusy(false);
    }
  }

  if (!view) return <SettingsLoading />;
  const status = sentStatus(view, noun);
  return (
    <>
      <p className="w4-lead">
        {lead
          ? lead(view)
          : `${shownAmount(BigInt(view.amount.raw), view.token)} ${view.token} to ${shortHex(view.to)}`}
      </p>
      {status.headline ? (
        <p className="w4-sent-head" data-phase={status.phase} role="status">
          {status.headline}
        </p>
      ) : null}
      {status.phase === 'sent' ? (
        // The money arrived; final is minutes away. No countdown: Base decides when.
        <p className="w4-hint">{status.note}</p>
      ) : view.state === 'failed' ? (
        <p className="w4-error" role="alert">
          It didn’t go through{view.errorCode ? ` (${view.errorCode})` : ''}. Nothing left the
          wallet.
        </p>
      ) : view.state === 'expired' ? (
        <p className="w4-hint">It wasn’t signed in time, so it can never be sent.</p>
      ) : view.state === 'cancelled' ? (
        <p className="w4-hint" role="status">
          Cancelled: the cancel is final on Base and the {noun} never landed.
        </p>
      ) : view.state === 'cancel_pending' ? (
        <p className="w4-hint" role="status">
          Cancelling. Until Base settles it, the {noun} may still land.
        </p>
      ) : (
        <Steps view={view} label={`${Noun} status`} />
      )}
      {after?.(view)}
      {view.explorerUrl ? (
        <a className="w4-link" href={view.explorerUrl} target="_blank" rel="noreferrer">
          View on Basescan
        </a>
      ) : null}
      {view.state === 'submitted' && !view.cancel ? (
        cancelOpen ? (
          <form onSubmit={(event) => void cancel(event)} className="w4-steps">
            <p className="w4-hint">
              To cancel, you sign a no-op at the same place; whichever Base takes first wins, so the{' '}
              {noun} may still land. If the cancellation fee cannot be covered, nothing is signed or
              charged for the cancellation. The original {noun} may still complete.
            </p>
            <PasswordField value={password} onChange={setPassword} />
            <ErrorLine message={error} />
            <button
              type="submit"
              className="ap4-btn ap4-ghost"
              disabled={busy || !password}
              aria-busy={busy}
            >
              {busy ? 'Signing…' : 'Sign the cancel'}
            </button>
          </form>
        ) : (
          <div className="w4-steps">
            <p className="w4-hint">Not in a block yet. You can try to cancel it.</p>
            <button type="button" className="ap4-btn ap4-ghost" onClick={() => setCancelOpen(true)}>
              {`Cancel this ${noun}`}
            </button>
          </div>
        )
      ) : null}
      {next && status.released ? (
        <button type="button" className="ap4-btn w4-wide" disabled={busy} onClick={next.onClick}>
          {next.label}
        </button>
      ) : null}
    </>
  );
}

/** Who a released payment went to, or the address a withdrawal went to. */
const sentTo = (entry: ReleasedOperation, view: WithdrawalView) =>
  entry.payment ? entry.payment.name.trim() || `CC-${entry.payment.short}` : shortHex(view.to);

/**
 * Operations released at Base's safe head, or found already done as a screen opened
 * (src/base/wallet/withdraw.ts). Nothing else in the browser lists what went out, so each shows as a
 * quiet line, read now and then, until it is done; then its record goes and the line stays until
 * this screen closes. `noun`: what every line is on this screen (Pay: always a payment); without
 * it, a line is a payment only when its record names who was paid.
 */
export function SentLines({
  agentId,
  except,
  noun,
}: {
  agentId: string;
  except?: string;
  noun?: 'payment' | 'withdrawal';
}) {
  const [lines, setLines] = useState<Array<{ entry: ReleasedOperation; view: WithdrawalView }>>([]);
  useEffect(() => {
    let stop = false;
    let timer = 0;
    const known = new Map<string, { entry: ReleasedOperation; view: WithdrawalView }>();
    const done = new Set<string>();
    const tick = async () => {
      const open = readReleased(agentId).filter(
        (entry) => entry.withdrawalId !== except && !done.has(entry.withdrawalId),
      );
      // Gone from the record elsewhere (its own screen saw it done): no longer shown.
      for (const id of known.keys())
        if (!done.has(id) && !open.some((entry) => entry.withdrawalId === id)) known.delete(id);
      await Promise.all(
        open.map(async (entry) => {
          try {
            const view = await readWithdrawal(agentId, entry.withdrawalId);
            // Another operation than the one signed here under this id is never shown.
            if (
              view.withdrawalId !== entry.withdrawalId ||
              view.userOpHash.toLowerCase() !== entry.userOpHash.toLowerCase()
            ) {
              dropReleased(agentId, entry.withdrawalId);
              known.delete(entry.withdrawalId);
              return;
            }
            known.set(entry.withdrawalId, { entry, view });
            if (DONE.includes(view.state)) {
              dropReleased(agentId, entry.withdrawalId);
              done.add(entry.withdrawalId);
            }
          } catch (err) {
            if (err instanceof ApiError && err.status === 404) {
              dropReleased(agentId, entry.withdrawalId);
              known.delete(entry.withdrawalId);
            }
            // Any other miss: the line keeps what it last read.
          }
        }),
      );
      if (stop) return;
      setLines([...known.values()].sort((a, b) => b.entry.releasedAt - a.entry.releasedAt));
      const waiting = readReleased(agentId).some(
        (entry) => entry.withdrawalId !== except && !done.has(entry.withdrawalId),
      );
      if (waiting) timer = window.setTimeout(() => void tick(), SAFE_POLL_MS);
    };
    void tick();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [agentId, except]);

  if (!lines.length) return null;
  return (
    <ul className="w4-sent-lines" aria-label="Sent from this wallet">
      {lines.map(({ entry, view }) => {
        const status = sentStatus(view, noun ?? (entry.payment ? 'payment' : 'withdrawal'));
        return (
          <li key={entry.withdrawalId} data-phase={status.phase}>
            {shownAmount(BigInt(view.amount.raw), view.token)} {view.token} to {sentTo(entry, view)}{' '}
            · {status.short}
          </li>
        );
      })}
    </ul>
  );
}
