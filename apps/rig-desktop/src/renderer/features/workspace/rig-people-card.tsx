import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { relativeTime } from '@renderer/features/chat/session-history';
import {
  fileLinks,
  stripRigPrefix,
  summarySegments,
  type SummarySegment,
} from '@renderer/features/home/summary-segments';
import { usePulseBriefing } from '@renderer/features/home/use-pulse-briefing';
import { rpc } from '@renderer/lib/ipc';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { rigFilesQueryKey } from './file-tree';

/**
 * The workspace's PEOPLE section: who is in this rig, and one line about
 * what has been happening in it.
 *
 * Two rules learned the hard way. First, the line has to be about THIS rig
 * — the briefing's per-person narration is account-wide and reads as
 * generic filler when you are standing inside one rig, so `perRig` is the
 * only part shown. Second, people and that line stay visually separate: an
 * earlier version stacked the rig summary directly under a member's name
 * and avatar, which read as something that person had said.
 *
 * The briefing is a cached narration the relay regenerates roughly every
 * three hours, and `usePulseBriefing` already forces a fresh one when it
 * ages out. The refresh control is therefore a nudge for impatience, not
 * the mechanism, and stays hidden until the section is hovered.
 */
export function RigPeopleCard({
  root,
  rootId,
  bindingId,
  onOpenFile,
}: {
  root: string;
  rootId: string;
  bindingId: string | null;
  /** Opens a file the summary names — same handler the tree and cards use. */
  onOpenFile: (absPath: string, relPath: string) => void;
}) {
  const membersQuery = useQuery({
    queryKey: ['rig', 'share', 'members', root],
    queryFn: () => rpc.rig.share.members({ root }),
    staleTime: 60_000,
  });
  const { state, refreshing, forceRefresh } = usePulseBriefing();
  // The listing the tree already fetched — a second reader of one cache
  // entry, not a second call. Files the summary names become links.
  const filesQuery = useQuery({
    queryKey: rigFilesQueryKey(root, rootId),
    queryFn: async () => {
      const result = await rpc.rig.files.list({ rootId });
      if (!result.success) throw new Error(result.error.message);
      return result.data;
    },
  });

  const members = membersQuery.data?.success ? membersQuery.data.data.members : [];
  const briefing = state.kind === 'data' ? state.briefing : null;
  const generatedAt = briefing ? Date.parse(briefing.generatedAt) : NaN;
  /**
   * THIS rig's line, not the account-wide personal one. `perPerson` reads
   * "across 3 rigs, CTO reviews, grammar cleanup" — true, and completely
   * generic when you are standing inside one rig looking at its files.
   * `perRig` is the only part of the briefing actually about the rig in
   * front of you, so it is the only part shown here.
   */
  const rigEntry = bindingId
    ? (briefing?.perRig.find((item) => item.bindingId === bindingId) ?? null)
    : null;
  const rigLine = rigEntry ? stripRigPrefix(rigEntry.line, rigEntry.rigName) : null;
  const segments = rigLine
    ? summarySegments(rigLine, fileLinks(flattenFiles(filesQuery.data ?? [])))
    : [];

  // A rig nobody shares is a rig with nothing to say about people. Local
  // rigs and unreachable-relay states both land here.
  if (members.length === 0) return null;

  const selfId = briefing?.perPerson.find((p) => p.isSelf)?.userId ?? null;
  const ordered = [...members].sort(
    (a, b) => Number(b.userId === selfId) - Number(a.userId === selfId)
  );

  return (
    <div className="group/people mx-6 mt-5 flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <p className="font-mono text-xs tracking-wide text-text-muted uppercase">People</p>
        {/*
          The briefing refreshes itself when it ages out, so this is a
          nudge, not the mechanism — it stays out of sight until you go
          looking for it.
        */}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={() => void forceRefresh()}
                disabled={refreshing}
                aria-label="Refresh summary"
                className={cn(
                  'text-text-muted hover:bg-bg-2 hover:text-text-primary rounded-control flex size-5 items-center justify-center transition-opacity',
                  refreshing
                    ? 'opacity-100'
                    : 'opacity-0 group-hover/people:opacity-100 focus-visible:opacity-100'
                )}
              >
                <RefreshCw
                  className={cn('size-3', refreshing && 'animate-spin')}
                  strokeWidth={1.5}
                />
              </button>
            }
          />
          <TooltipContent side="bottom">
            {refreshing
              ? 'Updating'
              : Number.isNaN(generatedAt)
                ? 'Refresh summary'
                : `Updated ${relativeTime(generatedAt, Date.now())} · refresh`}
          </TooltipContent>
        </Tooltip>
      </div>
      {/*
        With one member the line reads as that person's own update, so it
        runs inline after their name like a message and costs no extra row.
        With several it cannot: the briefing has no per-person-per-rig
        breakdown, and hanging one rig-level sentence off whichever name
        happens to be first would attribute it to someone who may not have
        done any of it. There it sits below the group, unattributed.
      */}
      {ordered.length === 1 ? (
        /*
          A flex row, not an inline span inside a paragraph: inline meant
          the second line of a wrapped sentence ran back under the avatar
          instead of lining up with the first line's text. Avatar and name
          are a fixed column, the sentence is its own block beside them.
        */
        <div className="flex items-start gap-1.5">
          <span className="flex shrink-0 items-center gap-1.5 pt-px">
            <IdentityAvatar
              name={ordered[0].name}
              avatarUrl={ordered[0].avatarUrl}
              sizeClassName="size-5"
              textClassName="text-xs"
            />
            <span className="text-xs font-medium text-text-primary">
              {ordered[0].userId === selfId
                ? 'You'
                : (ordered[0].name ?? ordered[0].email ?? 'Teammate')}
            </span>
          </span>
          <p className="min-w-0 flex-1 pt-0.5 text-xs leading-relaxed text-text-muted">
            {segments.length > 0
              ? renderSegments(segments, root, onOpenFile)
              : (rigLine ?? ordered[0].role)}
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {ordered.map((member) => (
              <Tooltip key={member.userId}>
                <TooltipTrigger
                  render={
                    <div className="flex min-w-0 items-center gap-1.5">
                      <IdentityAvatar
                        name={member.name}
                        avatarUrl={member.avatarUrl}
                        sizeClassName="size-5"
                        textClassName="text-xs"
                      />
                      <span className="min-w-0 truncate text-xs text-text-secondary">
                        {member.userId === selfId
                          ? 'You'
                          : (member.name ?? member.email ?? 'Teammate')}
                      </span>
                    </div>
                  }
                />
                <TooltipContent side="bottom">
                  {member.email ? `${member.email} · ${member.role}` : member.role}
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
          {rigLine ? (
            <p className="text-xs leading-relaxed text-text-muted">
              {segments.length > 0 ? renderSegments(segments, root, onOpenFile) : rigLine}
            </p>
          ) : (
            briefing && (
              /* An empty slot reads as a failure; the honest state is that
                 the briefing simply has nothing for this rig yet. */
              <p className="text-xs leading-relaxed text-text-muted">Nothing new to summarize yet.</p>
            )
          )}
        </>
      )}
    </div>
  );
}

/** Every file in the listing, flattened — the summary names basenames, wherever they live. */
function flattenFiles(
  nodes: readonly { relPath: string; kind: string; children?: unknown }[]
): { relPath: string }[] {
  const out: { relPath: string }[] = [];
  const walk = (list: readonly { relPath: string; kind: string; children?: unknown }[]) => {
    for (const node of list) {
      if (node.kind === 'dir') walk((node.children ?? []) as typeof list);
      else out.push({ relPath: node.relPath });
    }
  };
  walk(nodes);
  return out;
}

/** Renders the summary with the files it names as real links into those files. */
function renderSegments(
  segments: SummarySegment[],
  root: string,
  onOpenFile: (absPath: string, relPath: string) => void
) {
  return segments.map((segment, index) =>
    segment.kind === 'link' && segment.target.kind === 'file' ? (
      <button
        key={`${segment.text}-${index}`}
        type="button"
        onClick={() => {
          const relPath = (segment.target as { kind: 'file'; relPath: string }).relPath;
          onOpenFile(`${root}/${relPath}`, relPath);
        }}
        className="text-text-secondary underline decoration-current/30 underline-offset-2 transition-colors hover:text-text-primary"
      >
        {segment.text}
      </button>
    ) : (
      <span key={index}>{segment.text}</span>
    )
  );
}
