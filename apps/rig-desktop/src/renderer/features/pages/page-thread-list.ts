import type { PageThread } from '@shared/spaces/pages';

/**
 * The list under a page's comment count (`page-view.tsx`): every thread,
 * so one whose pin can't be placed on the page can still be opened.
 */

/** Open threads, then resolved ones, each in pin order. */
export function threadListGroups(threads: readonly PageThread[]): {
  open: PageThread[];
  resolved: PageThread[];
} {
  const byPin = (a: PageThread, b: PageThread) => a.n - b.n;
  return {
    open: threads.filter((t) => !t.resolved).sort(byPin),
    resolved: threads.filter((t) => t.resolved).sort(byPin),
  };
}

/** A comment as one line: its line breaks and runs of spaces folded. */
export function threadExcerpt(comment: string): string {
  return comment.replace(/\s+/g, ' ').trim();
}

/** "1 reply", "3 replies"; null when there are none. */
export function replyCountLabel(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? '1 reply' : `${count} replies`;
}
