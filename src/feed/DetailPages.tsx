import { useEffect, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, LoaderCircle, RefreshCw, Wallet } from 'lucide-react';
import type { FeedServiceDetail, PublicFeedRequest } from '../../shared/feed';
import type { FeedPayCall } from '../../shared/feed-pay';
import { usePageTitle } from '../shell/usePageTitle';
import {
  alreadyClosed,
  closeRequest,
  feedErrorCopy,
  FeedFailure,
  getRequest,
  getService,
} from './feedApi';
import { feedClick, goTo } from './feedNav';
import { feedHref, heldManageCode, readManageToken } from './feedPaths';
import { agoText, plain, shownTitles, utcText } from './feedFormat';
import { Banner, DrawerHead, Empty, SkeletonCards, useNow } from './FeedParts';
import { CallCard } from './pay/CallCard';
import { callPageSub, refusalSentence } from './pay/payModel';
import { getCall, payFailure } from './payApi';
import { dropMine, mineEntry, useMine } from './mine';
import { RequestDetail } from './RequestItem';
import { hostHref, ServiceDetail, ServiceHead } from './ServiceItem';

/*
 * The Feed's pages for one thing: a service (/feed/services/<id>, the address the assistants'
 * search gives as detail_url), a request (/feed/requests/<id>), the page that closes a request
 * (/feed/requests/<id>/manage#ccf_…), and one paid call of the person's agent (/feed/calls/<id>,
 * city_service_call's detail_url and the wallet History's link). Saved links keep working: a withdrawn service still answers
 * for 30 days, and anything else that is gone says so plainly.
 */

function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <p className="fd-back">
      <a className="fd-link" href={href} onClick={feedClick(href, { top: true })}>
        {label}
      </a>
    </p>
  );
}

/**
 * "Request closed", in place of the button that closed it: it takes focus, so it is read out and
 * keyboard users keep their place.
 */
function ClosedCard({ title }: { title: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <section className="fd-sheet fd-post" aria-labelledby="fd-closed-h">
      <div className="fd-ok-head">
        <CircleCheck size={22} aria-hidden="true" />
        <h2 id="fd-closed-h" tabIndex={-1} ref={heading}>
          Request closed
        </h2>
      </div>
      <p>{title ? `“${title}” no longer shows in the Feed.` : 'It no longer shows in the Feed.'}</p>
    </section>
  );
}

function RetryBanner({
  error,
  action,
  title,
  onRetry,
}: {
  error: unknown;
  action: 'service' | 'request';
  title: string;
  onRetry: () => void;
}) {
  const copy = feedErrorCopy(error, action);
  return (
    <Banner
      tone="bad"
      title={title}
      action={
        <button type="button" className="fd-btn" onClick={onRetry}>
          <RefreshCw size={14} aria-hidden="true" />
          Try again
        </button>
      }
    >
      {`${copy.title} ${copy.detail}`}
    </Banner>
  );
}

type Load<T> =
  | { phase: 'loading' }
  | { phase: 'ready'; value: T }
  | { phase: 'missing' }
  | { phase: 'error'; error: unknown };

const missing = (error: unknown) =>
  error instanceof FeedFailure &&
  (error.code === 'service_not_found' ||
    error.code === 'request_not_found' ||
    error.code === 'not_found');

export function ServicePage({ id }: { id: string }) {
  const [load, setLoad] = useState<Load<FeedServiceDetail>>({ phase: 'loading' });
  // Try again reads past the browser's cache (attempt > 0).
  const [attempt, setAttempt] = useState(0);
  const now = useNow();
  const service = load.phase === 'ready' ? load.value.service : null;
  const title = service ? (shownTitles([service]).get(service.id) ?? service.provider.host) : '';
  usePageTitle(title ? `${title} · Feed · Central City` : 'Feed · Central City');

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ phase: 'loading' });
    getService(id, { signal: controller.signal, ...(attempt ? { cache: 'no-store' } : {}) })
      .then((value) => setLoad({ phase: 'ready', value }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoad(missing(error) ? { phase: 'missing' } : { phase: 'error', error });
      });
    return () => controller.abort();
  }, [id, attempt]);

  const back = <BackLink href={feedHref.offered} label="Back to Offered" />;
  if (load.phase === 'loading')
    return (
      <>
        {back}
        <SkeletonCards label="Loading the service" count={1} />
      </>
    );
  if (load.phase === 'missing')
    return (
      <>
        {back}
        <div className="fd-sheet">
          <Empty
            title="This service isn’t listed"
            help="x402 Bazaar may no longer list it, or it was hidden. Saved links work for 30 days after a service leaves the list."
          />
        </div>
      </>
    );
  if (load.phase === 'error')
    return (
      <>
        {back}
        <RetryBanner
          error={load.error}
          action="service"
          title="This service couldn’t be loaded"
          onRetry={() => setAttempt((value) => value + 1)}
        />
      </>
    );
  const detail = load.value;
  const source = detail.sources[0];
  return (
    <>
      {back}
      {detail.degraded && detail.service.status !== 'withdrawn' ? (
        <Banner tone="warn" title="Source refresh delayed">
          {source?.lastSuccessAt
            ? `x402 Bazaar hasn’t answered since ${utcText(source.lastSuccessAt)} (${agoText(source.lastSuccessAt, now)}). This page shows what it listed then.`
            : 'x402 Bazaar hasn’t answered lately. This page shows what it listed last.'}
        </Banner>
      ) : null}
      <section className="fd-sheet fd-detail" aria-labelledby="fd-dh">
        <ServiceHead id="fd-dh" service={detail.service} title={title} />
        <ServiceDetail
          service={detail.service}
          now={now}
          onHost={(host) => goTo(hostHref(host), { top: true })}
        />
      </section>
    </>
  );
}

