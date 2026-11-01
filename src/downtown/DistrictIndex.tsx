import { useEffect, useState } from 'react';
import { STATUS_LABEL, orderedDistricts, sourcePath, type DowntownData } from './data';

/*
 * The districts: one slim row per district under its group, in the same hairline style as the
 * repository list. A row shows the number, name, a one-line summary, the version and the status;
 * opening it (a native <details>) shows the whole description, what it includes, where it lives
 * and the GitHub link right under the row, so what changes is always where the reader clicked.
 *
 * A link to /downtown#district-<id> opens that row, scrolls to it and marks it. Render touches
 * no browser globals (the page may be prerendered).
 */

const pad = (n: number) => String(n).padStart(2, '0');

export function DistrictIndex({ data }: { data: DowntownData }) {
  const districts = orderedDistricts(data);
  const [targetId, setTargetId] = useState<string | null>(null);

  // Follow a direct link to a district once, and whenever the hash changes.
  useEffect(() => {
    const follow = () => {
      const match = /^#district-([a-z0-9-]+)$/.exec(window.location.hash);
      if (!match || !districts.some((d) => d.id === match[1])) return setTargetId(null);
      setTargetId(match[1]);
      requestAnimationFrame(() => {
        const row = document.getElementById(`district-${match[1]}`);
        if (row instanceof HTMLDetailsElement) row.open = true;
        row?.scrollIntoView({ block: 'center' });
      });
    };
    follow();
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
    // The district list only changes with the data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  if (districts.length === 0) return null;
  const groups = data.categories
    .map((category) => ({
      category,
      members: districts.filter((d) => d.category === category.id),
    }))
    .filter((group) => group.members.length > 0);

  return (
    <section id="districts" className="dt-section dt-districts" aria-labelledby="districts-title">
      <div className="dt-section-head">
        <h2 id="districts-title">{districtsTitle(districts.length)}</h2>
        <p>
          Every part of Central City that is public, grouped by what you would use it for. Open a
          district to see what it contains and where its code lives.
        </p>
      </div>

      {groups.map(({ category, members }) => (
        <div
          key={category.id}
          id={`group-${category.id}`}
          className="dt-group"
          role="group"
          aria-labelledby={`group-title-${category.id}`}
        >
          <div className="dt-group-head">
            <h3 id={`group-title-${category.id}`}>{category.name}</h3>
            <p>{category.summary}</p>
          </div>
          <div className="dt-rows">
            {members.map((d) => {
              const number = districts.indexOf(d) + 1;
              const path = sourcePath(d).slice(1);
              const githubUrl = d.source ?? d.repository;
              const [lead] = splitPurpose(d.purpose);
              return (
                <details
                  key={d.id}
                  id={`district-${d.id}`}
                  className={d.id === targetId ? 'dt-row dt-row-target' : 'dt-row'}
                >
                  <summary>
                    <span className="dt-row-no dt-mono">{pad(number)}</span>
                    <span className="dt-row-text">
                      <span className="dt-row-name">{d.name}</span>
                      <span className="dt-row-lead">{lead}</span>
                    </span>
                    <span className="dt-row-version dt-mono">{d.version ?? '–'}</span>
                    <span className={`dt-row-status dt-row-status-${d.status}`}>
                      {STATUS_LABEL[d.status]}
                    </span>
                    <svg className="dt-row-chevron" viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M4 6l4 4 4-4" />
                    </svg>
                  </summary>
                  <div className="dt-row-body">
                    <p className="dt-row-purpose">{d.purpose}</p>
                    {d.includes?.length ? (
                      <ul className="dt-row-includes" aria-label="Includes">
                        {d.includes.map((item) => (
                          <li key={item} className="dt-mono">
                            {item}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <p className="dt-row-foot">
                      <span className="dt-mono">{d.version ?? 'Not released yet'}</span>
                      <span>{STATUS_LABEL[d.status]}</span>
                      <span className="dt-row-path dt-mono">
                        {path.length ? path.join(' / ') : 'No repository yet'}
                      </span>
                      <span>{d.license}</span>
                      {githubUrl ? (
                        <a href={githubUrl} aria-label={`${d.name} on GitHub`}>
                          Open on GitHub <span aria-hidden="true">↗</span>
                        </a>
                      ) : null}
                    </p>
                  </div>
                </details>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}

/**
 * The first sentence of a purpose (the row's one-line summary), and the rest. The row body shows
 * the whole purpose, so no word of the data is dropped.
 */
export function splitPurpose(purpose: string): [string, string | null] {
  const match = /^(.{40,}?[.!?])\s+(?=[A-Z/`])/s.exec(purpose);
  if (!match || purpose.length < 220) return [purpose, null];
  return [match[1], purpose.slice(match[0].length).trim() || null];
}

const WORDS = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
  'Twenty',
];

/** "Eighteen districts." for small counts, "24 districts." beyond twenty. */
export function districtsTitle(count: number): string {
  const word = WORDS[count] ?? String(count);
  return `${word} district${count === 1 ? '' : 's'}.`;
}
