import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { formatUnits, parseUnits } from 'viem';
import { ApiError } from '../../api';
import { readWallet, type WalletView } from '../../base/wallet/api';
import {
  addressOrNull,
  carryAnchorOver,
  checkedIntent,
  checkOperation,
  checkSigningWindow,
  createWithdrawal,
  discardUnsigned,
  dropLaneRecord,
  laneFor,
  laneRefusal,
  lanesOnServer,
  lanesRemembered,
  readAnchor,
  readLaneRecords,
  reconcileSignature,
  releasedAtOpen,
  rememberLanes,
  saveAnchor,
  saveLaneRecord,
  signAndSend,
  signatureRefused,
  signaturePath,
  WithdrawalCheckError,
  WithdrawalLockedError,
  type CheckedIntent,
  type LaneRecord,
  type SigningRequest,
  type WithdrawalAnchor,
  type WithdrawalToken,
  type WithdrawalView,
} from '../../base/wallet/withdraw';
import { VaultCryptoError } from '../../base/vault';
import type { AgentScreenProps } from './screens';
import { SettingsError, SettingsFrame, SettingsLoading } from './settingsShared';
import { SentLines, WithdrawalStatus } from './WithdrawalStatus';
import { WalletHistory, type SignedNow } from './WalletHistory';
import './wallet-screen.css';

/*
 * Withdraw from an agent's wallet (Operation Base Wallet W2). The owner types where and how much;
 * the server prepares the operation; this browser checks it decodes to exactly that (from this
 * wallet, this token, this amount, this address) and only then asks for the wallet password to
 * sign it. A signed withdrawal is live until it lands or its cancel does; the screen never says
 * "cancelled" before Base says so.
 */

const DECIMALS: Record<WithdrawalToken, number> = { USDC: 6, ETH: 18 };
/** A typed password goes after this long without a key press or tap, as on the wallet key. */
const IDLE_LOCK_MS = 5 * 60_000;

type Phase =
  | { k: 'loading' }
  | { k: 'error'; message: string }
  | { k: 'form' }
  /** `intent`: what is signed, decoded from the checked operation (never the server's summary). */
  /**
   * `unconfirmed` (lanes): its signature went out but the answer didn't say it was taken (a 5xx,
   * a lost answer). It stays this withdrawal: Sign and send sends the same signature again, Back
   * keeps it in History; never discarded or cancelled from here, and nothing new is prepared.
   */
  | {
      k: 'review';
      request: SigningRequest;
      hash: `0x${string}`;
      intent: CheckedIntent;
      unconfirmed?: boolean;
    }
  /**
   * `original`: the withdrawal as checked and signed here; a cancel must sit at its nonce.
   * `payment`: a payment (Base Pay) is anchored, never shown as a withdrawal.
   */
  | {
      k: 'status';
      withdrawalId: string;
      original: { userOperation: SigningRequest['userOperation']; userOpHash: `0x${string}` };
      payment?: WithdrawalAnchor['payment'];
    };

const statusOf = (anchor: WithdrawalAnchor): Phase => ({
  k: 'status',
  withdrawalId: anchor.withdrawalId,
  original: { userOperation: anchor.userOperation, userOpHash: anchor.userOpHash },
  payment: anchor.payment,
});

const failure = (error: unknown) =>
  error instanceof WithdrawalLockedError
    ? error.message
    : error instanceof WithdrawalCheckError
      ? `Not signed: ${error.message}`
      : error instanceof VaultCryptoError || error instanceof ApiError || error instanceof Error
        ? error.message
        : 'Something went wrong. Try again.';

const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
const shown = (raw: bigint, token: WithdrawalToken) => {
  const text = formatUnits(raw, DECIMALS[token]);
  return token === 'USDC' ? Number(text).toFixed(2) : text;
};

