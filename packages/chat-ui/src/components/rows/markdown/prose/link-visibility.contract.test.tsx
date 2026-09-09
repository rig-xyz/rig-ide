/**
 * link-visibility.contract.test.tsx — Bug B regression guard ("the filename
 * was clickable but not very visible"): a linked inline-code file mention
 * (backtick-quoted, `InlineCode.href`) must look unmistakably different from
 * a plain, non-clickable inline-code chip — link accent color + a dotted
 * underline (`inlineCodeChipLink` in prose.css.ts, applied alongside
 * `inlineCodeChip` in `Prose.tsx`'s `fragVisualClass`) — while staying
 * PIXEL-IDENTICAL in size to the same chip without a link (Bug A's own
 * discipline: color/decoration only, no padding/margin/width change).
 *
 * Runs in the browser project (real DOM + real computed styles) — the
 * distinguishing styles here are color/text-decoration, which a pure-JS
 * pretext probe can't observe.
 */

import { DEFAULT_THEME } from '@core/theme';
import { describe, expect, it } from 'vitest';
import { createChatContext } from '@/chat-context';
import { createChatView } from '@/chat-view';
import { createChatState } from '@/state/chat-state';
import type { ChatMessage, TranscriptTurn } from '@/model';

const nextPaint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

async function mountLinkedMessage(
  text: string,
  matcher: (t: string) => { text: string; path?: string }[]
) {
  const ctx = createChatContext({ theme: DEFAULT_THEME });
  const state = createChatState(ctx);
  const msg: ChatMessage = { kind: 'message', id: 'm1', seq: 0, role: 'assistant', text };
  const turn: TranscriptTurn = {
    id: 't1',
    seq: 0,
    initiator: 'agent',
    items: [msg] as TranscriptTurn['items'],
  };
  state.transcript.history.seed([turn]);

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:400px;';
  document.body.appendChild(host);

  const view = createChatView({ context: ctx, state, parent: host, commands: { linkFileMentions: matcher } });
  await nextPaint();
  await nextPaint();

  const cleanup = () => {
    view.dispose();
    ctx.dispose();
    state.dispose();
    document.body.removeChild(host);
  };
  return { host, cleanup };
}

describe('linked inline-code file mention is visibly distinct from a plain code chip', () => {
  it('adds link color + dotted underline, keeps identical box geometry to the unlinked chip', async () => {
    const path = 'notes.md';
    const text = `See \`${path}\` and \`other.md\` for details.`;
    const matcher = (t: string) => (t === path ? [{ text: t, path }] : [{ text: t }]);

    const { host, cleanup } = await mountLinkedMessage(text, matcher);
    try {
      const anchors = Array.from(host.querySelectorAll('a')).filter((a) => a.textContent === path);
      const spans = Array.from(host.querySelectorAll('span')).filter((s) => s.textContent === 'other.md');
      expect(anchors).toHaveLength(1);
      expect(spans).toHaveLength(1);

      const linked = anchors[0]!;
      const plain = spans[0]!;
      const linkedStyle = getComputedStyle(linked);
      const plainStyle = getComputedStyle(plain);

      // Visibly distinct: color + underline.
      expect(linkedStyle.color).not.toBe(plainStyle.color);
      expect(linkedStyle.textDecorationLine).toContain('underline');
      expect(plainStyle.textDecorationLine).not.toContain('underline');

      // Same box geometry — Bug A discipline (measured width == rendered
      // width): background chip chrome (padding/margin/background/radius)
      // is untouched by the link treatment.
      expect(linkedStyle.paddingLeft).toBe(plainStyle.paddingLeft);
      expect(linkedStyle.paddingRight).toBe(plainStyle.paddingRight);
      expect(linkedStyle.marginLeft).toBe(plainStyle.marginLeft);
      expect(linkedStyle.marginRight).toBe(plainStyle.marginRight);
      expect(linkedStyle.backgroundColor).toBe(plainStyle.backgroundColor);
      expect(linkedStyle.borderRadius).toBe(plainStyle.borderRadius);
      const linkedRect = linked.getBoundingClientRect();
      const plainRect = plain.getBoundingClientRect();
      expect(linkedRect.width).toBeCloseTo(plainRect.width, 0);
      expect(linkedRect.height).toBe(plainRect.height);
    } finally {
      cleanup();
    }
  });

  it('a hover state is defined for the linked chip (distinct :hover background rule exists)', async () => {
    const path = 'notes.md';
    const text = `See \`${path}\` for details.`;
    const matcher = (t: string) => (t === path ? [{ text: t, path }] : [{ text: t }]);

    const { host, cleanup } = await mountLinkedMessage(text, matcher);
    try {
      const anchor = Array.from(host.querySelectorAll('a')).find((a) => a.textContent === path);
      expect(anchor).toBeDefined();
      const cls = anchor!.className;
      let found = false;
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        for (const rule of Array.from(rules)) {
          if (rule instanceof CSSStyleRule && rule.selectorText.includes(':hover')) {
            const classSelectors = cls
              .split(' ')
              .filter(Boolean)
              .map((c) => `.${c}`);
            if (classSelectors.some((sel) => rule.selectorText.includes(sel))) {
              found = true;
            }
          }
        }
      }
      expect(found).toBe(true);
    } finally {
      cleanup();
    }
  });
});
