import { useQuery } from '@tanstack/react-query';
import { Pin, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { relativeTime } from '@renderer/features/chat/session-history';
import { events, rpc } from '@renderer/lib/ipc';
import { RigMark } from '@renderer/lib/ui/rig-mark';
import { cn } from '@renderer/lib/utils';
import {
  type Card,
  selectCards,
  toContentOnlyPinned,
  toContentOnlyWrites,
} from '@shared/rig/card-rail';
import { filterToContentOnly } from '@shared/rig/file-navigator-categories';
import type { RigFileNode } from '@shared/rig/files';
import { rigSettingsChangedChannel } from '@shared/rig/settings';
import { iconFor, rigFilesQueryKey } from './file-tree';
import { useEverWrittenPaths, useRecentWrites } from './write-activity';

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

/**
 * `training/workouts/vo2.yaml` → `workouts`. The immediate folder is the
 * part a reader actually uses to place a file; the full ancestor trail is
 * noise in a 200px card, and a file at the rig root gets no location line
 * at all rather than a meaningless one.
 */
function parentFolder(relPath: string): string | null {
  const segments = relPath.split('/');
  segments.pop();
  return segments.length === 0 ? null : (segments[segments.length - 1] ?? null);
}

export function ActiveFiles({
  root,
  rootId,
  bindingId,
  onOpenFile,
}: {
  root: string;
  rootId: string;
  bindingId: string;
  /** Opens the file AND arms a reveal for when the user returns to the tree (`App.tsx`'s `openFileAndReveal`). */
  onOpenFile: (absPath: string, relPath: string) => void;
}) {
  const { data } = useQuery({
    queryKey: rigFilesQueryKey(root, rootId),
    queryFn: async () => {
      const result = await rpc.rig.files.list({ rootId });
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
    const next = pinned.includes(relPath)
      ? pinned.filter((p) => p !== relPath)
      : [...pinned, relPath];
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
  // Authorship, as far as this app can honestly know it: every path an
  // agent session has written since launch. A human's editor and the sync
  // daemon are indistinguishable to the file watcher, so nothing else on a
  // card claims a person.
  const agentWritten = useEverWrittenPaths(root);
  const scrollRef = useScrollbarReveal();

  if (cards.length === 0) return null;

  return (
    <div className="mt-5 flex shrink-0 flex-col gap-2">
      {/*
        The heading follows the content: while an agent is mid-write this
        strip really is showing work in progress, and the rest of the time
        it is honestly just what changed last. One adaptive line beats a
        generic label that is wrong half the time.
      */}
      <p className="px-4 font-mono text-xs tracking-wide text-text-muted uppercase">
        {activePaths.size > 0 ? 'Being worked on' : 'Recently updated'}
      </p>
      <div ref={scrollRef} className="carousel-scroll flex gap-2.5 px-6 pb-2">
        {cards.map((card) => {
          const node = nodeByPath.get(card.relPath);
          return (
            <FileCard
              key={card.relPath}
              card={card}
              node={node}
              active={activePaths.has(card.relPath)}
              byAgent={agentWritten.has(card.relPath)}
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
  byAgent,
  isPinned,
  onOpen,
  onTogglePin,
  onDismiss,
}: {
  card: Card;
  node: RigFileNode | undefined;
  active: boolean;
  /** An agent wrote this file at some point this session — the only authorship the client can honestly claim. */
  byAgent: boolean;
  isPinned: boolean;
  onOpen: () => void;
  onTogglePin: () => void;
  onDismiss: () => void;
}) {
  const name = node?.name ?? card.relPath.split('/').pop() ?? card.relPath;
  const folder = parentFolder(card.relPath);
  const Icon = iconFor(name);

  return (
    <div
      data-card-key={card.relPath}
      className={cn(
        // A hairline, not a fill. A filled tile reads as heavy in light
        // mode and vanishes into the panel in dark; a border is legible in
        // both and lets the row of cards stay quiet next to the tree.
        // Tonal pass: cards rest one surface step UP from the panel (white
        // in light mode) instead of dissolving into it, and hover climbs
        // the ladder rather than inventing a border change.
        'card-pop-in border-border-hairline bg-bg-1 rounded-card group relative flex w-[190px] shrink-0 flex-col border transition-colors',
        'hover:bg-bg-2'
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 flex-col gap-1 rounded-card p-2.5 text-left"
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <Icon className="size-3.5 shrink-0 text-text-secondary" strokeWidth={1.5} />
          <span
            className={cn(
              'text-text-primary min-w-0 flex-1 truncate text-xs font-medium',
              active && 'active-shimmer'
            )}
          >
            {name}
          </span>
        </div>
        {/*
          Location only when there is one worth naming: the immediate
          folder, not the whole trail, and nothing at all for a file at the
          rig root ("Top level" told the reader nothing).
        */}
        {/*
          One meta line, not two: where it lives and when it changed read
          as a single quiet sentence under the name rather than stacking
          into a third and fourth row of text in a small card.
        */}
        {/*
          Charter v2 one-signal rule: the shimmering NAME above is the
          live-write signal. This line is provenance — plain text, no second
          shimmer, no pulsing dot stacked onto motion already saying it.
        */}
        <span className="text-text-muted flex min-w-0 items-center gap-1 text-xs">
          {active ? (
            <>
              <RigMark size={11} className="shrink-0" />
              <span className="truncate">Editing now</span>
            </>
          ) : (
            <>
              {byAgent && <RigMark size={11} className="shrink-0 opacity-60" />}
              <span className="truncate">
                {[folder, card.at === undefined ? 'Pinned' : relativeTime(card.at, Date.now())]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </>
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
            isPinned ? 'text-text-primary' : 'text-text-muted hover:text-text-primary'
          )}
        >
          <Pin className="size-3" strokeWidth={1.5} fill={isPinned ? 'currentColor' : 'none'} />
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={card.type === 'pinned' ? 'Unpin' : 'Dismiss'}
          className="flex size-5 items-center justify-center rounded-control bg-bg-1 text-text-muted hover:bg-bg-2 hover:text-text-primary"
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
      timer = window.setTimeout(
        () => element.classList.remove('is-scrolling'),
        SCROLLBAR_LINGER_MS
      );
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      element.removeEventListener('scroll', onScroll);
      window.clearTimeout(timer);
    };
  }, []);

  return ref;
}
