import { jsonLanguage } from '@codemirror/lang-json';
import { highlightCode, tagHighlighter, tags as t } from '@lezer/highlight';

/**
 * A JSON file's Preview: the document pretty printed with two-space indent
 * and colored like the code editor (`doc-editor-theme.ts`'s
 * `codeHighlightStyle`, same tokens and the same tokens left plain), read
 * only. A file that doesn't parse shows as it is, with a note.
 */

/** The files that open in Preview by default: `.json` and `.geojson`. */
export function isJsonPreviewPath(path: string): boolean {
  return /\.(geo)?json$/i.test(path);
}

/** The JSON pretty printed with two-space indent, or null when it doesn't parse. */
export function prettyJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}

/** The code editor's palette as classes, so a static page needs no editor to wear it. */
const highlighter = tagHighlighter([
  { tag: [t.keyword, t.operatorKeyword], class: 'text-text-primary font-[550]' },
  { tag: t.propertyName, class: 'text-accent' },
  { tag: [t.string, t.number, t.bool, t.atom, t.null], class: 'text-text-secondary' },
  { tag: [t.comment, t.lineComment, t.blockComment], class: 'text-text-muted italic' },
  { tag: [t.punctuation, t.bracket, t.squareBracket, t.brace, t.paren, t.separator], class: 'text-text-muted' },
  { tag: t.invalid, class: 'text-danger' },
]);

export type JsonSpan = { text: string; className: string };

/** The text as lines of colored spans. */
export function highlightJson(text: string): JsonSpan[][] {
  const lines: JsonSpan[][] = [[]];
  highlightCode(
    text,
    jsonLanguage.parser.parse(text),
    highlighter,
    (code, classes) => lines[lines.length - 1]!.push({ text: code, className: classes }),
    () => lines.push([])
  );
  return lines;
}
