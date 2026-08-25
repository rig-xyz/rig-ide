import { useQuery } from '@tanstack/react-query';
import { Pin, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { cn } from '@renderer/lib/utils';
import { type Card, selectCards, toContentOnlyPinned, toContentOnlyWrites } from '@shared/rig/card-rail';
import { filterToContentOnly } from '@shared/rig/file-navigator-categories';
import { rigSettingsChangedChannel } from '@shared/rig/settings';
import type { RigFileNode } from '@shared/rig/files';
import { computeUnseenSummary, rigSeenStateChangedChannel, type SeenMap } from '@shared/rig/seen-state';
import { displayTitle, iconFor, rigFilesQueryKey } from './file-tree';
import { reasonForCard } from './suggested-reason';
import { useRecentWrites } from './write-activity';

/**
 * File-navigator redesign v2 (`docs/file-navigator-design.md` §3.2): the
 * Suggested group — round-1's horizontally-scrolled tile rail, rebuilt onto
 * the tree's own row chassis, vertical, capped at 3, wrapped in a single
 * rounded container. Populated by `selectCards` (pure, `shared/rig/card-rail.ts`)
 * from three real signals: `rpc.rig.settings`'s `pinnedPathsByRig`,
 * `write-activity.ts`'s live agent-write observations, and seen-state — same
 * three signals slice 3/4 already built, just re-presented per the v2 spec.
 *
 * CONTENT ONLY, structurally (§3.2, the round-1 bug this fixes: `daemon.log`
 * surfacing as a suggestion): the raw listing is filtered through
 * `filterToContentOnly` BEFORE `fresh` is ever derived from it, and
 * pinned/in-progress candidates are run through `toContentOnlyPinned`/
 * `toContentOnlyWrites` at the same input boundary before ever reaching
 * `selectCards` — a system/skills path can never become a card, by
 * construction, not by a render-time filter. Reads the SAME cached file
 * listing `FileTree` already queries (`rigFilesQueryKey`) — no second
 * `rig.files.list` round trip. Collapses to nothing when there are no cards
 * (no empty shell).
 */

const MAX_SUGGESTED = 3;

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

export function SuggestedFiles({
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

  // §3.2's content-only boundary: filter the tree FIRST, everything derived
  // from it (nodeByPath, fresh) is content-only for free from then on.
  const contentTree = useMemo(() => filterToContentOnly(data ?? []), [data]);
  const nodeByPath = useMemo(() => {
    const map = new Map<string, RigFileNode>();
    for (const node of flattenFiles(contentTree)) map.set(node.relPath, node);
    return map;
  }, [contentTree]);

  const fresh = useMemo(() => {
    if (!seenState) return [];
    const { unseenFiles } = computeUnseenSummary(contentTree, seenState.seen, seenState.baselineAt);
    return [...unseenFiles].map((relPath) => ({
      relPath,
      at: nodeByPath.get(relPath)?.mtimeMs ?? seenState.baselineAt,
    }));
  }, [contentTree, seenState, nodeByPath]);

  const inProgress = useMemo(
    () => toContentOnlyWrites(recentWrites).filter((w) => !dismissedInProgress.has(w.relPath)),
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

  // §3.2: "at most 3 rows... cap 3" — a hard total cap (unlike slice 3's
  // unbounded-pinned rail), so pinned/in-progress/fresh are all subject to
  // it now. `selectCards` itself is untouched (`maxNonPinned` still only
  // caps in-progress+fresh) — the outer `.slice` is the call-site's own cap,
  // applied AFTER `selectCards` already orders pinned-first.
  const cards = useMemo(
    () =>
      selectCards({
        pinnedRelPaths: toContentOnlyPinned(pinned),
        inProgress,
        fresh,
        maxNonPinned: MAX_SUGGESTED,
      }).slice(0, MAX_SUGGESTED),
    [pinned, inProgress, fresh]
  );

  const railRef = useRef<HTMLDivElement>(null);
  useFlip(
    railRef,
    cards.map((c) => c.relPath).join('|')
  );

  if (cards.length === 0) return null;

  return (
    <div className="border-border-hairline bg-bg-1 mx-3 mt-2 shrink-0 overflow-hidden rounded-lg border">
      <p className="text-text-muted px-3 pt-2 pb-1 text-[10px] font-medium tracking-wide uppercase">Suggested</p>
      <div ref={railRef} className="flex flex-col pb-1">
        {cards.map((card) => {
          const node = nodeByPath.get(card.relPath);
          const isPinned = pinned.includes(card.relPath);
          return (
            <SuggestedRow
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
    </div>
  );
}

/**
 * Row anatomy (§3.2): type icon, title (medium weight), then a muted reason
 * — same chassis as a tree row (full-row rounded hover), not a tile. Pin/
 * dismiss glyphs appear only on hover, at the right edge — no per-row
 * chrome at rest beyond the reason text itself.
 */
function SuggestedRow({
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
  const reason = reasonForCard(card, Date.now());

  return (
    <div data-card-key={card.relPath} className="card-pop-in group flex h-8 items-center gap-2 px-2">
      <button
        type="button"
        onClick={onOpen}
        className="rounded-control hover:bg-bg-2 flex min-w-0 flex-1 items-center gap-2 px-1 py-1 text-left transition-colors"
      >
        <Icon className="text-text-secondary size-3.5 shrink-0" strokeWidth={1.5} />
        <span className="text-text-primary min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        <span className="text-text-muted flex shrink-0 items-center gap-1 text-xs">
          {reason.pulsing && <span className="bg-accent pulse-dot size-[5px] shrink-0 rounded-full" />}
          {reason.text}
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
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
    </div>
  );
}

/**
 * Minimal FLIP: measures each row's position before a reflow (keyed by
 * `dep`, the ordered relPath list joined into one string — cheap identity
 * for "did the order change"), then on the next layout applies the inverse
 * transform and animates it back to identity. `prefers-reduced-motion`
 * skips the animated leg entirely — the DOM still reflows instantly, just
 * without the sibling glide. This is the app's only sibling-reflow
 * animation; new-row entrance is the separate `card-pop-in` CSS class, and
 * the group's own appearance is `suggested-group-in`.
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
