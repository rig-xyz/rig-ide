import { useQuery } from '@tanstack/react-query';
import { Bot, Pin, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { relativeTime } from '@renderer/features/chat/session-history';
import { events, rpc } from '@renderer/lib/ipc';
import { cn } from '@renderer/lib/utils';
import { type Card, selectCards } from '@shared/rig/card-rail';
import { rigSettingsChangedChannel } from '@shared/rig/settings';
import type { RigFileNode } from '@shared/rig/files';
import { computeUnseenSummary, rigSeenStateChangedChannel, type SeenMap } from '@shared/rig/seen-state';
import { breadcrumbSegments } from '@renderer/features/artifact/breadcrumb';
import { displayTitle, iconFor, rigFilesQueryKey } from './file-tree';
import { useRecentWrites } from './write-activity';

/**
 * File-navigator redesign (`docs/file-navigator-design.md` §3): the card
 * rail — Pinned, In progress, Fresh, populated by `selectCards` (pure,
 * `shared/rig/card-rail.ts`) from three real signals: `rpc.rig.settings`'s
 * `pinnedPathsByRig`, `write-activity.ts`'s live agent-write observations,
 * and slice 3's seen-state. Reads the SAME cached file listing `FileTree`
 * already queries (`rigFilesQueryKey`) — no second `rig.files.list` round
 * trip. Collapses to nothing when there are no cards.
 */

const MAX_NON_PINNED = 5;

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

/** "folder / folder" for a file's relPath — empty for a rig-root file. Reuses the artifact header's own breadcrumb split (root='' so the whole relPath is treated as already-relative). */
function folderBreadcrumb(relPath: string): string {
  const segments = breadcrumbSegments('', relPath);
  return segments
    .slice(0, -1)
    .map((s) => s.label)
    .join(' / ');
}

export function CardRail({
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

  const [seenState, setSeenState] = useState<{ baselineAt: number; seen: SeenMap } | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      void rpc.rig.seenState.getState({ bindingId }).then((state) => {
        if (alive) setSeenState(state);
      });
    };
    load();
    const off = events.on(rigSeenStateChangedChannel, ({ bindingId: changed }) => {
      if (changed === bindingId) load();
    });
    return () => {
      alive = false;
      off();
    };
  }, [bindingId]);

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
  const [dismissedInProgress, setDismissedInProgress] = useState<Set<string>>(new Set());

  const nodeByPath = useMemo(() => {
    const map = new Map<string, RigFileNode>();
    for (const node of flattenFiles(data ?? [])) map.set(node.relPath, node);
    return map;
  }, [data]);

  const fresh = useMemo(() => {
    if (!seenState || !data) return [];
    const { unseenFiles } = computeUnseenSummary(data, seenState.seen, seenState.baselineAt);
    return [...unseenFiles].map((relPath) => ({
      relPath,
      at: nodeByPath.get(relPath)?.mtimeMs ?? seenState.baselineAt,
    }));
  }, [data, seenState, nodeByPath]);

  const inProgress = useMemo(
    () => recentWrites.filter((w) => !dismissedInProgress.has(w.relPath)),
    [recentWrites, dismissedInProgress]
  );

  const togglePin = (relPath: string) => {
    const next = pinned.includes(relPath) ? pinned.filter((p) => p !== relPath) : [...pinned, relPath];
    setPinned(next);
    void rpc.rig.settings.set({ pinnedPathsByRig: { [bindingId]: next } });
  };

  const dismiss = (card: Card) => {
    if (card.type === 'pinned') {
      togglePin(card.relPath);
    } else if (card.type === 'in-progress') {
      setDismissedInProgress((prev) => new Set(prev).add(card.relPath));
    } else {
      void rpc.rig.seenState.markSeen({ bindingId, relPath: card.relPath });
    }
  };

  const cards = useMemo(
    () => selectCards({ pinnedRelPaths: pinned, inProgress, fresh, maxNonPinned: MAX_NON_PINNED }),
    [pinned, inProgress, fresh]
  );

  const railRef = useRef<HTMLDivElement>(null);
  useFlip(
    railRef,
    cards.map((c) => c.relPath).join('|')
  );

  if (cards.length === 0) return null;

  return (
    <div
      ref={railRef}
      className="border-border-hairline flex shrink-0 gap-2 overflow-x-auto border-b px-3 py-2"
    >
      {cards.map((card) => {
        const node = nodeByPath.get(card.relPath);
        const isPinned = pinned.includes(card.relPath);
        return (
          <CardItem
            key={card.relPath}
            card={card}
            node={node}
            isPinned={isPinned}
            onOpen={() => onOpenFile(`${root}/${card.relPath}`, card.relPath)}
            onTogglePin={() => togglePin(card.relPath)}
            onDismiss={() => dismiss(card)}
          />
        );
      })}
    </div>
  );
}

