import { useEffect, useId, useRef, useState } from 'react';
import { Ban, CircleCheck, Clock } from 'lucide-react';
import {
  FEED_HOSTED_SOURCE,
  FEED_LIMITS,
  type FeedField,
  type FeedSchemaSummary,
  type FeedService,
  type FeedUsage,
} from '../../shared/feed';
import { avatarStyle } from '../shell/avatarColor';
import { avatarKeyOf } from './avatarKey';
import { NO_OFFERED_FILTERS, offeredSearch } from './feedApi';
import { feedHref } from './feedPaths';
import { askFeedSignInAgain, SIGN_IN_LABEL } from './feedSignIn';
import {
  agoText,
  countMissing,
  dayText,
  EXTERNAL_LABEL,
  fieldMeta,
  fieldsHeadNote,
  initialOf,
  ioWords,
  number,
  plain,
  priceMain,
  priceRule,
  shownDescription,
  staleHours,
  useFact,
  usesShort,
  useSub,
  utcText,
  utcTime,
} from './feedFormat';
import {
  Avatar,
  CopyButton,
  CreditLink,
  DrawerHead,
  siteOrigin,
  SourceBadge,
  useSignedIn,
} from './FeedParts';
import { sheetWanted } from './pay/openPayments';
import { listingPayState, notPayableText, OWN_SETUP_TITLE } from './pay/payModel';
import { UseSheet } from './pay/UseSheet';
import { usePayAccess, type PayAccess } from './pay/usePayAccess';

/*
 * One Offered service: a small card (or a list row) and its details. A card holds the avatar,
 * the title, the site, price and uses, and the small "x402 Bazaar" credit; the title is a button
 * stretched over the card, so the whole card opens the details. An external service, never a
 * Central City agent: no agent Pay, no Rate, no passport, never Central City blue. Provider text
 * is plain text only; the raw examples wait under a closed disclosure. While Feed pay is on for
 * the person (docs/FEED_PAY.md), a payable listing has "Use with my agent": one of their own
 * agents pays it from its own wallet after one confirm (src/feed/pay).
 */

/** Offered, filtered to one host (/feed?host=…). */
export const hostHref = (host: string) =>
  `${feedHref.offered}${offeredSearch({ ...NO_OFFERED_FILTERS, host })}`;

/** The id of a card's (or row's) button: the drawer gives focus back to it. */
export const serviceHitId = (id: string) => `fd-t-${id}`;

/**
 * Limits every listing has (the listing's own words come first, in its description). While Feed
 * pay is on for the person, Central City may have called the service for them, and the price is
 * the live one they confirm: the words say so (docs/FEED_PAY.md section 12).
 */
const LIMITS = [
  'Central City hasn’t called this service. Results, uptime and refunds are up to the service.',
  'The price is as listed. The service’s payment request at call time sets what is paid.',
];
const LIMITS_PAY_ON = [
  'Central City doesn’t check results, uptime or refunds. They are up to the service.',
  'The listed price can change. The service’s payment request at call time sets its price, and you see what your agent pays before you confirm.',
];

function PriceText({ service }: { service: FeedService }) {
  return (
    <>
      {priceMain(service.price)}
      {service.price ? <span className="visually-hidden"> per call</span> : null}
    </>
  );
}

/** No paid use reported, and none ever made: "New". */
const isNew = (usage: FeedUsage) => usage.paidCalls30d === 0 && !usage.lastCalledAt;

/** The source gives a 30-day count that can be used (0 included; countMissing). */
const counted = (usage: FeedUsage, now: number) => !countMissing(usage, now);

function UsesText({ service }: { service: FeedService }) {
  const usage = service.usage;
  const fresh = isNew(usage);
  const now = Date.now();
  return (
    <span className="fd-uses" data-new={fresh ? 'true' : undefined}>
      {usesShort(usage, now)}
      <span className="visually-hidden">
        {fresh
          ? ': no paid uses reported yet'
          : counted(usage, now)
            ? ` in the last 30 days, reported by ${usage.reportedBy}`
            : `: ${useSub(usage, now)}`}
      </span>
    </span>
  );
}

