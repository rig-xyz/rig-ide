import { style } from '@vanilla-extract/css';
import { vars } from '@styles/theme.css';
import { createVariableThemeContract } from '@styles/variable-theme-contract.css';

// ── Runtime geometry contract ─────────────────────────────────────────────────

export type CollapsibleCardStyleVars = {
  height: number;
};

export const collapsibleCardVars = createVariableThemeContract<CollapsibleCardStyleVars>({
  height: null,
});

// ── Card shell ────────────────────────────────────────────────────────────────

export const collapsibleCard = style({
  border: `1px solid ${vars.border}`,
  borderRadius: vars.radiusLg,
  overflow: 'hidden',
  boxSizing: 'border-box',
  height: collapsibleCardVars.height,
});

/**
 * `chrome: 'line'` shell (design-system Rule 9) — same height/overflow
 * mechanics as `collapsibleCard` (so the collapse/expand tween still tracks
 * correctly) but no border or radius: card chrome is reserved for file-edit
 * summaries, everything else is a quiet line whose "card" is really just an
 * optional inset content block under it (see `Execute`'s `expandedInset`).
 */
export const collapsibleCardFlat = style({
  overflow: 'hidden',
  boxSizing: 'border-box',
  height: collapsibleCardVars.height,
});
