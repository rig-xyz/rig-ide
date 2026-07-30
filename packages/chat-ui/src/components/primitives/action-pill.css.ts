/**
 * action-pill.css.ts — styles for the hover action pill (Slack-style row
 * toolbar) and its persistent thread badge / reaction chip companions.
 *
 * Reveal scopes (marker-class pattern, same as copy-button.css.ts):
 *   messageGroup   — assistant message container hover reveals the pill.
 *   threadRowGroup — tool-like UnitRow hover reveals the pill. The marker was
 *                    previously minted in thread-button.css.ts; it moved here
 *                    when the pill replaced the lone overlay ThreadButton.
 *
 * The pill is an absolutely-positioned overlay: zero height impact, pure CSS
 * opacity reveal (0 → 1, 120ms ease). Keyboard access: buttons are focusable
 * and `:has(:focus-visible)` forces the pill visible.
 */

import { style } from '@vanilla-extract/css';
import { messageGroup } from './copy-button.css';
import { vars } from '@styles/theme.css';

/** Apply to a tool-like UnitRow root to enable pill group-hover reveal. */
export const threadRowGroup = style({});

const pillBase = style({
  position: 'absolute',
  display: 'flex',
  alignItems: 'center',
  gap: '2px',
  padding: '2px',
  borderRadius: vars.radiusMd,
  border: `1px solid ${vars.border}`,
  background: vars.bg1,
  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.12)',
  opacity: 0,
  transition: 'opacity 120ms ease',
  userSelect: 'none',
  zIndex: 10,
  selectors: {
    '&:has(:focus-visible)': { opacity: 1 },
  },
});

/** Pill inside an assistant message root (revealed by messageGroup hover). */
export const actionPillInMessage = style([
  pillBase,
  {
    top: '-4px',
    right: 0,
    selectors: {
      [`${messageGroup}:hover &`]: { opacity: 1 },
    },
  },
]);

/**
 * Pill inside a tool-like UnitRow (revealed by threadRowGroup hover).
 * Anchored to the top-right corner of a zero-size host wrapper that UnitRow
 * positions at `top: gapBefore - 4, right: insetX + 6` (offsets depend on
 * per-unit geometry, so they stay inline in the wrapper).
 */
export const actionPillInRow = style([
  pillBase,
  {
    top: 0,
    right: 0,
    selectors: {
      [`${threadRowGroup}:hover &`]: { opacity: 1 },
    },
  },
]);

/** 24px-high icon button inside the pill. */
export const pillButton = style({
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '3px',
  height: '24px',
  minWidth: '24px',
  padding: '0 3px',
  borderRadius: vars.radiusSm,
  fontSize: '0.75rem',
  lineHeight: 1,
  color: vars.fgMuted,
  background: 'transparent',
  selectors: {
    '&:hover': { background: vars.bg2, color: vars.fg },
  },
});

/** 1px vertical divider between the reaction group and the action buttons. */
export const pillDivider = style({
  width: '1px',
  alignSelf: 'stretch',
  margin: '3px 1px',
  background: vars.border,
});
