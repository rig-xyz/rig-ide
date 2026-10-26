import type { TranscriptTurn } from '@emdash/core/acp/client';
import { useQuery } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { ReplayStore } from '@renderer/features/chat/replay-store';
import type { RigChatStore } from '@renderer/features/chat/rig-chat-store';
import { rpc } from '@renderer/lib/ipc';
import { cn } from '@renderer/lib/utils';
import { startPromptFromBrief } from '@shared/rig/start-prompt';
import { turnView, type SessionApproval } from '../session-turns';
import type { SessionRunMeta } from '../types';
import { SessionCard } from './session-card';
import { SafeMarkdown } from '@renderer/lib/ui/comment-markdown';
import { SpaceFileLink } from './space-file-link';
import { bubbleClass, useOpenWebLink } from './transcript-items';

/**
 * A space session drawn the way the Room draws its own: what you asked as
 * your message on the right, and each of Claude's turns as the Room's
 * session card ("Worked 28s · 3 steps" over the answer), approvals included.
 * Opened beside the Room (`SessionPane` in `chat-panel.tsx`).
 *
 * A turn Rig started from your Feed opens with a short brief (`startPrompt`
 * in main's `orch/actions.ts`): it says so above your message, and the full
 * brief reads as a file chip, like files in the Room's answers.
 */
export const SessionTurnsView = observer(function SessionTurnsView({
  store,
  root,
  rootId,
  onOpenFile,
}: {
  store: RigChatStore | ReplayStore;
  root: string;
  rootId: string;
  onOpenFile?: (absPath: string) => void;
}) {
  const live = store.kind === 'live' ? store : null;
  const committed = store.turns;
  const liveTurn = live?.liveTurn ?? null;
  const approvals: SessionApproval[] = (live?.permissionQueue ?? []).map((request) => ({
    requestId: request.requestId,
    title: request.title,
    options: request.options,
  }));
  // When each turn was first seen running here: its live elapsed time.
  const startedAt = useRef(new Map<string, string>());
  if (liveTurn && !startedAt.current.has(liveTurn.id)) startedAt.current.set(liveTurn.id, new Date().toISOString());

  const turns: { turn: TranscriptTurn; live: boolean }[] = useMemo(
    () => [
      ...committed.filter((t) => t.id !== liveTurn?.id).map((turn) => ({ turn, live: false })),
      ...(liveTurn ? [{ turn: liveTurn, live: true }] : []),
    ],
    [committed, liveTurn]
  );

  // Kept at the bottom while new work comes in, unless you scrolled up to read.
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const lastEvents = turns.reduce((n, t) => n + t.turn.items.length, approvals.length);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lastEvents]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const model = live?.model ?? 'unknown';
  const title = (store.kind === 'live' ? store.title : store.session?.title) ?? 'Session';
  const openPath = (path: string) => onOpenFile?.(path.startsWith('/') ? path : `${root.replace(/\/+$/, '')}/${path}`);

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto" data-testid="session-turns">
      <div className="mx-auto flex max-w-[44rem] flex-col gap-4 px-3 py-6">
        {turns.map(({ turn, live: isLive }, index) => {
          const view = turnView(turn, { live: isLive, approvals: isLive ? approvals : [] });
          const meta: SessionRunMeta = {
            id: turn.id,
            agent: 'claude',
            owner: 'you',
            model,
            title,
            status: view.status,
            startedAt: startedAt.current.get(turn.id) ?? '',
            endedAt: null,
          };
          return (
            <div key={turn.id} className="flex flex-col gap-3">
              {view.prompt && (
                <YourMessage
                  text={view.prompt}
                  first={index === 0}
                  title={title}
                  rootId={rootId}
                  onOpenPath={openPath}
                />
              )}
              {(view.events.length > 0 || isLive) && (
                <SessionCard
                  meta={meta}
                  events={view.events}
                  owner={null}
                  viewerIsOwner
                  onStop={isLive && live ? () => live.stop() : undefined}
                  onResolvePermission={live ? (_requestId, optionId) => live.resolvePermission(optionId) : undefined}
                  onOpenFile={openPath}
                />
              )}
            </div>
          );
        })}
        {turns.length === 0 && (
          <p className="py-10 text-center text-sm text-text-muted">
            {store.kind === 'replay' && store.loading ? 'Loading this session…' : 'Nothing here yet.'}
          </p>
        )}
      </div>
    </div>
  );
});

const BRIEF_PATH = /(sessions\/[^\s)]+\/brief\.md)/;
/** What a start from the Feed used to say, all of it: said again from its brief file. */
const BARE_BRIEF = /^Work through (sessions\/[^\s]+\/brief\.md)\.?$/;

/**
 * Your message, on the right like in the Room, in markdown so files read as
 * the Room's file chips. A start from your Feed (it links its brief) says so above it.
 */
function YourMessage({
  text,
  first,
  title,
  rootId,
  onOpenPath,
}: {
  text: string;
  first: boolean;
  title: string;
  rootId: string;
  onOpenPath: (path: string) => void;
}) {
  const openWebLink = useOpenWebLink();
  const fromFeed = first && BRIEF_PATH.test(text);
  const bare = BARE_BRIEF.exec(text.trim());
  const briefPath = bare?.[1] ?? null;
  const { data: rebuilt } = useQuery({
    queryKey: ['rig', 'session-brief', rootId, briefPath],
    queryFn: async () => {
      const read = await rpc.rig.files.read({ rootId, relativePath: briefPath!, maxBytes: 64_000 });
      return read.success ? startPromptFromBrief(read.data.content, briefPath!) : null;
    },
    enabled: !!briefPath && !!rootId,
    staleTime: Infinity,
  });
  const shown = briefPath
    ? (rebuilt ?? `**${title}**\n\nEverything is in the brief: [\`brief.md\`](${briefPath})`)
    : text;
  return (
    <div className="flex flex-col items-end gap-1 pl-12" data-testid="session-your-message">
      {fromFeed && <span className="text-xs text-text-muted">Started from your Feed</span>}
      <div className={cn(bubbleClass(true), 'flex flex-col gap-2')}>
        <SafeMarkdown
          content={shown}
          className="text-sm leading-relaxed text-text-primary"
          onOpenPath={onOpenPath}
          renderFileLink={(parts) => <SpaceFileLink {...parts} onOpen={onOpenPath} from={null} />}
          onOpenWebLink={openWebLink}
        />
      </div>
    </div>
  );
}
