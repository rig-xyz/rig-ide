import { execFile } from 'node:child_process';
import { webContents as allWebContents, shell, type WebContents } from 'electron';
import { err, ok, type Result } from '@emdash/shared';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { signInSiteForUrl, type BrowserId } from '@shared/pages/sign-in-sites';
import { canonicalPageUrl } from '@shared/spaces/links';
import { log } from '@main/lib/logger';
import { runCommentTurnInRoom } from '../spaces/dispatch-controller-instance';
import { createHttpSpacesRelayApi } from '../spaces/relay-api';
import { isPagesBrowserSession, pagesSession, rigFilesSession } from './agent-pages';
import { CHROMIUM_BROWSERS, installedBrowsers } from './chrome-sign-in';
import { linkTitle } from './link-titles';
import type { AutoSignInOutcome } from './page-sign-ins';
import { pageSignIns, startPageSignInsKeepInStep } from './page-sign-ins-instance';
import { isPanelPage } from './panel-page';
import { watchPins } from './pin-watch';
import { applyPageZoom, watchZoomKeys } from './page-zoom';
import { rigFileExternalUrl } from './rig-file-protocol';
import { rigFileDeps } from './rig-file-session';
import { pageAccess } from './sign-in-check';
import { events } from '@main/lib/events';
import { pagePinsMovedChannel } from '@shared/pages/pin-events';
import { pageZoomKeyChannel } from '@shared/pages/page-zoom';
import { normalizeBrowserZoomFactor } from '@shared/browser';
import type { PageAnchor, PagePlace, PageThread } from '@shared/spaces/pages';
import { hitPage, locateOnPage } from './page-frames';
import { listPageMessages, threadsFromRows } from './page-pins';
import { createPinMissLog } from './pin-miss-log';

/**
 * The renderer's view of pages in the panel: placing and finding pins on the
 * page a `<webview>` shows, and a page's comment threads (pins) in a space.
 * Frame access stays here in main; the renderer only passes the webview's id,
 * and only a webview in the pages browser profile is ever touched.
 */

type Failure = { message: string };
const api = createHttpSpacesRelayApi();
const logPinMiss = createPinMissLog((message, fields) => log.info(message, fields));

function pageContents(id: number): WebContents | null {
  const wc = allWebContents.fromId(id);
  return wc && !wc.isDestroyed() && isPagesBrowserSession(wc.session) ? wc : null;
}

/** A page the person opened in the panel, a web page or a space's file: pins and zoom work on both. */
function panelPage(wc: WebContents | null | undefined): boolean {
  return isPanelPage(wc, pagesSession()) || isPanelPage(wc, rigFilesSession());
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
    `Look at the page with rig_browser_pins, rig_browser_read and rig_browser_screenshot (pin ${thread.n}) using that link; read a board in full rather than guessing at small text.`,
    "Your final message is posted as your reply in that pin's thread, where the person asked: keep it to a few sentences.",
    '</rig_page_pin>',
  ].join('\n');
}

const AGENT_LABEL = { claude: 'claude-code', codex: 'codex' } as const;

/** Privacy & Security › Files & Folders, where macOS's "access data from other apps" is turned back on. */
export const FILES_AND_FOLDERS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders';

startPageSignInsKeepInStep();

