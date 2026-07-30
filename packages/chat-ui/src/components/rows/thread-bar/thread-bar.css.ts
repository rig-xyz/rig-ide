/**
 * thread-bar.css.ts — styles for the Slack-style thread bar emitted under a
 * threaded message ("N replies · last 2m   View thread ›").
 *
 * The whole bar is a button: hover shows a subtle bg tint and fades in a
 * right-aligned "View thread ›" label. Fixed height (vars.rowH from the def)
 * — the bar is a Lane-A unit measured by its own UnitDef.
 */

import { style } from '@vanilla-extract/css';
import { vars } from '@styles/theme.css';

export const bar = style({
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  width: '100%',
  padding: '0 6px',
  borderRadius: '6px',
  background: 'transparent',
  fontSize: '0.75rem',
  lineHeight: 1,
  textAlign: 'left',
  userSelect: 'none',
  selectors: {
    '&:hover': { background: vars.bg1 },
  },
});

export const barIcon = style({
  display: 'flex',
  alignItems: 'center',
  color: vars.link,
});

export const barCount = style({
  color: vars.link,
  fontWeight: 500,
});

export const barTime = style({
  color: vars.fgMuted,
});

export const barView = style({
  marginLeft: 'auto',
  color: vars.fgMuted,
  opacity: 0,
  transition: 'opacity 120ms ease',
  selectors: {
    [`${bar}:hover &`]: { opacity: 1 },
    [`${bar}:focus-visible &`]: { opacity: 1 },
  },
});
