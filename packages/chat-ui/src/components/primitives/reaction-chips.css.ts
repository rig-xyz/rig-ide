/**
 * reaction-chips.css.ts — styles for reaction chips ("👍 2" pills) and the
 * persistent 🧵N thread badge on tool-like rows.
 *
 * Chips are 18px high so they fit inside the assistant footer's reserved
 * 24px row (zero height impact) and inside the tool-row bottom-right overlay.
 */

import { style } from '@vanilla-extract/css';
import { vars } from '@styles/theme.css';

export const chipRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
});

export const chip = style({
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '3px',
  height: '18px',
  padding: '0 6px',
  borderRadius: vars.radiusFull,
  border: `1px solid ${vars.border}`,
  background: 'transparent',
  fontSize: '0.6875rem',
  lineHeight: 1,
  color: vars.fgMuted,
  userSelect: 'none',
  selectors: {
    '&:hover': { borderColor: vars.fgPassive, color: vars.fg },
  },
});

/** Accent border + tint when the current user has reacted. */
export const chipMine = style({
  borderColor: vars.link,
  background: `color-mix(in srgb, ${vars.link} 10%, transparent)`,
  color: vars.link,
  selectors: {
    '&:hover': { borderColor: vars.link, color: vars.link },
  },
});

/** Persistent, always-visible 🧵N badge on threaded tool rows. */
export const threadBadge = style({
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '3px',
  height: '18px',
  padding: '0 6px',
  borderRadius: vars.radiusFull,
  border: `1px solid ${vars.border}`,
  background: vars.bg1,
  fontSize: '0.6875rem',
  lineHeight: 1,
  color: vars.fgMuted,
  userSelect: 'none',
  selectors: {
    '&:hover': { color: vars.fg, borderColor: vars.fgPassive },
  },
});
