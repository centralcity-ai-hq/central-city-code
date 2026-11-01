import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../api';
import { readWallet, type WalletView } from '../../base/wallet/api';
import {
  checkRateOperation,
  checkRatingWindow,
  confirmRateTargetOnBase,
  createRating,
  lookupRateTarget,
  rateLookup,
  RateTargetError,
  rateTo,
  RATING_EXPIRED,
  RATING_WINDOW_CLOSED,
  ratingDropped,
  type RateTarget,
  type Stars as StarCount,
} from '../../base/wallet/rate';
import { markRatingsOff, ratingsOff, readRater } from '../../base/wallet/useRater';
import { usePasswordLock } from '../../base/wallet/usePasswordLock';
import {
  clearAnchor,
  discardUnsigned,
  DONE,
  laneFor,
  readWithdrawal,
  saveAnchor,
  signAndSend,
  signaturePath,
} from '../../base/wallet/withdraw';
import { RATE_STARS } from '../../../shared/base/rate';
import {
  chainWords,
  NOT_ON_ARC_YET,
  walletChain,
  type ChainWords,
} from '../../../shared/base/wallet-chains';
import {
  DETAILS_CHANGED,
  LOOK_AGAIN,
  rateFailure,
  ratingKey,
  ratingsOffError,
  ratingStage,
  starLabel,
  starsCaption,
  type Rater,
  type RatingKey,
  type RatingView,
} from './rateScreenModel';
import { RatingsGiven } from './RatingsGiven';
import { GIVEN_FINAL, GIVEN_ON_BASE } from './ratingsGivenModel';
import type { AgentScreenProps } from './screens';
import { SettingsEmpty, SettingsError, SettingsFrame, SettingsLoading } from './settingsShared';
import { StarIcon, Stars } from './Stars';
import { ErrorLine, PasswordField, signingFailure } from './WithdrawalStatus';
import './wallet-screen.css';

/*
 * Rate another Central City agent on Base, 1 to 5 stars, from this agent's wallet (Operation
 * Rating R2; the approved Rate mockup). The owner types BOTH the agent's Base ID and its passport
 * number; the server looks them up and this browser checks the answer is that one agent, then
 * reads Base itself (src/base/wallet/rate.ts). The rating is prepared by the server, checked here
 * to be exactly this one rating, and signed and sent the way Pay does it. Anything that doesn't
 * match signs nothing. Under the form, the agents rated so far (RatingsGiven), each one tap away
 * from being rated again.
 */

/** Lookups wait for the owner to stop typing. */
const LOOKUP_DELAY_MS = 450;
const POLL_MS = 3_000;

type Found =
  | { k: 'idle' }
  | { k: 'checking' }
  | { k: 'found'; target: RateTarget }
  | { k: 'refused'; message: string };

type Phase =
  | { k: 'loading' }
  | { k: 'error'; message: string }
  | { k: 'off' }
  /** The agent itself has no final Base ID and passport: it can't rate. */
  | { k: 'not_rater' }
  | { k: 'find' }
  | { k: 'stars'; target: RateTarget }
  | {
      k: 'status';
      withdrawalId: string;
      target: RateTarget;
      stars: StarCount;
      initial: RatingView | null;
    };

/** The agent's public name, or its Base ID while its card isn't public. */
const who = (target: RateTarget, words: ChainWords) =>
  target.agent.name.trim() || `${words.id} ${target.agent.baseId}`;