function HitButton({
  service,
  title,
  onOpen,
}: {
  service: FeedService;
  title: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="fd-hit"
      id={serviceHitId(service.id)}
      aria-haspopup="dialog"
      title={title}
      onClick={onOpen}
    >
      <span className="fd-ell">{title}</span>
    </button>
  );
}

export function ServiceCard({
  service,
  title,
  colour,
  onOpen,
}: {
  service: FeedService;
  /** The title the list shows (shownTitles: a repeated title gets its address's last part). */
  title: string;
  /** The list's colour for this host (assignAvatarColors), so neighbours differ. */
  colour: string;
  onOpen: () => void;
}) {
  return (
    <li className="fd-card" data-kind={service.kind}>
      <div className="fd-cin">
        <div className="fd-ch">
          <Avatar style={avatarStyle(avatarKeyOf(service), colour)}>{initialOf(service)}</Avatar>
          <h3 className="fd-ct">
            <HitButton service={service} title={title} onOpen={onOpen} />
          </h3>
          <p className="fd-meta">{service.provider.host}</p>
        </div>
        <div className="fd-cf">
          <span className="fd-cprice">
            <PriceText service={service} />
          </span>
          <UsesText service={service} />
          <SourceBadge source={service.source} />
        </div>
      </div>
    </li>
  );
}

/** One line in the list: avatar, title, site, uses, price (two short lines on phones). */
export function ServiceRow({
  service,
  title,
  colour,
  onOpen,
}: {
  service: FeedService;
  title: string;
  colour: string;
  onOpen: () => void;
}) {
  return (
    <li className="fd-row svc" data-kind={service.kind}>
      <Avatar size="xxs" className="fd-r-av" style={avatarStyle(avatarKeyOf(service), colour)}>
        {initialOf(service)}
      </Avatar>
      <div className="fd-r-t">
        <h3 className="fd-ct">
          <HitButton service={service} title={title} onOpen={onOpen} />
        </h3>
      </div>
      <span className="fd-r-host">{service.provider.host}</span>
      <span className="fd-r-use">
        <UsesText service={service} />
      </span>
      <span className="fd-r-price">
        <PriceText service={service} />
      </span>
      <span className="fd-r-meta" aria-hidden="true">
        {service.provider.host} · {usesShort(service.usage)}
      </span>
    </li>
  );
}

