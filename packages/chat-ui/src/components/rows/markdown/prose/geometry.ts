/**
 * Prose layout geometry constants.
 *
 * These values are fixed — they are not themeable. They live here, colocated
 * with the prose layout code that owns them.
 */

/** Horizontal indent per nesting level for list items (px). */
export const LIST_INDENT = 16;

/** Horizontal indent per nesting level for blockquotes (px). */
export const BLOCKQUOTE_INDENT = 16;

/** Gap from bullet center-anchor to list item text start (px). */
export const LIST_BULLET_GAP = 12;

/** Text column of a quote whose content sits at `depth` (px). */
export const quoteTextLeft = (depth: number): number => (depth + 1) * BLOCKQUOTE_INDENT;

/** Quote bar x: 10px left of the quote's text column (px). */
export const quoteRailX = (depth: number): number => quoteTextLeft(depth) - 10;
