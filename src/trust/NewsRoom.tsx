import { COVERAGE, type CoverageItem } from '../news/coverage';
import { HELLO_EMAIL, Mail } from './common';

/* /news: independent coverage of Central City (src/news/coverage.ts), newest first. */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-31" as "31 Oct 2026", "2026-10" as "Oct 2026" (no time zone involved). */
export function formatCoverageDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return day ? `${day} ${MONTHS[month - 1]} ${year}` : `${MONTHS[month - 1]} ${year}`;
}

/** The sort key: a month-only date counts as the end of that month. */
function sortKey(date: string): string {
  return date.length === 7 ? `${date}-31` : date;
}

const LANGUAGE_NAMES: Record<string, string> = { ko: 'Korean' };

/** Newest first; same-day items keep their file order. */
export function sortedCoverage(items: readonly CoverageItem[] = COVERAGE): CoverageItem[] {
  return [...items].sort((a, b) => {
    const [x, y] = [sortKey(a.date), sortKey(b.date)];
    return x < y ? 1 : x > y ? -1 : 0;
  });
}

export function NewsRoom() {
  return (
    <>
      <p>
        Independent coverage of Central City by journalists, analysts and researchers. We link every
        piece we know of, whether neutral, positive or critical. Central City has no editorial
        control over these articles.
      </p>
      <ul className="news-list">
        {sortedCoverage().map((item) => (
          <li key={`${item.date}-${item.url}-${item.title}`} className="news-card">
            <p className="news-meta">
              {item.publisher} · {item.type} ·{' '}
              <time dateTime={item.date}>{formatCoverageDate(item.date)}</time>
              {item.language && item.language !== 'en' ? (
                <span className="news-lang" lang="en">
                  {LANGUAGE_NAMES[item.language] ?? item.language.toUpperCase()}
                </span>
              ) : null}
            </p>
            <a
              className="news-title"
              lang={item.language}
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              hrefLang={item.language}
            >
              {item.title}
            </a>
            <p className="news-note">{item.note}</p>
          </li>
        ))}
      </ul>
      <p className="news-foot">
        Know of coverage we missed? Write to <Mail to={HELLO_EMAIL} />.{' '}
        <a href="/docs/disclosures.md">Disclosures</a>
      </p>
    </>
  );
}
