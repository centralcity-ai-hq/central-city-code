import { ArrowUpRight, Check, Circle, LoaderCircle, X } from 'lucide-react';
import {
  passed,
  passportPath,
  ticks,
  type OnBaseRow,
  type VerifyResult,
  type VerifyTick,
} from './onBaseData';
import { number } from './countLogClient';
import './on-base.css';

export type VerifyState = { phase: 'checking' } | { phase: 'done'; result: VerifyResult };

const TITLES = {
  owner: { pass: 'Owner matches', fail: "Owner doesn't match", pending: 'Owner not read yet' },
  // The tokenURI on Base is the agent's passport address (its short link); the evidence line
  // shows the address Base returned.
  uri: {
    pass: 'Points to its passport on centralcity.ai',
    fail: 'Points somewhere else',
    pending: 'Address not read yet',
  },
  // Central City's own passport names the Base ID now: its endorsement today, not a proof of who
  // minted it (each agent mints from its own account).
  registeredBy: {
    pass: 'Confirmed by Central City',
    fail: 'Not confirmed by Central City',
    pending: 'Not confirmed yet',
  },
  // A fail proves only that this mint's finality wasn't shown (a wrong hint, a reorg), never that
  // the Base ID isn't on Base: the owner and address checks say what Base holds.
  final: { pass: 'Final on Base', fail: 'Finality not proven', pending: 'Not final yet' },
  // The passport's Central City score, recomputed in this browser from Base's feedback of the
  // rater wallets the passport names.
  score: {
    pass: 'Score: matches Base',
    fail: "Score: doesn't match Base",
    pending: 'Score: not read from Base',
  },
} as const;

function Tick({ tick, titles }: { tick: VerifyTick; titles: Record<VerifyTick['state'], string> }) {
  return (
    <li className="ob-tick" data-state={tick.state}>
      <i aria-hidden="true">
        {tick.state === 'pass' ? (
          <Check size={12} strokeWidth={3} />
        ) : tick.state === 'fail' ? (
          <X size={11} strokeWidth={3} />
        ) : (
          <Circle size={7} fill="currentColor" />
        )}
      </i>
      <div>
        <b>{titles[tick.state]}</b>
        <span>{tick.evidence}</span>
      </div>
    </li>
  );
}

/**
 * Verify's answer, under a row or on the passport (docs/design/on-base-mockup.html): four checks
 * read from Base in this browser, each with what Base returned, and on a passport with a Central
 * City score a fifth, the score recomputed from Base. Unreachable claims nothing.
 */
export function OnBaseVerifyPanel({
  row,
  state,
  onRetry,
  passportLink = true,
  basescanHref,
}: {
  row: Pick<OnBaseRow, 'baseId' | 'short'>;
  state: VerifyState;
  onRetry: () => void;
  /** Under a list row: "Open the passport"; on the passport itself, not. */
  passportLink?: boolean;
  /** "View on Basescan": the Base ID's own page (basescanToken) or its registration transaction. */
  basescanHref: string;
}) {
  const label = `Verify Base ID ${row.baseId}`;
  if (state.phase === 'checking')
    return (
      <div
        className="ob-check"
        data-place={passportLink ? undefined : 'passport'}
        role="region"
        aria-label={label}
        aria-busy="true"
      >
        <p className="ob-check-head" role="status">
          <LoaderCircle className="spin" size={14} aria-hidden="true" /> Reading from Base in your
          browser…
        </p>
      </div>
    );
  const { result } = state;
  if (result.kind === 'unreachable')
    return (
      <div
        className="ob-check"
        data-place={passportLink ? undefined : 'passport'}
        role="region"
        aria-label={label}
      >
        <div className="ob-banner" data-tone="bad" role="alert">
          <div>
            <b>Couldn't reach Base from your browser</b>
            <p>
              Nothing was checked, so nothing is marked as passed. Try again; it reads Base
              directly, never from Central City.
            </p>
          </div>
          <button type="button" className="ob-pill" onClick={onRetry}>
            Try again
          </button>
        </div>
      </div>
    );
  const count = passed(result);
  const total = ticks(result).length;
  const finalizing = result.final.state === 'pending';
  const host = (() => {
    try {
      return new URL(result.rpc).host;
    } catch {
      return result.rpc;
    }
  })();
  return (
    <div
      className="ob-check"
      data-place={passportLink ? undefined : 'passport'}
      role="region"
      aria-label={label}
    >
      <p className="ob-check-head">
        <b>
          {count === total
            ? `All ${total} checks pass`
            : `${count} of ${total} checks pass${finalizing && count === total - 1 ? ' · finalizing' : ''}`}
        </b>
        <span>
          Read just now in your browser from Base ({host}), block {number.format(result.block)}.
          From Central City, only the passport this ID points to
          {result.score ? ' and which rater wallets are Central City agents' : ''}.
        </span>
      </p>
      <ul className="ob-ticks">
        <Tick tick={result.owner} titles={TITLES.owner} />
        <Tick tick={result.uri} titles={TITLES.uri} />
        <Tick tick={result.registeredBy} titles={TITLES.registeredBy} />
        <Tick tick={result.final} titles={TITLES.final} />
        {result.score ? <Tick tick={result.score} titles={TITLES.score} /> : null}
      </ul>
      <div className="ob-check-links">
        {passportLink ? (
          <a className="ob-pill" href={passportPath(row.short)}>
            Open the passport
          </a>
        ) : null}
        <a className="ob-pill" href={basescanHref} target="_blank" rel="noreferrer">
          View on Basescan <ArrowUpRight size={13} aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}
