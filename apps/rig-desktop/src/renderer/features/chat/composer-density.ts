/**
 * Composer overlap round (post-release usage, Dylan's screenshots): the
 * bottom utility row's picker cluster (harness identity, model, effort,
 * permission mode, replay's session-context chip) didn't handle narrow
 * panels — nothing in the row shrunk or dropped, so at ~360-420px panel
 * widths the cluster simply overflowed and visually overlapped Send.
 *
 * Pure decision only: given the composer's measured width (from the
 * existing `ResizeObserver` in `chat-panel.tsx`, which already tracks
 * height for content padding — this reads the same rect's width), what
 * should the picker row show. `full` is today's behavior, unchanged. An
 * honest priority ladder rather than a blanket "hide everything": the
 * harness identity chip and Send never degrade (identity and the one
 * primary action stay legible at any width); the MODEL picker keeps a
 * label — always TRUNCATED, never hidden, since "which model" is the one
 * thing worth reading even when tight; permission mode still gets its
 * shield icon at every density (a safety control should never vanish
 * silently) but drops its text label; effort and the replay session-context
 * chip are the lowest-priority information here and are the ones that
 * actually disappear, since neither has an icon to fall back to.
 */
export type ComposerDensity = 'full' | 'compact';

const COMPACT_BELOW_PX = 380;

export function deriveComposerDensity(width: number): ComposerDensity {
  return width > 0 && width < COMPACT_BELOW_PX ? 'compact' : 'full';
}
