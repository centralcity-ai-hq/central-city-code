/*
 * "Listed on": the directories that list Central City, each linking to our page there, plus two
 * onchain records (the Base ERC-8004 identity registry and our fee contract's verified source on Basescan),
 * named as what they are. An endless
 * strip (the set is drawn twice; the copy is hidden from assistive technology and the tab order).
 * Hover or focus pauses it; with reduced motion it stands still. Each name has its site's
 * logo (decorative, alt="": the name is the link's text). Never "partner"
 * wording. Smithery verifies the server through its link here.
 */
export interface Listing {
  name: string;
  href: string;
  /** The listing's logo in public/brand/listed/; none: a letter tile instead. */
  logo?: string;
  /** The letter tile's text when there is no logo. */
  tile?: string;
  /** A one-colour (black) mark: inverted in the dark theme so it stays visible. */
  mono?: boolean;
}

export const LISTINGS: Listing[] = [
  {
    name: 'MCP Registry',
    href: 'https://registry.modelcontextprotocol.io/?q=ai.centralcity',
    logo: '/brand/listed/modelcontextprotocol.svg',
    mono: true,
  },
  {
    name: 'Smithery',
    href: 'https://smithery.ai/servers/centralcity/central-city',
    logo: '/brand/listed/smithery.png',
  },
  {
    name: 'Gemini CLI Extensions',
    href: 'https://geminicli.com/extensions/?name=centralcity-ai-orggemini-cli-extension',
    logo: '/brand/listed/googlegemini.svg',
    mono: true,
  },
  {
    name: 'Claude Code Plugin',
    href: 'https://github.com/centralcity-ai-hq/toolkit/tree/main/integrations/claude-code/central-city',
    logo: '/brand/clients/claude.svg',
  },
  {
    name: 'Cursor Directory',
    href: 'https://cursor.directory/plugins/central-city',
    logo: '/brand/listed/cursor.svg',
    mono: true,
  },
  {
    name: 'DefiLlama',
    href: 'https://defillama.com/protocol/central-city',
    logo: '/brand/listed/defillama.png',
  },
  {
    name: 'x402-dev',
    href: 'https://github.com/michielpost/x402-dev/blob/master/Projects.md',
    tile: 'x4',
  },
  {
    name: 'Glama',
    href: 'https://glama.ai/mcp/connectors/ai.centralcity/central-city',
    logo: '/brand/listed/glama.svg',
    mono: true,
  },
  {
    name: 'MCP Market',
    href: 'https://mcpmarket.com/server/central-city',
    logo: '/brand/listed/mcpmarket.png',
    mono: true,
  },
  {
    name: 'HOL Registry',
    href: 'https://hol.org/registry/agent/uaid:aid:LzoGwrHPEcJE4z8Aas6vkdiHrgicsyKXpeEHeudGcNqEXJ21txUxVbujLSFCgF1qB',
    logo: '/brand/listed/hol.png',
    mono: true,
  },
  {
    name: 'QuickNode',
    href: 'https://erc-8004.quicknode.com/agents/base-mainnet/99029',
    logo: '/brand/listed/quicknode.png',
  },
  {
    name: '8004scan',
    href: 'https://8004scan.io/agents/base/99029',
    logo: '/brand/listed/8004scan.png',
  },
  {
    name: 'Dune',
    href: 'https://dune.com/centralcity',
    logo: '/brand/listed/dune.png',
    mono: true,
  },
  {
    name: 'ElizaOS',
    href: 'https://www.npmjs.com/package/@centralcity/plugin-central-city',
    logo: '/brand/listed/elizaos.png',
  },
  {
    name: 'Base ERC-8004 registry',
    href: 'https://basescan.org/address/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    logo: '/brand/listed/base.svg',
  },
  {
    name: 'Basescan',
    href: 'https://basescan.org/address/0xe807a76385ec3d76d17ab955091c12329d0a1403#code',
    logo: '/brand/listed/basescan.png',
  },
];

function Set({ copy }: { copy: boolean }) {
  return (
    <div className="cc-lo-set" aria-hidden={copy ? 'true' : undefined}>
      {LISTINGS.map((item) => (
        <a
          key={item.name}
          className="cc-lo"
          href={item.href}
          target="_blank"
          rel="noopener noreferrer"
          tabIndex={copy ? -1 : undefined}
        >
          {item.logo ? (
            <img
              src={item.logo}
              alt=""
              width={26}
              height={26}
              loading="lazy"
              className={item.mono ? 'cc-lo-mono' : undefined}
            />
          ) : (
            <span className="cc-lo-tile" data-tile={item.tile} aria-hidden="true" />
          )}
          {item.name}
        </a>
      ))}
    </div>
  );
}

export function ListedOn() {
  return (
    <section className="cc-listed" aria-label="Listed on">
      <div className="cc-listed-h">Listed on</div>
      <div
        className="cc-mq"
        // Focus stops the strip (CSS); bring the focused listing fully into view, even when it
        // was only partly visible (browsers scroll only links that are fully out of view).
        onFocus={(event) => {
          if (event.target instanceof HTMLElement)
            event.target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }}
      >
        <div className="cc-mq-track">
          <Set copy={false} />
          <Set copy />
        </div>
      </div>
    </section>
  );
}
