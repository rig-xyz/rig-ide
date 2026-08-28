import { describe, expect, it } from 'vitest';
import { renderPreviewDom } from './render-preview';

/**
 * The render half: every element `positionComponents` covers stamps
 * `data-pos="start:end"` from its own hast/mdast `node.position` — markers
 * and all (see the module doc for why). `position-index.test.ts` and
 * `text-alignment.test.ts` cover peeling those markers back off; this file
 * only checks that the right elements get the right RAW attribute in the
 * first place.
 */

describe('positionComponents: data-pos stamping', () => {
  it('paragraph', () => {
    const source = 'Hello world.';
    const { root } = renderPreviewDom(source);
    expect(root.querySelector('p')?.getAttribute('data-pos')).toBe('0:12');
  });

  it('all six heading levels', () => {
    for (let level = 1; level <= 6; level++) {
      const marker = '#'.repeat(level);
      const source = `${marker} Heading`;
      const { root } = renderPreviewDom(source);
      const heading = root.querySelector(`h${level}`);
      expect(heading?.getAttribute('data-pos')).toBe(`0:${source.length}`);
    }
  });

  it('unordered and ordered lists, and their items', () => {
    const source = '- one\n- two\n';
    const { root } = renderPreviewDom(source);
    expect(root.querySelector('ul')?.getAttribute('data-pos')).toBe('0:11');
    const items = root.querySelectorAll('li');
    expect(items[0]?.getAttribute('data-pos')).toBe('0:5');
    expect(items[1]?.getAttribute('data-pos')).toBe('6:11');
  });

  it('table, rows, and cells', () => {
    const source = '| a | b |\n| - | - |\n| 1 | 2 |\n';
    const { root } = renderPreviewDom(source);
    expect(root.querySelector('table')?.getAttribute('data-pos')).not.toBeNull();
    expect(root.querySelectorAll('tr').length).toBe(2); // thead's row + tbody's row
    for (const cell of Array.from(root.querySelectorAll('td,th'))) {
      expect(cell.getAttribute('data-pos')).toMatch(/^\d+:\d+$/);
    }
  });

  it('fenced code (on the code element, not stamped on pre)', () => {
    const source = '```js\ncode();\n```\n';
    const { root } = renderPreviewDom(source);
    expect(root.querySelector('pre')?.getAttribute('data-pos')).toBeNull();
    expect(root.querySelector('code')?.getAttribute('data-pos')).toBe('0:17');
  });

  it('inline code', () => {
    const source = 'a `code` b';
    const { root } = renderPreviewDom(source);
    expect(root.querySelector('code')?.getAttribute('data-pos')).toBe('2:8');
  });

  it('em, strong, and del', () => {
    const source = '*em* **strong** ~~del~~';
    const { root } = renderPreviewDom(source);
    expect(root.querySelector('em')?.getAttribute('data-pos')).toBe('0:4');
    expect(root.querySelector('strong')?.getAttribute('data-pos')).toBe('5:15');
    expect(root.querySelector('del')?.getAttribute('data-pos')).toBe('16:23');
  });

  it('links', () => {
    const source = '[text](https://example.com)';
    const { root } = renderPreviewDom(source);
    expect(root.querySelector('a')?.getAttribute('data-pos')).toBe(`0:${source.length}`);
  });

  it('blockquote', () => {
    const source = '> quoted\n';
    const { root } = renderPreviewDom(source);
    expect(root.querySelector('blockquote')?.getAttribute('data-pos')).toBe('0:8');
  });

  it('task-list items still get data-pos on the li itself, alongside the synthesized checkbox', () => {
    const source = '- [x] done\n';
    const { root } = renderPreviewDom(source);
    const li = root.querySelector('li');
    expect(li?.getAttribute('data-pos')).toBe('0:10');
    expect(li?.querySelector('input[type="checkbox"]')).not.toBeNull();
  });

  it('nested inline formatting: the outer node keeps its own full span, the inner one its own', () => {
    const source = '*em **strong** end*';
    const { root } = renderPreviewDom(source);
    expect(root.querySelector('em')?.getAttribute('data-pos')).toBe(`0:${source.length}`);
    expect(root.querySelector('strong')?.getAttribute('data-pos')).toBe('4:14');
  });
});
