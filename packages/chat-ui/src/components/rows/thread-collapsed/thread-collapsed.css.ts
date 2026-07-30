/**
 * thread-collapsed.css.ts — styles for the "discussed in thread" muted line.
 * Same interaction shape as the thread bar: whole line is a button, hover
 * tints the background and fades in "View thread ›".
 */

import { style } from '@vanilla-extract/css';
import { vars } from '@styles/theme.css';

export const line = style({
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
  color: vars.fgMuted,
  userSelect: 'none',
  selectors: {
    '&:hover': { background: vars.bg1 },
  },
});

export const lineIcon = style({
  display: 'flex',
  alignItems: 'center',
  color: vars.fgPassive,
});

export const lineView = style({
  marginLeft: 'auto',
  color: vars.fgMuted,
  opacity: 0,
  transition: 'opacity 120ms ease',
  selectors: {
    [`${line}:hover &`]: { opacity: 1 },
    [`${line}:focus-visible &`]: { opacity: 1 },
  },
});
