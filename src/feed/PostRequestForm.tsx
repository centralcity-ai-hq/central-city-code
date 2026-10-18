import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  Bot,
  Ban,
  CircleAlert,
  CircleCheck,
  Clock,
  LoaderCircle,
  TriangleAlert,
  User,
} from 'lucide-react';
import { FEED_LIMITS, type PostedFeedRequest } from '../../shared/feed';
import { listOwnAgents, searchOwnAgents } from '../rooms/api';
import { selectedWorkspaceId } from '../api';
import { isPagedWorkspace } from '../agents/agentPages';
import { useAgentPicker } from '../agents/useAgentPicker';
import { feedErrorCopy, FeedFailure, postKey, postRequest, type PostKey } from './feedApi';
import {
  codePoints,
  dayText,
  dayValue,
  DRAFT_ORDER,
  draftProblems,
  EMPTY_DRAFT,
  FIELD_LABELS,
  manageLink,
  plain,
  postedWithoutAccount,
  requestBody,
  type DraftField,
  type RequestDraft,
} from './feedFormat';
import { Banner, CopyButton, siteOrigin } from './FeedParts';

/*
 * "Post a request", inside the workspace: posted as the signed-in account or as one of its agents
 * (the server names the poster from the session, never from the form). The form checks what it
 * can before sending (the server checks again), lists every problem at the top, and maps each
 * refusal to plain words. Risky money requests are not refused here: the server holds them for
 * review and the page says "Your request is in review", without a reason.
 */

export interface PosterAgent {
  id: string;
  name: string;
}

/**
 * What one account may post (server/feed/requests.ts FEED_CAPS_DEFAULT postsPerOwnerHour and
 * postsPerOwnerDay; tests/feed-ui.test.ts keeps the two in step). The form is signed in, so the
 * signed-out caps per address (FEED_LIMITS.postsPerHour) are not the ones that apply.
 */
export const ACCOUNT_POST_CAPS = { perHour: 30, perDay: 100 } as const;

/** This site's own host: on a preview its links are refused as a reply handle (centralCityLink). */
const siteHost = () => (typeof window === 'undefined' ? '' : window.location.hostname);

/**
 * The agents a person may post as: the list Rooms uses to host or join as (listOwnAgents: the
 * workspace's live agents, never a revoked one and never the person's own Elric).
 */
export async function loadPosterAgents(signal?: AbortSignal): Promise<PosterAgent[]> {
  return (await listOwnAgents(signal)).map((agent) => ({
    id: agent.id,
    name: plain(agent.name) || 'Agent',
  }));
}

/**
 * The agents to post as that match `q`, over the whole workspace: only in a paged workspace, where
 * loadPosterAgents gives the newest page (src/agents/agentPages.ts); null elsewhere.
 */
export function posterAgentSearch():
  ((q: string, signal: AbortSignal) => Promise<PosterAgent[]>) | null {
  if (!isPagedWorkspace(selectedWorkspaceId())) return null;
  return async (q, signal) =>
    (await searchOwnAgents(q, signal)).map((agent) => ({
      id: agent.id,
      name: plain(agent.name) || 'Agent',
    }));
}

/** "12/100", read as "12 of 100 characters". */
function Counter({ id, used, max }: { id: string; used: number; max: number }) {
  return (
    <span className="fd-count" id={id}>
      {used}/{max}
      <span className="visually-hidden"> characters</span>
    </span>
  );
}

function Field({
  id,
  label,
  optional,
  hint,
  count,
  problem,
  children,
}: {
  id: string;
  label: string;
  optional?: string;
  hint?: ReactNode;
  count?: { used: number; max: number };
  problem?: string;
  children: ReactNode;
}) {
  return (
    <div className="fd-fl">
      <label htmlFor={id}>
        {label} {optional ? <span className="fd-opt">({optional})</span> : null}
      </label>
      {children}
      {problem ? (
        <p className="fd-err" id={`${id}-problem`}>
          <CircleAlert size={14} aria-hidden="true" />
          <span>{problem}</span>
        </p>
      ) : null}
      {hint || count ? (
        <div className="fd-hint-row">
          {hint ? (
            <p className="fd-hint" id={`${id}-hint`}>
              {hint}
            </p>
          ) : (
            <span />
          )}
          {count ? <Counter id={`${id}-count`} used={count.used} max={count.max} /> : null}
        </div>
      ) : null}
    </div>
  );
}

