import { useQuery } from '@tanstack/react-query';
import { Pin, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { RigMark } from '@renderer/lib/ui/rig-mark';
import { cn } from '@renderer/lib/utils';
import { relativeTime } from '@renderer/features/chat/session-history';
import { type Card, selectCards, toContentOnlyPinned, toContentOnlyWrites } from '@shared/rig/card-rail';
import { filterToContentOnly } from '@shared/rig/file-navigator-categories';
import { rigSettingsChangedChannel } from '@shared/rig/settings';
import type { RigFileNode } from '@shared/rig/files';
import { iconFor, rigFilesQueryKey } from './file-tree';
import { useRecentWrites } from './write-activity';

/**
 * Navigator v3 — the ACTIVE FILES carousel, the workspace's answer to "where
 * is the thing being worked on right now."
 *
 * Adaptive membership, in one honest order: files an agent is writing this
 * minute, then anything pinned, then the most recently changed. A file being
 * written right now has its name and path SHIMMER — the one place ambient
 * motion is allowed here, because it is reporting live state rather than
 * decorating a card, and it stops the instant the write window closes.
 *
 * Each card carries its own provenance underneath: the rig mark when an
 * agent is behind the change (that is the only attribution the write signal
 * can honestly make — see `write-activity.ts`), otherwise just the time. No
 * invented per-person attribution.
 *
 * CONTENT ONLY, structurally: the listing is filtered through
 * `filterToContentOnly` before anything is derived from it, and pinned/
 * in-progress candidates go through `toContentOnlyPinned`/`toContentOnlyWrites`
 * at the same boundary, so a system path like `daemon.log` can never reach a
 * card. Reads the SAME cached listing the tree queries — no second round trip.
 */

const MAX_CARDS = 8;
/** How long the horizontal scrollbar stays visible after the last scroll event. */
const SCROLLBAR_LINGER_MS = 700;

function flattenFiles(nodes: RigFileNode[]): RigFileNode[] {
  const out: RigFileNode[] = [];
  const walk = (list: RigFileNode[]) => {
    for (const node of list) {
      if (node.kind === 'dir') walk(node.children ?? []);
      else out.push(node);
    }
  };
  walk(nodes);
  return out;
}

/** `training/workouts/vo2.yaml` → `training / workouts`, the card's location line. Root-level files have none. */
function parentTrail(relPath: string): string | null {
  const segments = relPath.split('/');
  segments.pop();
  return segments.length === 0 ? null : segments.join(' / ');
}

export function ActiveFiles({
  root,
  bindingId,
  onOpenFile,
}: {
  root: string;
  bindingId: string;
  /** Opens the file AND arms a reveal for when the user returns to the tree (`App.tsx`'s `openFileAndReveal`). */
  onOpenFile: (absPath: string, relPath: string) => void;
}) {
  const { data } = useQuery({
    queryKey: rigFilesQueryKey(root),
    queryFn: async () => {
      const result = await rpc.rig.files.list(root);
      if (!result.success) throw new Error(result.error.message);
      return result.data;
    },
  });

  const [pinned, setPinned] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    void rpc.rig.settings.get().then((settings) => {
      if (alive) setPinned(settings.pinnedPathsByRig[bindingId] ?? []);
    });
    const off = events.on(rigSettingsChangedChannel, (settings) => {
      setPinned(settings.pinnedPathsByRig[bindingId] ?? []);
    });
    return () => {
      alive = false;
      off();
    };
  }, [bindingId]);

  const recentWrites = useRecentWrites(root);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const contentTree = useMemo(() => filterToContentOnly(data ?? []), [data]);
  const nodeByPath = useMemo(() => {
    const map = new Map<string, RigFileNode>();
    for (const node of flattenFiles(contentTree)) map.set(node.relPath, node);
    return map;
  }, [contentTree]);

  const inProgress = useMemo(
    () => toContentOnlyWrites(recentWrites).filter((w) => !dismissed.has(w.relPath)),
    [recentWrites, dismissed]
  );

  /**
   * The carousel's own "otherwise" arm: when nothing is being actively
   * written, the most recently CHANGED files fill the strip. Deliberately
   * not the unseen set (that is the tree's dots' job) — Dylan's spec is
   * "the most recently changed show up there", so a file you have already
   * read still belongs here if it is the freshest thing in the rig.
   */
  const recentlyChanged = useMemo(() => {
    const files = flattenFiles(contentTree).filter((node) => node.mtimeMs !== undefined);
    return files
      .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))
      .slice(0, MAX_CARDS)
      .filter((node) => !dismissed.has(node.relPath))
      .map((node) => ({ relPath: node.relPath, at: node.mtimeMs as number }));
  }, [contentTree, dismissed]);

  const togglePin = (relPath: string) => {
    const next = pinned.includes(relPath) ? pinned.filter((p) => p !== relPath) : [...pinned, relPath];
    setPinned(next);
    void rpc.rig.settings.set({ pinnedPathsByRig: { [bindingId]: next } });
  };

  const cards = useMemo(
    () =>
      selectCards({
        pinnedRelPaths: toContentOnlyPinned(pinned),
        inProgress,
        fresh: recentlyChanged,
        maxNonPinned: MAX_CARDS,
      }).slice(0, MAX_CARDS),
    [pinned, inProgress, recentlyChanged]
  );

  const activePaths = useMemo(() => new Set(inProgress.map((w) => w.relPath)), [inProgress]);
  const scrollRef = useScrollbarReveal();

  if (cards.length === 0) return null;

  return (
    <div className="mt-3 flex shrink-0 flex-col gap-1.5">
      <p className="text-text-muted px-3 text-xs font-medium">Active files</p>
      <div ref={scrollRef} className="carousel-scroll flex gap-2 px-3 pb-1.5">
        {cards.map((card) => {
          const node = nodeByPath.get(card.relPath);
          return (
            <FileCard
              key={card.relPath}
              card={card}
              node={node}
              active={activePaths.has(card.relPath)}
              isPinned={pinned.includes(card.relPath)}
              onOpen={() => onOpenFile(`${root}/${card.relPath}`, card.relPath)}
              onTogglePin={() => togglePin(card.relPath)}
              onDismiss={() => {
                if (card.type === 'pinned') togglePin(card.relPath);
                else setDismissed((prev) => new Set(prev).add(card.relPath));
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * One card: filename, its folder trail, and a provenance footer. Both text
 * lines shimmer while an agent is mid-write. Pin and dismiss stay hidden
 * until hover so a resting strip is just files and their state.
 */
function FileCard({
  card,
  node,
  active,
  isPinned,
  onOpen,
  onTogglePin,
  onDismiss,
}: {
  card: Card;
  node: RigFileNode | undefined;
  active: boolean;
  isPinned: boolean;
  onOpen: () => void;
  onTogglePin: () => void;
  onDismiss: () => void;
}) {
  const name = node?.name ?? (card.relPath.split('/').pop() ?? card.relPath);
  const trail = parentTrail(card.relPath);
  const Icon = iconFor(name);

  return (
    <div
      data-card-key={card.relPath}
      className="card-pop-in border-border-hairline bg-bg-1 rounded-card group relative flex w-[184px] shrink-0 flex-col"
    >
      <button
        type="button"
        onClick={onOpen}
        className="hover:bg-bg-2 rounded-card flex min-w-0 flex-1 flex-col gap-1 p-2.5 text-left transition-colors"
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <Icon className="text-text-secondary size-3.5 shrink-0" strokeWidth={1.5} />
          <span
            className={cn(
              'text-text-primary min-w-0 flex-1 truncate text-xs font-medium',
              active && 'active-shimmer'
            )}
          >
            {name}
          </span>
        </div>
        <span className={cn('text-text-muted min-w-0 truncate text-xs', active && 'active-shimmer-muted')}>
          {trail ?? 'Top level'}
        </span>
        <span className="text-text-muted mt-1 flex min-w-0 items-center gap-1.5 text-xs">
          {active ? (
            <>
              <RigMark size={11} className="shrink-0" />
              <span className="truncate">Agent editing now</span>
              <span className="bg-accent pulse-dot size-[5px] shrink-0 rounded-full" />
            </>
          ) : (
            <span className="truncate">
              {card.at === undefined ? 'Pinned' : `Edited ${relativeTime(card.at, Date.now())}`}
            </span>
          )}
        </span>
      </button>
      <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <button
          type="button"
          onClick={onTogglePin}
          aria-label={isPinned ? 'Unpin' : 'Pin'}
          className={cn(
            'rounded-control bg-bg-1 hover:bg-bg-2 flex size-5 items-center justify-center',
            isPinned ? 'text-accent' : 'text-text-muted hover:text-text-primary'
          )}
        >
          <Pin className="size-3" strokeWidth={1.5} fill={isPinned ? 'currentColor' : 'none'} />
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={card.type === 'pinned' ? 'Unpin' : 'Dismiss'}
          className="rounded-control bg-bg-1 hover:bg-bg-2 text-text-muted hover:text-text-primary flex size-5 items-center justify-center"
        >
          <X className="size-3" strokeWidth={1.5} />
        </button>
      </div>
    </div>
  );
}

/**
 * Keeps the horizontal scrollbar invisible until the strip is actually
 * being scrolled, then hides it again shortly after — the CSS in
 * `tokens.css` owns the appearance, this owns only the timing.
 */
function useScrollbarReveal(): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let timer: number | undefined;
    const onScroll = () => {
      element.classList.add('is-scrolling');
      window.clearTimeout(timer);
      timer = window.setTimeout(() => element.classList.remove('is-scrolling'), SCROLLBAR_LINGER_MS);
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      element.removeEventListener('scroll', onScroll);
      window.clearTimeout(timer);
    };
  }, []);

  return ref;
}
