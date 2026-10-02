import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { themeColor } from '@renderer/features/spaces/dock-model';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { cn } from '@renderer/lib/utils';
import type { RigRecentTheme } from '@shared/rig/recent-themes';
import { HomeFeedLabel } from './home-feed-label';
import {
  moreTopicsLabel,
  shortAge,
  splitRecentThemes,
  themeActivityLine,
  themeFaces,
  type AcrossSpacesView,
} from './recent-themes-state';

/** Faces on a line before the rest are left out. */
const FACES_SHOWN_CAP = 3;

/**
 * "Across your spaces today": a flat feed of the Room themes with activity
 * in the last 24h, one line each, newest first, five then "N more topics".
 * Built only from the themes the relay's worker already made
 * (`use-recent-themes.ts`). A line opens in place to its description; from
 * there, or from its space name, it opens its space's Room, on that theme
 * when Room themes is on (`home.tsx`). One line is open at a time.
 */
export function AcrossYourSpacesToday({
  view,
  onOpenTheme,
  avatarOf,
}: {
  view: AcrossSpacesView;
  onOpenTheme: (theme: RigRecentTheme) => void;
  /** A face's picture, when Home knows one for that name. */
  avatarOf?: (name: string) => string | null;
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
    />
  );

  return (
    <section className="flex flex-col gap-1" data-testid="across-spaces-today">
      <HomeFeedLabel aside={view.kind === 'themes' ? view.themes.length : undefined}>
        Across your spaces today
      </HomeFeedLabel>
      {view.kind === 'loading' ? (
        <p className="px-2 py-1.5 text-sm text-text-muted">Loading today&rsquo;s topics…</p>
      ) : view.kind === 'offline' ? (
        <p className="px-2 py-1.5 text-sm text-text-muted">
          Topics show here once rig is reachable.
        </p>
      ) : view.kind === 'empty' ? (
        <p className="px-2 py-1.5 text-sm text-text-muted" data-testid="across-spaces-empty">
          Quiet day across your spaces
        </p>
      ) : (
        <ul className="flex flex-col">
          {shown.map(line)}
          {showMore && more.map(line)}
          {more.length > 0 && (
            <li>
              <button
                type="button"
                onClick={() => setShowMore((o) => !o)}
                aria-expanded={showMore}
                className="flex items-center gap-1 px-2 py-1.5 text-xs text-text-muted transition-colors hover:text-text-primary"
                data-testid="across-spaces-more"
              >
                {moreTopicsLabel(more.length)}
                <ChevronRight
                  className={cn('size-3 transition-transform', showMore && 'rotate-90')}
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

function ThemeLine({
  theme,
  now,
  open,
  onToggle,
  onOpen,
  avatarOf,
}: {
  theme: RigRecentTheme;
  now: number;
  open: boolean;
  onToggle: () => void;
  onOpen: () => void;
  avatarOf?: (name: string) => string | null;
}) {
  const faces = themeFaces(theme.people);
  return (
    <li
      className={cn('rounded-control transition-colors', open ? 'bg-bg-2/40' : 'hover:bg-bg-2/50')}
      data-testid="theme-line"
      data-theme-id={theme.themeId}
      data-open={open ? 'true' : undefined}
    >
      {/* The whole line toggles; its name is the keyboard's way in, its space name opens the Room. */}
      <div className="flex h-9 min-w-0 cursor-pointer items-center gap-2.5 px-2" onClick={onToggle}>
        <ThemeDot color={themeColor(theme.themeId)} />
        <button
          type="button"
          aria-expanded={open}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
          className="min-w-0 shrink truncate text-left text-sm font-semibold text-text-primary outline-none focus-visible:underline"
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
            className="min-w-0 shrink-[2] truncate text-sm text-text-muted transition-colors hover:text-text-primary"
            data-testid="theme-line-space"
          >
            # {theme.spaceName}
          </button>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-3 pl-2">
          {faces.length > 0 && (
            <span className="flex items-center" data-testid="theme-line-faces">
              {faces.slice(0, FACES_SHOWN_CAP).map((name, i) => (
                <span key={name} title={name} className={cn('flex', i > 0 && '-ml-1')}>
                  <IdentityAvatar
                    name={name}
                    avatarUrl={avatarOf?.(name) ?? null}
                    sizeClassName="size-5"
                    textClassName="text-2xs"
                    className="ring-2 ring-bg-0"
                  />
                </span>
              ))}
            </span>
          )}
          <span
            className="w-7 text-right font-mono text-2xs text-text-muted tabular-nums"
            data-testid="theme-line-age"
          >
            {shortAge(theme.lastActivityAt, now)}
          </span>
        </span>
      </div>
      {open && (
        <div
          className="popover-in flex flex-col gap-1 pr-2 pb-2.5 pl-[26px]"
          data-testid="theme-line-detail"
        >
          {theme.description && (
            <p className="text-sm leading-snug text-text-secondary">{theme.description}</p>
          )}
          <p className="text-xs text-text-muted">
            {themeActivityLine(theme)} ·{' '}
            <button
              type="button"
              onClick={onOpen}
              className="transition-colors hover:text-text-primary"
              data-testid="theme-line-open"
            >
              Open the Room on this topic ›
            </button>
          </p>
        </div>
      )}
    </li>
  );
}

/** The theme's color, the same as its dot in the Room, with a soft halo around it. */
function ThemeDot({ color }: { color: string }) {
  return (
    <span
      className="size-2 shrink-0 rounded-full"
      style={{
        background: color,
        boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 22%, transparent)`,
      }}
      aria-hidden
    />
  );
}
