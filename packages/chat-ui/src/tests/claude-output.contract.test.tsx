/**
 * claude-output.contract.test.tsx — renders CLAUDE_OUTPUT_FIXTURE (every GFM
 * construct Claude/Codex routinely emit) through the real chat view and
 * checks each element survives with its structure: tables keep inline
 * formatting, wrap instead of truncating, respect alignment and reserve
 * exactly their DOM height; over-wide code chips break inside their cell;
 * lists keep numbers and task checkboxes, a list in a quote keeps the rail;
 * strikethrough (incl. links and headings), math source and footnotes
 * aren't dropped. The non-overlay scrollbar case lives in
 * claude-output-scrollbars.contract.test.tsx.
 *
 * Browser project: real layout + vanilla-extract CSS.
 */

import { codeWrapper } from '@components/rows/markdown/code/code.css';
import { pquoteRail } from '@components/rows/markdown/prose/prose.css';
import { horizontalScrollbarHeight } from '@core/measure/scrollbar';
import { describe, expect, it } from 'vitest';
import { expectReservedExactly, frameOf, mount, proseFrame, texts } from './claude-output-harness';

describe('Claude output fixture renders every markdown element', () => {
  it('tables: scroll wrapper, header cells, inline formatting, wrapping, alignment, exact height', async () => {
    const { host, cleanup } = await mount(620);
    try {
      const tables = Array.from(host.querySelectorAll('table'));
      expect(tables).toHaveLength(4);

      for (const table of tables) {
        const wrapper = table.parentElement!;
        const frame = frameOf(table);
        // Wrapped in a horizontal scroller that never exceeds the chat column.
        expect(getComputedStyle(wrapper).overflowX).toBe('auto');
        expect(wrapper.clientWidth).toBeLessThanOrEqual(frame.clientWidth);
        // Reserved (layout) height === rendered height, scrollbar track included.
        expectReservedExactly(wrapper, frame, table.offsetHeight);
        expect(table.querySelectorAll('thead th').length).toBeGreaterThan(0);
      }

      const [summary, wide, long] = tables;
      expect(texts(summary.querySelectorAll('thead th'))).toEqual(['Area', 'Status', 'Owner']);

      // Only the 8-column table is wider than the column (and scrolls).
      expect(wide.offsetWidth).toBeGreaterThan(wide.parentElement!.clientWidth);
      expect(summary.offsetWidth).toBeLessThanOrEqual(summary.parentElement!.clientWidth);
      expect(long.offsetWidth).toBeLessThanOrEqual(long.parentElement!.clientWidth);

      // Inline code and links survive inside cells.
      const firstCell = wide.querySelector('tbody td')!;
      expect(firstCell.textContent).toContain('yjs');
      expect(firstCell.querySelector('[class]')).not.toBeNull();
      const cellLink = long.querySelector<HTMLAnchorElement>('tbody a');
      expect(cellLink?.getAttribute('href')).toBe('https://example.com/protocol');

      // A long cell wraps onto several lines instead of truncating.
      const longCell = long.querySelectorAll('tbody td')[1]!;
      expect(longCell.textContent).toContain('every connected peer.');
      expect((longCell as HTMLElement).offsetHeight).toBeGreaterThan(40);

      // Right-aligned column: the Owner text sits against the cell's right edge.
      const ownerCell = summary.querySelectorAll('tbody td')[2] as HTMLElement;
      const ownerText = ownerCell.querySelector('span')!.getBoundingClientRect();
      expect(ownerCell.getBoundingClientRect().right - ownerText.right).toBeLessThan(14);
    } finally {
      cleanup();
    }
  });

  it('lists keep ordered numbers and task checkboxes; strike, math and footnotes survive', async () => {
    const { host, cleanup } = await mount(620);
    try {
      const markers = texts(host.querySelectorAll('[aria-hidden="true"]'));
      expect(markers).toEqual(expect.arrayContaining(['1.', '2.', '3.', '•']));

      const boxes = Array.from(host.querySelectorAll('[data-checked]'));
      expect(boxes.map((b) => b.getAttribute('data-checked'))).toEqual(['true', 'false', 'false']);

      const struck = Array.from(host.querySelectorAll('span')).find(
        (s) => s.textContent === 'blocker'
      )!;
      expect(getComputedStyle(struck).textDecorationLine).toContain('line-through');
      const struckLink = Array.from(host.querySelectorAll('a')).find((a) => a.textContent === 'old RFC')!;
      expect(getComputedStyle(struckLink).textDecorationLine).toBe('underline line-through');
      const struckHeading = Array.from(host.querySelectorAll('span')).find((s) => s.textContent === 'v1')!;
      expect(getComputedStyle(struckHeading).textDecorationLine).toContain('line-through');

      const text = host.textContent ?? '';
      expect(text).toContain('O(n \\log n)');
      expect(text).toContain('T(n) = 2T(n/2) + O(n)');
      expect(text).toContain('worst case[1]');
      expect(text).toContain('[1] Assuming the log is already sorted.');
    } finally {
      cleanup();
    }
  });

  it('narrow column: every table stays inside it', async () => {
    const { host, cleanup } = await mount(360);
    try {
      for (const table of Array.from(host.querySelectorAll('table'))) {
        const frame = frameOf(table);
        expect(table.parentElement!.clientWidth).toBeLessThanOrEqual(frame.clientWidth);
        expectReservedExactly(table.parentElement!, frame, table.offsetHeight);
      }
    } finally {
      cleanup();
    }
  });

  it('a code chip wider than its column breaks across lines inside the cell', async () => {
    for (const width of [620, 360]) {
      const { host, cleanup } = await mount(width);
      try {
        const cell = host.querySelectorAll('table')[3]!.querySelectorAll('tbody td')[1] as HTMLElement;
        const path = '/Users/sam/Rig/growth/quarterly-planning/2026/q4/drafts/relay-sync-migration-notes-final-v3.md';
        // Nothing lost (line-end spaces are trimmed by the layout).
        expect(cell.textContent?.replace(/\s+/g, '')).toBe(`see${path}`);
        const cellRight = cell.getBoundingClientRect().right;
        const chunks = Array.from(cell.querySelectorAll('span')).filter((s) =>
          path.includes(s.textContent ?? '\0')
        );
        expect(chunks.length).toBeGreaterThan(1);
        for (const chunk of chunks) {
          expect(chunk.getBoundingClientRect().right).toBeLessThanOrEqual(cellRight);
        }
      } finally {
        cleanup();
      }
    }
  });

  it('a quote draws one continuous bar across its paragraphs, list and code block', async () => {
    const { host, cleanup } = await mount(620);
    try {
      // The fixture has one blockquote: paragraph, 2 list items, code, paragraph.
      const bars = Array.from(host.querySelectorAll<HTMLElement>(`.${pquoteRail}`));
      expect(bars).toHaveLength(1);
      const bar = bars[0]!.getBoundingClientRect();
      const first = proseFrame(host, 'Note:').getBoundingClientRect();
      const last = proseFrame(host, 'Ping me if it fails.').getBoundingClientRect();
      // No vertical gap anywhere: one element from the first block's top to the last's bottom.
      expect(bar.top).toBe(first.top);
      expect(bar.bottom).toBe(last.bottom);
      expect(bar.height).toBeGreaterThan(0);

      const textLeft = Array.from(host.querySelectorAll('span'))
        .find((s) => s.textContent === 'Note:')!
        .getBoundingClientRect().left;
      for (const text of ['run it off-peak', 'watch the dashboard']) {
        // List items: bullet past the quote's text column, within the bar's span.
        const item = proseFrame(host, text);
        const bullet = item.querySelector('[aria-hidden="true"]')!.getBoundingClientRect();
        expect(bullet.left).toBeGreaterThan(bar.right + 10);
        expect(item.getBoundingClientRect().top).toBeGreaterThanOrEqual(bar.top);
      }

      // Code block inside the quote: indented to the quote's text column,
      // right of the bar, and inside the bar's vertical span.
      const code = Array.from(host.querySelectorAll<HTMLElement>(`.${codeWrapper}`)).find((w) =>
        w.textContent?.includes('pnpm backfill --dry-run')
      )!;
      const codeRect = code.getBoundingClientRect();
      expect(codeRect.left).toBe(textLeft);
      expect(codeRect.left).toBeGreaterThan(bar.right);
      expect(codeRect.top).toBeGreaterThan(bar.top);
      expect(codeRect.bottom).toBeLessThan(bar.bottom);
    } finally {
      cleanup();
    }
  });

  it('back-to-back lists get a paragraph gap', async () => {
    const { host, cleanup } = await mount(620);
    try {

      const gap = (a: string, b: string) =>
        proseFrame(host, b).getBoundingClientRect().top -
        proseFrame(host, a).getBoundingClientRect().bottom;
      expect(gap('Ship the desktop build', 'Announce it')).toBe(2);
      expect(gap('Announce it', 'Write the migration')).toBe(6);
    } finally {
      cleanup();
    }
  });

  it('code blocks that scroll sideways reserve the scrollbar track and clip nothing', async () => {
    const { host, cleanup } = await mount(620);
    try {
      const wrappers = Array.from(host.querySelectorAll<HTMLElement>(`.${codeWrapper}`));
      expect(wrappers.some((w) => w.scrollWidth > w.clientWidth)).toBe(true);
      for (const wrapper of wrappers) {
        const lines = wrapper.children.length;
        expectReservedExactly(wrapper, frameOf(wrapper), lines * 20 + 16);
      }
      // The layout-time probe agrees with the real track thickness.
      const wide = wrappers.find((w) => w.scrollWidth > w.clientWidth)!;
      expect(horizontalScrollbarHeight(codeWrapper)).toBe(wide.offsetHeight - wide.clientHeight - 2);
    } finally {
      cleanup();
    }
  });
});
