import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type ComponentProps,
  type ComponentType,
} from 'react';
import { ChevronDown, Menu, X } from 'lucide-react';
import { Lockup, SkipLink } from '../brand';
import { ThemeToggle } from './theme';
import { LINKS, NAV_GROUPS, sectionsOf, type NavGroup, type NavItem } from './links';
import { useInviteHref } from './navigation';
import './shell.css';
import { api } from '../api';

/**
 * The phone menu is its own chunk, fetched while a phone-width page is idle, or when the menu
 * button is touched or focused. Once it is here the menu renders directly: through lazy() alone,
 * React would hold it back about 300 ms after the tap.
 */
let loadedPhoneMenu: typeof import('./PhoneMenu').default | null = null;
const loadPhoneMenu = () =>
  import('./PhoneMenu').then((module) => {
    loadedPhoneMenu = module.default;
    return module;
  });
const LazyPhoneMenu = lazy(() => loadPhoneMenu().catch(() => ({ default: PlainLinksMenu })));

/** Moves focus to the fallback menu's first link once, when it mounts (a stable ref callback). */
const focusIn = (nav: HTMLElement | null) => nav?.querySelector('a')?.focus();
/**
 * If the menu's chunk cannot load: the same links as a plain list, never an error page. Like the
 * real menu, focus moves into it on open and Escape closes it (focus back on the menu button).
 */
const PlainLinksMenu = (props: {
  id: string;
  renderLink: (item: NavItem) => ReactNode;
  signIn: ReactNode;
  closing?: boolean;
  onClose: (escape: boolean) => void;
}) => (
  <nav
    ref={focusIn}
    id={props.id}
    className="cc-header-menu"
    aria-label="Menu"
    data-state={props.closing ? 'closing' : undefined}
    inert={props.closing}
    onKeyDown={(event) => event.key === 'Escape' && props.onClose(true)}
  >
    {NAV_GROUPS.flatMap((group) => group.items).map(props.renderLink)}
    {props.signIn}
  </nav>
);
const prefetchPhoneMenu = () => void loadPhoneMenu().catch(() => undefined);

/** How long the phone menu stays mounted for its 140 ms exit (motion.css). */
const MENU_EXIT_MS = 140;
const reducedMotion = () =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export type PublicPage =
  | 'home'
  | 'connect'
  | 'signin'
  | 'downtown'
  | 'rooms'
  | 'docs'
  | 'workflows'
  | 'usecases'
  | 'notfound';

/** The page each header item stands for, so the item (and its group) can show "current". */
const CURRENT_HREF: Partial<Record<PublicPage, string>> = {
  docs: '/docs',
  downtown: '/downtown',
  workflows: '/workflows',
  usecases: '/use-cases',
};

/** Hover intent: a trigger opens the panel only after the pointer rests on it this long. */
const OPEN_DELAY_MS = 100;
/** Leaving the header and the panel closes it after this long (room for a diagonal move). */
const CLOSE_DELAY_MS = 220;

/** Where the app lives for a signed-in visitor (header "Open app", Product › Workspace). */
const APP_HREF = '/rooms';

