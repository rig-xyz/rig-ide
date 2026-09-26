import type { RoomMessageRow } from '../spaces/relay-api';
import type { PageAnchor } from './page-frame-scripts';

/**
 * A pin is a comment thread whose `path` is a page's link and whose anchor
 * carries `page` (where on the page). Pins are numbered by when they were
 * made, resolved ones included, so a number never changes under someone:
 * the panel and the agents' browser tools count the same way.
 */
export interface PinnedThread {
  n: number;
  id: string;
  comment: string;
  quote: string;
  anchor: PageAnchor;
  resolved: boolean;
  authorName: string | null;
}

export function isPageAnchor(value: unknown): value is PageAnchor {
  const a = value as Partial<PageAnchor> | null;
  return !!a && Array.isArray(a.xo) && Array.isArray(a.hops) && typeof a.path === 'string' && typeof a.tag === 'string';
}

export function pinsFromRows(rows: readonly RoomMessageRow[]): PinnedThread[] {
  return rows
    .filter((r) => !r.parentId && isPageAnchor(r.anchor?.page))
    .sort((a, b) => a.seq - b.seq)
    .map((r, i) => ({
      n: i + 1,
      id: r.id,
      comment: r.body,
      quote: r.quote ?? '',
      anchor: r.anchor!.page as unknown as PageAnchor,
      resolved: !!r.resolvedAt,
      authorName: r.author.name,
    }));
}
