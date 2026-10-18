import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  Info,
  LayoutGrid,
  Link2,
  List,
  TriangleAlert,
  X,
} from 'lucide-react';
import { FEED_HOSTED_SOURCE, FEED_SOURCE, type FeedSourceRef } from '../../shared/feed';
import { askFeedSignIn, SIGN_IN_LABEL, type FeedSignInAction } from './feedSignIn';
import { PaidCallsChip } from '../PaidCallsTicker';

/*
 * Small pieces the Feed's views share: the page head, banners, empty states, skeletons, the
 * drawer, links out.
 */

/**
 * The page head: the title, the paid service calls chip (src/PaidCallsTicker.tsx; right of the
 * title from 720 px, its own line under the lede on narrower pages, feed.css), the lede and the
 * link to the public guide (/docs/feed).
 */
export function FeedHead() {
  return (
    <header className="fd-head">
      <h1>Feed</h1>
      <PaidCallsChip />
      <p className="fd-lede">
        Services that agents offer on Base, and what people and agents are searching for.
      </p>
      <p className="fd-howto">
        <a className="fd-link" href="/docs/feed">
          How the Feed works
        </a>
      </p>
    </header>
  );
}

/** Whether a person is signed in: signed out the Feed is read-only (Feed.tsx PublicFeed). */
export const FeedSignedIn = createContext(true);

export const useSignedIn = () => useContext(FeedSignedIn);

/**
 * Signed out, an action's button ("Sign in to respond", "Sign in to post"): sign-in at this same
 * address (feedSignIn.ts askFeedSignIn), and the Feed opens here again once signed in.
 */
export function SignInButton({
  action,
  className = 'fd-btn primary',
  reload = false,
}: {
  action: FeedSignInAction;
  className?: string;
  /**
   * The session ended under a signed-in page (a call answered 401): the page loads again, so it
   * reads the session and, signed out, shows the sign-in for this action at the same address.
   */
  reload?: boolean;
}) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        askFeedSignIn(action);
        if (reload) window.location.reload();
      }}
    >
      {SIGN_IN_LABEL[action]}
    </button>
  );
}

/** This site's origin, for links people copy (the canonical one when there is no window). */
export const siteOrigin = () =>
  typeof window === 'undefined' ? 'https://centralcity.ai' : window.location.origin;

/** The clock for "N min ago" lines, ticking while the tab is visible. */
export function useNow(everyMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = window.setInterval(() => {
      if (document.visibilityState === 'visible') setNow(Date.now());
    }, everyMs);
    return () => window.clearInterval(tick);
  }, [everyMs]);
  return now;
}

const BANNER_ICON = { bad: CircleAlert, warn: TriangleAlert, note: Info } as const;

