import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for Dylan's pinned-card polish pass (glassy collapsed chip with
 * an oozing expand button, the plain-font name header with a round Collapse
 * control, Cloud hidden for a space, and the Agents phantom for a still-
 * loading model) — `agent-rows.test` coverage for the logo-stack/phantom
 * bits lives alongside the Agents section's own tests in
 * `spaces-room.test.tsx`; this file is the pinned card's own shape.
 */

const mocks = vi.hoisted(() => ({
  filesList: vi.fn(),
  shareMembers: vi.fn(),
  seenState: vi.fn(),
  settingsGet: vi.fn(),
  pulseGet: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    rig: {
      files: { list: (...args: unknown[]) => mocks.filesList(...args) },
      share: { members: (...args: unknown[]) => mocks.shareMembers(...args) },
      seenState: { getState: (...args: unknown[]) => mocks.seenState(...args) },
      settings: { get: (...args: unknown[]) => mocks.settingsGet(...args) },
      pulse: { get: (...args: unknown[]) => mocks.pulseGet(...args) },
    },
  },
  events: { on: vi.fn(() => () => {}) },
}));

import { PinnedCard } from '@renderer/features/workspace/pinned-card';

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('PinnedCard', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    try {
      localStorage.clear();
    } catch {
      // localStorage unavailable in this environment — nothing to clear.
    }
    mocks.filesList.mockReset().mockResolvedValue({ success: true, data: [] });
    mocks.shareMembers.mockReset().mockResolvedValue({ success: true, data: { members: [], selfRole: 'owner' } });
    mocks.seenState.mockReset().mockResolvedValue({ baselineAt: Date.now(), seen: {} });
    mocks.settingsGet.mockReset().mockResolvedValue({ pinnedPathsByRig: {} });
    mocks.pulseGet.mockReset().mockResolvedValue({ success: false, error: { kind: 'relay', message: 'offline' } });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function flush() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function render(props: Partial<React.ComponentProps<typeof PinnedCard>> = {}) {
    const queryClient = new QueryClient();
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PinnedCard
            root="/rigs/growth"
            rootId="rig_growth"
            bindingId="binding_growth"
            name="growth"
            syncing={false}
            onOpenFile={() => {}}
            onOpenFocus={() => {}}
            {...props}
          />
        </QueryClientProvider>
      );
    });
    await flush();
  }

  describe('collapsed chip', () => {
    it('is glassy (backdrop-blur, hairline edge) and drops the leading panel icon from the chip body', async () => {
      await render({ startCollapsed: true });

      const chip = host.querySelector('[data-testid="pinned-chip"]')!;
      expect(chip).toBeTruthy();
      expect(chip.innerHTML).toContain('backdrop-blur-md');
      expect(chip.innerHTML).toContain('border-border-hairline');
      // The icon now lives only in the oozing expand button, not inline in
      // the chip's own visible content.
      const expandButton = host.querySelector('[data-testid="pinned-chip-expand"]')!;
      expect(expandButton.querySelector('svg')).toBeTruthy();
    });

    it('reveals the round expand button on hover and hides it again after leaving', async () => {
      await render({ startCollapsed: true });

      const chip = host.querySelector('[data-testid="pinned-chip"]')!;
      const expandButton = host.querySelector<HTMLButtonElement>('[data-testid="pinned-chip-expand"]')!;
      expect(expandButton.className).toContain('pointer-events-none');
      expect(expandButton.className).toContain('opacity-0');

      // React synthesizes onMouseEnter/onMouseLeave from bubbling native
      // mouseover/mouseout (it doesn't listen for the non-bubbling
      // mouseenter/mouseleave events directly).
      await act(async () => {
        chip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
      expect(expandButton.className).toContain('pointer-events-auto');
      expect(expandButton.className).toContain('opacity-100');

      await act(async () => {
        chip.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      });
      // Forgiving hover: still visible immediately after leaving...
      expect(expandButton.className).toContain('opacity-100');
      // ...and gone only after the close grace elapses (real timers — the
      // component's own close-grace timeout, not one this test controls).
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
      });
      expect(expandButton.className).toContain('opacity-0');
    });

    it('opens the panel from either the chip itself or the expand button', async () => {
      await render({ startCollapsed: true });
      expect(host.querySelector('[data-testid="pinned-chip"]')).toBeTruthy();

      await act(async () => {
        click(host.querySelector('[data-testid="pinned-chip-expand"]')!);
      });
      await flush();
      expect(host.querySelector('[data-testid="pinned-chip"]')).toBeNull();
      // The full card is showing instead — its own Collapse control is there.
      expect(host.querySelector('[aria-label="Collapse"]')).toBeTruthy();
    });

    it('still shows what it always did: the name (or chip summary), syncing, and the new count', async () => {
      await render({ startCollapsed: true, syncing: true });
      const chip = host.querySelector('[data-testid="pinned-chip"]')!;
      expect(chip.textContent).toContain('growth');
      expect(chip.textContent).toContain('Syncing');
    });
  });

  describe('expanded header', () => {
    it('shows the rig name in the regular font, not the mono "RIG" label', async () => {
      await render();
      const header = host.querySelector('.card-pop-in > div > p')!;
      expect(header.textContent).toBe('growth');
      expect(header.className).not.toContain('font-mono');
      expect(header.className).not.toContain('uppercase');
      expect(header.className).toContain('font-medium');
    });

    it('strips a leading "#" from the name', async () => {
      await render({ name: '#growth' });
      const header = host.querySelector('.card-pop-in > div > p')!;
      expect(header.textContent).toBe('growth');
    });

    it('replaces the chevron "Hide" control with a round Collapse button', async () => {
      await render();
      expect(host.querySelector('[aria-label="Hide rig details"]')).toBeNull();
      const collapseButton = host.querySelector<HTMLButtonElement>('[aria-label="Collapse"]')!;
      expect(collapseButton).toBeTruthy();
      expect(collapseButton.className).toContain('rounded-full');

      await act(async () => click(collapseButton));
      await flush();
      // Collapsing swaps back to the chip.
      expect(host.querySelector('[data-testid="pinned-chip"]')).toBeTruthy();
    });
  });

  describe('Cloud row', () => {
    it('shows Cloud for a plain rig', async () => {
      await render({ isSpace: false });
      expect(host.textContent).toContain('Cloud');
      expect(host.textContent).toContain('Backed up');
    });

    it('hides Cloud entirely for a space', async () => {
      await render({ isSpace: true });
      expect(host.textContent).not.toContain('Cloud');
      expect(host.textContent).not.toContain('Backed up');
    });
  });

  it('Changes shows one clock on the row ("N new"); the day\'s count lives inside', async () => {
    mocks.filesList.mockResolvedValue({
      success: true,
      data: [{ kind: 'file', name: 'notes.md', relPath: 'notes.md', mtimeMs: Date.now() }],
    });
    mocks.seenState.mockResolvedValue({ baselineAt: Date.now() - 60_000, seen: {} });
    await render();
    const row = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Changes'))!;
    expect(row.parentElement!.textContent).toContain('1 new');
    expect(row.parentElement!.textContent).not.toContain('today');
    // The section remembers being open (it starts open); open it if it isn't.
    if (!host.querySelector('[data-testid="changes-today"]')) {
      await act(async () => row.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    }
    expect(host.querySelector('[data-testid="changes-today"]')?.textContent).toBe('1 file changed in the last day');
  });

  it("lets a function chip summary own the chip's whole status", async () => {
    await render({ startCollapsed: true, syncing: true, chipSummary: ({ unseenCount }) => <span>room says {unseenCount}</span> });
    const chip = host.querySelector('[data-testid="pinned-chip"]')!;
    expect(chip.textContent).toContain('room says 0');
    expect(chip.textContent).not.toContain('Syncing');
  });

  it('shows the "Activity" section label in the regular font, sentence case', async () => {
    mocks.filesList.mockResolvedValue({
      success: true,
      data: [{ kind: 'file', name: 'notes.md', relPath: 'notes.md', mtimeMs: Date.now() }],
    });
    await render();
    const activityLabel = Array.from(host.querySelectorAll('p')).find((p) => p.textContent === 'Activity');
    expect(activityLabel).toBeTruthy();
    expect(activityLabel!.className).not.toContain('font-mono');
    expect(activityLabel!.className).not.toContain('uppercase');
  });
});