function AgentCard({
  target,
  words,
  from,
  checked = false,
}: {
  target: RateTarget;
  words: ChainWords;
  /** The rating agent, on the stars step. */
  from?: string;
  /** The find step: what was checked. */
  checked?: boolean;
}) {
  return (
    <div className="w4-vcard w4-rate-agent" role="group" aria-label="Agent to rate">
      <div className="w4-vmain">
        <span className="w4-av w4-av-lg" aria-hidden="true">
          {who(target, words).charAt(0).toUpperCase()}
        </span>
        <span className="w4-who">
          <b>{who(target, words)}</b>
          <small>
            {words.id} {target.agent.baseId} · Passport {target.agent.short}
            {from ? ` · from ${from}` : ''}
          </small>
        </span>
      </div>
      {checked ? (
        <div className="w4-chips">
          <span className="w4-chip">✓ {words.id} and passport match</span>
          {/* What this browser read on Base itself: the Base ID's passport (rate.ts). */}
          <span className="w4-chip">✓ Passport read from {words.on}</span>
        </div>
      ) : null}
    </div>
  );
}

/** The five stars as real radio buttons: arrow keys move between them, as in any radio group. */
function StarPicker({
  name,
  value,
  onChange,
  disabled,
}: {
  name: string;
  value: StarCount | null;
  onChange: (stars: StarCount) => void;
  disabled: boolean;
}) {
  return (
    <div className="w4-rate-pick">
      <span id="w4-rate-q">How was {name}?</span>
      <div className="w4-pick" role="radiogroup" aria-labelledby="w4-rate-q">
        {RATE_STARS.map((star) => (
          <label key={star} className="w4-pick-star">
            <input
              type="radio"
              name="stars"
              className="visually-hidden"
              value={star}
              aria-label={starLabel(star)}
              checked={value === star}
              disabled={disabled}
              onChange={() => onChange(star)}
            />
            <StarIcon on={value !== null && star <= value} size={38} />
          </label>
        ))}
      </div>
      <span className="w4-pick-caption" aria-live="polite">
        {starsCaption(value)}
      </span>
    </div>
  );
}

/**
 * A rating on its way: read every few seconds until Base is done with it. "Rated" once it is in a
 * block at Base's safe head; final follows by itself. A rating has no cancel (not yet).
 */
