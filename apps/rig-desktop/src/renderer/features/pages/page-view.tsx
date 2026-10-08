import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { WebviewTag } from 'electron';
import { ExternalLink } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useViewRequest } from '@renderer/features/artifact/view-request';
import { useRunnableAgents, type RunnableAgent } from '@renderer/features/chat/use-runnable-agents';
import { CommentCount, CommentModeControl, CommentModeStatus, shortAgentName } from '@renderer/features/comment-mode/comment-mode-ui';
import { useCommentMode } from '@renderer/features/comment-mode/use-comment-mode';
import {
  COMMENT_PLACEHOLDER,
  CommentCardAuthor,
  CommentCardFrame,
  CommentCardQuote,
  CommentCardTo,
  CommentNumber,
  REPLY_PLACEHOLDER,
} from '@renderer/features/comment-mode/comment-card';
import { PaintbrushCursorChip } from '@renderer/features/docs/paintbrush/paintbrush-cursor-chip';
import { roomSourceCache } from '@renderer/features/spaces/room-source-cache';
import { events, rpc } from '@renderer/lib/ipc';
import { AgentIcon } from '@renderer/lib/ui/agent-icon';
import { Button } from '@renderer/lib/ui/button';
import { Textarea } from '@renderer/lib/ui/textarea';
import { cn } from '@renderer/lib/utils';
import { pagePinsMovedChannel } from '@shared/pages/pin-events';
import { pageZoomKeyChannel, pageZoomSite } from '@shared/pages/page-zoom';
import { isSignInWall, KNOWN_SIGN_IN_SITES, signInSiteForUrl } from '@shared/pages/sign-in-sites';
import { canonicalPageUrl, partitionForPage } from '@shared/spaces/links';
import type { PageAnchor, PagePlace, PageThread } from '@shared/spaces/pages';
import { AccountChip, SignInBanner } from './account-chip';
import { clearAutoSignIn, getAutoState, registerPanelPage, runAutoSignIn } from './auto-sign-in';
import { ConnectSheet } from './connect-sheet';
import { NotSharedNotice } from './not-shared-notice';
import { replyCountLabel, threadExcerpt, threadListGroups } from './page-thread-list';
import { PageZoomControl, usePageZoom } from './page-zoom';
import { startRelocator, type Relocator } from './pin-relocator';
import { SignInSheet } from './sign-in-sheet';
import { recordFor, useSignIns } from './use-sign-ins';

/**
 * A web page (a Claude artifact, a Google Doc) open beside the Room, as the
 * member sees it: the real page in the pages browser profile, with the
 * space's comments pinned on it. Pins are comment threads like a file's
 * (same Room row, thread, @mentions, Resolve); their places are found again
 * by main (`rig.pages.locate`) as the page scrolls, zooms or changes.
 * Design: canvas board 15.
 */

type Thread = PageThread;
type Place = PagePlace;
type Draft = { anchor: PageAnchor; quote: string; x: number; y: number };

type RoomAgent = 'claude' | 'codex';
/** The agents that answer pins: the ones a space's Room can run. */
const ROOM_AGENTS: readonly string[] = ['claude', 'codex'] satisfies RoomAgent[];

/** Which of the member's agents a comment asks, if any: "@claude …", "@codex …". */
function mentionedAgent(body: string): RoomAgent | null {
  const m = /(?:^|\s)@(claude|codex)\b/i.exec(body);
  return m ? (m[1]!.toLowerCase() as RoomAgent) : null;
}
/** The threads' slow poll: new pins and replies arrive live from the Room; this catches resolves and a Room that isn't open. */
const THREADS_EVERY_MS = 15_000;

