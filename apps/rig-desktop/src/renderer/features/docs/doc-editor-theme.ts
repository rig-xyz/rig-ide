import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

/**
 * Typography + markdown syntax styling for the doc surface.
 *
 * Deliberately not a stock CM6 theme: this should read as a document editor,
 * not an IDE. Rewritten from emdash's `doc-editor-theme.ts` against this app's
 * own tokens (`renderer/tokens.css`) rather than the old app's semantic vars,
 * so light/dark follow the app's `[data-theme]` toggle with no extra wiring.
 *
 * Colors reference the plain `:root` custom properties tokens.css declares
 * directly (`--bg-0`, `--text-primary`, …). `--font-mono`/`--text-base` and
 * the rest of the type ramp live only inside tokens.css's `@theme inline`
 * block, which Tailwind resolves into generated utility classes rather than
 * exposing as runtime custom properties — not usable from this CM6
 * `EditorView.theme()` call, which is plain injected CSS outside Tailwind's
 * pipeline. Their literal values are copied here instead.
 */

const MONO_STACK = "'Geist Mono', Menlo, Monaco, Consolas, monospace";

/** Class applied to the fading highlight over an absorbed external edit. */
export const DOC_FLASH_CLASS = 'cm-docFlash';

/** Duration of the external-edit flash, in ms. Must match the keyframes below. */
export const DOC_FLASH_DURATION_MS = 1200;

const docTheme = EditorView.theme({
  '&': {
    // Grows to content height rather than filling (and internally scrolling)
    // its parent: the artifact view's outer wrapper is the scroll container
    // instead, so the margin comment rail — an absolutely positioned sibling
    // of the editor host, not something CM6 knows about — scrolls in the same
    // coordinate space as the anchors it tracks. See `artifact-view.tsx`.
    height: 'auto',
    fontSize: '15px',
    backgroundColor: 'var(--bg-0)',
    color: 'var(--text-primary)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: '1.7',
    overflow: 'visible',
  },
  // Auto margins on the flex child center the ~68ch writing column, per the
  // artifact view spec (`docs/collab-pivot-spec.md` §4.3).
  '.cm-content': {
    maxWidth: '68ch',
    margin: '0 auto',
    padding: '48px 24px 60vh',
    caretColor: 'var(--text-primary)',
  },
  // `relative` gives the comments layer a containing block for the marker dot
  // it absolutely positions beside the line.
  '.cm-line': { padding: '0', position: 'relative' },
  '.cm-placeholder': { color: 'var(--text-muted)' },
  [`.${DOC_FLASH_CLASS}`]: {
    borderRadius: '2px',
    animation: `cm-docFlashFade ${DOC_FLASH_DURATION_MS}ms ease-out forwards`,
  },
  '@keyframes cm-docFlashFade': {
    '0%': { backgroundColor: 'var(--accent-subtle)' },
    '100%': { backgroundColor: 'transparent' },
  },
});

const docHighlightStyle = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.6em', fontWeight: '650', lineHeight: '1.3' },
  { tag: t.heading2, fontSize: '1.35em', fontWeight: '650', lineHeight: '1.35' },
  { tag: t.heading3, fontSize: '1.15em', fontWeight: '650' },
  { tag: [t.heading4, t.heading5, t.heading6, t.heading], fontWeight: '650' },
  { tag: t.strong, fontWeight: '650' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  {
    tag: t.monospace,
    fontFamily: MONO_STACK,
    fontSize: '0.9em',
    backgroundColor: 'var(--bg-2)',
    borderRadius: '3px',
    padding: '0.1em 0.3em',
  },
  { tag: [t.link, t.url], color: 'var(--accent)', textDecoration: 'underline' },
  { tag: t.quote, color: 'var(--text-secondary)', fontStyle: 'italic' },
  { tag: t.list, color: 'var(--text-primary)' },
  { tag: t.labelName, color: 'var(--text-secondary)' },
  { tag: t.string, color: 'var(--text-secondary)' },
  { tag: t.comment, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: t.atom, color: 'var(--text-secondary)' },
  { tag: t.contentSeparator, color: 'var(--text-muted)' },
  // Markdown punctuation (`#`, `*`, backticks, list bullets) recedes.
  { tag: t.processingInstruction, color: 'var(--text-muted)' },
]);

