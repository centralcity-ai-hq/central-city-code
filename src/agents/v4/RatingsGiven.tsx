import { useEffect, useState } from 'react';
import { ApiError } from '../../api';
import { readRatingsGiven, type RatingGiven } from '../../base/wallet/rate';
import { readWithdrawal } from '../../base/wallet/withdraw';
import {
  givenDate,
  givenFollowed,
  givenName,
  givenOpen,
  givenStatus,
  GIVEN_NOTE,
  latestPerAgent,
} from './ratingsGivenModel';
import { Stars } from './Stars';

/*
 * The agents this agent rated, on the Rate screen under Continue (the product owner's call after
 * the first real rating). The server lists what the wallet's ratings are as stored (GET
 * …/wallet/ratings, no Base read); while one is still on its way, it is read on the withdrawal
 * route (which follows it on Base) and the list read again, every POLL_MS while the page is shown.
 * Nothing shows while there are none, the read fails or ratings are off. Tapping a row fills in its
 * Base ID and passport number, to rate that agent again.
 */

/** While a rating is on its way and the page is shown. */
export const GIVEN_POLL_MS = 15_000;
/** Too many reads (429): wait a minute. */
const BACKOFF_MS = 60_000;
/** At most this many ratings on their way are followed per read. */
const FOLLOW_MAX = 5;

export function RatingsGiven({
  agentId,
  onPick,
}: {
  agentId: string;
  onPick: (rating: RatingGiven) => void;
}) {
  const [rows, setRows] = useState<RatingGiven[]>([]);
  useEffect(() => {
    let stop = false;
    let running = false;
    let timer = 0;
    let shown: RatingGiven[] = [];
    const later = (ms: number) => {
      window.clearTimeout(timer);
      if (!stop) timer = window.setTimeout(() => void tick(), ms);
    };
    const tick = async () => {
      // Hidden: no reads; it picks up again when the page is shown.
      if (stop || running || document.visibilityState === 'hidden') return;
      running = true;
      try {
        // Those on their way are followed on Base first (their owner's read), then listed.
        await Promise.all(
          shown
            .filter(givenFollowed)
            .slice(0, FOLLOW_MAX)
            .map((row) => readWithdrawal(agentId, row.withdrawalId).catch(() => null)),
        );
        if (stop) return;
        shown = latestPerAgent(await readRatingsGiven(agentId));
        if (stop) return;
        setRows(shown);
        if (shown.some(givenOpen)) later(GIVEN_POLL_MS);
      } catch (error) {
        // Ratings off here (404): nothing to show, nothing to poll. Too many reads: wait longer.
        if (error instanceof ApiError && error.status === 404) {
          shown = [];
          setRows([]);
          return;
        }
        later(error instanceof ApiError && error.status === 429 ? BACKOFF_MS : GIVEN_POLL_MS);
      } finally {
        running = false;
      }
    };
    const visible = () => {
      if (document.visibilityState === 'visible' && shown.some(givenOpen)) later(0);
    };
    document.addEventListener('visibilitychange', visible);
    void tick();
    return () => {
      stop = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [agentId]);

  if (!rows.length) return null;
  return (
    <section className="w4-given" aria-labelledby="w4-given-h">
      <p className="w4-section" id="w4-given-h">
        Ratings given
      </p>
      <div className="ap4-group w4-list" role="list" aria-label="Ratings given">
        {rows.map((row) => {
          const name = givenName(row);
          const status = givenStatus(row);
          return (
            <div
              className="ap4-row v4s-still w4-given-row"
              role="listitem"
              key={row.withdrawalId}
              data-phase={status.phase}
            >
              <button
                type="button"
                className="w4-given-pick"
                title={`Rate ${name} again`}
                onClick={() => onPick(row)}
              >
                <span className="w4-av" aria-hidden="true">
                  {name.charAt(0).toUpperCase()}
                </span>
                <span className="ap4-k">
                  <span className="w4-given-who">
                    <span className="w4-given-name">Rated {name}</span>
                    <Stars value={row.stars} />
                  </span>
                  <span className="w4-row-sub">
                    {status.line} · {givenDate(row.createdAt)}
                  </span>
                </span>
              </button>
              {row.explorerUrl ? (
                <a
                  className="w4-given-link"
                  href={row.explorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Rating of ${name} on Basescan`}
                >
                  Basescan
                </a>
              ) : null}
            </div>
          );
        })}
      </div>
      <p className="w4-hint w4-given-note">{GIVEN_NOTE}</p>
    </section>
  );
}
