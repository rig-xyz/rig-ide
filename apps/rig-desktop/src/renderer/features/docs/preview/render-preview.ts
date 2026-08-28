import { JSDOM } from 'jsdom';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { positionComponents } from './markdown-position-components';

/**
 * Test-only render path: markdown source → real DOM, without a browser.
 *
 * The app renders `positionComponents` output live, in the Electron
 * renderer (a real DOM already). Vitest's `node` project (this repo's
 * default — see vitest.config.ts) has no DOM at all, so tests build one
 * themselves: `react-dom/server`'s `renderToStaticMarkup` needs no DOM to
 * turn the React tree into an HTML string (server-side rendering is
 * DOM-free by design), and `jsdom` (already a devDependency) then parses
 * that string into a real `Text`/`Element` tree — `data-pos` attributes,
 * escaped/entity-decoded text content, and all — for `buildPositionIndex`
 * to walk exactly as it would walk the live app's DOM.
 *
 * Only `remark-gfm` is wired in (tables, task lists, strikethrough,
 * autolinks) — `remark-math` is a preview-mode open question (see
 * docs/preview-mode-spec.md, "Open questions") this module doesn't need
 * to take a position on.
 */
export function renderPreviewDom(source: string): {
  root: HTMLElement;
  document: Document;
  window: Window;
} {
  const html = renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      { remarkPlugins: [remarkGfm], components: positionComponents },
      source
    )
  );
  const dom = new JSDOM(`<!doctype html><body><div id="preview-root">${html}</div></body>`);
  const root = dom.window.document.getElementById('preview-root');
  if (!root) throw new Error('renderPreviewDom: #preview-root missing from parsed output');
  return { root, document: dom.window.document, window: dom.window as unknown as Window };
}
