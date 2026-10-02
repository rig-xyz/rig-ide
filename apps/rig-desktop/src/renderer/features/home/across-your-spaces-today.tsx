import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@renderer/lib/utils';
import type { RigRecentTheme } from '@shared/rig/recent-themes';
import {
  moreTopicsLabel,
  splitRecentThemes,
  themeActivityLine,
  type AcrossSpacesView,
} from './recent-themes-state';

/**
 * "Across your spaces today": one card per Room theme with activity in the
 * last 24h, newest first, five then "N more topics". Built only from the
 * themes the relay's worker already made (`use-recent-themes.ts`). A card
 * opens its space's Room, on that theme when Room themes is on (`home.tsx`).
 */
export function AcrossYourSpacesToday({
  view,
  onOpenTheme,
}: {
  view: AcrossSpacesView;
  onOpenTheme: (theme: RigRecentTheme) => void;
}) {
  const [open, setOpen] = useState(false);
  const { shown, more } =
    view.kind === 'themes' ? splitRecentThemes(view.themes) : { shown: [], more: [] };

  return (
    <section className="flex flex-col gap-2" data-testid="across-spaces-today">
      <h2 className="text-sm font-medium text-text-primary">Across your spaces today</h2>
      {view.kind === 'loading' ? (
        <p className="text-xs text-text-muted">Loading today&rsquo;s topics…</p>
      ) : view.kind === 'offline' ? (
        <p className="text-xs text-text-muted">Topics show here once rig is reachable.</p>
      ) : view.kind === 'empty' ? (
        <p className="text-xs text-text-muted" data-testid="across-spaces-empty">
          Quiet day across your spaces
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {shown.map((theme) => (
            <ThemeCard key={theme.themeId} theme={theme} onOpen={() => onOpenTheme(theme)} />
          ))}
          {more.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                className="flex w-fit items-center gap-1 px-1 text-xs text-text-muted transition-colors hover:text-text-primary"
                data-testid="across-spaces-more"
              >
                {moreTopicsLabel(more.length)}
                <ChevronRight
                  className={cn('size-3 transition-transform', open && 'rotate-90')}
                  strokeWidth={1.5}
                />
              </button>
              {open &&
                more.map((theme) => (
                  <ThemeCard key={theme.themeId} theme={theme} onOpen={() => onOpenTheme(theme)} />
                ))}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function ThemeCard({ theme, onOpen }: { theme: RigRecentTheme; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex flex-col gap-0.5 rounded-card border border-border-hairline bg-bg-1 p-3 text-left transition-colors hover:bg-bg-2"
      data-testid="theme-card"
      data-theme-id={theme.themeId}
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 truncate text-sm font-medium text-text-primary">{theme.name}</span>
        <span
          className="min-w-0 shrink-[2] truncate font-mono text-xs text-text-muted"
          data-testid="theme-card-space"
        >
          # {theme.spaceName}
        </span>
      </span>
      {theme.description && (
        <span className="text-sm leading-snug text-text-secondary">{theme.description}</span>
      )}
      <span className="text-xs text-text-muted">{themeActivityLine(theme)}</span>
    </button>
  );
}
