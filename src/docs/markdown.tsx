import { Fragment, type ReactNode } from 'react';
import type { Nodes, PhrasingContent, Root, RootContent, Table } from 'mdast';
import { Code } from './Code';

/*
 * Public Markdown rendered to React elements node by node, as in the room Markdown
 * (src/rooms/markdown/render.tsx), so there is no path to raw HTML: HTML in the text shows as
 * text, and links are http(s), mailto, site paths or #anchors only. Headings get GitHub-style ids,
 * so the .md anchors work on the page too. Used by the docs guides (./Guide.tsx) and the audit page
 * (src/trust/Audit.tsx); the parsed trees come from scripts/public-docs/guides.ts.
 */

const SITE = 'https://centralcity.ai';
/** Deeper nesting is flattened to its text. */
const MAX_DEPTH = 24;

/**
 * The link target on the page, or null when the URL is not one we link (it shows as text). A
 * same-site path goes through `page`, which may point a .md file at its HTML page.
 */
export function markdownHref(url: string, page: (path: string) => string = (path) => path) {
  if (url.startsWith('#')) return url;
  let parsed: URL;
  try {
    parsed = new URL(url, SITE);
  } catch {
    return null;
  }
  if (parsed.origin === SITE) return `${page(parsed.pathname)}${parsed.search}${parsed.hash}`;
  if (parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:')
    return parsed.username || parsed.password ? null : parsed.href;
  return null;
}

/** Plain text of a node. */
function textOf(node: Nodes): string {
  if ('value' in node && typeof node.value === 'string') return node.value;
  if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? '';
  if ('children' in node) return (node.children as Nodes[]).map(textOf).join('');
  return '';
}

/** GitHub's heading anchors: lower case, punctuation dropped, spaces as hyphens. */
export function headingId(text: string, used: Map<string, number>): string {
  const base = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
  const count = used.get(base) ?? 0;
  used.set(base, count + 1);
  return count ? `${base}-${count}` : base;
}

/** What a custom table renderer gets: the inline renderer and the section the table is under. */
export type TableTools = {
  /** One inline node (text, link, code, emphasis...) rendered as everywhere else. */
  inline: (node: PhrasingContent, key: string) => ReactNode;
  /** The latest h2 or h3 above the table. */
  section: string;
  key: string;
};

/**
 * A page can draw some tables its own way (the audit page: contracts as cards, findings as rows).
 * Returning undefined keeps the plain table.
 */
export type TableRenderer = (table: Table, tools: TableTools) => ReactNode | undefined;

type Context = {
  ids: Map<string, number>;
  definitions: Map<string, string>;
  /** The latest section heading, to name the tables under it. */
  section: string;
  /** The latest h2 or h3, for a custom table renderer. */
  subsection: string;
  href: (url: string) => string | null;
  table?: TableRenderer;
};

function children(node: Nodes, ctx: Context, depth: number, key: string): ReactNode[] {
  if (!('children' in node)) return [];
  return (node.children as Nodes[]).map((child, index) =>
    renderNode(child, ctx, depth + 1, `${key}.${index}`),
  );
}

function link(href: string | null, content: ReactNode, key: string) {
  return href ? (
    <a key={key} href={href}>
      {content}
    </a>
  ) : (
    <span key={key}>{content}</span>
  );
}

function renderNode(node: Nodes, ctx: Context, depth: number, key: string): ReactNode {
  if (depth > MAX_DEPTH) return <span key={key}>{textOf(node)}</span>;
  const kids = () => children(node, ctx, depth, key);
  switch (node.type) {
    case 'root':
      return kids();
    case 'paragraph':
      return <p key={key}>{kids()}</p>;
    case 'heading': {
      const text = textOf(node);
      const id = headingId(text, ctx.ids);
      if (node.depth <= 2) ctx.section = text;
      if (node.depth <= 3) ctx.subsection = text;
      const Tag = node.depth <= 2 ? 'h2' : node.depth === 3 ? 'h3' : 'h4';
      return (
        <Tag key={key} id={id}>
          {kids()}
        </Tag>
      );
    }
    case 'thematicBreak':
      return <hr key={key} />;
    case 'blockquote':
      return <blockquote key={key}>{kids()}</blockquote>;
    case 'list':
      return node.ordered ? (
        <ol key={key} start={node.start ?? undefined}>
          {kids()}
        </ol>
      ) : (
        <ul key={key}>{kids()}</ul>
      );
    case 'listItem':
      // A tight item's paragraphs read as plain text, as in any Markdown renderer.
      return (
        <li key={key}>
          {node.spread
            ? kids()
            : node.children.map((child, index) =>
                child.type === 'paragraph'
                  ? children(child, ctx, depth + 1, `${key}.${index}`)
                  : renderNode(child, ctx, depth + 1, `${key}.${index}`),
              )}
        </li>
      );
    case 'code':
      return <Code key={key} value={node.value} label={node.lang || 'Code'} />;
    case 'inlineCode':
      return <code key={key}>{node.value}</code>;
    case 'emphasis':
      return <em key={key}>{kids()}</em>;
    case 'strong':
      return <strong key={key}>{kids()}</strong>;
    case 'delete':
      return <del key={key}>{kids()}</del>;
    case 'break':
      return <br key={key} />;
    case 'text':
      return node.value;
    // Raw HTML is never interpreted: it shows exactly as written.
    case 'html':
      return <span key={key}>{node.value}</span>;
    case 'link':
      return link(ctx.href(node.url), kids(), key);
    case 'linkReference': {
      const url = ctx.definitions.get(node.identifier);
      return link(url ? ctx.href(url) : null, kids(), key);
    }
    // Images are not loaded: a link to the image instead.
    case 'image':
    case 'imageReference': {
      const url = node.type === 'image' ? node.url : ctx.definitions.get(node.identifier);
      return link(url ? ctx.href(url) : null, `Image: ${node.alt || 'untitled'}`, key);
    }
    case 'definition':
      return null;
    case 'table': {
      const custom = ctx.table?.(node, {
        inline: (child, childKey) => renderNode(child, ctx, depth + 3, childKey),
        section: ctx.subsection,
        key,
      });
      if (custom !== undefined) return <Fragment key={key}>{custom}</Fragment>;
      const [head, ...body] = node.children;
      const align = node.align ?? [];
      const cells = (row: typeof head, Cell: 'th' | 'td', rowKey: string) =>
        row?.children.map((cell, index) => (
          <Cell
            key={`${rowKey}.${index}`}
            style={align[index] ? { textAlign: align[index]! } : undefined}
          >
            {children(cell, ctx, depth + 2, `${rowKey}.${index}`)}
          </Cell>
        ));
      // The box scrolls sideways on narrow screens; the page itself never does.
      return (
        <div
          key={key}
          className="docs-table"
          tabIndex={0}
          role="region"
          aria-label={ctx.section ? `Table: ${ctx.section}` : 'Table'}
        >
          <table>
            {head ? (
              <thead>
                <tr>{cells(head, 'th', `${key}.h`)}</tr>
              </thead>
            ) : null}
            <tbody>
              {body.map((row, index) => (
                <tr key={`${key}.${index}`}>{cells(row, 'td', `${key}.${index}`)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'footnoteReference':
      return <sup key={key}>[{node.label ?? node.identifier}]</sup>;
    case 'footnoteDefinition':
      return (
        <div key={key}>
          <sup>[{node.label ?? node.identifier}]</sup> {kids()}
        </div>
      );
    default:
      return <span key={key}>{textOf(node)}</span>;
  }
}

/** The page body: the title is the page's h1, and the closing link to the AI index is left out. */
function body(tree: Root): RootContent[] {
  const nodes = tree.children.filter((node) => !(node.type === 'heading' && node.depth === 1));
  const last = nodes[nodes.length - 1];
  if (last?.type === 'paragraph' && textOf(last).startsWith('More docs:')) nodes.pop();
  return nodes;
}

/** A parsed public doc, node by node, with `href` deciding each link's target. */
export function MarkdownBody({
  tree,
  href = (url) => markdownHref(url),
  table,
}: {
  tree: Root;
  href?: (url: string) => string | null;
  table?: TableRenderer;
}) {
  const definitions = new Map<string, string>();
  for (const node of tree.children)
    if (node.type === 'definition') definitions.set(node.identifier, node.url);
  const ctx: Context = { ids: new Map(), definitions, section: '', subsection: '', href, table };
  return <>{body(tree).map((node, index) => renderNode(node, ctx, 1, `g${index}`))}</>;
}
