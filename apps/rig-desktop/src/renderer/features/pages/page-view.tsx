import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { WebviewTag } from 'electron';
import { ExternalLink, MessageCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Textarea } from '@renderer/lib/ui/textarea';
import { cn } from '@renderer/lib/utils';
import { formatRelative } from '@renderer/lib/time-format';
import { classifyLink, RIG_PAGES_PARTITION } from '@shared/spaces/links';
import type { PageAnchor, PagePlace, PageThread } from '@shared/spaces/pages';
import { FirstOpen, useSignInStatus, type SignInSite } from './sign-in';

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

const LOCATE_EVERY_MS = 150;

/** Which of the member's agents a comment asks, if any: "@claude …", "@codex …". */
function mentionedAgent(body: string): 'claude' | 'codex' | null {
  const m = /(?:^|\s)@(claude|codex)\b/i.exec(body);
  return m ? (m[1]!.toLowerCase() as 'claude' | 'codex') : null;
}
const THREADS_EVERY_MS = 4000;

function siteOf(url: string): SignInSite | null {
  const kind = classifyLink(url).kind;
  return kind.startsWith('claude') ? 'claude' : kind.startsWith('google') ? 'google' : null;
}

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
}: {
  url: string;
  title: string;
  bindingId: string;
  /** The page's own title, once it loads: the tab takes it. */
  onTitle?: (title: string) => void;
}) {
  const me = useQuery({ queryKey: ['rig', 'account', 'me'], queryFn: () => rpc.rig.account.me() });
  const selfName = me.data?.success ? (me.data.data.name ?? me.data.data.email?.split('@')[0] ?? null) : null;
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
  const [commenting, setCommenting] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [places, setPlaces] = useState<Record<string, Place>>({});
  const [showResolved, setShowResolved] = useState(false);
  const [firstOpenDone, setFirstOpenDone] = useState(false);
  const viewRef = useRef<WebviewTag | null>(null);
  const site = siteOf(url);
  const signIn = useSignInStatus();
  const needsSignIn = site !== null && !firstOpenDone && (signIn.data === undefined || !signIn.data[site]);
  const needsSignInRef = useRef(needsSignIn);
  needsSignInRef.current = needsSignIn;
  const browserId = useMemo(() => `rig-page-${Math.random().toString(36).slice(2)}`, []);
  const queryClient = useQueryClient();

  // The page itself: registered as one of the app's browsers (so the
  // webview is allowed to attach and gets the browser hardening), created
  // with its profile set before it attaches.
  useEffect(() => {
    let cancelled = false;
    let view: WebviewTag | null = null;
    void rpc.browser.registerSession({ browserId, partition: RIG_PAGES_PARTITION }).then(() => {
      if (cancelled || !hostRef.current) return;
      view = document.createElement('webview') as WebviewTag;
      viewRef.current = view;
      view.setAttribute('partition', RIG_PAGES_PARTITION);
      view.setAttribute('src', url);
      view.className = 'absolute inset-0 size-full';
      view.addEventListener('dom-ready', () => {
        const id = view!.getWebContentsId();
        setWebContentsId(id);
        void rpc.browser.bindWebContents({ browserId, webContentsId: id });
      });
      view.addEventListener('page-title-updated', (event) => {
        // Behind the first-open screen the page is its site's sign-in page: not a title for the tab.
        if (!needsSignInRef.current) onTitleRef.current?.((event as unknown as { title: string }).title);
      });
      hostRef.current.appendChild(view);
    });
    return () => {
      cancelled = true;
      view?.remove();
      void rpc.browser.unregisterSession(browserId);
    };
    // A new link is a new tab (keyed by url), so url never changes here.
  }, [browserId, url]);

  const threadsKey = ['page-threads', bindingId, url];
  const threads = useQuery({
    queryKey: threadsKey,
    queryFn: async (): Promise<PageThread[]> => {
      const result = await rpc.rig.pages.threads({ bindingId, url });
      return result.success ? result.data : [];
    },
    refetchInterval: THREADS_EVERY_MS,
  });
  const resolvedCount = (threads.data ?? []).filter((t) => t.resolved).length;
  const open = (threads.data ?? []).filter((t) => showResolved || !t.resolved);
  const refresh = () => queryClient.invalidateQueries({ queryKey: threadsKey });

  // Pins follow their elements as the page scrolls, zooms or changes.
  useEffect(() => {
    if (webContentsId === null || open.length === 0) return;
    let stopped = false;
    const tick = async () => {
      const result = await rpc.rig.pages.locate({ webContentsId, pins: open.map((t) => ({ id: t.id, anchor: t.anchor })) });
      if (stopped) return;
      if (result.success) setPlaces(Object.fromEntries(result.data.map((p) => [p.id, p])));
      setTimeout(() => void tick(), LOCATE_EVERY_MS);
    };
    void tick();
    return () => {
      stopped = true;
    };
  }, [webContentsId, open.map((t) => t.id).join(',')]);

  // Esc leaves comment mode, or closes what's open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (draft) setDraft(null);
      else if (commenting) setCommenting(false);
      else setOpenId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draft, commenting]);

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

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="page-view">
      <div className="border-border-hairline flex h-11 shrink-0 items-center gap-2 border-b px-4">
        <b className="min-w-0 truncate text-sm font-medium text-text-primary">{title}</b>
        <span className="shrink-0 text-xs text-text-muted">
          {hostOf(url)}
          {selfName ? ` · as ${selfName}` : ''}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {resolvedCount > 0 && (
            <button
              type="button"
              onClick={() => setShowResolved((on) => !on)}
              aria-pressed={showResolved}
              className={cn(
                'flex h-7 items-center rounded-control px-2 text-xs transition-colors',
                showResolved ? 'bg-bg-2 text-text-primary' : 'hover:bg-bg-2 text-text-muted'
              )}
            >
              {resolvedCount} resolved
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setCommenting((on) => !on);
              setDraft(null);
            }}
            aria-pressed={commenting}
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-control px-2 text-xs transition-colors',
              commenting ? 'bg-accent-subtle text-accent' : 'hover:bg-bg-2 text-text-secondary'
            )}
            data-testid="page-comment-toggle"
          >
            <MessageCircle className="size-3.5" strokeWidth={1.5} />
            Comment
          </button>
          <button
            type="button"
            onClick={() => void rpc.app.openExternal(url)}
            className="hover:bg-bg-2 flex h-7 items-center gap-1.5 rounded-control px-2 text-xs text-text-secondary transition-colors"
          >
            <ExternalLink className="size-3.5" strokeWidth={1.5} />
            Open in browser
          </button>
        </span>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={hostRef} className="absolute inset-0" />
        {needsSignIn && site && signIn.data !== undefined && (
          <FirstOpen
            site={site}
            onDone={() => {
              setFirstOpenDone(true);
              viewRef.current?.reload();
            }}
            onOpenInBrowser={() => void rpc.app.openExternal(url)}
          />
        )}
        {commenting && (
          <div className="absolute inset-0 cursor-crosshair" onClick={(event) => void pinAt(event)} data-testid="page-comment-layer" />
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
        {openThread && openPlace?.found && (
          <ThreadCard
            thread={openThread}
            at={{ x: openPlace.x!, y: openPlace.y! }}
            width={stageWidth}
            onReply={async (body) => {
              await rpc.rig.pages.reply({ bindingId, parentId: openThread.id, body });
              const agent = mentionedAgent(body);
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
            width={stageWidth}
            onCancel={() => setDraft(null)}
            onSubmit={async (body) => {
              const result = await rpc.rig.pages.comment({ bindingId, url, body, quote: draft.quote, anchor: draft.anchor });
              setDraft(null);
              setCommenting(false);
              await refresh();
              if (result.success) {
                setOpenId(result.data.id);
                const agent = mentionedAgent(body);
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
  width,
  onReply,
  onResolve,
}: {
  thread: Thread;
  at: { x: number; y: number };
  width: number;
  onReply: (body: string) => Promise<void>;
  onResolve: () => Promise<void>;
}) {
  const [reply, setReply] = useState('');
  return (
    <div
      className="border-border-hairline bg-bg-1 absolute z-10 flex w-[288px] flex-col gap-2 rounded-card border p-3 shadow-lg"
      style={cardStyle(at, width)}
      data-testid="page-thread-card"
    >
      <p className="border-border-strong line-clamp-2 border-l-2 pl-2 text-xs text-text-muted">{thread.quote}</p>
      <div className="flex items-baseline justify-between text-xs">
        <b className="font-medium text-text-primary">{thread.authorName ?? 'Someone'}</b>
        <span className="text-text-muted">{formatRelative(thread.createdAt)}</span>
      </div>
      <p className="text-sm text-text-primary">{thread.comment}</p>
      {thread.replies.map((r) => (
        <div key={r.id} className="border-border-hairline flex flex-col gap-1 border-t pt-2">
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-text-secondary">
              {r.agent ? (
                <>
                  {agentName(r.agent)} (with <b className="font-medium text-text-primary">{r.authorName ?? 'someone'}</b>)
                </>
              ) : (
                <b className="font-medium text-text-primary">{r.authorName ?? 'Someone'}</b>
              )}
            </span>
            <span className="text-text-muted">{formatRelative(r.createdAt)}</span>
          </div>
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
        placeholder="Reply, @ to mention"
        className="min-h-9 text-sm"
      />
      <div className="flex justify-end">
        <button type="button" onClick={() => void onResolve()} className="text-xs text-text-muted hover:text-text-primary">
          {thread.resolved ? 'Reopen' : 'Resolve'}
        </button>
      </div>
    </div>
  );
}

function DraftCard({
  draft,
  width,
  onCancel,
  onSubmit,
}: {
  draft: Draft;
  width: number;
  onCancel: () => void;
  onSubmit: (body: string) => Promise<void>;
}) {
  const [body, setBody] = useState('');
  return (
    <div
      className="border-border-hairline bg-bg-1 absolute z-10 flex w-[288px] flex-col gap-2 rounded-card border p-3 shadow-lg"
      style={cardStyle(draft, width)}
      data-testid="page-draft-card"
    >
      <p className="border-border-strong line-clamp-2 border-l-2 pl-2 text-xs text-text-muted">{draft.quote}</p>
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
        placeholder="Comment, @ to mention"
        className="min-h-14 text-sm"
      />
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={!body.trim()} onClick={() => void onSubmit(body.trim())}>
          Comment
        </Button>
      </div>
    </div>
  );
}

function agentName(agent: string): string {
  return agent === 'claude-code' || agent === 'claude' ? 'Claude' : agent === 'codex' ? 'Codex' : agent;
}
