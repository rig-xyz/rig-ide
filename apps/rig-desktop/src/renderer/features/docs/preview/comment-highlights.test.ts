import { afterEach, describe, expect, it } from 'vitest';
import type { CommentMarker } from '../comments/comment-decorations';
import { createPreviewCommentPainter } from './comment-highlights';
import { buildPositionIndex } from './position-index';
import { renderPreviewDom } from './render-preview';

/**
 * `comment-highlights.ts` reads real globals (`window`, `document`, `CSS`,
 * `Highlight`) rather than an injected DOM, because in the actual app those
 * globals ARE the Electron renderer's real DOM — same reasoning as
 * `render-preview.ts`'s own doc comment for why this module's tests build
 * their own DOM rather than relying on one. This project's `node` vitest
 * project (see vitest.config.ts) has none of those globals, so this file
 * installs them for the duration of each test: `window`/`document` from a
 * fresh `renderPreviewDom` JSDOM instance (so painted Ranges and
 * `caretRangeFromPoint`'s polyfilled result share one DOM realm), and a
 * minimal `CSS.highlights`/`Highlight` polyfill (jsdom implements neither
 * the CSS Custom Highlight API). Real painting/hit-testing pixel geometry
 * only a real browser can give is covered at the browser-test level
 * (Chromium supports both natively); this file is about the module's OWN
 * logic — bucket routing, skip-on-unmapped, dispose, isPointInRange lookup.
 */

class FakeHighlight {
  readonly ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

type Installed = {
  root: HTMLElement;
  document: Document;
  highlights: Map<string, FakeHighlight>;
};

const globals = globalThis as unknown as {
  window?: unknown;
  document?: unknown;
  CSS?: unknown;
  Highlight?: unknown;
};
let saved: Pick<typeof globals, 'window' | 'document' | 'CSS' | 'Highlight'>;

function install(source: string): Installed {
  saved = {
    window: globals.window,
    document: globals.document,
    CSS: globals.CSS,
    Highlight: globals.Highlight,
  };
  const { root, document, window } = renderPreviewDom(source);
  const highlights = new Map<string, FakeHighlight>();
  globals.window = window;
  globals.document = document;
  globals.CSS = { highlights };
  globals.Highlight = FakeHighlight;
  return { root, document, highlights };
}

afterEach(() => {
  globals.window = saved.window;
  globals.document = saved.document;
  globals.CSS = saved.CSS;
  globals.Highlight = saved.Highlight;
});

function marker(
  overrides: Partial<CommentMarker> & Pick<CommentMarker, 'id' | 'from' | 'to'>
): CommentMarker {
  return { resolved: false, active: false, ...overrides };
}

describe('createPreviewCommentPainter', () => {
  it('buckets a resting, unresolved marker under rig-preview-comment', () => {
    const source = 'hello world';
    const { root, highlights } = install(source);
    const index = buildPositionIndex(root, source);
    const painter = createPreviewCommentPainter(() => index);

    painter.paint([marker({ id: 't1', from: source.indexOf('world'), to: source.length })]);

    expect(highlights.has('rig-preview-comment')).toBe(true);
    expect(highlights.get('rig-preview-comment')!.ranges).toHaveLength(1);
    expect(highlights.has('rig-preview-comment-active')).toBe(false);
  });

  it('buckets active/resolved combinations into their own highlight keys', () => {
    const source = 'hello world, goodbye moon';
    const { root, highlights } = install(source);
    const index = buildPositionIndex(root, source);
    const painter = createPreviewCommentPainter(() => index);

    painter.paint([
      marker({ id: 'active', from: 0, to: 5, active: true }),
      marker({ id: 'resolved', from: 7, to: 12, resolved: true }),
      marker({ id: 'active-resolved', from: 14, to: 22, active: true, resolved: true }),
    ]);

    expect([...highlights.keys()].sort()).toEqual(
      [
        'rig-preview-comment-active',
        'rig-preview-comment-active-resolved',
        'rig-preview-comment-resolved',
      ].sort()
    );
  });

  it('skips a marker whose source range the index cannot map, without throwing', () => {
    const source = 'hello world';
    const { root, highlights } = install(source);
    const index = buildPositionIndex(root, source);
    const painter = createPreviewCommentPainter(() => index);

    expect(() => painter.paint([marker({ id: 'unmapped', from: 9999, to: 10000 })])).not.toThrow();
    expect(highlights.size).toBe(0);
  });

  it('clears every previously painted key on the next paint', () => {
    const source = 'hello world';
    const { root, highlights } = install(source);
    const index = buildPositionIndex(root, source);
    const painter = createPreviewCommentPainter(() => index);

    painter.paint([marker({ id: 't1', from: 0, to: 5, active: true })]);
    expect(highlights.has('rig-preview-comment-active')).toBe(true);

    painter.paint([]);
    expect(highlights.size).toBe(0);
  });

  it('dispose clears every painted key', () => {
    const source = 'hello world';
    const { root, highlights } = install(source);
    const index = buildPositionIndex(root, source);
    const painter = createPreviewCommentPainter(() => index);

    painter.paint([marker({ id: 't1', from: 0, to: 5 })]);
    painter.dispose();

    expect(highlights.size).toBe(0);
  });

  it('hitTest finds the thread whose painted range contains the point', () => {
    const source = 'hello world';
    const { root, document } = install(source);
    const index = buildPositionIndex(root, source);
    const painter = createPreviewCommentPainter(() => index);
    const textNode = root.firstChild!.firstChild as Text;

    painter.paint([marker({ id: 't1', from: source.indexOf('world'), to: source.length })]);

    // jsdom has no real layout, so `caretRangeFromPoint` is polyfilled to
    // report a fixed point inside "world" regardless of the given
    // coordinates — this is about the isPointInRange lookup, not real pixel
    // hit-testing.
    (
      document as unknown as { caretRangeFromPoint: (x: number, y: number) => Range }
    ).caretRangeFromPoint = () => {
      const r = document.createRange();
      r.setStart(textNode, source.indexOf('orl'));
      r.setEnd(textNode, source.indexOf('orl'));
      return r;
    };

    expect(painter.hitTest(1, 1)).toBe('t1');
  });

  it('hitTest returns null when the point is outside every painted range', () => {
    const source = 'hello world';
    const { root, document } = install(source);
    const index = buildPositionIndex(root, source);
    const painter = createPreviewCommentPainter(() => index);
    const textNode = root.firstChild!.firstChild as Text;

    painter.paint([marker({ id: 't1', from: source.indexOf('world'), to: source.length })]);

    (
      document as unknown as { caretRangeFromPoint: (x: number, y: number) => Range }
    ).caretRangeFromPoint = () => {
      const r = document.createRange();
      r.setStart(textNode, 0); // "hello" — not part of the painted range
      r.setEnd(textNode, 0);
      return r;
    };

    expect(painter.hitTest(1, 1)).toBeNull();
  });
});
