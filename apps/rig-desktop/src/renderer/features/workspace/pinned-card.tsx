import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Cloud, Diff, FolderTree, Loader2, Sparkles, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { NavigatorContent } from '@renderer/features/artifact/navigator-popover';
import { relativeTime } from '@renderer/features/chat/session-history';
import {
  fileLinks,
  stripRigPrefix,
  summarySegments,
  type SummarySegment,
} from '@renderer/features/home/summary-segments';
import { usePulseBriefing } from '@renderer/features/home/use-pulse-briefing';
import { NewMenu } from '@renderer/features/rig-import/add-menu';
import { ImportDocDialog } from '@renderer/features/rig-import/import-doc-dialog';
import { RigSharePopoverContent } from '@renderer/features/rig-share/rig-share-button';
import { events, rpc } from '@renderer/lib/ipc';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { RigMark } from '@renderer/lib/ui/rig-mark';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { selectCards, toContentOnlyPinned, toContentOnlyWrites } from '@shared/rig/card-rail';
import {
  classifyEntryCategory,
  filterToContentOnly,
} from '@shared/rig/file-navigator-categories';
import { rigFileChangeChannel, type RigFileNode } from '@shared/rig/files';
import { computeUnseenSummary, type SeenMap } from '@shared/rig/seen-state';
import { rigSettingsChangedChannel } from '@shared/rig/settings';
import { iconFor, rigFilesQueryKey } from './file-tree';
import { useEverWrittenPaths, useRecentWrites } from './write-activity';

/**
 * Session-first viewer: the PINNED CARD — the rig's state, floating over
 * the full-bleed session instead of owning a panel. Two sections in one
 * row grammar (label left, status right, 28px tall):
 *
 *   RIG — state claims: Changes (recency + the pulse story), Files (the
 *   browse door), Cloud (backup), Skills, People. Rows render only while
 *   they have something true to say (Skills disappears at zero; People
 *   stays for a solo rig because that IS the invite moment).
 *
 *   ACTIVITY — the working set, same selection engine as the old carousel
 *   (`selectCards`). Shimmer is the ONE live-write signal; the accent dot
 *   marks new; the rig mark is the only authorship the app can honestly
 *   claim (see `write-activity.ts`).
 *
 * Feedback round 2: rows EXPAND IN PLACE — an accordion, exactly one
 * section open — instead of popovers hanging off the card. The card is
 * itself a floating surface; float-on-float detached each row's content
 * from the row that named it, and two could stack open at once. Inline
 * disclosure keeps the content under its label, and one-open-at-a-time
 * gives replace-not-stack for free. Popovers remain only for true
 * transient menus (the New menu inside the Files section).
 *
 * Collapses to a slim chip (name + new count + sync dot) — persisted in
 * localStorage like the other purely-cosmetic layout preferences.
 */

const COLLAPSED_KEY = 'rig-pinned-card-collapsed';
const SUMMARY_OPEN_KEY = 'rig-changes-summary-open';
const MAX_ACTIVITY_ROWS = 5;
const CHANGED_RECENTLY_MS = 24 * 60 * 60 * 1000;

type CardSection = 'changes' | 'files' | 'skills' | 'people';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Feedback round 1: the Changes summary defaults to SHOWN; only an explicit collapse is remembered. */
function readSummaryOpen(): boolean {
  try {
    return localStorage.getItem(SUMMARY_OPEN_KEY) !== 'false';
  } catch {
    return true;
  }
}

/**
 * Feedback round 1: skill files are almost all literally named `SKILL.md`
 * — the identity lives in the folder (`.claude/skills/<name>/SKILL.md`) or
 * the document's own title. Name the skill, not its file.
 */
function skillDisplayName(node: RigFileNode): string {
  if (node.title) return node.title;
  const segments = node.relPath.split('/');
  const base = segments[segments.length - 1] ?? node.name;
  if (/^skill\.md$/i.test(base) && segments.length >= 2) {
    return segments[segments.length - 2] ?? node.name;
  }
  return node.name;
}

function flattenFiles(nodes: readonly RigFileNode[]): RigFileNode[] {
  const out: RigFileNode[] = [];
  const walk = (list: readonly RigFileNode[]) => {
    for (const node of list) {
      if (node.kind === 'dir') walk(node.children ?? []);
      else out.push(node);
    }
  };
  walk(nodes);
  return out;
}

