import { afterEach, describe, expect, it, vi } from 'vitest';
import { stopAllPinWatches, watchPins, type WatchedContents } from './pin-watch';

/**
 * Comments and pins spike (rig docs/comments-pins-spike.md), surface 3.
 * Fails today.
 *
 * Browser mode reloads a space's html file when it is written
 * (`artifact-view.tsx`, `pageReload`). The new document gets its watcher on
 * `did-frame-finish-load`, after it has already laid out, so nothing says
 * "moved": the pins stay where the old page had them until the renderer's
 * two second safety tick looks again.
 */

function fakePage() {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  const top = { executeJavaScript: vi.fn(async () => true), framesInSubtree: [] as unknown[] };
  top.framesInSubtree = [top];
  const wc = {
    id: 7,
    isDestroyed: () => false,
    on: vi.fn((name: string, fn: (...args: unknown[]) => void) => {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(fn);
      return wc;
    }),
    once: vi.fn((name: string, fn: (...args: unknown[]) => void) => {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(fn);
      return wc;
    }),
    off: vi.fn(() => wc),
    executeJavaScriptInIsolatedWorld: vi.fn(async () => true),
    mainFrame: top,
  };
  const emit = (name: string, ...args: unknown[]) => {
    for (const fn of [...(handlers.get(name) ?? [])]) fn(...args);
  };
  return { wc: wc as unknown as WatchedContents, emit };
}

afterEach(() => stopAllPinWatches());

describe('pins after the page reloads', () => {
  it('a page that finished loading again counts as moved', () => {
    const page = fakePage();
    const moved = vi.fn();
    watchPins(page.wc, moved);
    // The file was written; the page reloaded with a new layout.
    page.emit('did-frame-finish-load');
    expect(moved).toHaveBeenCalled();
  });
});
