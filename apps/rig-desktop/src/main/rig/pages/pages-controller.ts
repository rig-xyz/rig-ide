import { webContents as allWebContents, type WebContents } from 'electron';
import { err, ok, type Result } from '@emdash/shared';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { canonicalPageUrl } from '@shared/spaces/links';
import { log } from '@main/lib/logger';
import { runCommentTurnInRoom } from '../spaces/dispatch-controller-instance';
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

/**
 * What an agent asked from a pin is told, alongside the question: which page
 * and pin, and how to look at it. Its final message becomes its reply in the
 * pin's thread.
 */
export function pinHiddenContext(url: string, thread: Pick<PageThread, 'n' | 'quote' | 'anchor'>): string {
  const board = thread.anchor.hops[0]?.sig?.split(/\s+/).slice(0, 8).join(' ');
  return [
    '<rig_page_pin>',
    `This question was asked in a comment pinned on a web page open in the space: ${url}`,
    `It is about pin ${thread.n}, on a ${thread.anchor.tag} reading "${thread.quote}"${board ? ` (on the board starting "${board}")` : ''}.`,
    `Look at the page with browser_pins, browser_read and browser_screenshot (pin ${thread.n}) using that link; read a board in full rather than guessing at small text.`,
    "Your final message is posted as your reply in that pin's thread, where the person asked: keep it to a few sentences.",
    '</rig_page_pin>',
  ].join('\n');
}

const AGENT_LABEL = { claude: 'claude-code', codex: 'codex' } as const;

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

  /**
   * Your agent, asked from a pin: it runs in the Room like any turn (so
   * everyone sees it work), with the pin as context, and its answer is posted
   * as its reply in the pin's thread. Returns once the turn has started.
   */
  askAgent: async (input: { bindingId: string; url: string; threadId: string; agent: 'claude' | 'codex'; question: string }): Promise<Result<{ runId: string }, Failure>> => {
    const url = canonicalPageUrl(input.url);
    const rows = await api.listMessages(input.bindingId, { path: url, limit: 200 });
    const thread = rows.success ? threadsFromRows(rows.data).find((t) => t.id === input.threadId) : undefined;
    if (!thread) return err({ message: 'That pin is gone.' });
    const run = await runCommentTurnInRoom({
      bindingId: input.bindingId,
      agent: input.agent,
      prompt: input.question,
      hiddenContext: pinHiddenContext(url, thread),
      threadId: input.threadId,
    });
    if (!run) return err({ message: 'Your agents answer pins in a space only.' });
    if (!run.success) return err({ message: `Your ${input.agent === 'claude' ? 'Claude' : 'Codex'} couldn't start: ${run.error}` });
    void run.data.done.then(async ({ status, answer }) => {
      if (status !== 'done' || !answer.trim()) return;
      const posted = await api.postMessage(input.bindingId, {
        body: answer.trim().slice(0, 8000),
        parentId: input.threadId,
        authorKind: 'agent',
        meta: { agent: AGENT_LABEL[input.agent] },
      });
      if (!posted.success) log.warn('Rig pages: could not post the agent reply on the pin', { error: posted.error.message });
    });
    return ok({ runId: run.data.runId });
  },

  resolve: async (input: { bindingId: string; id: string; resolved: boolean }): Promise<Result<void, Failure>> => {
    if (!api.resolveThread) return err({ message: 'Resolving isn’t available.' });
    const done = await api.resolveThread(input.bindingId, input.id, input.resolved);
    return done.success ? ok(undefined) : err({ message: done.error.message });
  },
});
