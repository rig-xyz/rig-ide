import { ArrowRight } from 'lucide-react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { ActionButton } from '@renderer/features/home-feed/action-button';
import '@renderer/features/home-feed/home-feed.css';

/**
 * Reaching for a button opens it up, but never moves what's next to it: on
 * Connect, a hint that wrapped to a second line moved the button out from
 * under the cursor, and it shook.
 */

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('ActionButton on hover', () => {
  it('keeps its place in the row, so a hint beside it stays put', async () => {
    await act(async () => {
      root.render(
        <div style={{ width: 600 }} className="flex flex-wrap items-center gap-2.5" data-testid="row">
          <ActionButton variant="primary" icon={ArrowRight}>
            Catch me up
          </ActionButton>
          <span className="text-meta whitespace-nowrap" data-testid="hint">
            Catches you up since 10:53 AM from 2 tools
          </span>
        </div>
      );
    });
    // Exactly as wide as the button and the hint at rest: any growth would wrap the hint.
    const rowEl = host.querySelector<HTMLElement>('[data-testid="row"]')!;
    const hintEl = host.querySelector<HTMLElement>('[data-testid="hint"]')!;
    rowEl.style.width = `${host.querySelector('button')!.getBoundingClientRect().width + 10 + Math.ceil(hintEl.getBoundingClientRect().width) + 1}px`;
    const hint = () => host.querySelector<HTMLElement>('[data-testid="hint"]')!.getBoundingClientRect();
    const row = () => host.querySelector<HTMLElement>('[data-testid="row"]')!.getBoundingClientRect();
    const before = { hint: hint(), row: row() };
    await userEvent.hover(host.querySelector('button')!);
    // Past its transition.
    await new Promise((resolve) => setTimeout(resolve, 400));
    await vi.waitFor(() => {
      expect(hint().left).toBeCloseTo(before.hint.left, 0);
      expect(hint().top).toBeCloseTo(before.hint.top, 0);
      expect(row().height).toBeCloseTo(before.row.height, 0);
    });
  });
});