export function PostRequestForm({
  initialTitle = '',
  onPosted,
  onCancel,
}: {
  initialTitle?: string;
  /** `lapsed`: the form said "from your account", but the session had ended (not an account). */
  onPosted: (posted: PostedFeedRequest, lapsed: boolean) => void;
  onCancel: () => void;
}) {
  const ids = useId();
  const fieldId = (field: DraftField | 'postAs') => `${ids}-${field}`;
  const [draft, setDraft] = useState<RequestDraft>({ ...EMPTY_DRAFT, title: initialTitle });
  const [problems, setProblems] = useState<Partial<Record<DraftField, string>>>({});
  const [summary, setSummary] = useState(false);
  // Each refused submit moves focus to the summary once; typing a fix never takes it away.
  const [refusals, setRefusals] = useState(0);
  const [failure, setFailure] = useState<{ title: string; detail: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [agents, setAgents] = useState<PosterAgent[] | null>(null);
  const [agentsFailed, setAgentsFailed] = useState(false);
  const [agentsAttempt, setAgentsAttempt] = useState(0);
  // One key per request: a retry after a lost answer is the same request, never a second one;
  // a change to any field makes it a new request, with a new key (postKey).
  const key = useRef<PostKey | null>(null);
  const honeypot = useRef<HTMLInputElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const failureRef = useRef<HTMLDivElement>(null);
  const [now] = useState(() => Date.now());
  // A paged workspace lists its newest agents; any other is found with the search.
  const posters = useAgentPicker(agents, posterAgentSearch(), [draft.postAs], {
    label: 'Search all your agents',
    className: 'fd-agent-search',
  });

  useEffect(() => {
    document.getElementById(fieldId(initialTitle ? 'description' : 'title'))?.focus();
    // Once, when the form opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    loadPosterAgents(controller.signal).then(
      (list) => {
        setAgents(list);
        setAgentsFailed(false);
      },
      () => {
        if (controller.signal.aborted) return;
        setAgents([]);
        setAgentsFailed(true);
      },
    );
    return () => controller.abort();
  }, [agentsAttempt]);
  useEffect(() => {
    if (refusals) summaryRef.current?.focus();
  }, [refusals]);
  useEffect(() => {
    if (failure) failureRef.current?.focus();
  }, [failure]);

  const set = (field: keyof RequestDraft) => (value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    if (field !== 'postAs' && problems[field])
      setProblems((current) => ({ ...current, [field]: undefined }));
  };
  const described = (field: DraftField, extra: string[] = []) =>
    [
      problems[field] ? `${fieldId(field)}-problem` : '',
      ...extra.map((part) => `${fieldId(field)}-${part}`),
    ]
      .filter(Boolean)
      .join(' ') || undefined;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending) return;
    setFailure(null);
    const found = draftProblems(draft, Date.now(), siteHost());
    setProblems(found);
    if (DRAFT_ORDER.some((field) => found[field])) {
      setSummary(true);
      setRefusals((value) => value + 1);
      return;
    }
    setSummary(false);
    const website = honeypot.current?.value ?? '';
    setSending(true);
    const body = requestBody(draft, '', website);
    key.current = postKey(key.current, body);
    try {
      const posted = await postRequest({ ...body, idempotencyKey: key.current.key });
      key.current = null;
      onPosted(posted, postedWithoutAccount(draft.postAs, posted));
    } catch (error) {
      if (error instanceof FeedFailure && error.code === 'agent_not_found') {
        setDraft((current) => ({ ...current, postAs: '' }));
        setAgentsAttempt((value) => value + 1);
      }
      setFailure(feedErrorCopy(error, 'post'));
    } finally {
      setSending(false);
    }
  }

  const listed = DRAFT_ORDER.filter((field) => problems[field]);
  const postingAs = draft.postAs ? (posters.known.get(draft.postAs)?.name ?? 'your agent') : null;
  return (
    <section className="fd-sheet fd-post" aria-labelledby={`${ids}-heading`}>
      <div className="fd-post-head">
        <h2 id={`${ids}-heading`}>Post a request</h2>
        <p>Say what you need and how to reach you.</p>
      </div>
      <form
        className="fd-form"
        aria-labelledby={`${ids}-heading`}
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        {summary && listed.length ? (
          <div className="fd-errsum" tabIndex={-1} ref={summaryRef}>
            <b>Check {listed.length === 1 ? 'one field' : `${listed.length} fields`}</b>
            <ul>
              {listed.map((field) => (
                <li key={field}>
                  <a
                    href={`#${fieldId(field)}`}
                    onClick={(event) => {
                      event.preventDefault();
                      document.getElementById(fieldId(field))?.focus();
                    }}
                  >
                    {FIELD_LABELS[field].endsWith('?')
                      ? `${FIELD_LABELS[field]} ${problems[field]}`
                      : `${FIELD_LABELS[field]}: ${problems[field]}`}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {failure ? (
          <div className="fd-errsum" tabIndex={-1} ref={failureRef}>
            <b>{failure.title}</b>
            <span>{failure.detail}</span>
          </div>
        ) : null}
        <div className="fd-banner fd-public" data-tone="warn">
          <TriangleAlert size={16} aria-hidden="true" />
          <div>
            <b>Everything here is public.</b>
            <p>Don’t include emails, phone numbers, keys or recovery phrases.</p>
          </div>
        </div>
        <Field
          id={fieldId('title')}
          label={FIELD_LABELS.title}
          hint="5 to 100 characters, no links."
          count={{ used: codePoints(draft.title), max: FEED_LIMITS.requestTitleMax }}
          problem={problems.title}
        >
          <input
            className="fd-input"
            id={fieldId('title')}
            type="text"
            value={draft.title}
            maxLength={FEED_LIMITS.requestTitleMax}
            autoComplete="off"
            placeholder="For example: extract text from 40 scanned PDFs"
            aria-invalid={problems.title ? true : undefined}
            aria-describedby={described('title', ['hint', 'count'])}
            onChange={(event) => set('title')(event.target.value)}
          />
        </Field>
        <Field
          id={fieldId('description')}
          label={FIELD_LABELS.description}
          hint="Up to 2 https links. No personal data about other people."
          count={{ used: codePoints(draft.description), max: FEED_LIMITS.requestDescriptionMax }}
          problem={problems.description}
        >
          <textarea
            className="fd-input"
            id={fieldId('description')}
            rows={5}
            value={draft.description}
            maxLength={FEED_LIMITS.requestDescriptionMax}
            placeholder="What you’ll provide, what you want back, and how you’ll check it."
            aria-invalid={problems.description ? true : undefined}
            aria-describedby={described('description', ['hint', 'count'])}
            onChange={(event) => set('description')(event.target.value)}
          />
        </Field>
        <div className="fd-row2">
          <Field
            id={fieldId('budget')}
            label={FIELD_LABELS.budget}
            optional="optional"
            hint="In total, in USDC on Base. Information only: no money moves through the Feed."
            problem={problems.budget}
          >
            <div className="fd-suffix">
              <input
                className="fd-input"
                id={fieldId('budget')}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={draft.budget}
                aria-invalid={problems.budget ? true : undefined}
                aria-describedby={described('budget', ['hint'])}
                onChange={(event) => set('budget')(event.target.value)}
              />
              <span aria-hidden="true">USDC</span>
            </div>
          </Field>
          <Field
            id={fieldId('deadline')}
            label={FIELD_LABELS.deadline}
            optional="optional"
            hint="The request closes on that day. Without one, it closes after 14 days."
            problem={problems.deadline}
          >
            <input
              className="fd-input"
              id={fieldId('deadline')}
              type="date"
              value={draft.deadline}
              min={dayValue(now)}
              max={dayValue(now + FEED_LIMITS.requestTtlMaxMs - 86_400_000)}
              aria-invalid={problems.deadline ? true : undefined}
              aria-describedby={described('deadline', ['hint'])}
              onChange={(event) => set('deadline')(event.target.value)}
            />
          </Field>
        </div>
        <div className="fd-row2">
          <Field
            id={fieldId('tags')}
            label={FIELD_LABELS.tags}
            optional="optional"
            hint="Up to 5, separated by commas."
            problem={problems.tags}
          >
            <input
              className="fd-input"
              id={fieldId('tags')}
              type="text"
              value={draft.tags}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="pdf, ocr"
              aria-invalid={problems.tags ? true : undefined}
              aria-describedby={described('tags', ['hint'])}
              onChange={(event) => set('tags')(event.target.value)}
            />
          </Field>
          <div className="fd-fl">
            <label htmlFor={fieldId('postAs')}>Post as</label>
            <select
              className="fd-input"
              id={fieldId('postAs')}
              value={draft.postAs}
              aria-describedby={`${fieldId('postAs')}-hint`}
              onChange={(event) => set('postAs')(event.target.value)}
            >
              <option value="">Me (no name shown)</option>
              {(posters.agents ?? []).map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
            {posters.field}
            <div className="fd-hint-row">
              <p className="fd-hint" id={`${fieldId('postAs')}-hint`}>
                {agentsFailed ? (
                  <>
                    Your agents couldn’t be loaded.{' '}
                    <button
                      type="button"
                      className="fd-link"
                      onClick={() => setAgentsAttempt((value) => value + 1)}
                    >
                      Try again
                    </button>
                  </>
                ) : (
                  'Posted from your account without your name. An agent posts under its own name.'
                )}
              </p>
            </div>
          </div>
        </div>
        <Field
          id={fieldId('reply')}
          label={FIELD_LABELS.reply}
          optional="optional, public"
          hint="A Base address or an https link, shown on your request as unverified. Without one, nobody can reach you."
          problem={problems.reply}
        >
          <input
            className="fd-input"
            id={fieldId('reply')}
            type="text"
            value={draft.reply}
            maxLength={FEED_LIMITS.replyMax}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="0x… or https://…"
            aria-invalid={problems.reply ? true : undefined}
            aria-describedby={described('reply', ['hint'])}
            onChange={(event) => set('reply')(event.target.value)}
          />
        </Field>
        {/* For automated posting only: people never see or fill this field. */}
        <div className="fd-hp" aria-hidden="true">
          <label htmlFor={`${ids}-website`}>Leave this empty</label>
          <input
            ref={honeypot}
            id={`${ids}-website`}
            name="website"
            type="text"
            tabIndex={-1}
            autoComplete="off"
            defaultValue=""
          />
        </div>
        <ul className="fd-rules">
          <li>
            {postingAs ? (
              <Bot size={14} aria-hidden="true" />
            ) : (
              <User size={14} aria-hidden="true" />
            )}
            <span>
              <b>
                {postingAs ? `Posted as ${postingAs}, your agent.` : 'Posted from your account.'}
              </b>{' '}
              After posting you get a private link that closes the request.
            </span>
          </li>
          <li>
            <Ban size={14} aria-hidden="true" />
            <span>
              <b>Not listed:</b> requests to move money, such as gift or prepaid cards, gold,
              transfers or yield. Anyone can report a request.
            </span>
          </li>
        </ul>
        <div className="fd-form-actions">
          <button type="submit" className="button primary" aria-disabled={sending || undefined}>
            {sending ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : null}
            {sending ? 'Posting…' : 'Post request'}
          </button>
          <button type="button" className="button secondary" onClick={onCancel}>
            Cancel
          </button>
          <span className="fd-muted">
            Up to {ACCOUNT_POST_CAPS.perHour} requests an hour and {ACCOUNT_POST_CAPS.perDay} a day.
          </span>
        </div>
      </form>
    </section>
  );
}

/** After posting: live or in review, and the private link that closes it, shown once. */
export function PostedCard({
  posted,
  lapsed = false,
  onSee,
  onAnother,
}: {
  posted: PostedFeedRequest;
  /** Posted without the account the form named: the session had ended (postedWithoutAccount). */
  lapsed?: boolean;
  onSee: () => void;
  onAnother: () => void;
}) {
  const ids = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const held = posted.request.status !== 'open';
  const title = plain(posted.request.title);
  const link = manageLink(siteOrigin(), posted.request.id, posted.manageToken);
  return (
    <section className="fd-sheet fd-post" aria-labelledby={`${ids}-h`}>
      <div className="fd-ok-head" data-held={held ? 'true' : undefined}>
        {held ? (
          <Clock size={22} aria-hidden="true" />
        ) : (
          <CircleCheck size={22} aria-hidden="true" />
        )}
        <h2 id={`${ids}-h`} tabIndex={-1} ref={heading}>
          {held ? 'Your request is in review' : 'Your request is live'}
        </h2>
      </div>
      <p>
        {held
          ? `“${title}” is in review and isn’t listed in Searched for. A request still in review after 7 days is deleted.`
          : `“${title}” is in Searched for now, open until ${dayText(posted.request.expiresAt)}.`}
      </p>
      {lapsed ? (
        <Banner tone="warn" title="You were signed out, so it wasn’t posted from your account">
          Only your private link can close it. Sign in again before you post more.
        </Banner>
      ) : null}
      <div className="fd-closecode">
        <span>Your private link</span>
        <code className="fd-mono">{link}</code>
        <CopyButton text={link} label="Copy" hidden=" your private link" />
      </div>
      <p className="fd-muted">
        Shown once. Anyone with this link can close the request, so keep it to yourself.
      </p>
      <div className="fd-d-actions">
        {held ? null : (
          <button type="button" className="fd-btn primary" onClick={onSee}>
            See your request
          </button>
        )}
        <button type="button" className="fd-btn" onClick={onAnother}>
          Post another
        </button>
      </div>
    </section>
  );
}
