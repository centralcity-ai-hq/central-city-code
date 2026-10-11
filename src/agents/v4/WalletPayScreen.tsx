import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { parseUnits } from 'viem';
import { ApiError } from '../../api';
import { readWallet, type WalletView } from '../../base/wallet/api';
import {
  checkPayment,
  confirmOnBase,
  amountProblem,
  createPayment,
  lookupRecipient,
  noteProblem,
  ONLY_AGENTS,
  payTo,
  POINT_IN_TIME,
  recipientProblem,
  RecipientError,
  type PayRecipientAgent,
  type PaySigningRequest,
} from '../../base/wallet/pay';
import { usePasswordLock } from '../../base/wallet/usePasswordLock';
import {
  carryAnchorOver,
  checkedIntent,
  checkSigningWindow,
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
  type LaneRecord,
  type WithdrawalAnchor,
  signAndSend,
  signatureRefused,
  signaturePath,
  type CheckedIntent,
  type WithdrawalView,
} from '../../base/wallet/withdraw';
import { PAY_NOTE_MAX } from '../../../shared/base/pay';
import type { AgentScreenProps } from './screens';
import { SettingsError, SettingsFrame, SettingsLoading } from './settingsShared';
import { WalletHistory, type SignedNow } from './WalletHistory';
import {
  ErrorLine,
  PasswordField,
  SentLines,
  shortHex,
  shownAmount,
  signingFailure,
  WithdrawalStatus,
  type SignedOperation,
} from './WithdrawalStatus';
import './wallet-screen.css';

/*
 * Pay another Central City agent on Base in USDC (Operation Base Pay P1), from this agent's wallet.
 * The owner types the recipient's Base ID or passport; the server looks it up on Base and this
 * browser checks the answer is that agent (src/base/wallet/pay.ts). On Review the server prepares
 * the payment, this browser checks it is one USDC transfer of exactly that amount to exactly that
 * wallet, and reads Base itself: ownerOf(Base ID) must be that wallet. Right before signing it reads
 * Base once more. A name never decides; anything that doesn't match signs nothing.
 */

const USDC_DECIMALS = 6;
/** Lookups wait for the owner to stop typing. */
const LOOKUP_DELAY_MS = 450;

type Recipient =
  | { k: 'idle' }
  | { k: 'checking' }
  | { k: 'found'; recipient: PayRecipientAgent }
  /** `withdraw`: not a Central City agent; Withdraw is the way to any other address. */
  | { k: 'refused'; message: string; withdraw?: boolean };

type Phase =
  | { k: 'loading' }
  | { k: 'error'; message: string }
  | { k: 'form' }
  | {
      k: 'review';
      request: PaySigningRequest;
      hash: `0x${string}`;
      /** What is signed, decoded from the checked operation (never the server's summary). */
      intent: CheckedIntent;
      recipient: PayRecipientAgent;
      /** The block this browser read the recipient's owner at. */
      block: number;
      note: string | null;
      /**
       * Lanes: its signature went out but the answer didn't say it was taken (a 5xx, a lost
       * answer). It stays this payment: Pay sends the same signature again, Back keeps it in
       * History; it is never discarded or cancelled from here, and nothing new is prepared.
       */
      unconfirmed?: boolean;
    }
  | {
      k: 'status';
      withdrawalId: string;
      original: SignedOperation;
      /** What was paid, as signed here (kept with the anchor across a reload); null: unknown. */
      paid: { recipient: PaidTo; note: string | null } | null;
    };

/** The recipient as a status screen names it (kept with the anchor, so also after a reload). */
type PaidTo = Pick<PayRecipientAgent, 'name' | 'short' | 'baseId'>;
const paidOf = (anchor: WithdrawalAnchor) =>
  anchor.payment
    ? {
        recipient: {
          name: anchor.payment.name,
          short: anchor.payment.short,
          baseId: anchor.payment.baseId,
        },
        note: anchor.payment.note,
      }
    : null;

/** As the anchor keeps a payment's names, so its record names it once it is released. */
const namesOf = (paid: {
  recipient: PaidTo;
  note: string | null;
}): WithdrawalAnchor['payment'] => ({
  name: paid.recipient.name,
  short: paid.recipient.short,
  baseId: paid.recipient.baseId,
  note: paid.note,
});