/** A plain text link (header and footer); GitHub items open in a new tab and show ↗. */
export function NavLink({
  item,
  current,
  signedIn,
}: {
  item: NavItem;
  current: PublicPage;
  signedIn: boolean;
}) {
  const describedBy = useId();
  return (
    <a
      className="cc-nav-link"
      // Product › Workspace: the sign-in page, or the app itself once signed in.
      href={signedIn && item.href === LINKS.signIn ? APP_HREF : item.href}
      aria-current={CURRENT_HREF[current] === item.href ? 'page' : undefined}
      {...(item.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      {...(item.description ? { 'aria-describedby': describedBy } : {})}
      data-described={item.description ? 'true' : undefined}
    >
      {item.description ? (
        <span className="cc-nav-text">
          <span>{item.label}</span>
          <span id={describedBy} className="cc-nav-description">
            {item.description}
          </span>
        </span>
      ) : (
        item.label
      )}
      {item.external ? (
        <>
          <span className="cc-nav-external" aria-hidden="true">
            ↗
          </span>
          <span className="visually-hidden"> (opens in a new tab)</span>
        </>
      ) : null}
    </a>
  );
}

/** The links of one group's panel content, in order (for Tab and the arrow keys). */
const linksIn = (element: HTMLElement | null | undefined) =>
  Array.from(element?.querySelectorAll<HTMLAnchorElement>('a') ?? []);

type GroupId = NavGroup['id'];

/**
 * The wide header's menus, in the manner of openai.com. One persistent panel under the header
 * fades in with a small drop; between groups its height eases to the active group's content, the
 * outgoing content fades out quickly and the incoming one fades in from a few pixels below; the
 * page behind blurs and dims. Hover
 * intent: resting on a trigger for 100 ms opens it, or switches to it while the panel is open
 * (passing over a trigger does neither). The triggers span the header's full height (a generous hit area) and leaving
 * the header and the panel closes it only after 220 ms, so a diagonal move
 * from a trigger into the panel never closes it. Clicking or Enter/Space/ArrowDown open it too;
 * Tab from an open trigger enters its links; Escape closes it and returns focus.
 */
function DesktopNav({
  signedIn,
  current,
  open,
  active,
  show,
  hide,
  cancelTimers,
  intendOpen,
}: {
  signedIn: boolean;
  current: PublicPage;
  open: boolean;
  active: GroupId;
  show: (id: GroupId) => void;
  hide: () => void;
  cancelTimers: () => void;
  intendOpen: (id: GroupId) => void;
}) {
  const panelId = useId();
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const contents = useRef(new Map<string, HTMLDivElement>());
  const [height, setHeight] = useState(0);

  // The panel's height follows the active content (measured, so it eases between NAV_GROUPS).
  useLayoutEffect(() => {
    setHeight(contents.current.get(active)?.offsetHeight ?? 0);
  }, [active, open]);

  const focusTrigger = (index: number) =>
    triggers.current.get(NAV_GROUPS[(index + NAV_GROUPS.length) % NAV_GROUPS.length]!.id)?.focus();

  // Focus the group's first link as soon as it is focusable (it becomes visible a frame or two
  // after the panel opens).
  const focusFirstLink = (id: GroupId, frames = 8) =>
    requestAnimationFrame(() => {
      const link = contents.current.get(id)?.querySelector('a');
      link?.focus();
      if (frames > 1 && document.activeElement !== link) focusFirstLink(id, frames - 1);
    });

  const onTriggerKey = (event: ReactKeyboardEvent, index: number) => {
    const id = NAV_GROUPS[index]!.id;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      show(id);
      focusFirstLink(id);
    } else if (event.key === 'Tab' && !event.shiftKey && open && active === id) {
      event.preventDefault();
      focusFirstLink(id);
    }
  };

  const onContentKey = (event: ReactKeyboardEvent, index: number) => {
    const id = NAV_GROUPS[index]!.id;
    const links = linksIn(contents.current.get(id));
    const at = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (event.key === 'Tab' && !event.shiftKey && at === links.length - 1) {
      // Past the last link: on to the next trigger (or out of the menus after the last one).
      if (index < NAV_GROUPS.length - 1) {
        event.preventDefault();
        hide();
        focusTrigger(index + 1);
      } else hide();
    } else if (event.key === 'Tab' && event.shiftKey && at === 0) {
      event.preventDefault();
      focusTrigger(index);
    }
  };

  return (
    <>
      <nav className="cc-header-nav nav-links" aria-label="Public">
        {NAV_GROUPS.map((group, index) => (
          <button
            key={group.id}
            ref={(element) => {
              if (element) triggers.current.set(group.id, element);
            }}
            type="button"
            className="cc-nav-trigger"
            aria-expanded={open && active === group.id}
            aria-controls={`${panelId}-${group.id}`}
            onPointerEnter={(event: ReactPointerEvent) => {
              // Open or switch only if the pointer rests here (100 ms), so passing over a
              // trigger on the way down into the panel changes nothing.
              if (event.pointerType === 'mouse' && !(open && active === group.id))
                intendOpen(group.id);
            }}
            onPointerLeave={(event: ReactPointerEvent) => {
              // Passing over a trigger never opens or switches to it.
              if (event.pointerType === 'mouse') cancelTimers();
            }}
            onClick={(event) => {
              // A pointer click opens (it never toggles shut the panel its hover just opened);
              // Enter or Space toggle.
              if (event.detail > 0) show(group.id);
              else if (open && active === group.id) hide();
              else show(group.id);
            }}
            onKeyDown={(event) => onTriggerKey(event, index)}
          >
            {group.label}
          </button>
        ))}
      </nav>
      <div className="cc-mega" data-open={open ? 'true' : undefined} style={{ height }}>
        <div className="cc-mega-inner">
          {NAV_GROUPS.map((group, index) => (
            <div
              key={group.id}
              ref={(element) => {
                if (element) contents.current.set(group.id, element);
              }}
              id={`${panelId}-${group.id}`}
              className="cc-mega-content"
              data-active={open && active === group.id ? 'true' : undefined}
              onKeyDown={(event) => onContentKey(event, index)}
              onClick={(event) => {
                if ((event.target as HTMLElement).closest('a')) hide();
              }}
            >
              <p className="cc-mega-label">{group.label}</p>
              {sectionsOf(group.items).map(({ section, items }) => (
                <div key={section ?? ''} className="cc-mega-section">
                  {section ? <p className="cc-mega-label">{section}</p> : null}
                  <ul role="list" aria-label={section ?? undefined}>
                    {items.map((item) => (
                      <li key={item.href}>
                        <NavLink item={item} current={current} signedIn={signedIn} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/**
 * The Central City public header (v8 Design System): the logo lockup, four menus (Product,
 * Developers, Open Source, Company; links.ts NAV_GROUPS), quiet "Sign in" (or "Open app" when
 * signed in), the primary "Invite your AI" and the theme toggle. Under 900 px the menus become a
 * full-screen menu with the four groups as expandable sections, Sign in and the theme; the
 * primary action and logo stay visible at every viewport.
 */
export function PublicHeader({ current }: { current: PublicPage }) {
  const [scrolled, setScrolled] = useState(false);
  // The phone menu: open, closed, or on its way out (still shown while its exit plays).
  const [menu, setMenu] = useState<'open' | 'closing' | 'closed'>('closed');
  const menuOpen = menu === 'open';
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<GroupId>('product');
  // One filled button per view: while a page's own "Invite your AI"
  // (#hero-invite) is on screen, the header's copy of it steps back to secondary style.
  const [heroInviteVisible, setHeroInviteVisible] = useState(false);
  // Signed in? One GET /api/session per page load (one header per page); any failure counts as
  // signed out, and the header then shows "Sign in".
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    api<{ operator?: unknown }>('/api/session', undefined, 'GET').then(
      (body) => setSignedIn(Boolean(body.operator)),
      () => undefined,
    );
  }, []);
  const menuId = useId();
  const header = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const inviteHref = useInviteHref();

  // Hover intent and the close delay share one timer.
  const cancelTimers = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
  };
  const later = (run: () => void, ms: number) => {
    cancelTimers();
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      run();
    }, ms);
  };
  const show = (id: GroupId) => {
    cancelTimers();
    setActive(id);
    setOpen(true);
  };
  const hide = () => {
    cancelTimers();
    setOpen(false);
  };
  const intendOpen = (id: GroupId) => later(() => show(id), OPEN_DELAY_MS);
  const closeSoon = (event: ReactPointerEvent) => {
    if (event.pointerType === 'mouse') later(hide, CLOSE_DELAY_MS);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const menuTimer = useRef<number | undefined>(undefined);
  // Chosen when the menu opens, so it never remounts while it is open.
  const PhoneMenu = useRef<ComponentType<ComponentProps<typeof LazyPhoneMenu>>>(LazyPhoneMenu);
  const openMenu = () => {
    window.clearTimeout(menuTimer.current);
    if (menu === 'closed') PhoneMenu.current = loadedPhoneMenu ?? LazyPhoneMenu;
    setMenu('open');
  };
  const closeMenu = () => {
    window.clearTimeout(menuTimer.current);
    if (reducedMotion()) return setMenu('closed');
    setMenu('closing');
    menuTimer.current = window.setTimeout(() => setMenu('closed'), MENU_EXIT_MS);
  };
  useEffect(() => () => window.clearTimeout(menuTimer.current), []);
  // On a phone, the menu's chunk comes in while the page is idle, so the first tap opens it at
  // once instead of waiting for the network.
  useEffect(() => {
    if (!window.matchMedia?.('(max-width: 899px)').matches) return;
    const idle = window.requestIdleCallback ?? ((run: () => void) => window.setTimeout(run, 1200));
    const cancel = window.cancelIdleCallback ?? window.clearTimeout;
    const handle = idle(prefetchPhoneMenu);
    return () => cancel(handle);
  }, []);

  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 4);
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, []);

  // Layout effect: decide before the first paint, so the header never flashes filled.
  // Steps back while either the hero button ('Sign up' / 'Invite your AI') or the CTA is visible.
  useLayoutEffect(() => {
    const targets = Array.from(
      document.querySelectorAll<HTMLElement>(
        '#hero-invite, .cc-landing-hero .button.primary, .cc-lp-hero .button.primary',
      ),
    );
    if (targets.length === 0) return;
    const isAnyVisible = () =>
      targets.some((el) => {
        const box = el.getBoundingClientRect();
        return box.bottom > 0 && box.top < window.innerHeight;
      });
    setHeroInviteVisible(isAnyVisible());
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(() => {
      setHeroInviteVisible(isAnyVisible());
    });
    targets.forEach((target) => observer.observe(target));
    return () => observer.disconnect();
  }, []);

  // The wide panel: Escape closes it and returns focus to its trigger; focus or a press
  // outside the header closes it.
  useEffect(() => {
    if (!open) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const inside = header.current?.contains(document.activeElement);
      hide();
      if (inside)
        header.current
          ?.querySelector<HTMLButtonElement>(`.cc-nav-trigger[aria-controls$="-${active}"]`)
          ?.focus();
    };
    const outside = (event: Event) => {
      if (!header.current?.contains(event.target as Node)) hide();
    };
    document.addEventListener('keydown', keydown);
    document.addEventListener('focusin', outside);
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('pointerdown', outside);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);

  // Signed in: "Open app" instead of "Sign in" (Product › Workspace follows, see NavLink).
  const signIn = signedIn ? (
    <a className="cc-header-signin nav-signin" href={APP_HREF}>
      Open app
    </a>
  ) : (
    <a
      className="cc-header-signin nav-signin"
      href={LINKS.signIn}
      aria-current={current === 'signin' ? 'page' : undefined}
    >
      Sign in
    </a>
  );

  return (
    <header
      ref={header}
      className={`cc-header site-nav${scrolled || menuOpen || open ? ' is-scrolled' : ''}${open ? ' is-open' : ''}`}
      onPointerLeave={closeSoon}
    >
      <SkipLink />
      <div className="cc-header-inner nav-inner" onPointerEnter={cancelTimers}>
        <Lockup href={LINKS.home} label="Central City home" />
        <DesktopNav
          signedIn={signedIn}
          current={current}
          open={open}
          active={active}
          show={show}
          hide={hide}
          cancelTimers={cancelTimers}
          intendOpen={intendOpen}
        />
        <div className="cc-header-actions nav-actions">
          <span className="cc-header-wide">{signIn}</span>
          <a
            className={`btn ${heroInviteVisible ? 'btn-secondary secondary' : 'btn-primary primary'} btn-sm button cc-header-invite`}
            href={inviteHref}
            aria-label="Invite your AI"
            aria-current={current === 'connect' ? 'page' : undefined}
          >
            <span className="cc-label-long" aria-hidden="true">
              Invite your AI
            </span>
            <span className="cc-label-short" aria-hidden="true">
              Invite AI
            </span>
          </a>
          <span className="cc-header-wide">
            <ThemeToggle />
          </span>
          <button
            ref={menuButton}
            type="button"
            className="icon-button cc-header-menu-button"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            onPointerDown={prefetchPhoneMenu}
            onFocus={prefetchPhoneMenu}
            onClick={() => (menuOpen ? closeMenu() : openMenu())}
          >
            {menuOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
          </button>
        </div>
      </div>
      {/* The page behind an open panel blurs and dims; a press on it closes the panel. */}
      <div
        className="cc-mega-backdrop"
        data-open={open ? 'true' : undefined}
        aria-hidden="true"
        // Only real pointer movement over the page closes the panel (never a mouse that was
        // resting there when the keyboard opened it); a close already on its way is kept.
        onPointerMove={(event) => timer.current === undefined && closeSoon(event)}
        onClick={hide}
      />
      {menu !== 'closed' ? (
        <Suspense fallback={null}>
          <PhoneMenu.current
            id={menuId}
            closing={menu === 'closing'}
            groups={NAV_GROUPS}
            renderLink={(item) => (
              <NavLink key={item.href} item={item} current={current} signedIn={signedIn} />
            )}
            signIn={signIn}
            theme={<ThemeToggle />}
            chevron={<ChevronDown className="cc-menu-chevron" size={18} aria-hidden="true" />}
            onClose={(escape) => {
              closeMenu();
              if (escape) menuButton.current?.focus();
            }}
          />
        </Suspense>
      ) : null}
    </header>
  );
}
