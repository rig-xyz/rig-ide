/**
 * claude-output.contract.test.tsx — renders CLAUDE_OUTPUT_FIXTURE (every GFM
 * construct Claude/Codex routinely emit) through the real chat view and
 * checks each element survives with its structure: tables keep inline
 * formatting, wrap instead of truncating, respect alignment and reserve
 * exactly their DOM height; lists keep numbers and task checkboxes;
 * strikethrough, math source and footnotes aren't dropped.
 *
 * Browser project: real layout + vanilla-extract CSS.
 */

import { DEFAULT_THEME } from '@core/theme';
import { describe, expect, it } from 'vitest';
import { createChatContext } from '@/chat-context';
import { createChatView } from '@/chat-view';
import { createChatState } from '@/state/chat-state';
import type { ChatMessage, TranscriptTurn } from '@/model';
import { CLAUDE_OUTPUT_FIXTURE } from './claude-output-fixture';

const nextPaint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

async function mount(width: number) {
  const ctx = createChatContext({ theme: DEFAULT_THEME });
  const state = createChatState(ctx);
  const msg: ChatMessage = {
    kind: 'message',
    id: 'm1',
    seq: 0,
    role: 'assistant',
    text: CLAUDE_OUTPUT_FIXTURE,
  };
  const turn: TranscriptTurn = {
    id: 't1',
    seq: 0,
    initiator: 'agent',
    items: [msg] as TranscriptTurn['items'],
  };
  state.transcript.history.seed([turn]);
  const host = document.createElement('div');
  // Tall enough that the whole message is inside the virtualizer's window.
  host.style.cssText = `position:fixed;top:0;left:0;width:${width}px;height:4000px;`;
  document.body.appendChild(host);
  const view = createChatView({ context: ctx, state, parent: host });
  await nextPaint();
  await nextPaint();
  const cleanup = () => {
    view.dispose();
    ctx.dispose();
    state.dispose();
    host.remove();
  };
  return { host, cleanup };
}

const texts = (els: Iterable<Element>) => Array.from(els, (el) => el.textContent?.trim() ?? '');

describe('Claude output fixture renders every markdown element', () => {
  it('tables: scroll wrapper, header cells, inline formatting, wrapping, alignment, exact height', async () => {
    const { host, cleanup } = await mount(620);
    try {
      const tables = Array.from(host.querySelectorAll('table'));
      expect(tables).toHaveLength(3);

      for (const table of tables) {
        const wrapper = table.parentElement!;
        const frame = table.closest<HTMLElement>('[data-block-id]')!;
        // Wrapped in a horizontal scroller that never exceeds the chat column.
        expect(getComputedStyle(wrapper).overflowX).toBe('auto');
        expect(wrapper.clientWidth).toBeLessThanOrEqual(frame.clientWidth);
        // Reserved (layout) height === rendered height (+2 wrapper border).
        expect(table.offsetHeight + 2).toBe(frame.offsetHeight);
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
        const frame = table.closest<HTMLElement>('[data-block-id]')!;
        expect(table.parentElement!.clientWidth).toBeLessThanOrEqual(frame.clientWidth);
        expect(table.offsetHeight + 2).toBe(frame.offsetHeight);
      }
    } finally {
      cleanup();
    }
  });
});
