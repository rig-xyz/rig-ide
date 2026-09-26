import { webContents as allWebContents, type WebContents } from 'electron';
import { err, ok, type Result } from '@emdash/shared';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { canonicalPageUrl } from '@shared/spaces/links';
import { createHttpSpacesRelayApi } from '../spaces/relay-api';
import { pagesSession } from './agent-pages';
import type { PageAnchor, PagePlace, PageThread } from '@shared/spaces/pages';
import { hitPage, locateOnPage } from './page-frames';
import { threadsFromRows } from './page-pins';

/**
 * The renderer's view of pages in the panel: placing and finding pins on the
 * page a `<webview>` shows, and a page's comment threads (pins) in a space.
 * Frame access stays here in main; the renderer only passes the webview's id,
 * and only a webview in the pages browser profile is ever touched.
 */

type Failure = { message: string };
const api = createHttpSpacesRelayApi();

function pageContents(id: number): WebContents | null {
  const wc = allWebContents.fromId(id);
  return wc && !wc.isDestroyed() && wc.session === pagesSession() ? wc : null;
}

/** What a new pin quotes: the element's text, else the board it's on. */
function quoteFor(anchor: PageAnchor): string {
  if (anchor.text) return anchor.text;
  const board = anchor.hops[0]?.sig?.split(/\s+/).slice(0, 6).join(' ');
  const what = ['rect', 'svg', 'path', 'canvas', 'g', 'circle', 'line'].includes(anchor.tag) ? 'Chart' : anchor.tag === 'img' ? 'Image' : 'Element';
  return board ? `${what} · ${board}` : what;
}

export const rigPagesController = createRPCController({
  hit: async ({ webContentsId, x, y }: { webContentsId: number; x: number; y: number }): Promise<Result<{ anchor: PageAnchor; quote: string } | null, Failure>> => {
    const page = pageContents(webContentsId);
    if (!page) return err({ message: 'That page is no longer open.' });
    const anchor = await hitPage(page, x, y).catch(() => null);
    return ok(anchor ? { anchor, quote: quoteFor(anchor).slice(0, 2000) } : null);
  },

  locate: async ({ webContentsId, pins }: { webContentsId: number; pins: { id: string; anchor: PageAnchor }[] }): Promise<Result<({ id: string } & PagePlace)[], Failure>> => {
    const page = pageContents(webContentsId);
    if (!page) return err({ message: 'That page is no longer open.' });
    const places = await Promise.all(pins.map(async (p) => ({ id: p.id, ...(await locateOnPage(page, p.anchor).catch(() => ({ found: false }))) })));
    return ok(places);
  },

  threads: async ({ bindingId, url }: { bindingId: string; url: string }): Promise<Result<PageThread[], Failure>> => {
    const [rows, members] = await Promise.all([api.listMessages(bindingId, { path: canonicalPageUrl(url), limit: 200 }), api.listMembers(bindingId)]);
    if (!rows.success) return err({ message: rows.error.message });
    const names = new Map<string, string>();
    for (const m of members.success ? members.data : []) {
      const name = m.name ?? m.email?.split('@')[0] ?? null;
      if (!name) continue;
      names.set(m.userId, name);
      if (m.clerkUserId) names.set(m.clerkUserId, name);
    }
    return ok(threadsFromRows(rows.data, (id) => (id ? (names.get(id) ?? null) : null)));
  },

  comment: async (input: { bindingId: string; url: string; body: string; quote: string; anchor: PageAnchor }): Promise<Result<{ id: string }, Failure>> => {
    const posted = await api.postMessage(input.bindingId, {
      body: input.body,
      path: canonicalPageUrl(input.url),
      anchor: { exact: input.quote.slice(0, 2000), page: input.anchor as unknown as Record<string, unknown> },
    });
    return posted.success ? ok({ id: posted.data.id }) : err({ message: posted.error.message });
  },

  reply: async (input: { bindingId: string; parentId: string; body: string }): Promise<Result<{ id: string }, Failure>> => {
    const posted = await api.postMessage(input.bindingId, { body: input.body, parentId: input.parentId });
    return posted.success ? ok({ id: posted.data.id }) : err({ message: posted.error.message });
  },

  resolve: async (input: { bindingId: string; id: string; resolved: boolean }): Promise<Result<void, Failure>> => {
    if (!api.resolveThread) return err({ message: 'Resolving isn’t available.' });
    const done = await api.resolveThread(input.bindingId, input.id, input.resolved);
    return done.success ? ok(undefined) : err({ message: done.error.message });
  },
});