/** Pages whose sign-in banner was hidden (✕), for this run of the app. */
const bannerDismissed = new Set<string>();
/** After a load settles, a moment for script redirects before looking for a sign-in wall. */
const WALL_CHECK_DELAY_MS = 700;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function PageView({
  url,
  title,
  bindingId,
  onTitle,
  reloadKey,
}: {
  url: string;
  title: string;
  bindingId: string;
  /** The page's own title, once it loads: the tab takes it. */
  onTitle?: (title: string) => void;
  /** Changing it reloads the page: a space's file that was just written. */
  reloadKey?: number;
}) {
  // Held in a ref: a new callback from the parent must not recreate the page.
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;
  const hostRef = useRef<HTMLDivElement>(null);
  const [stageWidth, setStageWidth] = useState(800);
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setStageWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const [webContentsId, setWebContentsId] = useState<number | null>(null);
  // The page's zoom: fitted to the panel until you choose one for the site.
  const zoom = usePageZoom(useMemo(() => pageZoomSite(url), [url]), stageWidth);
  const applyZoomRef = useRef<() => void>(() => {});
  applyZoomRef.current = () => {
    if (webContentsId !== null) void rpc.rig.pages.setZoom({ webContentsId, factor: zoom.factor });
  };
  // Again when the app's own zoom changes (the webview follows it otherwise).
  const appZoom = window.devicePixelRatio;
  useEffect(() => applyZoomRef.current(), [webContentsId, zoom.factor, appZoom]);
  const pressZoomRef = useRef(zoom.press);
  pressZoomRef.current = zoom.press;
  useEffect(() => {
    if (webContentsId === null) return;
    return events.on(pageZoomKeyChannel, (d) => d.webContentsId === webContentsId && pressZoomRef.current(d.key));
  }, [webContentsId]);
  const { agents: runnable } = useRunnableAgents();
  const agents = useMemo(() => runnable.filter((a) => ROOM_AGENTS.includes(a.id)), [runnable]);
  const commentMode = useCommentMode(agents);
  const commenting = commentMode.on;
  const setCommenting = commentMode.setOn;
  const who = commentMode.who;
  const layerRef = useRef<HTMLDivElement>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [places, setPlaces] = useState<Record<string, Place>>({});
  const [showResolved, setShowResolved] = useState(false);
  const viewRef = useRef<WebviewTag | null>(null);
  // Signing the page in (board 18): the chip in the header, the banner on a
  // sign-in wall, the sheet over the page. The page always loads.
  const site = useMemo(() => signInSiteForUrl(url), [url]);
  const signIns = useSignIns();
  const record = recordFor(signIns.data, site?.id);
  const [wall, setWall] = useState(false);
  // Signed in, but the site's own page says this account can't see it (case 8); hidden for this load with ✕.
  const [notShared, setNotShared] = useState(false);
  const [notSharedHidden, setNotSharedHidden] = useState(false);
  const [bannerHidden, setBannerHidden] = useState(() => bannerDismissed.has(url));
  const siteIdRef = useRef(site?.id);
  siteIdRef.current = site?.id;
  // Read from the webview's events: whether this page should try an automatic sign-in now.
  const wantsAutoRef = useRef(false);
  wantsAutoRef.current = !!site && !!signIns.data?.connection && (!record || !!record.expired);
  const browserId = useMemo(() => `rig-page-${Math.random().toString(36).slice(2)}`, []);
  const where = `page:${browserId}`;
  const queryClient = useQueryClient();

  // The page itself: registered as one of the app's browsers (so the
  // webview is allowed to attach and gets the browser hardening), created
  // with its profile set before it attaches.
  useEffect(() => {
    let cancelled = false;
    let view: WebviewTag | null = null;
    let wallTimer: ReturnType<typeof setTimeout> | null = null;
    let unregister: (() => void) | null = null;
    let looked = false;
    // A space's file opens in a profile of its own, with none of the person's web sign-ins.
    const partition = partitionForPage(url);
    void rpc.browser.registerSession({ browserId, partition }).then(() => {
      if (cancelled || !hostRef.current) return;
      view = document.createElement('webview') as WebviewTag;
      viewRef.current = view;
      view.setAttribute('partition', partition);
      view.setAttribute('src', url);
      view.className = 'absolute inset-0 size-full';
      view.addEventListener('dom-ready', () => {
        const id = view!.getWebContentsId();
        setWebContentsId(id);
        void rpc.browser.bindWebContents({ browserId, webContentsId: id });
        // The page the person opened: where this site's automatic sign-in (and its retries) goes.
        if (siteIdRef.current && !unregister) unregister = registerPanelPage(siteIdRef.current, { webContentsId: id, pageUrl: url });
      });
      view.addEventListener('page-title-updated', (event) => {
        // A sign-in page's title ("Sign in – Google Accounts") is not a title for the tab.
        if (!isSignInWall({ url: view!.getURL() })) onTitleRef.current?.((event as unknown as { title: string }).title);
      });
      // Did the page land on a sign-in form? Asked again after every load.
      const lookForWall = () => {
        if (wallTimer) clearTimeout(wallTimer);
        wallTimer = setTimeout(() => {
          if (cancelled || !view) return;
          void rpc.rig.pages
            .signInWall({ webContentsId: view.getWebContentsId(), ...(siteIdRef.current ? { site: siteIdRef.current } : {}) })
            .then((r) => {
              if (cancelled) return;
              setWall(r.wall);
              setNotShared(r.notShared);
              if (!r.notShared) setNotSharedHidden(false);
              // Connected and not signed in: on a sign-in wall, and on first load only for a known
              // sign-in site (Google, claude.ai, Notion…). Any other site's first load could be a
              // public page whose analytics cookies would get copied (and a Keychain prompt with
              // it), so it waits for a wall. Never a retry.
              const site = siteIdRef.current;
              const firstLoad = !looked && !!site && site in KNOWN_SIGN_IN_SITES;
              if ((r.wall || firstLoad) && wantsAutoRef.current && site) void runAutoSignIn(site);
              looked = true;
            })
            .catch(() => {});
        }, WALL_CHECK_DELAY_MS);
      };
      // Another site in the same tab would take that host's own remembered zoom.
      view.addEventListener('did-navigate', () => applyZoomRef.current());
      view.addEventListener('did-stop-loading', lookForWall);
      view.addEventListener('did-navigate-in-page', lookForWall);
      hostRef.current.appendChild(view);
    });
    return () => {
      cancelled = true;
      if (wallTimer) clearTimeout(wallTimer);
      unregister?.();
      view?.remove();
      void rpc.browser.unregisterSession(browserId);
    };
    // A new link is a new tab (keyed by url), so url never changes here.
  }, [browserId, url]);

  // Reloads when the file behind it changes (Browser mode).
  const lastReloadKey = useRef(reloadKey);
  useEffect(() => {
    if (lastReloadKey.current === reloadKey) return;
    lastReloadKey.current = reloadKey;
    viewRef.current?.reload();
  }, [reloadKey]);

  // An agent showing the asker a passage: found and scrolled to once the page
  // is up, then left selected.
  const [findText, setFindText] = useState<string | null>(null);
  useViewRequest(url, (request) => {
    if (request.passage) setFindText(request.passage);
  });
  const findDoneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (findDoneTimer.current) clearTimeout(findDoneTimer.current);
  }, []);
  useEffect(() => {
    const view = viewRef.current;
    if (!findText || webContentsId === null || !view) return;
    const find = () => {
      view.removeEventListener('did-stop-loading', find);
      view.findInPage(findText);
      if (findDoneTimer.current) clearTimeout(findDoneTimer.current);
      findDoneTimer.current = setTimeout(() => view.stopFindInPage('keepSelection'), 2_500);
      setFindText(null);
    };
    if (view.isLoading()) view.addEventListener('did-stop-loading', find);
    else find();
    return () => {
      view.removeEventListener('did-stop-loading', find);
    };
  }, [findText, webContentsId]);

  // A new sign-in for the site (the sheet, Settings, Keep in step), or one
  // removed, reloads the page as that account (cases 9 and 13).
  const signedInAt = signIns.isSuccess ? (record?.importedAt ?? 0) : null;
  const lastSignedInAt = useRef(signedInAt);
  useEffect(() => {
    if (signedInAt === null) return;
    if (lastSignedInAt.current !== null && lastSignedInAt.current !== signedInAt) viewRef.current?.reload();
    lastSignedInAt.current = signedInAt;
  }, [signedInAt]);
  // Signed in (automatically or through the sheet): an earlier automatic failure no longer applies.
  useEffect(() => {
    if (site && record && !record.expired && getAutoState(site.id)) clearAutoSignIn(site.id);
  }, [site, record]);
  const signInHere = () => {
    if (site) clearAutoSignIn(site.id);
    bannerDismissed.add(url);
    setBannerHidden(true);
    viewRef.current?.focus();
  };

  const threadsKey = ['page-threads', bindingId, url];
  const threads = useQuery({
    queryKey: threadsKey,
    queryFn: async (): Promise<PageThread[]> => {
      const result = await rpc.rig.pages.threads({ bindingId, url });
      return result.success ? result.data : [];
    },
    // Live: the space's Room says when a pin or reply lands (below); this slow poll and focus catch the rest (resolves).
    refetchInterval: THREADS_EVERY_MS,
    refetchOnWindowFocus: true,
  });
  const resolvedCount = (threads.data ?? []).filter((t) => t.resolved).length;
  const open = (threads.data ?? []).filter((t) => showResolved || !t.resolved);
  const refresh = () => queryClient.invalidateQueries({ queryKey: threadsKey });
  const openRef = useRef(open);
  openRef.current = open;

  // A pin or a reply on this page, arriving in the space's live Room: the threads now, not at the next poll.
  useEffect(() => {
    const room = roomSourceCache.peek(bindingId);
    if (!room) return;
    const path = canonicalPageUrl(url);
    return room.subscribe((event) => {
      if (event.type !== 'message_created') return;
      const m = event.message;
      const onThisPage = m.meta.kind === 'comment_mirror' && m.meta.path === path;
      if (onThisPage || (m.threadId && openRef.current.some((t) => t.id === m.threadId))) void queryClient.invalidateQueries({ queryKey: ['page-threads', bindingId, url] });
    });
  }, [bindingId, url, queryClient]);

  // Pins follow their elements when the page says it moved (scroll, resize,
  // zoom, change), once per frame while it moves, plus a slow safety tick;
  // nothing runs while the page is still.
  const relocatorRef = useRef<Relocator | null>(null);
  const pinIds = open.map((t) => t.id).join(',');
  useEffect(() => {
    if (webContentsId === null || !pinIds) return;
    void rpc.rig.pages.watchPins({ webContentsId });
    const relocator = startRelocator({
      locate: async () => {
        const pins = openRef.current.map((t) => ({ id: t.id, anchor: t.anchor }));
        const result = await rpc.rig.pages.locate({ webContentsId, pins });
        if (result.success) setPlaces(Object.fromEntries(result.data.map((p) => [p.id, p])));
      },
      subscribe: (onMoved) => events.on(pagePinsMovedChannel, (d) => d.webContentsId === webContentsId && onMoved()),
    });
    relocatorRef.current = relocator;
    return () => {
      relocator.stop();
      relocatorRef.current = null;
    };
  }, [webContentsId, pinIds]);
  // The panel itself resized: the page moved under the pins.
  useEffect(() => relocatorRef.current?.poke(), [stageWidth]);

  // Esc closes the draft, then leaves comment mode, then closes the open
  // thread. Capture phase, and marked used, so the panel's own Esc (close
  // the tab) waits for the next one.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (draft) setDraft(null);
      else if (commenting) setCommenting(false);
      else if (openId) setOpenId(null);
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [draft, commenting, openId, setCommenting]);

  // Comment mode's hover: outline what a click would pin. One lookup in
  // flight at a time; the latest pointer position wins.
  const [hover, setHover] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const peekRef = useRef<{ busy: boolean; next: { x: number; y: number } | null }>({ busy: false, next: null });
  const peekAt = (x: number, y: number) => {
    if (webContentsId === null) return;
    const state = peekRef.current;
    state.next = { x, y };
    if (state.busy) return;
    state.busy = true;
    void (async () => {
      while (state.next) {
        const point = state.next;
        state.next = null;
        setHover(await rpc.rig.pages.peek({ webContentsId, ...point }));
      }
      state.busy = false;
    })();
  };
  useEffect(() => {
    if (!commenting || draft) setHover(null);
  }, [commenting, draft]);

  const pinAt = async (event: React.MouseEvent<HTMLDivElement>) => {
    if (webContentsId === null) return;
    const box = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const result = await rpc.rig.pages.hit({ webContentsId, x, y });
    if (result.success && result.data) setDraft({ ...result.data, x, y });
  };

  const openThread = open.find((t) => t.id === openId) ?? null;
  const openPlace = openThread ? places[openThread.id] : undefined;
  // The open thread's card sits at its pin; one opened from the list whose pin
  // isn't placed sits at the panel's top right. It says so only once a look
  // found nothing, not while the first look is on its way.
  const openAt = openPlace?.found && openPlace.x !== undefined && openPlace.y !== undefined ? { x: openPlace.x, y: openPlace.y } : null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="page-view">
      <div className="border-border-hairline flex h-11 shrink-0 items-center gap-2 border-b px-4">
        <b className="min-w-0 truncate text-sm font-medium text-text-primary">{title}</b>
        <span className="shrink-0 text-xs text-text-muted">{hostOf(url)}</span>
        {site && <AccountChip site={site} pageUrl={url} where={where} onSignInHere={signInHere} notShared={notShared} />}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <CommentModeControl
            on={commenting}
            toggle={() => {
              setCommenting(!commenting);
              setDraft(null);
            }}
            who={who}
            agents={agents}
            pick={(id) => {
              commentMode.pick(id);
              setDraft(null);
            }}
            count={
              <CommentCount
                open={(threads.data ?? []).length - resolvedCount}
                resolved={resolvedCount}
                showResolved={showResolved}
                onToggleResolved={() => setShowResolved((on) => !on)}
                list={(close) => (
                  <ThreadList
                    threads={threads.data ?? []}
                    openId={openId}
                    showResolved={showResolved}
                    onPick={(t) => {
                      // A resolved thread's pin is drawn only while resolved ones are shown.
                      if (t.resolved) setShowResolved(true);
                      setDraft(null);
                      setOpenId(t.id);
                      close();
                    }}
                    onToggleResolved={() => {
                      setShowResolved((on) => !on);
                      close();
                    }}
                  />
                )}
              />
            }
            testId="page-comment-mode"
          />
          <PageZoomControl factor={zoom.factor} fitted={zoom.fitted} onPress={zoom.press} />
          <button
            type="button"
            onClick={() => void rpc.app.openExternal(url)}
            className="hover:bg-bg-2 flex h-7 items-center gap-1.5 rounded-control px-2 text-xs text-text-secondary transition-colors"
            aria-label="Open in browser"
            title="Open in browser"
          >
            <ExternalLink className="size-3.5" strokeWidth={1.5} />
            {/* A narrow panel keeps the icon: room for the zoom. */}
            {stageWidth >= 640 && 'Open in browser'}
          </button>
        </span>
      </div>
      {site && (
        <SignInBanner
          site={site}
          pageUrl={url}
          where={where}
          wall={wall}
          dismissed={bannerHidden}
          onDismiss={() => {
            bannerDismissed.add(url);
            setBannerHidden(true);
          }}
        />
      )}

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={hostRef} className="absolute inset-0" />
        {site && notShared && !notSharedHidden && <NotSharedNotice site={site} pageUrl={url} onHide={() => setNotSharedHidden(true)} />}
        {site && <SignInSheet siteId={site.id} onSignInHere={signInHere} />}
        <ConnectSheet where={where} />
        {commenting && (
          <div
            ref={layerRef}
            className="absolute inset-0"
            onClick={(event) => void pinAt(event)}
            onMouseMove={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              peekAt(event.clientX - box.left, event.clientY - box.top);
            }}
            onMouseLeave={() => setHover(null)}
            data-testid="page-comment-layer"
          />
        )}
        <PaintbrushCursorChip active={commenting && !draft} containerRef={layerRef} who={who} />
        {commenting && !draft && <CommentModeStatus who={who} onLeave={() => setCommenting(false)} />}
        {commenting && !draft && hover && (
          <div
            className="border-accent bg-accent/5 pointer-events-none absolute rounded-sm border-[1.5px]"
            style={{ left: hover.x - 2, top: hover.y - 2, width: hover.w + 4, height: hover.h + 4 }}
            data-testid="page-hover-outline"
          />
        )}
        {open.map((t) => {
          const p = places[t.id];
          if (!p?.found || p.x === undefined || p.y === undefined) return null;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setOpenId((current) => (current === t.id ? null : t.id))}
              style={{ left: p.x, top: p.y }}
              className={cn(
                'absolute -mt-5 -ml-0.5 grid size-5 place-items-center rounded-[999px_999px_999px_3px] text-[10px] font-bold text-white shadow-[0_0_0_2px_white,0_3px_8px_rgba(20,40,90,.25)] transition-transform',
                t.resolved ? 'bg-text-muted' : 'bg-accent',
                openId === t.id && 'scale-110'
              )}
              data-testid="page-pin"
            >
              {t.n}
            </button>
          );
        })}
        {openThread && (
          <ThreadCard
            thread={openThread}
            at={openAt}
            lost={openPlace !== undefined && !openPlace.found}
            width={stageWidth}
            onReply={async (body) => {
              const agent = mentionedAgent(body);
              await rpc.rig.pages.reply({ bindingId, parentId: openThread.id, body, asks: agent ?? undefined });
              if (agent) void rpc.rig.pages.askAgent({ bindingId, url, threadId: openThread.id, agent, question: body });
              await refresh();
            }}
            onResolve={async () => {
              await rpc.rig.pages.resolve({ bindingId, id: openThread.id, resolved: !openThread.resolved });
              setOpenId(null);
              await refresh();
            }}
          />
        )}
        {draft && (
          <DraftCard
            draft={draft}
            to={who}
            width={stageWidth}
            onCancel={() => setDraft(null)}
            onSubmit={async (typed) => {
              // Addressed to an agent: the comment says so, as if typed.
              const body = who && !mentionedAgent(typed) ? `@${who.id} ${typed}` : typed;
              const agent = mentionedAgent(body);
              const result = await rpc.rig.pages.comment({
                bindingId,
                url,
                title,
                body,
                quote: draft.quote,
                anchor: draft.anchor,
                asks: agent ?? undefined,
              });
              setDraft(null);
              setCommenting(false);
              await refresh();
              if (result.success) {
                setOpenId(result.data.id);
                if (agent) void rpc.rig.pages.askAgent({ bindingId, url, threadId: result.data.id, agent, question: body });
              }
            }}
          />
        )}
      </div>
    </div>
  );
}

