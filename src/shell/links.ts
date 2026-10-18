/**
 * Public destinations that exist today (DESIGN_SYSTEM §2.1–2.2: a link renders only when its
 * route exists). Some routes are still hash-based until the path router covers them, so every entry
 * is the URL that works now. `null` means "not live yet": the header or footer leaves it out.
 */
export const LINKS = {
  home: '/',
  downtown: '/downtown',
  signIn: '/#signin',
  signUp: '/#signin',
  /** Sign in, then the room's Invite sheet (the step after connecting an AI app). */
  invite: '/invite',
  /**
   * Signed out, every "Invite your AI" button opens the Connect page (the product owner, 12 Oct):
   * add Central City to your AI app first; that page then links to the invite step.
   */
  connect: '/connect',
  /** The no-account path (/mcp/open and the per-app setup): today's Connect page. */
  tryWithoutAccount: '/#connect',
  mcpConnection: '/#connect',
  protocol: '/downtown#district-protocol',
  /**
   * The public source code (header: Developers › GitHub). An external GitHub page:
   * a clean snapshot of this application's tree, published as its own public repository.
   * `null` until that repository is public: the header shows no Developers section before then.
   */
  code: 'https://github.com/centralcity-ai-hq/central-city-code' as string | null,
  /** Elric, Central City's AI assistant: the chat for signed-in owners (sign-in first otherwise). */
  elric: '/elric',
  docs: '/docs',
  rooms: null as string | null,
  answers: null as string | null,
  workflows: '/workflows',
  about: '/about',
  contact: '/contact',
  support: '/support',
  security: '/security',
  privacy: '/privacy',
  terms: '/terms',
  status: '/status',
  downtownJson: '/downtown.json',
  downtownMd: '/downtown.md',
} as const;

const GITHUB = 'https://github.com/centralcity-ai-hq';

/**
 * The one switch for Elric's code on GitHub: true once the public code repository carries Elric's
 * folder (server/elric in central-city-code). Downtown then lists it as "Elric" among the
 * repositories (the product owner, 15 Oct: there, not in the Open Source menu).
 */
export const ELRIC_CODE_PUBLISHED = true;
/** Elric's folder in the public code repository (Downtown's "Elric" row links it). */
export const ELRIC_CODE_URL = `${GITHUB}/central-city-code/tree/main/server/elric`;

/** One entry in a header menu and the footer: a short name and where it goes. */
export type NavItem = {
  label: string;
  href: string;
  /** On GitHub: opens in a new tab (noopener) and shows ↗. */
  external?: boolean;
  /** One short line under the name in the header menus (the footer shows the name only). */
  description?: string;
  /** A heading inside its menu: consecutive items with the same section are shown together. */
  section?: string;
};
export type NavGroup = {
  id: 'product' | 'developers' | 'open-source' | 'company';
  label: string;
  items: NavItem[];
};

/** The public GitHub repositories the header and footer may link (tests check every URL). */
export const PUBLIC_REPOS = [
  'https://github.com/centralcity-ai-hq/protocol',
  'https://github.com/centralcity-ai-hq/sdk-ts',
  'https://github.com/centralcity-ai-hq/central-city-code',
  'https://github.com/centralcity-ai-hq/transparency',
];

/**
 * The public header's four menus; the footer mirrors them. Short names, nothing listed twice.
 * Every href is a live page or a public GitHub page; e2e/shell.spec.ts checks each one.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'product',
    label: 'Product',
    items: [
      { label: 'Elric', href: LINKS.elric, description: 'Your AI assistant in Central City' },
      { label: 'Workspace', href: LINKS.signIn },
      // Connecting an AI is the header's "Invite your AI" button (the product owner, 12 Oct).
      {
        label: 'Base Agents',
        href: '/explorer/base',
        description: 'Agents with a passport on Base',
      },
    ],
  },
  {
    id: 'developers',
    label: 'Developers',
    items: [
      { label: 'Docs', href: '/docs' },
      // Moved from Product (the product owner, 12 Oct): Product is Elric, Workspace, Base Agents.
      { label: 'Use cases', href: '/use-cases' },
      {
        label: 'Changelog',
        href: `${GITHUB}/central-city-code/blob/main/CHANGELOG.md`,
        external: true,
      },
      { label: 'Status', href: LINKS.status },
    ],
  },
  {
    id: 'open-source',
    label: 'Open Source',
    items: [
      {
        label: 'Agent Explorer',
        href: '/explorer',
        description: 'Every AI agent on Central City, live',
      },
      // The repositories, Elric's code among them, are on /downtown.
      { label: 'Downtown', href: LINKS.downtown },
      { label: 'Verify', href: '/downtown/verify' },
    ],
  },
  {
    id: 'company',
    label: 'Company',
    items: [
      { label: 'About', href: LINKS.about },
      { label: 'Contact', href: LINKS.contact },
      { label: 'Security', href: LINKS.security },
      { label: 'Privacy', href: LINKS.privacy },
    ],
  },
];

export type FooterLink = { label: string; href: string | null; external?: boolean };
export type FooterColumn = { title: string; links: FooterLink[] };

/**
 * The site footer: the header's four groups, then Help & legal (support and the policies).
 * Every same-site entry is a live page; e2e/footer.spec.ts opens each one and fails on a 404.
 */
export const FOOTER_COLUMNS: FooterColumn[] = [
  // The footer shows names only: no description lines or menu sections.
  ...NAV_GROUPS.map((group) => ({
    title: group.label,
    links: group.items.map(({ label, href, external }) => ({
      label,
      href,
      ...(external ? { external } : {}),
    })),
  })),
  {
    title: 'Help & legal',
    links: [
      { label: 'Support', href: LINKS.support },
      { label: 'Terms of service', href: LINKS.terms },
      { label: 'Privacy choices', href: '/privacy-choices' },
      { label: 'Acceptable use', href: '/acceptable-use' },
      { label: 'Data processing addendum', href: '/dpa' },
      { label: 'Imprint', href: '/imprint' },
    ],
  },
];

/** The footer's bottom line: no registration numbers here, only the name and city. */
export const FOOTER_COPYRIGHT = '© 2026 La Cavina S.R.L. · Torino, Italy';

/** Columns with at least one live link, each holding only its live links. */
export function liveFooterColumns(columns = FOOTER_COLUMNS) {
  return columns
    .map((column) => ({
      title: column.title,
      links: column.links.filter(
        (link): link is { label: string; href: string; external?: boolean } => Boolean(link.href),
      ),
    }))
    .filter((column) => column.links.length > 0);
}

/** A menu's items in their sections, in order: unnamed first, then each named section. */
export function sectionsOf(items: NavItem[]): Array<{ section: string | null; items: NavItem[] }> {
  const sections: Array<{ section: string | null; items: NavItem[] }> = [];
  for (const item of items) {
    const name = item.section ?? null;
    const last = sections.at(-1);
    if (last && last.section === name) last.items.push(item);
    else sections.push({ section: name, items: [item] });
  }
  return sections;
}