export function WalletWithdrawScreen({ agent, onBack, backLabel }: AgentScreenProps) {
  const [phase, setPhase] = useState<Phase>({ k: 'loading' });
  const [wallet, setWallet] = useState<WalletView | null>(null);
  const [token, setToken] = useState<WithdrawalToken>('USDC');
  const [amount, setAmount] = useState('');
  const [max, setMax] = useState(false);
  const [to, setTo] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** The signature's answer, shown until the first read. */
  const [view, setView] = useState<WithdrawalView | null>(null);
  /** A plain line above the form (a withdrawal signed here that the server no longer knows). */
  const [notice, setNotice] = useState('');
  /** Lanes (the server's `lanes: true`): withdrawals don't wait for each other (see Pay). */
  const [lanes, setLanes] = useState(false);
  /** The withdrawal signed just now, for its History line to show at once. */
  const [signed, setSigned] = useState<SignedNow | null>(null);
  // One key per withdrawal the owner means: a retry of the same form never makes a second one.
  const key = useRef(crypto.randomUUID());
  // The typed password is dropped when the page is hidden or left, after IDLE_LOCK_MS without
  // input, or when this screen closes; a signature made meanwhile is dropped, never sent.
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
  }, [guarded, lock]);
  const alive = () => {
    const started = session.current;
    return () => session.current === started;
  };

  const load = useCallback(async () => {
    setPhase({ k: 'loading' });
    try {
      const read = await readWallet(agent.id);
      if (read.kind !== 'wallet' || !read.wallet.address)
        return setPhase({ k: 'error', message: 'This wallet can’t send yet.' });
      setWallet(read.wallet);
      // Lanes: what is on its way shows in History (the server's open list); an anchor from
      // before joins it there. Off on the server and nothing laned left here: as before.
      const server = await lanesOnServer(agent.id);
      if (server !== null) rememberLanes(agent.id, server);
      const laned = (server ?? lanesRemembered(agent.id)) || readLaneRecords(agent.id).length > 0;
      setLanes(laned);
      if (laned && carryAnchorOver(agent.id)) return setPhase({ k: 'form' });
      // A withdrawal (or payment) this browser signed earlier that may still be on its way.
      // Already done at this first read: released, and the form opens with it as a quiet line.
      const anchor = readAnchor(agent.id);
      if (anchor && !(await releasedAtOpen(agent.id, anchor))) return setPhase(statusOf(anchor));
      setPhase({ k: 'form' });
    } catch (err) {
      setPhase({ k: 'error', message: failure(err) });
    }
  }, [agent.id]);
  useEffect(() => {
    void load();
  }, [load]);

  /**
   * The withdrawal prepared but not signed is discarded on the server, and the next one gets a new
   * key: with the old key, an edited withdrawal would be refused as another use of it.
   */
  async function startOver(unsigned: string | null) {
    key.current = crypto.randomUUID();
    if (unsigned) await discardUnsigned(agent.id, unsigned);
  }

  /** Back to an empty form for the next withdrawal (the last one is sent, or done). */
  function newWithdrawal() {
    void startOver(null);
    setToken('USDC');
    setAmount('');
    setMax(false);
    setTo('');
    setError('');
    setNotice('');
    setPassword('');
    setView(null);
    setPhase({ k: 'form' });
    // What is available changed with the withdrawal: read again, quietly.
    readWallet(agent.id)
      .then((read) => {
        if (read.kind === 'wallet' && read.wallet.address) setWallet(read.wallet);
      })
      .catch(() => {});
  }

  async function prepare(event: FormEvent) {
    event.preventDefault();
    if (!wallet?.address) return;
    setError('');
    const destination = addressOrNull(to);
    if (!destination) return setError('That isn’t a valid address. Check its letters.');
    let raw: string | 'max' = 'max';
    if (!max) {
      try {
        const value = parseUnits(amount.trim(), DECIMALS[token]);
        if (value <= 0n) throw new Error();
        raw = value.toString();
      } catch {
        return setError(`Type an amount in ${token}, like ${token === 'USDC' ? '12.50' : '0.01'}.`);
      }
    }
    setBusy(true);
    setSigned(null);
    let prepared: string | null = null;
    try {
      const request = await createWithdrawal(agent.id, {
        token,
        amount: raw,
        to: destination,
        idempotencyKey: key.current,
      });
      prepared = request.withdrawalId;
      const laned = request.lanes === true;
      rememberLanes(agent.id, laned);
      if (laned) setLanes(true);
      // Checked here, before the owner is even asked: the operation is exactly this withdrawal
      // (and with lanes on, in its own lane).
      const hash = checkOperation({
        userOperation: request.userOperation,
        userOpHash: request.userOpHash,
        entryPoint: request.entryPoint,
        chainId: request.chainId,
        wallet: wallet.address,
        owner: wallet.ownerAddress,
        agentId: agent.id,
        expected: { kind: 'withdraw', token, amount: raw, to: destination },
        lanes: request.lanes === true,
        lane: await laneFor(agent.id, request, wallet),
      });
      setPhase({ k: 'review', request, hash, intent: checkedIntent(request, wallet.address) });
    } catch (err) {
      // Prepared but refused here: dropped, so a corrected withdrawal isn't held behind it.
      if (prepared) await startOver(prepared);
      const held = laneRefusal(err, { noun: 'withdrawal', token }, lanes && !wallet.deployed);
      if (held) setError(held);
      else if (err instanceof ApiError && err.code === 'operation_pending') {
        const anchor = readAnchor(agent.id);
        if (anchor) setPhase(statusOf(anchor));
        else
          setError(
            'One withdrawal is still on its way. Wait for it, or cancel it in the browser that signed it.',
          );
      } else setError(failure(err));
    } finally {
      setBusy(false);
    }
  }

  async function signReview(event: FormEvent) {
    event.preventDefault();
    if (phase.k !== 'review' || !wallet) return;
    setError('');
    setBusy(true);
    // With lanes: the record, once kept right before the signature leaves.
    const flight: { record: LaneRecord | null } = { record: null };
    try {
      const laned = phase.request.lanes === true;
      checkSigningWindow(phase.request);
      const record: LaneRecord = {
        withdrawalId: phase.request.withdrawalId,
        userOperation: phase.request.userOperation,
        userOpHash: phase.hash,
        signedAt: Date.now(),
        laned: true,
      };
      // The checked operation is kept before the signature leaves: a lost answer can't lose it
      // (with lanes, as a History record that holds nothing up; without, as the one anchor).
      const sent = await signAndSend(
        signaturePath(agent.id, phase.request.withdrawalId),
        phase.hash,
        password,
        alive(),
        () => {
          checkSigningWindow(phase.request);
          if (laned) {
            saveLaneRecord(agent.id, record);
            flight.record = record;
          } else
            saveAnchor(agent.id, {
              withdrawalId: phase.request.withdrawalId,
              userOperation: phase.request.userOperation,
              userOpHash: phase.hash,
            });
        },
        wallet.ownerAddress,
      );
      setPassword('');
      if (laned) {
        // No wait: straight back to an empty form; the withdrawal goes on as a History line.
        newWithdrawal();
        setSigned({ view: sent, record });
        return;
      }
      setView(sent);
      // A new withdrawal from here on gets a new key.
      key.current = crypto.randomUUID();
      setPhase({
        k: 'status',
        withdrawalId: phase.request.withdrawalId,
        original: { userOperation: phase.request.userOperation, userOpHash: phase.hash },
      });
    } catch (err) {
      setPassword('');
      const refusal = laneRefusal(err, { noun: 'withdrawal', token: phase.intent.token });
      const record = flight.record;
      if (record && signatureRefused(err)) {
        // Refused before the server took it (funds moved meanwhile, say): nothing was sent. Its
        // record goes, the unsigned withdrawal is discarded, and the form keeps what was typed.
        dropLaneRecord(agent.id, phase.request.withdrawalId);
        await startOver(phase.request.withdrawalId);
        setPhase({ k: 'form' });
      } else if (record) {
        // Unclear (a 5xx, a lost answer): the signature may have been taken. Nothing is
        // discarded or cancelled and nothing new is prepared; the same withdrawal is read once.
        const now = await reconcileSignature(agent.id, record);
        if (now.k === 'sent') {
          newWithdrawal();
          setSigned({ view: now.view, record });
          return;
        }
        if (now.k === 'never') {
          dropLaneRecord(agent.id, phase.request.withdrawalId);
          await startOver(null);
          setPhase({ k: 'form' });
          setError('This withdrawal was never sent. Nothing left this wallet.');
          return;
        }
        setPhase({ ...phase, unconfirmed: true });
        setError(
          'Couldn’t confirm this withdrawal was sent. Nothing new was made: Sign and send sends this same withdrawal again, Back keeps it in History.',
        );
        return;
      }
      setError(refusal ?? failure(err));
    } finally {
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

  return (
    <SettingsFrame
      backLabel={backLabel ?? 'Wallet'}
      onBack={onBack}
      title={phase.k === 'review' ? 'Check and sign' : 'Withdraw'}
      sub={
        phase.k === 'form'
          ? `Send from ${agent.name}’s wallet to an address of yours on Base.`
          : undefined
      }
    >
      {phase.k === 'loading' ? (
        <SettingsLoading />
      ) : phase.k === 'error' ? (
        <SettingsError message={phase.message} onRetry={() => void load()} />
      ) : phase.k === 'form' && wallet ? (
        <form className="w4-steps" onSubmit={(event) => void prepare(event)}>
          {notice ? (
            <p className="w4-hint" role="status">
              {notice}
            </p>
          ) : null}
          {lanes ? null : <SentLines agentId={agent.id} />}
          <div className="w4-seg" role="radiogroup" aria-label="Token">
            {(['USDC', 'ETH'] as const).map((each) => (
              <button
                key={each}
                type="button"
                role="radio"
                aria-checked={token === each}
                onClick={() => setToken(each)}
              >
                {each}
                <small>{each === 'USDC' ? wallet.usdc.display : wallet.eth.display}</small>
              </button>
            ))}
          </div>
          <label className="w4-field">
            <span>Amount in {token}</span>
            <input
              inputMode="decimal"
              autoComplete="off"
              value={max ? 'All of it' : amount}
              disabled={max}
              onChange={(event) => setAmount(event.target.value)}
            />
          </label>
          <label className="w4-check">
            <input
              type="checkbox"
              checked={max}
              onChange={(event) => setMax(event.target.checked)}
            />
            Send all the {token} in the wallet
          </label>
          <label className="w4-field">
            <span>To address on Base</span>
            <input
              className="w4-mono"
              autoComplete="off"
              spellCheck={false}
              placeholder="0x…"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
            <small>Only an address on Base. Sent anywhere else, it can’t be recovered.</small>
          </label>
          {errorLine}
          <button type="submit" className="ap4-btn w4-wide" disabled={busy} aria-busy={busy}>
            {busy ? 'Preparing…' : 'Continue'}
          </button>
        </form>
      ) : phase.k === 'review' ? (
        <form className="w4-steps" onSubmit={(event) => void signReview(event)}>
          <div className="ap4-group">
            <div className="ap4-row v4s-still">
              <span className="ap4-k">Amount</span>
              <span className="ap4-v">
                {shown(phase.intent.amount, phase.intent.token)} {phase.intent.token}
              </span>
            </div>
            <div className="ap4-row v4s-still">
              <span className="ap4-k">
                To
                <span className="w4-row-sub w4-mono">{phase.intent.to}</span>
              </span>
            </div>
            <div className="ap4-row v4s-still">
              <span className="ap4-k">From</span>
              <span className="ap4-v">
                {agent.name} · {short(phase.intent.from)}
              </span>
            </div>
            <div className="ap4-row v4s-still">
              <span className="ap4-k">Network</span>
              <span className="ap4-v">
                {phase.intent.testnet
                  ? `${phase.intent.network} · test network, no real money`
                  : phase.intent.network}
              </span>
            </div>
            <div className="ap4-row v4s-still">
              <span className="ap4-k">Network fee</span>
              {/* checkOperation refused any operation without a paymaster: the fee is covered. */}
              <span className="ap4-v">Covered by Central City</span>
            </div>
          </div>
          {/* The server's hint can only add this caution; nothing shown above comes from it. */}
          {phase.request.summary.toIsContract ? (
            <p className="w4-caution">
              <b>That address is a contract.</b> Make sure it can receive {phase.intent.token}; if
              it can’t, the money is stuck there.
            </p>
          ) : null}
          {phase.intent.deploysWallet ? (
            <p className="w4-hint">This also sets up {agent.name}’s wallet on Base.</p>
          ) : null}
          <p className="w4-hint" data-k="checked">
            Checked in this browser: the operation sends exactly this, from this wallet, and nothing
            else.
          </p>
          <p className="w4-caution">
            <b>Withdrawals can’t be undone.</b>
          </p>
          {passwordField}
          {errorLine}
          <div className="ap4-actions">
            <button type="submit" className="ap4-btn" disabled={busy || !password} aria-busy={busy}>
              {busy ? 'Signing…' : 'Sign and send'}
            </button>
            <button
              type="button"
              className="ap4-btn ap4-ghost"
              disabled={busy}
              onClick={() => {
                // Maybe already taken: kept in History as it is, never discarded from here.
                if (phase.unconfirmed) return newWithdrawal();
                const unsigned = phase.request.withdrawalId;
                setPassword('');
                setError('');
                setBusy(true);
                void startOver(unsigned).finally(() => {
                  setBusy(false);
                  setPhase({ k: 'form' });
                });
              }}
            >
              Back
            </button>
          </div>
        </form>
      ) : phase.k === 'status' && wallet ? (
        <div className="w4-steps">
          <WithdrawalStatus
            key={phase.withdrawalId}
            agentId={agent.id}
            wallet={wallet}
            withdrawalId={phase.withdrawalId}
            original={phase.original}
            initial={view?.withdrawalId === phase.withdrawalId ? view : null}
            noun={phase.payment ? 'payment' : 'withdrawal'}
            lead={
              phase.payment
                ? (read) =>
                    `${shown(BigInt(read.amount.raw), read.token)} ${read.token} to ${
                      phase.payment!.name.trim() || `CC-${phase.payment!.short}`
                    }`
                : undefined
            }
            payment={phase.payment}
            next={{ label: 'New withdrawal', onClick: newWithdrawal }}
            onGone={() => {
              const noun = phase.payment ? 'payment' : 'withdrawal';
              newWithdrawal();
              setNotice(
                `The ${noun} signed here earlier can’t be found any more, so it isn’t shown.`,
              );
            }}
          />
          <SentLines agentId={agent.id} except={phase.withdrawalId} />
        </div>
      ) : null}
      {lanes && wallet && phase.k !== 'loading' && phase.k !== 'error' ? (
        <WalletHistory
          agentId={agent.id}
          wallet={wallet}
          signed={signed}
          hidden={phase.k !== 'form'}
        />
      ) : null}
    </SettingsFrame>
  );
}
