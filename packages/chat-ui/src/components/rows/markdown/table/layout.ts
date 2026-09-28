/**
 * layoutTable — pure geometry for a TableBlock.
 *
 * Every cell is laid out as a body prose block (pretext), so cells keep their
 * inline code chips, links and emphasis and wrap instead of truncating.
 *
 * Column widths follow the browser's auto table layout, simplified:
 *   - min[c] = widest unbreakable word in column c (capped at
 *     TABLE_MAX_MIN_COL_W so one long URL can't hog the row — it breaks
 *     mid-word instead); max[c] = widest single-line cell, capped at
 *     TABLE_MAX_COL_W (longer text wraps). Both include cell padding.
 *   - If the maxes fit, columns grow proportionally to fill the width.
 *   - Else if the mins fit, each column gets its min plus a share of the
 *     leftover proportional to (max - min).
 *   - Else the table can't fit: the wrapper scrolls horizontally and each
 *     column gets up to TABLE_SCROLL_COL_W (never below its min).
 *
 * Height is deterministic: each row is its tallest cell + vertical padding +
 * a 1px row border (none under the last row), plus the wrapper's border.
 */

import type { FontConfig } from '@core/config';
import type { ProseLaidOut, TableLaidOut, TableRowLayout } from '@core/layout/layout-types';
import { reserveHeight } from '@core/layout/reserve-height';
import type { InlineRun, ProseBlock, TableAlign, TableBlock } from '@core/markdown/document';
import { layoutProse, measureProseNaturalWidth } from '../prose/layout';

type PrepareRichInlineFn = Parameters<typeof layoutProse>[4];

// Cell padding — must match table.css.ts.
export const TABLE_CELL_PAD_X = 10;
export const TABLE_CELL_PAD_Y = 6;
const TABLE_BORDER = 1;
const TABLE_MIN_COL_W = 48;
const TABLE_MAX_MIN_COL_W = 160;
const TABLE_MAX_COL_W = 320;
const TABLE_SCROLL_COL_W = 200;
// Horizontal chrome inside a column: padding on both sides + the 1px right
// border every cell but the last draws (counted for all, so no line can
// overflow its cell).
const CELL_CHROME_X = 2 * TABLE_CELL_PAD_X + TABLE_BORDER;

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

function columnWidths(min: number[], max: number[], available: number): number[] {
  let widths: number[];
  if (sum(max) <= available) {
    const scale = available / sum(max);
    widths = max.map((w) => w * scale);
  } else if (sum(min) < available) {
    const slack = (available - sum(min)) / sum(max.map((w, c) => w - min[c]));
    widths = min.map((w, c) => w + (max[c] - w) * slack);
  } else {
    // Scrolling anyway — don't squeeze text columns to their longest word
    // (rows would turn into tall word-per-line stacks); give each up to a
    // comfortable reading width instead.
    widths = min.map((w, c) => Math.max(w, Math.min(max[c], TABLE_SCROLL_COL_W)));
  }
  // Integer px so <col> widths render exactly; hand the rounding remainder to
  // the widest column so a fitting table spans the full width.
  const rounded = widths.map(Math.floor);
  const slack = available - sum(rounded);
  if (slack > 0 && slack < rounded.length) {
    rounded[rounded.indexOf(Math.max(...rounded))] += slack;
  }
  return rounded;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function cellBlock(id: string, runs: InlineRun[]): ProseBlock {
  return { kind: 'prose', id, variant: 'body', runs };
}

/** The unbreakable pieces of a cell: text runs split at whitespace; chips whole. */
function words(runs: InlineRun[]): InlineRun[] {
  return runs.flatMap((run): InlineRun[] =>
    run.kind === 'text'
      ? run.text
          .split(/\s+/)
          .filter(Boolean)
          .map((text) => ({ ...run, text }))
      : run.kind === 'break'
        ? []
        : [run]
  );
}

/** Shift each line right/center within the cell for GFM column alignment. */
function alignCell(laid: ProseLaidOut, align: TableAlign, innerW: number): ProseLaidOut {
  if (align !== 'right' && align !== 'center') return laid;
  const lines = laid.lines.map((line) => {
    const free = Math.max(0, innerW - line.width);
    return { ...line, left: line.left + (align === 'right' ? free : free / 2) };
  });
  return { ...laid, lines };
}

export function layoutTable(
  block: TableBlock,
  blockTop: number,
  contentWidth: number,
  fonts: FontConfig,
  prepareRichInline?: PrepareRichInlineFn
): TableLaidOut {
  const colCount = Math.max(1, block.header.length);
  // Header cells render bold (thCell); measure them bold too.
  const header = block.header.map((cell) =>
    cell.map((r): InlineRun => (r.kind === 'text' ? { ...r, bold: true } : r))
  );
  const allRows = [header, ...block.rows];

  const width = (runs: InlineRun[]): number =>
    measureProseNaturalWidth(cellBlock('', runs), fonts, prepareRichInline);
  const min: number[] = [];
  const max: number[] = [];
  for (let c = 0; c < colCount; c++) {
    let minW = 0;
    let maxW = 0;
    for (const row of allRows) {
      const runs = row[c] ?? [];
      if (runs.length === 0) continue;
      maxW = Math.max(maxW, width(runs));
      for (const word of words(runs)) minW = Math.max(minW, width([word]));
    }
    min[c] = clamp(Math.ceil(minW) + CELL_CHROME_X, TABLE_MIN_COL_W, TABLE_MAX_MIN_COL_W);
    max[c] = clamp(Math.ceil(maxW) + CELL_CHROME_X, min[c], TABLE_MAX_COL_W);
  }

  // The visible table sits inside a 1px-bordered wrapper, so the usable inner
  // width is contentWidth minus the left+right border.
  const colWidths = columnWidths(min, max, contentWidth - 2 * TABLE_BORDER);
  const tableWidth = sum(colWidths);

  const rows: TableRowLayout[] = allRows.map((row, r) => {
    const cells = colWidths.map((colW, c) => {
      const innerW = Math.max(1, colW - CELL_CHROME_X);
      const runs = row[c] ?? [];
      const laid = layoutProse(
        cellBlock(`${block.id}:${r}:${c}`, runs),
        innerW,
        fonts,
        0,
        prepareRichInline
      );
      return { laid: alignCell(laid, block.align[c] ?? null, innerW), runs };
    });
    const contentH = Math.max(fonts.body.lineHeight, ...cells.map((cell) => cell.laid.height));
    const isLast = r === allRows.length - 1;
    return {
      height: contentH + 2 * TABLE_CELL_PAD_Y + (isLast ? 0 : TABLE_BORDER),
      cells,
    };
  });

  return {
    kind: 'table',
    id: block.id,
    top: blockTop,
    height: reserveHeight({ content: sum(rows.map((row) => row.height)), border: TABLE_BORDER }),
    contentWidth: tableWidth,
    colWidths,
    tableWidth,
    align: block.align,
    rows,
  };
}
