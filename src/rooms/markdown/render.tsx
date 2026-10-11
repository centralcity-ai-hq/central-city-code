import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Nodes, Root } from 'mdast';
import { CodeBlock } from './CodeBlock';
import { withoutBidiControls } from './guard';
import type { ParseResult } from './parse';
import { cachedParse, parseInWorker, prioritize } from './workerClient';

/*
 * Room message Markdown. The mdast tree is rendered to React
 * elements here, node by node, so there is no path from message text to HTML: no raw-HTML
 * props, raw HTML nodes become literal text, links are http(s) only, and
 * Markdown images are never loaded (they render as links; images come only from attachments).
 */

/** The server's text limit per part (see parse.ts, which enforces it). */
export const MAX_MARKDOWN_CHARS = 16_384;
/** Deeper nesting is flattened to its text (nested quotes/lists cannot blow the stack). */
const MAX_DEPTH = 24;
/** Messages longer than this many lines start collapsed with "Show more". */
export const COLLAPSE_MESSAGE_LINES = 40;

/** http and https only; everything else (javascript:, data:, vbscript:, relative, …) is text. */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    // Credentials in a link (user:pass@host) only serve to disguise the real host.
    parsed.username = '';
    parsed.password = '';
    return parsed.href;
  } catch {
    return null;
  }
}

/** Plain text of any node (used for flattened, unknown or unsafe content). Iterative: never
 * recurses, so any depth is safe. */
export function textOf(root: Nodes): string {
  const out: string[] = [];
  const stack: Nodes[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if ('value' in node && typeof node.value === 'string') out.push(node.value);
    else if ('children' in node) {
      const children = node.children as Nodes[];
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
    } else if (node.type === 'image' || node.type === 'imageReference') out.push(node.alt ?? '');
  }
  return out.join('');
}

/** Splits text into strings and @mention chips for the room's member names. */
export function withMentions(text: string, names: readonly string[], key: string): ReactNode[] {
  if (!names.length || !text.includes('@')) return [text];
  const pattern = new RegExp(
    `@(?:${[...names]
      .sort((a, b) => b.length - a.length)
      .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|')})`,
    'g',
  );
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) out.push(text.slice(last, match.index));
    out.push(
      <span key={`${key}@${match.index}`} className="rm-mention">
        {match[0]}
      </span>,
    );
    last = match.index + match[0].length;
  }
  out.push(text.slice(last));
  return out;
}

type Context = {
  names: readonly string[];
  definitions: Map<string, { url: string; title?: string | null }>;
  /** Text still being written: code is shown without highlighting (it changes every frame). */
  forming?: boolean;
};

function collectDefinitions(root: Nodes, into: Context['definitions']) {
  const stack: Nodes[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === 'definition') {
      if (!into.has(node.identifier))
        into.set(node.identifier, { url: node.url, title: node.title });
    } else if ('children' in node) for (const child of node.children as Nodes[]) stack.push(child);
  }
}

