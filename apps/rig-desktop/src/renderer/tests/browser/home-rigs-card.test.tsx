import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Polish round 2, lane F coverage for the Home "Rigs" card (Dylan: rename
 * from "Solo rigs", one "+ New" header action like the Spaces card, "Open"
 * removed). `home.tsx` wraps `RigsRail` in `FloatingCard` exactly this way
 * — this harness mirrors that composition rather than mounting the whole
 * `Home` (which needs a much larger RPC surface unrelated to this card).
 */

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    rig: {
      settings: {
        get: async () => ({ rigsRailView: { filter: 'all', sort: 'recent' }, hiddenByRig: {} }),
        set: async () => {},
      },
    },
  },
  events: { on: vi.fn(() => () => {}) },
}));

import { FloatingCard } from '@renderer/features/home/floating-card';
import { RigsRail } from '@renderer/features/home/rigs-rail';

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('Home "Rigs" card', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('titles itself "Rigs" (not "Solo rigs") with one "+ New" header action, and no "Open" action', async () => {
    const created: boolean[] = [];
    await act(async () => {
      root.render(
        <FloatingCard
          storageKey="test-rigs-card"
          title="Rigs"
          count={0}
          headerAction={
            <button type="button" onClick={() => created.push(true)}>
              + New
            </button>
          }
        >
          <RigsRail
            rows={[]}
            identities={new Map()}
            onOpenPath={() => {}}
            onOpenSession={() => {}}
          />
        </FloatingCard>
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Rigs');
    expect(host.textContent).not.toContain('Solo rigs');

    const buttons = [...host.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(buttons).toContain('+ New');
    expect(buttons.some((t) => t === 'Open')).toBe(false);
    expect(host.textContent).not.toContain('New rig');

    const newButton = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === '+ New')!;
    await act(async () => click(newButton));
    expect(created).toEqual([true]);
  });
});
