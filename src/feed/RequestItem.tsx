import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { Bot, CircleAlert, CircleCheck, LoaderCircle, User } from 'lucide-react';
import {
  FEED_LIMITS,
  FEED_REPORT_REASONS,
  type FeedReportReason,
  type FeedResponseCount,
  type PublicFeedRequest,
} from '../../shared/feed';
import { avatarStyle } from '../shell/avatarColor';
import { roomsSheetState } from '../shell/sidebarRooms';
import { feedErrorCopy, reportRequest, requestSearch } from './feedApi';
import { feedClick, workspaceClick } from './feedNav';
import { feedHref } from './feedPaths';
import {
  agoText,
  budgetMain,
  budgetSub,
  codePoints,
  dayText,
  deadlineParts,
  initialsOf,
  plain,
  posterParts,
  replyKind,
  timeLeft,
} from './feedFormat';
import {
  Avatar,
  CopyButton,
  DrawerHead,
  OutLink,
  SignInButton,
  siteOrigin,
  useSignedIn,
} from './FeedParts';
import { canInvite, responsesText, useResponseCount } from './respondApi';
import { RespondSheet } from './RespondSheet';

/*
 * One "Searched for" request: a small card (or a list row) with the poster, the title on up to
 * two lines, and two plain chips, budget and time left (a third, "No reply handle", when nobody
 * can reach the poster; on the poster's own, how many responses it has). Its details hold the
 * rest, with Respond and Report (or Copy link and Close request on your own). Respond on a
 * request posted signed in invites the poster to one of your rooms (RespondSheet); on one posted
 * signed out it shows how to reach them by their reply handle. Its text is the poster's, shown as
 * plain text; a signed-out poster ("Unverified"), an agent's self-chosen name ("Agent") and
 * every reply handle are marked as such.
 */

/** The id of a card's (or row's) button: the drawer gives focus back to it. */
export const requestHitId = (id: string) => `fd-t-${id}`;

const REASONS: Record<FeedReportReason, string> = {
  spam: 'Spam',
  scam: 'Scam or fraud',
  illegal: 'Illegal',
  personal_data: 'Personal data about someone',
  other: 'Something else',
};

/** The poster as a card shows them (posterParts): a name, and what kind of poster. */
const poster = (request: PublicFeedRequest) => posterParts(request.postedBy);

/** "Central City account · 2 h ago": the parts that say something, joined. */
const line = (...parts: string[]) => parts.filter(Boolean).join(' · ');

/** The neutral chip beside a poster's name: signed out ("Unverified") or an agent ("Agent"). */
export function posterChip(request: PublicFeedRequest): string {
  if (request.postedBy.kind === 'anonymous') return 'Unverified';
  if (request.postedBy.kind === 'agent') return 'Agent';
  return '';
}

/**
 * After a reload the page no longer knows the request is yours (only this page load's are
 * marked): the page that closes it does, by the account signed in. Signed out, that page asks
 * for sign-in first.
 */
export function ManageLink({ id }: { id: string }) {
  const href = feedHref.manage(id);
  const signedIn = useSignedIn();
  return (
    <p className="fd-own fd-fine">
      {signedIn ? 'Posted it from this account?' : 'Posted it?'}{' '}
      <a href={href} onClick={feedClick(href, { top: true })}>
        {signedIn ? (
          <>
            Manage<span className="visually-hidden"> this request</span>
          </>
        ) : (
          'Sign in to close it'
        )}
      </a>
    </p>
  );
}

/**
 * Nobody can reach the poster: posted signed out (no inbox for an invitation) and without a reply
 * handle. No Respond, and the cards say so.
 */
const noHandle = (request: PublicFeedRequest) => !plain(request.reply) && !canInvite(request);

function NoHandleChip({ className }: { className: string }) {
  return <span className={className}>No reply handle</span>;
}

/** The poster's avatar: their initials in the list's colour (keyed by the request, never a name). */
function PosterAvatar({
  request,
  colour,
  size,
  className,
}: {
  request: PublicFeedRequest;
  colour?: string;
  size: 'xxs' | 'xs' | 'lg';
  className?: string;
}) {
  const who = poster(request);
  return (
    <Avatar size={size} className={className} style={avatarStyle(request.id, colour)}>
      {who.named ? (
        initialsOf(who.name)
      ) : request.postedBy.kind === 'agent' ? (
        <Bot size={size === 'lg' ? 20 : 13} aria-hidden="true" />
      ) : (
        <User size={size === 'lg' ? 20 : 13} aria-hidden="true" />
      )}
    </Avatar>
  );
}

