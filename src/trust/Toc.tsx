import { useEffect, useState, type RefObject } from 'react';

/*
 * "On this page" for the long policy pages (design pages-v1). Built from the page's own section
 * headings (every h2 in the body has an id), so the legal texts stay untouched. Desktop: a sticky
 * column beside the text with the current section marked. Phone: a closed disclosure above it.
 */

type Section = { id: string; label: string };

/** The body's sections; `page` re-reads them when the same layout shows another page. */
export function useSections(body: RefObject<HTMLElement | null>, page: string): Section[] {
  const [sections, setSections] = useState<Section[]>([]);
  useEffect(() => {
    const root = body.current;
    if (!root) return;
    setSections(
      [...root.querySelectorAll<HTMLHeadingElement>('h2[id]')].map((heading) => ({
        id: heading.id,
        label: heading.textContent?.trim() ?? heading.id,
      })),
    );
  }, [body, page]);
  return sections;
}

/** The section whose heading was passed last while scrolling down. */
function useCurrent(sections: Section[]): string | null {
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    if (!sections.length || typeof IntersectionObserver === 'undefined') return;
    const headings = sections
      .map((section) => document.getElementById(section.id))
      .filter((heading): heading is HTMLElement => heading !== null);
    const observer = new IntersectionObserver(
      () => {
        const line = 120;
        let passed: string | null = null;
        for (const heading of headings)
          if (heading.getBoundingClientRect().top <= line) passed = heading.id;
        setCurrent(passed ?? headings[0]?.id ?? null);
      },
      { rootMargin: '0px 0px -60% 0px', threshold: [0, 1] },
    );
    for (const heading of headings) observer.observe(heading);
    return () => observer.disconnect();
  }, [sections]);
  return current;
}

function Links({ sections, current }: { sections: Section[]; current: string | null }) {
  return (
    <ol className="trust-toc-list">
      {sections.map((section) => (
        <li key={section.id}>
          <a href={`#${section.id}`} aria-current={section.id === current ? 'location' : undefined}>
            {section.label}
          </a>
        </li>
      ))}
    </ol>
  );
}

export function TocSidebar({ sections }: { sections: Section[] }) {
  const current = useCurrent(sections);
  if (sections.length < 2) return null;
  return (
    <nav className="trust-toc" aria-label="On this page">
      <p className="trust-toc-title">On this page</p>
      <Links sections={sections} current={current} />
    </nav>
  );
}

export function TocDisclosure({ sections }: { sections: Section[] }) {
  if (sections.length < 2) return null;
  return (
    <details className="trust-toc-mobile">
      <summary>On this page</summary>
      <Links sections={sections} current={null} />
    </details>
  );
}
