import { useEffect, useRef, useState } from 'react';
import { CircleAlert, LoaderCircle } from 'lucide-react';
import {
  FEED_SPONSORED_DONE,
  FEED_SPONSORED_LIMITS,
  type FeedSponsoredCall,
} from '../../../shared/feed-sponsored';
import { ResultBlock } from './CallCard';
import { getSponsoredCall, SponsoredFailure } from './sponsoredApi';
import {
  DONE_TITLE,
  doneLine,
  FREE_FAILED,
  FREE_NO_RESULT,
  freeStateLine,
  sponsoredResult,
} from './sponsoredModel';

/*
 * A free first buy after Use free (the First service free mockup, "After paying"): where it is
 * while Central City pays, then "Done. Paid by Central City." with the split and the result, in
 * the existing result block. Read every pollMs until it is done (paused while the tab is hidden).
 */

export const sponsoredDone = (call: Pick<FeedSponsoredCall, 'state'>) =>
  FEED_SPONSORED_DONE.includes(call.state);

export function useSponsoredPolling(
  initial: FeedSponsoredCall,
  onUpdate?: (call: FeedSponsoredCall) => void,
): FeedSponsoredCall {
  const [call, setCall] = useState(initial);
  useEffect(() => setCall(initial), [initial]);
  const report = useRef(onUpdate);
  report.current = onUpdate;
  const done = sponsoredDone(call);
  const callId = call.callId;
  useEffect(() => {
    if (done) return;
    let stop = false;
    let timer = 0;
    let misses = 0;
    const controller = new AbortController();
    const pollMs = FEED_SPONSORED_LIMITS.pollMs;
    const tick = async () => {
      if (stop) return;
      if (document.visibilityState === 'hidden') {
        timer = window.setTimeout(() => void tick(), pollMs);
        return;
      }
      try {
        const next = await getSponsoredCall(callId, { signal: controller.signal });
        if (stop) return;
        misses = 0;
        setCall(next);
        report.current?.(next);
        if (sponsoredDone(next)) return;
      } catch (error) {
        if (stop) return;
        // Gone (another account now, or the route is off): nothing more to read.
        if (
          error instanceof SponsoredFailure &&
          (error.code === 'off' || error.code === 'signed_out')
        )
          return;
        misses += 1;
      }
      timer = window.setTimeout(() => void tick(), pollMs * Math.min(8, 2 ** Math.min(misses, 3)));
    };
    timer = window.setTimeout(() => void tick(), pollMs);
    return () => {
      stop = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [callId, done]);
  return call;
}

export function FreeCallCard({
  call: initial,
  agentName,
  seller,
  host,
  headingId,
  onUpdate,
}: {
  call: FeedSponsoredCall;
  agentName: string;
  /** The selling agent's name, as the listing names it. */
  seller: string | null;
  host: string;
  headingId: string;
  onUpdate?: (call: FeedSponsoredCall) => void;
}) {
  const call = useSponsoredPolling(initial, onUpdate);
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => head.current?.focus(), []);
  const busy = freeStateLine(call, agentName);
  const result = call.state === 'delivered' ? sponsoredResult(call) : null;
  return (
    <section className="fp-call fp-free" aria-labelledby={headingId} data-state={call.state}>
      <h3 id={headingId} tabIndex={-1} ref={head}>
        Your call
      </h3>
      {busy ? (
        <p className="fp-state" data-tone="busy" role="status">
          <LoaderCircle size={16} aria-hidden="true" className="spin" />
          <span>{busy}</span>
        </p>
      ) : call.state === 'failed' ? (
        <p className="fp-state" data-tone="bad" role="status">
          <CircleAlert size={16} aria-hidden="true" />
          <span>{FREE_FAILED}</span>
        </p>
      ) : (
        <div className="fp-free-ok" role="status">
          <b>{DONE_TITLE}</b>
          <span>{doneLine(agentName, call.priceRaw, seller)}</span>
        </div>
      )}
      {result ? <ResultBlock result={result} host={host} /> : null}
      {call.state === 'paid_no_result' || (call.state === 'delivered' && !result) ? (
        <p className="fd-fine">{FREE_NO_RESULT}</p>
      ) : null}
    </section>
  );
}