function RateStatus({
  agentId,
  words,
  withdrawalId,
  initial,
  name,
  rater,
  stars,
  onAnother,
  onDone,
}: {
  agentId: string;
  words: ChainWords;
  withdrawalId: string;
  initial: RatingView | null;
  name: string;
  rater: string;
  stars: StarCount;
  onAnother: () => void;
  onDone: () => void;
}) {
  const [view, setView] = useState<RatingView | null>(initial);
  useEffect(() => {
    let stop = false;
    let timer = 0;
    const tick = async () => {
      try {
        const next = (await readWithdrawal(agentId, withdrawalId)) as RatingView;
        if (stop) return;
        setView(next);
        if (DONE.includes(next.state)) {
          clearAnchor(agentId, { withdrawalId, userOpHash: next.userOpHash }, 'rating');
          return;
        }
      } catch {
        // Not answered: the next read tries again.
      }
      if (!stop) timer = window.setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [agentId, withdrawalId]);

  const stage = view ? ratingStage(view) : 'on_its_way';
  const rated = stage === 'rated' || stage === 'final';
  return (
    <div className="w4-steps">
      {stage === 'on_its_way' ? (
        <>
          <div className="w4-rate-card w4-rate-going" role="status">
            <span className="v4s-spin" aria-hidden="true" />
            <span className="w4-rate-text">
              <b>Rating… on its way to {words.on}</b>
              <small>
                <Stars value={stars} /> for {name}, from {rater}
              </small>
            </span>
          </div>
          <p className="w4-hint">
            You can leave this screen. The rating carries on, on {words.on}.
          </p>
        </>
      ) : rated ? (
        <div className="w4-rate-card w4-rate-done" role="status">
          {/* ✓ only once Base made it final (as Pay and Ratings given); at the safe head it is on Base. */}
          {stage === 'final' ? (
            <span className="w4-rate-ok" aria-hidden="true">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
                <path
                  d="M5 12.5l4.5 4.5L19 7.5"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          ) : (
            <span className="v4s-spin" aria-hidden="true" />
          )}
          <b className="w4-rate-title">
            {words.say(stage === 'final' ? GIVEN_FINAL : GIVEN_ON_BASE)}
          </b>
          <span className="w4-rate-for">
            <Stars value={stars} size={18} /> for {name}
          </span>
          {view?.explorerUrl ? (
            <a className="w4-link" href={view.explorerUrl} target="_blank" rel="noreferrer">
              View on {words.explorer}
            </a>
          ) : null}
        </div>
      ) : stage === 'failed' ? (
        <p className="w4-refusal" role="alert">
          It didn’t go through{view?.errorCode ? ` (${view.errorCode})` : ''}. Nothing was rated.
        </p>
      ) : stage === 'expired' ? (
        <p className="w4-hint" role="status">
          It wasn’t signed in time, so nothing was rated.
        </p>
      ) : (
        <p className="w4-hint" role="status">
          Cancelled. Nothing was rated.
        </p>
      )}
      <div className="w4-rate-actions">
        {stage === 'on_its_way' ? null : (
          <button type="button" className="ap4-btn ap4-ghost" onClick={onAnother}>
            Rate another agent
          </button>
        )}
        <button type="button" className="ap4-btn" onClick={onDone}>
          Done
        </button>
      </div>
      {rated ? <p className="w4-hint">Rating {name} again replaces this one.</p> : null}
    </div>
  );
}

export function WalletRateScreen({ agent, onBack, backLabel }: AgentScreenProps) {
  const [phase, setPhase] = useState<Phase>({ k: 'loading' });
  const [wallet, setWallet] = useState<WalletView | null>(null);
  const [rater, setRater] = useState<Rater | null>(null);
  const [baseId, setBaseId] = useState('');
  const [passport, setPassport] = useState('');
  const [found, setFound] = useState<Found>({ k: 'idle' });
  const [stars, setStars] = useState<StarCount | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // One key per rating the owner means: a retry never makes a second one; a new agent or new
  // stars, or going back, make a new one.
  const key = useRef<RatingKey | null>(null);
  // The latest lookup wins: an older answer arriving late is dropped.
  const lookup = useRef(0);
  // The signing under way, by generation. Leaving the stars step (Back, another agent, ratings
  // off, the agent's details changed) moves it on: a rating still being prepared or checked then
  // signs and sends nothing, and nothing it learns later reaches the screen. Clearing the password
  // alone isn't that: the signing holds its own copy.
  const signing = useRef(0);
  // The signature has left for the server: Back waits for the answer (the rating is on its way).
  const [sending, setSending] = useState(false);
  const { password, setPassword, alive } = usePasswordLock(busy);
  // The screen closing is a leave too.
  useEffect(
    () => () => {
      signing.current += 1;
    },
    [],
  );

  /** Leaves the stars step: the signing under way (if any) is dropped, nothing of it is sent. */
  function leaveSigning() {
    signing.current += 1;
    key.current = null;
    setPassword('');
    setError('');
    setBusy(false);
    setSending(false);
  }

  const load = useCallback(async () => {
    setPhase({ k: 'loading' });
    if (ratingsOff()) return setPhase({ k: 'off' });
    try {
      const read = await readWallet(agent.id);
      if (read.kind === 'off') return setPhase({ k: 'off' });
      if (read.kind !== 'wallet' || !read.wallet.address)
        return setPhase({ k: 'error', message: 'This wallet can’t rate yet.' });
      setWallet(read.wallet);
      // The chain comes from the wallet view: the agent rates from its registration on that chain.
      const self = await readRater(agent.id, read.wallet.chainId);
      if (!self) return setPhase({ k: 'not_rater' });
      setRater(self);
      setPhase({ k: 'find' });
    } catch (err) {
      setPhase({ k: 'error', message: signingFailure(err) });
    }
  }, [agent.id]);
  useEffect(() => {
    void load();
  }, [load]);

  /** Off: the ratings routes answered 404. The Wallet won't offer Rate again in this page. */
  const off = () => {
    leaveSigning();
    markRatingsOff();
    setPhase({ k: 'off' });
  };

  const raterChain = wallet?.chainId;
  const find = useCallback(
    async (typed: { baseId: string; passport: string }) => {
      const ticket = ++lookup.current;
      setFound({ k: 'checking' });
      try {
        const target = await lookupRateTarget(agent.id, typed, { chainId: raterChain });
        if (ticket !== lookup.current) return;
        setFound({ k: 'found', target });
      } catch (err) {
        if (ticket !== lookup.current) return;
        // On the find step: whatever was signing was dropped when the stars step was left.
        if (ratingsOffError(err)) {
          markRatingsOff();
          return setPhase({ k: 'off' });
        }
        setFound({
          k: 'refused',
          message: rateFailure(err, agent.name, signingFailure, raterChain),
        });
      }
    },
    [agent.id, agent.name, raterChain],
  );

  // Look the agent up once both are typed in their right form and the owner stops typing.
  useEffect(() => {
    // Whatever was found was for the values before: it goes at once, never shown for new ones.
    lookup.current += 1;
    try {
      rateLookup({ baseId, passport }, raterChain);
    } catch {
      // Not complete yet: Continue says what is missing.
      setFound({ k: 'idle' });
      return;
    }
    setFound({ k: 'checking' });
    const timer = window.setTimeout(() => void find({ baseId, passport }), LOOKUP_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [baseId, passport, find, raterChain]);

  function proceed(event: FormEvent) {
    event.preventDefault();
    if (found.k === 'found') {
      setError('');
      setPhase({ k: 'stars', target: found.target });
      return;
    }
    if (found.k === 'checking') return;
    try {
      rateLookup({ baseId, passport }, raterChain);
    } catch (err) {
      return setFound({
        k: 'refused',
        message: err instanceof RateTargetError ? err.message : signingFailure(err),
      });
    }
    void find({ baseId, passport });
  }

  function backToFind() {
    leaveSigning();
    setPhase({ k: 'find' });
  }

  function another() {
    leaveSigning();
    lookup.current += 1;
    setBaseId('');
    setPassport('');
    setStars(null);
    setFound({ k: 'idle' });
    setPhase({ k: 'find' });
  }

  async function rate(event: FormEvent) {
    event.preventDefault();
    if (phase.k !== 'stars' || !wallet?.address || !rater || stars === null) return;
    setError('');
    setBusy(true);
    setSending(false);
    // This signing's generation: once the owner leaves the stars step it is over (leaveSigning).
    const generation = ++signing.current;
    const current = () => signing.current === generation;
    // Marked before anything else: if the password goes while Base is read, nothing is sent.
    const unlocked = alive();
    // Both, checked by signAndSend right before unlocking, signing and sending.
    const mark = () => current() && unlocked();
    // The rating prepared and checked here, once there is one: dropped if it can never be signed.
    let checked: { withdrawalId: string; userOpHash: `0x${string}` } | null = null;
    try {
      let target = phase.target;
      // The rating carries the check the owner saw. Past its expiry the agent is checked again
      // and shown, and the owner rates that one: nothing is sent on a check they didn't see.
      if (target.expiresAt <= Date.now()) {
        target = await lookupRateTarget(
          agent.id,
          { baseId, passport },
          { chainId: wallet.chainId },
        );
        if (!current()) return;
        setFound({ k: 'found', target });
        setPhase({ k: 'stars', target });
        throw new RateTargetError(
          'That check was too old, so the agent was checked again. Rate once more.',
        );
      }
      const chosen = ratingKey(key.current, target.lookupId, stars, () => crypto.randomUUID());
      key.current = chosen;
      const request = await createRating(agent.id, {
        to: rateTo(target),
        stars,
        idempotencyKey: chosen.key,
      });
      // The owner went back meanwhile (another agent, perhaps): this rating is dropped unsigned.
      if (!current()) return;
      // Checked here before signing: exactly this one rating, of this agent, with these stars.
      const hash = checkRateOperation({
        request,
        agentChainId: wallet.chainId,
        wallet: wallet.address,
        owner: wallet.ownerAddress,
        agentId: agent.id,
        expected: { baseId: target.agent.baseId, stars },
        raterBaseId: rater.baseId,
        // With lanes on, the rating's own lane (from its own id); otherwise nothing changes.
        lane: await laneFor(agent.id, request, wallet),
      });
      checked = { withdrawalId: request.withdrawalId, userOpHash: hash };
      // Once more, right before signing: Base still has that passport at that Base ID.
      await confirmRateTargetOnBase(target, { chainId: wallet.chainId });
      if (!current()) return;
      // With lanes on, its sponsorship still valid within the server's fixed deadline (as Pay).
      checkRatingWindow(request);
      // The checked operation is kept before the signature leaves: a lost answer can't lose it.
      // `mark` is checked again after unlocking and after signing: left by then, nothing is sent.
      const view = await signAndSend(
        signaturePath(agent.id, request.withdrawalId),
        hash,
        password,
        mark,
        () => {
          // Again right before the signature leaves: the unlock may have taken a while.
          checkRatingWindow(request);
          saveAnchor(
            agent.id,
            {
              withdrawalId: request.withdrawalId,
              userOperation: request.userOperation,
              userOpHash: hash,
            },
            'rating',
          );
          // Sent from here on: Back waits for the answer (and this rating carries on regardless).
          setSending(true);
        },
        wallet.ownerAddress,
      );
      if (!current()) return;
      setPassword('');
      key.current = null;
      setPhase({
        k: 'status',
        withdrawalId: request.withdrawalId,
        target,
        stars,
        initial: view as RatingView,
      });
    } catch (err) {
      // Left meanwhile: what this signing ran into is no longer the screen's (nor its password).
      if (!current()) return;
      setPassword('');
      if (ratingsOffError(err)) return off();
      // Refused before the server took a signature (its sponsorship or its time ran out, or any
      // other refusal from withdraw.ts SIGNATURE_REFUSALS): nothing was sent and this rating can
      // never be sent as it is. It is dropped and discarded, and the next Rate prepares a new one
      // under a new key: the same one is never sent again (the old key would only replay it).
      const dropped = checked ? ratingDropped(err) : null;
      if (dropped && checked) {
        key.current = null;
        clearAnchor(agent.id, checked, 'rating');
        await discardUnsigned(agent.id, checked.withdrawalId);
        if (!current()) return;
        setError(
          dropped === 'window'
            ? RATING_WINDOW_CLOSED
            : dropped === 'expired'
              ? RATING_EXPIRED
              : rateFailure(err, agent.name, signingFailure, raterChain),
        );
        return;
      }
      // The agent on screen isn't the one to rate any more: back to its details to check again.
      if (err instanceof ApiError && (LOOK_AGAIN as readonly string[]).includes(err.code ?? '')) {
        leaveSigning();
        lookup.current += 1;
        setFound({ k: 'refused', message: DETAILS_CHANGED });
        setPhase({ k: 'find' });
        return;
      }
      setError(rateFailure(err, agent.name, signingFailure, raterChain));
    } finally {
      if (current()) {
        setBusy(false);
        setSending(false);
      }
    }
  }

  const target = phase.k === 'stars' || phase.k === 'status' ? phase.target : null;
  const words = chainWords(raterChain);
  // Arc mainnet: not until it is recorded (shared/base/wallet-chains.ts).
  const notYet = walletChain(raterChain)?.manager === null;
  return (
    <SettingsFrame
      backLabel={phase.k === 'stars' ? 'Rate an agent' : (backLabel ?? 'Wallet')}
      onBack={phase.k === 'stars' ? backToFind : onBack}
      backDisabled={sending}
      title={target ? `Rate ${who(target, words)}` : 'Rate an agent'}
      sub={
        phase.k === 'find'
          ? `Rate another Central City agent on ${words.on}, from ${agent.name}. Type its ${words.id} and its passport number: both must belong to the same Central City agent.`
          : undefined
      }
    >
      {phase.k === 'loading' ? (
        <SettingsLoading />
      ) : phase.k === 'error' ? (
        <SettingsError message={phase.message} onRetry={() => void load()} />
      ) : phase.k === 'off' ? (
        <SettingsEmpty title="Not available yet">
          Rating agents isn’t switched on here yet.
        </SettingsEmpty>
      ) : phase.k === 'not_rater' ? (
        <SettingsEmpty title="Not available for this agent">
          {notYet
            ? NOT_ON_ARC_YET
            : `Only a Central City agent on ${words.on}, with a final ${words.id} and a passport, can rate others.`}
        </SettingsEmpty>
      ) : phase.k === 'find' ? (
        <form className="w4-steps" onSubmit={proceed} noValidate>
          <div className="w4-pair">
            <label className="w4-field">
              <span>{words.id}</span>
              <input
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                aria-required="true"
                aria-invalid={found.k === 'refused' || undefined}
                value={baseId}
                onChange={(event) => setBaseId(event.target.value)}
              />
            </label>
            <label className="w4-field">
              <span>Passport number</span>
              <input
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-required="true"
                aria-invalid={found.k === 'refused' || undefined}
                value={passport}
                onChange={(event) => setPassport(event.target.value)}
              />
            </label>
          </div>
          <p className="w4-hint w4-pair-hint">
            Both are on the agent’s passport. The passport number is the 6 characters after
            centralcity.ai/a/.
          </p>
          <div className="w4-slot" aria-live="polite">
            {found.k === 'checking' ? (
              <p className="w4-hint">Checking on {words.on}…</p>
            ) : found.k === 'found' ? (
              <AgentCard target={found.target} words={words} checked />
            ) : found.k === 'refused' ? (
              <p className="w4-refusal" role="alert">
                {found.message}
              </p>
            ) : null}
          </div>
          <button
            type="submit"
            className="ap4-btn w4-wide"
            disabled={found.k === 'checking'}
            aria-busy={found.k === 'checking'}
          >
            Continue
          </button>
          {/* The agents rated so far: tap one to fill in its details and rate it again. */}
          <RatingsGiven
            agentId={agent.id}
            chainId={raterChain}
            onPick={(rating) => {
              setBaseId(rating.baseId);
              setPassport(rating.short);
            }}
          />
        </form>
      ) : phase.k === 'stars' ? (
        <form className="w4-steps" onSubmit={(event) => void rate(event)}>
          <AgentCard target={phase.target} words={words} from={agent.name} />
          <StarPicker
            name={who(phase.target, words)}
            value={stars}
            disabled={busy}
            onChange={(next) => {
              setError('');
              setStars(next);
            }}
          />
          {/* Signing always opens the wallet key with its password: the key is never kept. */}
          <PasswordField value={password} onChange={setPassword} />
          <p className="w4-rate-note">
            Public on {words.on} and stays there. Free: the fee is covered. One rating per agent
            counts, your latest.
          </p>
          <ErrorLine message={error} />
          <button
            type="submit"
            className="ap4-btn w4-wide"
            disabled={busy || stars === null || !password}
            aria-busy={busy}
          >
            {busy ? 'Signing…' : `Rate ${who(phase.target, words)}`}
          </button>
        </form>
      ) : phase.k === 'status' && rater ? (
        <RateStatus
          agentId={agent.id}
          words={words}
          withdrawalId={phase.withdrawalId}
          initial={phase.initial}
          name={who(phase.target, words)}
          rater={agent.name}
          stars={phase.stars}
          onAnother={another}
          onDone={onBack}
        />
      ) : null}
    </SettingsFrame>
  );
}