/** Theme + markdown highlighting for the doc surface. */
export const docTypography: Extension = [docTheme, syntaxHighlighting(docHighlightStyle)];

// ── code (non-markdown text/code/config) ─────────────────────────────────────

/**
 * Round (mono code theme): every text/code/config file that ISN'T markdown —
 * json, yaml, toml, a grammarless `.env`, all of it — reads as code, not as
 * a proportional-font paragraph. Applied whenever `language !== 'markdown'`
 * (`doc-editor.tsx`), regardless of whether that language has real CM6
 * grammar: a `.env` file with no grammar at all still gets Geist Mono and
 * code sizing, just no syntax colors on top.
 *
 * Deliberately not full-width-hostile like a real IDE, but deliberately NOT
 * the prose column either — no `max-width`/centering, since code lines (and
 * especially long JSON/YAML nesting) wrap or scroll on their own terms.
 */
const flashStyleRules = {
  [`.${DOC_FLASH_CLASS}`]: {
    borderRadius: '2px',
    animation: `cm-docFlashFade ${DOC_FLASH_DURATION_MS}ms ease-out forwards`,
  },
  '@keyframes cm-docFlashFade': {
    '0%': { backgroundColor: 'var(--accent-subtle)' },
    '100%': { backgroundColor: 'transparent' },
  },
};

const codeTheme = EditorView.theme({
  '&': {
    height: 'auto',
    fontSize: '13px',
    backgroundColor: 'var(--bg-0)',
    color: 'var(--text-primary)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: MONO_STACK,
    lineHeight: '1.6',
    overflow: 'visible',
  },
  '.cm-content': {
    padding: '24px 24px 60vh',
    caretColor: 'var(--text-primary)',
  },
  '.cm-line': { padding: '0', position: 'relative' },
  '.cm-placeholder': { color: 'var(--text-muted)' },
  ...flashStyleRules,
});

/**
 * One small, quiet, zinc-based `HighlightStyle` shared by every code grammar
 * this app has (json/yaml/toml/html/css/js/shell/python/… — see
 * `doc-editor.tsx`'s `languageExtension`) — a doc tool's syntax highlighting,
 * not an IDE's. Only tokens the reader actually scans for get any color at
 * all: names/keys (the one restrained accent, same role `--accent` plays for
 * links in the prose theme above) and comments (receding, like markdown's
 * punctuation). Everything else — strings, numbers, keywords, brackets —
 * stays within the neutral text-primary/secondary/muted ramp rather than a
 * per-token rainbow.
 */
const codeHighlightStyle = HighlightStyle.define([
  {
    tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword, t.operatorKeyword],
    color: 'var(--text-primary)',
    fontWeight: '550',
  },
  { tag: [t.propertyName, t.attributeName, t.labelName], color: 'var(--accent)' },
  { tag: [t.className, t.typeName, t.tagName], color: 'var(--text-primary)' },
  { tag: [t.string, t.number, t.bool, t.atom, t.null], color: 'var(--text-secondary)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: [t.punctuation, t.bracket, t.squareBracket, t.brace, t.paren], color: 'var(--text-muted)' },
  { tag: t.operator, color: 'var(--text-secondary)' },
  { tag: t.meta, color: 'var(--text-muted)' },
  { tag: t.invalid, color: 'var(--danger)' },
]);

/** Theme + syntax highlighting for every non-markdown text/code/config file. */
export const docCodeTypography: Extension = [codeTheme, syntaxHighlighting(codeHighlightStyle)];