const CARD_WIDTH = 288;

/** Keeps a floating card beside its pin, flipping to the pin's left when the page is too narrow on the right. */
function cardStyle(at: { x: number; y: number }, width: number): React.CSSProperties {
  const right = at.x + 18;
  const left = right + CARD_WIDTH + 8 > width ? at.x - CARD_WIDTH - 10 : right;
  return { left: Math.max(8, Math.min(left, width - CARD_WIDTH - 8)), top: Math.max(8, at.y - 12) };
}

function ThreadCard({
  thread,
  at,
  lost,
  width,
  onReply,
  onResolve,
}: {
  thread: Thread;
  /** Its pin's point; null when the pin isn't placed, and the card sits at the top right. */
  at: { x: number; y: number } | null;
  /** The page was looked over and the pinned element isn't on it. */
  lost: boolean;
  width: number;
  onReply: (body: string) => Promise<void>;
  onResolve: () => Promise<void>;
}) {
  const [reply, setReply] = useState('');
  return (
    <CommentCardFrame
      active
      resolved={thread.resolved}
      className="absolute z-10 w-[288px] shadow-lg"
      style={at ? cardStyle(at, width) : { right: 8, top: 8 }}
      data-testid="page-thread-card"
    >
      <CommentCardQuote n={thread.n} quote={thread.quote} active resolved={thread.resolved} />
      {!at && lost && <p className="text-xs text-text-muted">Can't find where this was pinned on the page.</p>}
      <CommentCardAuthor who={thread.authorName ?? 'Someone'} at={thread.createdAt} />
      <p className="text-sm text-text-primary">{thread.comment}</p>
      {thread.replies.map((r) => (
        <div key={r.id} className="border-border-hairline flex flex-col gap-1 border-t pt-2">
          <CommentCardAuthor
            who={
              r.agent ? (
                <>
                  {agentName(r.agent)} <span className="font-normal text-text-muted">with {r.authorName ?? 'someone'}</span>
                </>
              ) : (
                (r.authorName ?? 'Someone')
              )
            }
            at={r.createdAt}
          />
          <p className="text-sm text-text-primary">{r.body}</p>
        </div>
      ))}
      <Textarea
        value={reply}
        onChange={(event) => setReply(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && reply.trim()) {
            event.preventDefault();
            void onReply(reply.trim()).then(() => setReply(''));
          }
        }}
        placeholder={REPLY_PLACEHOLDER}
        rows={1}
        className="max-h-32 min-h-8 py-1.5 text-sm"
      />
      <div className="flex justify-end">
        <button type="button" onClick={() => void onResolve()} className="text-xs text-text-muted hover:text-text-primary">
          {thread.resolved ? 'Reopen' : 'Resolve'}
        </button>
      </div>
    </CommentCardFrame>
  );
}