export function RequestPage({ id, onClosed }: { id: string; onClosed?: () => void }) {
  const [load, setLoad] = useState<Load<PublicFeedRequest>>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [closing, setClosing] = useState(false);
  const [closeProblem, setCloseProblem] = useState('');
  const [closedTitle, setClosedTitle] = useState<string | null>(null);
  const now = useNow();
  const mine = useMine().find((entry) => entry.request.id === id) ?? null;
  const request = load.phase === 'ready' ? load.value : null;
  usePageTitle(request ? `${plain(request.title)} · Feed · Central City` : 'Feed · Central City');

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ phase: 'loading' });
    getRequest(id, { signal: controller.signal, ...(attempt ? { cache: 'no-store' } : {}) })
      .then((value) => setLoad({ phase: 'ready', value }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoad(missing(error) ? { phase: 'missing' } : { phase: 'error', error });
      });
    return () => controller.abort();
  }, [id, attempt]);

  async function close() {
    if (!mine) return;
    setClosing(true);
    setCloseProblem('');
    try {
      // Closed already (elsewhere, or it expired): closed all the same.
      const done = await closeRequest(id, mine.manageToken).catch((error: unknown) => {
        if (alreadyClosed(error)) return null;
        throw error;
      });
      dropMine(id);
      // An open request left the list (not one closed elsewhere already): the count follows.
      if (done) onClosed?.();
      setClosedTitle(plain(done?.title ?? mine.request.title));
    } catch (error) {
      const copy = feedErrorCopy(error, 'close');
      setCloseProblem(`${copy.title} ${copy.detail}`);
    } finally {
      setClosing(false);
    }
  }

  const back = <BackLink href={feedHref.requests} label="Back to Searched for" />;
  if (closedTitle !== null)
    return (
      <>
        {back}
        <ClosedCard title={closedTitle} />
      </>
    );
  if (load.phase === 'loading')
    return (
      <>
        {back}
        <SkeletonCards label="Loading the request" count={1} />
      </>
    );
  if (load.phase === 'missing')
    return (
      <>
        {back}
        <div className="fd-sheet">
          <Empty
            title="This request isn’t listed"
            help="It may have been closed, expired or hidden, or it is still in review."
          />
        </div>
      </>
    );
  if (load.phase === 'error')
    return (
      <>
        {back}
        <RetryBanner
          error={load.error}
          action="request"
          title="This request couldn’t be loaded"
          onRetry={() => setAttempt((value) => value + 1)}
        />
      </>
    );
  return (
    <>
      {back}
      <section className="fd-sheet fd-detail" aria-labelledby="fd-dh">
        <RequestDetail
          headId="fd-dh"
          request={load.value}
          now={now}
          mine={Boolean(mine)}
          manage
          closing={closing}
          closeProblem={closeProblem}
          onCloseRequest={() => void close()}
        />
      </section>
    </>
  );
}

/**
 * The private link's page. Its token left the address bar (and so history) at startup
 * (feedPaths.ts captureManageCode); it lives in memory until the request is closed. Signed out,
 * the page opens only with that token, which alone closes it (feedPaths.ts signedOutManageId);
 * signed in, the account that posted the request can close it here without the token too.
 */