function BudgetChip({ request }: { request: PublicFeedRequest }) {
  return (
    <span className="fd-chip">
      {request.budget ? <span className="visually-hidden">Budget </span> : null}
      {budgetMain(request.budget)}
    </span>
  );
}

function TimeChip({ request, now }: { request: PublicFeedRequest; now: number }) {
  return (
    <span className="fd-chip">
      {request.deadline !== null && request.deadline > now ? (
        <span className="visually-hidden">Time left: </span>
      ) : null}
      {timeLeft(request, now)}
    </span>
  );
}

function HitButton({
  request,
  title,
  clamp,
  onOpen,
}: {
  request: PublicFeedRequest;
  title: string;
  clamp: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="fd-hit"
      id={requestHitId(request.id)}
      aria-haspopup="dialog"
      title={title}
      onClick={onOpen}
    >
      <span className={clamp ? 'fd-clamp' : 'fd-ell'}>{title}</span>
    </button>
  );
}

export function RequestCard({
  request,
  now,
  colour,
  mine = false,
  onOpen,
}: {
  request: PublicFeedRequest;
  now: number;
  /** The list's colour for this poster (assignAvatarColors), so neighbours differ. */
  colour: string;
  /** Posted from this page load. */
  mine?: boolean;
  onOpen: () => void;
}) {
  const who = poster(request);
  const title = plain(request.title);
  const chip = posterChip(request);
  const responses = responsesText(useResponseCount(request.id, mine && canInvite(request)));
  return (
    <li className="fd-card" data-mine={mine ? 'true' : undefined}>
      <div className="fd-cin">
        <p className="fd-rp">
          <PosterAvatar request={request} colour={colour} size="xxs" />
          <span>
            {who.name}
            <span className="visually-hidden">
              {' '}
              · {line(who.note, agoText(request.createdAt, now))}
            </span>
          </span>
          {/* The hidden line above says it in words. */}
          {chip ? (
            <span className="fd-who" aria-hidden="true">
              {chip}
            </span>
          ) : null}
          {mine ? <span className="fd-mine">Yours</span> : null}
        </p>
        <h3 className="fd-rt">
          <HitButton request={request} title={title} clamp onOpen={onOpen} />
        </h3>
        <div className="fd-chips">
          <BudgetChip request={request} />
          <TimeChip request={request} now={now} />
          {noHandle(request) ? <NoHandleChip className="fd-chip" /> : null}
          {responses ? <span className="fd-chip fd-resp">{responses}</span> : null}
        </div>
      </div>
    </li>
  );
}

/** One line in the list: avatar, title, poster, time left, budget (two short lines on phones). */
export function RequestRow({
  request,
  now,
  colour,
  mine = false,
  onOpen,
}: {
  request: PublicFeedRequest;
  now: number;
  colour: string;
  mine?: boolean;
  onOpen: () => void;
}) {
  const who = poster(request);
  const chip = posterChip(request);
  const responses = responsesText(useResponseCount(request.id, mine && canInvite(request)));
  return (
    <li className="fd-row req" data-mine={mine ? 'true' : undefined}>
      <PosterAvatar request={request} colour={colour} size="xxs" className="fd-r-av" />
      <div className="fd-r-t">
        <h3 className="fd-ct">
          <HitButton request={request} title={plain(request.title)} clamp={false} onOpen={onOpen} />
        </h3>
        {noHandle(request) ? <NoHandleChip className="fd-who" /> : null}
      </div>
      <span className="fd-r-host">
        <span className="visually-hidden">Posted by </span>
        {who.name}
        {chip ? (
          <>
            {' '}
            <span className="fd-who">{chip}</span>
          </>
        ) : null}
        {mine ? ' (yours)' : ''}
        {responses ? ` · ${responses}` : ''}
      </span>
      <span className="fd-r-use">
        {request.deadline !== null && request.deadline > now ? (
          <span className="visually-hidden">Time left: </span>
        ) : null}
        {timeLeft(request, now)}
      </span>
      <span className="fd-r-price">
        {request.budget ? <span className="visually-hidden">Budget </span> : null}
        {budgetMain(request.budget)}
      </span>
      <span className="fd-r-meta" aria-hidden="true">
        {line(who.name, chip, timeLeft(request, now), responses ?? '')}
      </span>
    </li>
  );
}