/** True when the visible link text already names the destination host. */
export function textShowsHost(text: string, host: string): boolean {
  const shown = text
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '');
  const real = host.toLowerCase().replace(/^www\./, '');
  return shown === real || (/^[/?#:]/.test(shown.slice(real.length)) && shown.startsWith(real));
}

/**
 * A link out of a room: new tab, no opener, no referrer. When its text does not name the real
 * host (`[https://centralcity.ai](https://evil.example)`), the host follows it in muted text, and
 * the title always carries the full destination.
 */
function Link({ href, text, children }: { href: string; text: string; children: ReactNode }) {
  const host = new URL(href).host;
  return (
    <>
      <a href={href} title={href} target="_blank" rel="noopener nofollow ugc noreferrer">
        {children}
      </a>
      {textShowsHost(text, host) ? null : <span className="md-link-host"> ({host})</span>}
    </>
  );
}

function renderChildren(node: Nodes, ctx: Context, depth: number, key: string): ReactNode[] {
  if (!('children' in node)) return [];
  return (node.children as Nodes[]).map((child, index) =>
    renderNode(child, ctx, depth + 1, `${key}.${index}`),
  );
}

function renderNode(node: Nodes, ctx: Context, depth: number, key: string): ReactNode {
  if (depth > MAX_DEPTH) return <span key={key}>{textOf(node)}</span>;
  const kids = () => renderChildren(node, ctx, depth, key);
  switch (node.type) {
    case 'root':
      return kids();
    case 'paragraph':
      return <p key={key}>{kids()}</p>;
    case 'heading': {
      const level = Math.min(node.depth, 3);
      const Tag = (['h4', 'h5', 'h6'] as const)[level - 1]!;
      return (
        <Tag key={key} className={`md-h md-h${level}`}>
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
      return (
        <li key={key} className={typeof node.checked === 'boolean' ? 'md-task' : undefined}>
          {typeof node.checked === 'boolean' ? (
            <input
              type="checkbox"
              checked={node.checked}
              disabled
              readOnly
              aria-label={node.checked ? 'Done' : 'Not done'}
            />
          ) : null}
          {kids()}
        </li>
      );
    case 'code':
      return (
        <CodeBlock
          key={key}
          code={node.value}
          language={node.lang ?? ''}
          highlight={!ctx.forming}
        />
      );
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
      return <span key={key}>{withMentions(node.value, ctx.names, key)}</span>;
    // Raw HTML is never interpreted: it is shown exactly as typed.
    case 'html':
      return <span key={key}>{node.value}</span>;
    case 'link': {
      const href = safeHref(node.url);
      return href ? (
        <Link key={key} href={href} text={textOf(node)}>
          {kids()}
        </Link>
      ) : (
        <span key={key}>{kids()}</span>
      );
    }
    case 'linkReference': {
      const found = ctx.definitions.get(node.identifier);
      const href = safeHref(found?.url);
      return href ? (
        <Link key={key} href={href} text={textOf(node)}>
          {kids()}
        </Link>
      ) : (
        <span key={key}>{textOf(node) || node.label}</span>
      );
    }
    // Markdown images are not loaded (viewer IPs, CSP): a link to the image instead.
    case 'image':
    case 'imageReference': {
      const url = node.type === 'image' ? node.url : ctx.definitions.get(node.identifier)?.url;
      const href = safeHref(url);
      const label = `Image: ${node.alt || href || 'untitled'}`;
      return href ? (
        <Link key={key} href={href} text={label}>
          {label}
        </Link>
      ) : (
        <span key={key}>{label}</span>
      );
    }
    case 'definition':
      return null;
    case 'table': {
      const [head, ...body] = node.children;
      const align = node.align ?? [];
      const cells = (row: typeof head, Cell: 'th' | 'td', rowKey: string) =>
        row?.children.map((cell, index) => (
          <Cell
            key={`${rowKey}.${index}`}
            style={align[index] ? { textAlign: align[index]! } : undefined}
          >
            {renderChildren(cell, ctx, depth + 2, `${rowKey}.${index}`)}
          </Cell>
        ));
      return (
        <div key={key} className="md-table" tabIndex={0} role="region" aria-label="Table">
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
        <div key={key} className="md-footnote">
          <sup>[{node.label ?? node.identifier}]</sup> {kids()}
        </div>
      );
    default:
      return <span key={key}>{textOf(node)}</span>;
  }
}

/**
 * Renders Markdown text as React elements (see the module comment for the safety rules).
 *
 * In the browser the parse runs in a worker with a hard time budget (workerClient.ts); the
 * message shows as plain text until it arrives, and stays plain on timeout, pathological input
 * (guard.ts) or any failure, so one message can never freeze or break the room. `parse` runs a
 * synchronous parser instead (server rendering and unit tests).
 */
export function Markdown({
  text,
  names = [],
  parse,
  priority = 0,
}: {
  text: string;
  names?: readonly string[];
  parse?: (text: string) => ParseResult;
  /** Parse order: the message seq, so the newest are parsed first (on-screen ones before all). */
  priority?: number;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const nameKey = names.join('\u0000');
  const clean = withoutBidiControls(text);
  const truncated = clean.length > MAX_MARKDOWN_CHARS;
  const syncResult = useMemo(() => (parse ? parse(clean) : undefined), [parse, clean]);
  const [parsed, setParsed] = useState<{ text: string; result: ParseResult } | null>(() => {
    const result = parse ? undefined : cachedParse(clean);
    return result ? { text: clean, result } : null;
  });
  useEffect(() => {
    if (parse || parsed?.text === clean) return;
    let live = true;
    void parseInWorker(clean, priority).then((result) => {
      if (live) setParsed({ text: clean, result });
    });
    // A message on screen jumps the queue.
    const element = wrap.current;
    const observer =
      element && typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) prioritize(clean);
          })
        : null;
    if (element) observer?.observe(element);
    return () => {
      live = false;
      observer?.disconnect();
    };
  }, [clean, parse, parsed?.text, priority]);
  const result = syncResult ?? (parsed?.text === clean ? parsed.result : null);
  const content = useMemo(() => {
    if (!result || !('tree' in result)) return null;
    try {
      const definitions: Context['definitions'] = new Map();
      collectDefinitions(result.tree, definitions);
      return renderNode(result.tree, { names, definitions }, 0, 'm');
    } catch {
      return null;
    }
  }, [result, nameKey]);
  const long = clean.split('\n').length > COLLAPSE_MESSAGE_LINES;
  const [expanded, setExpanded] = useState(false);
  const state = content ? 'parsed' : result ? 'plain' : 'pending';
  return (
    <div className="md-body-wrap" ref={wrap}>
      <div className={`md-body${long && !expanded ? ' collapsed' : ''}`}>
        {content ?? (
          <p className="rm-text" data-markdown={state}>
            {withMentions(clean, names, 'p')}
          </p>
        )}
      </div>
      {content && truncated ? <p className="md-truncated">(message truncated)</p> : null}
      {long ? (
        <button
          type="button"
          className="md-quiet"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Renders a parsed tree as the children of an `.md-body` (no wrapper), for the streamed reveal
 * (Streaming.tsx), which renders an answer block by block. `forming`: the text is still being
 * written (code is not highlighted yet).
 */
export function renderTree(tree: Root, names: readonly string[] = [], forming = false): ReactNode {
  try {
    const definitions: Context['definitions'] = new Map();
    collectDefinitions(tree, definitions);
    return renderNode(tree, { names, definitions, forming }, 0, 'm');
  } catch {
    return null;
  }
}
