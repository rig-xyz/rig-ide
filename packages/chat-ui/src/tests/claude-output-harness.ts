/**
 * claude-output-harness — mounts CLAUDE_OUTPUT_FIXTURE in the real chat view
 * plus the DOM helpers the claude-output contract tests share.
 */

import { DEFAULT_THEME } from '@core/theme';
import { expect } from 'vitest';
import { createChatContext } from '@/chat-context';
import { createChatView } from '@/chat-view';
import { createChatState } from '@/state/chat-state';
import type { ChatMessage, TranscriptTurn } from '@/model';
import { CLAUDE_OUTPUT_FIXTURE } from './claude-output-fixture';

const nextPaint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

export async function mount(width: number) {
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

export const texts = (els: Iterable<Element>) =>
  Array.from(els, (el) => el.textContent?.trim() ?? '');

/** Scrollbar track height a horizontal scroller actually draws (0 when it overlays). */
export const trackHeight = (wrapper: HTMLElement) =>
  wrapper.scrollWidth > wrapper.clientWidth ? wrapper.offsetHeight - wrapper.clientHeight - 2 : 0;

/**
 * A fixed-height horizontal scroller (table / code block) reserves exactly its
 * content + border + the scrollbar track the platform draws, and clips
 * nothing vertically.
 */
export function expectReservedExactly(wrapper: HTMLElement, frame: HTMLElement, contentH: number) {
  expect(frame.offsetHeight).toBe(contentH + 2 + trackHeight(wrapper));
  expect(wrapper.scrollHeight).toBeLessThanOrEqual(wrapper.clientHeight);
}

export const frameOf = (el: Element) => el.closest<HTMLElement>('[data-block-id]')!;

export const proseFrame = (host: HTMLElement, text: string) =>
  frameOf(Array.from(host.querySelectorAll('span')).find((s) => s.textContent === text)!);
