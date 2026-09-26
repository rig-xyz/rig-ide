import type { RoomMessageRow } from '../spaces/relay-api';
import type { PageAnchor, PageThread } from '@shared/spaces/pages';

export type { PageThread, PageThreadReply } from '@shared/spaces/pages';

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

function agentOf(meta: Record<string, unknown> | null): string | null {
  const agent = meta?.agent;
  return typeof agent === 'string' ? agent : null;
}

/** `nameOf` names an author the relay sent without one (it identifies them by id; the Room names them from the members list). */
export function threadsFromRows(rows: readonly RoomMessageRow[], nameOf: (userId: string | null) => string | null = () => null): PageThread[] {
  const byRow = new Map(rows.map((r) => [r.id, r]));
  return pinsFromRows(rows).map((pin) => {
    const root = byRow.get(pin.id)!;
    return {
      n: pin.n,
      id: pin.id,
      quote: pin.quote,
      comment: pin.comment,
      authorName: pin.authorName ?? nameOf(root.author.userId),
      createdAt: root.createdAt,
      resolved: pin.resolved,
      anchor: pin.anchor,
      replies: rows
        .filter((r) => r.parentId === pin.id)
        .sort((a, b) => a.seq - b.seq)
        .map((r) => ({
          id: r.id,
          body: r.body,
          authorName: r.author.name ?? nameOf(r.author.userId),
          agent: r.author.kind === 'agent' ? agentOf(r.meta) : null,
          createdAt: r.createdAt,
        })),
    };
  });
}