/** A signature sent whose answer didn't say it was taken (lanes). */
const UNCONFIRMED =
  'Couldn’t confirm this payment was sent. Nothing new was made: Pay sends this same payment again, Back keeps it in History.';

const who = (recipient: Pick<PayRecipientAgent, 'name' | 'short'>) =>
  recipient.name.trim() || `CC-${recipient.short}`;
const group = (value: number) => value.toLocaleString('en-US');
const clock = (at: number) =>
  new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

function VerifiedCard({
  recipient,
  onChange,
}: {
  recipient: PayRecipientAgent;
  onChange: () => void;
}) {
  return (
    <div className="w4-vcard" role="group" aria-label="Recipient">
      <div className="w4-vtop">
        <span>Verified on Base</span>
        <button type="button" className="w4-textbtn" onClick={onChange}>
          Change
        </button>
      </div>
      <div className="w4-vmain">
        <span className="w4-av" aria-hidden="true">
          {who(recipient).charAt(0).toUpperCase()}
        </span>
        <span className="w4-who">
          <b>{who(recipient)}</b>
          <small className="w4-mono">{shortHex(recipient.wallet)}</small>
        </span>
        <span className="w4-vid">
          <small>Base ID</small>
          <b>{recipient.baseId}</b>
        </span>
      </div>
      <p className="w4-hint">
        Checked on Base at block {group(recipient.verified.block)}, {clock(recipient.verified.at)}.{' '}
        {POINT_IN_TIME} The Base ID decides, not the name.
      </p>
    </div>
  );
}

