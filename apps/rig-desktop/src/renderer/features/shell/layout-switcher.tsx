import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/lib/utils';

export type RigLayout = 'chat' | 'split' | 'files';

/**
 * Layout-switcher round: this control replaces the two per-pane fold
 * buttons (chat's old collapse-to-strip, the artefact pane's old collapse-
 * to-edge-strip) — one mechanism for chat ⇄ split ⇄ files instead of two
 * booleans that could disagree. Switching to split/files with no tabs open
 * opens the focus view — App owns that rule, this control only reports
 * the pick.
 */
export function LayoutSwitcher({
  layout,
  hiddenTabCount,
  onChange,
}: {
  layout: RigLayout;
  /** Open tabs not currently visible — only meaningful while `layout === 'chat'`; surfaced as a presence dot on the split segment. */
  hiddenTabCount: number;
  onChange: (next: RigLayout) => void;
}) {
  const segments: { value: RigLayout; label: string }[] = [
    { value: 'chat', label: 'Chat' },
    { value: 'split', label: 'Side by side' },
    { value: 'files', label: 'Files' },
  ];

  return (
    <div
      role="radiogroup"
      aria-label="Layout"
      className="border-border-hairline bg-bg-1 flex items-center gap-0.5 rounded-control border p-0.5 [-webkit-app-region:no-drag]"
    >
      {segments.map((segment) => {
        const selected = layout === segment.value;
        return (
          <Tooltip key={segment.value}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={segment.label}
                  onClick={() => onChange(segment.value)}
                  className={cn(
                    'relative flex h-6 w-8 items-center justify-center rounded-control transition-colors',
                    selected
                      ? 'bg-bg-2 text-text-primary'
                      : 'text-text-muted hover:bg-bg-2/60 hover:text-text-primary'
                  )}
                >
                  <LayoutGlyph value={segment.value} />
                  {/* One dot, one place — both reveal targets (split and
                      files) would be noise; split is the direct door back
                      to whatever tabs are hidden. */}
                  {hiddenTabCount > 0 && layout === 'chat' && segment.value === 'split' && (
                    <span className="bg-accent absolute -top-0.5 -right-0.5 size-1.5 rounded-full" />
                  )}
                </button>
              }
            />
            <TooltipContent side="bottom">{segment.label}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** The glyph IS the layout — a tiny frame with a divider at the split ratio, legible at this size without a lucide icon. */
function LayoutGlyph({ value }: { value: RigLayout }) {
  const frame =
    'relative h-[11px] w-[15px] overflow-hidden rounded-[2.5px] border-[1.2px] border-current';
  if (value === 'chat') return <span className={frame} />;
  return (
    <span className={frame}>
      <span
        className={cn(
          'absolute inset-y-0 right-0 border-l-[1.2px] border-current bg-current/40',
          value === 'split' ? 'w-[55%]' : 'w-[78%]'
        )}
      />
    </span>
  );
}
