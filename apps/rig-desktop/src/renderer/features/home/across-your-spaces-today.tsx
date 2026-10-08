import { ChevronDown } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { themeColor } from '@renderer/features/spaces/dock-model';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { rpc } from '@renderer/lib/ipc';
import { cn } from '@renderer/lib/utils';
import type { RigRecentTheme } from '@shared/rig/recent-themes';
import { firstNameOf } from './greeting';
import { HomeFeedLabel } from './home-feed-label';
import {
  moreTopicsLabel,
  shortAge,
  splitRecentThemes,
  themePeopleLine,
  type AcrossSpacesView,
  type TopicMark,
} from './recent-themes-state';
import { faceReasonLabel, topicFaceReasons, type FaceReason } from './face-reasons';

/** Faces on a line before the rest are left out. */
const FACES_SHOWN_CAP = 3;

/**
 * "Across your spaces today": a flat feed of the Room themes with activity
 * in the last 24h, one line each with its description as a one line summary
 * under it, newest first, five then "N more topics". Built only from the
 * themes the relay's worker already made (`use-recent-themes.ts`). A line
 * opens in place to its whole description and its activity; from
 * there, or from its space name, it opens its space's Room, on that theme
 * when Room themes is on (`home.tsx`). One line is open at a time.
 */
