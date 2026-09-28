/**
 * table-visual.css.ts — visual styles for Table.tsx cells.
 *
 * Geometry rules (font-size, line-height, cell padding) stay in table.css.ts.
 * This file covers overflow, border, and background decoration.
 */

import { globalStyle, style } from '@vanilla-extract/css';
import { webkitThinScrollbar } from '@styles/scrollbar.css';
import { vars } from '@styles/theme.css';

/** Scroll wrapper around the table (same scroller conventions as codeWrapper). */
export const tableScroll = style({
  border: `1px solid ${vars.border}`,
  borderRadius: vars.radiusLg,
  width: '100%',
  height: '100%',
  overflowX: 'auto',
  overflowY: 'hidden',
  boxSizing: 'border-box',
  scrollbarWidth: 'thin',
});

globalStyle(`${tableScroll}::-webkit-scrollbar`, {
  width: '8px',
  height: '8px',
});

webkitThinScrollbar(tableScroll, 'horizontal');

/** Applied to <th> cells for visual decoration. */
export const thCell = style({
  background: vars.tableHeaderBg,
  // Clips an unbreakable run (a long code chip) at the cell's padding edge.
  overflow: 'hidden',
  verticalAlign: 'top',
  borderRight: `1px solid ${vars.border}`,
  borderBottom: `1px solid ${vars.border}`,
  selectors: {
    '&:last-child': { borderRight: 'none' },
  },
});

/** Applied to <td> cells for visual decoration. */
export const tdCell = style({
  overflow: 'hidden',
  verticalAlign: 'top',
  borderRight: `1px solid ${vars.border}`,
  borderBottom: `1px solid ${vars.border}`,
  selectors: {
    '&:last-child': { borderRight: 'none' },
  },
});

/** Remove bottom border from the last row's td cells. */
export const tdCellLastRow = style({
  borderBottom: 'none',
});

/** Positioning context for a cell's pretext-laid-out lines. */
export const cellBody = style({
  position: 'relative',
});