/**
 * Under the comment count: every thread on the page, open ones first, each
 * opening its card. The count's resolved toggle moves in here.
 */
function ThreadList({
  threads,
  openId,
  showResolved,
  onPick,
  onToggleResolved,
}: {
  threads: Thread[];
  openId: string | null;
  showResolved: boolean;
  onPick: (thread: Thread) => void;
  onToggleResolved: () => void;
}) {
  const { open, resolved } = threadListGroups(threads);
  const row = (t: Thread) => {
    const replies = replyCountLabel(t.replies.length);
    return (
      <button
        key={t.id}
        type="button"
        role="menuitem"
        tabIndex={-1}
        onClick={() => onPick(t)}
        className={cn(
          'flex w-full items-start gap-2 rounded-control px-2.5 py-1.5 text-left outline-none transition-colors hover:bg-bg-2 focus-visible:bg-bg-2',
          openId === t.id && 'bg-bg-2'
        )}
        data-testid="page-thread-list-item"
      >
        <CommentNumber n={t.n} active={openId === t.id} resolved={t.resolved} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate text-xs font-medium text-text-primary">{t.authorName ?? 'Someone'}</span>
            {replies && <span className="ml-auto shrink-0 text-xs text-text-muted">{replies}</span>}
          </span>
          <span className="truncate text-xs text-text-secondary">{threadExcerpt(t.comment)}</span>
        </span>
      </button>
    );
  };
  return (
    <>
      {open.map(row)}
      {resolved.length > 0 && (
        <>
          <p className="border-border-hairline mt-1 border-t px-2.5 pt-2 pb-1 text-2xs text-text-muted">Resolved</p>
          {resolved.map(row)}
          <button
            type="button"
            role="menuitemcheckbox"
            tabIndex={-1}
            aria-checked={showResolved}
            onClick={onToggleResolved}
            className="border-border-hairline mt-1 flex w-full items-center border-t px-2.5 pt-2 pb-1.5 text-left text-xs text-text-muted outline-none transition-colors hover:text-text-primary focus-visible:text-text-primary"
          >
            {showResolved ? 'Hide resolved pins' : 'Show resolved pins'}
          </button>
        </>
      )}
    </>
  );
}