export function ManagePage({ id, onClosed }: { id: string; onClosed?: () => void }) {
  const [token] = useState(
    () =>
      heldManageCode(id) ??
      readManageToken(window.location.hash) ??
      mineEntry(id)?.manageToken ??
      null,
  );
  const [load, setLoad] = useState<Load<PublicFeedRequest>>({ phase: 'loading' });
  const [state, setState] = useState<'idle' | 'closing' | 'closed'>('idle');
  const [problem, setProblem] = useState('');
  const [closedTitle, setClosedTitle] = useState('');
  const now = useNow();
  usePageTitle('Close your request · Feed · Central City');

  useEffect(() => {
    if (!window.location.hash) return;
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${window.location.search}`,
    );
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    getRequest(id, { signal: controller.signal })
      .then((value) => setLoad({ phase: 'ready', value }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoad(missing(error) ? { phase: 'missing' } : { phase: 'error', error });
      });
    return () => controller.abort();
  }, [id]);

  async function close() {
    if (state === 'closing') return;
    setState('closing');
    setProblem('');
    try {
      // Closed already (elsewhere, or it expired): closed all the same.
      const done = await closeRequest(id, token).catch((error: unknown) => {
        if (alreadyClosed(error)) return null;
        throw error;
      });
      const shown = load.phase === 'ready' ? load.value.title : mineEntry(id)?.request.title;
      dropMine(id);
      // Only an open, listed request lowers the count (not one in review, nor one closed already).
      if (done && load.phase === 'ready' && load.value.status === 'open') onClosed?.();
      setClosedTitle(plain(done?.title ?? shown));
      setState('closed');
    } catch (error) {
      const copy = feedErrorCopy(error, 'close');
      setProblem(`${copy.title} ${copy.detail}`);
      setState('idle');
    }
  }

  const back = <BackLink href={feedHref.requests} label="Back to Searched for" />;
  if (state === 'closed')
    return (
      <>
        {back}
        <ClosedCard title={closedTitle} />
      </>
    );
  return (
    <>
      {back}
      <section className="fd-sheet fd-post" aria-labelledby="fd-manage-h">
        <div className="fd-post-head">
          <h2 id="fd-manage-h">Close your request</h2>
          <p>Closing takes it out of the Feed for good. Nobody can respond to it after that.</p>
        </div>
        {load.phase === 'ready' ? (
          <div className="fd-sheet fd-detail fd-inner">
            <RequestDetail headId="fd-manage-r" request={load.value} now={now} bare />
          </div>
        ) : load.phase === 'missing' ? (
          <p className="fd-muted">
            This request isn’t listed: it may be closed or expired already, or still in review. You
            can still close it.
          </p>
        ) : load.phase === 'error' ? (
          <p className="fd-muted">The request couldn’t be shown. You can still close it.</p>
        ) : (
          <SkeletonCards label="Loading your request" count={1} />
        )}
        {token ? null : (
          <p className="fd-muted">
            This link has no private code. If you posted the request from this account, you can
            still close it here.
          </p>
        )}
        {problem ? (
          <p className="fd-err" role="alert">
            <CircleAlert size={14} aria-hidden="true" />
            <span>{problem}</span>
          </p>
        ) : null}
        <div className="fd-d-actions">
          <button
            type="button"
            className="fd-btn primary"
            aria-disabled={state === 'closing' || undefined}
            onClick={() => void close()}
          >
            {state === 'closing' ? (
              <LoaderCircle className="spin" size={14} aria-hidden="true" />
            ) : null}
            {state === 'closing' ? 'Closing…' : 'Close the request'}
          </button>
        </div>
      </section>
    </>
  );
}

/**
 * One call an agent of the person paid (Feed or their AI): where it is, the payment and the
 * result while it is kept. Only the owner of the paying wallet reads it; anyone else gets the
 * same answer as an unknown call.
 */
export function CallPage({ id }: { id: string }) {
  const [load, setLoad] = useState<Load<FeedPayCall>>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const now = useNow();
  usePageTitle(
    load.phase === 'ready'
      ? `Call to ${load.value.service.host} · Feed · Central City`
      : 'Service call · Feed · Central City',
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ phase: 'loading' });
    getCall(id, { signal: controller.signal })
      .then((value) => setLoad({ phase: 'ready', value }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const failure = payFailure(error);
        setLoad(
          failure.code === 'call_not_found' || failure.code === 'not_found'
            ? { phase: 'missing' }
            : { phase: 'error', error: failure },
        );
      });
    return () => controller.abort();
  }, [id, attempt]);

  const back = <BackLink href={feedHref.offered} label="Back to Offered" />;
  if (load.phase === 'loading')
    return (
      <>
        {back}
        <SkeletonCards label="Loading the call" count={1} />
      </>
    );
  if (load.phase === 'missing')
    return (
      <>
        {back}
        <div className="fd-sheet">
          <Empty
            title="This call isn’t here"
            help="Only the owner of the agent that paid can see a call. Check that you’re signed in with that account."
          />
        </div>
      </>
    );
  if (load.phase === 'error')
    return (
      <>
        {back}
        <Banner
          tone="bad"
          title="This call couldn’t be loaded"
          action={
            <button type="button" className="fd-btn" onClick={() => setAttempt((v) => v + 1)}>
              <RefreshCw size={14} aria-hidden="true" />
              Try again
            </button>
          }
        >
          {refusalSentence(payFailure(load.error))}
        </Banner>
      </>
    );
  const call = load.value;
  const service = feedHref.service(call.service.id);
  return (
    <>
      {back}
      <section className="fd-sheet fd-detail" aria-labelledby="fd-ch">
        <DrawerHead
          id="fd-ch"
          mark={
            <span className="fp-mark" aria-hidden="true">
              <Wallet size={20} />
            </span>
          }
          eyebrow="Service call"
          title={plain(call.service.title) || call.service.host}
          sub={callPageSub(call)}
        />
        <div className="fd-d-body">
          <CallCard call={call} heading="The call" headingId="fd-ch-call" now={now} />
          <p className="fd-fine">
            <a className="fd-link" href={service} onClick={feedClick(service, { top: true })}>
              Open the service in the Feed
            </a>
          </p>
        </div>
      </section>
    </>
  );
}
