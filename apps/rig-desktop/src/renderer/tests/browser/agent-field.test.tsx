import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentField, type AgentFieldHandle } from '@renderer/lib/ui/agent-field';

/** A claimed tile says where it sits, so a caption can stand beside it. */

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