export function WalletPayScreen({ agent, onBack, onOpen, backLabel }: AgentScreenProps) {
  const [phase, setPhase] = useState<Phase>({ k: 'loading' });
  const [wallet, setWallet] = useState<WalletView | null>(null);
  const [to, setTo] = useState('');
  const [recipient, setRecipient] = useState<Recipient>({ k: 'idle' });
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState<WithdrawalView | null>(null);
  /** A plain line above the form (a payment signed here that the server no longer knows). */
  const [notice, setNotice] = useState('');
  /**
   * Lanes (the server's `lanes: true`): payments don't wait for each other. Signing returns to an
   * empty form and every payment on its way is a History line. Off: one at a time, as before.
   */
  const [lanes, setLanes] = useState(false);
  /** The payment signed just now, for its History line to show at once. */
  const [signed, setSigned] = useState<SignedNow | null>(null);
  // One key per payment the owner means: a retry of the same form never makes a second one.
  const key = useRef(crypto.randomUUID());
  // The latest lookup wins: an older answer arriving late is dropped.
  const lookup = useRef(0);
  const { password, setPassword, alive } = usePasswordLock(busy);

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
      // One owner operation at a time per wallet: one this browser signed may still be on its way.
      // Already done at this first read: released, and the form opens with it as a quiet line.
      const anchor = readAnchor(agent.id);
      if (anchor && !(await releasedAtOpen(agent.id, anchor)))
        return setPhase({
          k: 'status',
          withdrawalId: anchor.withdrawalId,
          original: { userOperation: anchor.userOperation, userOpHash: anchor.userOpHash },
          paid: paidOf(anchor),
        });
      setPhase({ k: 'form' });
    } catch (err) {
      setPhase({ k: 'error', message: signingFailure(err) });
    }
  }, [agent.id]);
  useEffect(() => {
    void load();
  }, [load]);

  const find = useCallback(
    async (text: string) => {
      const ticket = ++lookup.current;
      const problem = recipientProblem(text);
      if (problem) return setRecipient({ k: 'refused', message: problem });
      setRecipient({ k: 'checking' });
      try {
        const found = await lookupRecipient(text);
        if (ticket !== lookup.current) return;
        if (wallet?.address && found.wallet.toLowerCase() === wallet.address.toLowerCase())
          return setRecipient({ k: 'refused', message: `That’s ${agent.name}’s own wallet.` });
        setRecipient({ k: 'found', recipient: found });
      } catch (err) {
        if (ticket !== lookup.current) return;
        const notAgent =
          (err instanceof RecipientError && err.message === ONLY_AGENTS) ||
          (err instanceof ApiError && err.code === 'not_central_city_agent');
        setRecipient({
          k: 'refused',
          message: notAgent ? ONLY_AGENTS : signingFailure(err),
          withdraw: notAgent,
        });
      }
    },
    [agent.name, wallet?.address],
  );

  // Look the recipient up once the owner stops typing.
  useEffect(() => {
    const text = to.trim();
    if (!text) {
      lookup.current += 1;
      setRecipient({ k: 'idle' });
      return;
    }
    const timer = window.setTimeout(() => void find(text), LOOKUP_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [to, find]);

  const available = wallet ? BigInt(wallet.usdc.raw) : 0n;
  let typed: bigint | null = null;
  try {
    typed = amount.trim() ? parseUnits(amount.trim().replace(',', '.'), USDC_DECIMALS) : null;
  } catch {
    typed = null;
  }
  const over = typed !== null && typed > available;
  const found = recipient.k === 'found' ? recipient.recipient : null;

  /**
   * The payment prepared but not signed is discarded on the server, and the next one gets a new
   * key: with the old key, an edited payment would be refused as another use of it.
   */
  async function startOver(unsigned: string | null) {
    key.current = crypto.randomUUID();
    if (unsigned) await discardUnsigned(agent.id, unsigned);
  }

  /** Back to an empty form for the next payment (the last one is sent, or done). */
  function newPayment() {
    void startOver(null);
    lookup.current += 1;
    setTo('');
    setAmount('');
    setNote('');
    setError('');
    setNotice('');
    setPassword('');
    setRecipient({ k: 'idle' });
    setSent(null);
    setPhase({ k: 'form' });
    // What is available changed with the payment: read again, quietly.
    readWallet(agent.id)
      .then((read) => {
        if (read.kind === 'wallet' && read.wallet.address) setWallet(read.wallet);
      })
      .catch(() => {});
  }

  async function prepare(event: FormEvent) {
    event.preventDefault();
    if (!wallet?.address || !found) return;
    setError('');
    if (typed === null || typed <= 0n) return setError('Type an amount in USDC, like 12.50.');
    const tooSmall = amountProblem(typed);
    if (tooSmall) return setError(tooSmall);
    if (over)
      return setError(`More than ${agent.name} has: ${wallet.usdc.display} USDC available.`);
    const noteIssue = noteProblem(note);
    if (noteIssue) return setError(noteIssue);
    const raw = typed.toString();
    const text = note.trim() || null;
    setBusy(true);
    setSigned(null);
    let prepared: string | null = null;
    try {
      // The payment carries the check the owner saw. Past its expiry it is looked up again and
      // shown, and the owner confirms that one: nothing is sent on a check they didn't see.
      if (found.expiresAt <= Date.now()) {
        setRecipient({ k: 'checking' });
        const again = await lookupRecipient(to);
        setRecipient({ k: 'found', recipient: again });
        throw new RecipientError(
          'The check on Base was over 5 minutes old, so it ran again. Check the recipient, then Review payment.',
        );
      }
      const target = found;
      const request = await createPayment(agent.id, {
        idempotencyKey: key.current,
        to: payTo(target),
        amount: raw,
        note: text,
      });
      prepared = request.withdrawalId;
      const laned = request.lanes === true;
      rememberLanes(agent.id, laned);
      if (laned) setLanes(true);
      // Checked here, before the owner is even asked: exactly this payment, to exactly this wallet,
      // and with lanes on, in its own lane.
      const hash = checkPayment({
        request,
        recipient: target,
        amount: raw,
        wallet: wallet.address,
        owner: wallet.ownerAddress,
        agentId: agent.id,
        lane: await laneFor(agent.id, request, wallet),
      });
      // The screen shows the operation's own values; a summary that differs signs nothing.
      const intent = checkedIntent(request, wallet.address);
      // And Base, read by this browser: the Base ID still belongs to that wallet.
      const block = await confirmOnBase(target);
      setPhase({ k: 'review', request, hash, intent, recipient: target, block, note: text });
    } catch (err) {
      // Prepared but refused here: dropped, so a corrected payment isn't held behind it.
      if (prepared) await startOver(prepared);
      const held = laneRefusal(err, { noun: 'payment', token: 'USDC' }, lanes && !wallet.deployed);
      if (held) setError(held);
      else if (err instanceof ApiError && err.code === 'operation_pending') {
        const anchor = readAnchor(agent.id);
        if (anchor)
          setPhase({
            k: 'status',
            withdrawalId: anchor.withdrawalId,
            original: { userOperation: anchor.userOperation, userOpHash: anchor.userOpHash },
            paid: paidOf(anchor),
          });
        else
          setError(
            'A payment or withdrawal from this wallet is still on its way. Wait for it, or cancel it first.',
          );
      } else {
        if (err instanceof ApiError && err.code === 'recipient_changed')
          setRecipient({ k: 'refused', message: err.message });
        // Expired on the server's clock: look it up again for the owner to confirm.
        if (err instanceof ApiError && err.code === 'recipient_expired') void find(to.trim());
        setError(signingFailure(err));
      }
    } finally {
      setBusy(false);
    }
  }

  async function pay(event: FormEvent) {
    event.preventDefault();
    if (phase.k !== 'review' || !wallet) return;
    setError('');
    setBusy(true);
    // Marked before anything else: if the password goes while Base is read, nothing is sent.
    const mark = alive();
    // With lanes: the record, once kept right before the signature leaves.
    const flight: { record: LaneRecord | null } = { record: null };
    try {
      // Once more, right before signing: Base still has that wallet for that Base ID.
      await confirmOnBase(phase.recipient);
      checkSigningWindow(phase.request);
      const payment = {
        name: phase.recipient.name,
        short: phase.recipient.short,
        baseId: phase.recipient.baseId,
        note: phase.note,
      };
      const laned = phase.request.lanes === true;
      const kept: LaneRecord = {
        withdrawalId: phase.request.withdrawalId,
        userOperation: phase.request.userOperation,
        userOpHash: phase.hash,
        payment,
        signedAt: Date.now(),
        laned: true,
      };
      // The checked operation is kept before the signature leaves: a lost answer can't lose it
      // (and if this browser can't keep it, nothing is sent). With lanes, as a record in History
      // that holds nothing up; without, as the wallet's one anchor.
      const view = await signAndSend(
        signaturePath(agent.id, phase.request.withdrawalId),
        phase.hash,
        password,
        mark,
        () => {
          checkSigningWindow(phase.request);
          if (laned) {
            saveLaneRecord(agent.id, kept);
            flight.record = kept;
          } else
            saveAnchor(agent.id, {
              withdrawalId: phase.request.withdrawalId,
              userOperation: phase.request.userOperation,
              userOpHash: phase.hash,
              payment,
            });
        },
        wallet.ownerAddress,
      );
      setPassword('');
      if (laned) {
        // No wait: straight back to an empty form; the payment goes on as a History line.
        newPayment();
        setSigned({ view, record: kept });
        return;
      }
      setSent(view);
      // A new payment from here on gets a new key.
      key.current = crypto.randomUUID();
      setPhase({
        k: 'status',
        withdrawalId: phase.request.withdrawalId,
        original: { userOperation: phase.request.userOperation, userOpHash: phase.hash },
        paid: { recipient: phase.recipient, note: phase.note },
      });
    } catch (err) {
      setPassword('');
      const refusal = laneRefusal(err, { noun: 'payment', token: 'USDC' });
      const record = flight.record;
      if (record && signatureRefused(err)) {
        // Refused before the server took it (funds moved meanwhile, say): nothing was sent. Its
        // record goes, the unsigned payment is discarded, and the form keeps what was typed.
        dropLaneRecord(agent.id, phase.request.withdrawalId);
        await startOver(phase.request.withdrawalId);
        setPhase({ k: 'form' });
      } else if (record) {
        // Unclear (a 5xx, a lost answer): the signature may have been taken. Nothing is
        // discarded or cancelled and nothing new is prepared; the same payment is read once.
        const now = await reconcileSignature(agent.id, record);
        if (now.k === 'sent') {
          newPayment();
          setSigned({ view: now.view, record });
          return;
        }
        if (now.k === 'never') {
          dropLaneRecord(agent.id, phase.request.withdrawalId);
          await startOver(null);
          setPhase({ k: 'form' });
          setError('This payment was never sent. Nothing left this wallet.');
          return;
        }
        setPhase({ ...phase, unconfirmed: true });
        setError(UNCONFIRMED);
        return;
      }
      setError(refusal ?? signingFailure(err));
    } finally {
      setBusy(false);
    }
  }

  const errorLine = <ErrorLine message={error} />;
  const usdc = (raw: bigint) => shownAmount(raw, 'USDC');

  return (
    <SettingsFrame
      backLabel={backLabel ?? 'Wallet'}
      onBack={onBack}
      title={phase.k === 'review' ? 'Check and pay' : 'Pay'}
      sub={
        phase.k === 'form'
          ? `From ${agent.name}’s wallet to another Central City agent on Base.`
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
          {lanes ? null : <SentLines agentId={agent.id} noun="payment" />}
          <label className="w4-field">
            <span>To</span>
            <input
              className="w4-mono"
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              placeholder="Base ID or passport link"
              value={to}
              aria-invalid={recipient.k === 'refused' || undefined}
              onChange={(event) => setTo(event.target.value)}
            />
            {recipient.k === 'refused' ? null : <small>Central City agents on Base only.</small>}
          </label>
          <div className="w4-slot" aria-live="polite">
            {recipient.k === 'checking' ? (
              <p className="w4-hint">Checking on Base…</p>
            ) : recipient.k === 'found' ? (
              <VerifiedCard
                recipient={recipient.recipient}
                onChange={() => {
                  setTo('');
                  setError('');
                }}
              />
            ) : recipient.k === 'refused' ? (
              <>
                <p className="w4-error" role="alert">
                  {recipient.message}
                </p>
                {recipient.withdraw ? (
                  <button
                    type="button"
                    className="ap4-btn ap4-ghost"
                    onClick={() => onOpen('wallet-withdraw')}
                  >
                    Withdraw instead
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
          <label className="w4-field">
            <span>Amount in USDC</span>
            <input
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              aria-invalid={over || undefined}
              onChange={(event) => setAmount(event.target.value)}
            />
            <small className={over ? 'w4-error' : undefined}>
              {over
                ? `More than ${agent.name} has. ${wallet.usdc.display} USDC available.`
                : typed && typed > 0n
                  ? `${wallet.usdc.display} USDC available · ${usdc(available - typed)} left after`
                  : `${wallet.usdc.display} USDC available`}
            </small>
          </label>
          <label className="w4-field">
            <span>
              Note <span className="w4-opt">optional</span>
            </span>
            <input
              autoComplete="off"
              maxLength={PAY_NOTE_MAX * 2}
              placeholder="What it’s for"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
            <small>Both owners see it. It stays in Central City, not on Base.</small>
          </label>
          <div className="ap4-group">
            <div className="ap4-row v4s-still">
              <span className="ap4-k">Network fee</span>
              <span className="ap4-v">Covered by Central City</span>
            </div>
            <div className="ap4-row v4s-still">
              <span className="ap4-k">{found ? `${who(found)} receives` : 'They receive'}</span>
              <span className="ap4-v">{usdc(typed && typed > 0n ? typed : 0n)} USDC</span>
            </div>
          </div>
          {errorLine}
          <button
            type="submit"
            className="ap4-btn w4-wide"
            disabled={busy || !found || !typed || typed <= 0n || over}
            aria-busy={busy}
          >
            {busy ? 'Preparing…' : 'Review payment'}
          </button>
        </form>
      ) : phase.k === 'review' ? (
        <form className="w4-steps" onSubmit={(event) => void pay(event)}>
          <div className="w4-hero">
            <p className="w4-eyebrow">You pay</p>
            <div className="w4-amount">
              <span className="w4-big">{usdc(phase.intent.amount)}</span>
              <span className="w4-unit">USDC</span>
            </div>
            <p className="w4-sub">
              to {who(phase.recipient)} · Base ID {phase.recipient.baseId}
            </p>
          </div>
          <p className="w4-section">What you sign</p>
          <div className="ap4-group">
            <div className="ap4-row v4s-still">
              <span className="ap4-k">Amount</span>
              <span className="ap4-v">{usdc(phase.intent.amount)} USDC</span>
            </div>
            <div className="ap4-row v4s-still">
              <span className="ap4-k">
                To wallet
                <span className="w4-row-sub w4-mono">{phase.intent.to}</span>
              </span>
            </div>
            <div className="ap4-row v4s-still">
              <span className="ap4-k">Base ID</span>
              <span className="ap4-v">
                {phase.recipient.baseId} · {who(phase.recipient)}
              </span>
            </div>
            <div className="ap4-row v4s-still">
              <span className="ap4-k">From</span>
              <span className="ap4-v">
                {agent.name} · {shortHex(phase.intent.from)}
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
              {/* checkOperation refused any operation without the pinned sponsor: it is covered. */}
              <span className="ap4-v">Covered by Central City</span>
            </div>
          </div>
          {phase.note ? (
            <p className="w4-hint">
              Not signed: the note “{phase.note}”. Both owners see it in Central City.
            </p>
          ) : null}
          {phase.intent.deploysWallet ? (
            <p className="w4-hint">This also sets up {agent.name}’s wallet on Base.</p>
          ) : null}
          <ul className="w4-checks" aria-label="Checked in this browser">
            <li>
              <b>Decoded in your browser.</b> One USDC transfer of {usdc(phase.intent.amount)} to{' '}
              {shortHex(phase.intent.to)}, from this wallet. Nothing else.
            </li>
            <li>
              <b>Checked on Base from your browser.</b> Base ID {phase.recipient.baseId} belongs to
              that wallet at block {group(phase.block)}. {POINT_IN_TIME}
            </li>
          </ul>
          <p className="w4-caution">
            <b>Payments can’t be undone.</b>
          </p>
          <PasswordField value={password} onChange={setPassword} />
          <p className="w4-hint">
            Just before it signs, your browser checks Base once more. If anything changed, nothing
            is signed.
          </p>
          {errorLine}
          <div className="ap4-actions">
            <button type="submit" className="ap4-btn" disabled={busy || !password} aria-busy={busy}>
              {busy ? 'Signing…' : `Pay ${usdc(phase.intent.amount)} USDC`}
            </button>
            <button
              type="button"
              className="ap4-btn ap4-ghost"
              disabled={busy}
              onClick={() => {
                // Maybe already taken: kept in History as it is, never discarded from here.
                if (phase.unconfirmed) return newPayment();
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
            initial={sent?.withdrawalId === phase.withdrawalId ? sent : null}
            // On Pay it is always a payment, even one anchored before its names were kept.
            noun="payment"
            payment={phase.paid ? namesOf(phase.paid) : undefined}
            next={{ label: 'New payment', onClick: newPayment }}
            onGone={() => {
              newPayment();
              setNotice(
                'The payment signed here earlier can’t be found any more, so it isn’t shown.',
              );
            }}
            lead={
              phase.paid
                ? (view) => `${usdc(BigInt(view.amount.raw))} USDC to ${who(phase.paid!.recipient)}`
                : undefined
            }
            after={(view) =>
              view.state === 'final' && phase.paid ? (
                <div className="ap4-group" aria-label="Receipt">
                  <div className="ap4-row v4s-still">
                    <span className="ap4-k">Paid</span>
                    <span className="ap4-v">{usdc(BigInt(view.amount.raw))} USDC</span>
                  </div>
                  <div className="ap4-row v4s-still">
                    <span className="ap4-k">To</span>
                    <span className="ap4-v">
                      {who(phase.paid.recipient)} · Base ID {phase.paid.recipient.baseId}
                    </span>
                  </div>
                  <div className="ap4-row v4s-still">
                    <span className="ap4-k">
                      Wallet
                      <span className="w4-row-sub w4-mono">{view.to}</span>
                    </span>
                  </div>
                  {phase.paid.note ? (
                    <div className="ap4-row v4s-still">
                      <span className="ap4-k">Note</span>
                      <span className="ap4-v">“{phase.paid.note}”</span>
                    </div>
                  ) : null}
                  {view.blockNumber ? (
                    <div className="ap4-row v4s-still">
                      <span className="ap4-k">Block</span>
                      <span className="ap4-v">{group(view.blockNumber)}</span>
                    </div>
                  ) : null}
                </div>
              ) : view.state === 'submitted' || view.state === 'included' ? (
                <p className="w4-hint">
                  You can leave this screen. The payment carries on, on Base.
                </p>
              ) : null
            }
          />
          <SentLines agentId={agent.id} except={phase.withdrawalId} noun="payment" />
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