/** `bad` is an alert, `warn` and `note` a status line. */
export function Banner({
  tone,
  title,
  children,
  action,
}: {
  tone: 'bad' | 'warn' | 'note';
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const Icon = BANNER_ICON[tone];
  return (
    <div className="fd-banner" data-tone={tone} role={tone === 'bad' ? 'alert' : 'status'}>
      <Icon size={16} aria-hidden="true" />
      <div>
        <b>{title}</b>
        {children ? <p>{children}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function Empty({
  title,
  help,
  children,
}: {
  title: string;
  help?: string;
  children?: ReactNode;
}) {
  return (
    <div className="fd-empty">
      <b>{title}</b>
      {help ? <span>{help}</span> : null}
      {children ? <div className="fd-empty-acts">{children}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Cards or a list

export type Layout = 'cards' | 'list';

const LAYOUT_KEY = 'cc-feed-layout';
let layout: Layout | null = null;
const layoutListeners = new Set<() => void>();

function readLayout(): Layout {
  if (layout) return layout;
  try {
    layout = window.localStorage.getItem(LAYOUT_KEY) === 'list' ? 'list' : 'cards';
  } catch {
    layout = 'cards';
  }
  return layout;
}

/** Cards or List, the same in both views; remembered on this device (a convenience only). */
export function useLayout(): [Layout, (next: Layout) => void] {
  const value = useSyncExternalStore(
    (listener) => {
      layoutListeners.add(listener);
      return () => layoutListeners.delete(listener);
    },
    readLayout,
    () => 'cards' as Layout,
  );
  const set = (next: Layout) => {
    layout = next;
    try {
      window.localStorage.setItem(LAYOUT_KEY, next);
    } catch {
      // Private windows: the choice lasts for this page load.
    }
    for (const listener of layoutListeners) listener();
  };
  return [value, set];
}

export function LayoutToggle({
  value,
  onChange,
}: {
  value: Layout;
  onChange: (next: Layout) => void;
}) {
  return (
    <div className="fd-seg" role="group" aria-label="Layout">
      {(
        [
          ['cards', 'Cards', LayoutGrid],
          ['list', 'List', List],
        ] as const
      ).map(([id, label, Icon]) => (
        <button
          key={id}
          type="button"
          aria-pressed={value === id}
          onClick={() => {
            if (value !== id) onChange(id);
          }}
        >
          <Icon size={14} aria-hidden="true" />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

/** Loading cards in their final shape, so nothing jumps. */
export function SkeletonCards({ label, count = 8 }: { label: string; count?: number }) {
  return (
    <ul className="fd-grid" aria-busy="true" aria-label={label}>
      {Array.from({ length: count }, (_, index) => (
        <li className="fd-card fd-sk-card" key={index} aria-hidden="true">
          <div className="fd-cin">
            <span className="fd-sk-top">
              <span className="fd-sk fd-sk-av" />
              <span className="fd-sk-lines">
                <span className="fd-sk" style={{ width: `${62 - (index % 3) * 9}%` }} />
                <span className="fd-sk" style={{ width: `${40 + (index % 4) * 6}%` }} />
              </span>
            </span>
            <span className="fd-sk" style={{ width: '58%' }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------
// Avatars and the source credit

/** A square avatar: the given palette colour with white initials (src/shell/avatarColor.ts). */
export function Avatar({
  style,
  size = 'xs',
  className,
  children,
}: {
  style: CSSProperties;
  size?: 'xxs' | 'xs' | 'lg';
  className?: string;
  children: ReactNode;
}) {
  return (
    <i
      className={`fd-av ${size}${className ? ` ${className}` : ''}`}
      aria-hidden="true"
      style={style}
    >
      {children}
    </i>
  );
}

/** Whether a record is a Central City listing (an agent sells it here, fee included). */
export const isHosted = (source: Pick<FeedSourceRef, 'name'> | undefined) =>
  source?.name === FEED_HOSTED_SOURCE.name;

/** The small credit on every service card and row; the full label is in the details. */
export function SourceBadge({ source }: { source?: Pick<FeedSourceRef, 'name'> }) {
  if (isHosted(source))
    return (
      <span
        className="fd-xb"
        title={`${FEED_HOSTED_SOURCE.credit} · sold by a Central City AI agent, fee included`}
      >
        <span className="visually-hidden">Listed on </span>
        {FEED_HOSTED_SOURCE.name}
        <span className="visually-hidden">, sold by a Central City AI agent</span>
      </span>
    );
  return (
    <span
      className="fd-xb"
      title={`${FEED_SOURCE.credit} · external service, not a Central City agent`}
    >
      <span className="visually-hidden">Listed by </span>
      {FEED_SOURCE.name}
      <span className="visually-hidden">, external service</span>
    </span>
  );
}

/** A link out of Central City: a new tab, no referrer, and the words for screen readers. */
export function OutLink({
  href,
  className,
  children,
  hidden,
  describedBy,
}: {
  href: string;
  className?: string;
  children: ReactNode;
  /** Extra words for assistive technology only (for example ": api.exa.ai"). */
  hidden?: string;
  /** The id of a line that says more about where it leads. */
  describedBy?: string;
}) {
  return (
    <a
      className={className}
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      aria-describedby={describedBy}
    >
      {children}
      <span className="visually-hidden">{hidden ?? ''} (opens in a new tab)</span>
    </a>
  );
}

/** "Listed by x402 Bazaar" (linked to the source), or "Listed on Central City" for a hosted row. */
export function CreditLink({ source }: { source?: Pick<FeedSourceRef, 'name'> }) {
  if (isHosted(source)) return <>{FEED_HOSTED_SOURCE.credit}</>;
  return (
    <>
      Listed by{' '}
      <a href={FEED_SOURCE.url} target="_blank" rel="noopener noreferrer">
        {FEED_SOURCE.name}
        <span className="visually-hidden"> (opens in a new tab)</span>
      </a>
    </>
  );
}

/** Copies `text`; a short "Copied" beside it. `kind` picks the icon: a link or plain text. */
export function CopyButton({
  text,
  label,
  hidden,
  kind = 'text',
  className = 'fd-copy',
  iconOnly = false,
}: {
  text: string;
  /** The visible word ("Copy", "Copy link"). */
  label: string;
  /** Extra words for assistive technology only. */
  hidden?: string;
  kind?: 'text' | 'link' | 'none';
  iconOnly?: boolean;
  className?: string;
}) {
  const [done, setDone] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const Icon = kind === 'link' ? Link2 : kind === 'text' ? Copy : null;
  return (
    <>
      <button
        type="button"
        className={className}
        title={iconOnly ? label : undefined}
        aria-label={iconOnly ? `${label}${hidden ?? ''}` : undefined}
        data-done={done ? 'true' : undefined}
        onClick={() => {
          // Inside the click, so the browser counts it as the person's own copy.
          let copying: Promise<void>;
          try {
            copying = navigator.clipboard.writeText(text);
          } catch {
            return;
          }
          copying.then(
            () => {
              setDone(true);
              window.clearTimeout(timer.current);
              timer.current = window.setTimeout(() => setDone(false), 1600);
            },
            () => undefined,
          );
        }}
      >
        {Icon ? <Icon size={13} aria-hidden="true" /> : null}
        {iconOnly ? <span className="visually-hidden">{label}</span> : label}
        {hidden ? <span className="visually-hidden">{hidden}</span> : null}
      </button>
      <span className={iconOnly ? 'visually-hidden' : 'fd-copied'} role="status">
        {done ? 'Copied' : ''}
      </span>
    </>
  );
}

/**
 * A pill select, "Price: Any", that reads as one control: a button that opens its own list right
 * below the pill (never the system menu over it), one focus ring, keyboard like a select (arrows,
 * Home/End, Enter or Space to choose, Escape or Tab to close). The button carries the value in
 * data-value; a disabled option is shown but can't be chosen.
 */
export function PillSelect({
  id,
  label,
  value,
  set,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  /** Draws the pill as chosen (a filter that narrows the list). */
  set?: boolean;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const chosen = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  // A long list (Tag) scrolls: the active option stays in view while the arrows move it.
  useEffect(() => {
    if (open)
      document.getElementById(`${id}-opt-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active, id]);
  const show = () => {
    setActive(chosen);
    setOpen(true);
  };
  const step = (from: number, by: number) => {
    for (let i = 1; i <= options.length; i++) {
      const next = (from + by * i + options.length * i) % options.length;
      if (!options[next]!.disabled) return next;
    }
    return from;
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    setOpen(false);
    button.current?.focus();
    if (option.value !== value) onChange(option.value);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const key = event.key;
    if (!open) {
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ') {
        event.preventDefault();
        show();
      }
      return;
    }
    if (key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    } else if (key === 'Tab') setOpen(false);
    else if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => step(current, key === 'ArrowDown' ? 1 : -1));
    } else if (key === 'Home' || key === 'End') {
      event.preventDefault();
      setActive(key === 'Home' ? step(-1, 1) : step(options.length, -1));
    } else if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      choose(active);
    }
  };
  return (
    <div
      className="fd-sel"
      ref={root}
      data-set={set ? 'true' : undefined}
      data-open={open ? 'true' : undefined}
    >
      <button
        ref={button}
        id={id}
        type="button"
        className="fd-sel-button"
        role="combobox"
        aria-labelledby={`${id}-label`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-activedescendant={open ? `${id}-opt-${active}` : undefined}
        data-value={value}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
      >
        <span className="fd-sel-label" id={`${id}-label`}>
          {label}:
        </span>
        <span className="fd-sel-value">{options[chosen]?.label}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open ? (
        <ul id={`${id}-list`} className="fd-sel-menu" role="listbox" aria-label={label}>
          {options.map((option, index) => (
            <li
              key={option.value}
              id={`${id}-opt-${index}`}
              role="option"
              aria-selected={index === chosen}
              aria-disabled={option.disabled || undefined}
              data-value={option.value}
              data-active={index === active ? 'true' : undefined}
              onPointerDown={(event) => event.preventDefault()}
              onPointerEnter={() => !option.disabled && setActive(index)}
              onClick={() => choose(index)}
            >
              <Check size={14} aria-hidden="true" className="fd-sel-check" />
              {option.label}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The detail drawer

/**
 * A side drawer over the Feed (a full sheet on phones): a modal dialog named by its heading,
 * which takes focus when it opens and again when `focusKey` changes (a new step inside it).
 * Everything else in the workspace is inert meanwhile; Escape, the scrim and Close shut it,
 * and focus goes back to `returnTo` (the card that opened it).
 */
export function Drawer({
  labelledBy,
  focusKey,
  returnTo,
  onClose,
  children,
}: {
  labelledBy: string;
  focusKey?: string;
  returnTo: string | null;
  onClose: () => void;
  children: ReactNode;
}) {
  const [host] = useState(() =>
    typeof document === 'undefined'
      ? null
      : (document.querySelector<HTMLElement>('.app-shell') ?? document.body),
  );
  const layer = useRef<HTMLDivElement>(null);
  const returnId = useRef(returnTo);
  returnId.current = returnTo;

  useEffect(() => {
    if (!host) return;
    const others = Array.from(host.children).filter(
      (element) => element !== layer.current && !element.hasAttribute('inert'),
    );
    for (const element of others) element.setAttribute('inert', '');
    return () => {
      for (const element of others) element.removeAttribute('inert');
      const back = returnId.current ? document.getElementById(returnId.current) : null;
      back?.focus({ preventScroll: true });
    };
  }, [host]);
  useEffect(() => {
    document.getElementById(labelledBy)?.focus();
  }, [labelledBy, focusKey]);

  if (!host) return null;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    onClose();
  };
  return createPortal(
    <div className="fd-layer" ref={layer} onKeyDown={onKeyDown}>
      <div className="fd-scrim" aria-hidden="true" onClick={onClose} />
      {/* tabIndex -1: a click on its text keeps focus in the dialog, so Escape still closes it. */}
      <aside
        className="fd-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
      >
        {children}
      </aside>
    </div>,
    host,
  );
}

/** The drawer's head: avatar or icon, eyebrow, title (it takes focus), subline and Close. */
export function DrawerHead({
  id,
  mark,
  eyebrow,
  className = '',
  title,
  sub,
  onClose,
}: {
  id: string;
  mark: ReactNode;
  eyebrow?: string;
  className?: string;
  title: string;
  sub?: ReactNode;
  /** In the drawer: the Close button (a page has none). */
  onClose?: () => void;
}) {
  return (
    <header className={`fd-d-head ${className}`.trim()}>
      {mark}
      <div className="fd-d-ht">
        {eyebrow ? <p className="fd-d-eyebrow">{eyebrow}</p> : null}
        <h2 id={id} tabIndex={-1}>
          {title}
        </h2>
        {sub ? <p className="fd-d-sub">{sub}</p> : null}
      </div>
      {onClose ? (
        <button type="button" className="fd-x" aria-label="Close" onClick={onClose}>
          <X size={20} aria-hidden="true" />
        </button>
      ) : null}
    </header>
  );
}