export function AcrossYourSpacesToday({
  view,
  onOpenTheme,
  avatarOf,
  marks,
  reasonsOf,
}: {
  view: AcrossSpacesView;
  onOpenTheme: (theme: RigRecentTheme) => void;
  /** A face's picture, when Home knows one for that name. */
  avatarOf?: (name: string) => string | null;
  /** Each topic against its space's read cursor (`markTopics`): new ones get a pill, read ones step back. */
  marks?: ReadonlyMap<string, TopicMark>;
  /** A space's reason faces (`use-face-reasons.ts`): a line shows only the people it names who are one. */
  reasonsOf?: (bindingId: string) => readonly FaceReason[];
}) {
  const [showMore, setShowMore] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const { shown, more } =
    view.kind === 'themes' ? splitRecentThemes(view.themes) : { shown: [], more: [] };
  const now = Date.now();

  const line = (theme: RigRecentTheme) => (
    <ThemeLine
      key={theme.themeId}
      theme={theme}
      now={now}
      open={openId === theme.themeId}
      onToggle={() => setOpenId((id) => (id === theme.themeId ? null : theme.themeId))}
      onOpen={() => onOpenTheme(theme)}
      avatarOf={avatarOf}
      mark={marks?.get(theme.themeId)}
      reasons={reasonsOf?.(theme.bindingId) ?? []}
    />
  );

  return (
    <section className="flex flex-col gap-1.5" data-testid="across-spaces-today">
      <div className="pb-1">
        <HomeFeedLabel
          aside={view.kind === 'themes' ? topicsCountLabel(view.themes.length) : undefined}
        >
          Across your spaces today
        </HomeFeedLabel>
      </div>
      {view.kind === 'loading' ? (
        <p className="py-1.5 text-xs text-text-muted">Loading today&rsquo;s topics…</p>
      ) : view.kind === 'offline' ? (
        <p className="py-1.5 text-xs text-text-muted">Topics show here once rig is reachable.</p>
      ) : view.kind === 'empty' ? (
        <p className="py-1.5 text-xs text-text-muted" data-testid="across-spaces-empty">
          Quiet day across your spaces
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {shown.map(line)}
          {showMore && more.map(line)}
          {more.length > 0 && (
            <li className="pt-1">
              <button
                type="button"
                onClick={() => setShowMore((o) => !o)}
                aria-expanded={showMore}
                className="flex items-center gap-1 font-mono text-2xs text-text-muted transition-colors hover:text-text-primary"
                data-testid="across-spaces-more"
              >
                {moreTopicsLabel(more.length)}
                <ChevronDown
                  className={cn('size-3 transition-transform', showMore && 'rotate-180')}
                  strokeWidth={1.5}
                />
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

/** The count on the right of the label, "6 topics". */
function topicsCountLabel(count: number): string {
  return count === 1 ? '1 topic' : `${count} topics`;
}

/**
 * One topic: the dot, the name, # space, faces and age on the first line,
 * and its description as a muted second line, cut to one line until it's
 * opened. Open, the description wraps in full and the activity line with
 * "Open the Room on this topic" follows. The whole line toggles; its name
 * is the keyboard's way in, its space name opens the Room.
 */
function ThemeLine({
  theme,
  now,
  open,
  onToggle,
  onOpen,
  avatarOf,
  mark,
  reasons,
}: {
  theme: RigRecentTheme;
  now: number;
  open: boolean;
  onToggle: () => void;
  onOpen: () => void;
  avatarOf?: (name: string) => string | null;
  mark?: TopicMark;
  reasons: readonly FaceReason[];
}) {
  // Faces only for the people who are why this topic matters to you.
  const faces = topicFaceReasons(theme.people, reasons, mark);
  const seen = mark?.kind === 'seen';
  // Your own name in the people line reads as You: the relay labels people by display or first name.
  const meQuery = useQuery({ queryKey: ['rig', 'account', 'me'], queryFn: () => rpc.rig.account.me() });
  const myName = meQuery.data?.success ? meQuery.data.data.name : null;
  const selfNames = myName ? [myName, firstNameOf(myName)].filter((n): n is string => !!n) : [];
  return (
    <li
      className={cn(
        'glass-hover -mx-3 flex cursor-pointer flex-col gap-1 rounded-[12px] px-3 py-2.5 leading-normal',
        // Read already: it steps back until hovered or opened.
        seen && !open && 'opacity-50 transition-opacity hover:opacity-85'
      )}
      onClick={onToggle}
      data-testid="theme-line"
      data-theme-id={theme.themeId}
      data-open={open ? 'true' : undefined}
      data-mark={mark?.kind}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <ThemeDot color={themeColor(theme.themeId)} />
        <button
          type="button"
          aria-expanded={open}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
          className={cn(
            'min-w-0 shrink truncate text-left text-sm text-text-primary outline-none focus-visible:underline',
            seen ? 'font-medium' : 'font-semibold'
          )}
          data-testid="theme-line-name"
        >
          {theme.name}
        </button>
        {theme.spaceName && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
            className="min-w-0 shrink-[2] truncate text-xs text-text-muted transition-colors hover:text-text-primary"
            data-testid="theme-line-space"
          >
            # {theme.spaceName}
          </button>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2.5 pl-2">
          {faces.length > 0 && (
            <span className="flex items-center" data-testid="theme-line-faces">
              {faces.slice(0, FACES_SHOWN_CAP).map(({ name, reason }, i) => (
                <span
                  key={name}
                  title={faceReasonLabel(reason)}
                  data-name={name}
                  data-reason={reason.kind}
                  className={cn('flex', i > 0 && '-ml-[7px]')}
                >
                  <IdentityAvatar
                    name={reason.name ?? name}
                    avatarUrl={reason.avatarUrl ?? avatarOf?.(name) ?? null}
                    sizeClassName="size-5"
                    textClassName="text-2xs"
                    className="ring-2 ring-bg-0"
                  />
                </span>
              ))}
            </span>
          )}
          {mark?.kind === 'new' && (
            <span
              className="bg-accent-subtle text-accent rounded-full px-[7px] py-px text-2xs font-medium whitespace-nowrap"
              data-testid="theme-line-new"
            >
              {mark.count} new
            </span>
          )}
          <span
            className="w-11 text-right font-mono text-2xs text-text-muted tabular-nums"
            data-testid="theme-line-age"
          >
            {shortAge(theme.lastActivityAt, now)}
          </span>
        </span>
      </div>
      {theme.description && (!seen || open) && (
        <p
          className={cn(
            'pl-[19px] text-xs leading-normal text-text-secondary',
            !open && 'truncate'
          )}
          data-testid="theme-line-desc"
        >
          {theme.description}
        </p>
      )}
      {open && (
        <div className="popover-in flex min-w-0 items-center gap-3 pl-[19px] text-xs" data-testid="theme-line-detail">
          <span className="min-w-0 flex-1 truncate text-text-muted">{themePeopleLine(theme.people, selfNames)}</span>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
            className="shrink-0 text-text-secondary transition-colors hover:text-text-primary"
            data-testid="theme-line-open"
          >
            {theme.spaceName ? `Open in #${theme.spaceName}` : 'Open the space'} ›
          </button>
        </div>
      )}
    </li>
  );
}

/** The theme's color, the same as its dot in the Room, with a soft halo ring around it. */
function ThemeDot({ color }: { color: string }) {
  return (
    <span
      className="size-[9px] shrink-0 rounded-full"
      style={{
        background: color,
        boxShadow: `0 0 0 4px color-mix(in oklab, ${color} 22%, transparent)`,
      }}
      aria-hidden
    />
  );
}
