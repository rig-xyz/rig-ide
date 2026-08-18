import { globalStyle, style } from '@vanilla-extract/css';
import { webkitThinScrollbar } from '@styles/scrollbar.css';
import { vars } from '@styles/theme.css';

// ── Expanded inset (design-system Rule 9: "not a box") ─────────────────────────
//
// A subtle left hairline + indent, not a bordered card — the collapsed
// header already carries the row's chrome (none). This is the only visual
// structure the expanded state adds.

export const executeInset = style({
  marginLeft: '9px',
  borderLeft: `2px solid ${vars.border}`,
});

// ── Body ──────────────────────────────────────────────────────────────────────

/** Wrapper: height + overflow set inline (depend on bodyH). */
export const executeBody = style({
  position: 'relative',
  boxSizing: 'content-box',
  scrollbarWidth: 'thin',
});

globalStyle(`${executeBody}::-webkit-scrollbar`, {
  width: 'var(--execute-scrollbar-size)',
  height: 'var(--execute-scrollbar-size)',
});

// Polish round: this scroller had no track/thumb theming at all — Chromium's
// full default scrollbar, not even the thinness `scrollbarWidth` above asks
// for (Chromium ignores that property). Same shared convention as the
// transcript's own scroll container.
webkitThinScrollbar(executeBody);

// ── Line ──────────────────────────────────────────────────────────────────────
//
// Output is the new information (full prominence); the command is
// de-emphasized here — the header already named it at full prominence.

export const executeLine = style({
  whiteSpace: 'pre',
  fontSize: vars.typeCodeFontSize,
  fontWeight: vars.typeCodeFontWeight,
  fontFamily: vars.typeCodeFontFamily,
  color: vars.fg,
  // line-height is set via inline style from theme.fonts.code.lineHeight
  // so it cannot drift from the measured value via a CSS variable.
});

export const executeCommandLine = style({
  color: vars.fgMuted,
});

export const executeSpacerLine = style({
  userSelect: 'none',
});

globalStyle(`${executeLine} span`, {
  color: 'var(--shiki-light)',
});

globalStyle(`.emdark ${executeLine} span`, {
  color: 'var(--shiki-dark)',
});

// ── Collapsed subtext (live ticker / purpose summary) ───────────────────────────

export const executeSubtext = style({
  paddingLeft: '28px',
  paddingRight: '8px',
  fontFamily: vars.fontMono,
  fontSize: '11px',
  color: vars.fgMuted,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});