function CardItem({
  card,
  node,
  isPinned,
  onOpen,
  onTogglePin,
  onDismiss,
}: {
  card: Card;
  node: RigFileNode | undefined;
  isPinned: boolean;
  onOpen: () => void;
  onTogglePin: () => void;
  onDismiss: () => void;
}) {
  const title = node ? displayTitle(node) : card.relPath.split('/').pop() ?? card.relPath;
  const Icon = iconFor(node?.name ?? card.relPath);
  const breadcrumb = folderBreadcrumb(card.relPath);

  return (
    <div
      data-card-key={card.relPath}
      className="card-pop-in group border-border-hairline bg-bg-1 hover:border-border-strong rounded-card relative flex w-44 shrink-0 flex-col gap-1 border p-2 text-left transition-colors"
    >
      <div className="absolute top-1 right-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onTogglePin();
          }}
          aria-label={isPinned ? 'Unpin' : 'Pin'}
          title={isPinned ? 'Unpin' : 'Pin'}
          className={cn(
            'rounded-control hover:bg-bg-2 flex size-5 items-center justify-center',
            isPinned ? 'text-accent' : 'text-text-muted hover:text-text-primary'
          )}
        >
          <Pin className="size-3" strokeWidth={1.5} fill={isPinned ? 'currentColor' : 'none'} />
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onDismiss();
          }}
          aria-label={card.type === 'pinned' ? 'Unpin' : 'Dismiss'}
          title={card.type === 'pinned' ? 'Unpin' : 'Dismiss'}
          className="rounded-control hover:bg-bg-2 text-text-muted hover:text-text-primary flex size-5 items-center justify-center"
        >
          <X className="size-3" strokeWidth={1.5} />
        </button>
      </div>

      <button type="button" onClick={onOpen} className="flex min-w-0 flex-col gap-1 text-left">
        <div className="flex items-center gap-1.5 pr-8">
          <span className="relative flex shrink-0 items-center justify-center">
            <Icon className="text-text-secondary size-3.5" strokeWidth={1.5} />
            {card.type === 'in-progress' && (
              <span className="bg-accent pulse-dot absolute -top-0.5 -right-0.5 size-1.5 rounded-full" />
            )}
          </span>
          <span className="text-text-primary min-w-0 truncate text-xs font-medium">{title}</span>
        </div>
        {breadcrumb && <span className="text-text-muted truncate text-xs">{breadcrumb}</span>}
        <span className="text-text-muted flex items-center gap-1 text-xs">
          {card.sessionId && <Bot className="size-3 shrink-0" strokeWidth={1.5} />}
          {card.at !== undefined ? relativeTime(card.at, Date.now()) : 'Pinned'}
        </span>
      </button>
    </div>
  );
}

/**
 * Minimal FLIP: measures each card's position before a reflow (keyed by
 * `dep`, the ordered relPath list joined into one string — cheap identity
 * for "did the order change"), then on the next layout applies the inverse
 * transform and animates it back to identity. `prefers-reduced-motion`
 * skips the animated leg entirely — the DOM still reflows instantly, just
 * without the sibling glide. This is the app's only sibling-reflow
 * animation; new-card entrance is the separate `card-pop-in` CSS class.
 */
function useFlip(containerRef: React.RefObject<HTMLDivElement | null>, dep: string): void {
  const prevRects = useRef<Map<string, DOMRect>>(new Map());

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const reduceMotion =
      typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const children = Array.from(container.querySelectorAll<HTMLElement>('[data-card-key]'));

    if (!reduceMotion) {
      for (const child of children) {
        const key = child.dataset.cardKey;
        if (!key) continue;
        const prev = prevRects.current.get(key);
        if (!prev) continue;
        const next = child.getBoundingClientRect();
        const dx = prev.left - next.left;
        const dy = prev.top - next.top;
        if (dx === 0 && dy === 0) continue;
        child.style.transition = 'none';
        child.style.transform = `translate(${dx}px, ${dy}px)`;
        requestAnimationFrame(() => {
          child.style.transition = 'transform 200ms ease-out';
          child.style.transform = '';
        });
      }
    }

    const rects = new Map<string, DOMRect>();
    for (const child of children) {
      const key = child.dataset.cardKey;
      if (key) rects.set(key, child.getBoundingClientRect());
    }
    prevRects.current = rects;
    // `dep` is a deliberate proxy for "card set or order changed" — the
    // actual measurement reads live DOM rects, not this string. `containerRef`
    // is a stable ref object (identity never changes), included only to
    // satisfy exhaustive-deps.
  }, [dep, containerRef]);
}
