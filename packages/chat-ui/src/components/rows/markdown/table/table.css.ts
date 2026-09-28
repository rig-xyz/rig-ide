/**
 * table.css.ts — geometry-coupled styles for Table.tsx.
 *
 * CRITICAL: cell padding (6px 10px) must equal TABLE_CELL_PAD_Y/X in
 * layout.ts — row heights are computed from it.
 * Do NOT move these padding/font values to sprinkles or inline styles.
 */

import { globalStyle, style } from '@vanilla-extract/css';
import { vars } from '@styles/theme.css';

export const pchatTable = style({
  borderCollapse: 'separate',
  borderSpacing: 0,
  fontSize: vars.typeBodyFontSize,
  lineHeight: vars.typeBodyLineHeight,
});

// Cell geometry — padding feeds the row-height formula in layout.ts.
// Uses globalStyle with the parent class selector to mirror the old
// `.pchat-table th, .pchat-table td` rule without touching Tailwind cascade.
globalStyle(`${pchatTable} th, ${pchatTable} td`, {
  padding: '6px 10px',
  textAlign: 'left',
});

globalStyle(`${pchatTable} th`, {
  fontWeight: 600,
  // background — applied in Table.tsx via Tailwind / sprinkles
});
