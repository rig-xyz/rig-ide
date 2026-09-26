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
 *
 * At rest it shows only the current layout; hovering it (or tabbing into
 * it) slides the other two out on its left, in a frame that only shows
 * then (Dylan, 2026-09-26).
 */
export function LayoutSwitcher({
  layout,
  hiddenTabCount,
  onChange,
  spaceMode = false,
}: {
  layout: RigLayout;
  /** Open tabs not currently visible — only meaningful while `layout === 'chat'`; surfaced as a presence dot on the split segment. */
  hiddenTabCount: number;
  onChange: (next: RigLayout) => void;
  /** Room chrome round: a space's Room owns `'chat'` instead of a session,
   * so the segments read Chat/Split/Doc there — same three values, same
   * glyphs, just the words a member actually sees. */
  spaceMode?: boolean;
}) {
  const segments: { value: RigLayout; label: string }[] = spaceMode
    ? [
        { value: 'chat', label: 'Chat' },
        { value: 'split', label: 'Split' },
        { value: 'files', label: 'Doc' },
      ]
    : [
        { value: 'chat', label: 'Chat' },
        { value: 'split', label: 'Side by side' },
        { value: 'files', label: 'Files' },
      ];

  // The others first, the current one last: it's what the collapsed control
  // shows, and it never moves when the others slide out on its left.
  const ordered = [...segments.filter((s) => s.value !== layout), ...segments.filter((s) => s.value === layout)];
  const hiddenTabsDot = hiddenTabCount > 0 && layout === 'chat';

  return (
    <div
      role="radiogroup"
      aria-label="Layout"
      // No box at rest, just the current layout's glyph; the frame (and the
      // current one's fill) come in with the others on hover or focus.
      className="group flex items-center rounded-control border border-transparent p-0.5 transition-colors duration-200 hover:border-border-hairline hover:bg-bg-1 has-[:focus-visible]:border-border-hairline has-[:focus-visible]:bg-bg-1 [-webkit-app-region:no-drag]"
    >
      {ordered.map((segment) => {
        const selected = layout === segment.value;
        return (
          <span
            key={segment.value}
            className={cn(
              'flex shrink-0 transition-[max-width,opacity,margin] duration-200 ease-out motion-reduce:transition-none',
              selected
                ? 'max-w-8'
                : 'max-w-0 overflow-hidden opacity-0 group-hover:mr-0.5 group-hover:max-w-8 group-hover:opacity-100 group-has-[:focus-visible]:mr-0.5 group-has-[:focus-visible]:max-w-8 group-has-[:focus-visible]:opacity-100'
            )}
          >
            <Tooltip>
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
                        ? 'text-text-primary group-hover:bg-bg-2 group-has-[:focus-visible]:bg-bg-2'
                        : 'text-text-muted hover:bg-bg-2/60 hover:text-text-primary'
                    )}
                  >
                    <LayoutGlyph value={segment.value} />
                    {/* One dot, one place — both reveal targets (split and
                        files) would be noise; split is the direct door back
                        to whatever tabs are hidden. Collapsed, the current
                        segment carries it until the control opens. */}
                    {hiddenTabsDot && segment.value === 'split' && (
                      <span className="bg-accent absolute -top-0.5 -right-0.5 size-1.5 rounded-full" />
                    )}
                    {hiddenTabsDot && selected && (
                      <span className="bg-accent absolute -top-0.5 -right-0.5 size-1.5 rounded-full transition-opacity group-hover:opacity-0 group-has-[:focus-visible]:opacity-0" />
                    )}
                  </button>
                }
              />
              <TooltipContent side="bottom">{segment.label}</TooltipContent>
            </Tooltip>
          </span>
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
