import type { RelayApiError, RoomMessageRow, SpacesRelayApi } from '../spaces/relay-api';
import { ok, type Result } from '@emdash/shared';
import { canonicalPageUrl, legacyPagePaths } from '@shared/spaces/links';
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

const PAGE_LIMIT = 200;
const MAX_PAGES = 50;

/**
 * Every message on a page's link, paging with `after` until a short page, so
 * pins and replies past the first 200 messages still load. The relay lists
 * them oldest first.
 */
export async function listAllMessages(
  api: Pick<SpacesRelayApi, 'listMessages'>,
  bindingId: string,
  path: string
): Promise<Result<RoomMessageRow[], RelayApiError>> {
  const all: RoomMessageRow[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await api.listMessages(bindingId, { path, limit: PAGE_LIMIT, ...(after ? { after } : {}) });
    if (!rows.success) {
      if (page === 0) return rows;
      break;
    }
    all.push(...rows.data);
    const last = rows.data.at(-1)?.seq;
    if (rows.data.length < PAGE_LIMIT || last === undefined || String(last) === after) break;
    after = String(last);
  }
  return ok(all);
}

/**
 * Every message on a page: under its key now (`canonicalPageUrl`) and the
 * keys pins had before one key per document (`legacyPagePaths`), merged in
 * the order they were posted, so existing pins stay.
 */
export async function listPageMessages(
  api: Pick<SpacesRelayApi, 'listMessages'>,
  bindingId: string,
  url: string
): Promise<Result<RoomMessageRow[], RelayApiError>> {
  const [now, ...before] = await Promise.all(
    [canonicalPageUrl(url), ...legacyPagePaths(url)].map((path) => listAllMessages(api, bindingId, path))
  );
  if (!now!.success) return now!;
  const byId = new Map(now!.data.map((r) => [r.id, r]));
  for (const rows of before) if (rows.success) for (const r of rows.data) if (!byId.has(r.id)) byId.set(r.id, r);
  return ok([...byId.values()].sort((a, b) => a.seq - b.seq));
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