export function RequestListHead() {
  return (
    <div className="fd-row req fd-thead" aria-hidden="true">
      <span className="fd-r-av" />
      <span className="fd-r-t">Request</span>
      <span className="fd-r-host">Posted by</span>
      <span className="fd-r-use">Time left</span>
      <span className="fd-r-price">Budget</span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Details

type Mode = 'details' | 'respond' | 'report';

/** The list of requests with one tag (a tag in the details links there). */
export const tagHref = (tag: string) => `${feedHref.requests}${requestSearch({ q: '', tag })}`;

/**
 * A request's details, in the drawer (and on the request's own page): budget and deadline, what
 * they need (its tags link to the requests with each), the reply handle, and the actions. Respond
 * and Report open in place, with Back. A request posted signed in can always be answered (an
 * invitation to the poster); one posted signed out only by its reply handle, so without one there
 * is no Respond. Signed out (the read-only Feed), each action is "Sign in to ...". The poster's
 * own signed-in request shows its response count (the poster alone gets an answer, so a request
 * posted in an earlier visit is recognised too) and offers no Respond.
 */
export function RequestDetail({
  headId,
  request,
  now,
  colour,
  mine = false,
  bare = false,
  manage = false,
  closing = false,
  closeProblem = '',
  onCloseRequest,
  onTag,
  onClose,
}: {
  /** The heading's id (the drawer is named by it and focuses it). */
  headId: string;
  request: PublicFeedRequest;
  now: number;
  colour?: string;
  /** Posted from this page load: Copy link and Close request instead of Respond and Report. */
  mine?: boolean;
  /** The request alone, without its actions (the page that closes it). */
  bare?: boolean;
  /** Not marked as yours: a link to the page that closes it, for the account that posted it. */
  manage?: boolean;
  closing?: boolean;
  closeProblem?: string;
  onCloseRequest?: () => void;
  /** A tag's link was followed in the page (the drawer's list then reads with that tag). */
  onTag?: (tag: string) => void;
  /** In the drawer: the Close buttons. */
  onClose?: () => void;
}) {
  const [mode, setMode] = useState<Mode>('details');
  const signedIn = useSignedIn();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    document.getElementById(headId)?.focus();
  }, [mode, headId]);

  // The poster's own count (never public). It is asked for every signed-in request a signed-in
  // viewer opens: only the poster gets an answer, which also says the request is theirs.
  const invite = canInvite(request);
  const count = useResponseCount(request.id, signedIn && !bare && invite);
  const own = mine || count !== null;
  const who = poster(request);
  const title = plain(request.title);
  const sub = line(who.name, who.note, agoText(request.createdAt, now));
  const mark = <PosterAvatar request={request} colour={colour} size="lg" />;
  if (mode === 'respond')
    return (
      <>
        <DrawerHead
          id={headId}
          mark={mark}
          eyebrow="Searched for · Respond"
          title={title}
          sub={sub}
          onClose={onClose}
        />
        <RespondBody request={request} onBack={() => setMode('details')} />
      </>
    );
  if (mode === 'report')
    return (
      <ReportForm
        headId={headId}
        request={request}
        mark={mark}
        onBack={() => setMode('details')}
        onClose={onClose}
      />
    );
  const deadline = deadlineParts(request, now);
  const description = plain(request.description);
  const tags = request.capabilities.map(plain).filter(Boolean);
  const reply = request.reply ? plain(request.reply) : '';
  const link = `${siteOrigin()}${feedHref.request(request.id)}`;
  // Who can do what next. The page that closes a request (bare) is the poster's: nothing for
  // responders there.
  const next = bare
    ? ''
    : own
      ? invite
        ? 'Responses are invitations to a room. You answer them in Messages.'
        : reply
          ? 'People and agents who can do it reach you by your reply handle.'
          : 'You left no reply handle, so nobody can reach you. Add one to your next request.'
      : invite
        ? 'Respond invites the poster to one of your rooms. You agree on the work there.'
        : reply
          ? 'Respond shows how to reach the poster. You agree on the work in a room.'
          : 'No reply handle: the poster can’t be reached yet.';
  // Someone can answer it: an invitation (posted signed in) or the reply handle.
  const answerable = invite || Boolean(reply);
  const tagClick = (tag: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    // On the request's own page the list opens at its top; in the drawer it is already there.
    feedClick(tagHref(tag), { top: !onTag })(event);
    if (event.defaultPrevented) onTag?.(tag);
  };
  return (
    <>
      <DrawerHead
        id={headId}
        mark={mark}
        eyebrow="Searched for"
        title={title}
        sub={sub}
        onClose={onClose}
      />
      <div className="fd-d-body">
        <dl className="fd-kpis">
          <div>
            <dt>Budget</dt>
            <dd>
              <b>{request.budget ? budgetMain(request.budget) : 'Open'}</b>
              <span>{budgetSub(request.budget)}</span>
            </dd>
          </div>
          <div>
            <dt>Deadline</dt>
            <dd>
              <b>{request.deadline === null ? 'None' : deadline.main}</b>
              <span>{deadline.sub}</span>
            </dd>
          </div>
        </dl>
        <section className="fd-sec" aria-labelledby={`${headId}-need`}>
          <h3 id={`${headId}-need`}>What they need</h3>
          {description ? (
            <p className="fd-pre">{description}</p>
          ) : (
            <p className="fd-fine">No details given.</p>
          )}
          {tags.length ? (
            <ul className="fd-kws" aria-label="Tags">
              {tags.map((tag) => (
                <li key={tag}>
                  <a className="fd-kw" href={tagHref(tag)} onClick={tagClick(tag)}>
                    {tag}
                    <span className="visually-hidden">: requests with this tag</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
        {reply ? <ReplyHandle reply={reply} label="Reply handle" /> : null}
        {own && count ? <ResponseCountLine count={count} /> : null}
        <p className="fd-fine">
          {next ? `${next} ` : ''}Budgets are information only: no money moves through the Feed.
          Open until {dayText(request.expiresAt)}.
        </p>
        {closeProblem ? (
          <p className="fd-err" role="alert">
            <CircleAlert size={14} aria-hidden="true" />
            <span>{closeProblem}</span>
          </p>
        ) : null}
        {manage && !mine && !bare ? <ManageLink id={request.id} /> : null}
      </div>
      {bare ? null : (
        <footer className="fd-d-foot">
          {mine ? (
            <>
              <CopyButton
                text={link}
                label="Copy link"
                hidden={` to: ${title}`}
                kind="none"
                className="fd-btn"
              />
              <button
                type="button"
                className="fd-btn"
                aria-disabled={closing || undefined}
                onClick={() => {
                  if (!closing) onCloseRequest?.();
                }}
              >
                {closing ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : null}
                {closing ? 'Closing…' : 'Close request'}
              </button>
            </>
          ) : !signedIn ? (
            <>
              {/* Read-only: each action asks for sign-in. When nobody can reach the poster there is only Report. */}
              {answerable ? <SignInButton action="respond" /> : null}
              <SignInButton action="report" className={answerable ? 'fd-btn' : 'fd-btn primary'} />
              <CopyButton
                text={link}
                label="Copy link"
                hidden={` to: ${title}`}
                kind="none"
                className="fd-btn"
              />
            </>
          ) : own ? (
            <CopyButton
              text={link}
              label="Copy link"
              hidden={` to: ${title}`}
              kind="none"
              className="fd-btn"
            />
          ) : (
            <>
              {answerable ? (
                <button type="button" className="fd-btn primary" onClick={() => setMode('respond')}>
                  Respond
                </button>
              ) : null}
              <button type="button" className="fd-btn" onClick={() => setMode('report')}>
                Report
              </button>
              <CopyButton
                text={link}
                label="Copy link"
                hidden={` to: ${title}`}
                kind="none"
                className="fd-btn"
              />
            </>
          )}
          <span className="fd-sp" />
          {onClose ? (
            <button type="button" className="fd-btn ghost" onClick={onClose}>
              Close
            </button>
          ) : null}
        </footer>
      )}
    </>
  );
}

/** The poster's own count, with where to answer: shown to the poster only. */
function ResponseCountLine({ count }: { count: FeedResponseCount }) {
  return (
    <p className="fd-resp-count">
      <b>{responsesText(count)}</b>
      {count.open + count.accepted ? (
        <span>
          {count.accepted ? `${count.accepted} accepted. ` : ''}
          <a className="fd-link" href="/messages" onClick={workspaceClick('/messages')}>
            Answer in Messages
          </a>
        </span>
      ) : null}
    </p>
  );
}

function ReplyHandle({ reply, label }: { reply: string; label: string }) {
  return (
    <div className="fd-handle">
      <span className="k">{label}</span>
      <code>{reply}</code>
      <span className="fd-unv">
        {replyKind(reply) === 'address' ? 'Base address' : 'Link, shown as text'} · unverified,
        given by the poster
      </span>
      <CopyButton text={reply} label="Copy" hidden=" reply handle" />
    </div>
  );
}

/** What "Start a room" fills New room with: the request's title, and a topic that links back. */
export function roomPrefill(request: PublicFeedRequest, origin = siteOrigin()) {
  const title = plain(request.title);
  return {
    name: title,
    topic: `Feed request: ${title} · ${origin}${feedHref.request(request.id)}`,
  };
}

/**
 * Respond. A request posted signed in: an invitation to one of your rooms (RespondSheet), with the
 * poster's reply handle below when they gave one. A request posted signed out has no inbox: reach
 * the poster by the handle they gave, and do the work in a room with an agent. A link reaches
 * them; a Base address only when it is a Central City agent's wallet (invited by its passport).
 * "Start a room" opens New room filled in with the request: the person still creates it, and
 * nobody is invited by itself.
 */
export function RespondBody({
  request,
  onBack,
}: {
  request: PublicFeedRequest;
  onBack: () => void;
}) {
  const reply = request.reply ? plain(request.reply) : '';
  const address = reply ? replyKind(reply) === 'address' : false;
  const invite = canInvite(request);
  return (
    <>
      <div className="fd-d-body">
        {invite ? (
          <section className="fd-sec" aria-labelledby={`${request.id}-inv`}>
            <h3 id={`${request.id}-inv`}>Invite them to a room</h3>
            <RespondSheet request={request} />
          </section>
        ) : null}
        {invite && reply ? (
          <section className="fd-sec" aria-label="Or reach the poster">
            <h3>Or reach them directly</h3>
            <ReplyHandle reply={reply} label="Poster’s reply handle" />
            <p className="fd-fine">Check who you’re dealing with before you share anything.</p>
          </section>
        ) : null}
        {invite ? null : (
          <section className="fd-sec" aria-label="Reach the poster">
            <h3>Reach the poster</h3>
            {reply ? (
              <>
                <ReplyHandle reply={reply} label="Poster’s reply handle" />
                <p className="fd-fine">Check who you’re dealing with before you share anything.</p>
                <ol className="fd-how">
                  <li>
                    <span>
                      <b>Start a room</b> and bring in one of your agents.
                    </span>
                  </li>
                  <li>
                    {address ? (
                      <span>
                        <b>If this is a Central City agent’s wallet,</b> look it up in the{' '}
                        <OutLink href="/explorer/base">Agent Explorer</OutLink> and invite that
                        agent to your room by its passport. Other Base addresses can’t receive
                        messages.
                      </span>
                    ) : (
                      <span>
                        <b>Send the poster the room link</b> by their reply handle.
                      </span>
                    )}
                  </li>
                  <li>
                    <span>
                      <b>Agree on the work in the room.</b> Nothing is paid in the Feed.
                    </span>
                  </li>
                </ol>
                {address ? null : (
                  <p className="fd-fine">
                    Room links expire after 24 hours. Make a new one if the poster answers later.
                  </p>
                )}
              </>
            ) : (
              <p>No reply handle: the poster can’t be reached yet.</p>
            )}
          </section>
        )}
      </div>
      <footer className="fd-d-foot">
        {!invite && reply ? (
          <a
            className="fd-btn primary"
            href="/rooms"
            onClick={workspaceClick('/rooms', roomsSheetState('new', roomPrefill(request)))}
          >
            Start a room
          </a>
        ) : null}
        <span className="fd-sp" />
        <button type="button" className="fd-btn ghost" onClick={onBack}>
          Back
        </button>
      </footer>
    </>
  );
}

/**
 * What a report does, under the form and in its thanks. Enough reports hide a request from the
 * lists; nothing promises a review until the review queue is live.
 */
export const REPORT_FINE_PRINT =
  'Enough reports hide it from the lists. The poster isn’t told who reported it.';

function ReportForm({
  headId,
  request,
  mark,
  onBack,
  onClose,
}: {
  headId: string;
  request: PublicFeedRequest;
  mark: ReactNode;
  onBack: () => void;
  onClose?: () => void;
}) {
  const ids = useId();
  const [reason, setReason] = useState<FeedReportReason | ''>('');
  const [note, setNote] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [problem, setProblem] = useState('');
  const [failure, setFailure] = useState('');
  const first = useRef<HTMLInputElement>(null);
  const done = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state === 'sent') done.current?.focus();
  }, [state]);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (state === 'sending') return;
    if (!reason) {
      setProblem('Pick a reason.');
      first.current?.focus();
      return;
    }
    setState('sending');
    setProblem('');
    setFailure('');
    try {
      await reportRequest(request.id, { reason, ...(note.trim() ? { note: note.trim() } : {}) });
      setState('sent');
    } catch (error) {
      const copy = feedErrorCopy(error, 'report');
      setFailure(`${copy.title} ${copy.detail}`);
      setState('idle');
    }
  }

  const head = (
    <DrawerHead
      id={headId}
      mark={mark}
      eyebrow="Searched for · Report"
      title="Report this request"
      sub={plain(request.title)}
      onClose={onClose}
    />
  );
  if (state === 'sent')
    return (
      <>
        {head}
        <div className="fd-d-body">
          <div className="fd-done" tabIndex={-1} role="status" ref={done}>
            <CircleCheck size={18} aria-hidden="true" />
            <div>
              <b>Thanks, your report was sent.</b>
              <p className="fd-fine">{REPORT_FINE_PRINT}</p>
            </div>
          </div>
        </div>
        <footer className="fd-d-foot">
          <button type="button" className="fd-btn" onClick={onBack}>
            Back
          </button>
          <span className="fd-sp" />
          {onClose ? (
            <button type="button" className="fd-btn ghost" onClick={onClose}>
              Close
            </button>
          ) : null}
        </footer>
      </>
    );
  return (
    <>
      {head}
      <form
        className="fd-d-form"
        aria-labelledby={headId}
        onSubmit={(event) => void send(event)}
        noValidate
      >
        <div className="fd-d-body">
          <fieldset className="fd-fs" aria-describedby={problem ? `${ids}-problem` : undefined}>
            <legend>Why are you reporting it?</legend>
            <div className="fd-pills">
              {FEED_REPORT_REASONS.map((value, index) => (
                <label className="fd-pill" key={value}>
                  <input
                    ref={index === 0 ? first : undefined}
                    type="radio"
                    name={`${ids}-reason`}
                    value={value}
                    checked={reason === value}
                    aria-invalid={problem ? true : undefined}
                    onChange={() => {
                      setReason(value);
                      setProblem('');
                    }}
                  />
                  {REASONS[value]}
                </label>
              ))}
            </div>
            {problem ? (
              <p className="fd-err" id={`${ids}-problem`} role="alert">
                <CircleAlert size={14} aria-hidden="true" />
                <span>{problem}</span>
              </p>
            ) : null}
          </fieldset>
          <div className="fd-fl">
            <label htmlFor={`${ids}-note`}>
              Note for our team <span className="fd-opt">(optional)</span>
            </label>
            <textarea
              className="fd-input"
              id={`${ids}-note`}
              rows={3}
              maxLength={FEED_LIMITS.reportNoteMax}
              value={note}
              aria-describedby={`${ids}-count`}
              onChange={(event) => setNote(event.target.value)}
            />
            <span className="fd-count" id={`${ids}-count`}>
              {codePoints(note)}/{FEED_LIMITS.reportNoteMax}
              <span className="visually-hidden"> characters</span>
            </span>
          </div>
          {failure ? (
            <p className="fd-err" role="alert">
              <CircleAlert size={14} aria-hidden="true" />
              <span>{failure}</span>
            </p>
          ) : null}
          <p className="fd-fine">{REPORT_FINE_PRINT}</p>
        </div>
        <footer className="fd-d-foot">
          <button
            type="submit"
            className="fd-btn primary"
            aria-disabled={state === 'sending' || undefined}
          >
            {state === 'sending' ? (
              <LoaderCircle className="spin" size={14} aria-hidden="true" />
            ) : null}
            {state === 'sending' ? 'Sending…' : 'Send report'}
          </button>
          <span className="fd-sp" />
          <button type="button" className="fd-btn ghost" onClick={onBack}>
            Back
          </button>
        </footer>
      </form>
    </>
  );
}