export const rigPagesController = createRPCController({
  /**
   * Signing pages in (board 18). A site is its registrable domain
   * (`@shared/pages/sign-in-sites`). Settings › Sign-ins and the page chip
   * read `signIns`; the sheet runs `signInOptions` → `signIn`.
   */
  signIns: () => pageSignIns.list(),

  /** Profiles signed in to the site in each installed browser (names and last use, no cookies). */
  signInOptions: ({ site, pageUrl }: { site: string; pageUrl?: string }) => pageSignIns.options(site, pageUrl),

  /** The person's pick: macOS asks before the browser's key is handed over; cookies are written only once the check passes. */
  signIn: (input: { site: string; browser: BrowserId; profile: string; pageUrl?: string }) => pageSignIns.signIn(input),

  /** "Refresh from Chrome": the same profile again. */
  refreshSignIn: ({ site }: { site: string }) => pageSignIns.refresh(site),

  /** The sheet's Cancel, mid-read or mid-check: nothing is written. */
  cancelSignIn: ({ site }: { site: string }): void => pageSignIns.cancel(site),

  /** Forget a site's sign-in in rig's pages (every host that was copied); the browser is untouched. */
  signOut: ({ site }: { site: string }) => pageSignIns.signOut(site),

  setKeepInStep: ({ on }: { on: boolean }): void => pageSignIns.setKeepInStep(on),

  /** "Connect Chrome": installed browsers' profiles (after the heads-up: reading them is what macOS asks about). */
  connectOptions: () => pageSignIns.connectOptions(),

  /** "Connect Chrome": the chosen profile, with the one Keychain read. */
  connect: (input: { browser: BrowserId; profile: string }) => pageSignIns.connect(input),

  cancelConnect: (): void => pageSignIns.cancelConnect(),

  disconnect: (opts: { signOutAll?: boolean }) => pageSignIns.disconnect(opts),

  /**
   * A page the person opened loaded (or hit a sign-in wall) and rig has no
   * sign-in for its site: sign it in from the connected profile. Only for a
   * panel page (`isPanelPage`), never an agent's tab.
   */
  autoSignIn: async (input: { webContentsId: number; pageUrl: string; retry?: boolean }): Promise<AutoSignInOutcome> => {
    if (!isPanelPage(allWebContents.fromId(input.webContentsId), pagesSession())) return { ok: false, reason: 'not_a_panel_page' };
    return pageSignIns.autoSignIn({ pageUrl: input.pageUrl, ...(input.retry ? { retry: true } : {}) });
  },

  /**
   * Whether the page in a panel webview is on a sign-in wall (a known
   * sign-in host, a sign-in path, a password field). A wall on the page's
   * site (the one its link belongs to, not the sign-in host it was sent to)
   * marks rig's copy of that sign-in expired. `notShared`: signed in, but
   * the site's own page says this account can't see it (case 8; known sites only).
   */
  signInWall: async ({ webContentsId, site }: { webContentsId: number; site?: string }): Promise<{ wall: boolean; notShared: boolean }> => {
    const page = pageContents(webContentsId);
    if (!page) return { wall: false, notShared: false };
    const access = await pageAccess(page);
    if (access.wall && site) pageSignIns.markWall(site);
    return access;
  },

  /** Opens System Settings at Files & Folders (case 2). */
  openPrivacySettings: async (): Promise<void> => {
    await shell.openExternal(FILES_AND_FOLDERS_URL);
  },

  /** "Open in Chrome": the page in the named browser (else the first Chromium one installed, else the default browser). */
  openInBrowser: async ({ url, browser }: { url: string; browser?: BrowserId }): Promise<void> => {
    if (!signInSiteForUrl(url)) return;
    const spec = (browser && CHROMIUM_BROWSERS.find((b) => b.id === browser)) || installedBrowsers()[0];
    if (!spec) return void (await shell.openExternal(url));
    await new Promise<void>((resolve) => execFile('open', ['-b', spec.bundleId, url], () => resolve()));
  },

  /**
   * "Open in browser" on a space's file page: the real file in the default
   * browser, resolved the way `rig-file://` serves it. False when the
   * protocol would refuse it, so nothing opens.
   */
  openRigFileInBrowser: async ({ url }: { url: string }): Promise<boolean> => {
    const fileUrl = await rigFileExternalUrl(rigFileDeps, url);
    if (!fileUrl) return false;
    await shell.openExternal(fileUrl);
    return true;
  },

  /** The name behind a Claude or Google link chip, read from the page as the person sees it; null when it can't be named. */
  linkTitle: ({ url }: { url: string }): Promise<string | null> => linkTitle(url),

  hit: async ({ webContentsId, x, y }: { webContentsId: number; x: number; y: number }): Promise<Result<{ anchor: PageAnchor; quote: string } | null, Failure>> => {
    const page = pageContents(webContentsId);
    if (!page) return err({ message: 'That page is no longer open.' });
    const anchor = await hitPage(page, x, y).catch(() => null);
    return ok(anchor ? { anchor, quote: quoteFor(anchor).slice(0, 2000) } : null);
  },

  /** What a click at (x, y) would pin, as its outline on the page: comment mode's hover. */
  peek: async ({ webContentsId, x, y }: { webContentsId: number; x: number; y: number }): Promise<{ x: number; y: number; w: number; h: number } | null> => {
    const page = pageContents(webContentsId);
    if (!page) return null;
    const anchor = await hitPage(page, x, y).catch(() => null);
    if (!anchor) return null;
    const at = await locateOnPage(page, anchor).catch(() => null);
    if (!at?.found || at.x === undefined || at.y === undefined || at.w === undefined || at.h === undefined) return null;
    return { x: at.x - anchor.fx * at.w, y: at.y - anchor.fy * at.h, w: at.w, h: at.h };
  },

  /**
   * Pins follow the page by events, not polling: a watcher in the panel
   * page says when it moved, and `pagePinsMovedChannel` tells the renderer
   * to `locate` again. Panel pages only; once per page.
   */
  watchPins: ({ webContentsId }: { webContentsId: number }): boolean => {
    const wc = allWebContents.fromId(webContentsId);
    if (!wc || !panelPage(wc)) return false;
    watchPins(wc, () => events.emit(pagePinsMovedChannel, { webContentsId }));
    return true;
  },

  /**
   * A panel page's zoom (`@shared/pages/page-zoom`): `factor` is relative to
   * the app's own zoom. The first call also routes the page's ⌘+/⌘−/⌘0 and
   * Ctrl-scroll to the panel (`pageZoomKeyChannel`) instead of the menu.
   * Panel pages only.
   */
  setZoom: ({ webContentsId, factor }: { webContentsId: number; factor: number }): boolean => {
    const wc = allWebContents.fromId(webContentsId);
    if (!wc || !panelPage(wc)) return false;
    watchZoomKeys(wc, (key) => events.emit(pageZoomKeyChannel, { webContentsId, key }));
    applyPageZoom(wc, normalizeBrowserZoomFactor(factor));
    return true;
  },

  locate: async ({ webContentsId, pins }: { webContentsId: number; pins: { id: string; anchor: PageAnchor }[] }): Promise<Result<({ id: string } & PagePlace)[], Failure>> => {
    const page = pageContents(webContentsId);
    if (!page) return err({ message: 'That page is no longer open.' });
    const places = await Promise.all(
      pins.map(async (p) => {
        const at: PagePlace = await locateOnPage(page, p.anchor).catch(() => ({ found: false, why: 'error' }));
        // Why a pin isn't drawn for someone: once per page, pin and reason.
        if (!at.found) logPinMiss(page.getURL(), p, at.why);
        return { id: p.id, ...at };
      })
    );
    return ok(places);
  },

  threads: async ({ bindingId, url }: { bindingId: string; url: string }): Promise<Result<PageThread[], Failure>> => {
    const [rows, members] = await Promise.all([listPageMessages(api, bindingId, url), api.listMembers(bindingId)]);
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

  /**
   * `asks`: the agent the renderer will ask itself right after (`askAgent`),
   * saved as `meta.asks` so the relay's dispatcher doesn't ask it again.
   */
  comment: async (input: { bindingId: string; url: string; title?: string; body: string; quote: string; anchor: PageAnchor; asks?: 'claude' | 'codex' }): Promise<Result<{ id: string }, Failure>> => {
    const path = canonicalPageUrl(input.url);
    // The pin's number, saved with it so the chat can show it without the
    // page's whole history: pins number in the order they were made.
    const existing = await listPageMessages(api, input.bindingId, input.url);
    const pin = existing.success ? threadsFromRows(existing.data).length + 1 : undefined;
    const posted = await api.postMessage(input.bindingId, {
      body: input.body,
      path,
      anchor: { exact: input.quote.slice(0, 2000), page: input.anchor as unknown as Record<string, unknown> },
      // So the chat names the page for everyone, whether or not they can open it.
      meta: {
        ...(input.title ? { pageTitle: input.title.slice(0, 200) } : {}),
        ...(pin ? { pin } : {}),
        ...(input.asks ? { asks: input.asks } : {}),
      },
    });
    return posted.success ? ok({ id: posted.data.id }) : err({ message: posted.error.message });
  },

  reply: async (input: { bindingId: string; parentId: string; body: string; asks?: 'claude' | 'codex' }): Promise<Result<{ id: string }, Failure>> => {
    const posted = await api.postMessage(input.bindingId, {
      body: input.body,
      parentId: input.parentId,
      ...(input.asks ? { meta: { asks: input.asks } } : {}),
    });
    return posted.success ? ok({ id: posted.data.id }) : err({ message: posted.error.message });
  },

  /**
   * Your agent, asked from a pin: it runs in the Room like any turn (so
   * everyone sees it work), with the pin as context, and its answer is posted
   * as its reply in the pin's thread. Returns once the turn has started.
   */
  askAgent: async (input: { bindingId: string; url: string; threadId: string; agent: 'claude' | 'codex'; question: string }): Promise<Result<{ runId: string }, Failure>> => {
    const url = canonicalPageUrl(input.url);
    const rows = await listPageMessages(api, input.bindingId, input.url);
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
