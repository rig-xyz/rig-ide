/**
 * Line numbers for comment cards on code and text files, where a reader
 * finds a passage by its line rather than by its words. Markdown reads as
 * prose and gets none.
 */

const MARKDOWN = /\.(md|markdown|mdx)$/i;

/** Whether cards on this file show the lines their passage is on. */
export function showsLineNumbers(path: string): boolean {
  return !MARKDOWN.test(path);
}

/** 1-based line of `index` in `text`. */
function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** "Line 12", or "Lines 12 to 14" for a passage over several lines. */
export function lineLabel(text: string, index: number, length: number): string {
  const first = lineAt(text, index);
  const end = Math.max(index, index + length - 1);
  const last = lineAt(text, end);
  return last > first ? `Lines ${first} to ${last}` : `Line ${first}`;
}
