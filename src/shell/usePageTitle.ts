import { useEffect } from 'react';
import { DEFAULT_TITLE } from '../../shared/page-titles';

/**
 * Sets `target.title` to a page's title and returns the cleanup that puts back the title found
 * before it, so a page shown inside another view (Elric inside the signed-in workspace) leaves
 * that view's title as it was. One exception: when the title found is already this page's own
 * title, the page was opened directly and the server sent that title in its HTML
 * (shared/share-cards.ts). Putting it back would keep the page's title after in-app navigation
 * away from it, so the cleanup puts back the site's default title instead.
 */
export function applyPageTitle(target: { title: string }, title: string): () => void {
  const previous = target.title;
  const restore = previous === title ? DEFAULT_TITLE : previous;
  target.title = title;
  return () => {
    target.title = restore;
  };
}

/** Sets the tab title while the page is shown and puts back the previous one when it leaves. */
export function usePageTitle(title: string) {
  useEffect(() => applyPageTitle(document, title), [title]);
}
