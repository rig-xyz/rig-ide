import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DotMatrix from '@renderer/lib/ui/dot-matrix';

/** The matrix clock, counted: how many draws are subscribed to it now. */
const clock = vi.hoisted(() => ({ live: 0 }));
vi.mock('@renderer/lib/ui/dot-matrix', async (original) => {
  const real = await original<typeof DotMatrix>();
  return {
    ...real,
    subscribeMatrixClock: (listener: () => void) => {
      clock.live += 1;
      const off = real.subscribeMatrixClock(listener);
      return () => {
        clock.live -= 1;
        off();
      };
    },
  };
});

import { AgentField, MAX_CLAIMED_TILES, type AgentFieldHandle } from '@renderer/lib/ui/agent-field';

/**
 * A claimed tile says where it sits, so a caption can stand beside it; the
 * field redraws on the clock only while something on it moves; it holds at
 * most `MAX_CLAIMED_TILES` claimed tiles.
 */

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  host.style.cssText = 'position:relative;width:600px;height:400px';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('AgentField tile.at', () => {
  it('is null until the tile is claimed, then its center in fractions of the field, the same each time', async () => {
    const ref = createRef<AgentFieldHandle>();
    await act(async () => root.render(<AgentField ref={ref} className="absolute inset-0" />));
    const tile = ref.current!.tile('t', { x: 0.25, y: 0.75, radius: 0.08 });
    expect(tile.at()).toBeNull();
    await vi.waitFor(() => {
      tile.set('reading', '--accent');
      const at = tile.at();
      expect(at).not.toBeNull();
      expect(at!.x).toBeGreaterThan(0);
      expect(at!.x).toBeLessThan(1);
      expect(at!.y).toBeGreaterThan(0);
      expect(at!.y).toBeLessThan(1);
    });
    expect(tile.at()).toEqual(tile.at());
    tile.release();
    expect(tile.at()).toBeNull();
  });
});

describe('AgentField drawing', () => {
  it('is on the clock only while something moves', async () => {
    const ref = createRef<AgentFieldHandle>();
    await act(async () => root.render(<AgentField ref={ref} mode="idle" className="absolute inset-0" />));
    // Idle, nothing claimed: still.
    await new Promise((r) => setTimeout(r, 100));
    expect(clock.live).toBe(0);
    const tile = ref.current!.tile('a');
    tile.set('reading', '--accent');
    await vi.waitFor(() => expect(clock.live).toBe(1));
    // Settled to an end glyph: still again after the next tick.
    tile.set('done');
    await vi.waitFor(() => expect(clock.live).toBe(0));
    await act(async () => root.render(<AgentField ref={ref} mode="ambient" className="absolute inset-0" />));
    await vi.waitFor(() => expect(clock.live).toBe(1));
  });

  it('reads a color off the page once, not per tile per frame', async () => {
    const ref = createRef<AgentFieldHandle>();
    await act(async () => root.render(<AgentField ref={ref} mode="idle" className="absolute inset-0" />));
    const spy = vi.spyOn(window, 'getComputedStyle');
    for (let i = 0; i < 12; i++) ref.current!.tile(`t${i}`).set('reading', '--theme-3');
    await new Promise((r) => setTimeout(r, 300));
    const reads = spy.mock.calls.length;
    spy.mockRestore();
    expect(reads).toBeLessThanOrEqual(1);
  });

  it('lets the oldest settled tile go past the cap', async () => {
    const ref = createRef<AgentFieldHandle>();
    await act(async () => root.render(<AgentField ref={ref} mode="idle" className="absolute inset-0" />));
    const tiles = Array.from({ length: MAX_CLAIMED_TILES }, (_, i) => ref.current!.tile(`t${i}`));
    tiles.forEach((t, i) => t.set(i === 3 ? 'done' : 'reading'));
    expect(tiles.every((t) => t.at() !== null)).toBe(true);
    const extra = ref.current!.tile('extra');
    extra.set('reading');
    expect(extra.at()).not.toBeNull();
    expect(tiles[3]!.at()).toBeNull();
    expect(tiles.filter((t) => t.at() === null)).toHaveLength(1);
  });
});
