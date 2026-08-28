import type { Element } from 'hast';
import { createElement } from 'react';
import type { JSX } from 'react';
import type { Components, ExtraProps } from 'react-markdown';

/**
 * react-markdown component overrides that stamp `data-pos="start:end"` on
 * every rendered block/inline element that has one — the render half of
 * the position index (docs/preview-mode-spec.md, "The core mechanism: the
 * position index"). `position-index.ts` is the read half: it walks this
 * DOM and aligns each stamped leaf's rendered text against its own source
 * slice.
 *
 * react-markdown v10 always passes the hast `node` to custom components
 * (`hast-util-to-jsx-runtime` is invoked with `passNode: true` internally,
 * regardless of what the public types imply), so every override below can
 * read `node.position`.
 *
 * Deliberately the node's OWN span, markers and all — a strong/em/del's
 * position spans `**text**`/`_text_`/`~~text~~`, a heading's spans `#
 * text`, a list item's spans `- text`, a link's spans `[text](url)`. This
 * looks like it stamps the wrong thing for a "leaf" whose rendered text
 * excludes those markers, but it is deliberate: the OWN span is what a
 * sibling needs to correctly bound ITS gap text (the plain-text run right
 * after a `</strong>` must start counting from after the closing `**`, not
 * from the tight content boundary — see `position-index.ts`'s walk, which
 * advances its cursor past this exact attribute). `position-index.ts`
 * strips markers back out per tag (`contentSlice`) only where a LEAF's own
 * text needs aligning against content, not markers — same file, same
 * function, as the fence/backtick stripping it already does for `code`.
 * Splitting "own span" (render-time, here) from "content span" (read-time,
 * there) keeps this file a one-line-per-tag stamp with no markdown-syntax
 * knowledge of its own.
 */

/**
 * Exported so callers that need to combine position-stamping with their OWN
 * component override (the Preview pane's external-link click-intercept and
 * scrollable table wrapper — see `features/artifact/preview-pane.tsx`) don't
 * have to reimplement it.
 */
export function posAttr(node: Element | undefined): string | undefined {
  const start = node?.position?.start?.offset;
  const end = node?.position?.end?.offset;
  return typeof start === 'number' && typeof end === 'number' ? `${start}:${end}` : undefined;
}

/**
 * One override per positioned tag, all doing the same thing: read
 * `node.position`, stamp `data-pos`, render the plain intrinsic element
 * with every other prop passed through untouched (className for a fenced
 * code block's language, href/title for links, children always).
 * `createElement` sidesteps the "JSX with a dynamic tag name" typing
 * friction of writing `<Tag {...rest} />` for a generic `Tag`.
 */
function withPos<Tag extends keyof JSX.IntrinsicElements>(tag: Tag) {
  function Positioned(props: JSX.IntrinsicElements[Tag] & ExtraProps) {
    const { node, ...rest } = props;
    return createElement(tag, { ...rest, 'data-pos': posAttr(node) });
  }
  Positioned.displayName = `Positioned(${String(tag)})`;
  return Positioned;
}

/**
 * The tag set required by docs/preview-mode-spec.md: block AND inline —
 * headings, paragraphs, lists, list items, tables/rows/cells, code (both
 * fenced and inline share the `code` tag), em/strong/del, links,
 * blockquotes. `pre` is deliberately NOT wrapped: it contributes no text
 * of its own (all of it lives in its `code` child), so `position-index.ts`
 * just walks through it transparently as an unpositioned wrapper — one
 * fewer attribute per code block, no loss of coverage.
 */
export const positionComponents: Components = {
  h1: withPos('h1'),
  h2: withPos('h2'),
  h3: withPos('h3'),
  h4: withPos('h4'),
  h5: withPos('h5'),
  h6: withPos('h6'),
  p: withPos('p'),
  ul: withPos('ul'),
  ol: withPos('ol'),
  li: withPos('li'),
  table: withPos('table'),
  tr: withPos('tr'),
  td: withPos('td'),
  th: withPos('th'),
  code: withPos('code'),
  em: withPos('em'),
  strong: withPos('strong'),
  del: withPos('del'),
  a: withPos('a'),
  blockquote: withPos('blockquote'),
};