export function PinnedCard({
  root,
  rootId,
  bindingId,
  name,
  syncing,
  onOpenFile,
  onOpenFocus,
}: {
  root: string;
  rootId: string;
  bindingId: string;
  name: string | null;
  /** First-sync round: this rig was just attached and tapd is still pulling files down. */
  syncing: boolean;
  /** Opens in an editor tab; relPath rides along so this card can mark it seen. */
  onOpenFile: (absPath: string, relPath: string) => void;
  onOpenFocus: () => void;
}) {
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [importOpen, setImportOpen] = useState(false);
  const toggleCollapsed = () => {
    setCollapsed((current) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, String(!current));
      } catch {
        // localStorage unavailable — just won't persist.
      }
      return !current;
    });
  };

  // The accordion: exactly one section open. Only the Changes preference
  // persists (its summary defaults open); the rest are transient looks.
  const [expanded, setExpanded] = useState<CardSection | null>(
    readSummaryOpen() ? 'changes' : null
  );
  const toggleSection = (section: CardSection) => {
    setExpanded((current) => {
      const next = current === section ? null : section;
      if (section === 'changes') {
        try {
          localStorage.setItem(SUMMARY_OPEN_KEY, String(next === 'changes'));
        } catch {
          // localStorage unavailable — just won't persist.
        }
      }
      return next;
    });
  };

  const filesKey = rigFilesQueryKey(root, rootId);
  const { data } = useQuery({
    queryKey: filesKey,
    queryFn: async () => {
      const result = await rpc.rig.files.list({ rootId });
      if (!result.success) throw new Error(result.error.message);
      return result.data;
    },
  });
  // The listing goes stale the moment anything under the root changes —
  // App.tsx already holds the watch registration for this rootId; this is
  // just the read side.
  useEffect(() => {
    const key = rigFilesQueryKey(root, rootId);
    return events.on(rigFileChangeChannel, ({ rootId: changed }) => {
      if (changed !== rootId) return;
      void queryClient.invalidateQueries({ queryKey: key });
    });
  }, [rootId, root, queryClient]);

  const membersQuery = useQuery({
    queryKey: ['rig', 'share', 'members', root],
    queryFn: () => rpc.rig.share.members({ root }),
    staleTime: 60_000,
  });
  const members = membersQuery.data?.success ? membersQuery.data.data.members : [];

  // Seen-state, same source as the old tree: baseline + per-file marks,
  // refreshed whenever the filesystem stirs (a synced-down edit is exactly
  // what should flip a row to new).
  const [seenState, setSeenState] = useState<{ baselineAt: number; seen: SeenMap } | null>(null);
  useEffect(() => {
    let alive = true;
    const fetchSeen = () => {
      void rpc.rig.seenState.getState({ bindingId }).then((state) => {
        if (alive) setSeenState(state);
      });
    };
    fetchSeen();
    const off = events.on(rigFileChangeChannel, ({ rootId: changed }) => {
      if (changed === rootId) fetchSeen();
    });
    return () => {
      alive = false;
      off();
    };
  }, [bindingId, rootId]);

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
  const agentWritten = useEverWrittenPaths(root);

  const contentTree = useMemo(() => filterToContentOnly(data ?? []), [data]);
  const contentFiles = useMemo(() => flattenFiles(contentTree), [contentTree]);
  const skillFiles = useMemo(
    () =>
      flattenFiles(data ?? []).filter((node) => classifyEntryCategory(node.relPath) === 'skills'),
    [data]
  );

  const unseenFiles = useMemo(
    () =>
      seenState
        ? computeUnseenSummary(contentTree, seenState.seen, seenState.baselineAt).unseenFiles
        : new Set<string>(),
    [contentTree, seenState]
  );
  const changedRecently = useMemo(() => {
    const cutoff = Date.now() - CHANGED_RECENTLY_MS;
    return contentFiles.filter((node) => (node.mtimeMs ?? 0) >= cutoff).length;
  }, [contentFiles]);

  const activity = useMemo(() => {
    const fresh = contentFiles
      .filter((node) => node.mtimeMs !== undefined)
      .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))
      .slice(0, MAX_ACTIVITY_ROWS)
      .map((node) => ({ relPath: node.relPath, at: node.mtimeMs as number }));
    return selectCards({
      pinnedRelPaths: toContentOnlyPinned(pinned),
      inProgress: toContentOnlyWrites(recentWrites),
      fresh,
      maxNonPinned: MAX_ACTIVITY_ROWS,
    }).slice(0, MAX_ACTIVITY_ROWS);
  }, [contentFiles, pinned, recentWrites]);
  const activePaths = useMemo(
    () => new Set(toContentOnlyWrites(recentWrites).map((w) => w.relPath)),
    [recentWrites]
  );

  const openFile = (relPath: string) => {
    // App.tsx's openFile owns the markSeen RPC (one semantic, one owner) —
    // this is only the optimistic local update so the dot clears now, not
    // after the next fs event.
    setSeenState((prev) =>
      prev ? { ...prev, seen: { ...prev.seen, [relPath]: Date.now() } } : prev
    );
    onOpenFile(`${root}/${relPath}`, relPath);
  };

  // The rig's one-line story — the same per-rig pulse line Home narrates,
  // shown under the Changes row. File names in it are live links.
  const { state: briefingState } = usePulseBriefing();
  const briefing = briefingState.kind === 'data' ? briefingState.briefing : null;
  const rigEntry = briefing?.perRig.find((item) => item.bindingId === bindingId) ?? null;
  const rigLine = rigEntry ? stripRigPrefix(rigEntry.line, rigEntry.rigName) : null;
  const summarySegs: SummarySegment[] = useMemo(
    () => (rigLine ? summarySegments(rigLine, fileLinks(contentFiles)) : []),
    [rigLine, contentFiles]
  );

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={toggleCollapsed}
        aria-label="Show rig details"
        className="card-pop-in border-border-hairline bg-bg-1 shadow-float hover:bg-bg-2 absolute top-[52px] right-4 z-20 flex origin-top-right items-center gap-1.5 rounded-chip border py-1 pr-2.5 pl-2 transition-colors"
      >
        <span className={cn('size-1.5 rounded-full', syncing ? 'bg-warning' : 'bg-success')} />
        <span className="max-w-36 truncate text-xs text-text-primary">{name ?? 'This rig'}</span>
        {unseenFiles.size > 0 && (
          <span className="bg-accent-subtle text-accent rounded-chip px-1.5 font-mono text-2xs">
            {unseenFiles.size}
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="card-pop-in border-border-hairline bg-bg-1 shadow-float absolute top-[52px] right-4 z-20 flex max-h-[calc(100vh-140px)] w-[304px] origin-top-right flex-col overflow-y-auto rounded-card border p-2">
      <div className="flex h-6 shrink-0 items-center px-2">
        <p className="font-mono text-2xs tracking-wide text-text-muted uppercase">Rig</p>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={toggleCollapsed}
                aria-label="Hide rig details"
                className="hover:bg-bg-2 hover:text-text-primary ml-auto flex size-5 items-center justify-center rounded-control text-text-muted transition-colors"
              >
                <ChevronRight className="size-3.5" strokeWidth={1.5} />
              </button>
            }
          />
          <TooltipContent side="bottom">Hide</TooltipContent>
        </Tooltip>
      </div>
      <ImportDocDialog
        root={root}
        rootId={rootId}
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={(absPath) => {
          const relPath = absPath.startsWith(`${root}/`) ? absPath.slice(root.length + 1) : null;
          if (relPath) openFile(relPath);
        }}
      />

      {/* ── RIG rows — one grammar: icon · label ····· value · chevron.
          Every row is a disclosure; its content expands IN PLACE. ── */}
      <div className="hover:bg-bg-2 flex h-7 shrink-0 items-center rounded-control pr-2 transition-colors">
        <button
          type="button"
          onClick={() => toggleSection('changes')}
          aria-expanded={expanded === 'changes'}
          className="flex h-full min-w-0 flex-1 items-center gap-2 pl-2 text-left"
        >
          <Diff className="size-3.5 shrink-0 text-text-muted" strokeWidth={1.5} />
          <span className="text-xs text-text-primary">Changes</span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {changedRecently === 0 && unseenFiles.size === 0 ? (
              <span className="text-2xs text-text-muted">Up to date</span>
            ) : changedRecently > 0 ? (
              // "0 today" beside a new-count is pure noise — the chip
              // alone carries that state.
              <span className="font-mono text-2xs text-text-muted">{changedRecently} today</span>
            ) : null}
            <ChevronRight
              className={cn(
                'size-3 shrink-0 text-text-muted transition-transform',
                expanded === 'changes' && 'rotate-90'
              )}
              strokeWidth={1.5}
            />
          </span>
        </button>
        {unseenFiles.size > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={onOpenFocus}
                  className="bg-accent-subtle text-accent ml-1.5 shrink-0 rounded-chip px-1.5 font-mono text-2xs transition-opacity hover:opacity-80"
                >
                  {unseenFiles.size} new
                </button>
              }
            />
            <TooltipContent side="left">Read what’s new</TooltipContent>
          </Tooltip>
        )}
      </div>
      {expanded === 'changes' && summarySegs.length > 0 && (
        <p className="popover-in shrink-0 px-2 pt-0.5 pb-1.5 text-xs leading-relaxed text-text-muted">
          {summarySegs.map((segment, index) =>
            segment.kind === 'link' && segment.target.kind === 'file' ? (
              <button
                key={`${segment.text}-${index}`}
                type="button"
                onClick={() => {
                  const relPath = (segment.target as { kind: 'file'; relPath: string }).relPath;
                  openFile(relPath);
                }}
                className="text-text-secondary hover:text-text-primary underline decoration-current/30 underline-offset-2 transition-colors"
              >
                {segment.text}
              </button>
            ) : (
              <span key={index}>{segment.text}</span>
            )
          )}
        </p>
      )}

      {/* P1: the browse door — every file in the rig, reachable at rest. */}
      <button
        type="button"
        onClick={() => toggleSection('files')}
        aria-expanded={expanded === 'files'}
        className="hover:bg-bg-2 flex h-7 shrink-0 items-center gap-2 rounded-control px-2 text-left transition-colors"
      >
        <FolderTree className="size-3.5 shrink-0 text-text-muted" strokeWidth={1.5} />
        <span className="text-xs text-text-primary">Files</span>
        <span className="ml-auto flex items-center gap-1.5">
          <span className="font-mono text-2xs text-text-muted">{contentFiles.length}</span>
          <ChevronRight
            className={cn(
              'size-3 shrink-0 text-text-muted transition-transform',
              expanded === 'files' && 'rotate-90'
            )}
            strokeWidth={1.5}
          />
        </span>
      </button>
      {expanded === 'files' && (
        <div className="popover-in shrink-0 px-1 pb-1">
          <NavigatorContent
            root={root}
            rootId={rootId}
            onOpenFile={(_absPath, relPath) => openFile(relPath)}
          />
          {/* Creation lives WITH the files it creates (feedback round 2:
              the header + was placeless). The menu itself stays a popover
              — that's a true transient menu's grammar. */}
          <div className="mt-1.5 flex items-center px-1">
            <NewMenu
              root={root}
              rootId={rootId}
              onOpenFile={(absPath) => {
                const relPath = absPath.startsWith(`${root}/`)
                  ? absPath.slice(root.length + 1)
                  : null;
                if (relPath) openFile(relPath);
                else onOpenFile(absPath, '');
              }}
              onOpenImportDialog={() => setImportOpen(true)}
            />
          </div>
        </div>
      )}

      <Tooltip>
        <TooltipTrigger
          render={
            <div className="flex h-7 shrink-0 items-center gap-2 rounded-control px-2">
              <Cloud className="size-3.5 shrink-0 text-text-muted" strokeWidth={1.5} />
              <span className="text-xs text-text-primary">Cloud</span>
              <span className="ml-auto flex items-center gap-1.5">
                {syncing ? (
                  <>
                    <Loader2 className="size-3 animate-spin text-text-muted" strokeWidth={1.5} />
                    <span className="text-2xs text-text-muted">Downloading…</span>
                  </>
                ) : (
                  <>
                    <span className="size-1.5 rounded-full bg-success" />
                    <span className="text-2xs text-text-muted">Backed up</span>
                  </>
                )}
              </span>
            </div>
          }
        />
        <TooltipContent side="left">
          {syncing ? 'Downloading this rig’s files' : 'Backed up to Rig’s cloud'}
        </TooltipContent>
      </Tooltip>

      {skillFiles.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => toggleSection('skills')}
            aria-expanded={expanded === 'skills'}
            className="hover:bg-bg-2 flex h-7 shrink-0 items-center gap-2 rounded-control px-2 text-left transition-colors"
          >
            <Sparkles className="size-3.5 shrink-0 text-text-muted" strokeWidth={1.5} />
            <span className="text-xs text-text-primary">Skills</span>
            <span className="ml-auto flex items-center gap-1.5">
              <span className="font-mono text-2xs text-text-muted">{skillFiles.length}</span>
              <ChevronRight
                className={cn(
                  'size-3 shrink-0 text-text-muted transition-transform',
                  expanded === 'skills' && 'rotate-90'
                )}
                strokeWidth={1.5}
              />
            </span>
          </button>
          {expanded === 'skills' && (
            <div className="popover-in shrink-0 pb-1">
              {skillFiles.map((node) => {
                const Icon = iconFor(node.name);
                return (
                  <button
                    key={node.relPath}
                    type="button"
                    onClick={() => openFile(node.relPath)}
                    className="hover:bg-bg-2 flex h-7 w-full items-center gap-1.5 rounded-control py-1 pr-2 pl-8 text-left text-xs text-text-secondary transition-colors hover:text-text-primary"
                  >
                    <Icon className="size-3.5 shrink-0 text-text-muted" strokeWidth={1.5} />
                    <span className="min-w-0 truncate">{skillDisplayName(node)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Rendered whenever membership is KNOWN — including "just you".
          A fresh solo rig is exactly the invite-your-cofounder moment;
          honest silence there hid the product's wedge (impeccable). */}
      {membersQuery.data?.success && (
        <>
          <button
            type="button"
            onClick={() => toggleSection('people')}
            aria-expanded={expanded === 'people'}
            className="hover:bg-bg-2 flex h-7 shrink-0 items-center gap-2 rounded-control px-2 text-left transition-colors"
          >
            <Users className="size-3.5 shrink-0 text-text-muted" strokeWidth={1.5} />
            <span className="text-xs text-text-primary">People</span>
            <span className="ml-auto flex items-center gap-1.5">
              {members.length === 0 ? (
                <span className="text-accent text-2xs font-medium">Invite</span>
              ) : (
                <span className="flex items-center">
                  {members.slice(0, 3).map((member, index) => (
                    <IdentityAvatar
                      key={member.userId}
                      name={member.name ?? member.email}
                      avatarUrl={member.avatarUrl}
                      sizeClassName="size-4"
                      textClassName="text-2xs"
                      className={cn('ring-bg-1 ring-1', index > 0 && '-ml-1')}
                    />
                  ))}
                  {members.length > 3 && (
                    <span className="bg-bg-2 text-text-muted ring-bg-1 -ml-1 flex size-4 shrink-0 items-center justify-center rounded-chip font-mono text-2xs ring-1">
                      +{members.length - 3}
                    </span>
                  )}
                </span>
              )}
              <ChevronRight
                className={cn(
                  'size-3 shrink-0 text-text-muted transition-transform',
                  expanded === 'people' && 'rotate-90'
                )}
                strokeWidth={1.5}
              />
            </span>
          </button>
          {expanded === 'people' && (
            <div className="popover-in shrink-0 pb-1">
              <RigSharePopoverContent root={root} name={name} />
            </div>
          )}
        </>
      )}

      {/* ── ACTIVITY — the working set, same geometry, no icon column ── */}
      {activity.length > 0 && (
        <>
          <div className="bg-border-hairline mx-2 my-1.5 h-px shrink-0" />
          <p className="flex h-6 shrink-0 items-center px-2 font-mono text-2xs tracking-wide text-text-muted uppercase">
            Activity
          </p>
          {activity.map((card) => {
            const active = activePaths.has(card.relPath);
            const unseen = !active && unseenFiles.has(card.relPath);
            const fileName = card.relPath.split('/').pop() ?? card.relPath;
            return (
              <button
                key={card.relPath}
                type="button"
                onClick={() => openFile(card.relPath)}
                className="hover:bg-bg-2 flex h-7 shrink-0 items-center gap-1.5 rounded-control px-2 text-left transition-colors"
              >
                {unseen && (
                  <span className="unseen-dot-in bg-accent size-[5px] shrink-0 rounded-full" />
                )}
                <span
                  className={cn(
                    'min-w-0 truncate text-xs',
                    active ? 'active-shimmer text-text-primary' : 'text-text-primary'
                  )}
                >
                  {fileName}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-1 font-mono text-2xs text-text-muted">
                  {active ? (
                    <>
                      <RigMark size={10} className="shrink-0" />
                      now
                    </>
                  ) : (
                    <>
                      {agentWritten.has(card.relPath) && (
                        <RigMark size={10} className="shrink-0 opacity-60" />
                      )}
                      {card.at === undefined ? 'pinned' : relativeTime(card.at, Date.now())}
                    </>
                  )}
                </span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={onOpenFocus}
            className="hover:bg-bg-2 flex h-6 shrink-0 items-center rounded-control px-2 text-left text-2xs text-text-muted transition-colors hover:text-text-primary"
          >
            View all
          </button>
        </>
      )}
    </div>
  );
}
