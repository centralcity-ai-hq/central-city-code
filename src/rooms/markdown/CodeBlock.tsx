import { useEffect, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import type { Root, RootContent } from 'hast';

type Highlighter = (language: string, code: string) => Root | null;
let loader: Promise<Highlighter> | null = null;
/** Loads the highlighting chunk once, the first time a code block renders. */
export function loadHighlighter(): Promise<Highlighter> {
  loader ??= import('./highlight').then((module) => module.highlight);
  return loader;
}

/** Above this many lines a block starts collapsed to 480 px with "Show all". */
const COLLAPSE_LINES = 24;

/**
 * lowlight's hast → React. Only spans and text exist in its output; anything else would be
 * rendered as its text content, never as markup. Class names are limited to hljs tokens.
 */
function renderHast(nodes: RootContent[], prefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${prefix}.${index}`;
    if (node.type === 'text') return node.value;
    if (node.type !== 'element') return null;
    const raw = node.properties?.className;
    const classes = (Array.isArray(raw) ? raw : [])
      .map(String)
      .filter((name) => /^hljs-[a-z_-]+$/.test(name))
      .join(' ');
    return (
      <span key={key} className={classes || undefined}>
        {renderHast(node.children, key)}
      </span>
    );
  });
}

export function CodeBlock({
  code,
  language,
  highlight = true,
}: {
  code: string;
  language: string;
  /** False while the code is still being written (streamed answers): plain until complete. */
  highlight?: boolean;
}) {
  const [tree, setTree] = useState<Root | null>(null);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const lang = language.trim().split(/\s+/)[0] ?? '';
  useEffect(() => {
    let live = true;
    setTree(null);
    if (!lang || !highlight) return;
    loadHighlighter()
      .then((run) => {
        if (live) setTree(run(lang, code));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [code, lang, highlight]);
  const long = code.split('\n').length > COLLAPSE_LINES;
  return (
    <div className="md-code" data-language={lang || undefined}>
      <div className="md-code-bar">
        <span className="md-code-lang">{lang || 'text'}</span>
        <button
          type="button"
          className="md-code-copy"
          aria-label="Copy code"
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 2000);
            });
          }}
        >
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre
        className={`md-code-pre${long && !expanded ? ' collapsed' : ''}`}
        tabIndex={0}
        aria-label={`${lang || 'Text'} code`}
      >
        <code className={tree ? 'hljs' : undefined}>
          {tree ? renderHast(tree.children, 'h') : code}
        </code>
      </pre>
      {long ? (
        <button
          type="button"
          className="md-quiet"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show less' : 'Show all'}
        </button>
      ) : null}
    </div>
  );
}
