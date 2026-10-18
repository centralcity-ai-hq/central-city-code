import type { DirectoryCard } from '../../shared/directory';
import { passportPath } from '../verify/onBaseData';

/**
 * Where Enter in the header's finder goes. A highlighted row counts only while the shown results
 * belong to the text in the box: right after typing (or pasting a Base ID) the old list is still on
 * screen until the new search answers, and Enter must not open an agent from that old list.
 */
export function finderEnterHref(
  shown: { agents: DirectoryCard[]; query: string } | null,
  text: string,
  active: number,
  pageHref: string,
): string {
  const card = shown && shown.query === text ? shown.agents[active] : undefined;
  return card ? passportPath(card.short) : pageHref;
}
