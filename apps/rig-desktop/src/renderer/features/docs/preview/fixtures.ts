/**
 * Sample markdown documents mixing the features docs/preview-mode-spec.md
 * calls out for the position index (escapes, entities, GFM tables, task
 * lists, nested lists, code, links, nested emphasis, blockquotes) — shared
 * between `position-index.test.ts`'s targeted cases and
 * `position-index-property.test.ts`'s randomized round-trip check.
 */
export const FIXTURES: readonly string[] = [
  // Prose with escapes, entities, and nested/adjacent inline formatting.
  [
    '# Release notes \\~ v2\n',
    '\n',
    'Ship it **today**, not *tomorrow* — Q&A found no blockers (`&amp;` in\n',
    'the changelog renders as \\&). See the *first \\_draft\\_ with **nested**\n',
    'bold* for context, and ~~the old plan~~ the new one.\n',
    '\n',
    'Escapes: \\*literal star\\*, \\[not a link\\], \\`not code\\`.\n',
  ].join(''),

  // GFM table with a pipe escape and a link inside a cell.
  [
    '| Feature | Status | Owner |\n',
    '| --- | --- | --- |\n',
    '| Escaped \\| pipe | Done | [Dylan](https://example.com/dylan) |\n',
    '| Emoji 🚀 row | In progress | Team |\n',
  ].join(''),

  // Task lists, nested bullets, and a blockquote.
  [
    '- [x] Ship the position index\n',
    '- [ ] Wire up the preview pane\n',
    '  - [ ] Toggle in the artifact header\n',
    '  - [ ] Frontmatter chip\n',
    '- [ ] Comments on preview\n',
    '\n',
    '> The index is the whole point — everything else is UI on top.\n',
    '> — spec, "The core mechanism"\n',
  ].join(''),

  // Code: fenced with a language, an indented block, and inline code.
  [
    'Run `pnpm run test` before sending a comment through `buildPositionIndex`.\n',
    '\n',
    '```ts\n',
    'const index = buildPositionIndex(root, source);\n',
    'const at = index.domToSource(node, 0);\n',
    '```\n',
    '\n',
    'A literal backtick in code: `` `backtick` ``.\n',
  ].join(''),

  // Links (shortcut, reference, inline-with-title) and an autolink.
  [
    'Read the [spec](https://example.com/spec "Preview mode spec") first,\n',
    'then [the anchors module][anchors], or just <https://example.com/quick>.\n',
    '\n',
    '[anchors]: https://example.com/anchors\n',
  ].join(''),
];
