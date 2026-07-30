import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

/**
 * Typography + markdown syntax styling for the doc surface.
 *
 * Deliberately not a stock CM6 theme: this should read as a document editor,
 * not an IDE. Colors come from the app's semantic tokens (defined on the
 * `.emlight` / `.emdark` theme classes in index.css) so light/dark follow the
 * app with no extra wiring. `--font-*` tokens live in an `@theme inline` block
 * and are therefore not emitted as CSS variables — the content column inherits
 * the app's sans stack from `body`, and the mono stack is duplicated here.
 */

const MONO_STACK = "Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";

/** Class applied to the fading highlight over an absorbed external edit. */
export const DOC_FLASH_CLASS = 'cm-docFlash';

/** Duration of the external-edit flash, in ms. Must match the keyframes below. */
export const DOC_FLASH_DURATION_MS = 1200;

const docTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '15px',
    backgroundColor: 'var(--background-secondary-1)',
    color: 'var(--foreground)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: '1.7',
    overflowY: 'auto',
  },
  // Auto margins on the flex child center the writing column in the scroller.
  '.cm-content': {
    maxWidth: '72ch',
    margin: '0 auto',
    padding: '32px 24px 40vh',
    caretColor: 'var(--foreground)',
  },
  // `relative` is layout-neutral on its own, and gives the comments layer a
  // containing block for the marker dot it absolutely positions beside the line.
  '.cm-line': { padding: '0', position: 'relative' },
  '.cm-placeholder': { color: 'var(--foreground-passive)' },
  [`.${DOC_FLASH_CLASS}`]: {
    borderRadius: '2px',
    animation: `cm-docFlashFade ${DOC_FLASH_DURATION_MS}ms ease-out forwards`,
  },
  '@keyframes cm-docFlashFade': {
    '0%': { backgroundColor: 'color-mix(in srgb, var(--blue-9) 32%, transparent)' },
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
    backgroundColor: 'var(--background-2)',
    borderRadius: '3px',
    padding: '0.1em 0.3em',
  },
  { tag: [t.link, t.url], color: 'var(--blue-11)', textDecoration: 'underline' },
  { tag: t.quote, color: 'var(--foreground-muted)', fontStyle: 'italic' },
  { tag: t.list, color: 'var(--foreground)' },
  { tag: t.labelName, color: 'var(--foreground-muted)' },
  { tag: t.string, color: 'var(--foreground-muted)' },
  { tag: t.comment, color: 'var(--foreground-passive)', fontStyle: 'italic' },
  { tag: t.atom, color: 'var(--foreground-muted)' },
  { tag: t.contentSeparator, color: 'var(--foreground-passive)' },
  // Markdown punctuation (`#`, `*`, backticks, list bullets) recedes.
  { tag: t.processingInstruction, color: 'var(--foreground-passive)' },
]);

/** Theme + markdown highlighting for the doc surface. */
export const docTypography: Extension = [docTheme, syntaxHighlighting(docHighlightStyle)];
