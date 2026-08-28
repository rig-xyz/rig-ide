/**
 * Frontmatter strip for the Preview pane (`preview-mode-spec.md`'s "Shape"
 * section): a document's `---`-delimited YAML block must never render as
 * body prose — it reads as metadata, not text the author wrote. Same regex
 * family as the round-trip spike and hub/web's own strip, kept here as a
 * small pure helper so it is unit-testable without pulling in react-markdown.
 *
 * Anchored to the very start of the document (`^`) and requires the closing
 * delimiter's own trailing newline — a `---` used as a markdown thematic
 * break (horizontal rule) mid-document never matches, only a genuine leading
 * frontmatter block does.
 */

const FRONTMATTER_PATTERN = /^---\n[\s\S]*?\n---\n/;

export interface FrontmatterSplit {
  /** The raw block, delimiters included, or null when the document has none. */
  raw: string | null;
  /** The document with the frontmatter block removed — what Preview renders as markdown. */
  body: string;
}

export function splitFrontmatter(content: string): FrontmatterSplit {
  const match = FRONTMATTER_PATTERN.exec(content);
  if (!match) return { raw: null, body: content };
  return { raw: match[0], body: content.slice(match[0].length) };
}