function DraftCard({
  draft,
  to,
  width,
  onCancel,
  onSubmit,
}: {
  draft: Draft;
  /** The agent comment mode is addressed to, or null for a plain comment. */
  to: RunnableAgent | null;
  width: number;
  onCancel: () => void;
  onSubmit: (body: string) => Promise<void>;
}) {
  const [body, setBody] = useState('');
  const toName = to ? shortAgentName(to.name) : null;
  return (
    <CommentCardFrame active className="absolute z-10 w-[288px] shadow-lg" style={cardStyle(draft, width)} data-testid="page-draft-card">
      <CommentCardQuote quote={draft.quote} />
      {to && toName && <CommentCardTo icon={<AgentIcon icon={to.icon} size={12} className="shrink-0" />} name={toName} />}
      <Textarea
        autoFocus
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && body.trim()) {
            event.preventDefault();
            void onSubmit(body.trim());
          }
        }}
        placeholder={toName ? `Ask ${toName} about this` : COMMENT_PLACEHOLDER}
        rows={2}
        className="max-h-40 min-h-14 py-1.5 text-sm"
      />
      <div className="flex justify-end gap-1.5">
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" disabled={!body.trim()} onClick={() => void onSubmit(body.trim())}>
          {toName ? `Ask ${toName}` : 'Comment'}
        </Button>
      </div>
    </CommentCardFrame>
  );
}

function agentName(agent: string): string {
  return agent === 'claude-code' || agent === 'claude' ? 'Claude' : agent === 'codex' ? 'Codex' : agent;
}
