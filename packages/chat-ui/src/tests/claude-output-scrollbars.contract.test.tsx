/**
 * claude-output-scrollbars.contract.test.tsx — the non-overlay scrollbar case
 * (Windows/Linux, macOS "always show scrollbars"), where a horizontal track
 * takes layout space at the bottom of a scroller.
 *
 * Playwright's headless Chromium hides scrollbars, so the platform probe is
 * stubbed to report an 8px track. A sideways-scrolling table / code block
 * must then leave exactly 8px of room under its content (where the real track
 * draws); one that fits must not grow.
 */

import { codeWrapper } from '@components/rows/markdown/code/code.css';
import { expect, it, vi } from 'vitest';
import { frameOf, mount } from './claude-output-harness';

const TRACK = 8;
// Hoisted above TRACK's declaration, so the factory repeats the literal.
vi.mock('@core/measure/scrollbar', () => ({ horizontalScrollbarHeight: () => 8 }));

it('scrolling tables and code blocks reserve the scrollbar track; fitting ones do not', async () => {
  const { host, cleanup } = await mount(620);
  try {
    const wrappers = [
      ...Array.from(host.querySelectorAll('table'), (t) => ({
        wrapper: t.parentElement!,
        contentH: t.offsetHeight,
      })),
      ...Array.from(host.querySelectorAll<HTMLElement>(`.${codeWrapper}`), (c) => ({
        wrapper: c,
        contentH: c.children.length * 20 + 16,
      })),
    ];
    let scrolling = 0;
    for (const { wrapper, contentH } of wrappers) {
      const scrolls = wrapper.scrollWidth > wrapper.clientWidth;
      if (scrolls) scrolling++;
      const room = scrolls ? TRACK : 0;
      expect(wrapper.clientHeight).toBe(contentH + room);
      expect(frameOf(wrapper).offsetHeight).toBe(contentH + 2 + room);
    }
    // The wide table and the long-line code block.
    expect(scrolling).toBe(2);
  } finally {
    cleanup();
  }
});
