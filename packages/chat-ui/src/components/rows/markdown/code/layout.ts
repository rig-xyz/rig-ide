/**
 * layoutCode — pure geometry for a CodeBlock.
 *
 * Moved here from core/layout/layout-code.ts so that layout constants,
 * CSS vars, and the renderer live in the same folder.
 *
 * Constants come from ./metrics (single source of truth).
 * Typography (line height) comes from the FontConfig passed in.
 */

import { measureRichInlineStats, prepareRichInline } from '@chenglou/pretext/rich-inline';
import type { CodeLaidOut } from '@core/layout/layout-types';
import { reserveHeight } from '@core/layout/reserve-height';
import type { CodeBlock } from '@core/markdown/document';
import type { FontConfig } from '@core/measure/fonts';

const CODE_BLOCK_PAD_Y = 8;
const CODE_BLOCK_BORDER = 1;
// codeWrapper's left padding — lines start this far in from the border.
const CODE_BLOCK_PAD_LEFT = 8;
// CSS default tab-size for `white-space: pre` lines.
const TAB_SIZE = 8;

const charWidthCache = new Map<string, number>();

/**
 * True when the longest line is wider than the block, i.e. the wrapper will
 * scroll horizontally. Code is monospace, so line width = columns × one
 * measured char width (tabs count as TAB_SIZE columns).
 */
export function codeOverflowsX(block: CodeBlock, fonts: FontConfig, effectiveWidth: number): boolean {
  let charW = charWidthCache.get(fonts.code.font);
  if (charW === undefined) {
    const prepared = prepareRichInline([{ text: '0'.repeat(100), font: fonts.code.font }]);
    charW = measureRichInlineStats(prepared, 1e7).maxLineWidth / 100;
    charWidthCache.set(fonts.code.font, charW);
  }
  let columns = 0;
  for (const line of block.code.split('\n')) {
    columns = Math.max(columns, line.length + (line.split('\t').length - 1) * (TAB_SIZE - 1));
  }
  return CODE_BLOCK_PAD_LEFT + columns * charW > effectiveWidth - 2 * CODE_BLOCK_BORDER;
}

export function layoutCode(
  block: CodeBlock,
  fonts: FontConfig,
  blockTop: number,
  effectiveWidth: number,
  /** Extra height for a non-overlay horizontal scrollbar track (0 when it doesn't scroll). */
  scrollbarHeight = 0
): CodeLaidOut {
  const codeLineHeight = fonts.code.lineHeight;
  const rawLines = block.code.split('\n');

  const lines = rawLines.map((text, i) => ({
    top: CODE_BLOCK_PAD_Y + i * codeLineHeight,
    text,
  }));

  const height = reserveHeight({
    content: rawLines.length * codeLineHeight + scrollbarHeight,
    padY: CODE_BLOCK_PAD_Y,
    border: CODE_BLOCK_BORDER,
  });

  return {
    kind: 'code',
    id: block.id,
    top: blockTop,
    height,
    contentWidth: effectiveWidth,
    lines,
    lang: block.lang,
  };
}
