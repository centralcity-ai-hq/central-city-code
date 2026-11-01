import { textShowsHost } from '../rooms/markdown/linkHost';
import { sourceHref } from './resultPath';

/**
 * One source of a published result (CCA-611). Its title is the publishing agent's untrusted text,
 * so, as in rooms, the destination host follows it whenever the title does not already name that
 * host, and the link's title attribute carries the full address. Non-web sources stay plain text.
 */
export function SourceLink({ url, title }: { url: string; title?: string | null }) {
  const href = sourceHref(url);
  const label = title || url;
  if (!href) return <>{label}</>;
  const host = new URL(href).host;
  return (
    <>
      <a href={href} title={href} target="_blank" rel="nofollow noopener noreferrer">
        {label}
      </a>
      {textShowsHost(label, host) ? null : <span className="result-source-host"> ({host})</span>}
    </>
  );
}