/** The list's column heads, for sighted readers (each row names its own parts). */
export function ServiceListHead() {
  return (
    <div className="fd-row svc fd-thead" aria-hidden="true">
      <span className="fd-r-av" />
      <span className="fd-r-t">Service</span>
      <span className="fd-r-host">Site</span>
      <span className="fd-r-use">Uses</span>
      <span className="fd-r-price">Price</span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Details

function Fields({ fields, more, empty }: { fields: FeedField[]; more: number; empty: string }) {
  if (!fields.length) return <p className="fd-fine">{empty}</p>;
  return (
    <ul className="fd-fields">
      {fields.map((field) => (
        <li key={`${field.in ?? 'out'}:${field.name}`}>
          <code>{plain(field.name)}</code>
          <span className="r" data-req={field.required ? 'true' : undefined}>
            {field.required ? 'Required' : 'Optional'}
          </span>
          <p className="fd-f-meta">
            {fieldMeta(field)}
            {/* A header's description can carry a credential's format: the name only. */}
            {field.description && field.in !== 'header' ? ` · ${plain(field.description)}` : ''}
          </p>
        </li>
      ))}
      {more > 0 ? (
        <li>
          <span className="fd-f-more">
            {number.format(more)} more {more === 1 ? 'field' : 'fields'}, not shown
          </span>
        </li>
      ) : null}
    </ul>
  );
}

/**
 * A raw example, as listed: JSON is laid out on several lines (the listing keeps it on one), but
 * only when that changes nothing but the layout. Read back, some JSON would print differently
 * (1e21 as 1e+21, a long id rounded, 1.50 as 1.5): that is shown as listed. One the source cut
 * at its limit (server/feed/bazaar.ts cut, which also drops a trailing space, so one short of it
 * counts) is no longer JSON, and says it was cut.
 */
export function exampleText(text: string): { text: string; cut: boolean } {
  const listed = text.trim();
  let value: unknown;
  try {
    value = JSON.parse(listed);
  } catch {
    return { text, cut: Array.from(text).length >= FEED_LIMITS.exampleMax - 1 };
  }
  return JSON.stringify(value) === listed
    ? { text: JSON.stringify(value, null, 2), cut: false }
    : { text, cut: false };
}

function Example({ label, text }: { label: string; text: string }) {
  const id = useId();
  const shown = exampleText(text);
  return (
    <figure className="fd-ex">
      <figcaption id={id}>{label}</figcaption>
      <pre className="fd-code" tabIndex={0} aria-labelledby={id}>
        {shown.text}
      </pre>
      {shown.cut ? (
        <p className="fd-fine">
          Cut at {number.format(FEED_LIMITS.exampleMax)} characters, so it ends early.
        </p>
      ) : null}
    </figure>
  );
}

function FieldPreview({
  fields,
  more,
  output = false,
}: {
  fields: FeedField[];
  more: number;
  output?: boolean;
}) {
  if (!fields.length)
    return (
      <p className="fd-fine">
        {output ? 'The listing describes no result.' : 'The listing describes no fields.'}
      </p>
    );
  return (
    <ul className="fd-service-fields">
      {fields.map((field) => (
        <li key={field.name}>
          <code>{plain(field.name)}</code>
          <span>
            {[plain(field.type), output ? '' : field.required ? 'required' : 'optional']
              .filter(Boolean)
              .join(' · ')}
          </span>
        </li>
      ))}
      {more > 0 ? (
        <li className="fd-fine">{number.format(more)} more fields in the listing</li>
      ) : null}
    </ul>
  );
}

function statusFact(service: FeedService, now: number) {
  if (service.status === 'stale')
    return (
      <>
        <span className="fd-state" data-state="stale">
          <Clock size={14} aria-hidden="true" />
          Not confirmed for {staleHours(service.lastSeenAt, now)} h
        </span>
        <span className="fd-fine">
          Missing from the last reads because x402 Bazaar did not answer. Still listed, with this
          label.
        </span>
      </>
    );
  if (service.status === 'withdrawn')
    return (
      <>
        <span className="fd-state" data-state="withdrawn">
          <Ban size={14} aria-hidden="true" />
          No longer listed
        </span>
        <span className="fd-fine">
          x402 Bazaar stopped listing it on {dayText(service.lastSeenAt)}. This page stays until{' '}
          {dayText(service.lastSeenAt + FEED_LIMITS.tombstoneMs)}.
        </span>
      </>
    );
  return (
    <>
      <span className="fd-state" data-state="active">
        <CircleCheck size={14} aria-hidden="true" />
        Active
      </span>
      <span className="fd-fine">In the latest full read of x402 Bazaar</span>
    </>
  );
}

function summaryOf(summary: FeedSchemaSummary | null) {
  return summary ?? { format: null, fields: [], more: 0, example: null, exampleState: null };
}

const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** The details' head: the same avatar as the card, the title, the listing's name and host. */
export function ServiceHead({
  id,
  service,
  title,
  colour,
  onClose,
}: {
  id: string;
  service: FeedService;
  title: string;
  colour?: string;
  onClose?: () => void;
}) {
  return (
    <DrawerHead
      id={id}
      mark={
        <Avatar size="lg" style={avatarStyle(avatarKeyOf(service), colour)}>
          {initialOf(service)}
        </Avatar>
      }
      className="fd-service-head"
      title={title}
      sub={service.provider.host}
      onClose={onClose}
    />
  );
}

/** The id of "Use with my agent": focus comes back to it from the use sheet. */
export const useButtonId = (id: string) => `fp-use-${id}`;

/**
 * The drawer's actions. Feed pay on for the person and a payable listing: Use with my agent
 * first. Not payable as listed: why, and Copy service address first. Signed out: Sign in to use
 * it. Off, not allowed, not known yet or withdrawn: Copy service address and Copy link, as
 * before. "Open service" is gone: a browser can't call a POST service, and it only ever answered
 * Payment Required.
 */
export function ServiceActions({
  service,
  access,
  onUse,
}: {
  service: FeedService;
  access: PayAccess;
  onUse: () => void;
  onClose?: () => void;
}) {
  const ids = useId();
  const link = `${siteOrigin()}${feedHref.service(service.id)}`;
  const listing = listingPayState(service);
  const on = access.phase === 'on';
  const payable = on && listing.kind === 'payable';
  const ownSetup = on && listing.kind === 'own_setup' ? listing.reason : null;
  // The session lapsed while the page showed it signed in: said, and sign-in comes first.
  const signIn = access.phase === 'signed_out' && listing.kind === 'payable';
  return (
    <footer className="fd-d-foot fd-service-foot">
      {ownSetup ? (
        <p className="fd-fine fd-foot-note fp-setup" id={`${ids}-s`}>
          <b>{OWN_SETUP_TITLE}</b> {notPayableText(ownSetup)}
        </p>
      ) : null}
      {signIn ? (
        <p className="fd-fine fd-foot-note fp-setup" id={`${ids}-o`}>
          <b>You were signed out.</b> Sign in again to use it with your agent.
        </p>
      ) : null}
      {signIn ? (
        <button
          type="button"
          className="fd-btn primary"
          aria-describedby={`${ids}-o`}
          onClick={() => askFeedSignInAgain('use')}
        >
          {SIGN_IN_LABEL.use}
        </button>
      ) : null}
      {payable ? (
        <button
          type="button"
          id={useButtonId(service.id)}
          className="fd-btn primary"
          onClick={onUse}
        >
          Use with my agent
        </button>
      ) : null}
      <CopyButton
        text={service.url}
        label="Copy service address"
        kind={payable || signIn ? 'text' : 'none'}
        iconOnly={payable || signIn}
        className={payable || signIn ? 'fd-btn' : 'fd-btn primary'}
      />
      <CopyButton
        text={link}
        label="Copy link"
        hidden=" to this service"
        kind="link"
        iconOnly
        className="fd-btn"
      />
    </footer>
  );
}

/**
 * Everything a card leaves out, in the drawer (and on the service's own page): the full label,
 * price and uses, what it does, input and output in words with the fields and the raw examples,
 * who runs it, source and freshness, how to use it, limitations, then the actions
 * (ServiceActions). Use with my agent opens the use sheet in place of the details.
 */
export function ServiceDetail({
  service,
  now,
  hostFiltered = false,
  onHost,
  onClose,
}: {
  service: FeedService;
  now: number;
  /** The list behind is this site's own (?host=): it shows every service of it, page by page. */
  hostFiltered?: boolean;
  /** "All services from this site": every service of the host, without the search. */
  onHost?: (host: string) => void;
  /** In the drawer: a Close button at the end. */
  onClose?: () => void;
}) {
  const ids = useId();
  // Signed out (the read-only Feed), today's drawer: whether pay is on is the person's own setting.
  const signedIn = useSignedIn();
  const read = usePayAccess(signedIn);
  const access: PayAccess = signedIn ? read : { phase: 'unknown' };
  // A payment that may have started, or a sheet that left for the agent's wallet: the sheet
  // shows again (src/feed/pay/openPayments.ts).
  const [using, setUsing] = useState(() => sheetWanted(service.id));
  // The sheet stays while it is open, even when a read says paying is off now or the session
  // lapsed: it says so itself (with sign-in), and Back shows the details as they are now.
  const lastOn = useRef<Extract<PayAccess, { phase: 'on' }> | null>(null);
  if (access.phase === 'on') lastOn.current = access;
  const sheetAccess = access.phase === 'on' ? access : signedIn ? lastOn.current : null;
  const wasUsing = useRef(false);
  useEffect(() => {
    // Back from the use sheet: focus returns to the button that opened it.
    if (!using && wasUsing.current) document.getElementById(useButtonId(service.id))?.focus();
    wasUsing.current = using;
  }, [using, service.id]);
  const input = summaryOf(service.input);
  const output = summaryOf(service.output);
  const description = shownDescription(service.description);
  const tags = service.capabilities.map(plain).filter(Boolean).slice(0, FEED_LIMITS.tagsMax);
  const usage = service.usage;
  const calls = usage.paidCalls30d;
  const host = service.provider.host;
  const head = (key: string) => `${ids}-${key}`;
  const counts = calls !== null && calls > 0;
  const payOn = access.phase === 'on' && listingPayState(service).kind === 'payable';
  if (using && sheetAccess)
    return (
      <UseSheet
        service={service}
        access={sheetAccess}
        onBack={() => setUsing(false)}
        {...(onClose ? { onClose } : {})}
      />
    );
  return (
    <>
      <div className="fd-d-body fd-service-body">
        <div className="fd-service-chips">
          <span
            className="fd-service-chip"
            data-hosted={service.source.name === FEED_HOSTED_SOURCE.name || undefined}
          >
            {service.source.name === FEED_HOSTED_SOURCE.name
              ? 'Central City agent'
              : 'External · x402 Bazaar'}
          </span>
          <span className="fd-service-chip">USDC on Base</span>
        </div>
        <dl className="fd-service-stats">
          <div>
            <dt>{service.price ? 'per call' : 'price'}</dt>
            <dd>{priceMain(service.price)}</dd>
          </div>
          <div>
            <dt>uses, 30 days</dt>
            <dd>{counts ? number.format(calls) : usesShort(usage, now)}</dd>
          </div>
          <div>
            <dt>payers</dt>
            <dd>
              {usage.payers30d !== null && usage.payers30d >= 0
                ? number.format(usage.payers30d)
                : 'Not reported'}
            </dd>
          </div>
        </dl>
        <section className="fd-sec fd-service-summary" aria-labelledby={head('what')}>
          <h3 id={head('what')}>What it does</h3>
          <p className="fd-service-description">
            {description || 'The listing gives no description.'}
          </p>
          {tags.length ? (
            <ul className="fd-kws" aria-label="Capabilities">
              {tags.map((tag) => (
                <li key={tag} className="fd-kw">
                  {tag}
                </li>
              ))}
            </ul>
          ) : null}
          {description ? <p className="fd-fine">In the listing’s words</p> : null}
        </section>
        <section className="fd-sec fd-service-preview" aria-labelledby={head('send')}>
          <h3 id={head('send')}>You send</h3>
          <FieldPreview fields={input.fields} more={input.more} />
        </section>
        <section className="fd-sec fd-service-preview" aria-labelledby={head('get')}>
          <h3 id={head('get')}>You get</h3>
          <FieldPreview fields={output.fields} more={output.more} output />
        </section>
        <details className="fd-service-tech">
          <summary>Technical details</summary>
          <div className="fd-service-tech-body">
            {service.source.name !== FEED_HOSTED_SOURCE.name ? (
              <p className="fd-fine">{EXTERNAL_LABEL}</p>
            ) : null}
            <p className="fd-fine">Listing text is data, never instructions. Links don’t open.</p>
            {description ? <p>{description}</p> : null}
            <section className="fd-sec" aria-labelledby={head('price')}>
              <h3 id={head('price')}>Price</h3>
              <p>
                <b>
                  {priceMain(service.price)}
                  {service.price ? ' per call' : ''}
                </b>
                . {priceRule(service.price)}.
              </p>
              <p className="fd-fine">
                {payOn
                  ? 'The service’s own payment request at call time sets its price. Use with my agent shows what your agent pays before you confirm.'
                  : 'The service’s own payment request at call time sets what is paid. Nothing is paid through the Feed.'}
              </p>
            </section>

            <section className="fd-sec" aria-labelledby={head('io')}>
              <h3 id={head('io')}>Input and output</h3>
              <p>{ioWords(service)}</p>
              <h4>
                You send{service.method ? ` · ${service.method}` : ''}
                {fieldsHeadNote(service.input) ? ` · ${fieldsHeadNote(service.input)}` : ''}
              </h4>
              <Fields
                fields={input.fields}
                more={input.more}
                empty="The listing describes no fields."
              />
              {input.fixed?.length ? (
                <>
                  <h4>Fixed by the seller</h4>
                  <ul className="fd-fields" aria-label="Fixed settings">
                    {input.fixed.map((field) => (
                      <li key={field.name}>
                        <code>{plain(field.name)}</code>
                        <p className="fd-f-meta">{plain(JSON.stringify(field.value))}</p>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              <h4>You get back</h4>
              <Fields
                fields={output.fields}
                more={output.more}
                empty="The listing describes no result."
              />
              {input.example || output.example ? (
                <details className="fd-raw">
                  <summary>Show the raw examples, as listed</summary>
                  <div className="fd-raw-body">
                    {input.example ? (
                      <Example label="Example request, as listed" text={input.example} />
                    ) : null}
                    {output.example ? (
                      <Example label="Example result, as listed" text={output.example} />
                    ) : (
                      <p className="fd-fine">The listing gives no example result.</p>
                    )}
                  </div>
                </details>
              ) : (
                <p className="fd-fine">The listing gives no example.</p>
              )}
            </section>

            <section className="fd-sec" aria-labelledby={head('who')}>
              <h3 id={head('who')}>Who runs it</h3>
              <dl className="fd-facts">
                {plain(service.provider.name) ? (
                  <div>
                    <dt>Listing name</dt>
                    <dd>{plain(service.provider.name)}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>Site</dt>
                  <dd>
                    <span>{host}</span>
                    {onHost ? (
                      <button type="button" className="fd-link" onClick={() => onHost(host)}>
                        All services from this site
                      </button>
                    ) : null}
                    {service.moreFromHost > 0 && !hostFiltered ? (
                      <span className="fd-fine">
                        {/* A Central City row counts per seller wallet: the same agent. */}
                        {`${number.format(service.moreFromHost)} more from this ${
                          service.source.name === FEED_HOSTED_SOURCE.name ? 'agent' : 'site'
                        }`}
                      </span>
                    ) : null}
                  </dd>
                </div>
                <div>
                  <dt>Service address</dt>
                  <dd>
                    <code>{[service.method, service.url].filter(Boolean).join(' ')}</code>
                    <span className="fd-fine">
                      Shown as text. It answers with a payment request.
                    </span>
                  </dd>
                </div>
                {service.payTo ? (
                  <div>
                    <dt>Paid to</dt>
                    <dd>
                      <code title={service.payTo}>{shortAddress(service.payTo)}</code>
                      <span className="fd-fine">
                        The address the service asks to be paid at in its payment request. Sending
                        USDC to it directly does not pay for a call.
                      </span>
                    </dd>
                  </div>
                ) : null}
              </dl>
            </section>

            <section className="fd-sec" aria-labelledby={head('src')}>
              <h3 id={head('src')}>Source and freshness</h3>
              <dl className="fd-facts">
                <div>
                  <dt>Source</dt>
                  <dd>
                    <span>
                      <CreditLink source={service.source} />
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{statusFact(service, now)}</dd>
                </div>
                <div>
                  <dt>Last read</dt>
                  <dd>
                    {agoText(service.source.fetchedAt, now)} · {utcTime(service.source.fetchedAt)}
                  </dd>
                </div>
                {service.source.updatedAt ? (
                  <div>
                    <dt>Listing updated</dt>
                    <dd>{utcText(service.source.updatedAt)}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>Use</dt>
                  <dd>
                    <span>{useFact(usage, now)}</span>
                    <span className="fd-fine">
                      {usage.lastCalledAt
                        ? `Last paid call ${agoText(usage.lastCalledAt, now)}. `
                        : ''}
                      Reported by {usage.reportedBy}, not measured by Central City.
                    </span>
                  </dd>
                </div>
              </dl>
            </section>

            <section className="fd-sec" aria-labelledby={head('how')}>
              <h3 id={head('how')}>How to use it</h3>
              {payOn ? (
                <p>
                  Use with my agent pays the service from your agent’s wallet and shows the result
                  here. A program with its own x402 client can also call the service address.
                </p>
              ) : (
                <p>
                  A program or AI with an x402 client and its own Base USDC wallet calls the service
                  address and pays the payment request it answers with. Central City can’t pay it
                  for your agents yet.
                </p>
              )}
            </section>

            <section className="fd-sec" aria-labelledby={head('lim')}>
              <h3 id={head('lim')}>Limitations</h3>
              <ul className="fd-limits">
                {(payOn ? LIMITS_PAY_ON : LIMITS).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>
          </div>
        </details>
      </div>
      <ServiceActions
        service={service}
        access={access}
        onUse={() => setUsing(true)}
        {...(onClose ? { onClose } : {})}
      />
    </>
  );
}
